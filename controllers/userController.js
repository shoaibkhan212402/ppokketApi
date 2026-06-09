const { pool } = require('../config/db');
const { getCache, setCache, invalidateUserCache, CACHE_TTL } = require('../config/redis');

// GET /api/user/profile
const getProfile = async (req, res) => {
  try {
    const cacheKey = `user:${req.user.id}:profile`;
    const cached = await getCache(cacheKey);
    if (cached) return res.json(cached);

    const [rows] = await pool.query(
      `SELECT u.*, bd.account_holder, bd.account_number, bd.ifsc_code, bd.bank_name, bd.account_type, bd.is_verified as bank_verified,
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
    const { full_name, email, pan_number, aadhaar_number, date_of_birth, occupation, monthly_income, fcm_token, dark_mode, language } = req.body;
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
      [full_name, email, pan_number, aadhaar_number, date_of_birth, occupation, monthly_income, fcm_token, dark_mode, language, req.user.id]
    );
    const [rows] = await pool.query('SELECT * FROM users WHERE id = ?', [req.user.id]);
    const user = rows[0];
    delete user.password;
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
    
    if (!account_holder || !account_number || !ifsc_code || !bank_name) {
      return res.status(400).json({ success: false, message: 'All fields are required for bank verification.' });
    }

    // Dummy Validation Checks
    if (!/^\d{9,18}$/.test(account_number)) {
      return res.status(400).json({ success: false, message: 'Invalid bank account number. Must be between 9 and 18 digits.' });
    }

    const ifscRegex = /^[A-Z]{4}0[A-Z0-9]{6}$/;
    if (!ifscRegex.test(ifsc_code.trim().toUpperCase())) {
      return res.status(400).json({ success: false, message: 'Invalid IFSC code format. E.g. HDFC0001234' });
    }

    // Save/Update with is_verified = 1
    await pool.query(
      `INSERT INTO bank_details (user_id, account_holder, account_number, ifsc_code, bank_name, account_type, is_verified)
       VALUES (?, ?, ?, ?, ?, ?, 1)
       ON DUPLICATE KEY UPDATE
         account_holder = VALUES(account_holder),
         account_number = VALUES(account_number),
         ifsc_code = VALUES(ifsc_code),
         bank_name = VALUES(bank_name),
         account_type = VALUES(account_type),
         is_verified = 1,
         updated_at = NOW()`,
      [
        req.user.id,
        account_holder.trim(),
        account_number.trim(),
        ifsc_code.trim().toUpperCase(),
        bank_name.trim(),
        account_type || 'savings'
      ]
    );

    // Invalidate user caches
    await invalidateUserCache(req.user.id);

    return res.json({
      success: true,
      verified: true,
      message: 'Bank account verified successfully via dummy gateway.'
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
      'SELECT credit_limit, wallet_balance, credit_score, is_kyc_verified FROM users WHERE id = ?', [userId]
    );
    const [kycRows] = await pool.query(
      'SELECT status FROM kyc_documents WHERE user_id = ?', [userId]
    );
    const kyc_status = userRows[0]?.is_kyc_verified
      ? 'approved'
      : (kycRows[0]?.status || 'not_submitted');
    const [activeLoan] = await pool.query(
      'SELECT * FROM loans WHERE user_id = ? AND status IN ("disbursed","approved") ORDER BY created_at DESC LIMIT 1', [userId]
    );
    const [nextEmi] = await pool.query(
      'SELECT * FROM emi_schedule WHERE user_id = ? AND status = "upcoming" ORDER BY due_date ASC LIMIT 1', [userId]
    );
    const [recentTxn] = await pool.query(
      'SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 5', [userId]
    );
    const [unreadNotif] = await pool.query(
      'SELECT COUNT(*) as count FROM notifications WHERE user_id = ? AND is_read = 0', [userId]
    );
    const response = {
      success: true,
      dashboard: {
        ...userRows[0],
        kyc_status,
        active_loan: activeLoan[0] || null,
        next_emi: nextEmi[0] || null,
        recent_transactions: recentTxn,
        unread_notifications: unreadNotif[0]?.count || 0,
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

module.exports = { getProfile, updateProfile, updateBankDetails, verifyBankDetails, getDashboard, checkEligibility };

