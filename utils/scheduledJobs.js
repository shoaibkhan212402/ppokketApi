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

    // Step 3 — mark closed loans where all EMIs are paid
    await conn.query(
      `UPDATE loans l
         SET l.status = 'closed'
       WHERE l.status = 'disbursed'
         AND NOT EXISTS (
           SELECT 1 FROM emi_schedule e
           WHERE e.loan_id = l.id AND e.status != 'paid'
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

// ── Register all cron jobs ────────────────────────────────────────────────────
const registerJobs = () => {
  // Penalty calculation — every day at 00:05
  cron.schedule('5 0 * * *', markOverdueAndCalcPenalty, { timezone: 'Asia/Kolkata' });

  // EMI reminders — every day at 09:00
  cron.schedule('0 9 * * *', sendEmiReminders, { timezone: 'Asia/Kolkata' });

  // Audit log cleanup — every Sunday at 02:00
  cron.schedule('0 2 * * 0', cleanOldAuditLogs, { timezone: 'Asia/Kolkata' });

  console.log('✅ Scheduled jobs registered: penalty, EMI reminders, audit cleanup');
};

module.exports = { registerJobs, markOverdueAndCalcPenalty, sendEmiReminders };
