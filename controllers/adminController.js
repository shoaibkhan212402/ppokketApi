const crypto = require('crypto');
const bcrypt = require('bcrypt');
const fs = require('fs');
const path = require('path');
const { pool } = require('../config/db');
const { sendNotification, sendMulticast } = require('../utils/fcm');
const { generateEMISchedule } = require('../utils/loanUtils');
const { getCache, setCache, delCache, invalidateUserCache, CACHE_TTL } = require('../config/redis');

// GET /api/admin/dashboard
const getAdminDashboard = async (req, res) => {
  try {
    const cacheKey = 'admin:dashboard';
    const cached = await getCache(cacheKey);
    if (cached) return res.json(cached);

    const [[totalUsers]] = await pool.query('SELECT COUNT(*) as count FROM users');
    const [[totalLoans]] = await pool.query('SELECT COUNT(*) as count FROM loans');
    const [[pendingLoans]] = await pool.query("SELECT COUNT(*) as count FROM loans WHERE status = 'pending'");
    const [[approvedLoans]] = await pool.query("SELECT COUNT(*) as count FROM loans WHERE status IN ('approved','disbursed')");
    const [[totalDisbursed]] = await pool.query("SELECT COALESCE(SUM(amount),0) as total FROM loans WHERE status = 'disbursed'");
    const [[totalCollected]] = await pool.query("SELECT COALESCE(SUM(amount),0) as total FROM transactions WHERE status = 'success' AND type = 'emi'");
    const [[pendingKYC]] = await pool.query("SELECT COUNT(*) as count FROM kyc_documents WHERE status = 'pending'");

    const [recentLoans] = await pool.query(
      `SELECT l.*, u.full_name, u.mobile FROM loans l
       JOIN users u ON u.id = l.user_id
       ORDER BY l.created_at DESC LIMIT 10`
    );

    const response = {
      success: true,
      stats: {
        total_users: totalUsers.count,
        total_loans: totalLoans.count,
        pending_loans: pendingLoans.count,
        approved_loans: approvedLoans.count,
        total_disbursed: totalDisbursed.total,
        total_collected: totalCollected.total,
        pending_kyc: pendingKYC.count,
      },
      recent_loans: recentLoans,
    };
    await setCache(cacheKey, response, CACHE_TTL.LONG);
    res.json(response);
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/admin/users
const getAllUsers = async (req, res) => {
  try {
    const { page = 1, limit = 20, search = '' } = req.query;
    const offset = (page - 1) * limit;
    const searchParam = `%${search}%`;

    const [users] = await pool.query(
      `SELECT u.id, u.full_name, u.mobile, u.email, u.date_of_birth as dob, u.pan_number, u.aadhaar_number,
              u.monthly_income, u.occupation as employment_type, u.credit_score, u.credit_limit, u.wallet_balance,
              u.interest_rate, u.is_active, u.is_kyc_verified, u.created_at,
              k.status as kyc_status
       FROM users u
       LEFT JOIN kyc_documents k ON k.user_id = u.id
       WHERE u.full_name LIKE ? OR u.mobile LIKE ? OR u.email LIKE ?
       ORDER BY u.created_at DESC
       LIMIT ? OFFSET ?`,
      [searchParam, searchParam, searchParam, parseInt(limit), parseInt(offset)]
    );

    const [[{ total }]] = await pool.query(
      'SELECT COUNT(*) as total FROM users WHERE full_name LIKE ? OR mobile LIKE ? OR email LIKE ?',
      [searchParam, searchParam, searchParam]
    );

    res.json({ success: true, users, total, page: parseInt(page), limit: parseInt(limit) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/admin/loans
const getAllLoans = async (req, res) => {
  try {
    const { page = 1, limit = 20, status = '' } = req.query;
    const offset = (page - 1) * limit;
    const where = status ? `WHERE l.status = '${pool.escape(status).slice(1,-1)}'` : '';

    const [loans] = await pool.query(
      `SELECT l.*, u.full_name, u.mobile, u.email, u.credit_score
       FROM loans l
       JOIN users u ON u.id = l.user_id
       ${status ? `WHERE l.status = ?` : ''}
       ORDER BY l.created_at DESC
       LIMIT ? OFFSET ?`,
      status ? [status, parseInt(limit), parseInt(offset)] : [parseInt(limit), parseInt(offset)]
    );

    res.json({ success: true, loans });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// PUT /api/admin/approve-loan/:id
const approveLoan = async (req, res) => {
  try {
    const loanId = req.params.id;
    const adminId = req.admin.id;

    const [loan] = await pool.query('SELECT * FROM loans WHERE id = ?', [loanId]);
    if (!loan.length) return res.status(404).json({ success: false, message: 'Loan not found' });
    if (!['pending', 'under_review'].includes(loan[0].status)) {
      return res.status(400).json({ success: false, message: 'Loan cannot be approved in current state' });
    }

    // Generate EMI schedule
    const schedule = generateEMISchedule(loan[0]);
    const emiInserts = schedule.map(s => [
      loanId, loan[0].user_id, s.installment_no, s.due_date, s.emi_amount, s.principal, s.interest
    ]);

    await pool.query(
      `UPDATE loans SET status = 'approved', approved_by = ?, approved_at = NOW(), next_emi_date = ? WHERE id = ?`,
      [adminId, schedule[0].due_date, loanId]
    );

    if (emiInserts.length) {
      await pool.query(
        `INSERT INTO emi_schedule (loan_id, user_id, installment_no, due_date, emi_amount, principal_amount, interest_amount)
         VALUES ?`,
        [emiInserts]
      );
    }

    // Notify user
    const [user] = await pool.query('SELECT fcm_token FROM users WHERE id = ?', [loan[0].user_id]);
    await pool.query(
      'INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, ?)',
      [loan[0].user_id, '🎉 Loan Approved!', `Your loan of ₹${loan[0].amount} has been approved. It will be disbursed within 24 hours.`, 'loan']
    );

    if (user[0]?.fcm_token) {
      await sendNotification(user[0].fcm_token, '🎉 Loan Approved!', `Your loan of ₹${loan[0].amount} has been approved!`);
    }

    res.json({ success: true, message: 'Loan approved successfully' });
    // Invalidate caches
    await invalidateUserCache(loan[0].user_id);
    await delCache('admin:dashboard');
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// PUT /api/admin/reject-loan/:id
const rejectLoan = async (req, res) => {
  try {
    const { reason } = req.body;
    const loanId = req.params.id;

    const [loan] = await pool.query('SELECT * FROM loans WHERE id = ?', [loanId]);
    if (!loan.length) return res.status(404).json({ success: false, message: 'Loan not found' });

    await pool.query(
      `UPDATE loans SET status = 'rejected', rejected_reason = ? WHERE id = ?`,
      [reason || 'Application did not meet eligibility criteria', loanId]
    );

    await pool.query(
      'INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, ?)',
      [loan[0].user_id, 'Loan Application Update', `Your loan application has been rejected. Reason: ${reason || 'Eligibility criteria not met'}. You may apply again after 30 days.`, 'loan']
    );

    res.json({ success: true, message: 'Loan rejected' });
    await invalidateUserCache(loan[0].user_id);
    await delCache('admin:dashboard');
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/admin/kyc - pending KYC list
const getPendingKYC = async (req, res) => {
  try {
    const [kycs] = await pool.query(
      `SELECT k.*, u.full_name, u.mobile, u.email, u.pan_number, u.aadhaar_number,
              bd.bank_name, bd.account_holder, bd.account_number, bd.ifsc_code, bd.account_type
       FROM kyc_documents k
       JOIN users u ON u.id = k.user_id
       LEFT JOIN bank_details bd ON bd.user_id = u.id
       WHERE k.status = 'pending'
       ORDER BY k.created_at ASC`
    );
    res.json({ success: true, kycs });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// PUT /api/admin/kyc/:userId
const reviewKYC = async (req, res) => {
  try {
    const { status, rejection_reason, credit_limit, interest_rate } = req.body;
    const userId = req.params.userId;

    if (!['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ success: false, message: 'Status must be approved or rejected' });
    }

    await pool.query(
      `UPDATE kyc_documents SET status = ?, rejection_reason = ?, reviewed_by = ?, reviewed_at = NOW()
       WHERE user_id = ?`,
      [status, rejection_reason || null, req.admin.id, userId]
    );

    if (status === 'approved') {
      const limitVal = credit_limit !== undefined && credit_limit !== null ? parseFloat(credit_limit) : 10000.00;
      const rateVal = interest_rate !== undefined && interest_rate !== null ? parseFloat(interest_rate) : 2.50;
      await pool.query(
        'UPDATE users SET is_kyc_verified = 1, credit_limit = ?, interest_rate = ? WHERE id = ?',
        [limitVal, rateVal, userId]
      );
    } else {
      await pool.query('UPDATE users SET is_kyc_verified = 0 WHERE id = ?', [userId]);
    }

    const title = status === 'approved' ? '✅ KYC Verified!' : '❌ KYC Rejected';
    const message = status === 'approved'
      ? 'Your KYC has been verified. You can now apply for loans.'
      : `Your KYC was rejected. Reason: ${rejection_reason || 'Documents unclear'}. Please re-upload.`;

    await pool.query(
      'INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, ?)',
      [userId, title, message, 'kyc']
    );

    const [user] = await pool.query('SELECT fcm_token FROM users WHERE id = ?', [userId]);
    if (user[0]?.fcm_token) {
      await sendNotification(user[0].fcm_token, title, message, { screen: 'Profile' });
    }

    res.json({ success: true, message: `KYC ${status} successfully` });
    await invalidateUserCache(userId);
    await delCache('admin:dashboard');
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/admin/transactions
const getAllTransactions = async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;
    const [txns] = await pool.query(
      `SELECT t.*, u.full_name, u.mobile FROM transactions t
       JOIN users u ON u.id = t.user_id
       ORDER BY t.created_at DESC LIMIT ? OFFSET ?`,
      [parseInt(limit), parseInt(offset)]
    );
    res.json({ success: true, transactions: txns });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/admin/notify
const sendBulkNotification = async (req, res) => {
  try {
    const { title, message, user_ids } = req.body;
    if (!title || !message) return res.status(400).json({ success: false, message: 'Title and message required' });

    let tokens = [];

    if (user_ids && user_ids.length) {
      const inserts = user_ids.map(uid => [uid, title, message, 'system']);
      await pool.query('INSERT INTO notifications (user_id, title, message, type) VALUES ?', [inserts]);

      // Get FCM tokens for targeted users
      const [users] = await pool.query(
        'SELECT fcm_token FROM users WHERE id IN (?) AND fcm_token IS NOT NULL',
        [user_ids]
      );
      tokens = users.map(u => u.fcm_token).filter(Boolean);
    } else {
      // All users
      await pool.query(
        `INSERT INTO notifications (user_id, title, message, type)
         SELECT id, ?, ?, 'system' FROM users WHERE is_active = 1`,
        [title, message]
      );

      // Get FCM tokens for all active users
      const [users] = await pool.query(
        'SELECT fcm_token FROM users WHERE is_active = 1 AND fcm_token IS NOT NULL'
      );
      tokens = users.map(u => u.fcm_token).filter(Boolean);
    }

    if (tokens.length) {
      await sendMulticast(tokens, title, message, { screen: 'Home' });
    }

    res.json({ success: true, message: 'Notifications sent' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// PUT /api/admin/disburse-loan/:id
const disburseLoan = async (req, res) => {
  try {
    const loanId = req.params.id;
    const [loan] = await pool.query("SELECT * FROM loans WHERE id = ? AND status = 'approved'", [loanId]);
    if (!loan.length) return res.status(404).json({ success: false, message: 'Approved loan not found' });

    const userId = loan[0].user_id;

    // Check if bank details exist
    const [bank] = await pool.query("SELECT * FROM bank_details WHERE user_id = ?", [userId]);
    if (!bank.length || !bank[0].account_number || !bank[0].ifsc_code) {
      return res.status(400).json({
        success: false,
        message: 'Disbursement failed: User has not updated their bank details yet.'
      });
    }

    const payoutAmount = loan[0].amount;
    const mockUTR = 'PAYOUT' + crypto.randomBytes(6).toString('hex').toUpperCase();

    await pool.query(
      "UPDATE loans SET status = 'disbursed', disbursed_at = NOW() WHERE id = ?",
      [loanId]
    );

    // Credit wallet
    await pool.query('UPDATE users SET wallet_balance = wallet_balance + ? WHERE id = ?', [payoutAmount, userId]);

    await pool.query(
      `INSERT INTO transactions (user_id, loan_id, amount, type, status, description, receipt_url)
       VALUES (?, ?, ?, 'credit', 'success', ?, ?)`,
      [
        userId,
        loanId,
        payoutAmount,
        `Disbursed to Bank Account ${bank[0].bank_name} (A/C: ******${bank[0].account_number.slice(-4)})`,
        `UTR: ${mockUTR}`
      ]
    );

    await pool.query(
      'INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, ?)',
      [
        userId,
        '💰 Loan Disbursed to Bank!',
        `Your loan of ₹${payoutAmount} has been disbursed to your bank account (${bank[0].bank_name} A/C ending in ${bank[0].account_number.slice(-4)}). Ref UTR: ${mockUTR}`,
        'loan'
      ]
    );

    const [user] = await pool.query('SELECT fcm_token FROM users WHERE id = ?', [userId]);
    if (user[0]?.fcm_token) {
      await sendNotification(
        user[0].fcm_token,
        '💰 Loan Disbursed to Bank!',
        `Your loan of ₹${payoutAmount} has been disbursed to your bank account (${bank[0].bank_name} A/C ending in ${bank[0].account_number.slice(-4)}).`,
        { screen: 'Loans' }
      );
    }

    res.json({
      success: true,
      message: 'Loan disbursed successfully to user\'s bank account',
      utr: mockUTR,
      bank: bank[0].bank_name
    });
    await invalidateUserCache(userId);
    await delCache('admin:dashboard');
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/admin/loans/:id/emi-schedule
const getLoanEMISchedule = async (req, res) => {
  try {
    const loanId = req.params.id;
    const [schedule] = await pool.query(
      'SELECT * FROM emi_schedule WHERE loan_id = ? ORDER BY installment_no ASC',
      [loanId]
    );
    res.json({ success: true, emi_schedule: schedule });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// PUT /api/admin/users/:userId/credit-limit
const updateCreditLimit = async (req, res) => {
  try {
    const userId = req.params.userId;
    const { credit_limit, interest_rate } = req.body;

    if (credit_limit === undefined) {
      return res.status(400).json({ success: false, message: 'Credit limit is required' });
    }

    const updates = [];
    const params = [];

    updates.push('credit_limit = ?');
    params.push(parseFloat(credit_limit));

    if (interest_rate !== undefined) {
      updates.push('interest_rate = ?');
      params.push(parseFloat(interest_rate));
    }

    params.push(userId);

    const [result] = await pool.query(
      `UPDATE users SET ${updates.join(', ')} WHERE id = ?`,
      params
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    await invalidateUserCache(userId);
    res.json({ success: true, message: 'Credit limit and interest rate updated successfully' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// PUT /api/admin/users/:userId/toggle-status
const toggleUserStatus = async (req, res) => {
  try {
    const userId = req.params.userId;
    const [user] = await pool.query('SELECT is_active FROM users WHERE id = ?', [userId]);
    if (!user.length) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const newStatus = user[0].is_active ? 0 : 1;
    await pool.query('UPDATE users SET is_active = ? WHERE id = ?', [newStatus, userId]);

    await invalidateUserCache(userId);
    res.json({
      success: true,
      message: `User ${newStatus ? 'activated' : 'blocked'} successfully`,
      is_active: newStatus
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// PUT /api/admin/change-password
const changeAdminPassword = async (req, res) => {
  try {
    const { current_password, new_password } = req.body;
    const adminId = req.admin.id;

    if (!current_password || !new_password) {
      return res.status(400).json({ success: false, message: 'Current and new password required' });
    }

    const [admin] = await pool.query('SELECT password FROM admins WHERE id = ?', [adminId]);
    if (!admin.length) {
      return res.status(404).json({ success: false, message: 'Admin not found' });
    }

    const isMatch = await bcrypt.compare(current_password, admin[0].password);
    if (!isMatch) {
      return res.status(400).json({ success: false, message: 'Incorrect current password' });
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(new_password, salt);

    await pool.query('UPDATE admins SET password = ? WHERE id = ?', [hashedPassword, adminId]);
    res.json({ success: true, message: 'Password updated successfully' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

const getSettingsFilePath = () => path.join(__dirname, '../config/settings.json');

// GET /api/admin/system-settings
const getSystemSettings = async (req, res) => {
  try {
    const filePath = getSettingsFilePath();
    if (!fs.existsSync(filePath)) {
      const defaults = {
        interest_rate: 2.5,
        max_credit_limit: 50000,
        min_loan_amount: 1000,
        processing_fee_pct: 2,
        late_fee: 200
      };
      fs.writeFileSync(filePath, JSON.stringify(defaults, null, 2));
      return res.json(defaults);
    }
    const data = fs.readFileSync(filePath, 'utf8');
    res.json(JSON.parse(data));
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// PUT /api/admin/system-settings
const updateSystemSettings = async (req, res) => {
  try {
    const { interest_rate, max_credit_limit, min_loan_amount, processing_fee_pct, late_fee } = req.body;
    const settings = {
      interest_rate: parseFloat(interest_rate),
      max_credit_limit: parseFloat(max_credit_limit),
      min_loan_amount: parseFloat(min_loan_amount),
      processing_fee_pct: parseFloat(processing_fee_pct),
      late_fee: parseFloat(late_fee)
    };

    const filePath = getSettingsFilePath();
    fs.writeFileSync(filePath, JSON.stringify(settings, null, 2));
    res.json({ success: true, message: 'System settings saved successfully', settings });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

module.exports = {
  getAdminDashboard, getAllUsers, getAllLoans,
  approveLoan, rejectLoan, disburseLoan,
  getPendingKYC, reviewKYC,
  getAllTransactions, sendBulkNotification,
  getLoanEMISchedule,
  updateCreditLimit, toggleUserStatus,
  changeAdminPassword, getSystemSettings, updateSystemSettings
};
