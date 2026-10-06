const crypto = require('crypto');
const { pool } = require('../config/db');
const { sendNotification } = require('../utils/fcm');
const { invalidateUserCache } = require('../config/redis');
const { auditLog } = require('../utils/audit');
const {
  GATEWAYS, GATEWAY_NAMES,
  isConfigured, describeGateway, isAuthError,
  getSelectedGateway, setSelectedGateway, pickGatewayForOrder, gatewayOfOrder,
  cashfree, razorpay, clients,
} = require('../utils/paymentGateway');
const { isAutoDebitOrder, cancelScheduledAutoDebits, refundAutoDebit } = require('../utils/autoPay');

const frontendUrl = (req) => req?.headers?.origin || process.env.FRONTEND_URL || 'https://ppokket.com';
// Public base URL of this API, for links a gateway sends the browser back to.
const apiUrl = (req) => process.env.API_PUBLIC_URL || `${req.protocol}://${req.get('host')}`;

// POST /api/payment/create-order
const createOrder = async (req, res) => {
  try {
    const { loan_id, investment_id, is_settlement } = req.body;
    const userId = req.user.id;

    if (!loan_id && !investment_id) {
      return res.status(400).json({ success: false, message: 'loan_id or investment_id required' });
    }

    let amountVal;
    let descriptionText;
    let paymentType;
    let refLoanId = null;
    let refInvestmentId = null;

    if (investment_id) {
      const [invRows] = await pool.query(
        'SELECT * FROM investments WHERE id = ? AND user_id = ?',
        [investment_id, userId]
      );
      if (!invRows.length) {
        return res.status(404).json({ success: false, message: 'Investment not found' });
      }
      const investment = invRows[0];
      if (investment.status !== 'pending') {
        return res.status(400).json({ success: false, message: `Investment status is ${investment.status}. Funding requires pending status.` });
      }
      amountVal = parseFloat(investment.principal_amount);
      descriptionText = `Investment funding — ${investment.tenure_months} months @ ${investment.interest_rate}%/month`;
      paymentType = 'investment';
      refInvestmentId = investment.id;
    } else {
      // Verify loan belongs to user
      const [loanRows] = await pool.query(
        'SELECT * FROM loans WHERE id = ? AND user_id = ?',
        [loan_id, userId]
      );
      if (!loanRows.length) {
        return res.status(404).json({ success: false, message: 'Loan not found' });
      }
      const loan = loanRows[0];

      if (loan.status !== 'disbursed') {
        return res.status(400).json({ success: false, message: `Loan status is ${loan.status}. Payment requires disbursed status.` });
      }

      if (is_settlement) {
        if (loan.settlement_amount === null || loan.settlement_amount === undefined) {
          return res.status(400).json({ success: false, message: 'No active settlement offer found for this loan.' });
        }
        amountVal = parseFloat(loan.settlement_amount);
        descriptionText = `Settlement payment for loan #${loan_id}`;
        paymentType = 'settlement';
      } else {
        // Charge amount is never trusted from the client — derive it from the
        // earliest unpaid/overdue EMI row, including any accrued late penalty,
        // the same row verifyPayment() will mark paid on success.
        const [emiRows] = await pool.query(
          `SELECT * FROM emi_schedule
            WHERE loan_id = ? AND status IN ('upcoming', 'overdue')
            ORDER BY due_date ASC LIMIT 1`,
          [loan_id]
        );
        if (!emiRows.length) {
          return res.status(400).json({ success: false, message: 'No pending EMI found for this loan.' });
        }
        const emi = emiRows[0];
        const penalty = emi.penalty_waived ? 0 : parseFloat(emi.penalty_amount || 0);
        amountVal = parseFloat(emi.emi_amount) + penalty;
        descriptionText = `EMI #${emi.installment_no} payment for loan #${loan_id}` + (penalty > 0 ? ` (incl. ₹${penalty.toFixed(2)} penalty)` : '');
        paymentType = 'emi';
      }
      refLoanId = loan_id;
    }

    const [userRow] = await pool.query('SELECT full_name, mobile, email FROM users WHERE id = ?', [userId]);
    const user = userRow[0] || {};
    const phone = user.mobile ? user.mobile.replace(/\D/g, '').slice(-10) : '';

    // Which gateway takes this payment: the admin's selection, narrowed to
    // what this client is able to open (see pickGatewayForOrder).
    const { gateway, clientCanUse } = await pickGatewayForOrder(req.body.supported_gateways);
    if (!clientCanUse) {
      return res.status(400).json({
        success: false,
        code: 'APP_UPDATE_REQUIRED',
        message: 'Please update the app to the latest version to make payments.',
      });
    }

    const isProduction = process.env.NODE_ENV === 'production';
    const gatewayReady = isConfigured(gateway);
    if (isProduction && !gatewayReady) {
      return res.status(500).json({ success: false, message: 'Payment gateway is not configured. Please contact support.' });
    }

    const reference = refLoanId ? refLoanId : 'inv' + refInvestmentId;
    const returnTab = refInvestmentId ? 'Investments' : 'My+Loans';
    let orderId = null;
    let orderGateway = 'mock';
    let checkout = {};

    if (gatewayReady) {
      try {
        const created = gateway === 'razorpay'
          ? await razorpay.createOrder({
            reference,
            amount: amountVal,
            notes: {
              user_id: String(userId),
              purpose: paymentType,
              ...(refLoanId ? { loan_id: String(refLoanId) } : { investment_id: String(refInvestmentId) }),
            },
          })
          : await cashfree.createOrder({
            reference,
            amount: amountVal,
            customer: { id: userId, email: user.email, phone, name: user.full_name },
            returnUrl: `${frontendUrl(req)}/profile?tab=${returnTab}&order_id={order_id}`,
          });
        orderId = created.orderId;
        checkout = created.checkout;
        orderGateway = gateway;
      } catch (err) {
        console.error(`${GATEWAY_NAMES[gateway]} order creation failed:`, err.response?.data || err.message);
        // Fail closed in production: a transient gateway error must never
        // silently downgrade to a mock order that later auto-verifies as paid.
        if (isProduction) {
          return res.status(502).json({ success: false, message: 'Payment gateway is temporarily unavailable. Please try again shortly.' });
        }
        console.warn('Falling back to mock order (non-production only).');
      }
    }

    if (orderGateway === 'mock') {
      orderId = `order_mock_${crypto.randomBytes(8).toString('hex')}`;
    }

    // Save pending transaction
    await pool.query(
      `INSERT INTO transactions (user_id, loan_id, investment_id, razorpay_order_id, amount, type, status, description)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
      [userId, refLoanId, refInvestmentId, orderId, amountVal, paymentType, descriptionText]
    );

    res.json({
      success: true,
      order_id: orderId,
      gateway: orderGateway, // 'cashfree' | 'razorpay' | 'mock' — tells the client which checkout to open
      amount: amountVal,
      currency: 'INR',
      is_mock: orderGateway === 'mock',
      // Cashfree checkout
      payment_session_id: checkout.payment_session_id || null,
      cashfree_env: process.env.CASHFREE_ENV === 'production' ? 'production' : 'sandbox',
      // Razorpay checkout
      razorpay: orderGateway === 'razorpay' ? {
        key_id: checkout.key_id,
        amount_paise: checkout.amount_paise,
        name: 'Ppokket',
        description: descriptionText,
        prefill: { name: user.full_name || '', email: user.email || '', contact: phone },
        // Redirect-mode return address, for clients (the app's WebView) that
        // can't rely on checkout's in-page success handler.
        callback_url: `${apiUrl(req)}/api/payment/razorpay/callback?order_id=${orderId}`,
      } : null,
    });
  } catch (err) {
    console.error('[createOrder]', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// A loan has just closed. Its Auto-Pay mandate is parked ('inactive', reusable
// for the next loan) — unless the customer has another loan still running,
// whose EMIs are debited through the same mandate.
const parkMandateIfNoLoans = (conn, userId) => conn.query(
  `UPDATE bank_mandates m
      SET m.status = 'inactive'
    WHERE m.user_id = ? AND m.status = 'active'
      AND NOT EXISTS (
        SELECT 1 FROM loans l
         WHERE l.user_id = m.user_id
           AND l.status IN ('disbursed', 'approved', 'withdrawal_requested')
      )`,
  [userId]
);

// Applies a confirmed-paid transaction to whatever it was paying for. Shared
// by every path that can report a payment (verify, webhooks, Razorpay
// callback) so they all settle it identically. The caller owns the DB
// transaction and holds a FOR UPDATE lock on the transactions row; the loan /
// investment is always taken from that row, never from the request.
const applySuccessfulPayment = async (conn, txn, paymentId, signature = null) => {
  const userId = txn.user_id;
  const loanId = txn.loan_id;
  const paidAmount = txn.amount;

  await conn.query(
    `UPDATE transactions SET
       razorpay_payment_id = ?,
       razorpay_signature = COALESCE(?, razorpay_signature),
       status = 'success'
     WHERE id = ?`,
    [paymentId, signature, txn.id]
  );

  const notify = (title, message) => conn.query(
    'INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, ?)',
    [userId, title, message, 'payment']
  );

  if (txn.investment_id) {
    // Investment funding — activate the investment. 'cancelled' is accepted
    // too: the money has arrived, so an attempt the user cancelled while the
    // payment was still in flight is honoured.
    const [activated] = await conn.query(
      `UPDATE investments SET status = 'active', start_date = CURDATE(),
         maturity_date = DATE_ADD(CURDATE(), INTERVAL tenure_months MONTH)
       WHERE id = ? AND status IN ('pending', 'cancelled')`,
      [txn.investment_id]
    );
    if (activated.affectedRows !== 1) {
      // Already funded by an earlier order — this is a second payment for the
      // same investment. Keep the money trail and flag it for a refund rather
      // than announcing an activation that didn't happen.
      await conn.query(
        "UPDATE transactions SET description = CONCAT('[REFUND DUE - duplicate payment] ', COALESCE(description, '')) WHERE id = ?",
        [txn.id]
      );
      await notify('Duplicate Payment Received', `We received an extra payment of ₹${paidAmount} for an investment that was already funded. Our team will refund it to your original payment method. Payment ID: ${paymentId}`);
      console.error(`[payment] Duplicate investment payment — refund due. txn #${txn.id}, investment #${txn.investment_id}, order ${txn.razorpay_order_id}`);
      return { kind: 'investment_duplicate', userId, paidAmount };
    }

    await notify('Investment Active 🎉', `Your investment of ₹${paidAmount} is now active. Payment ID: ${paymentId}`);
    return { kind: 'investment', userId, paidAmount };
  }

  if (txn.type === 'settlement') {
    // Settle the loan: mark the loan as fully paid and status = 'closed'
    await conn.query(
      `UPDATE loans SET amount_paid = amount_paid + ?, status = 'closed' WHERE id = ?`,
      [paidAmount, loanId]
    );
    // Deactivate mandate on loan close
    await parkMandateIfNoLoans(conn, userId);
    // Mark all upcoming or overdue EMIs as paid (settled)
    await conn.query(
      `UPDATE emi_schedule SET status = 'paid', paid_amount = emi_amount, paid_at = NOW()
       WHERE loan_id = ? AND status IN ('upcoming', 'overdue')`,
      [loanId]
    );

    await notify('Loan Settled Successfully 🎉', `Your loan #${loanId} has been settled and closed successfully. Thank you!`);
    return { kind: 'settlement', userId, paidAmount };
  }

  // Normal EMI payment
  await conn.query(
    `UPDATE loans SET amount_paid = amount_paid + ? WHERE id = ?`,
    [paidAmount, loanId]
  );

  // Mark the earliest unpaid EMI as paid — the same row createOrder charged for
  await conn.query(
    `UPDATE emi_schedule SET status = 'paid', paid_amount = ?, paid_at = NOW()
     WHERE loan_id = ? AND status IN ('upcoming', 'overdue') ORDER BY due_date ASC LIMIT 1`,
    [paidAmount, loanId]
  );

  // Check if loan fully closed — count remaining unpaid/non-waived EMIs
  const [[{ remaining }]] = await conn.query(
    `SELECT COUNT(*) AS remaining FROM emi_schedule
      WHERE loan_id = ? AND status NOT IN ('paid', 'waived')`,
    [loanId]
  );
  if (remaining === 0) {
    await conn.query("UPDATE loans SET status = 'closed' WHERE id = ?", [loanId]);
    await parkMandateIfNoLoans(conn, userId);
  }

  await notify('Payment Successful ✅', `Your EMI payment of ₹${paidAmount} has been received. Payment ID: ${paymentId}`);
  return { kind: 'emi', userId, paidAmount };
};

// Push sent once, by whichever path actually settled the payment.
const pushPaymentResult = async ({ kind, userId, paidAmount }) => {
  const [user] = await pool.query('SELECT fcm_token FROM users WHERE id = ?', [userId]);
  const token = user[0]?.fcm_token;
  if (!token) return;

  const loanScreen = { screen: 'Profile', params: { screen: 'LoanHistory' } };
  if (kind === 'investment') {
    sendNotification(token, 'Investment Active 🎉', `Your investment of ₹${paidAmount} is now active.`, { screen: 'Investment' }).catch(() => {});
  } else if (kind === 'settlement') {
    sendNotification(token, 'Loan Settled Successfully 🎉', `Your settlement payment of ₹${paidAmount} has been received and your loan is closed.`, loanScreen).catch(() => {});
  } else if (kind === 'emi') {
    sendNotification(token, 'Payment Successful ✅', `Your EMI payment of ₹${paidAmount} has been received.`, loanScreen).catch(() => {});
  }
};

// Records an order the gateway has confirmed as paid — exactly once, however
// many of verify / webhook / callback report it. `userId` limits the lookup to
// that user's own order (the authenticated verify path).
// Resolves to { status: 'not_found' | 'already' | 'settled', txn, result }.
const settlePaidOrder = async (orderId, paymentId, { userId = null, signature = null } = {}) => {
  const conn = await pool.getConnection();
  let txn;
  let result;
  try {
    await conn.beginTransaction();

    // Get transaction with a row-level lock
    const [rows] = await conn.query(
      `SELECT * FROM transactions WHERE razorpay_order_id = ?${userId ? ' AND user_id = ?' : ''} ORDER BY id ASC LIMIT 1 FOR UPDATE`,
      userId ? [orderId, userId] : [orderId]
    );
    if (!rows.length) {
      await conn.rollback();
      return { status: 'not_found' };
    }
    txn = rows[0];
    if (txn.status === 'success') {
      await conn.rollback();
      return { status: 'already', txn };
    }

    result = await applySuccessfulPayment(conn, txn, paymentId, signature);
    await conn.commit();
  } catch (err) {
    try { await conn.rollback(); } catch (_) { }
    throw err;
  } finally {
    conn.release();
  }

  // Bust dashboard + user cache so Home/PayEMI show fresh data immediately
  await invalidateUserCache(result.userId).catch(() => {});
  await pushPaymentResult(result).catch(() => {});

  // An EMI the customer has just paid themselves may also have an auto-debit
  // scheduled at the bank — withdraw it so the EMI isn't collected twice.
  if (txn.loan_id && ['emi', 'settlement'].includes(result.kind) && !isAutoDebitOrder(orderId)) {
    await cancelScheduledAutoDebits(txn.loan_id)
      .catch((err) => console.error('[settlePaidOrder] cancelScheduledAutoDebits:', err.message));
  }

  return { status: 'settled', txn, result };
};

// POST /api/payment/verify
const verifyPayment = async (req, res) => {
  try {
    const orderId = req.body.razorpay_order_id;
    const userId = req.user.id;

    if (!orderId || typeof orderId !== 'string') {
      return res.status(400).json({ success: false, message: 'razorpay_order_id required' });
    }

    // Always the gateway the order was created on — not whichever one is
    // selected now — so a switch never strands a payment that is in flight.
    const gateway = gatewayOfOrder(orderId);
    let paymentId = '';
    let isPaid = false;

    if (gateway === 'mock') {
      if (process.env.NODE_ENV === 'production') {
        // Mock orders should never exist in production (createOrder refuses to
        // mint them there), but never trust one as paid if it somehow shows up.
        console.error(`[verifyPayment] Rejected mock order verification in production: ${orderId}`);
        return res.status(400).json({ success: false, message: 'Payment verification failed: Invalid order' });
      }
      isPaid = true;
      paymentId = `pay_mock_${Date.now()}`;
    } else {
      // Razorpay checkout hands the client a signed receipt. When one is sent
      // it must be genuine; the gateway lookup below is still what decides.
      const { razorpay_payment_id: clientPaymentId, razorpay_signature: clientSignature } = req.body;
      if (gateway === 'razorpay' && clientPaymentId && clientSignature
        && !razorpay.verifySignature(orderId, clientPaymentId, clientSignature)) {
        console.error(`[verifyPayment] Razorpay signature mismatch for ${orderId}`);
        return res.status(400).json({ success: false, message: 'Payment verification failed: Invalid signature' });
      }

      try {
        const status = await clients[gateway].fetchPayment(orderId);
        isPaid = status.paid;
        if (status.paid) paymentId = status.paymentId;
      } catch (err) {
        console.error(`${GATEWAY_NAMES[gateway]} order verify failed:`, err.response?.data || err.message);
      }
    }

    if (!isPaid) {
      return res.status(400).json({ success: false, message: 'Payment verification failed: Order not paid' });
    }

    const outcome = await settlePaidOrder(orderId, paymentId, { userId });

    if (outcome.status === 'not_found') {
      return res.status(404).json({ success: false, message: 'Transaction not found' });
    }

    // Skip processing if already marked success
    if (outcome.status === 'already') {
      return res.json({
        success: true,
        message: 'Payment already processed successfully',
        payment_id: outcome.txn.razorpay_payment_id || paymentId,
      });
    }

    const isDuplicate = outcome.result.kind === 'investment_duplicate';
    res.json({
      success: true,
      message: isDuplicate
        ? 'This investment was already funded — your extra payment will be refunded.'
        : 'Payment verified successfully',
      payment_id: paymentId,
      duplicate: isDuplicate,
    });
  } catch (err) {
    console.error('[verifyPayment]', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/payment/history
const getPaymentHistory = async (req, res) => {
  try {
    const [transactions] = await pool.query(
      `SELECT t.*, l.amount as loan_amount FROM transactions t
       LEFT JOIN loans l ON l.id = t.loan_id
       WHERE t.user_id = ?
       ORDER BY t.created_at DESC`,
      [req.user.id]
    );
    res.json({ success: true, transactions });
  } catch (err) {
    console.error('[getPaymentHistory]', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/payment/webhook
// Cashfree PG webhook (API version 2023-08-01): signed with
// base64(HMAC-SHA256(timestamp + rawBody, CASHFREE_SECRET_KEY)) in the
// `x-webhook-signature` header, alongside `x-webhook-timestamp`.
// Docs: https://www.cashfree.com/docs/api-reference/payments/latest/webhooks
const handleWebhook = async (req, res) => {
  try {
    const signature = req.headers['x-webhook-signature'];
    const timestamp = req.headers['x-webhook-timestamp'];
    const webhookSecret = process.env.CASHFREE_SECRET_KEY;

    if (!webhookSecret) {
      console.error('[handleWebhook] CASHFREE_SECRET_KEY not configured — rejecting webhook.');
      return res.status(500).json({ success: false, message: 'Webhook not configured' });
    }
    if (!signature || !timestamp) {
      return res.status(400).json({ success: false, message: 'Missing webhook signature headers' });
    }

    if (!cashfree.verifyWebhookSignature(req.rawBody || JSON.stringify(req.body), timestamp, signature)) {
      console.error('[handleWebhook] Invalid Cashfree webhook signature');
      return res.status(400).json({ success: false, message: 'Invalid webhook signature' });
    }

    // Acknowledge receipt immediately to Cashfree
    res.json({ status: 'ok' });

    if (req.body.type !== 'PAYMENT_SUCCESS_WEBHOOK') return;

    const order = req.body.data?.order;
    const payment = req.body.data?.payment;
    if (!order || !payment || payment.payment_status !== 'SUCCESS') return;

    const orderId = order.order_id; // stored in transactions.razorpay_order_id — the column name predates Cashfree
    if (gatewayOfOrder(orderId) === 'mock' && process.env.NODE_ENV === 'production') {
      console.error(`[handleWebhook] Rejected mock order in production webhook: ${orderId}`);
      return;
    }

    // Same settlement path as verifyPayment: investments, settlements and
    // overdue EMIs are all handled identically whichever arrives first.
    await settlePaidOrder(orderId, String(payment.cf_payment_id), { signature });
  } catch (err) {
    console.error('❌ Webhook error:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ success: false, message: err.message });
    }
  }
};

// POST /api/payment/webhook/razorpay
// Razorpay webhook: signed with hex(HMAC-SHA256(rawBody, RAZORPAY_WEBHOOK_SECRET))
// in the `X-Razorpay-Signature` header. Subscribe it to `payment.captured`
// (and/or `order.paid`) on the Razorpay dashboard.
// Docs: https://razorpay.com/docs/webhooks/validate-test/
const handleRazorpayWebhook = async (req, res) => {
  try {
    const signature = req.headers['x-razorpay-signature'];

    if (!process.env.RAZORPAY_WEBHOOK_SECRET) {
      console.error('[handleRazorpayWebhook] RAZORPAY_WEBHOOK_SECRET not configured — rejecting webhook.');
      return res.status(500).json({ success: false, message: 'Webhook not configured' });
    }
    if (!signature) {
      return res.status(400).json({ success: false, message: 'Missing webhook signature header' });
    }
    if (!razorpay.verifyWebhookSignature(req.rawBody || JSON.stringify(req.body), signature)) {
      console.error('[handleRazorpayWebhook] Invalid Razorpay webhook signature');
      return res.status(400).json({ success: false, message: 'Invalid webhook signature' });
    }

    // Acknowledge receipt immediately to Razorpay
    res.json({ status: 'ok' });

    if (!['payment.captured', 'order.paid'].includes(req.body.event)) return;

    const payment = req.body.payload?.payment?.entity;
    if (!payment?.order_id || payment.status !== 'captured') return;

    await settlePaidOrder(payment.order_id, payment.id, { signature });
  } catch (err) {
    console.error('❌ Razorpay webhook error:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ success: false, message: err.message });
    }
  }
};

// POST /api/payment/razorpay/callback?order_id=…
// Where Razorpay checkout sends the browser after a redirect-mode payment —
// the app's WebView flow, where checkout's in-page success handler can't be
// relied on. This is an unauthenticated form POST, so nothing in it is taken
// on trust: the payment is settled only if Razorpay itself reports the order
// paid. The browser is then sent on to the same return page a Cashfree
// payment ends at, which is the URL the app is watching for.
const handleRazorpayCallback = async (req, res) => {
  const frontend = process.env.FRONTEND_URL || 'https://ppokket.com';
  const orderId = String(req.query.order_id || req.body?.razorpay_order_id || '');
  if (gatewayOfOrder(orderId) !== 'razorpay') {
    return res.redirect(303, `${frontend}/profile`);
  }

  let returnTab = 'My+Loans';
  try {
    const [txn] = await pool.query(
      'SELECT investment_id FROM transactions WHERE razorpay_order_id = ? ORDER BY id ASC LIMIT 1',
      [orderId]
    );
    if (txn[0]?.investment_id) returnTab = 'Investments';

    if (txn.length) {
      const status = await razorpay.fetchPayment(orderId);
      if (status.paid) {
        const { razorpay_payment_id: paymentId, razorpay_signature: signature } = req.body || {};
        const signed = paymentId && signature && razorpay.verifySignature(orderId, paymentId, signature);
        await settlePaidOrder(orderId, status.paymentId, { signature: signed ? signature : null });
      }
    }
  } catch (err) {
    // The client verifies again when it lands on the return page, and the
    // webhook covers the rest — never leave the user stranded on an API error.
    console.error('[handleRazorpayCallback]', err.response?.data || err.message);
  }

  res.redirect(303, `${frontend}/profile?tab=${returnTab}&order_id=${encodeURIComponent(orderId)}`);
};

// POST /api/payment/refund  (admin only)
const initiateRefund = async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const { transaction_id, reason } = req.body;
    if (!transaction_id) {
      conn.release();
      return res.status(400).json({ success: false, message: 'transaction_id required' });
    }

    const [txn] = await conn.query('SELECT * FROM transactions WHERE id = ? FOR UPDATE', [transaction_id]);
    if (!txn.length) {
      conn.release();
      return res.status(404).json({ success: false, message: 'Transaction not found' });
    }
    if (txn[0].status !== 'success') {
      conn.release();
      return res.status(400).json({ success: false, message: 'Only successful transactions can be refunded' });
    }
    if (txn[0].type === 'refund') {
      conn.release();
      return res.status(400).json({ success: false, message: 'Transaction is already a refund' });
    }

    const orderId = txn[0].razorpay_order_id;
    const payment_id = txn[0].razorpay_payment_id;
    const refundAmount = txn[0].amount;
    const note = reason || 'Admin initiated refund';

    // The refund has to go back through the gateway that took the payment,
    // whichever one is selected today.
    const gateway = gatewayOfOrder(orderId || '');
    // An EMI collected by Auto-Pay isn't an order at all: it was debited
    // through the customer's mandate, and is refunded through it.
    const isAutoDebit = isAutoDebitOrder(orderId);
    const isMock = gateway === 'mock' || (payment_id && /^pay_(auto_)?mock/.test(payment_id));

    let refund;
    if (!isMock && (isAutoDebit || isConfigured(gateway))) {
      try {
        let refundId;
        if (isAutoDebit) {
          refundId = await refundAutoDebit({ userId: txn[0].user_id, orderId, amount: refundAmount, note });
        } else if (gateway === 'razorpay') {
          refundId = await razorpay.refund({ paymentId: payment_id, amount: refundAmount, note });
        } else {
          refundId = await cashfree.refund({ orderId, amount: refundAmount, note });
        }
        refund = { id: refundId };
      } catch (err) {
        console.error(`${GATEWAY_NAMES[gateway]} refund failed:`, err.response?.data || err.message);
        conn.release();
        return res.status(500).json({
          success: false,
          message: `${GATEWAY_NAMES[gateway]} refund failed: ${err.response?.data?.error?.description || err.response?.data?.message || err.message}`
        });
      }
    } else {
      refund = { id: `rfnd_mock_${crypto.randomBytes(6).toString('hex')}` };
    }

    await conn.beginTransaction();

    await conn.query(
      `INSERT INTO transactions (user_id, loan_id, razorpay_order_id, razorpay_payment_id, amount, type, status, description)
       VALUES (?, ?, ?, ?, ?, 'refund', 'success', ?)`,
      [txn[0].user_id, txn[0].loan_id, txn[0].razorpay_order_id, refund.id, refundAmount,
      `Refund for payment ${payment_id} — ${reason || 'Admin refund'}`]
    );

    // Reverse EMI mark if applicable
    if (txn[0].type === 'emi' && txn[0].loan_id) {
      await conn.query(
        `UPDATE emi_schedule SET status = 'upcoming', paid_amount = 0, paid_at = NULL
         WHERE loan_id = ? AND status = 'paid' ORDER BY due_date DESC LIMIT 1`,
        [txn[0].loan_id]
      );
      await conn.query(
        `UPDATE loans SET amount_paid = GREATEST(0, amount_paid - ?), status = 'disbursed'
         WHERE id = ? AND status = 'closed'`,
        [refundAmount, txn[0].loan_id]
      );
      await conn.query(
        `UPDATE loans SET amount_paid = GREATEST(0, amount_paid - ?) WHERE id = ? AND status != 'closed'`,
        [refundAmount, txn[0].loan_id]
      );
    }

    await conn.query(
      'INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, ?)',
      [txn[0].user_id, 'Refund Initiated 💸',
      `A refund of ₹${refundAmount} has been initiated. Refund ID: ${refund.id}. It will reflect in 5–7 business days.`,
        'payment']
    );

    await conn.commit();
    conn.release();

    res.json({ success: true, message: 'Refund initiated successfully', refund_id: refund.id, amount: refundAmount });
  } catch (err) {
    try { await conn.rollback(); } catch (_) { }
    conn.release();
    console.error('[initiateRefund]', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/payment/cancel
const cancelPayment = async (req, res) => {
  try {
    const { razorpay_order_id } = req.body;
    const userId = req.user.id;

    if (!razorpay_order_id) {
      return res.status(400).json({ success: false, message: 'razorpay_order_id required' });
    }

    await pool.query(
      "UPDATE transactions SET status = 'failed' WHERE razorpay_order_id = ? AND user_id = ? AND status = 'pending'",
      [razorpay_order_id, userId]
    );

    res.json({ success: true, message: 'Payment marked as failed/cancelled' });
  } catch (err) {
    console.error('[cancelPayment]', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─────────────────────────────────────────────
// ADMIN — which gateway collects payments
// ─────────────────────────────────────────────

// GET /api/admin/payment-gateway
const getGatewayConfig = async (req, res) => {
  try {
    res.json({
      success: true,
      active: await getSelectedGateway(),
      gateways: GATEWAYS.map(describeGateway),
    });
  } catch (err) {
    console.error('[getGatewayConfig]', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// PUT /api/admin/payment-gateway   { gateway: 'cashfree' | 'razorpay' }
// Switching is refused unless the target gateway's keys are present and the
// gateway accepts them — otherwise the switch would take payments down.
const setGateway = async (req, res) => {
  try {
    const { gateway } = req.body;
    if (!GATEWAYS.includes(gateway)) {
      return res.status(400).json({ success: false, message: `gateway must be one of: ${GATEWAYS.join(', ')}` });
    }
    const name = GATEWAY_NAMES[gateway];

    if (!isConfigured(gateway)) {
      return res.status(400).json({
        success: false,
        message: `${name} API keys are not set on the server. Add them to the backend environment and restart it before switching.`,
      });
    }

    try {
      await clients[gateway].checkCredentials();
    } catch (err) {
      console.error(`[setGateway] ${name} key check failed:`, err.response?.data || err.message);
      return isAuthError(err)
        ? res.status(400).json({ success: false, message: `${name} rejected the API keys configured on the server. Check them and try again.` })
        : res.status(502).json({ success: false, message: `Could not reach ${name} to confirm its keys. Nothing was changed — please try again.` });
    }

    const previous = await getSelectedGateway();
    await setSelectedGateway(gateway);
    await auditLog({ req, action: 'payment_gateway_changed', entityType: 'setting', details: { from: previous, to: gateway } });

    res.json({
      success: true,
      message: `Payments will now be collected through ${name}.`,
      active: gateway,
      gateways: GATEWAYS.map(describeGateway),
    });
  } catch (err) {
    console.error('[setGateway]', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

module.exports = {
  createOrder, verifyPayment, getPaymentHistory, cancelPayment, initiateRefund,
  handleWebhook, handleRazorpayWebhook, handleRazorpayCallback,
  getGatewayConfig, setGateway,
  settlePaidOrder,
};
