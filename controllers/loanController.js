const { pool } = require('../config/db');
const { calculateEMI, generateEMISchedule } = require('../utils/loanUtils');
const { sendNotification } = require('../utils/fcm');
const { getCache, setCache, delCache, invalidateUserCache, CACHE_TTL } = require('../config/redis');

// POST /api/loan/apply
const applyLoan = async (req, res) => {
  try {
    const userId = req.user.id;
    const { amount, duration_months, purpose } = req.body;

    if (![3, 6].includes(parseInt(duration_months))) {
      return res.status(400).json({ success: false, message: 'Tenure must be either 3 or 6 months.' });
    }

    // Check KYC
    const [kyc] = await pool.query('SELECT status FROM kyc_documents WHERE user_id = ?', [userId]);
    if (!kyc.length || kyc[0].status !== 'approved') {
      return res.status(403).json({ success: false, message: 'KYC verification required before applying for a loan' });
    }

    // Check existing active loan
    const [existing] = await pool.query(
      'SELECT id FROM loans WHERE user_id = ? AND status IN ("pending","under_review","approved","disbursed")',
      [userId]
    );
    if (existing.length) {
      return res.status(400).json({ success: false, message: 'You already have an active loan application' });
    }

    // Check credit limit & fetch user custom interest rate
    const [userRows] = await pool.query('SELECT credit_limit, interest_rate FROM users WHERE id = ?', [userId]);
    if (!userRows.length) return res.status(404).json({ success: false, message: 'User not found' });
    const user = userRows[0];
    const creditLimit = Number(user.credit_limit) || 0;

    if (creditLimit <= 0) {
      return res.status(400).json({ success: false, message: 'Your credit limit has not been assigned yet. Please wait for admin review.' });
    }
    if (amount > creditLimit) {
      return res.status(400).json({ success: false, message: `Loan amount exceeds your credit limit of ₹${creditLimit}` });
    }

    const interest_rate = parseFloat(user.interest_rate) || 2.50; // Use admin-assigned ROI
    const processing_fee = Math.round(amount * 0.02); // 2%
    const emi_amount = calculateEMI(amount, interest_rate, duration_months);
    const total_payable = emi_amount * duration_months;

    const [result] = await pool.query(
      `INSERT INTO loans (user_id, amount, interest_rate, duration_months, emi_amount, processing_fee, total_payable, purpose, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
      [userId, amount, interest_rate, duration_months, emi_amount, processing_fee, total_payable, purpose || null]
    );

    const loanId = result.insertId;

    // Insert notification
    await pool.query(
      'INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, ?)',
      [userId, 'Loan Application Submitted', `Your loan application of ₹${amount} has been submitted and is under review.`, 'loan']
    );

    res.status(201).json({
      success: true,
      message: 'Loan application submitted successfully',
      loan: {
        id: loanId,
        amount,
        interest_rate,
        duration_months,
        emi_amount,
        processing_fee,
        total_payable,
        status: 'pending',
      }
    });
    // Invalidate caches
    await invalidateUserCache(userId);
    await delCache('admin:dashboard');
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/loan/history
const getLoanHistory = async (req, res) => {
  try {
    const cacheKey = `user:${req.user.id}:loans`;
    const cached = await getCache(cacheKey);
    if (cached) return res.json(cached);

    const [loans] = await pool.query(
      'SELECT * FROM loans WHERE user_id = ? ORDER BY created_at DESC',
      [req.user.id]
    );
    const response = { success: true, loans };
    await setCache(cacheKey, response, CACHE_TTL.MEDIUM);
    res.json(response);
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/loan/details/:id
const getLoanDetails = async (req, res) => {
  try {
    const [loan] = await pool.query(
      'SELECT * FROM loans WHERE id = ? AND user_id = ?',
      [req.params.id, req.user.id]
    );
    if (!loan.length) return res.status(404).json({ success: false, message: 'Loan not found' });

    const [emiSchedule] = await pool.query(
      'SELECT * FROM emi_schedule WHERE loan_id = ? ORDER BY installment_no',
      [req.params.id]
    );
    const [transactions] = await pool.query(
      'SELECT * FROM transactions WHERE loan_id = ? ORDER BY created_at DESC',
      [req.params.id]
    );

    res.json({ success: true, loan: loan[0], emi_schedule: emiSchedule, transactions });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/loan/emi-calculator
const emiCalculator = async (req, res) => {
  try {
    const { amount, duration_months, interest_rate } = req.query;
    const rateVal = parseFloat(interest_rate) || 2.5;
    const emi = calculateEMI(parseFloat(amount), rateVal, parseInt(duration_months));
    const total_payable = emi * parseInt(duration_months);
    const total_interest = total_payable - parseFloat(amount);
    const processing_fee = Math.round(amount * 0.02);

    res.json({
      success: true,
      emi_amount: Math.round(emi),
      total_payable: Math.round(total_payable),
      total_interest: Math.round(total_interest),
      processing_fee,
      interest_rate: rateVal,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

module.exports = { applyLoan, getLoanHistory, getLoanDetails, emiCalculator };
