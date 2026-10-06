const crypto = require('crypto');
const { pool } = require('../config/db');
const { sendNotification } = require('./fcm');
const {
  cashfreeSubscriptions, cashfreeErrorCode, cashfreeErrorMessage, autoPayMode,
} = require('./paymentGateway');

// Auto-Pay: a customer's e-mandate (bank_mandates) and the EMI debits raised
// against it. The HTTP side lives in mandateController, the schedule in
// scheduledJobs; this is the part they share.
//
// How one EMI is collected:
//   1. The day before it falls due, raiseAutoDebits() records a pending
//      transaction and asks Cashfree to present the debit on the due date.
//   2. The bank's answer arrives as a SUBSCRIPTION_PAYMENT_* webhook
//      (handleSubscriptionEvent). A success is settled exactly like a manual
//      EMI payment; a failure is recorded and the customer is told to pay.
//   3. reconcileAutoDebits() asks Cashfree about anything still pending, so a
//      missed webhook or an interrupted request never strands a debit.

// A debit can't be presented the day it is raised: Cashfree takes a schedule
// date from tomorrow (if raised before 21:00 IST for UPI Autopay) to 14 days out.
const AUTO_DEBIT_LEAD_DAYS = 1;
const PRESENT_CUTOFF_HOUR_IST = 20;
// The nightly overdue job leaves an EMI alone this many days past its due date
// while its debit is still in flight — bank results can take a couple of
// working days — so a customer who was debited on time isn't charged a penalty.
const AUTO_DEBIT_GRACE_DAYS = 4;
// How long a debit Cashfree accepted may go unanswered before it is written off.
const UNANSWERED_DEBIT_MINUTES = 10 * 24 * 60;
// How long after setup a mandate that isn't active yet keeps being checked on.
const PENDING_MANDATE_WATCH_DAYS = 3;
const JOB_LOCK = 'ppokket_auto_debit';
const LOAN_SCREEN = { screen: 'Profile', params: { screen: 'LoanHistory' } };
const SETUP_AGAIN_MESSAGE = 'Your Auto-Pay mandate is not active with your bank, so EMIs will not be debited automatically. Please set up Auto-Pay again from your profile.';

const formatINR = (n) => `₹${parseFloat(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// Calendar date in India, `offsetDays` from today, as YYYY-MM-DD.
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const istDate = (offsetDays = 0) => new Date(Date.now() + IST_OFFSET_MS + offsetDays * 86400000).toISOString().slice(0, 10);
const istHour = () => new Date(Date.now() + IST_OFFSET_MS).getUTCHours();

// An auto-debit is known everywhere by one id: auto_<loanId>_<installmentNo>_<timestamp>.
// It is the transaction's razorpay_order_id and the payment_id Cashfree has for
// the charge; the loan and installment in it tie the debit back to its EMI.
const autoDebitOrderId = (loanId, installmentNo) => `auto_${loanId}_${installmentNo}_${Date.now()}`;
const isAutoDebitOrder = (orderId) => /^auto_\d+_\d+_/.test(orderId || '');
const installmentOfOrder = (orderId) => Number(/^auto_\d+_(\d+)_/.exec(orderId || '')?.[1]) || null;
// SQL: transactions row `t` is an auto-debit of emi_schedule row `e`.
const AUTO_DEBIT_OF_EMI = "t.loan_id = e.loan_id AND t.razorpay_order_id LIKE CONCAT('auto\\_', e.loan_id, '\\_', e.installment_no, '\\_%')";
// SQL: emi_schedule row `e` has a debit in flight that the overdue job should wait for.
const AWAITING_AUTO_DEBIT = `e.due_date >= DATE_SUB(CURDATE(), INTERVAL ${AUTO_DEBIT_GRACE_DAYS} DAY)
  AND EXISTS (SELECT 1 FROM transactions t WHERE t.type = 'emi' AND t.status = 'pending' AND ${AUTO_DEBIT_OF_EMI})`;

const notifyUser = async (userId, title, message, pushTarget) => {
  await pool.query(
    'INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, ?)',
    [userId, title, message, 'payment']
  );
  const [[user]] = await pool.query('SELECT fcm_token FROM users WHERE id = ?', [userId]);
  if (user?.fcm_token) sendNotification(user.fcm_token, title, message, pushTarget).catch(() => {});
};

// ── Mandates ──────────────────────────────────────────────────────────────────

// Cashfree subscription_status → bank_mandates.status
const MANDATE_STATUS = {
  INITIALIZED: 'pending',           // registered; the customer has not authorised it yet
  BANK_APPROVAL_PENDING: 'pending', // authorised; the bank / NPCI has still to confirm
  ACTIVE: 'active',
  ON_HOLD: 'active',                // a debit failed; the mandate itself still stands (see chargeMandate)
  PAUSED: 'cancelled',
  CUSTOMER_PAUSED: 'cancelled',
  CANCELLED: 'cancelled',
  CUSTOMER_CANCELLED: 'cancelled',
  COMPLETED: 'cancelled',
  EXPIRED: 'failed',
  LINK_EXPIRED: 'failed',
  CARD_EXPIRED: 'failed',
};
const CHARGEABLE_AT_GATEWAY = ['ACTIVE', 'ON_HOLD'];

const findMandate = async (subscriptionId) => {
  if (!subscriptionId) return null;
  const [[mandate]] = await pool.query('SELECT * FROM bank_mandates WHERE subscription_id = ?', [subscriptionId]);
  return mandate || null;
};

// Brings a mandate row in line with what Cashfree says about its subscription.
// `sub` is the subscription when the caller has already fetched it. Resolves
// to { mandate, gatewayStatus } — the refreshed row and Cashfree's own status,
// which is null when Cashfree has no such subscription.
const syncMandate = async (mandate, sub) => {
  if (sub === undefined) sub = await cashfreeSubscriptions.fetch(mandate.subscription_id);

  // Unknown to this Cashfree account (registered against other keys, say):
  // nothing can be debited through it, so it has to be set up again.
  let status = sub ? (MANDATE_STATUS[sub.subscription_status] || mandate.status) : 'failed';
  // A mandate parked when its loan closed stays parked until the customer reuses it.
  if (mandate.status === 'inactive' && status === 'active') status = 'inactive';

  const auth = sub?.authorization_details || {};
  const row = [mandate.id, mandate.subscription_id];
  // Claiming the move to 'active' in its own statement means only one of the
  // paths that can see it (return page, verify, webhook) announces it.
  let activated = false;
  if (status === 'active') {
    const [claimed] = await pool.query(
      "UPDATE bank_mandates SET status = 'active' WHERE id = ? AND subscription_id = ? AND status <> 'active'",
      row
    );
    activated = claimed.affectedRows === 1;
  }
  await pool.query(
    `UPDATE bank_mandates SET
       status = ?, umrn = COALESCE(?, umrn), payment_mode = COALESCE(?, payment_mode), mandate_id = COALESCE(?, mandate_id)
     WHERE id = ? AND subscription_id = ?`,
    [status, auth.authorization_reference || null, auth.payment_group || null, sub?.cf_subscription_id || null, ...row]
  );

  if (activated) {
    await notifyUser(
      mandate.user_id,
      'Auto-Pay Activated Successfully! 🏦',
      'Automatic deduction of EMIs has been set up on your bank account.',
      { screen: 'Profile' }
    ).catch((err) => console.error('[autoPay] activation notice failed:', err.message));
  }

  const [[refreshed]] = await pool.query('SELECT * FROM bank_mandates WHERE id = ?', [mandate.id]);
  return { mandate: refreshed || mandate, gatewayStatus: sub?.subscription_status || null };
};

// A mandate simulated in development can't be debited by a server that talks
// to Cashfree. Marks such a row failed so the customer sets Auto-Pay up for
// real; resolves to true when it did.
const retireMockMandate = async (mandate) => {
  if (!mandate || mandate.payment_mode !== 'mock' || autoPayMode() === 'mock') return false;
  if (mandate.status !== 'failed') {
    await pool.query("UPDATE bank_mandates SET status = 'failed' WHERE id = ?", [mandate.id]);
    mandate.status = 'failed';
  }
  return true;
};

// ── Debits ────────────────────────────────────────────────────────────────────

// Closes a pending auto-debit as failed. Resolves to true if this call closed it.
const failAutoDebit = async (orderId, description, cfPaymentId = null) => {
  const [result] = await pool.query(
    `UPDATE transactions SET
       status = 'failed', description = ?, razorpay_payment_id = COALESCE(?, razorpay_payment_id)
     WHERE razorpay_order_id = ? AND type = 'emi' AND status = 'pending'`,
    [String(description).slice(0, 500), cfPaymentId, orderId]
  );
  return result.affectedRows === 1;
};

const notifyDebitFailed = async (orderId) => {
  const [[txn]] = await pool.query(
    'SELECT user_id, loan_id, amount FROM transactions WHERE razorpay_order_id = ? ORDER BY id ASC LIMIT 1',
    [orderId]
  );
  if (!txn) return;
  await notifyUser(
    txn.user_id,
    'Auto-Debit Failed ⚠️',
    `Automatic deduction of ${formatINR(txn.amount)} for EMI #${installmentOfOrder(orderId)} of Loan #${txn.loan_id} did not go through. Please pay it manually to avoid late charges.`,
    LOAN_SCREEN
  );
};

// Applies Cashfree's verdict on a debit to its transaction. `payment` is a
// subscription payment as Cashfree reports it (charge response, webhook or
// lookup). Safe to call any number of times, from any of those paths.
// Resolves to 'success' | 'failed' | 'pending'.
const recordChargeResult = async (orderId, payment) => {
  const status = String(payment?.payment_status || '').toUpperCase();
  const cfPaymentId = payment?.cf_payment_id ? String(payment.cf_payment_id) : null;

  if (status === 'SUCCESS') {
    // Required here, not at the top: paymentController reaches back into this
    // module (cancelScheduledAutoDebits) when a payment settles.
    const { settlePaidOrder } = require('../controllers/paymentController');
    const outcome = await settlePaidOrder(orderId, cfPaymentId || `cf_${orderId}`);
    if (outcome.status === 'not_found') {
      console.error(`[autoPay] Cashfree reports ${orderId} paid but there is no such transaction — needs a manual look.`);
    }
    return 'success';
  }

  if (['FAILED', 'CANCELLED'].includes(status)) {
    const reason = payment.failure_details?.failure_reason
      || (status === 'CANCELLED' ? 'the debit was cancelled' : 'declined by the bank');
    if (await failAutoDebit(orderId, `Auto-debit failed: ${reason}`, cfPaymentId)) {
      await notifyDebitFailed(orderId);
    }
    return 'failed';
  }

  // Accepted and waiting for its day at the bank. Keeping Cashfree's id marks
  // the debit as one Cashfree has taken on.
  if (cfPaymentId) {
    await pool.query(
      "UPDATE transactions SET razorpay_payment_id = ? WHERE razorpay_order_id = ? AND status = 'pending' AND razorpay_payment_id IS NULL",
      [cfPaymentId, orderId]
    );
  }
  return 'pending';
};

// Cashfree turned the request down for good — as opposed to a timeout, an
// outage or an auth problem, where the debit may or may not exist on its side.
const isDefiniteRejection = (err) => {
  if (![400, 404].includes(err.response?.status)) return false;
  // A repeat of a payment_id Cashfree already holds is not a refusal of the debit.
  return !/already|duplicate/i.test(`${cashfreeErrorCode(err)} ${cashfreeErrorMessage(err)}`);
};

const chargeMandate = async (debit) => {
  const request = {
    subscriptionId: debit.subscriptionId,
    paymentId: debit.orderId,
    amount: debit.amount,
    scheduleDate: debit.dueDate,
    remarks: `EMI ${debit.installmentNo} of loan ${debit.loanId}`,
  };
  try {
    return await cashfreeSubscriptions.charge(request);
  } catch (err) {
    if (cashfreeErrorCode(err) !== 'subscription_not_active') throw err;
    // Cashfree parks a subscription ON_HOLD after a failed debit. The mandate
    // at the bank is still good, so lift the hold and present again.
    const sub = await cashfreeSubscriptions.fetch(debit.subscriptionId).catch(() => null);
    if (sub?.subscription_status !== 'ON_HOLD') throw err;
    try {
      await cashfreeSubscriptions.manage(debit.subscriptionId, 'ACTIVATE');
    } catch (activateErr) {
      console.error(`[autoPay] Could not lift the hold on ${debit.subscriptionId}:`, activateErr.response?.data || activateErr.message);
      throw err;
    }
    return cashfreeSubscriptions.charge(request);
  }
};

// Asks Cashfree to present one debit and records the answer. The pending
// transaction must exist before this is called, so that whatever happens to
// the request there is a record to reconcile.
const presentCharge = async (debit) => {
  let payment;
  try {
    payment = await chargeMandate(debit);
  } catch (err) {
    console.error(`[autoPay] Charge ${debit.orderId} not accepted:`, err.response?.data || err.message);
    // Outcome unknown — leave it pending; reconcileAutoDebits will find out.
    if (!isDefiniteRejection(err)) return;

    if (await failAutoDebit(debit.orderId, `Auto-debit could not be scheduled: ${cashfreeErrorMessage(err)}`)) {
      await notifyDebitFailed(debit.orderId);
    }
    if (['subscription_not_active', 'subscription_not_found'].includes(cashfreeErrorCode(err))) {
      await retireUnchargeableMandate(debit.subscriptionId);
    }
    return;
  }

  if (await recordChargeResult(debit.orderId, payment) === 'pending') {
    const dueOn = new Date(`${debit.dueDate}T12:00:00+05:30`)
      .toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
    await notifyUser(
      debit.userId,
      'Auto-Debit Scheduled 🏦',
      `${formatINR(debit.amount)} for EMI #${debit.installmentNo} of Loan #${debit.loanId} will be debited from your bank account on ${dueOn}. Please keep your account funded.`,
      LOAN_SCREEN
    );
  }
};

// Cashfree refused a debit because the mandate isn't chargeable. Take its
// word: bring the row in line, and if Cashfree still calls the mandate usable
// but won't charge it, stop presenting debits against it.
const retireUnchargeableMandate = async (subscriptionId) => {
  const mandate = await findMandate(subscriptionId);
  if (!mandate) return;
  const { mandate: refreshed } = await syncMandate(mandate);
  if (refreshed.status === 'active') {
    await pool.query("UPDATE bank_mandates SET status = 'failed' WHERE id = ? AND subscription_id = ?", [mandate.id, subscriptionId]);
  }
  await notifyUser(mandate.user_id, 'Auto-Pay Needs Attention ⚠️', SETUP_AGAIN_MESSAGE, { screen: 'Profile' });
};

// Cron fires in every server process; a debit must be raised by exactly one.
const withJobLock = async (fn) => {
  const conn = await pool.getConnection();
  try {
    const [[{ locked }]] = await conn.query('SELECT GET_LOCK(?, 0) AS locked', [JOB_LOCK]);
    if (Number(locked) !== 1) {
      console.log('[autoPay] Another process is already working through auto-debits — skipped.');
      return;
    }
    try {
      await fn();
    } finally {
      await conn.query('SELECT RELEASE_LOCK(?)', [JOB_LOCK]).catch(() => {});
    }
  } finally {
    conn.release();
  }
};

// Raises the debit for every EMI that falls due tomorrow and has an active
// mandate behind it. Idempotent — an EMI that already has an auto-debit on
// record is never raised again, so it is safe to run several times a day.
const raiseAutoDebits = () => withJobLock(async () => {
  const mode = autoPayMode();
  if (mode === 'unavailable') {
    console.error('⚠️  [autoPay] Cashfree keys are missing or placeholders in PRODUCTION — no EMI auto-debits can be raised. Fix CASHFREE_APP_ID / CASHFREE_SECRET_KEY.');
    return;
  }

  // A simulated debit settles on the spot, so in mock mode it runs on the due date itself.
  const dueDate = istDate(mode === 'mock' ? 0 : AUTO_DEBIT_LEAD_DAYS);
  // Only a loan's earliest unpaid EMI is debited: a settled payment is always
  // applied to the earliest one, and an overdue EMI also carries a penalty the
  // customer has to clear themselves.
  const [dueEmis] = await pool.query(
    `SELECT e.loan_id, e.installment_no, e.emi_amount, e.user_id,
            m.id AS mandate_id, m.subscription_id, m.payment_mode
       FROM emi_schedule e
       JOIN loans l ON l.id = e.loan_id AND l.status = 'disbursed'
       JOIN bank_mandates m ON m.user_id = e.user_id AND m.status = 'active'
      WHERE e.status = 'upcoming'
        AND e.due_date = ?
        AND NOT EXISTS (
          SELECT 1 FROM emi_schedule p
           WHERE p.loan_id = e.loan_id AND p.status IN ('upcoming', 'overdue') AND p.due_date < e.due_date
        )
        AND NOT EXISTS (SELECT 1 FROM transactions t WHERE ${AUTO_DEBIT_OF_EMI})
      ORDER BY e.id`,
    [dueDate]
  );
  console.log(`[autoPay] ${dueEmis.length} EMI(s) due ${dueDate} to auto-debit (${mode}).`);

  for (const emi of dueEmis) {
    try {
      const isMockMandate = emi.payment_mode === 'mock';
      if (isMockMandate !== (mode === 'mock')) {
        // Registered under the other mode — there is nothing real to debit.
        if (await retireMockMandate({ id: emi.mandate_id, payment_mode: emi.payment_mode, status: 'active' })) {
          await notifyUser(emi.user_id, 'Set Up Auto-Pay 🏦', SETUP_AGAIN_MESSAGE, { screen: 'Profile' });
        }
        continue;
      }

      const orderId = autoDebitOrderId(emi.loan_id, emi.installment_no);
      await pool.query(
        `INSERT INTO transactions (user_id, loan_id, razorpay_order_id, amount, type, status, description)
         VALUES (?, ?, ?, ?, 'emi', 'pending', ?)`,
        [emi.user_id, emi.loan_id, orderId, emi.emi_amount, `Automatic EMI payment (Installment #${emi.installment_no})`]
      );

      if (isMockMandate) {
        await recordChargeResult(orderId, {
          payment_status: 'SUCCESS',
          cf_payment_id: `pay_auto_mock_${crypto.randomBytes(6).toString('hex')}`,
        });
        continue;
      }

      await presentCharge({
        orderId,
        subscriptionId: emi.subscription_id,
        userId: emi.user_id,
        loanId: emi.loan_id,
        installmentNo: emi.installment_no,
        amount: emi.emi_amount,
        dueDate,
      });
    } catch (err) {
      console.error(`[autoPay] EMI #${emi.installment_no} of loan #${emi.loan_id}:`, err.message);
    }
  }
});

// Asks Cashfree about every auto-debit still pending and applies what it says.
const reconcileAutoDebits = () => withJobLock(async () => {
  if (autoPayMode() !== 'live') return;

  const [pending] = await pool.query(
    `SELECT t.razorpay_order_id AS order_id, t.razorpay_payment_id AS cf_payment_id,
            t.user_id, t.loan_id, t.amount,
            TIMESTAMPDIFF(MINUTE, t.created_at, NOW()) AS age_minutes,
            m.subscription_id, m.status AS mandate_status, m.payment_mode
       FROM transactions t
       LEFT JOIN bank_mandates m ON m.user_id = t.user_id
      WHERE t.type = 'emi' AND t.status = 'pending' AND t.razorpay_order_id LIKE 'auto\\_%'
      ORDER BY t.id`
  );

  for (const debit of pending) {
    try {
      const hasLiveMandate = debit.subscription_id && debit.payment_mode !== 'mock';
      const payment = hasLiveMandate
        ? await cashfreeSubscriptions.fetchPayment(debit.subscription_id, debit.order_id)
        : null;
      if (payment) {
        await recordChargeResult(debit.order_id, payment);
        continue;
      }

      if (debit.cf_payment_id) {
        // Cashfree took this debit on, but not under the mandate the customer
        // has now (they have since re-registered). Its webhook still settles
        // it; this only stops the wait going on for ever.
        if (debit.age_minutes > UNANSWERED_DEBIT_MINUTES) {
          await failAutoDebit(debit.order_id, 'Auto-debit result was never received');
        }
        continue;
      }

      // Cashfree has no such debit: the request never arrived.
      const installmentNo = installmentOfOrder(debit.order_id);
      const [[emi]] = await pool.query(
        'SELECT status, due_date FROM emi_schedule WHERE loan_id = ? AND installment_no = ?',
        [debit.loan_id, installmentNo]
      );
      const tomorrow = istDate(1);
      const stillInTime = emi?.status === 'upcoming'
        && (emi.due_date > tomorrow || (emi.due_date === tomorrow && istHour() < PRESENT_CUTOFF_HOUR_IST));

      if (hasLiveMandate && debit.mandate_status === 'active' && stillInTime) {
        await presentCharge({
          orderId: debit.order_id,
          subscriptionId: debit.subscription_id,
          userId: debit.user_id,
          loanId: debit.loan_id,
          installmentNo,
          amount: debit.amount,
          dueDate: emi.due_date,
        });
        continue;
      }

      // Too late to present (or nothing to present it against). A request made
      // moments ago may simply not be visible yet, so give it half an hour.
      if (debit.age_minutes < 30) continue;
      const closed = await failAutoDebit(debit.order_id, 'Auto-debit was not presented to the bank');
      // Only worth telling the customer about an EMI that is current and still unpaid.
      if (closed && emi && emi.status !== 'paid' && debit.age_minutes < 7 * 24 * 60) {
        await notifyDebitFailed(debit.order_id);
      }
    } catch (err) {
      console.error(`[autoPay] Reconciling ${debit.order_id}:`, err.response?.data || err.message);
    }
  }
});

// A bank can take up to a couple of days to confirm an eNACH mandate. Checks
// on the ones still waiting, so they go active (and the customer hears about
// it) even if the webhook never arrives and they don't tap "Verify Status".
const syncPendingMandates = async () => {
  if (autoPayMode() !== 'live') return;
  const [waiting] = await pool.query(
    `SELECT * FROM bank_mandates
      WHERE status = 'pending' AND (payment_mode IS NULL OR payment_mode <> 'mock')
        AND updated_at >= DATE_SUB(NOW(), INTERVAL ${PENDING_MANDATE_WATCH_DAYS} DAY)
      ORDER BY updated_at DESC LIMIT 200`
  );
  for (const mandate of waiting) {
    await syncMandate(mandate)
      .catch((err) => console.error(`[autoPay] Checking mandate ${mandate.subscription_id}:`, err.response?.data || err.message));
  }
};

// The customer has paid this loan's EMI another way. Withdraws any debit that
// is scheduled but not yet presented, so the same EMI isn't collected twice.
// If it is too late to withdraw and the debit goes through, it is settled like
// any other payment — against the loan's next unpaid EMI.
const cancelScheduledAutoDebits = async (loanId) => {
  if (autoPayMode() !== 'live') return;
  const [scheduled] = await pool.query(
    `SELECT t.razorpay_order_id AS order_id, m.subscription_id
       FROM transactions t
       JOIN bank_mandates m ON m.user_id = t.user_id
      WHERE t.loan_id = ? AND t.type = 'emi' AND t.status = 'pending' AND t.razorpay_order_id LIKE 'auto\\_%'`,
    [loanId]
  );
  for (const debit of scheduled) {
    try {
      await cashfreeSubscriptions.cancelPayment(debit.subscription_id, debit.order_id);
      await failAutoDebit(debit.order_id, 'Auto-debit cancelled — the EMI was paid another way');
    } catch (err) {
      console.error(`[autoPay] Could not withdraw scheduled debit ${debit.order_id}:`, err.response?.data || err.message);
    }
  }
};

// Refunds an EMI that Auto-Pay collected. The debit went through the
// customer's mandate as a Cashfree subscription payment, so that is where it
// is refunded — Cashfree's order refund API has never heard of it.
// Resolves to the refund id; throws if Cashfree does not take the refund.
const refundAutoDebit = async ({ userId, orderId, amount, note }) => {
  if (autoPayMode() !== 'live') throw new Error('Auto-Pay is not connected to Cashfree on this server');

  const [[mandate]] = await pool.query('SELECT subscription_id, payment_mode FROM bank_mandates WHERE user_id = ?', [userId]);
  if (!mandate || mandate.payment_mode === 'mock') {
    throw new Error('the customer no longer has the mandate this EMI was debited on — refund it from the Cashfree dashboard');
  }

  const refund = await cashfreeSubscriptions.refund({
    subscriptionId: mandate.subscription_id,
    paymentId: orderId,
    amount,
    note,
    paymentMode: mandate.payment_mode,
  });
  if (['FAILED', 'CANCEL', 'CANCELLED'].includes(String(refund.refund_status).toUpperCase())) {
    throw new Error(`Cashfree did not accept the refund (${refund.refund_status})`);
  }
  return refund.refund_id;
};

// ── Webhooks ──────────────────────────────────────────────────────────────────

// A verified SUBSCRIPTION_* webhook from Cashfree. Events only say that
// something changed; the state acted on is read back from Cashfree, which
// keeps this independent of the webhook payload version and of events
// arriving out of order.
const handleSubscriptionEvent = async (event) => {
  const data = event?.data || {};
  const subscriptionId = data.subscription_id || data.subscription_details?.subscription_id;

  if (data.payment_type === 'CHARGE' && isAutoDebitOrder(data.payment_id)) {
    const payment = subscriptionId
      ? await cashfreeSubscriptions.fetchPayment(subscriptionId, data.payment_id).catch(() => null)
      : null;
    await recordChargeResult(data.payment_id, payment || data);
    return;
  }

  // Authorisation results and status changes.
  const mandate = await findMandate(subscriptionId);
  if (mandate && mandate.payment_mode !== 'mock') await syncMandate(mandate);
};

module.exports = {
  AUTO_DEBIT_OF_EMI, AWAITING_AUTO_DEBIT, CHARGEABLE_AT_GATEWAY,
  isAutoDebitOrder, findMandate, syncMandate, retireMockMandate,
  raiseAutoDebits, reconcileAutoDebits, cancelScheduledAutoDebits, syncPendingMandates,
  refundAutoDebit, handleSubscriptionEvent,
};
