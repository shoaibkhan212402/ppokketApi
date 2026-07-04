const cron = require('node-cron');
const { pool } = require('../config/db');

// ── Helpers ───────────────────────────────────────────────────────────────────

const sendSms = async (mobile, otp = null, message = null) => {
  const authkey = process.env.APITXT_AUTHKEY;
  if (!authkey) return;
  try {
    // For reminders we use a plain SMS with the message embedded as the OTP slot
    // APItxt replaces {otp} in the default template — we put our text there
    const url = new URL('https://apitxt.com/api/sendOTP');
    url.searchParams.set('authkey', authkey);
    url.searchParams.set('mobile', `91${mobile}`);
    url.searchParams.set('otp', otp || '000000'); // placeholder if no real OTP
    url.searchParams.set('channel', 'sms');
    await fetch(url.toString());
  } catch (err) {
    console.error('[scheduledJobs][sendSms]', err.message);
  }
};

const formatINR = (n) => `₹${parseFloat(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// ── JOB 1: Daily penalty calculation (runs at 00:05 every day) ────────────────
//   Finds all EMIs that are overdue (due_date < today, status = 'upcoming')
//   and applies a daily penalty = penalty_rate% of EMI amount per overdue day.
//   penalty_rate is stored per loan (default 1%).
const markOverdueAndCalcPenalty = async () => {
  const conn = await pool.getConnection();
  try {
    console.log('[cron] Running overdue/penalty job...');

    await conn.beginTransaction();

    // Step 1 — mark newly overdue EMIs
    await conn.query(
      `UPDATE emi_schedule
         SET status = 'overdue'
       WHERE status = 'upcoming'
         AND due_date < CURDATE()`
    );

    // Step 2 — calculate penalty for all overdue, unpaid, non-waived EMIs
    const [overdue] = await conn.query(
      `SELECT e.id, e.loan_id, e.emi_amount, e.penalty_amount, e.penalty_days,
              e.due_date, l.penalty_rate
         FROM emi_schedule e
         JOIN loans l ON l.id = e.loan_id
        WHERE e.status = 'overdue'
          AND e.penalty_waived = 0
          AND (e.paid_amount IS NULL OR e.paid_amount < e.emi_amount)`
    );

    for (const emi of overdue) {
      const daysPastDue   = Math.floor((Date.now() - new Date(emi.due_date).getTime()) / 86400000);
      const newDays       = Math.max(daysPastDue, 0);
      const penaltyRate   = parseFloat(emi.penalty_rate) || 1.0;
      // penalty = (penaltyRate / 100) * emi_amount * days_overdue  (cap at 50% of EMI)
      const rawPenalty    = (penaltyRate / 100) * parseFloat(emi.emi_amount) * newDays;
      const cappedPenalty = Math.min(rawPenalty, parseFloat(emi.emi_amount) * 0.5);
      const newPenalty    = Math.round(cappedPenalty * 100) / 100;

      await conn.query(
        `UPDATE emi_schedule SET penalty_amount = ?, penalty_days = ? WHERE id = ?`,
        [newPenalty, newDays, emi.id]
      );
    }

    // Step 3 — mark closed loans where all EMIs are paid or waived
    await conn.query(
      `UPDATE loans l
         SET l.status = 'closed'
       WHERE l.status = 'disbursed'
         AND NOT EXISTS (
           SELECT 1 FROM emi_schedule e
           WHERE e.loan_id = l.id AND e.status NOT IN ('paid', 'waived')
         )
         AND EXISTS (
           SELECT 1 FROM emi_schedule e2
           WHERE e2.loan_id = l.id
         )`
    );

    // Set mandates to inactive for users who have no active/disbursed loans
    await conn.query(
      `UPDATE bank_mandates m
          SET m.status = 'inactive'
        WHERE m.status = 'active'
          AND NOT EXISTS (
            SELECT 1 FROM loans l
             WHERE l.user_id = m.user_id
               AND l.status IN ('disbursed', 'approved', 'withdrawal_requested')
          )`
    );

    await conn.commit();
    console.log(`[cron] Penalty job complete — ${overdue.length} overdue EMIs processed`);
  } catch (err) {
    try { await conn.rollback(); } catch (_) {}
    console.error('[cron][penalty]', err.message);
  } finally {
    conn.release();
  }
};

// ── JOB 2: EMI reminders 3 days before due date (runs at 09:00 every day) ────
const sendEmiReminders = async () => {
  try {
    console.log('[cron] Running EMI reminder job...');

    const [upcoming] = await pool.query(
      `SELECT e.id, e.loan_id, e.emi_amount, e.due_date,
              u.mobile, u.full_name, u.fcm_token
         FROM emi_schedule e
         JOIN users u ON u.id = e.user_id
        WHERE e.status = 'upcoming'
          AND e.due_date = DATE_ADD(CURDATE(), INTERVAL 3 DAY)`
    );

    const { sendNotification } = require('./fcm');

    for (const emi of upcoming) {
      const dueDate = new Date(emi.due_date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
      const msg     = `Hi ${emi.full_name || 'User'}, your EMI of ${formatINR(emi.emi_amount)} is due on ${dueDate}. Please ensure funds are available. - Ppokket`;

      // Push notification
      if (emi.fcm_token) {
        sendNotification(emi.fcm_token, '⏰ EMI Due in 3 Days', msg, { screen: 'Loans' }).catch(() => {});
      }

      // In-app notification
      await pool.query(
        'INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, ?)',
        [emi.user_id || null, '⏰ EMI Reminder', msg, 'loan']
      ).catch(() => {});
    }

    // Also send overdue reminders for same-day overdue
    const [overdueToday] = await pool.query(
      `SELECT e.id, e.emi_amount, e.penalty_amount, e.due_date,
              u.id AS user_id, u.mobile, u.full_name, u.fcm_token
         FROM emi_schedule e
         JOIN users u ON u.id = e.user_id
        WHERE e.status = 'overdue'
          AND DATE(e.due_date) = DATE_SUB(CURDATE(), INTERVAL 1 DAY)`
    );

    for (const emi of overdueToday) {
      const total = parseFloat(emi.emi_amount) + parseFloat(emi.penalty_amount || 0);
      const msg   = `Your EMI of ${formatINR(emi.emi_amount)} was due yesterday. Penalty of ${formatINR(emi.penalty_amount || 0)} has been added. Total due: ${formatINR(total)}. Pay now to avoid further charges. - Ppokket`;
      if (emi.fcm_token) {
        sendNotification(emi.fcm_token, '❗ EMI Overdue', msg, { screen: 'Loans' }).catch(() => {});
      }
      await pool.query(
        'INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, ?)',
        [emi.user_id, '❗ EMI Overdue', msg, 'loan']
      ).catch(() => {});
    }

    console.log(`[cron] EMI reminders sent — ${upcoming.length} upcoming, ${overdueToday.length} overdue nudges`);
  } catch (err) {
    console.error('[cron][reminders]', err.message);
  }
};

// ── JOB 3: Weekly audit log cleanup — purge logs older than 1 year ────────────
const cleanOldAuditLogs = async () => {
  try {
    const [result] = await pool.query(
      `DELETE FROM audit_log WHERE created_at < DATE_SUB(NOW(), INTERVAL 1 YEAR)`
    );
    if (result.affectedRows > 0) {
      console.log(`[cron] Cleaned ${result.affectedRows} old audit log entries`);
    }
  } catch (err) {
    console.error('[cron][audit-cleanup]', err.message);
  }
};

// ── JOB 4: Daily EMI Auto-Debits via Cashfree (runs at 09:30 every day) ────────
const processAutoDebits = async () => {
  const conn = await pool.getConnection();
  const crypto = require('crypto');
  try {
    console.log('[cron] Running EMI Auto-Debit job...');

    // Find all upcoming EMIs due today where the user has an active mandate
    const [dueEmis] = await conn.query(
      `SELECT e.id AS emi_id, e.loan_id, e.installment_no, e.emi_amount, e.due_date,
              u.id AS user_id, u.full_name, u.mobile, u.fcm_token,
              m.subscription_id, m.payment_mode
         FROM emi_schedule e
         JOIN bank_mandates m ON m.user_id = e.user_id AND m.status = 'active'
         JOIN users u ON u.id = e.user_id
        WHERE e.status = 'upcoming'
          AND e.due_date = CURDATE()`
    );

    console.log(`[cron] Found ${dueEmis.length} due EMIs with active mandates to process.`);

    const appId = process.env.CASHFREE_APP_ID;
    const secretKey = process.env.CASHFREE_SECRET_KEY;
    const cfEnv = process.env.CASHFREE_ENV === 'production' ? 'production' : 'sandbox';
    const isMockGlobal = !appId || appId.includes('placeholder') || !secretKey || secretKey.includes('placeholder');
    if (isMockGlobal && process.env.NODE_ENV === 'production') {
      console.error('⚠️  [cron][AutoDebit] CASHFREE_APP_ID/CASHFREE_SECRET_KEY missing or placeholder in PRODUCTION — auto-debits are running in MOCK mode (EMIs will be marked paid with no real charge). Fix env vars immediately.');
    }
    const baseUrl = cfEnv === 'production' ? 'https://api.cashfree.com' : 'https://sandbox.cashfree.com';

    const { sendNotification } = require('./fcm');

    for (const emi of dueEmis) {
      console.log(`[cron][AutoDebit] Processing EMI #${emi.installment_no} of Loan #${emi.loan_id} for user ${emi.full_name} (${emi.emi_amount} INR)...`);

      const isMock = isMockGlobal || emi.payment_mode === 'mock';
      const orderId = `auto_${emi.loan_id}_${emi.installment_no}_${Date.now()}`;
      const paymentId = isMock ? `pay_auto_mock_${crypto.randomBytes(6).toString('hex')}` : `pay_auto_${Date.now()}`;

      // Insert pending transaction
      await conn.query(
        `INSERT INTO transactions (user_id, loan_id, razorpay_order_id, razorpay_payment_id, amount, type, status, description)
         VALUES (?, ?, ?, ?, ?, 'emi', 'pending', ?)`,
        [
          emi.user_id,
          emi.loan_id,
          orderId,
          isMock ? paymentId : null,
          emi.emi_amount,
          `Automatic EMI payment (Installment #${emi.installment_no})`
        ]
      );

      if (isMock) {
        // In mock mode, complete the payment successfully right away
        await conn.beginTransaction();
        try {
          // Update transaction
          await conn.query(
            "UPDATE transactions SET status = 'success' WHERE razorpay_order_id = ?",
            [orderId]
          );

          // Update loan paid amount
          await conn.query(
            "UPDATE loans SET amount_paid = amount_paid + ? WHERE id = ?",
            [emi.emi_amount, emi.loan_id]
          );

          // Update EMI status
          await conn.query(
            "UPDATE emi_schedule SET status = 'paid', paid_amount = ?, paid_at = NOW() WHERE id = ?",
            [emi.emi_amount, emi.emi_id]
          );

          // Check if loan fully closed — count remaining unpaid/non-waived EMIs
          const [[{ remaining }]] = await conn.query(
            `SELECT COUNT(*) AS remaining FROM emi_schedule
              WHERE loan_id = ? AND status NOT IN ('paid', 'waived')`,
            [emi.loan_id]
          );
          if (remaining === 0) {
            await conn.query("UPDATE loans SET status = 'closed' WHERE id = ?", [emi.loan_id]);
            await conn.query("UPDATE bank_mandates SET status = 'inactive' WHERE user_id = ?", [emi.user_id]);
          }

          // Send confirmation notifications
          const msg = `Auto-Debit Successful: ₹${emi.emi_amount} was successfully auto-debited for EMI #${emi.installment_no} of Loan #${emi.loan_id}.`;
          await conn.query(
            'INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, ?)',
            [emi.user_id, 'Auto-Debit Successful ✅', msg, 'payment']
          );

          if (emi.fcm_token) {
            sendNotification(emi.fcm_token, 'Auto-Debit Successful ✅', msg, { screen: 'Loans' }).catch(() => {});
          }

          await conn.commit();
          console.log(`[cron][AutoDebit] Mandate success (mock) for EMI #${emi.emi_id}`);
        } catch (dbErr) {
          await conn.rollback();
          console.error(`[cron][AutoDebit] DB Error in mock transaction execution:`, dbErr.message);
        }
      } else {
        // Call Cashfree Raise Charge API
        try {
          const payUrl = `${baseUrl}/pg/subscriptions/pay`;
          const payRes = await fetch(payUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Client-Id': appId,
              'X-Client-Secret': secretKey
            },
            body: JSON.stringify({
              subscription_id: emi.subscription_id,
              payment_id: orderId,
              payment_amount: parseFloat(emi.emi_amount),
              payment_remarks: `Auto recovery EMI #${emi.installment_no} for Loan #${emi.loan_id}`,
              payment_type: 'CHARGE'
            })
          });

          const payData = await payRes.json();

          if (payRes.status === 200) {
            console.log(`[cron][AutoDebit] Cashfree charge initiated successfully for sub_id ${emi.subscription_id}:`, payData);
          } else {
            console.error(`[cron][AutoDebit] Cashfree charge failed for sub_id ${emi.subscription_id}:`, payData);
            // Mark transaction failed
            await conn.query(
              "UPDATE transactions SET status = 'failed', description = ? WHERE razorpay_order_id = ?",
              [`Cashfree Auto-Debit Failed: ${payData.message || 'Unknown error'}`, orderId]
            );

            // Notify user about auto-debit failure
            const failMsg = `Auto-Debit Failed: Automatic deduction of ₹${emi.emi_amount} failed. Please pay manually to avoid overdue charges.`;
            await conn.query(
              'INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, ?)',
              [emi.user_id, 'Auto-Debit Failed ⚠️', failMsg, 'payment']
            );

            if (emi.fcm_token) {
              sendNotification(emi.fcm_token, 'Auto-Debit Failed ⚠️', failMsg, { screen: 'Loans' }).catch(() => {});
            }
          }
        } catch (apiErr) {
          console.error(`[cron][AutoDebit] API request exception for sub_id ${emi.subscription_id}:`, apiErr.message);
          await conn.query(
            "UPDATE transactions SET status = 'failed', description = ? WHERE razorpay_order_id = ?",
            [`API error: ${apiErr.message}`, orderId]
          );
        }
      }
    }
  } catch (err) {
    console.error('[cron][auto-debit-job]', err.message);
  } finally {
    conn.release();
  }
};

// ── Register all cron jobs ────────────────────────────────────────────────────
const registerJobs = () => {
  // Penalty calculation — every day at 00:05
  cron.schedule('5 0 * * *', markOverdueAndCalcPenalty, { timezone: 'Asia/Kolkata' });

  // EMI reminders — every day at 09:00
  cron.schedule('0 9 * * *', sendEmiReminders, { timezone: 'Asia/Kolkata' });

  // Audit log cleanup — every Sunday at 02:00
  cron.schedule('0 2 * * 0', cleanOldAuditLogs, { timezone: 'Asia/Kolkata' });

  // Auto-debit processing — every day at 09:30
  cron.schedule('30 9 * * *', processAutoDebits, { timezone: 'Asia/Kolkata' });

  console.log('✅ Scheduled jobs registered: penalty, EMI reminders, audit cleanup, auto-debit');
};

module.exports = { registerJobs, markOverdueAndCalcPenalty, sendEmiReminders, processAutoDebits };
