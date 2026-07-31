const crypto = require('crypto');
const { pool } = require('../config/db');
const { calculateMaturityAmount, calculateCurrentValue } = require('../utils/investmentUtils');
const { sendNotification } = require('../utils/fcm');
const { invalidateUserCache } = require('../config/redis');

// Reads the admin-configured investment settings from system_settings.
// investment_max_amount === '' means "no cap".
const getSettings = async () => {
  const [rows] = await pool.query(
    `SELECT setting_key, setting_value FROM system_settings WHERE setting_key IN (
       'investment_monthly_rate', 'investment_min_amount', 'investment_max_amount',
       'investment_min_tenure_months', 'investment_max_tenure_months'
     )`
  );
  const map = Object.fromEntries(rows.map(r => [r.setting_key, r.setting_value]));
  return {
    monthly_rate: parseFloat(map.investment_monthly_rate ?? '1'),
    min_amount: parseFloat(map.investment_min_amount ?? '5000'),
    max_amount: map.investment_max_amount && map.investment_max_amount !== '' ? parseFloat(map.investment_max_amount) : null,
    min_tenure_months: parseInt(map.investment_min_tenure_months ?? '1'),
    max_tenure_months: parseInt(map.investment_max_tenure_months ?? '12'),
  };
};

// ─────────────────────────────────────────────
// USER-FACING
// ─────────────────────────────────────────────

// GET /api/investment/settings
const getInvestmentSettings = async (req, res) => {
  try {
    const settings = await getSettings();
    res.json({ success: true, settings });
  } catch (err) {
    console.error('[getInvestmentSettings]', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/investment/calculator?amount=&tenure_months=
const previewMaturity = async (req, res) => {
  try {
    const principal = parseFloat(req.query.amount);
    const tenureMonths = parseInt(req.query.tenure_months);
    if (!Number.isFinite(principal) || principal <= 0 || !Number.isInteger(tenureMonths) || tenureMonths <= 0) {
      return res.status(400).json({ success: false, message: 'amount and tenure_months are required' });
    }

    const settings = await getSettings();
    const maturityAmount = calculateMaturityAmount(principal, settings.monthly_rate, tenureMonths);

    res.json({
      success: true,
      principal_amount: principal,
      interest_rate: settings.monthly_rate,
      tenure_months: tenureMonths,
      maturity_amount: maturityAmount,
      total_interest: Math.round((maturityAmount - principal) * 100) / 100,
    });
  } catch (err) {
    console.error('[previewMaturity]', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/investment/create
const createInvestment = async (req, res) => {
  try {
    const userId = req.user.id;
    const principal = Number(req.body.amount);
    const tenureMonths = parseInt(req.body.tenure_months);

    if (!Number.isFinite(principal) || principal <= 0 || !Number.isInteger(tenureMonths) || tenureMonths <= 0) {
      return res.status(400).json({ success: false, message: 'A valid amount and tenure_months are required' });
    }

    // Check KYC — same gate as loan applications
    const [kyc] = await pool.query('SELECT status FROM kyc_documents WHERE user_id = ?', [userId]);
    if (!kyc.length || kyc[0].status !== 'approved') {
      return res.status(403).json({ success: false, message: 'KYC verification required before investing' });
    }

    const settings = await getSettings();

    if (principal < settings.min_amount || (settings.max_amount !== null && principal > settings.max_amount)) {
      const rangeMsg = settings.max_amount !== null
        ? `between ₹${settings.min_amount} and ₹${settings.max_amount}`
        : `at least ₹${settings.min_amount}`;
      return res.status(400).json({ success: false, message: `Amount must be ${rangeMsg}` });
    }
    if (tenureMonths < settings.min_tenure_months || tenureMonths > settings.max_tenure_months) {
      return res.status(400).json({ success: false, message: `Tenure must be between ${settings.min_tenure_months} and ${settings.max_tenure_months} months` });
    }

    const maturityAmount = calculateMaturityAmount(principal, settings.monthly_rate, tenureMonths);

    const [result] = await pool.query(
      `INSERT INTO investments (user_id, principal_amount, interest_rate, tenure_months, maturity_amount, status)
       VALUES (?, ?, ?, ?, ?, 'pending')`,
      [userId, principal, settings.monthly_rate, tenureMonths, maturityAmount]
    );

    res.status(201).json({
      success: true,
      message: 'Investment created — proceed to funding',
      investment: {
        id: result.insertId,
        principal_amount: principal,
        interest_rate: settings.monthly_rate,
        tenure_months: tenureMonths,
        maturity_amount: maturityAmount,
        status: 'pending',
      },
    });
  } catch (err) {
    console.error('[createInvestment]', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/investment/cancel/:id
const cancelInvestment = async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;

    const [result] = await pool.query(
      "UPDATE investments SET status = 'cancelled' WHERE id = ? AND user_id = ? AND status = 'pending'",
      [id, userId]
    );
    if (!result.affectedRows) {
      return res.status(400).json({ success: false, message: 'Investment not found or cannot be cancelled (already funded or not yours)' });
    }

    res.json({ success: true, message: 'Investment cancelled' });
  } catch (err) {
    console.error('[cancelInvestment]', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/investment/withdraw/:id
// Early-withdrawal rule: if the lock-in period (tenure) has already fully
// elapsed, the user gets the full locked-in maturity_amount (same as the
// nightly maturity cron). If withdrawn before the lock-in period ends, the
// user gets principal_amount only — interest is forfeited.
const withdrawInvestment = async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const userId = req.user.id;
    const { id } = req.params;
    const { payout_method, account_holder_name, account_number, ifsc_code, upi_id } = req.body;

    if (payout_method === 'bank') {
      if (!account_holder_name || !account_number || !ifsc_code) {
        await conn.rollback();
        return res.status(400).json({ success: false, message: 'Account holder name, account number and IFSC code are required' });
      }
    } else if (payout_method === 'upi') {
      if (!upi_id) {
        await conn.rollback();
        return res.status(400).json({ success: false, message: 'UPI ID is required' });
      }
    } else {
      return res.status(400).json({ success: false, message: 'payout_method must be "bank" or "upi"' });
    }

    await conn.beginTransaction();

    const [[investment]] = await conn.query(
      `SELECT *, (maturity_date <= CURDATE()) AS is_matured
         FROM investments WHERE id = ? AND user_id = ? AND status = 'active' FOR UPDATE`,
      [id, userId]
    );
    if (!investment) {
      await conn.rollback();
      return res.status(404).json({ success: false, message: 'Active investment not found' });
    }

    const isMatured = !!investment.is_matured;
    const payoutAmount = isMatured ? parseFloat(investment.maturity_amount) : parseFloat(investment.principal_amount);

    const [updateResult] = await conn.query(
      `UPDATE investments SET
         status = 'withdrawal_requested',
         payout_method = ?,
         payout_account_holder = ?,
         payout_account_number = ?,
         payout_ifsc = ?,
         payout_upi_id = ?,
         pending_payout_amount = ?,
         is_early_withdrawal = ?,
         withdrawal_requested_at = NOW()
       WHERE id = ? AND status = 'active'`,
      [
        payout_method,
        payout_method === 'bank' ? account_holder_name : null,
        payout_method === 'bank' ? account_number : null,
        payout_method === 'bank' ? ifsc_code : null,
        payout_method === 'upi' ? upi_id : null,
        payoutAmount,
        isMatured ? 0 : 1,
        id,
      ]
    );
    if (updateResult.affectedRows !== 1) {
      // Lost a race with the maturity cron (or a duplicate request) — the
      // investment was already closed out by the other request.
      await conn.rollback();
      return res.status(409).json({ success: false, message: 'Investment status changed — please refresh and try again' });
    }

    const notifMsg = isMatured
      ? `Your withdrawal of ₹${payoutAmount} (full maturity amount) has been received and is being processed. Funds will reach your account within 24–48 hours.`
      : `Your withdrawal of ₹${payoutAmount} (principal only — lock-in period not complete, interest forfeited) has been received and is being processed. Funds will reach your account within 24–48 hours.`;
    await conn.query(
      'INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, ?)',
      [userId, '⏳ Withdrawal Processing', notifMsg, 'payment']
    );

    await conn.commit();

    const [[user]] = await pool.query('SELECT fcm_token FROM users WHERE id = ?', [userId]);
    if (user?.fcm_token) {
      sendNotification(user.fcm_token, '⏳ Withdrawal Processing', notifMsg, { screen: 'Investments' }).catch(() => {});
    }

    res.json({
      success: true,
      message: 'Withdrawal request received — funds will be sent to your account within 24–48 hours.',
      matured: isMatured,
      amount_pending: payoutAmount,
    });
  } catch (err) {
    try { await conn.rollback(); } catch (_) {}
    console.error('[withdrawInvestment]', err);
    res.status(500).json({ success: false, message: err.message });
  } finally {
    conn.release();
  }
};

// GET /api/investment/my-investments
const getMyInvestments = async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT * FROM investments WHERE user_id = ? ORDER BY created_at DESC',
      [req.user.id]
    );

    const investments = rows.map(inv => ({ ...inv, current_value: calculateCurrentValue(inv) }));
    res.json({ success: true, investments });
  } catch (err) {
    console.error('[getMyInvestments]', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/investment/my-investments/:id
const getInvestmentDetails = async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT * FROM investments WHERE id = ? AND user_id = ?',
      [req.params.id, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ success: false, message: 'Investment not found' });

    const [transactions] = await pool.query(
      'SELECT * FROM transactions WHERE investment_id = ? ORDER BY created_at DESC',
      [req.params.id]
    );

    res.json({
      success: true,
      investment: { ...rows[0], current_value: calculateCurrentValue(rows[0]) },
      transactions,
    });
  } catch (err) {
    console.error('[getInvestmentDetails]', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/investment/portfolio-summary
const getPortfolioSummary = async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM investments WHERE user_id = ?', [req.user.id]);

    const active = rows.filter(r => r.status === 'active');
    const matured = rows.filter(r => r.status === 'matured');
    const totalInvested = active.reduce((s, r) => s + parseFloat(r.principal_amount), 0);
    const currentValue = active.reduce((s, r) => s + calculateCurrentValue(r), 0);
    const totalMaturedPayout = matured.reduce((s, r) => s + parseFloat(r.maturity_amount), 0);

    res.json({
      success: true,
      summary: {
        active_count: active.length,
        matured_count: matured.length,
        total_invested: Math.round(totalInvested * 100) / 100,
        current_value: Math.round(currentValue * 100) / 100,
        total_matured_payout: Math.round(totalMaturedPayout * 100) / 100,
      },
    });
  } catch (err) {
    console.error('[getPortfolioSummary]', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─────────────────────────────────────────────
// ADMIN-FACING
// ─────────────────────────────────────────────

// GET /api/admin/investments
const adminGetAllInvestments = async (req, res) => {
  try {
    const { page = 1, limit = 25, status = 'all', search = '' } = req.query;
    const offset = (page - 1) * limit;

    let where = '';
    const params = [];
    if (status !== 'all') { where += ' AND i.status = ?'; params.push(status); }
    if (search) {
      where += ' AND (u.full_name LIKE ? OR u.mobile LIKE ?)';
      const q = `%${search}%`;
      params.push(q, q);
    }

    const [investments] = await pool.query(
      `SELECT i.*, u.full_name AS user_name, u.mobile AS user_mobile
         FROM investments i
         JOIN users u ON u.id = i.user_id
        WHERE 1=1 ${where}
        ORDER BY i.created_at DESC
        LIMIT ? OFFSET ?`,
      [...params, Number(limit), Number(offset)]
    );

    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) AS total FROM investments i
         JOIN users u ON u.id = i.user_id
        WHERE 1=1 ${where}`,
      params
    );

    const withCurrentValue = investments.map(inv => ({ ...inv, current_value: calculateCurrentValue(inv) }));

    res.json({ success: true, investments: withCurrentValue, total });
  } catch (err) {
    console.error('[adminGetAllInvestments]', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/admin/investments/:id
const adminGetInvestmentDetail = async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT i.*, u.full_name AS user_name, u.mobile AS user_mobile
         FROM investments i
         JOIN users u ON u.id = i.user_id
        WHERE i.id = ?`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ success: false, message: 'Investment not found' });

    const [transactions] = await pool.query(
      'SELECT * FROM transactions WHERE investment_id = ? ORDER BY created_at DESC',
      [req.params.id]
    );

    res.json({
      success: true,
      investment: { ...rows[0], current_value: calculateCurrentValue(rows[0]) },
      transactions,
    });
  } catch (err) {
    console.error('[adminGetInvestmentDetail]', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/admin/investments/:id/complete-withdrawal
// Admin has manually sent the money to the user's bank/UPI (outside the app,
// same real-world step as loan disbursement) and confirms it here. This is
// the point wallet_balance actually gets credited — mirrors
// adminController.js's disburseLoan, which credits wallet_balance as the
// in-app running-total record even though the real money went to the user's
// bank account.
const adminCompleteWithdrawal = async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const { id } = req.params;

    await conn.beginTransaction();

    const [[investment]] = await conn.query(
      "SELECT * FROM investments WHERE id = ? AND status = 'withdrawal_requested' FOR UPDATE",
      [id]
    );
    if (!investment) {
      await conn.rollback();
      return res.status(404).json({ success: false, message: 'No pending withdrawal request found for this investment' });
    }

    const payoutAmount = parseFloat(investment.pending_payout_amount);
    const isEarly = !!investment.is_early_withdrawal;
    const newStatus = isEarly ? 'withdrawn' : 'matured';
    const txnType = isEarly ? 'investment_withdrawal' : 'investment_payout';
    const mockUTR = 'PAYOUT' + crypto.randomBytes(6).toString('hex').toUpperCase();
    const destination = investment.payout_method === 'upi'
      ? `UPI ${investment.payout_upi_id}`
      : `A/C ****${(investment.payout_account_number || '').slice(-4)} (IFSC ${investment.payout_ifsc})`;
    const description = isEarly
      ? `Early withdrawal sent to ${destination} — principal only, interest forfeited. UTR: ${mockUTR}`
      : `Maturity payout sent to ${destination}. UTR: ${mockUTR}`;

    const [updateResult] = await conn.query(
      "UPDATE investments SET status = ?, matured_at = NOW() WHERE id = ? AND status = 'withdrawal_requested'",
      [newStatus, id]
    );
    if (updateResult.affectedRows !== 1) {
      await conn.rollback();
      return res.status(409).json({ success: false, message: 'Withdrawal request status changed — please refresh and try again' });
    }

    await conn.query('UPDATE users SET wallet_balance = wallet_balance + ? WHERE id = ?', [payoutAmount, investment.user_id]);

    const [txnResult] = await conn.query(
      `INSERT INTO transactions (user_id, investment_id, amount, type, status, description)
       VALUES (?, ?, ?, ?, 'success', ?)`,
      [investment.user_id, investment.id, payoutAmount, txnType, description]
    );
    await conn.query('UPDATE investments SET payout_transaction_id = ? WHERE id = ?', [txnResult.insertId, investment.id]);

    const notifMsg = `₹${payoutAmount} has been sent to your ${destination}.`;
    await conn.query(
      'INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, ?)',
      [investment.user_id, '✅ Withdrawal Complete', notifMsg, 'payment']
    );

    await conn.commit();

    await invalidateUserCache(investment.user_id).catch(() => {});
    const [[user]] = await pool.query('SELECT fcm_token FROM users WHERE id = ?', [investment.user_id]);
    if (user?.fcm_token) {
      sendNotification(user.fcm_token, '✅ Withdrawal Complete', notifMsg, { screen: 'Investments' }).catch(() => {});
    }

    res.json({ success: true, message: 'Withdrawal marked as sent', amount: payoutAmount, utr: mockUTR });
  } catch (err) {
    try { await conn.rollback(); } catch (_) {}
    console.error('[adminCompleteWithdrawal]', err);
    res.status(500).json({ success: false, message: err.message });
  } finally {
    conn.release();
  }
};

module.exports = {
  getInvestmentSettings, previewMaturity,
  createInvestment, cancelInvestment, withdrawInvestment,
  getMyInvestments, getInvestmentDetails, getPortfolioSummary,
  adminGetAllInvestments, adminGetInvestmentDetail, adminCompleteWithdrawal,
};
