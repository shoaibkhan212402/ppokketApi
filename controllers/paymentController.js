const crypto = require('crypto');
const axios = require('axios');
const { pool } = require('../config/db');
const { sendNotification } = require('../utils/fcm');
const { invalidateUserCache } = require('../config/redis');

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

    let orderId = `order_${refLoanId ? refLoanId : 'inv' + refInvestmentId}_${Date.now()}`;
    let paymentSessionId = null;
    let cfEnv = process.env.CASHFREE_ENV === 'production' ? 'production' : 'sandbox';
    let isMock = true;
    const isProduction = process.env.NODE_ENV === 'production';
    const cashfreeConfigured = process.env.CASHFREE_APP_ID && !process.env.CASHFREE_APP_ID.includes('placeholder');

    if (isProduction && !cashfreeConfigured) {
      return res.status(500).json({ success: false, message: 'Payment gateway is not configured. Please contact support.' });
    }

    if (cashfreeConfigured) {
      const url = cfEnv === 'production' ? 'https://api.cashfree.com/pg/orders' : 'https://sandbox.cashfree.com/pg/orders';
      try {
        const response = await axios.post(url, {
          order_id: orderId,
          order_amount: parseFloat(amountVal),
          order_currency: 'INR',
          customer_details: {
            customer_id: String(userId),
            customer_email: user.email || 'customer@ppokket.com',
            customer_phone: user.mobile ? user.mobile.replace(/\D/g, '').slice(-10) : '9999999999',
            customer_name: user.full_name || 'Customer'
          },
          order_meta: {
            return_url: refInvestmentId
              ? `${req.headers.origin || process.env.FRONTEND_URL || 'https://ppokket.com'}/profile?tab=Investments&order_id={order_id}`
              : `${req.headers.origin || process.env.FRONTEND_URL || 'https://ppokket.com'}/profile?tab=My+Loans&order_id={order_id}`
          }
        }, {
          headers: {
            'x-client-id': process.env.CASHFREE_APP_ID,
            'x-client-secret': process.env.CASHFREE_SECRET_KEY,
            'x-api-version': '2023-08-01',
            'Content-Type': 'application/json'
          }
        });

        if (response.data && response.data.payment_session_id) {
          paymentSessionId = response.data.payment_session_id;
          orderId = response.data.order_id;
          isMock = false;
        }
      } catch (err) {
        console.error('Cashfree PG order creation failed:', err.response?.data || err.message);
        // Fail closed in production: a transient gateway error must never
        // silently downgrade to a mock order that later auto-verifies as paid.
        if (isProduction) {
          return res.status(502).json({ success: false, message: 'Payment gateway is temporarily unavailable. Please try again shortly.' });
        }
        console.warn('Falling back to mock order (non-production only).');
      }
    }

    if (isMock) {
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
      payment_session_id: paymentSessionId,
      amount: amountVal,
      currency: 'INR',
      cashfree_env: cfEnv,
      is_mock: isMock
    });
  } catch (err) {
    console.error('[createOrder]', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/payment/verify
const verifyPayment = async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const { razorpay_order_id, loan_id } = req.body;
    const orderId = razorpay_order_id;
    const userId = req.user.id;

    let isMock = orderId.startsWith('order_mock');
    let paymentId = isMock ? `pay_mock_${Date.now()}` : '';
    let isPaid = false;

    if (isMock && process.env.NODE_ENV === 'production') {
      // Mock orders should never exist in production (createOrder refuses to
      // mint them there), but never trust one as paid if it somehow shows up.
      console.error(`[verifyPayment] Rejected mock order verification in production: ${orderId}`);
      conn.release();
      return res.status(400).json({ success: false, message: 'Payment verification failed: Invalid order' });
    }

    if (isMock) {
      isPaid = true;
    } else {
      const cfEnv = process.env.CASHFREE_ENV === 'production' ? 'production' : 'sandbox';
      const url = cfEnv === 'production'
        ? `https://api.cashfree.com/pg/orders/${orderId}`
        : `https://sandbox.cashfree.com/pg/orders/${orderId}`;

      try {
        const response = await axios.get(url, {
          headers: {
            'x-client-id': process.env.CASHFREE_APP_ID,
            'x-client-secret': process.env.CASHFREE_SECRET_KEY,
            'x-api-version': '2023-08-01'
          }
        });
        if (response.data && response.data.order_status === 'PAID') {
          isPaid = true;
          paymentId = response.data.cf_order_id || `cf_${orderId}`;
        }
      } catch (err) {
        console.error('Cashfree order verify failed:', err.response?.data || err.message);
      }
    }

    if (!isPaid) {
      conn.release();
      return res.status(400).json({ success: false, message: 'Payment verification failed: Order not paid' });
    }

    await conn.beginTransaction();

    // Get transaction with a row-level lock
    const [txn] = await conn.query(
      'SELECT * FROM transactions WHERE razorpay_order_id = ? AND user_id = ? FOR UPDATE',
      [orderId, userId]
    );

    if (!txn.length) {
      await conn.rollback();
      conn.release();
      return res.status(404).json({ success: false, message: 'Transaction not found' });
    }

    // Skip processing if already marked success
    if (txn[0].status === 'success') {
      await conn.commit();
      conn.release();
      return res.json({
        success: true,
        message: 'Payment already processed successfully',
        payment_id: txn[0].razorpay_payment_id || paymentId,
      });
    }

    // Update transaction
    await conn.query(
      `UPDATE transactions SET
        razorpay_payment_id = ?,
        status = 'success'
       WHERE razorpay_order_id = ?`,
      [paymentId, orderId]
    );

    // Update loan amount_paid
    const paidAmount = txn[0].amount;

    if (txn[0].investment_id) {
      // Investment funding — activate the investment
      await conn.query(
        `UPDATE investments SET status = 'active', start_date = CURDATE(),
           maturity_date = DATE_ADD(CURDATE(), INTERVAL tenure_months MONTH)
         WHERE id = ? AND status = 'pending'`,
        [txn[0].investment_id]
      );

      await conn.query(
        'INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, ?)',
        [userId, 'Investment Active 🎉', `Your investment of ₹${paidAmount} is now active. Payment ID: ${paymentId}`, 'payment']
      );
    } else if (txn[0].type === 'settlement') {
      // Settle the loan: mark the loan as fully paid and status = 'closed'
      await conn.query(
        `UPDATE loans SET amount_paid = amount_paid + ?, status = 'closed' WHERE id = ?`,
        [paidAmount, loan_id]
      );
      // Deactivate mandate on loan close
      await conn.query("UPDATE bank_mandates SET status = 'inactive' WHERE user_id = ?", [userId]);
      // Mark all upcoming or overdue EMIs as paid (settled)
      await conn.query(
        `UPDATE emi_schedule SET status = 'paid', paid_amount = emi_amount, paid_at = NOW()
         WHERE loan_id = ? AND status IN ('upcoming', 'overdue')`,
        [loan_id]
      );
      
      // Notification
      await conn.query(
        'INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, ?)',
        [userId, 'Loan Settled Successfully 🎉', `Your loan #${loan_id} has been settled and closed successfully. Thank you!`, 'payment']
      );
    } else {
      // Normal EMI payment
      await conn.query(
        `UPDATE loans SET amount_paid = amount_paid + ? WHERE id = ?`,
        [paidAmount, loan_id]
      );

      // Mark EMI as paid
      await conn.query(
        `UPDATE emi_schedule SET status = 'paid', paid_amount = ?, paid_at = NOW()
         WHERE loan_id = ? AND status IN ('upcoming', 'overdue') ORDER BY due_date ASC LIMIT 1`,
        [paidAmount, loan_id]
      );

      // Check if loan fully closed — count remaining unpaid/non-waived EMIs
      const [[{ remaining }]] = await conn.query(
        `SELECT COUNT(*) AS remaining FROM emi_schedule
          WHERE loan_id = ? AND status NOT IN ('paid', 'waived')`,
        [loan_id]
      );
      if (remaining === 0) {
        await conn.query("UPDATE loans SET status = 'closed' WHERE id = ?", [loan_id]);
        await conn.query("UPDATE bank_mandates SET status = 'inactive' WHERE user_id = ?", [userId]);
      }
      
      // Notification
      await conn.query(
        'INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, ?)',
        [userId, 'Payment Successful ✅', `Your EMI payment of ₹${paidAmount} has been received. Payment ID: ${paymentId}`, 'payment']
      );
    }

    await conn.commit();
    conn.release();

    // Bust dashboard + user cache so Home/PayEMI show fresh data immediately
    await invalidateUserCache(userId).catch(() => {});

    const [user] = await pool.query('SELECT fcm_token FROM users WHERE id = ?', [userId]);
    if (user[0]?.fcm_token) {
      if (txn[0].investment_id) {
        sendNotification(user[0].fcm_token, 'Investment Active 🎉', `Your investment of ₹${paidAmount} is now active.`, { screen: 'Investment' }).catch(() => {});
      } else {
        sendNotification(user[0].fcm_token, 'Payment Successful ✅', `Your EMI payment of ₹${paidAmount} has been received.`, { screen: 'Profile', params: { screen: 'LoanHistory' } }).catch(() => {});
      }
    }

    res.json({
      success: true,
      message: 'Payment verified successfully',
      payment_id: paymentId,
    });
  } catch (err) {
    try {
      await conn.rollback();
    } catch (_) { }
    conn.release();
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

    const expectedSignature = crypto
      .createHmac('sha256', webhookSecret)
      .update(timestamp + (req.rawBody || JSON.stringify(req.body)))
      .digest('base64');

    const sigBuf = Buffer.from(signature);
    const expectedBuf = Buffer.from(expectedSignature);
    const signatureValid = sigBuf.length === expectedBuf.length && crypto.timingSafeEqual(sigBuf, expectedBuf);

    if (!signatureValid) {
      console.error('[handleWebhook] Invalid Cashfree webhook signature');
      return res.status(400).json({ success: false, message: 'Invalid webhook signature' });
    }

    // Acknowledge receipt immediately to Cashfree
    res.json({ status: 'ok' });

    const eventType = req.body.type;

    if (eventType === 'PAYMENT_SUCCESS_WEBHOOK') {
      const order = req.body.data?.order;
      const payment = req.body.data?.payment;
      if (!order || !payment || payment.payment_status !== 'SUCCESS') return;

      const razorpay_order_id = order.order_id; // column name kept for schema compat; holds the Cashfree order_id
      const razorpay_payment_id = String(payment.cf_payment_id);
      const razorpay_signature = signature;
      const amount = parseFloat(payment.payment_amount ?? order.order_amount);

      if (razorpay_order_id.startsWith('order_mock') && process.env.NODE_ENV === 'production') {
        console.error(`[handleWebhook] Rejected mock order in production webhook: ${razorpay_order_id}`);
        return;
      }

      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();

        // Get transaction with a row-level lock
        const [txn] = await conn.query(
          'SELECT * FROM transactions WHERE razorpay_order_id = ? FOR UPDATE',
          [razorpay_order_id]
        );

        if (!txn.length) {
          await conn.rollback();
          conn.release();
          return;
        }

        // If already processed, skip
        if (txn[0].status === 'success') {
          await conn.rollback();
          conn.release();
          return;
        }

        const loan_id = txn[0].loan_id;
        const investment_id = txn[0].investment_id;
        const userId = txn[0].user_id;

        // Update transaction
        await conn.query(
          `UPDATE transactions SET
            razorpay_payment_id = ?,
            razorpay_signature = ?,
            status = 'success'
           WHERE razorpay_order_id = ?`,
          [razorpay_payment_id, razorpay_signature, razorpay_order_id]
        );

        if (investment_id) {
          // Investment funding — activate the investment
          await conn.query(
            `UPDATE investments SET status = 'active', start_date = CURDATE(),
               maturity_date = DATE_ADD(CURDATE(), INTERVAL tenure_months MONTH)
             WHERE id = ? AND status = 'pending'`,
            [investment_id]
          );

          await conn.query(
            'INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, ?)',
            [userId, 'Investment Active (Webhook) 🎉', `Your investment of ₹${amount} is now active. Payment ID: ${razorpay_payment_id}`, 'payment']
          );

          await conn.commit();
          conn.release();
          await invalidateUserCache(userId).catch(() => {});
          return;
        }

        // Update loan amount_paid
        await conn.query(
          `UPDATE loans SET amount_paid = amount_paid + ? WHERE id = ?`,
          [amount, loan_id]
        );

        // Mark EMI as paid
        await conn.query(
          `UPDATE emi_schedule SET status = 'paid', paid_amount = ?, paid_at = NOW()
           WHERE loan_id = ? AND status = 'upcoming' ORDER BY due_date ASC LIMIT 1`,
          [amount, loan_id]
        );

        // Check if loan fully closed — count remaining unpaid/non-waived EMIs
        const [[{ remaining }]] = await conn.query(
          `SELECT COUNT(*) AS remaining FROM emi_schedule
            WHERE loan_id = ? AND status NOT IN ('paid', 'waived')`,
          [loan_id]
        );
        if (remaining === 0) {
          await conn.query("UPDATE loans SET status = 'closed' WHERE id = ?", [loan_id]);
          await conn.query("UPDATE bank_mandates SET status = 'inactive' WHERE user_id = ?", [userId]);
        }

        // Notification
        await conn.query(
          'INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, ?)',
          [userId, 'Payment Successful (Webhook) ✅', `Your EMI payment of ₹${amount} has been received. Payment ID: ${razorpay_payment_id}`, 'payment']
        );

        await conn.commit();
        conn.release();
        // Bust dashboard cache so Home/PayEMI refresh immediately
        await invalidateUserCache(userId).catch(() => {});
      } catch (dbErr) {
        try {
          await conn.rollback();
        } catch (_) { }
        conn.release();
        throw dbErr;
      }
    }
  } catch (err) {
    console.error('❌ Webhook error:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ success: false, message: err.message });
    }
  }
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

    let refund;
    const isMock = orderId.startsWith('order_mock') || (payment_id && payment_id.startsWith('pay_mock'));

    if (!isMock && process.env.CASHFREE_APP_ID && !process.env.CASHFREE_APP_ID.includes('placeholder')) {
      const cfEnv = process.env.CASHFREE_ENV === 'production' ? 'production' : 'sandbox';
      const url = cfEnv === 'production'
        ? `https://api.cashfree.com/pg/orders/${orderId}/refunds`
        : `https://sandbox.cashfree.com/pg/orders/${orderId}/refunds`;

      const refundId = `ref_${orderId.replace('order_', '')}_${Date.now()}`;
      try {
        const response = await axios.post(url, {
          refund_amount: parseFloat(refundAmount),
          refund_id: refundId,
          refund_note: reason || 'Admin initiated refund',
          refund_speed: 'STANDARD'
        }, {
          headers: {
            'x-client-id': process.env.CASHFREE_APP_ID,
            'x-client-secret': process.env.CASHFREE_SECRET_KEY,
            'x-api-version': '2023-08-01',
            'Content-Type': 'application/json'
          }
        });

        if (response.data && response.data.refund_id) {
          refund = { id: response.data.refund_id };
        } else {
          throw new Error('Invalid refund response from Cashfree');
        }
      } catch (err) {
        console.error('Cashfree PG refund failed:', err.response?.data || err.message);
        conn.release();
        return res.status(500).json({
          success: false,
          message: `Cashfree refund failed: ${err.response?.data?.message || err.message}`
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

module.exports = { createOrder, verifyPayment, getPaymentHistory, handleWebhook, initiateRefund, cancelPayment };
