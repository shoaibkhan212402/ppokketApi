const { pool } = require('../config/db');
const { getCache, setCache, invalidateUserCache, CACHE_TTL } = require('../config/redis');

// GET /api/user/profile
const getProfile = async (req, res) => {
  try {
    const cacheKey = `user:${req.user.id}:profile`;
    const cached = await getCache(cacheKey);
    if (cached) return res.json(cached);

    const [rows] = await pool.query(
      `SELECT u.*, bd.account_holder, bd.account_number, bd.ifsc_code, bd.bank_name, bd.account_type, bd.is_verified as bank_verified
       FROM users u
       LEFT JOIN bank_details bd ON bd.user_id = u.id
       WHERE u.id = ?`,
      [req.user.id]
    );
    if (!rows.length) return res.status(404).json({ success: false, message: 'User not found' });
    const user = rows[0];
    delete user.password;
    const response = { success: true, user };
    await setCache(cacheKey, response, CACHE_TTL.SHORT);
    res.json(response);
  } catch (err) {
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
      'SELECT credit_limit, wallet_balance, credit_score FROM users WHERE id = ?', [userId]
    );
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
        active_loan: activeLoan[0] || null,
        next_emi: nextEmi[0] || null,
        recent_transactions: recentTxn,
        unread_notifications: unreadNotif[0]?.count || 0,
      }
    };
    await setCache(cacheKey, response, CACHE_TTL.SHORT);
    res.json(response);
  } catch (err) {
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
    
    // Update credit limit and credit score in database
    await pool.query(
      'UPDATE users SET credit_score = ?, credit_limit = ?, updated_at = NOW() WHERE id = ?',
      [score, limit, userId]
    );
    
    // Insert notification
    await pool.query(
      'INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, ?)',
      [userId, 'Credit Limit Assigned! 💳', `Congratulations! Based on your profile, we have assigned you a credit limit of ₹${limit} with a credit score of ${score}.`, 'system']
    );
    
    res.json({
      success: true,
      message: 'Eligibility check completed successfully',
      credit_score: score,
      credit_limit: limit
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

module.exports = { getProfile, updateProfile, updateBankDetails, getDashboard, checkEligibility };

