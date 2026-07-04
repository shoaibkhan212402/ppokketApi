const { pool } = require('../config/db');
const { calculateEMI, generateEMISchedule } = require('../utils/loanUtils');
const { sendNotification } = require('../utils/fcm');
const { getCache, setCache, delCache, invalidateUserCache, CACHE_TTL } = require('../config/redis');
const { sendLoanAgreementEmail } = require('../utils/email');

// POST /api/loan/apply
const applyLoan = async (req, res) => {
  try {
    const userId = req.user.id;
    const { duration_months, purpose } = req.body;
    const amount = Number(req.body.amount);

    if (!Number.isFinite(amount) || amount < 1000) {
      return res.status(400).json({ success: false, message: 'Invalid loan amount. Minimum withdrawal is ₹1,000.' });
    }

    // Check KYC
    const [kyc] = await pool.query('SELECT status FROM kyc_documents WHERE user_id = ?', [userId]);
    if (!kyc.length || kyc[0].status !== 'approved') {
      return res.status(403).json({ success: false, message: 'KYC verification required before applying for a loan' });
    }

    // Check existing active loan
    const [existing] = await pool.query(
      'SELECT id FROM loans WHERE user_id = ? AND status IN ("pending","under_review","approved","withdrawal_requested")',
      [userId]
    );
    if (existing.length) {
      return res.status(400).json({ success: false, message: 'You already have an active loan application' });
    }

    // Check credit limit & withdrawal limit; fetch user custom interest rate and terms
    const [userRows] = await pool.query(
      'SELECT credit_limit, withdrawal_limit, interest_rate, custom_processing_fee_pct, custom_first_emi_pct, kyc_approved_tenure FROM users WHERE id = ?',
      [userId]
    );
    if (!userRows.length) return res.status(404).json({ success: false, message: 'User not found' });
    const user = userRows[0];

    // Dynamically validate requested duration against approved maximum tenure
    const maxTenure = user.kyc_approved_tenure ? parseInt(user.kyc_approved_tenure) : 6;
    if (parseInt(duration_months) < 1 || parseInt(duration_months) > maxTenure) {
      return res.status(400).json({ success: false, message: `Tenure must be between 1 and ${maxTenure} months.` });
    }
    const creditLimit = Number(user.credit_limit) || 0;
    // effective cap = min(credit_limit, withdrawal_limit) — withdrawal_limit NULL means no extra cap
    const withdrawalLimit = user.withdrawal_limit !== null ? Number(user.withdrawal_limit) : creditLimit;
    const effectiveLimit  = Math.min(creditLimit, withdrawalLimit);

    if (creditLimit <= 0) {
      return res.status(400).json({ success: false, message: 'Your credit limit has not been assigned yet. Please wait for admin review.' });
    }
    if (amount > effectiveLimit) {
      const msg = withdrawalLimit < creditLimit
        ? `Loan amount exceeds your withdrawal limit of ₹${effectiveLimit} (credit limit: ₹${creditLimit})`
        : `Loan amount exceeds your credit limit of ₹${creditLimit}`;
      return res.status(400).json({ success: false, message: msg });
    }

    // Load system settings
    const [settingsRows] = await pool.query('SELECT setting_key, setting_value FROM system_settings');
    const settings = {};
    for (const r of settingsRows) {
      const v = r.setting_value;
      settings[r.setting_key] = v === 'true' ? true : v === 'false' ? false : (!isNaN(v) && v !== '') ? Number(v) : v;
    }

    const interest_rate = parseFloat(user.interest_rate) || 2.50; // Use admin-assigned ROI
    
    // Resolve user's custom processing fee % or fallback to global settings
    const userFeePct = user.custom_processing_fee_pct != null ? parseFloat(user.custom_processing_fee_pct) : null;
    const feePct = userFeePct ?? parseFloat(settings.processing_fee_pct) ?? 2;
    const processing_fee = Math.round(amount * feePct / 100);

    const emi_amount = calculateEMI(amount, interest_rate, duration_months);

    // Resolve user's custom first EMI collection % or fallback to global settings
    const userFirstEmiPct = user.custom_first_emi_pct != null ? parseFloat(user.custom_first_emi_pct) : null;
    const resolvedFirstEmiPct = userFirstEmiPct ?? parseFloat(settings.first_emi_principal_pct) ?? 0;

    const mergedSettings = {
      ...settings,
      first_emi_principal_pct: resolvedFirstEmiPct
    };

    // Generate schedule to resolve true total payable based on custom user settings
    const schedule = generateEMISchedule(
      { amount, interest_rate, duration_months, emi_amount, processing_fee },
      null,
      mergedSettings
    );

    const total_payable = schedule.reduce((sum, r) => sum + parseFloat(r.emi_amount), 0);

    const [result] = await pool.query(
      `INSERT INTO loans (user_id, amount, interest_rate, duration_months, emi_amount, processing_fee, processing_fee_pct, first_emi_pct, processing_fee_in_first_emi, total_payable, purpose, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
      [userId, amount, interest_rate, duration_months, emi_amount, processing_fee, feePct, resolvedFirstEmiPct, settings.processing_fee_in_first_emi ? 1 : 0, total_payable, purpose || null]
    );

    const loanId = result.insertId;

    // Insert notification
    await pool.query(
      'INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, ?)',
      [userId, 'Loan Application Submitted', `Your loan application of ₹${amount} has been submitted and is under review.`, 'loan']
    );

    const firstEmiDate = schedule[0]?.due_date || null;
    const firstEmiAmount = schedule[0]?.emi_amount || emi_amount;

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
        processing_fee_pct: feePct,
        first_emi_pct: resolvedFirstEmiPct,
        processing_fee_in_first_emi: settings.processing_fee_in_first_emi ? 1 : 0,
        total_payable,
        status: 'pending',
        next_emi_date:   firstEmiDate,
        next_emi_amount: firstEmiAmount,
      }
    });
    // Invalidate caches
    await invalidateUserCache(userId);
    await delCache('admin:dashboard', 'admin:dashboard:partner:*');
  } catch (err) {
    console.error('[applyLoan]', err);
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
      `SELECT l.*,
        (SELECT e.due_date FROM emi_schedule e WHERE e.loan_id = l.id AND e.status NOT IN ('paid','waived') ORDER BY e.installment_no ASC LIMIT 1) AS next_emi_date,
        (SELECT e.emi_amount FROM emi_schedule e WHERE e.loan_id = l.id AND e.status NOT IN ('paid','waived') ORDER BY e.installment_no ASC LIMIT 1) AS next_emi_amount,
        (SELECT IFNULL(SUM(e.principal_amount), 0) FROM emi_schedule e WHERE e.loan_id = l.id AND e.status = 'paid') AS principal_paid
       FROM loans l WHERE l.user_id = ? ORDER BY l.created_at DESC`,
      [req.user.id]
    );
    const response = { success: true, loans };
    await setCache(cacheKey, response, CACHE_TTL.MEDIUM);
    res.json(response);
  } catch (err) {
    console.error('[getLoanHistory]', err);
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

    let emiSchedule = [];
    if (['disbursed', 'closed'].includes(loan[0].status)) {
      const [rows] = await pool.query(
        'SELECT * FROM emi_schedule WHERE loan_id = ? ORDER BY installment_no',
        [req.params.id]
      );
      emiSchedule = rows;
    }
    const [transactions] = await pool.query(
      'SELECT * FROM transactions WHERE loan_id = ? ORDER BY created_at DESC',
      [req.params.id]
    );

    res.json({ success: true, loan: loan[0], emi_schedule: emiSchedule, transactions });
  } catch (err) {
    console.error('[getLoanDetails]', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/loan/emi-calculator
const emiCalculator = async (req, res) => {
  try {
    const { amount, duration_months, interest_rate } = req.query;
    const userId  = req.user?.id;

    // Load system settings
    const [settingsRows] = await pool.query('SELECT setting_key, setting_value FROM system_settings');
    const settings = {};
    for (const r of settingsRows) {
      const v = r.setting_value;
      settings[r.setting_key] = v === 'true' ? true : v === 'false' ? false : (!isNaN(v) && v !== '') ? Number(v) : v;
    }

    // Resolve user custom settings if user is logged in
    let rateVal = parseFloat(interest_rate);
    let userFeePct = null;
    let userFirstEmiPct = null;
    let effective_limit = null;

    if (userId) {
      const [rows] = await pool.query(
        'SELECT credit_limit, withdrawal_limit, interest_rate, custom_processing_fee_pct, custom_first_emi_pct FROM users WHERE id = ?',
        [userId]
      );
      if (rows.length) {
        const u = rows[0];
        const cl = Number(u.credit_limit) || 0;
        const wl = u.withdrawal_limit !== null ? Number(u.withdrawal_limit) : cl;
        effective_limit = Math.min(cl, wl);
        
        if (isNaN(rateVal)) {
          rateVal = parseFloat(u.interest_rate);
        }
        
        if (u.custom_processing_fee_pct != null) {
          userFeePct = parseFloat(u.custom_processing_fee_pct);
        }
        if (u.custom_first_emi_pct != null) {
          userFirstEmiPct = parseFloat(u.custom_first_emi_pct);
        }
      }
    }

    if (isNaN(rateVal)) rateVal = 2.5;

    const principal = parseFloat(amount) || 10000;
    const months = parseInt(duration_months) || 6;

    // Resolve processing fee (user's custom or global setting)
    const feePct = userFeePct ?? parseFloat(settings.processing_fee_pct) ?? 2;
    const processing_fee = Math.round(principal * feePct / 100);

    const emi = calculateEMI(principal, rateVal, months);

    // Resolve first EMI principal pct (user's custom or global setting)
    const resolvedFirstEmiPct = userFirstEmiPct ?? parseFloat(settings.first_emi_principal_pct) ?? 0;
    
    const mergedSettings = {
      ...settings,
      first_emi_principal_pct: resolvedFirstEmiPct
    };

    // Generate schedule
    const schedule = generateEMISchedule(
      { amount: principal, interest_rate: rateVal, duration_months: months, emi_amount: emi, processing_fee },
      null,
      mergedSettings
    );

    const total_payable = schedule.reduce((sum, r) => sum + parseFloat(r.emi_amount), 0);
    const total_interest = total_payable - principal - (settings.processing_fee_in_first_emi ? 0 : processing_fee);

    res.json({
      success: true,
      emi_amount: Math.round(emi),
      total_payable: Math.round(total_payable),
      total_interest: Math.round(total_interest),
      processing_fee,
      processing_fee_pct: feePct,
      interest_rate: rateVal,
      effective_limit,
      schedule,
    });
  } catch (err) {
    console.error('[emiCalculator]', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/loan/emi-schedule/:id
const getEmiSchedule = async (req, res) => {
  try {
    const loanId = req.params.id;
    const userId = req.user.id;

    // Ensure the loan belongs to this user
    const [loan] = await pool.query('SELECT * FROM loans WHERE id = ? AND user_id = ?', [loanId, userId]);
    if (!loan.length) return res.status(404).json({ success: false, message: 'Loan not found' });

    let schedule = [];
    if (['disbursed', 'closed'].includes(loan[0].status)) {
      const [rows] = await pool.query(
        'SELECT * FROM emi_schedule WHERE loan_id = ? ORDER BY installment_no ASC',
        [loanId]
      );
      schedule = rows;
    }

    res.json({ success: true, schedule });
  } catch (err) {
    console.error('[getEmiSchedule]', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/loan/request-withdrawal/:id
const requestWithdrawal = async (req, res) => {
  try {
    const loanId = req.params.id;
    const userId = req.user.id;
    const { agreementAccepted } = req.body;

    if (!agreementAccepted) {
      return res.status(400).json({ success: false, message: 'You must accept the Loan Agreement to proceed.' });
    }

    // 1. Get loan details
    const [loanRows] = await pool.query('SELECT * FROM loans WHERE id = ? AND user_id = ?', [loanId, userId]);
    if (!loanRows.length) {
      return res.status(404).json({ success: false, message: 'Loan not found' });
    }
    const loan = loanRows[0];

    // 2. Validate loan status is 'approved'
    if (loan.status !== 'approved') {
      return res.status(400).json({ 
        success: false, 
        message: `Withdrawal can only be requested for approved loans. Current status is ${loan.status}.` 
      });
    }

    // 3. Validate bank mandate status is 'active'
    const [mandateRows] = await pool.query('SELECT status FROM bank_mandates WHERE user_id = ?', [userId]);
    const mandateActive = mandateRows.length > 0 && mandateRows[0].status === 'active';
    if (!mandateActive) {
      return res.status(400).json({ 
        success: false, 
        message: 'Auto-Debit mandate must be active before requesting withdrawal.' 
      });
    }

    // 4. Update loan status to 'withdrawal_requested' and set agreement details
    await pool.query(
      `UPDATE loans 
       SET status = 'withdrawal_requested', 
           agreement_accepted = 1, 
           agreement_accepted_at = NOW() 
       WHERE id = ?`,
      [loanId]
    );

    // 5. Create user notification
    await pool.query(
      'INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, ?)',
      [
        userId, 
        'Withdrawal Request Submitted', 
        `Your withdrawal request for ₹${loan.amount} has been submitted successfully and is awaiting disbursement.`, 
        'loan'
      ]
    );

    // Fetch user and bank details for email/notification
    const [userRows] = await pool.query(
      `SELECT u.fcm_token, u.full_name, u.email, u.mobile, a.full_address 
       FROM users u 
       LEFT JOIN aadhaar_kyc a ON u.id = a.user_id 
       WHERE u.id = ?`, 
      [userId]
    );
    const [bankRows] = await pool.query(
      'SELECT bank_name, account_number FROM bank_details WHERE user_id = ? ORDER BY id DESC LIMIT 1',
      [userId]
    );

    // Send push notification
    if (userRows.length && userRows[0].fcm_token) {
      sendNotification(
        userRows[0].fcm_token, 
        'Withdrawal Requested 💸', 
        `Your withdrawal request for ₹${loan.amount} has been received.`, 
        { screen: 'Loans' }
      ).catch(e => console.error('[requestWithdrawal push notification]', e));
    }

    // Send email with PDF agreement
    if (userRows.length && bankRows.length) {
      sendLoanAgreementEmail({
        user: userRows[0],
        loan: loan,
        bank: bankRows[0]
      }).catch(err => console.error('Failed sending loan agreement email:', err));
    }

    // Clear caches
    await invalidateUserCache(userId);
    await delCache('admin:dashboard', 'admin:dashboard:partner:*');

    return res.json({ 
      success: true, 
      message: 'Withdrawal request submitted successfully' 
    });
  } catch (err) {
    console.error('[requestWithdrawal]', err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/loan/withdrawal-status/:id
const getWithdrawalStatus = async (req, res) => {
  try {
    const loanId = req.params.id;
    const userId = req.user.id;

    // Get loan details
    const [loanRows] = await pool.query('SELECT * FROM loans WHERE id = ? AND user_id = ?', [loanId, userId]);
    if (!loanRows.length) {
      return res.status(404).json({ success: false, message: 'Loan not found' });
    }
    const loan = loanRows[0];

    // Get mandate details
    const [mandateRows] = await pool.query('SELECT status FROM bank_mandates WHERE user_id = ?', [userId]);
    const mandateActive = mandateRows.length > 0 && mandateRows[0].status === 'active';

    return res.json({
      success: true,
      loan: {
        id: loan.id,
        amount: loan.amount,
        status: loan.status,
        agreement_accepted: loan.agreement_accepted,
        agreement_accepted_at: loan.agreement_accepted_at
      },
      mandate_active: mandateActive
    });
  } catch (err) {
    console.error('[getWithdrawalStatus]', err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

module.exports = { applyLoan, getLoanHistory, getLoanDetails, emiCalculator, getEmiSchedule, requestWithdrawal, getWithdrawalStatus };
