const crypto = require('crypto');
const bcrypt = require('bcrypt');
const fs = require('fs');
const path = require('path');
const { pool } = require('../config/db');
const { sendNotification, sendMulticast } = require('../utils/fcm');
const { calculateEMI, generateEMISchedule } = require('../utils/loanUtils');
const { getCache, setCache, delCache, invalidateUserCache, CACHE_TTL } = require('../config/redis');
const { auditLog } = require('../utils/audit');
const { getUserCreditDetails } = require('./userController');

// GET /api/admin/dashboard
const getAdminDashboard = async (req, res) => {
  try {
    const isPartner = ['dsa_partner', 'bank_partner'].includes(req.admin.role);
    const cacheKey = isPartner ? `admin:dashboard:partner:${req.admin.id}` : 'admin:dashboard';
    const cached = await getCache(cacheKey);
    if (cached) return res.json(cached);

    let totalUsers, totalLoans, pendingLoans, approvedLoans, totalDisbursed, totalCollected, pendingKYC, recentLoans;

    if (isPartner) {
      [[totalUsers]] = await pool.query('SELECT COUNT(*) as count FROM users WHERE assigned_partner_id = ?', [req.admin.id]);
      [[totalLoans]] = await pool.query('SELECT COUNT(*) as count FROM loans l JOIN users u ON u.id = l.user_id WHERE u.assigned_partner_id = ?', [req.admin.id]);
      [[pendingLoans]] = await pool.query("SELECT COUNT(*) as count FROM loans l JOIN users u ON u.id = l.user_id WHERE l.status = 'pending' AND u.assigned_partner_id = ?", [req.admin.id]);
      [[approvedLoans]] = await pool.query("SELECT COUNT(*) as count FROM loans l JOIN users u ON u.id = l.user_id WHERE l.status IN ('approved','disbursed') AND u.assigned_partner_id = ?", [req.admin.id]);
      [[totalDisbursed]] = await pool.query("SELECT COALESCE(SUM(l.amount),0) as total FROM loans l JOIN users u ON u.id = l.user_id WHERE l.status = 'disbursed' AND u.assigned_partner_id = ?", [req.admin.id]);
      [[totalCollected]] = await pool.query("SELECT COALESCE(SUM(t.amount),0) as total FROM transactions t JOIN users u ON u.id = t.user_id WHERE t.status = 'success' AND t.type = 'emi' AND u.assigned_partner_id = ?", [req.admin.id]);
      [[pendingKYC]] = await pool.query("SELECT COUNT(*) as count FROM kyc_documents kd JOIN users u ON u.id = kd.user_id WHERE kd.status = 'pending' AND u.assigned_partner_id = ?", [req.admin.id]);
      const [[overdueEmis]] = await pool.query("SELECT COUNT(*) as count FROM emi_schedule e JOIN users u ON u.id = e.user_id WHERE e.status = 'overdue' AND u.assigned_partner_id = ?", [req.admin.id]);

      [recentLoans] = await pool.query(
        `SELECT l.*, u.full_name, u.mobile,
                (SELECT e.emi_amount FROM emi_schedule e WHERE e.loan_id = l.id AND e.status NOT IN ('paid','waived') ORDER BY e.installment_no ASC LIMIT 1) AS next_emi_amount,
                (SELECT e.due_date FROM emi_schedule e WHERE e.loan_id = l.id AND e.status NOT IN ('paid','waived') ORDER BY e.installment_no ASC LIMIT 1) AS next_emi_date
         FROM loans l
         JOIN users u ON u.id = l.user_id
         WHERE u.assigned_partner_id = ?
         ORDER BY l.created_at DESC LIMIT 10`,
        [req.admin.id]
      );

      const [pipelineRows] = await pool.query(
        `SELECT lead_status, COUNT(*) as count FROM users WHERE assigned_partner_id = ? GROUP BY lead_status`,
        [req.admin.id]
      );
      const lead_pipeline = {};
      for (const r of pipelineRows) lead_pipeline[r.lead_status] = r.count;

      const response = {
        success: true,
        stats: {
          total_users: totalUsers.count,
          total_loans: totalLoans.count,
          pending_loans: pendingLoans.count,
          approved_loans: approvedLoans.count,
          total_disbursed: parseFloat(totalDisbursed.total),
          total_collected: parseFloat(totalCollected.total),
          pending_kyc: pendingKYC.count,
          overdue_emis: overdueEmis.count,
        },
        lead_pipeline,
        recent_loans: recentLoans,
      };
      await setCache(cacheKey, response, CACHE_TTL.LONG);
      return res.json(response);
    } else {
      [[totalUsers]] = await pool.query('SELECT COUNT(*) as count FROM users');
      [[totalLoans]] = await pool.query('SELECT COUNT(*) as count FROM loans');
      [[pendingLoans]] = await pool.query("SELECT COUNT(*) as count FROM loans WHERE status = 'pending'");
      [[approvedLoans]] = await pool.query("SELECT COUNT(*) as count FROM loans WHERE status IN ('approved','disbursed')");
      [[totalDisbursed]] = await pool.query("SELECT COALESCE(SUM(amount),0) as total FROM loans WHERE status = 'disbursed'");
      [[totalCollected]] = await pool.query("SELECT COALESCE(SUM(amount),0) as total FROM transactions WHERE status = 'success' AND type = 'emi'");
      [[pendingKYC]] = await pool.query("SELECT COUNT(*) as count FROM kyc_documents WHERE status = 'pending'");

      [recentLoans] = await pool.query(
        `SELECT l.*, u.full_name, u.mobile,
                (SELECT e.emi_amount FROM emi_schedule e WHERE e.loan_id = l.id AND e.status NOT IN ('paid','waived') ORDER BY e.installment_no ASC LIMIT 1) AS next_emi_amount,
                (SELECT e.due_date FROM emi_schedule e WHERE e.loan_id = l.id AND e.status NOT IN ('paid','waived') ORDER BY e.installment_no ASC LIMIT 1) AS next_emi_date
         FROM loans l
         JOIN users u ON u.id = l.user_id
         ORDER BY l.created_at DESC LIMIT 10`
      );
    }

    const [[pendingContact]] = await pool.query("SELECT COUNT(*) as count FROM contact_messages WHERE is_read = 0");
    const [[overdueEmisAll]] = await pool.query("SELECT COUNT(*) as count FROM emi_schedule WHERE status = 'overdue'");

    const response = {
      success: true,
      stats: {
        total_users: totalUsers.count,
        total_loans: totalLoans.count,
        pending_loans: pendingLoans.count,
        approved_loans: approvedLoans.count,
        total_disbursed: parseFloat(totalDisbursed.total),
        total_collected: parseFloat(totalCollected.total),
        pending_kyc: pendingKYC.count,
        pending_contact_messages: pendingContact.count,
        overdue_emis: overdueEmisAll.count,
      },
      recent_loans: recentLoans,
    };
    await setCache(cacheKey, response, CACHE_TTL.LONG);
    res.json(response);
  } catch (err) {
    console.error('[getAdminDashboard]', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/admin/users
const getAllUsers = async (req, res) => {
  try {
    const { page = 1, limit = 20, search = '' } = req.query;
    const offset = (page - 1) * limit;
    const searchParam = `%${search}%`;
    const isPartner = ['dsa_partner', 'bank_partner'].includes(req.admin.role);

    let query = `
      SELECT u.id, u.full_name, u.mobile, u.email, u.date_of_birth as dob, u.pan_number, u.aadhaar_number,
              u.monthly_income, u.occupation as employment_type, u.credit_score, u.experian_score, u.experian_fetched_at, u.credit_limit, u.wallet_balance,
              u.interest_rate, u.withdrawal_limit, u.is_active, u.is_kyc_verified, u.is_dsa_partner, u.created_at,
              u.custom_processing_fee_pct, u.custom_first_emi_pct,
              u.kyc_approved_tenure, u.kyc_first_emi_amount, u.kyc_regular_emi_amount,
              u.assigned_partner_id, a.name as assigned_partner_name, a.role as assigned_partner_role,
              u.lead_status, u.dsa_custom_status,
              k.status as kyc_status, k.pan_verified as kyc_pan_verified, k.aadhaar_verified as kyc_aadhaar_verified,
              k.rejection_reason as kyc_rejection_reason
       FROM users u
       LEFT JOIN kyc_documents k ON k.user_id = u.id
       LEFT JOIN admins a ON a.id = u.assigned_partner_id
       WHERE (u.full_name LIKE ? OR u.mobile LIKE ? OR u.email LIKE ?)
    `;
    const params = [searchParam, searchParam, searchParam];

    if (isPartner) {
      query += ' AND u.assigned_partner_id = ?';
      params.push(req.admin.id);
    }

    query += ' ORDER BY u.created_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), parseInt(offset));

    const [users] = await pool.query(query, params);

    let countQuery = 'SELECT COUNT(*) as total FROM users WHERE (full_name LIKE ? OR mobile LIKE ? OR email LIKE ?)';
    const countParams = [searchParam, searchParam, searchParam];
    if (isPartner) {
      countQuery += ' AND assigned_partner_id = ?';
      countParams.push(req.admin.id);
    }

    const [[{ total }]] = await pool.query(countQuery, countParams);

    res.json({ success: true, users, total, page: parseInt(page), limit: parseInt(limit) });
  } catch (err) {
    console.error('[getAllUsers]', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// PUT /api/admin/users/:userId/lead-status  (DSA partner CRM update)
const VALID_LEAD_STATUSES = ['new', 'contacted', 'docs_submitted', 'kyc_pending', 'kyc_done', 'loan_applied', 'converted', 'inactive'];

const updateLeadStatus = async (req, res) => {
  try {
    const { userId } = req.params;
    const { lead_status, dsa_custom_status } = req.body;
    if (lead_status && !VALID_LEAD_STATUSES.includes(lead_status)) {
      return res.status(400).json({ success: false, message: 'Invalid lead status value' });
    }
    const isPartner = ['dsa_partner', 'bank_partner'].includes(req.admin.role);
    if (isPartner) {
      const [[lead]] = await pool.query('SELECT id FROM users WHERE id = ? AND assigned_partner_id = ?', [userId, req.admin.id]);
      if (!lead) return res.status(403).json({ success: false, message: 'This lead is not assigned to you' });
    }
    
    if (lead_status !== undefined && dsa_custom_status !== undefined) {
      await pool.query('UPDATE users SET lead_status = ?, dsa_custom_status = ? WHERE id = ?', [lead_status, dsa_custom_status, userId]);
    } else if (lead_status !== undefined) {
      await pool.query('UPDATE users SET lead_status = ? WHERE id = ?', [lead_status, userId]);
    } else if (dsa_custom_status !== undefined) {
      await pool.query('UPDATE users SET dsa_custom_status = ? WHERE id = ?', [dsa_custom_status, userId]);
    }
    res.json({ success: true, message: 'Lead status updated', lead_status, dsa_custom_status });
  } catch (err) {
    console.error('[updateLeadStatus]', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/admin/users/:userId/kyc-details  (for DSA partner lead detail modal)
const getLeadKycDetails = async (req, res) => {
  try {
    const { userId } = req.params;
    const isPartner = ['dsa_partner', 'bank_partner'].includes(req.admin.role);
    if (isPartner) {
      const [[lead]] = await pool.query('SELECT id FROM users WHERE id = ? AND assigned_partner_id = ?', [userId, req.admin.id]);
      if (!lead) return res.status(403).json({ success: false, message: 'Lead not assigned to you' });
    }
    const [[kyc]] = await pool.query(
      `SELECT kd.status, kd.pan_verified, kd.aadhaar_verified, kd.rejection_reason,
              kd.aadhaar_front IS NOT NULL AS has_aadhaar_front,
              kd.aadhaar_back  IS NOT NULL AS has_aadhaar_back,
              kd.pan_card      IS NOT NULL AS has_pan_card,
              kd.selfie        IS NOT NULL AS has_selfie,
              kd.bank_passbook IS NOT NULL AS has_bank_passbook,
              kd.reviewed_at,
              u.pan_number, u.aadhaar_number, u.pan_verified as user_pan_verified,
              u.aadhaar_verified as user_aadhaar_verified, u.is_kyc_verified,
              u.date_of_birth, u.occupation, u.monthly_income, u.dsa_custom_status
         FROM users u
         LEFT JOIN kyc_documents kd ON kd.user_id = u.id
        WHERE u.id = ?`,
      [userId]
    );
    if (!kyc) return res.status(404).json({ success: false, message: 'User not found' });
    res.json({ success: true, kyc });
  } catch (err) {
    console.error('[getLeadKycDetails]', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/admin/loans
const getAllLoans = async (req, res) => {
  try {
    const { page = 1, limit = 20, status = '', user_id = '' } = req.query;
    const offset = (page - 1) * limit;
    const isPartner = ['dsa_partner', 'bank_partner'].includes(req.admin.role);

    let query = `
      SELECT l.*, u.full_name, u.mobile, u.email,
             COALESCE(u.credit_score, u.experian_score) AS credit_score,
             u.occupation, u.monthly_income,
             (SELECT e.emi_amount FROM emi_schedule e WHERE e.loan_id = l.id AND e.status NOT IN ('paid','waived') ORDER BY e.installment_no ASC LIMIT 1) AS next_emi_amount,
             (SELECT e.due_date FROM emi_schedule e WHERE e.loan_id = l.id AND e.status NOT IN ('paid','waived') ORDER BY e.installment_no ASC LIMIT 1) AS next_emi_date
      FROM loans l
      JOIN users u ON u.id = l.user_id
    `;
    const conditions = [];
    const params = [];

    if (status) {
      conditions.push('l.status = ?');
      params.push(status);
    }
    if (user_id) {
      conditions.push('l.user_id = ?');
      params.push(user_id);
    }
    if (isPartner) {
      conditions.push('u.assigned_partner_id = ?');
      params.push(req.admin.id);
    }

    if (conditions.length) {
      query += ' WHERE ' + conditions.join(' AND ');
    }

    query += ' ORDER BY l.created_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), parseInt(offset));

    const [loans] = await pool.query(query, params);
    res.json({ success: true, loans });
  } catch (err) {
    console.error('[getAllLoans]', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/admin/preview-emi — accepts per-user overrides for processing fee & first EMI %
const previewEMI = async (req, res) => {
  try {
    const {
      amount, interest_rate, duration_months, first_emi_date,
      processing_fee,         // ₹ amount override
      processing_fee_pct,     // % override (takes precedence over system default)
      first_emi_pct,          // % of principal to collect as first EMI (step-down mode)
    } = req.query;

    const p = parseFloat(amount);
    const r = parseFloat(interest_rate);
    const n = parseInt(duration_months);
    if (!p || !r || !n) return res.status(400).json({ success: false, message: 'amount, interest_rate and duration_months required' });

    const sysSettings = await loadSettings();

    // Resolve processing fee
    const feePct = processing_fee_pct !== undefined
      ? parseFloat(processing_fee_pct)
      : parseFloat(sysSettings.processing_fee_pct) || 2;
    const procFee = processing_fee !== undefined
      ? parseFloat(processing_fee)
      : Math.round(p * feePct / 100 * 100) / 100;

    const gstOnFee = Math.round(procFee * (parseFloat(sysSettings.gst_on_processing_fee) || 18) / 100 * 100) / 100;

    // Merge first_emi_pct override into settings
    const mergedSettings = {
      ...sysSettings,
      first_emi_principal_pct: first_emi_pct !== undefined ? parseFloat(first_emi_pct) : (parseFloat(sysSettings.first_emi_principal_pct) || 0),
    };

    const emiAmt = calculateEMI(p, r, n);
    const schedule = generateEMISchedule(
      { amount: p, interest_rate: r, duration_months: n, emi_amount: emiAmt, processing_fee: procFee },
      first_emi_date || null,
      mergedSettings
    );

    // Totals
    const firstEmiCharges = schedule[0]?.first_emi_charges || 0;
    const firstEmiTotal = schedule[0]?.emi_amount || 0;
    const totalPay = Math.round(schedule.reduce((s, r) => s + parseFloat(r.emi_amount), 0) * 100) / 100;
    const isStepDown = parseFloat(mergedSettings.first_emi_principal_pct) > 0;

    res.json({
      success: true,
      emi_amount: isStepDown ? schedule[1]?.emi_amount || emiAmt : emiAmt,
      regular_emi: isStepDown ? schedule[1]?.emi_amount || emiAmt : emiAmt,
      first_emi_total: firstEmiTotal,
      first_emi_charges: firstEmiCharges,
      processing_fee: procFee,
      processing_fee_pct: feePct,
      gst_on_fee: gstOnFee,
      total_payable: totalPay,
      first_emi_pct: parseFloat(mergedSettings.first_emi_principal_pct) || 0,
      is_step_down: isStepDown,
      processing_fee_in_first_emi: !!sysSettings.processing_fee_in_first_emi,
      penalty_grace_days: sysSettings.penalty_grace_days || 3,
      penalty_type: sysSettings.penalty_type || 'percent',
      penalty_rate_per_day: sysSettings.penalty_rate_per_day || 1,
      penalty_flat_per_day: sysSettings.penalty_flat_per_day || 50,
      penalty_max_pct_of_emi: sysSettings.penalty_max_pct_of_emi || 50,
      bounce_charge: sysSettings.bounce_charge || 500,
      schedule,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// PUT /api/admin/process-loan/:id  — approve with admin-defined params + schedule EMIs
const processLoan = async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const loanId = req.params.id;
    const adminId = req.admin.id;
    const {
      approved_amount,   // admin can override user-requested amount
      interest_rate,     // override rate
      duration_months,   // override tenure
      first_emi_date,    // YYYY-MM-DD
      processing_fee,    // override processing fee (₹ amount)
      processing_fee_pct, // override processing fee %
    } = req.body;

    // Load global settings + user's custom rates
    const sysSettings = await loadSettings();

    await conn.beginTransaction();

    const [loanRows] = await conn.query('SELECT l.*, u.custom_processing_fee_pct, u.custom_first_emi_pct FROM loans l JOIN users u ON u.id = l.user_id WHERE l.id = ? FOR UPDATE', [loanId]);
    if (!loanRows.length) {
      await conn.rollback(); conn.release();
      return res.status(404).json({ success: false, message: 'Loan not found' });
    }
    const loan = loanRows[0];
    if (!['pending', 'under_review'].includes(loan.status)) {
      await conn.rollback(); conn.release();
      return res.status(400).json({ success: false, message: 'Loan cannot be processed in current state' });
    }

    // Resolve final params — admin form overrides → user custom rates → global defaults → loan original
    const finalAmount = approved_amount ? parseFloat(approved_amount) : parseFloat(loan.amount);
    const finalRate = interest_rate ? parseFloat(interest_rate) : (parseFloat(loan.interest_rate) || parseFloat(sysSettings.default_roi) || 2.5);
    const finalMonths = duration_months ? parseInt(duration_months) : parseInt(loan.duration_months);

    const bodyFeePct = processing_fee_pct !== undefined ? parseFloat(processing_fee_pct) : null;
    const userFeePct = loan.custom_processing_fee_pct != null ? parseFloat(loan.custom_processing_fee_pct) : null;
    const resolvedFeePct = bodyFeePct ?? userFeePct ?? parseFloat(sysSettings.processing_fee_pct) ?? 2;
    const finalProcFee = processing_fee !== undefined
      ? parseFloat(processing_fee)
      : Math.round(finalAmount * resolvedFeePct / 100 * 100) / 100;

    // first_emi_pct: from request body → user's custom → global setting
    const bodyFirstEmiPct = req.body.first_emi_pct !== undefined ? parseFloat(req.body.first_emi_pct) : null;
    const userFirstEmiPct = loan.custom_first_emi_pct != null ? parseFloat(loan.custom_first_emi_pct) : null;
    const resolvedFirstEmiPct = bodyFirstEmiPct ?? userFirstEmiPct ?? parseFloat(sysSettings.first_emi_principal_pct) ?? 0;

    const mergedSettings = { ...sysSettings, first_emi_principal_pct: resolvedFirstEmiPct };

    const finalEMI = calculateEMI(finalAmount, finalRate, finalMonths);
    const schedule = generateEMISchedule(
      { amount: finalAmount, interest_rate: finalRate, duration_months: finalMonths, emi_amount: finalEMI, processing_fee: finalProcFee },
      first_emi_date || null,
      mergedSettings
    );
    const finalTotal = Math.round(schedule.reduce((s, r) => s + parseFloat(r.emi_amount), 0) * 100) / 100;

    // Update the loan with admin's final terms + configured penalty rate
    await conn.query(
      `UPDATE loans SET
          amount          = ?,
          interest_rate   = ?,
          duration_months = ?,
          emi_amount      = ?,
          processing_fee  = ?,
          processing_fee_pct = ?,
          first_emi_pct   = ?,
          processing_fee_in_first_emi = ?,
          total_payable   = ?,
          penalty_rate    = ?,
          status          = 'approved',
          approved_by     = ?,
          approved_at     = NOW(),
          next_emi_date   = ?
        WHERE id = ?`,
      [finalAmount, finalRate, finalMonths, finalEMI, finalProcFee, resolvedFeePct, resolvedFirstEmiPct, sysSettings.processing_fee_in_first_emi ? 1 : 0, finalTotal,
        parseFloat(sysSettings.penalty_rate_per_day) || 1.0,
        adminId, first_emi_date || null, loanId]
    );

    // Delete any old EMI schedule rows (in case of re-processing)
    await conn.query('DELETE FROM emi_schedule WHERE loan_id = ?', [loanId]);

    // schedule already generated above with mergedSettings

    if (schedule.length) {
      const rows = schedule.map(s => [
        loanId, loan.user_id, s.installment_no, s.due_date, s.emi_amount, s.principal_amount, s.interest_amount
      ]);
      await conn.query(
        `INSERT INTO emi_schedule (loan_id, user_id, installment_no, due_date, emi_amount, principal_amount, interest_amount)
         VALUES ?`,
        [rows]
      );
    }

    // Update next_emi_date to first EMI due date
    if (schedule.length) {
      await conn.query('UPDATE loans SET next_emi_date = ? WHERE id = ?', [schedule[0].due_date, loanId]);
    }

    // Notify user
    await conn.query(
      'INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, ?)',
      [loan.user_id,
        '🎉 Withdrawal Approved!',
      `Your withdrawal of ₹${finalAmount} has been approved at ${finalRate}% per month for ${finalMonths} months. Next EMI: ₹${schedule[0]?.emi_amount || finalEMI} due: ${schedule[0]?.due_date || 'TBD'}.`,
        'loan']
    );

    await conn.commit();
    conn.release();

    const [userRow] = await pool.query('SELECT fcm_token FROM users WHERE id = ?', [loan.user_id]);
    if (userRow[0]?.fcm_token) {
      await sendNotification(userRow[0].fcm_token, '🎉 Withdrawal Approved!',
        `₹${finalAmount} approved. Next EMI: ₹${schedule[0]?.emi_amount || finalEMI} due ${schedule[0]?.due_date || 'TBD'}.`);
    }

    await invalidateUserCache(loan.user_id);
    await delCache('admin:dashboard', 'admin:dashboard:partner:*');
    await auditLog({
      req, action: 'loan_approved', entityType: 'loan', entityId: loanId,
      details: { amount: finalAmount, emi: finalEMI, months: finalMonths, rate: finalRate, first_emi: schedule[0]?.due_date }
    });

    res.json({
      success: true,
      message: 'Loan processed and EMI schedule generated',
      final_amount: finalAmount,
      emi_amount: finalEMI,
      total_payable: finalTotal,
      processing_fee: finalProcFee,
      schedule_count: schedule.length,
      first_emi_date: schedule[0]?.due_date,
    });
  } catch (err) {
    try { await conn.rollback(); } catch (_) { }
    conn.release();
    console.error('[processLoan]', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// Legacy wrapper kept for backward-compat (same as processLoan but no overrides)
const approveLoan = async (req, res) => {
  // Forward to processLoan without any overrides
  req.body = {};
  return processLoan(req, res);
};

// PUT /api/admin/users/:userId/withdrawal-limit
const setWithdrawalLimit = async (req, res) => {
  try {
    const { withdrawal_limit } = req.body;
    const userId = req.params.userId;

    const wl = withdrawal_limit === null || withdrawal_limit === ''
      ? null
      : parseFloat(withdrawal_limit);

    if (wl !== null && (isNaN(wl) || wl < 0)) {
      return res.status(400).json({ success: false, message: 'Invalid withdrawal limit' });
    }

    const [userRow] = await pool.query('SELECT id, credit_limit FROM users WHERE id = ?', [userId]);
    if (!userRow.length) return res.status(404).json({ success: false, message: 'User not found' });

    if (wl !== null && wl > parseFloat(userRow[0].credit_limit)) {
      return res.status(400).json({ success: false, message: 'Withdrawal limit cannot exceed credit limit' });
    }

    // Withdrawal limit can never be set below what the user has already withdrawn/disbursed —
    // otherwise availableCredit would go negative and the user would be unable to close out
    // their existing loan(s) without exceeding the new (lower) limit.
    if (wl !== null) {
      const { occupiedCredit } = await getUserCreditDetails(userId, userRow[0].credit_limit, null);
      if (wl < occupiedCredit) {
        return res.status(400).json({
          success: false,
          message: `Withdrawal limit cannot be less than ₹${occupiedCredit} already withdrawn/disbursed by the user`
        });
      }
    }

    await pool.query('UPDATE users SET withdrawal_limit = ? WHERE id = ?', [wl, userId]);
    await invalidateUserCache(userId);

    const title = 'Withdrawal Limit Updated';
    const message = wl === null
      ? 'Your withdrawal limit has been cleared. You can now withdraw up to your full credit limit.'
      : `Your withdrawal limit has been set to ₹${wl}.`;

    await pool.query(
      'INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, ?)',
      [userId, title, message, 'system']
    );

    const [user] = await pool.query('SELECT fcm_token FROM users WHERE id = ?', [userId]);
    if (user[0]?.fcm_token) {
      await sendNotification(user[0].fcm_token, title, message, { screen: 'Profile' });
    }

    const effectiveLimit = wl === null ? userRow[0].credit_limit : wl;
    res.json({
      success: true,
      message: wl === null
        ? 'Withdrawal limit cleared — user can now withdraw up to their full credit limit'
        : `Withdrawal limit set to ₹${wl}`,
      withdrawal_limit: wl,
      effective_limit: effectiveLimit,
    });
  } catch (err) {
    console.error('[setWithdrawalLimit]', err);
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

    const title = 'Loan Application Update';
    const message = `Your loan application has been rejected. Reason: ${reason || 'Eligibility criteria not met'}. You may apply again after 30 days.`;

    await pool.query(
      'INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, ?)',
      [loan[0].user_id, title, message, 'loan']
    );

    const [user] = await pool.query('SELECT fcm_token FROM users WHERE id = ?', [loan[0].user_id]);
    if (user[0]?.fcm_token) {
      await sendNotification(user[0].fcm_token, title, message, { screen: 'Profile', params: { screen: 'LoanHistory' } });
    }

    await auditLog({
      req, action: 'loan_rejected', entityType: 'loan', entityId: loanId,
      details: { reason: reason || 'Eligibility criteria not met', user_id: loan[0].user_id }
    });
    res.json({ success: true, message: 'Loan rejected' });
    await invalidateUserCache(loan[0].user_id);
    await delCache('admin:dashboard', 'admin:dashboard:partner:*');
  } catch (err) {
    console.error('[rejectLoan]', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/admin/kyc - KYC list
const getPendingKYC = async (req, res) => {
  try {
    const isPartner = ['dsa_partner', 'bank_partner'].includes(req.admin.role);
    let query = `
       SELECT k.*, u.full_name, u.mobile, u.email, u.pan_number, u.aadhaar_number,
              u.date_of_birth, u.credit_limit, u.interest_rate, u.kyc_approved_tenure,
              bd.bank_name, bd.account_holder, bd.account_number, bd.ifsc_code, bd.account_type,
              bd.branch, bd.city, bd.state, bd.micr, bd.swift,
              COALESCE(bd.is_verified, 0) AS bank_verified
       FROM kyc_documents k
       JOIN users u ON u.id = k.user_id
       LEFT JOIN bank_details bd ON bd.user_id = u.id
    `;
    const params = [];
    if (isPartner) {
      query += ' WHERE u.assigned_partner_id = ?';
      params.push(req.admin.id);
    }
    query += ' ORDER BY k.created_at ASC';

    const [kycs] = await pool.query(query, params);
    res.json({ success: true, kycs });
  } catch (err) {
    console.error('[getPendingKYC]', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// PUT /api/admin/kyc/:userId
const reviewKYC = async (req, res) => {
  try {
    const { status, rejection_reason, credit_limit, interest_rate, processing_fee_pct, first_emi_pct, tenure } = req.body;
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
      if (Number.isNaN(limitVal) || limitVal <= 0) {
        return res.status(400).json({ success: false, message: 'Please provide a valid credit limit greater than 0.' });
      }
      const rateVal = interest_rate !== undefined ? parseFloat(interest_rate) : 2.50;
      const feePct = processing_fee_pct !== undefined ? parseFloat(processing_fee_pct) : null;
      const firstEmiP = first_emi_pct !== undefined ? parseFloat(first_emi_pct) : null;
      const tenureVal = tenure !== undefined ? parseInt(tenure) : 6;

      // ── Compute EMI snapshot at KYC approval time ──────────────────────────
      const sysSettings = await loadSettings();
      const resolvedFeePct = feePct ?? parseFloat(sysSettings.processing_fee_pct) ?? 2;
      const resolvedFirstEmiPct = firstEmiP ?? parseFloat(sysSettings.first_emi_principal_pct) ?? 0;
      const procFee = Math.round(limitVal * resolvedFeePct / 100 * 100) / 100;

      const mergedSettings = {
        ...sysSettings,
        first_emi_principal_pct: resolvedFirstEmiPct,
        processing_fee_in_first_emi: sysSettings.processing_fee_in_first_emi,
        gst_on_processing_fee: sysSettings.gst_on_processing_fee,
      };

      const emiAmt = calculateEMI(limitVal, rateVal, tenureVal);
      const schedule = generateEMISchedule(
        { amount: limitVal, interest_rate: rateVal, duration_months: tenureVal, emi_amount: emiAmt, processing_fee: procFee },
        null,   // default → 3rd of next month
        mergedSettings
      );

      // first_emi_amount  = EMI #1 total (includes step-down principal + fee if applicable)
      // regular_emi_amount = EMI #2 in step-down mode, or same as emiAmt in standard mode
      const kycFirstEmi = parseFloat(schedule[0]?.emi_amount || emiAmt);
      const kycRegularEmi = parseFloat(schedule[1]?.emi_amount || emiAmt);
      // ──────────────────────────────────────────────────────────────────────

      await pool.query(
        `UPDATE users SET is_kyc_verified = 1, credit_limit = ?, interest_rate = ?,
          custom_processing_fee_pct = ?, custom_first_emi_pct = ?,
          kyc_approved_tenure = ?, kyc_first_emi_amount = ?, kyc_regular_emi_amount = ?
          WHERE id = ?`,
        [limitVal, rateVal, feePct, firstEmiP, tenureVal, kycFirstEmi, kycRegularEmi, userId]
      );
      await auditLog({
        req, action: 'kyc_approved', entityType: 'user', entityId: userId,
        details: {
          credit_limit: limitVal, interest_rate: rateVal, processing_fee_pct: feePct, first_emi_pct: firstEmiP,
          tenure: tenureVal, first_emi_amount: kycFirstEmi, regular_emi_amount: kycRegularEmi
        }
      });
    } else {
      await pool.query('UPDATE users SET is_kyc_verified = 0 WHERE id = ?', [userId]);
      await auditLog({
        req, action: 'kyc_rejected', entityType: 'user', entityId: userId,
        details: { rejection_reason }
      });
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
    await delCache('admin:dashboard', 'admin:dashboard:partner:*');
  } catch (err) {
    console.error('[reviewKYC]', err);
    res.status(500).json({ success: false, message: err.message });
  }
};


// GET /api/admin/transactions
const getAllTransactions = async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;
    const isPartner = ['dsa_partner', 'bank_partner'].includes(req.admin.role);

    let query = `
      SELECT t.*, u.full_name, u.mobile FROM transactions t
      JOIN users u ON u.id = t.user_id
    `;
    const params = [];
    if (isPartner) {
      query += ' WHERE u.assigned_partner_id = ?';
      params.push(req.admin.id);
    }
    query += ' ORDER BY t.created_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), parseInt(offset));

    const [txns] = await pool.query(query, params);
    res.json({ success: true, transactions: txns });
  } catch (err) {
    console.error('[getAllTransactions]', err);
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
    console.error('[sendBulkNotification]', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// PUT /api/admin/disburse-loan/:id
const disburseLoan = async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const loanId = req.params.id;

    await conn.beginTransaction();

    // Lock the loan row to prevent concurrent disbursals
    const [loanRows] = await conn.query(
      "SELECT * FROM loans WHERE id = ? FOR UPDATE",
      [loanId]
    );
    if (!loanRows.length) {
      await conn.rollback(); conn.release();
      return res.status(404).json({ success: false, message: 'Loan not found' });
    }
    const loan = loanRows[0];
    const userId = loan.user_id;

    if (loan.status === 'approved') {
      await conn.rollback(); conn.release();
      return res.status(400).json({
        success: false,
        message: 'User must complete Auto-Debit setup and accept the Loan Agreement before disbursement.'
      });
    }

    if (loan.status !== 'withdrawal_requested') {
      await conn.rollback(); conn.release();
      return res.status(400).json({
        success: false,
        message: `Loan status is ${loan.status}. Disbursement requires withdrawal_requested status.`
      });
    }

    if (loan.agreement_accepted !== 1) {
      await conn.rollback(); conn.release();
      return res.status(400).json({
        success: false,
        message: 'Disbursement failed: User has not accepted the Loan Agreement.'
      });
    }

    // Bank details check inside transaction
    const [bank] = await conn.query('SELECT * FROM bank_details WHERE user_id = ?', [userId]);
    if (!bank.length || !bank[0].account_number || !bank[0].ifsc_code) {
      await conn.rollback(); conn.release();
      return res.status(400).json({ success: false, message: 'Disbursement failed: User has not updated bank details.' });
    }

    let payoutAmount = parseFloat(loan.amount);
    let feeDeductionMsg = '';
    if (!loan.processing_fee_in_first_emi) {
      // Get system settings for GST
      const [settingsRows] = await conn.query('SELECT setting_key, setting_value FROM system_settings');
      const settings = {};
      for (const r of settingsRows) {
        settings[r.setting_key] = r.setting_value;
      }
      const gstPct = parseFloat(settings.gst_on_processing_fee || 18);
      const procFee = parseFloat(loan.processing_fee || 0);
      const feeGst = Math.round(procFee * (gstPct / 100) * 100) / 100;
      const totalDeduction = procFee + feeGst;
      payoutAmount = Math.max(0, payoutAmount - totalDeduction);
      feeDeductionMsg = ` (₹${totalDeduction} processing fee + ${gstPct}% GST deducted)`;
    }

    const mockUTR = 'PAYOUT' + crypto.randomBytes(6).toString('hex').toUpperCase();

    // All three writes are atomic — if any fails, the whole transaction rolls back
    await conn.query(
      "UPDATE loans SET status = 'disbursed', disbursed_at = NOW(), disburse_confirmed = 1 WHERE id = ?",
      [loanId]
    );

    await conn.query(
      'UPDATE users SET wallet_balance = wallet_balance + ? WHERE id = ?',
      [payoutAmount, userId]
    );

    const [txResult] = await conn.query(
      `INSERT INTO transactions (user_id, loan_id, amount, type, status, description, receipt_url)
       VALUES (?, ?, ?, 'credit', 'success', ?, ?)`,
      [
        userId, loanId, payoutAmount,
        `Loan disbursed to ${bank[0].bank_name} A/C ****${bank[0].account_number.slice(-4)}${feeDeductionMsg}`,
        `UTR: ${mockUTR}`,
      ]
    );

    await conn.query(
      'INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, ?)',
      [userId, '💰 Loan Disbursed!',
        `₹${payoutAmount} disbursed to ${bank[0].bank_name} A/C ****${bank[0].account_number.slice(-4)}. UTR: ${mockUTR}.${feeDeductionMsg}`,
        'loan']
    );

    await conn.commit();
    conn.release();

    // Audit (non-blocking, after commit)
    await auditLog({
      req,
      action: 'loan_disbursed',
      entityType: 'loan',
      entityId: loanId,
      details: { amount: payoutAmount, utr: mockUTR, bank: bank[0].bank_name, transaction_id: txResult.insertId },
    });

    // Push notification (non-blocking)
    pool.query('SELECT fcm_token FROM users WHERE id = ?', [userId]).then(([u]) => {
      if (u[0]?.fcm_token) {
        sendNotification(u[0].fcm_token, '💰 Loan Disbursed!',
          `₹${payoutAmount} disbursed to your ${bank[0].bank_name} account.`, { screen: 'Profile', params: { screen: 'LoanHistory' } });
      }
    }).catch(() => { });

    await Promise.all([invalidateUserCache(userId), delCache('admin:dashboard', 'admin:dashboard:partner:*')]);

    res.json({ success: true, message: 'Loan disbursed successfully', utr: mockUTR, bank: bank[0].bank_name });
  } catch (err) {
    try { await conn.rollback(); } catch (_) { }
    conn.release();
    console.error('[disburseLoan]', err);
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

    if (schedule.length) {
      return res.json({ success: true, emi_schedule: schedule });
    }

    // Dynamic generation if empty (pending loans)
    const [loan] = await pool.query('SELECT * FROM loans WHERE id = ?', [loanId]);
    if (!loan.length) {
      return res.json({ success: true, emi_schedule: [] });
    }

    const preview = generateEMISchedule(loan[0]);
    const mappedPreview = preview.map(inst => ({
      id: `preview-${inst.installment_no}`,
      loan_id: loanId,
      user_id: loan[0].user_id,
      installment_no: inst.installment_no,
      due_date: inst.due_date,
      emi_amount: inst.emi_amount,
      principal_amount: inst.principal,
      interest_amount: inst.interest,
      status: 'upcoming',
      paid_at: null
    }));

    return res.json({ success: true, emi_schedule: mappedPreview });
  } catch (err) {
    console.error('[getLoanEMISchedule]', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/admin/overdue-emis — cross-loan penalty view so collections doesn't
// have to open each loan individually. Two modes via ?filter=:
//   outstanding (default) — currently overdue, unpaid installments
//   paid_late              — installments that were overdue (penalty accrued)
//                             but have since been paid, for history/audit
const getOverdueEmis = async (req, res) => {
  try {
    const { search = '', filter = 'outstanding' } = req.query;
    const isPaidLate = filter === 'paid_late';
    const isPartner = ['dsa_partner', 'bank_partner'].includes(req.admin.role);

    let query = `
      SELECT e.id, e.loan_id, e.installment_no, e.due_date, e.emi_amount,
             e.penalty_amount, e.penalty_days, e.penalty_waived, e.status,
             e.paid_at, e.paid_amount,
             l.amount AS loan_amount, l.duration_months, l.interest_rate,
             u.id AS user_id, u.full_name, u.mobile, u.email
        FROM emi_schedule e
        JOIN loans l ON l.id = e.loan_id
        JOIN users u ON u.id = e.user_id
       WHERE ${isPaidLate ? "e.status = 'paid' AND (e.penalty_amount > 0 OR e.penalty_days > 0)" : "e.status = 'overdue'"}
    `;
    const params = [];

    if (isPartner) {
      query += ' AND u.assigned_partner_id = ?';
      params.push(req.admin.id);
    }
    if (search) {
      query += ' AND (u.full_name LIKE ? OR u.mobile LIKE ? OR u.email LIKE ?)';
      const s = `%${search}%`;
      params.push(s, s, s);
    }
    query += isPaidLate ? ' ORDER BY e.paid_at DESC' : ' ORDER BY e.penalty_amount DESC, e.due_date ASC';

    const [emis] = await pool.query(query, params);

    const summary = isPaidLate
      ? emis.reduce((acc, e) => {
          acc.count += 1;
          const p = Number(e.penalty_amount) || 0;
          if (e.penalty_waived) acc.total_penalty_waived += p;
          else acc.total_penalty_collected += p;
          return acc;
        }, { count: 0, total_penalty_collected: 0, total_penalty_waived: 0 })
      : emis.reduce((acc, e) => {
          acc.count += 1;
          acc.total_emi_due += Number(e.emi_amount) || 0;
          acc.total_penalty += e.penalty_waived ? 0 : (Number(e.penalty_amount) || 0);
          return acc;
        }, { count: 0, total_emi_due: 0, total_penalty: 0 });

    res.json({ success: true, emis, summary, filter: isPaidLate ? 'paid_late' : 'outstanding' });
  } catch (err) {
    console.error('[getOverdueEmis]', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// PUT /api/admin/emi/:id/penalty-waiver — waive or reinstate the late penalty
// on a single overdue installment (e.g. after a call with the customer agreeing
// to pay the EMI without the fine). Only allowed while still overdue/unpaid —
// once paid, the charge is already settled and can't be un-collected here.
const setPenaltyWaiver = async (req, res) => {
  try {
    const emiId = req.params.id;
    const { waived } = req.body;
    if (typeof waived !== 'boolean') {
      return res.status(400).json({ success: false, message: 'waived (boolean) is required' });
    }

    const [rows] = await pool.query(
      `SELECT e.*, u.full_name FROM emi_schedule e JOIN users u ON u.id = e.user_id WHERE e.id = ?`,
      [emiId]
    );
    if (!rows.length) return res.status(404).json({ success: false, message: 'EMI not found' });
    const emi = rows[0];
    if (emi.status !== 'overdue') {
      return res.status(400).json({ success: false, message: `Cannot change penalty waiver — EMI status is '${emi.status}', not overdue.` });
    }

    await pool.query('UPDATE emi_schedule SET penalty_waived = ? WHERE id = ?', [waived ? 1 : 0, emiId]);

    await auditLog({
      req,
      action: waived ? 'penalty_waived' : 'penalty_unwaived',
      entityType: 'emi_schedule',
      entityId: Number(emiId),
      details: { loan_id: emi.loan_id, installment_no: emi.installment_no, penalty_amount: emi.penalty_amount, user: emi.full_name },
    });

    res.json({ success: true, message: waived ? 'Penalty waived' : 'Penalty reinstated' });
  } catch (err) {
    console.error('[setPenaltyWaiver]', err);
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

    const title = 'Credit Terms Updated';
    let message = `Your credit limit has been updated to ₹${credit_limit}.`;
    if (interest_rate !== undefined) {
      message = `Your credit limit has been updated to ₹${credit_limit} and interest rate set to ${interest_rate}% / month.`;
    }

    await pool.query(
      'INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, ?)',
      [userId, title, message, 'system']
    );

    const [user] = await pool.query('SELECT fcm_token FROM users WHERE id = ?', [userId]);
    if (user[0]?.fcm_token) {
      await sendNotification(user[0].fcm_token, title, message, { screen: 'Profile' });
    }

    await invalidateUserCache(userId);
    res.json({ success: true, message: 'Credit limit and interest rate updated successfully' });
  } catch (err) {
    console.error('[updateCreditLimit]', err);
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
    console.error('[toggleUserStatus]', err);
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
    console.error('[changeAdminPassword]', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// Load all settings from DB as a plain object (numbers auto-cast)
const loadSettings = async () => {
  const [rows] = await pool.query('SELECT setting_key, setting_value FROM system_settings');
  const obj = {};
  for (const r of rows) {
    const v = r.setting_value;
    obj[r.setting_key] = v === 'true' ? true : v === 'false' ? false : (!isNaN(v) && v !== '') ? Number(v) : v;
  }
  return obj;
};

// GET /api/admin/system-settings
const getSystemSettings = async (req, res) => {
  try {
    const settings = await loadSettings();
    res.json({ success: true, settings });
  } catch (err) {
    console.error('[getSystemSettings]', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// PUT /api/admin/system-settings
const updateSystemSettings = async (req, res) => {
  try {
    const allowed = [
      'default_roi', 'min_loan_amount', 'max_loan_amount', 'min_tenure_months', 'max_tenure_months',
      'default_credit_limit', 'processing_fee_pct', 'processing_fee_in_first_emi', 'gst_on_processing_fee',
      'first_emi_principal_pct', 'first_emi_extra_pct', 'penalty_grace_days', 'penalty_type', 'penalty_rate_per_day',
      'penalty_flat_per_day', 'penalty_max_pct_of_emi', 'gst_on_penalty', 'bounce_charge',
      'gst_on_bounce', 'min_cibil_score',
      'investment_monthly_rate', 'investment_min_amount', 'investment_max_amount',
      'investment_min_tenure_months', 'investment_max_tenure_months',
    ];
    const updates = Object.entries(req.body).filter(([k]) => allowed.includes(k));
    for (const [k, v] of updates) {
      await pool.query(
        'INSERT INTO system_settings (setting_key,setting_value) VALUES (?,?) ON DUPLICATE KEY UPDATE setting_value=?',
        [k, String(v), String(v)]
      );
    }
    await auditLog({ req, action: 'settings_updated', entityType: 'setting', details: Object.fromEntries(updates) });
    const settings = await loadSettings();
    res.json({ success: true, message: 'Settings saved successfully', settings });
  } catch (err) {
    console.error('[updateSystemSettings]', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/admin/notifications/history
const getNotificationHistory = async (req, res) => {
  try {
    const { limit = 50, type = '' } = req.query;
    const where = type ? 'WHERE n.type = ?' : '';
    const params = type
      ? [type, parseInt(limit)]
      : [parseInt(limit)];

    const [notifications] = await pool.query(
      `SELECT n.id, n.user_id, n.title, n.message, n.type, n.is_read, n.created_at,
              u.full_name AS user_name
       FROM notifications n
       JOIN users u ON u.id = n.user_id
       ${where}
       ORDER BY n.created_at DESC
       LIMIT ?`,
      params
    );
    res.json({ success: true, notifications });
  } catch (err) {
    console.error('[getNotificationHistory]', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─────────────────────────────────────────────
// ADMIN MANAGEMENT (super_admin only)
// ─────────────────────────────────────────────

const DEFAULT_PERMISSIONS = {
  view_dashboard: 1, manage_users: 1, manage_loans: 1, manage_kyc: 1,
  view_transactions: 1, manage_transactions: 0, send_notifications: 1,
  manage_referrals: 1, manage_settings: 0, manage_admins: 0, manage_dsa: 0,
};

// GET /api/admin/admins
const getAllAdmins = async (req, res) => {
  try {
    const [admins] = await pool.query(
      `SELECT a.id, a.name, a.email, a.role, a.is_active, a.last_login, a.created_at,
              c.name AS created_by_name,
              p.view_dashboard, p.manage_users, p.manage_loans, p.manage_kyc,
              p.view_transactions, p.manage_transactions, p.send_notifications,
              p.manage_referrals, p.manage_settings, p.manage_admins, p.manage_dsa
       FROM admins a
       LEFT JOIN admins c ON c.id = a.created_by
       LEFT JOIN admin_permissions p ON p.admin_id = a.id
       ORDER BY a.created_at ASC`
    );
    res.json({ success: true, admins });
  } catch (err) {
    console.error('[getAllAdmins]', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/admin/admins
const createAdmin = async (req, res) => {
  try {
    const { name, email, password, role = 'admin', permissions = {} } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ success: false, message: 'Name, email and password are required' });
    }
    if (!['admin', 'reviewer', 'dsa_partner', 'bank_partner'].includes(role)) {
      return res.status(400).json({ success: false, message: 'Role must be admin, reviewer, dsa_partner, or bank_partner' });
    }
    const [existing] = await pool.query('SELECT id FROM admins WHERE email = ?', [email]);
    if (existing.length) {
      return res.status(409).json({ success: false, message: 'Admin with this email already exists' });
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPwd = await bcrypt.hash(password, salt);

    const [result] = await pool.query(
      'INSERT INTO admins (name, email, password, role, created_by) VALUES (?, ?, ?, ?, ?)',
      [name, email.toLowerCase().trim(), hashedPwd, role, req.admin.id]
    );
    const newAdminId = result.insertId;

    // Merge provided permissions with defaults
    const perms = { ...DEFAULT_PERMISSIONS, ...permissions };
    await pool.query(
      `INSERT INTO admin_permissions
         (admin_id, view_dashboard, manage_users, manage_loans, manage_kyc,
          view_transactions, manage_transactions, send_notifications,
          manage_referrals, manage_settings, manage_admins, manage_dsa)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [newAdminId,
        perms.view_dashboard ? 1 : 0,
        perms.manage_users ? 1 : 0,
        perms.manage_loans ? 1 : 0,
        perms.manage_kyc ? 1 : 0,
        perms.view_transactions ? 1 : 0,
        perms.manage_transactions ? 1 : 0,
        perms.send_notifications ? 1 : 0,
        perms.manage_referrals ? 1 : 0,
        perms.manage_settings ? 1 : 0,
        perms.manage_admins ? 1 : 0,
        perms.manage_dsa ? 1 : 0,
      ]
    );

    res.status(201).json({ success: true, message: 'Admin created successfully', admin_id: newAdminId });
  } catch (err) {
    console.error('[createAdmin]', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// PUT /api/admin/admins/:id
const updateAdmin = async (req, res) => {
  try {
    const targetId = parseInt(req.params.id);
    const { name, email, password } = req.body;

    const [existing] = await pool.query('SELECT id, role FROM admins WHERE id = ?', [targetId]);
    if (!existing.length) return res.status(404).json({ success: false, message: 'Admin not found' });
    if (existing[0].role === 'super_admin' && req.admin.id !== targetId) {
      return res.status(403).json({ success: false, message: 'Cannot modify another super admin' });
    }

    const updates = [];
    const params = [];
    if (name) { updates.push('name = ?'); params.push(name); }
    if (email) { updates.push('email = ?'); params.push(email.toLowerCase().trim()); }
    if (password) {
      const salt = await bcrypt.genSalt(10);
      updates.push('password = ?');
      params.push(await bcrypt.hash(password, salt));
    }

    if (!updates.length) return res.status(400).json({ success: false, message: 'Nothing to update' });
    params.push(targetId);
    await pool.query(`UPDATE admins SET ${updates.join(', ')} WHERE id = ?`, params);
    res.json({ success: true, message: 'Admin updated successfully' });
  } catch (err) {
    console.error('[updateAdmin]', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// PUT /api/admin/admins/:id/permissions
const updateAdminPermissions = async (req, res) => {
  try {
    const targetId = parseInt(req.params.id);
    const [existing] = await pool.query('SELECT id, role FROM admins WHERE id = ?', [targetId]);
    if (!existing.length) return res.status(404).json({ success: false, message: 'Admin not found' });
    if (existing[0].role === 'super_admin') {
      return res.status(400).json({ success: false, message: 'Cannot restrict super admin permissions' });
    }

    const p = req.body;
    await pool.query(
      `INSERT INTO admin_permissions
         (admin_id, view_dashboard, manage_users, manage_loans, manage_kyc,
          view_transactions, manage_transactions, send_notifications,
          manage_referrals, manage_settings, manage_admins, manage_dsa)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         view_dashboard      = VALUES(view_dashboard),
         manage_users        = VALUES(manage_users),
         manage_loans        = VALUES(manage_loans),
         manage_kyc          = VALUES(manage_kyc),
         view_transactions   = VALUES(view_transactions),
         manage_transactions = VALUES(manage_transactions),
         send_notifications  = VALUES(send_notifications),
         manage_referrals    = VALUES(manage_referrals),
         manage_settings     = VALUES(manage_settings),
         manage_admins       = VALUES(manage_admins),
         manage_dsa          = VALUES(manage_dsa)`,
      [targetId,
        p.view_dashboard ? 1 : 0,
        p.manage_users ? 1 : 0,
        p.manage_loans ? 1 : 0,
        p.manage_kyc ? 1 : 0,
        p.view_transactions ? 1 : 0,
        p.manage_transactions ? 1 : 0,
        p.send_notifications ? 1 : 0,
        p.manage_referrals ? 1 : 0,
        p.manage_settings ? 1 : 0,
        p.manage_admins ? 1 : 0,
        p.manage_dsa ? 1 : 0,
      ]
    );
    res.json({ success: true, message: 'Permissions updated successfully' });
  } catch (err) {
    console.error('[updateAdminPermissions]', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// PUT /api/admin/admins/:id/toggle-status
const toggleAdminStatus = async (req, res) => {
  try {
    const targetId = parseInt(req.params.id);
    if (targetId === req.admin.id) {
      return res.status(400).json({ success: false, message: 'Cannot deactivate your own account' });
    }
    const [existing] = await pool.query('SELECT id, role, is_active FROM admins WHERE id = ?', [targetId]);
    if (!existing.length) return res.status(404).json({ success: false, message: 'Admin not found' });
    if (existing[0].role === 'super_admin') {
      return res.status(403).json({ success: false, message: 'Cannot deactivate a super admin' });
    }

    const newStatus = existing[0].is_active ? 0 : 1;
    await pool.query('UPDATE admins SET is_active = ? WHERE id = ?', [newStatus, targetId]);
    res.json({ success: true, message: `Admin ${newStatus ? 'activated' : 'deactivated'} successfully`, is_active: newStatus });
  } catch (err) {
    console.error('[toggleAdminStatus]', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// DELETE /api/admin/admins/:id
const deleteAdmin = async (req, res) => {
  try {
    const targetId = parseInt(req.params.id);
    if (targetId === req.admin.id) {
      return res.status(400).json({ success: false, message: 'Cannot delete your own account' });
    }
    const [existing] = await pool.query('SELECT id, role FROM admins WHERE id = ?', [targetId]);
    if (!existing.length) return res.status(404).json({ success: false, message: 'Admin not found' });
    if (existing[0].role === 'super_admin') {
      return res.status(403).json({ success: false, message: 'Cannot delete a super admin' });
    }

    await pool.query('DELETE FROM admins WHERE id = ?', [targetId]);
    res.json({ success: true, message: 'Admin deleted successfully' });
  } catch (err) {
    console.error('[deleteAdmin]', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/admin/dsa/partners
const getAllDsaPartners = async (req, res) => {
  try {
    const [partners] = await pool.query(
      `SELECT u.id, u.full_name, u.mobile, u.email, u.created_at, u.is_dsa_partner,
              (SELECT COUNT(*) FROM users WHERE referred_by = u.id) AS total_leads,
              (SELECT COALESCE(SUM(credited_amount), 0) FROM referrals WHERE referrer_id = u.id AND status = 'credited') AS total_commissions
         FROM users u
        WHERE u.is_dsa_partner = 1
        ORDER BY u.created_at DESC`
    );
    res.json({ success: true, partners });
  } catch (err) {
    console.error('[getAllDsaPartners]', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// PUT /api/admin/users/:userId/dsa
const toggleUserDsaStatus = async (req, res) => {
  try {
    const { userId } = req.params;
    const { is_dsa_partner } = req.body;
    const dsaStatusVal = is_dsa_partner ? 1 : 0;

    const [userRow] = await pool.query('SELECT id, full_name, mobile, is_dsa_partner FROM users WHERE id = ?', [userId]);
    if (!userRow.length) return res.status(404).json({ success: false, message: 'User not found' });

    await pool.query('UPDATE users SET is_dsa_partner = ? WHERE id = ?', [dsaStatusVal, userId]);
    await invalidateUserCache(userId);

    // Send in-app notification about role change
    const title = dsaStatusVal ? '💼 DSA Partner Account Activated' : '💼 DSA Partner Status Revoked';
    const message = dsaStatusVal
      ? 'Congratulations! Your account has been upgraded to a DSA Partner. You can now onboard leads and track commissions via the new DSA Dashboard in your profile.'
      : 'Your DSA Partner privileges have been deactivated by an administrator.';
    await pool.query(
      'INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, ?)',
      [userId, title, message, 'system']
    );

    // Send push notification if token exists
    const [user] = await pool.query('SELECT fcm_token FROM users WHERE id = ?', [userId]);
    if (user[0]?.fcm_token) {
      await sendNotification(user[0].fcm_token, title, message, { screen: 'Profile' });
    }

    res.json({
      success: true,
      message: dsaStatusVal ? 'User assigned as DSA Partner successfully' : 'DSA Partner status revoked successfully',
      is_dsa_partner: dsaStatusVal
    });
  } catch (err) {
    console.error('[toggleUserDsaStatus]', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/admin/dsa/leads
const getAllDsaLeads = async (req, res) => {
  try {
    const [leads] = await pool.query(
      `SELECT u.id, u.full_name, u.mobile, u.email, u.created_at, u.is_kyc_verified,
              referrer.id AS referrer_id, referrer.full_name AS referrer_name, referrer.mobile AS referrer_mobile,
              kd.status AS kyc_doc_status,
              (SELECT status FROM loans WHERE user_id = u.id ORDER BY created_at DESC LIMIT 1) AS loan_status
         FROM users u
         JOIN users referrer ON referrer.id = u.referred_by
         LEFT JOIN kyc_documents kd ON kd.user_id = u.id
        WHERE referrer.is_dsa_partner = 1
        ORDER BY u.created_at DESC`
    );
    res.json({ success: true, leads });
  } catch (err) {
    console.error('[getAllDsaLeads]', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/admin/dsa-bank-list
const getDsaBankPartners = async (req, res) => {
  try {
    const [partners] = await pool.query(
      `SELECT id, name, email, role FROM admins WHERE role IN ('dsa_partner', 'bank_partner') AND is_active = 1`
    );
    res.json({ success: true, partners });
  } catch (err) {
    console.error('[getDsaBankPartners]', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// PUT /api/admin/users/:userId/assign-partner
const assignUserPartner = async (req, res) => {
  try {
    const { userId } = req.params;
    const { assigned_partner_id } = req.body;

    const partnerId = assigned_partner_id === null || assigned_partner_id === '' ? null : parseInt(assigned_partner_id);

    if (partnerId !== null) {
      const [partner] = await pool.query('SELECT role FROM admins WHERE id = ? AND is_active = 1', [partnerId]);
      if (!partner.length) {
        return res.status(404).json({ success: false, message: 'Partner not found or inactive' });
      }
      if (!['dsa_partner', 'bank_partner'].includes(partner[0].role)) {
        return res.status(400).json({ success: false, message: 'Target admin is not a DSA or Bank Partner' });
      }
    }

    const [userRow] = await pool.query('SELECT id FROM users WHERE id = ?', [userId]);
    if (!userRow.length) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    await pool.query('UPDATE users SET assigned_partner_id = ? WHERE id = ?', [partnerId, userId]);
    await invalidateUserCache(userId);

    if (partnerId !== null) {
      const [[partner]] = await pool.query('SELECT name FROM admins WHERE id = ?', [partnerId]);
      const partnerName = partner?.name || 'Relationship Officer';
      const title = 'Relationship Officer Assigned';
      const message = `Dedicated manager ${partnerName} has been assigned to assist you with your loan applications.`;

      await pool.query(
        'INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, ?)',
        [userId, title, message, 'system']
      );

      const [user] = await pool.query('SELECT fcm_token FROM users WHERE id = ?', [userId]);
      if (user[0]?.fcm_token) {
        await sendNotification(user[0].fcm_token, title, message, { screen: 'Profile' });
      }
    }

    res.json({
      success: true,
      message: partnerId === null ? 'Lead unassigned successfully' : 'Lead assigned to partner successfully',
      assigned_partner_id: partnerId
    });
  } catch (err) {
    console.error('[assignUserPartner]', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/admin/audit-log
const getAuditLog = async (req, res) => {
  try {
    const { page = 1, limit = 50, action, entity_type, admin_id } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let where = [];
    let params = [];
    if (action) { where.push('action LIKE ?'); params.push(`%${action}%`); }
    if (entity_type) { where.push('entity_type = ?'); params.push(entity_type); }
    if (admin_id) { where.push('admin_id = ?'); params.push(admin_id); }

    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) AS total FROM audit_log ${whereClause}`, params
    );
    const [logs] = await pool.query(
      `SELECT * FROM audit_log ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...params, parseInt(limit), offset]
    );

    res.json({ success: true, logs, total, page: parseInt(page), pages: Math.ceil(total / limit) });
  } catch (err) {
    console.error('[getAuditLog]', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// PUT /api/admin/loans/:id/settlement
const setLoanSettlement = async (req, res) => {
  try {
    const loanId = req.params.id;
    const { settlement_amount } = req.body; // number or null

    // Update in DB
    const [result] = await pool.query(
      'UPDATE loans SET settlement_amount = ? WHERE id = ?',
      [settlement_amount !== null && settlement_amount !== undefined ? parseFloat(settlement_amount) : null, loanId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: 'Loan not found' });
    }

    // Insert notification for user
    const [loan] = await pool.query('SELECT user_id, amount FROM loans WHERE id = ?', [loanId]);
    if (loan.length && settlement_amount !== null && settlement_amount !== undefined) {
      await pool.query(
        'INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, ?)',
        [
          loan[0].user_id,
          'Special One-Time Settlement Offer 🎁',
          `Settlement offer created for your active loan. Pay a flat ₹${settlement_amount} to close your loan immediately. Check the dashboard.`,
          'loan'
        ]
      );
    }

    res.json({ success: true, message: 'Settlement offer updated successfully' });
  } catch (err) {
    console.error('[setLoanSettlement]', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

module.exports = {
  getAdminDashboard, getAllUsers, getAllLoans,
  setLoanSettlement,
  approveLoan, rejectLoan, disburseLoan,
  processLoan, previewEMI, setWithdrawalLimit,
  getPendingKYC, reviewKYC,
  getAllTransactions, sendBulkNotification,
  getLoanEMISchedule, getOverdueEmis, setPenaltyWaiver,
  updateCreditLimit, toggleUserStatus,
  changeAdminPassword, getSystemSettings, updateSystemSettings,
  // Admin management
  getAllAdmins, createAdmin, updateAdmin, deleteAdmin,
  toggleAdminStatus, updateAdminPermissions,
  // Notification history
  getNotificationHistory,
  // DSA management
  getAllDsaPartners, toggleUserDsaStatus, getAllDsaLeads,
  // New Partner endpoints
  getDsaBankPartners, assignUserPartner,
  // Lead management (DSA partner CRM)
  updateLeadStatus, getLeadKycDetails,
  // Audit
  getAuditLog,
};
