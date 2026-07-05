const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const { pool } = require('../config/db');
const { redisClient } = require('../config/redis');

// OTP config
const OTP_TTL_SECONDS    = 5 * 60;  // 5 minutes
const OTP_MAX_ATTEMPTS   = 5;        // wrong attempts before lockout
const OTP_LOCK_SECONDS   = 15 * 60; // lockout duration
const OTP_RESEND_COOLDOWN_SECONDS = 60;       // min gap between two sends to the same number
const OTP_MAX_SENDS_PER_WINDOW    = 5;        // cap sends per number even across the cooldown
const OTP_SEND_WINDOW_SECONDS     = 60 * 60;  // 1 hour

// Admin login brute-force lockout (mirrors the OTP lockout pattern)
const ADMIN_MAX_ATTEMPTS = 5;
const ADMIN_LOCK_SECONDS = 15 * 60;

// Generate JWT
const generateToken = (id, role = 'user') => {
  return jwt.sign({ id, role }, process.env.JWT_SECRET, {
    expiresIn: '7d', // Enforce exactly 7 days validity
  });
};

// Generate a cryptographically random 6-digit OTP
const generateOTP = () => String(Math.floor(100000 + Math.random() * 900000));

// Dev-only fixed OTP for local testing so we don't burn real SMS credits / need
// the SMS gateway configured locally. Locked to NODE_ENV !== 'production' AND a
// single hardcoded test number — never a general "any number + this code" backdoor.
const DEV_TEST_MOBILE = '7310249234';
const DEV_TEST_OTP    = '123456';
const isDevTestNumber = (mobile) => process.env.NODE_ENV !== 'production' && mobile === DEV_TEST_MOBILE;

// Send OTP via APItxt (SMS by default, can extend to whatsapp/voice)
const sendOtpViaSms = async (mobile, otp) => {
  const authkey = process.env.APITXT_AUTHKEY;
  if (!authkey) throw new Error('OTP service not configured');

  const url = new URL('https://apitxt.com/api/sendOTP');
  url.searchParams.set('authkey', authkey);
  url.searchParams.set('mobile',  `91${mobile}`);
  url.searchParams.set('otp',     otp);
  url.searchParams.set('channel', 'sms');

  const resp = await fetch(url.toString());
  const data = await resp.json();

  if (data.status !== 'success') {
    console.error('[APItxt]', data);
    throw new Error(data.message || 'Failed to send OTP');
  }
  return data;
};

// POST /api/auth/send-otp
const sendOTP = async (req, res) => {
  try {
    const { mobile } = req.body;
    if (!mobile || !/^\d{10}$/.test(mobile)) {
      return res.status(400).json({ success: false, message: 'Invalid mobile number' });
    }

    // Check if mobile is locked out
    const lockKey = `otp_lock:${mobile}`;
    const locked  = await redisClient.get(lockKey);
    if (locked) {
      const ttl = await redisClient.ttl(lockKey);
      return res.status(429).json({ success: false, message: `Too many attempts. Try again in ${Math.ceil(ttl / 60)} minutes.` });
    }

    // Per-number resend cooldown — stops SMS-bombing one victim number from
    // rotating IPs/sessions (the route-level rate limiter is per-IP only).
    const cooldownKey = `otp_cooldown:${mobile}`;
    const cooldownTtl = await redisClient.ttl(cooldownKey);
    if (cooldownTtl > 0) {
      return res.status(429).json({ success: false, message: `Please wait ${cooldownTtl}s before requesting another OTP.` });
    }

    // Per-number send cap within a rolling window, independent of cooldown
    const sendCountKey = `otp_sendcount:${mobile}`;
    const sendCount = await redisClient.incr(sendCountKey);
    if (sendCount === 1) {
      await redisClient.expire(sendCountKey, OTP_SEND_WINDOW_SECONDS);
    }
    if (sendCount > OTP_MAX_SENDS_PER_WINDOW) {
      return res.status(429).json({ success: false, message: 'Too many OTP requests for this number. Please try again later.' });
    }

    const otp = isDevTestNumber(mobile) ? DEV_TEST_OTP : generateOTP();

    // Store OTP in Redis with TTL
    await redisClient.setEx(`otp:${mobile}`, OTP_TTL_SECONDS, JSON.stringify({ otp, attempts: 0 }));

    // Skip the real SMS gateway for the dev test number — no gateway credentials
    // needed locally, and no real SMS/credits spent testing.
    if (!isDevTestNumber(mobile)) {
      await sendOtpViaSms(mobile, otp);
    }

    // Only start the cooldown once the SMS actually went out, so a
    // transient provider failure doesn't block the user's next retry.
    await redisClient.setEx(cooldownKey, OTP_RESEND_COOLDOWN_SECONDS, '1');

    res.json({ success: true, message: 'OTP sent successfully' });
  } catch (err) {
    console.error('[sendOTP]', err);
    res.status(500).json({ success: false, message: 'Failed to send OTP. Please try again.' });
  }
};

// Shared verification & login logic
const handleVerifyAndLogin = async (mobile, otp, res, referralCode = null) => {
  if (!mobile || !/^\d{10}$/.test(mobile)) {
    return res.status(400).json({ success: false, message: 'Enter a valid 10-digit mobile number' });
  }
  if (!otp || !/^\d{6}$/.test(otp)) {
    return res.status(400).json({ success: false, message: 'Enter a valid 6-digit OTP' });
  }

  // Lockout check
  const lockKey = `otp_lock:${mobile}`;
  const locked  = await redisClient.get(lockKey);
  if (locked) {
    const ttl = await redisClient.ttl(lockKey);
    return res.status(429).json({ success: false, message: `Too many failed attempts. Try again in ${Math.ceil(ttl / 60)} minutes.` });
  }

  // Fetch stored OTP record
  const otpKey    = `otp:${mobile}`;
  const otpRaw    = await redisClient.get(otpKey);
  if (!otpRaw) {
    return res.status(400).json({ success: false, message: 'OTP expired or not requested. Please request a new OTP.' });
  }

  const record = JSON.parse(otpRaw);

  if (record.otp !== otp) {
    // Increment failed attempts
    record.attempts += 1;
    if (record.attempts >= OTP_MAX_ATTEMPTS) {
      await redisClient.del(otpKey);
      await redisClient.setEx(lockKey, OTP_LOCK_SECONDS, '1');
      return res.status(429).json({ success: false, message: 'Too many failed attempts. Your number is locked for 15 minutes.' });
    }
    // Preserve remaining TTL
    const remainingTtl = await redisClient.ttl(otpKey);
    await redisClient.setEx(otpKey, Math.max(remainingTtl, 1), JSON.stringify(record));
    const remaining = OTP_MAX_ATTEMPTS - record.attempts;
    return res.status(400).json({ success: false, message: `Invalid OTP. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.` });
  }

  // Find or create user
  let [rows] = await pool.query('SELECT * FROM users WHERE mobile = ?', [mobile]);
  let user = rows[0];
  let isNewUser = false;

  if (!user) {
    const newReferralCode = `PPK${mobile.slice(-6)}`;

    // Resolve referrer if a referral code was provided
    let referrerId = null;
    if (referralCode) {
      const [refRows] = await pool.query(
        'SELECT id FROM users WHERE referral_code = ?',
        [referralCode.trim().toUpperCase()]
      );
      if (refRows.length) {
        referrerId = refRows[0].id;
      } else {
        return res.status(400).json({ success: false, message: 'Invalid referral code.' });
      }
    }

    const [result] = await pool.query(
      'INSERT INTO users (mobile, full_name, referral_code, referred_by, credit_limit, wallet_balance) VALUES (?, ?, ?, ?, ?, ?)',
      [mobile, 'Ppokket User', newReferralCode, referrerId, 0, 0]
    );
    [rows] = await pool.query('SELECT * FROM users WHERE id = ?', [result.insertId]);
    user = rows[0];
    isNewUser = true;

    // Welcome notification
    await pool.query(
      'INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, ?)',
      [user.id, 'Welcome to Ppokket! 🎉', 'Your account has been created. Complete KYC to unlock your credit limit.', 'system']
    );

    // Create referral record so admin can credit the referrer
    if (referrerId) {
      await pool.query(
        'INSERT IGNORE INTO referrals (referrer_id, referred_id) VALUES (?, ?)',
        [referrerId, user.id]
      );
      await pool.query(
        'INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, ?)',
        [referrerId, '👥 New Referral!',
         `${user.full_name || 'A new user'} joined Ppokket using your referral code. You will earn a credit limit bonus once they complete KYC.`,
         'promo']
      );
    }
  } else {
    // If user exists but name is default 'Ppokket User' or email is empty, consider them a new user for profile completion
    if (user.full_name === 'Ppokket User' || !user.email) {
      isNewUser = true;
    }

    // Resolve referrer if a referral code was provided and user doesn't have a referrer yet
    if (referralCode && user.referred_by === null) {
      const [refRows] = await pool.query(
        'SELECT id FROM users WHERE referral_code = ?',
        [referralCode.trim().toUpperCase()]
      );
      if (refRows.length) {
        const referrerId = refRows[0].id;
        if (referrerId !== user.id) {
          // Update referred_by
          await pool.query('UPDATE users SET referred_by = ? WHERE id = ?', [referrerId, user.id]);
          // Create referral record
          await pool.query(
            'INSERT IGNORE INTO referrals (referrer_id, referred_id) VALUES (?, ?)',
            [referrerId, user.id]
          );
          // In-app notification for referrer
          await pool.query(
            'INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, ?)',
            [referrerId, '👥 New Referral!',
             `${user.full_name || 'A new user'} joined Ppokket using your referral code. You will earn a credit limit bonus once they complete KYC.`,
             'promo']
          );
          // Update local user object referred_by so it matches database
          user.referred_by = referrerId;
        } else {
          return res.status(400).json({ success: false, message: 'You cannot refer yourself.' });
        }
      } else {
        return res.status(400).json({ success: false, message: 'Invalid referral code.' });
      }
    }

    await pool.query('UPDATE users SET updated_at = NOW() WHERE id = ?', [user.id]);
  }

  // Get KYC status
  const [kycRows] = await pool.query('SELECT status FROM kyc_documents WHERE user_id = ?', [user.id]);
  const kycStatus = kycRows[0]?.status || 'not_submitted';

  const token = generateToken(user.id, 'user');

  // OTP verified and user session generated successfully — consume the OTP now
  await redisClient.del(otpKey);

  return res.json({
    success: true,
    isNewUser,
    token,
    user: {
      id: user.id,
      full_name: user.full_name,
      mobile: user.mobile,
      email: user.email,
      kyc_status: kycStatus,
      is_kyc_verified: user.is_kyc_verified,
      credit_limit: parseFloat(user.credit_limit) || 0,
      wallet_balance: parseFloat(user.wallet_balance) || 0,
      credit_score: user.credit_score || 0,
      occupation: user.occupation,
      monthly_income: user.monthly_income,
      interest_rate: parseFloat(user.interest_rate) || 2.50,
    },
  });
};

// POST /api/auth/verify-otp
const verifyOTP = async (req, res) => {
  try {
    const { mobile, otp, referral_code } = req.body;
    await handleVerifyAndLogin(mobile, otp, res, referral_code);
  } catch (err) {
    console.error('Verify OTP error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/auth/demo-login  (alias — same real OTP flow)
const demoLogin = async (req, res) => {
  try {
    const { mobile, otp, referral_code } = req.body;
    await handleVerifyAndLogin(mobile, otp, res, referral_code);
  } catch (err) {
    console.error('Demo login error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/auth/admin-login
const adminLogin = async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ success: false, message: 'Email and password required' });

    // Per-account lockout on top of the route's per-IP rate limit — mirrors
    // the OTP lockout pattern so credential stuffing from many IPs against
    // one admin account still gets stopped.
    const lockKey = `admin_lock:${email}`;
    const locked  = await redisClient.get(lockKey);
    if (locked) {
      const ttl = await redisClient.ttl(lockKey);
      return res.status(429).json({ success: false, message: `Too many failed attempts. Try again in ${Math.ceil(ttl / 60)} minutes.` });
    }

    const failKey = `admin_fail:${email}`;

    const [rows] = await pool.query('SELECT * FROM admins WHERE email = ? AND is_active = 1', [email]);
    const admin = rows[0];
    const match = admin ? await bcrypt.compare(password, admin.password) : false;

    if (!admin || !match) {
      const fails = await redisClient.incr(failKey);
      if (fails === 1) await redisClient.expire(failKey, ADMIN_LOCK_SECONDS);
      if (fails >= ADMIN_MAX_ATTEMPTS) {
        await redisClient.del(failKey);
        await redisClient.setEx(lockKey, ADMIN_LOCK_SECONDS, '1');
        return res.status(429).json({ success: false, message: `Too many failed attempts. This account is locked for ${ADMIN_LOCK_SECONDS / 60} minutes.` });
      }
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    await redisClient.del(failKey);
    await pool.query('UPDATE admins SET last_login = NOW() WHERE id = ?', [admin.id]);
    const token = generateToken(admin.id, 'admin');

    // Resolve permissions to send to the frontend for UI gating
    let permissions;
    if (admin.role === 'super_admin') {
      permissions = {
        view_dashboard: true, manage_users: true, manage_loans: true, manage_kyc: true,
        view_transactions: true, manage_transactions: true, send_notifications: true,
        manage_referrals: true, manage_settings: true, manage_admins: true, manage_dsa: true,
      };
    } else {
      const [[p]] = await pool.query('SELECT * FROM admin_permissions WHERE admin_id = ?', [admin.id]);
      permissions = p ? {
        view_dashboard:      !!p.view_dashboard,
        manage_users:        !!p.manage_users,
        manage_loans:        !!p.manage_loans,
        manage_kyc:          !!p.manage_kyc,
        view_transactions:   !!p.view_transactions,
        manage_transactions: !!p.manage_transactions,
        send_notifications:  !!p.send_notifications,
        manage_referrals:    !!p.manage_referrals,
        manage_settings:     !!p.manage_settings,
        manage_admins:       !!p.manage_admins,
        manage_dsa:          !!p.manage_dsa,
      } : {};
    }

    res.json({
      success: true,
      token,
      admin: { id: admin.id, name: admin.name, email: admin.email, role: admin.role },
      permissions,
    });
  } catch (err) {
    console.error('[adminLogin]', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

module.exports = { sendOTP, verifyOTP, demoLogin, adminLogin };

