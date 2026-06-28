const { pool } = require('../config/db');
const { getCache, setCache, invalidateUserCache, CACHE_TTL } = require('../config/redis');
const { sendNotification } = require('../utils/fcm');
const { verifyBankAccount, verifyIFSC, compareName } = require('../utils/bankVerify');

// Dynamic revolving credit calculation helper
const getUserCreditDetails = async (userId, creditLimit, withdrawalLimit) => {
  const [loans] = await pool.query(
    `SELECT id, amount, status, total_payable, amount_paid FROM loans WHERE user_id = ? AND status != 'rejected'`,
    [userId]
  );
  
  let occupiedCredit = 0;
  for (const loan of loans) {
    if (loan.status !== 'closed') {
      // For any active/non-closed loan, the full loan amount remains occupied
      occupiedCredit += parseFloat(loan.amount || 0);
    }
  }

  const effectiveLimit = withdrawalLimit !== null ? Math.min(parseFloat(creditLimit), parseFloat(withdrawalLimit)) : parseFloat(creditLimit);
  const availableCredit = Math.max(0, effectiveLimit - occupiedCredit);

  return { occupiedCredit, availableCredit };
};

// GET /api/user/profile
const getProfile = async (req, res) => {
  try {
    const cacheKey = `user:${req.user.id}:profile`;
    const cached = await getCache(cacheKey);
    if (cached) return res.json(cached);

    const [rows] = await pool.query(
      `SELECT u.*, bd.account_holder, bd.account_number, bd.ifsc_code, bd.bank_name, bd.account_type, bd.is_verified as bank_verified,
              bd.ifsc_bank_name, bd.branch, bd.branch_address, bd.city, bd.state,
              bd.micr, bd.swift, bd.contact, bd.neft, bd.rtgs, bd.imps, bd.upi, bd.ifsc_verified,
              k.status as kyc_doc_status
       FROM users u
       LEFT JOIN bank_details bd ON bd.user_id = u.id
       LEFT JOIN kyc_documents k ON k.user_id = u.id
       WHERE u.id = ?`,
      [req.user.id]
    );
    if (!rows.length) return res.status(404).json({ success: false, message: 'User not found' });
    const user = rows[0];
    delete user.password;
    if (user.is_kyc_verified) {
      user.kyc_status = 'approved';
    } else if (user.kyc_doc_status) {
      user.kyc_status = user.kyc_doc_status;
    } else {
      user.kyc_status = 'not_submitted';
    }
    delete user.kyc_doc_status;

    // Load global system settings for fallbacks
    const [settingsRows] = await pool.query('SELECT setting_key, setting_value FROM system_settings');
    const settings = {};
    for (const r of settingsRows) {
      settings[r.setting_key] = r.setting_value;
    }
    const defaultFirstEmiPct = parseFloat(settings.first_emi_principal_pct || 25);
    const defaultProcFeePct = parseFloat(settings.processing_fee_pct || 2);

    user.first_emi_pct = user.custom_first_emi_pct != null ? parseFloat(user.custom_first_emi_pct) : defaultFirstEmiPct;
    user.processing_fee_pct = user.custom_processing_fee_pct != null ? parseFloat(user.custom_processing_fee_pct) : defaultProcFeePct;
    user.processing_fee_in_first_emi = settings.processing_fee_in_first_emi === 'true' || settings.processing_fee_in_first_emi === true || settings.processing_fee_in_first_emi === '1';
    user.gst_on_processing_fee = parseFloat(settings.gst_on_processing_fee || 18);

    // Calculate dynamic revolving limits
    const creditDetails = await getUserCreditDetails(user.id, user.credit_limit, user.withdrawal_limit);
    user.available_credit = creditDetails.availableCredit;
    user.occupied_credit = creditDetails.occupiedCredit;

    const response = { success: true, user };
    await setCache(cacheKey, response, CACHE_TTL.SHORT);
    res.json(response);
  } catch (err) {
    console.error('[getProfile]', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// PUT /api/user/update
const updateProfile = async (req, res) => {
  try {
    const { full_name, email, pan_number, aadhaar_number, date_of_birth, occupation, monthly_income, fcm_token, dark_mode, language, referral_code } = req.body;
    
    let formattedDob = date_of_birth;

    // Enforce profile completeness if updating personal details
    if (full_name !== undefined || email !== undefined || date_of_birth !== undefined || occupation !== undefined || monthly_income !== undefined) {
      if (!full_name || !full_name.trim()) return res.status(400).json({ success: false, message: 'Full Name is required' });
      if (!email || !email.trim()) return res.status(400).json({ success: false, message: 'Email is required' });
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return res.status(400).json({ success: false, message: 'Invalid email address format' });
      if (!date_of_birth) return res.status(400).json({ success: false, message: 'Date of Birth is required' });
      
      // Support date format checking
      formattedDob = String(date_of_birth).trim();
      if (/^\d{2}\/\d{2}\/\d{4}$/.test(formattedDob)) {
        // Convert DD/MM/YYYY to YYYY-MM-DD
        const parts = formattedDob.split('/');
        formattedDob = `${parts[2]}-${parts[1]}-${parts[0]}`;
      }
      
      if (!/^\d{4}-\d{2}-\d{2}$/.test(formattedDob)) {
        return res.status(400).json({ success: false, message: 'Date of Birth must be in YYYY-MM-DD format' });
      }
      
      if (!occupation) return res.status(400).json({ success: false, message: 'Occupation is required' });
      if (occupation !== 'student') {
        if (monthly_income === undefined || monthly_income === null || parseFloat(monthly_income) <= 0) {
          return res.status(400).json({ success: false, message: 'Monthly Income is required and must be greater than 0' });
        }
      }
    }

    // Process referral code if provided and user does not already have a referrer
    if (referral_code) {
      const [currentUserRow] = await pool.query('SELECT referred_by FROM users WHERE id = ?', [req.user.id]);
      if (currentUserRow.length && currentUserRow[0].referred_by === null) {
        // Resolve referrer
        const [refRows] = await pool.query(
          'SELECT id, fcm_token FROM users WHERE referral_code = ?',
          [referral_code.trim().toUpperCase()]
        );
        if (refRows.length) {
          const referrerId = refRows[0].id;
          const referrerFcmToken = refRows[0].fcm_token;
          if (referrerId !== req.user.id) {
            // Update referred_by
            await pool.query('UPDATE users SET referred_by = ? WHERE id = ?', [referrerId, req.user.id]);
            // Create referral record
            await pool.query(
              'INSERT IGNORE INTO referrals (referrer_id, referred_id) VALUES (?, ?)',
              [referrerId, req.user.id]
            );
            // In-app notification for referrer
            const title = '👥 New Referral!';
            const message = `${full_name || 'A new user'} joined Ppokket using your referral code. You will earn a credit limit bonus once they complete KYC.`;
            await pool.query(
              'INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, ?)',
              [referrerId, title, message, 'promo']
            );
            // Push notification for referrer
            if (referrerFcmToken) {
              await sendNotification(referrerFcmToken, title, message, { screen: 'Referrals' });
            }
          } else {
            return res.status(400).json({ success: false, message: 'You cannot refer yourself.' });
          }
        } else {
          return res.status(400).json({ success: false, message: 'Invalid referral code.' });
        }
      }
    }

    // Prevent updates to verified details
    const [userRow] = await pool.query('SELECT is_kyc_verified, pan_verified, aadhaar_verified, full_name as old_name, email as old_email, date_of_birth as old_dob, occupation as old_occ, monthly_income as old_inc, pan_number as old_pan, aadhaar_number as old_aadhaar FROM users WHERE id = ?', [req.user.id]);
    const u = userRow[0] || {};
    
    // Check for PAN lock violation
    if (u.pan_verified && pan_number !== undefined && pan_number !== null && pan_number.trim().toUpperCase() !== (u.old_pan ? u.old_pan.trim().toUpperCase() : '')) {
      return res.status(400).json({ success: false, message: 'Verified PAN details cannot be changed.' });
    }

    // Check for Aadhaar lock violation
    if (u.aadhaar_verified && aadhaar_number !== undefined && aadhaar_number !== null && String(aadhaar_number).trim() !== (u.old_aadhaar ? String(u.old_aadhaar).trim() : '')) {
      return res.status(400).json({ success: false, message: 'Verified Aadhaar details cannot be changed.' });
    }

    let final_pan = pan_number;
    let final_aadhaar = aadhaar_number;
    let final_name = full_name;
    let final_email = email;
    let final_dob = formattedDob;
    let final_occ = occupation;
    let final_inc = monthly_income;

    await pool.query(
      `UPDATE users SET
        full_name = COALESCE(?, full_name),
        email = COALESCE(?, email),
        pan_number = COALESCE(?, pan_number),
        aadhaar_number = COALESCE(?, aadhaar_number),
        date_of_birth = COALESCE(?, date_of_birth),
        occupation = COALESCE(?, occupation),
        monthly_income = COALESCE(?, monthly_income),
        fcm_token = COALESCE(?, fcm_token),
        dark_mode = COALESCE(?, dark_mode),
        language = COALESCE(?, language),
        updated_at = NOW()
      WHERE id = ?`,
      [final_name, final_email, final_pan, final_aadhaar, final_dob, final_occ, final_inc, fcm_token, dark_mode, language, req.user.id]
    );
    const [rows] = await pool.query('SELECT * FROM users WHERE id = ?', [req.user.id]);
    const user = rows[0];
    delete user.password;
    
    // Load global system settings for fallbacks
    const [settingsRows] = await pool.query('SELECT setting_key, setting_value FROM system_settings');
    const settings = {};
    for (const r of settingsRows) {
      settings[r.setting_key] = r.setting_value;
    }
    const defaultFirstEmiPct = parseFloat(settings.first_emi_principal_pct || 25);
    const defaultProcFeePct = parseFloat(settings.processing_fee_pct || 2);

    user.first_emi_pct = user.custom_first_emi_pct != null ? parseFloat(user.custom_first_emi_pct) : defaultFirstEmiPct;
    user.processing_fee_pct = user.custom_processing_fee_pct != null ? parseFloat(user.custom_processing_fee_pct) : defaultProcFeePct;
    user.processing_fee_in_first_emi = settings.processing_fee_in_first_emi === 'true' || settings.processing_fee_in_first_emi === true || settings.processing_fee_in_first_emi === '1';
    user.gst_on_processing_fee = parseFloat(settings.gst_on_processing_fee || 18);

    await invalidateUserCache(req.user.id);
    res.json({ success: true, message: 'Profile updated', user });
  } catch (err) {
    console.error('[updateProfile]', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// PUT /api/user/bank-details
const updateBankDetails = async (req, res) => {
  try {
    const [check] = await pool.query('SELECT is_verified FROM bank_details WHERE user_id = ?', [req.user.id]);
    if (check.length && check[0].is_verified) {
      return res.status(400).json({ success: false, message: 'Bank details are already verified and cannot be changed.' });
    }

    const { account_holder, account_number, ifsc_code, bank_name, account_type } = req.body;
    await pool.query(
      `INSERT INTO bank_details (user_id, account_holder, account_number, ifsc_code, bank_name, account_type)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         account_holder = VALUES(account_holder),
         account_number = VALUES(account_number),
         ifsc_code = VALUES(ifsc_code),
         bank_name = VALUES(bank_name),
         account_type = VALUES(account_type),
         updated_at = NOW()`,
      [req.user.id, account_holder, account_number, ifsc_code, bank_name, account_type || 'savings']
    );
    await invalidateUserCache(req.user.id);
    res.json({ success: true, message: 'Bank details saved' });
  } catch (err) {
    console.error('[updateBankDetails]', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/user/bank-verify
const verifyBankDetails = async (req, res) => {
  try {
    const { account_holder, account_number, ifsc_code, bank_name, account_type } = req.body;
    const userId = req.user.id;

    // ── Step 0: All fields present ───────────────────────────────────────────
    if (!account_holder?.trim()) {
      return res.status(400).json({ success: false, field: 'holder', message: 'Account holder name is required.' });
    }
    if (!account_number?.trim()) {
      return res.status(400).json({ success: false, field: 'account', message: 'Account number is required.' });
    }
    if (!ifsc_code?.trim()) {
      return res.status(400).json({ success: false, field: 'ifsc', message: 'IFSC code is required.' });
    }
    if (!bank_name?.trim()) {
      return res.status(400).json({ success: false, field: 'bankName', message: 'Bank name is required.' });
    }

    // ── Step 1: Format validation ────────────────────────────────────────────
    const cleanAcc  = account_number.trim().replace(/[\s-]/g, '');
    const cleanIfsc = ifsc_code.trim().toUpperCase();

    if (!/^\d{9,18}$/.test(cleanAcc)) {
      return res.status(400).json({
        success: false, field: 'account',
        message: `Invalid account number "${cleanAcc}" — must be 9 to 18 digits with no spaces or dashes.`,
      });
    }
    if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(cleanIfsc)) {
      return res.status(400).json({
        success: false, field: 'ifsc',
        message: `Invalid IFSC code "${cleanIfsc}" — correct format is 4 letters + 0 + 6 alphanumeric (e.g. HDFC0001234).`,
      });
    }

    // ── Step 2: Verify account number via Penny Drop ─────────────────────────
    const [userRow] = await pool.query('SELECT mobile FROM users WHERE id = ?', [userId]);
    const mobile = userRow[0]?.mobile || '';

    let verifyRes;
    try {
      verifyRes = await verifyBankAccount({
        ifsc: cleanIfsc, accountNumber: cleanAcc,
        name: account_holder.trim(), mobile, useCache: false,
      });
    } catch (err) {
      return res.status(502).json({ success: false, message: `Bank verification service error: ${err.message}` });
    }

    // ── Step 3: Account must be found at this IFSC ───────────────────────────
    if (!verifyRes.success || !verifyRes.accountExists) {
      return res.status(400).json({
        success: false, field: 'account_ifsc',
        message: `Account number ${cleanAcc} was not found at IFSC ${cleanIfsc}. Please check both and try again.`,
      });
    }

    // ── Step 4: Account number echo-back must match ──────────────────────────
    const returnedAcc = (verifyRes.accountNumber || '').trim().replace(/[\s-]/g, '');
    if (returnedAcc && returnedAcc !== cleanAcc) {
      return res.status(400).json({
        success: false, field: 'account',
        message: `Account number mismatch — bank confirmed account ending in ...${returnedAcc.slice(-4)}, but you entered ...${cleanAcc.slice(-4)}. Please re-check your account number.`,
      });
    }

    // ── Step 5: IFSC echo-back must match ────────────────────────────────────
    const returnedIfsc = (verifyRes.ifsc || '').trim().toUpperCase();
    if (returnedIfsc && returnedIfsc !== cleanIfsc) {
      return res.status(400).json({
        success: false, field: 'ifsc',
        message: `IFSC mismatch — bank returned "${returnedIfsc}" but you entered "${cleanIfsc}". Please use the correct IFSC for your branch.`,
      });
    }

    // ── Step 6: Account holder name must match ───────────────────────────────
    if (!verifyRes.nameAtBank) {
      return res.status(400).json({
        success: false, field: 'holder',
        message: 'Bank did not return the account holder name. Please try again or contact your bank.',
      });
    }
    const nameResult = compareName(verifyRes.nameAtBank, account_holder.trim());
    if (!nameResult.match) {
      return res.status(400).json({
        success: false, field: 'holder',
        message: `Name mismatch — your bank has "${verifyRes.nameAtBank}" registered for this account, but you entered "${account_holder.trim()}". Enter your name exactly as it appears on your bank passbook.`,
      });
    }

    const finalHolderName = verifyRes.nameAtBank;

    // ── Step 7: Verify IFSC code and fetch branch details ────────────────────
    let ifscData = null;
    try {
      const ifscRes = await verifyIFSC(cleanIfsc);
      if (!ifscRes.success) {
        return res.status(400).json({
          success: false, field: 'ifsc',
          message: `IFSC code "${cleanIfsc}" could not be verified — ${ifscRes.message}. Please check the IFSC printed on your cheque or passbook.`,
        });
      }
      ifscData = ifscRes;
    } catch (ifscErr) {
      return res.status(502).json({ success: false, message: `IFSC verification service error: ${ifscErr.message}` });
    }

    // Save/Update bank details with all IFSC branch data
    await pool.query(
      `INSERT INTO bank_details
         (user_id, account_holder, account_number, ifsc_code, bank_name, account_type, is_verified,
          ifsc_bank_name, branch, branch_address, city, state, micr, swift, contact,
          neft, rtgs, imps, upi, ifsc_verified, ifsc_request_id)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
       ON DUPLICATE KEY UPDATE
         account_holder  = VALUES(account_holder),
         account_number  = VALUES(account_number),
         ifsc_code       = VALUES(ifsc_code),
         bank_name       = VALUES(bank_name),
         account_type    = VALUES(account_type),
         is_verified     = 1,
         ifsc_bank_name  = VALUES(ifsc_bank_name),
         branch          = VALUES(branch),
         branch_address  = VALUES(branch_address),
         city            = VALUES(city),
         state           = VALUES(state),
         micr            = VALUES(micr),
         swift           = VALUES(swift),
         contact         = VALUES(contact),
         neft            = VALUES(neft),
         rtgs            = VALUES(rtgs),
         imps            = VALUES(imps),
         upi             = VALUES(upi),
         ifsc_verified   = 1,
         ifsc_request_id = VALUES(ifsc_request_id),
         updated_at      = NOW()`,
      [
        userId,
        finalHolderName,
        cleanAcc,
        cleanIfsc,
        ifscData.bank || bank_name.trim(),   // prefer API-confirmed bank name
        account_type || 'savings',
        ifscData.bank    || null,
        ifscData.branch  || null,
        ifscData.address || null,
        ifscData.city    || null,
        ifscData.state   || null,
        ifscData.micr    || null,
        ifscData.swift   || null,
        ifscData.contact || null,
        ifscData.neft ? 1 : 0,
        ifscData.rtgs ? 1 : 0,
        ifscData.imps ? 1 : 0,
        ifscData.upi  ? 1 : 0,
        ifscData.requestId || null,
      ]
    );

    // Update bank_verified = 1 in users table
    await pool.query('UPDATE users SET bank_verified = 1 WHERE id = ?', [userId]);

    // Invalidate user caches
    await invalidateUserCache(userId);

    return res.json({
      success:      true,
      verified:     true,
      name_at_bank: finalHolderName,
      utr:          verifyRes.utr,
      ifsc: {
        ifsc:    ifscData.ifsc,
        bank:    ifscData.bank,
        branch:  ifscData.branch,
        address: ifscData.address,
        city:    ifscData.city,
        state:   ifscData.state,
        micr:    ifscData.micr,
        swift:   ifscData.swift,
        contact: ifscData.contact,
        neft:    ifscData.neft,
        rtgs:    ifscData.rtgs,
        imps:    ifscData.imps,
        upi:     ifscData.upi,
      },
      message: 'Bank account and IFSC verified successfully.',
    });
  } catch (err) {
    console.error('[verifyBankDetails]', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/user/dashboard
const getDashboard = async (req, res) => {
  try {
    const userId = req.user.id;
    const cacheKey = `user:${userId}:dashboard`;
    const cached = await getCache(cacheKey);
    if (cached) return res.json(cached);

    const [userRows] = await pool.query(
      'SELECT credit_limit, withdrawal_limit, wallet_balance, credit_score, experian_score, is_kyc_verified FROM users WHERE id = ?', [userId]
    );
    const [kycRows] = await pool.query(
      'SELECT status FROM kyc_documents WHERE user_id = ?', [userId]
    );
    const kyc_status = userRows[0]?.is_kyc_verified
      ? 'approved'
      : (kycRows[0]?.status || 'not_submitted');
    const [activeLoan] = await pool.query(
      'SELECT * FROM loans WHERE user_id = ? AND status IN ("disbursed","approved","withdrawal_requested") ORDER BY created_at DESC LIMIT 1', [userId]
    );
    let nextEmiRow = null;
    if (activeLoan.length && activeLoan[0].status === 'disbursed') {
      const [nextEmi] = await pool.query(
        'SELECT * FROM emi_schedule WHERE user_id = ? AND status = "upcoming" ORDER BY due_date ASC LIMIT 1', [userId]
      );
      nextEmiRow = nextEmi[0] || null;
    }
    const [recentTxn] = await pool.query(
      "SELECT * FROM transactions WHERE user_id = ? AND status = 'success' ORDER BY created_at DESC LIMIT 5", [userId]
    );
    const [unreadNotif] = await pool.query(
      'SELECT COUNT(*) as count FROM notifications WHERE user_id = ? AND is_read = 0', [userId]
    );

    // Calculate dynamic revolving limits
    const creditDetails = await getUserCreditDetails(userId, userRows[0]?.credit_limit || 0, userRows[0]?.withdrawal_limit ?? null);

    const response = {
      success: true,
      dashboard: {
        ...userRows[0],
        kyc_status,
        active_loan: activeLoan[0] || null,
        next_emi: nextEmiRow,
        recent_transactions: recentTxn,
        unread_notifications: unreadNotif[0]?.count || 0,
        available_credit: creditDetails.availableCredit,
        occupied_credit: creditDetails.occupiedCredit,
      }
    };
    await setCache(cacheKey, response, CACHE_TTL.SHORT);
    res.json(response);
  } catch (err) {
    console.error('[getDashboard]', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/user/check-eligibility
const checkEligibility = async (req, res) => {
  try {
    const userId = req.user.id;
    const [rows] = await pool.query('SELECT pan_number, monthly_income, occupation FROM users WHERE id = ?', [userId]);
    if (!rows.length) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    
    const { pan_number, monthly_income, occupation } = rows[0];
    
    if (!pan_number || !monthly_income || !occupation) {
      return res.status(400).json({
        success: false,
        message: 'Please complete your profile details (PAN Number, Occupation, and Monthly Income) to check eligibility.'
      });
    }
    
    // PAN validation check
    const panRegex = /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/;
    if (!panRegex.test(pan_number.toUpperCase())) {
      return res.status(400).json({ success: false, message: 'Invalid PAN card number format in profile.' });
    }
    
    // Calculate score & limit deterministically
    let hash = 0;
    const panClean = pan_number.toUpperCase();
    for (let i = 0; i < panClean.length; i++) {
      hash = (hash << 5) - hash + panClean.charCodeAt(i);
      hash |= 0;
    }
    
    const baseScore = 650 + Math.abs(hash % 151); // 650 to 800
    let score = baseScore;
    let limit = 10000; // default
    
    const income = parseFloat(monthly_income) || 0;
    
    if (occupation.toLowerCase() === 'student') {
      limit = 5000;
      score = score > 710 ? 710 : score;
    } else if (occupation.toLowerCase() === 'salaried') {
      if (income >= 50000) {
        limit = 45000;
        score = Math.min(850, score + 40);
      } else if (income >= 30000) {
        limit = 30000;
        score = Math.min(850, score + 20);
      } else if (income >= 15000) {
        limit = 15000;
      } else {
        limit = 5000;
        score = Math.max(300, score - 30);
      }
    } else { // self_employed / other
      if (income >= 50000) {
        limit = 35000;
        score = Math.min(850, score + 20);
      } else if (income >= 30000) {
        limit = 25000;
      } else if (income >= 15000) {
        limit = 12000;
      } else {
        limit = 5000;
        score = Math.max(300, score - 20);
      }
    }
    
    // Update credit score only — credit limit is assigned by admin on KYC approval
    await pool.query(
      'UPDATE users SET credit_score = ?, updated_at = NOW() WHERE id = ?',
      [score, userId]
    );

    await pool.query(
      'INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, ?)',
      [userId, 'Credit Score Updated 📊', `Your estimated credit score is ${score}. Your credit limit will be assigned by our team after KYC review.`, 'system']
    );

    await invalidateUserCache(userId);

    res.json({
      success: true,
      message: 'Credit score calculated successfully. Your credit limit will be assigned by our team after KYC verification.',
      credit_score: score,
      suggested_limit: limit,
    });
  } catch (err) {
    console.error('[checkEligibility]', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/user/notifications
const getNotifications = async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50',
      [req.user.id]
    );
    res.json({ success: true, notifications: rows });
  } catch (err) {
    console.error('[getNotifications]', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// PUT /api/user/notifications/read
const markNotificationsRead = async (req, res) => {
  try {
    await pool.query(
      'UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0',
      [req.user.id]
    );
    // Invalidate dashboard cache since unread count will change
    await invalidateUserCache(req.user.id);
    res.json({ success: true, message: 'Marked as read' });
  } catch (err) {
    console.error('[markNotificationsRead]', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

module.exports = { getProfile, updateProfile, updateBankDetails, verifyBankDetails, getDashboard, checkEligibility, getNotifications, markNotificationsRead };

