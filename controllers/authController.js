const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const { pool } = require('../config/db');

// Generate JWT
const generateToken = (id, role = 'user') => {
  return jwt.sign({ id, role }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  });
};

// POST /api/auth/send-otp
const sendOTP = async (req, res) => {
  try {
    const { mobile } = req.body;
    if (!mobile || !/^[6-9]\d{9}$/.test(mobile)) {
      return res.status(400).json({ success: false, message: 'Invalid mobile number' });
    }
    // Simulate sending OTP 123456

    res.json({ success: true, message: 'OTP sent successfully. Use 123456 for testing.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// Shared verification & login logic
const handleVerifyAndLogin = async (mobile, otp, res) => {
  if (!mobile || !/^[6-9]\d{9}$/.test(mobile)) {
    return res.status(400).json({ success: false, message: 'Enter a valid 10-digit mobile number' });
  }
  if (!otp || otp !== '123456') {
    return res.status(400).json({ success: false, message: 'Invalid OTP. Please use 123456 for testing.' });
  }

  // Find or create user
  let [rows] = await pool.query('SELECT * FROM users WHERE mobile = ?', [mobile]);
  let user = rows[0];
  let isNewUser = false;

  if (!user) {
    const referralCode = `PPK${mobile.slice(-6)}`;
    const [result] = await pool.query(
      'INSERT INTO users (mobile, full_name, referral_code, credit_limit, wallet_balance) VALUES (?, ?, ?, ?, ?)',
      [mobile, 'Ppokket User', referralCode, 0, 0]
    );
    [rows] = await pool.query('SELECT * FROM users WHERE id = ?', [result.insertId]);
    user = rows[0];
    isNewUser = true;

    // Welcome notification
    await pool.query(
      'INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, ?)',
      [user.id, 'Welcome to Ppokket! 🎉', 'Your account has been created. Complete KYC to unlock your credit limit.', 'system']
    );
  } else {
    // If user exists but name is default 'Ppokket User' or email is empty, consider them a new user for profile completion
    if (user.full_name === 'Ppokket User' || !user.email) {
      isNewUser = true;
    }
    await pool.query('UPDATE users SET updated_at = NOW() WHERE id = ?', [user.id]);
  }

  // Get KYC status
  const [kycRows] = await pool.query('SELECT status FROM kyc_documents WHERE user_id = ?', [user.id]);
  const kycStatus = kycRows[0]?.status || 'not_submitted';

  const token = generateToken(user.id, 'user');
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
    const { mobile, otp } = req.body;
    await handleVerifyAndLogin(mobile, otp, res);
  } catch (err) {
    console.error('Verify OTP error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/auth/demo-login
const demoLogin = async (req, res) => {
  try {
    const { mobile, otp } = req.body;
    await handleVerifyAndLogin(mobile, otp, res);
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

    const [rows] = await pool.query('SELECT * FROM admins WHERE email = ? AND is_active = 1', [email]);
    if (!rows.length) return res.status(401).json({ success: false, message: 'Invalid credentials' });

    const admin = rows[0];
    const match = await bcrypt.compare(password, admin.password);
    if (!match) return res.status(401).json({ success: false, message: 'Invalid credentials' });

    await pool.query('UPDATE admins SET last_login = NOW() WHERE id = ?', [admin.id]);
    const token = generateToken(admin.id, 'admin');
    res.json({
      success: true,
      token,
      admin: { id: admin.id, name: admin.name, email: admin.email, role: admin.role },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

module.exports = { sendOTP, verifyOTP, demoLogin, adminLogin };

