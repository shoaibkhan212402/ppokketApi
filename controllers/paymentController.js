const crypto = require('crypto');
const axios = require('axios');
const { pool } = require('../config/db');
const { sendNotification } = require('../utils/fcm');

// POST /api/payment/create-order
const createOrder = async (req, res) => {
  try {
    const { loan_id, amount, emi_id, is_settlement } = req.body;
    const userId = req.user.id;

    if (!loan_id) {
      return res.status(400).json({ success: false, message: 'loan_id required' });
    }

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

    let amountVal;
    let descriptionText;
    let paymentType = 'emi';

    if (is_settlement) {
      if (loan.settlement_amount === null || loan.settlement_amount === undefined) {
        return res.status(400).json({ success: false, message: 'No active settlement offer found for this loan.' });
      }
      amountVal = parseFloat(loan.settlement_amount);
      descriptionText = `Settlement payment for loan #${loan_id}`;
      paymentType = 'settlement';
    } else {
      const regularAmount = amount || emi_id;
      if (!regularAmount) {
        return res.status(400).json({ success: false, message: 'amount required' });
      }
      amountVal = regularAmount;
      descriptionText = `EMI payment for loan #${loan_id}`;
      paymentType = 'emi';
    }

    const [userRow] = await pool.query('SELECT full_name, mobile, email FROM users WHERE id = ?', [userId]);
    const user = userRow[0] || {};

    let orderId = `order_${loan_id}_${Date.now()}`;
    let paymentSessionId = null;
    let cfEnv = process.env.CASHFREE_ENV === 'production' ? 'production' : 'sandbox';
    let isMock = true;

    if (process.env.CASHFREE_APP_ID && !process.env.CASHFREE_APP_ID.includes('placeholder')) {
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
            return_url: `${req.headers.origin || process.env.FRONTEND_URL || 'https://ppokket.com'}/profile?tab=Loan+History&order_id={order_id}`
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
        console.warn('Cashfree PG order creation failed, falling back to mock:', err.response?.data || err.message);
      }
    }

    if (isMock) {
      orderId = `order_mock_${crypto.randomBytes(8).toString('hex')}`;
    }

    // Save pending transaction
    await pool.query(
      `INSERT INTO transactions (user_id, loan_id, razorpay_order_id, amount, type, status, description)
       VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
      [userId, loan_id, orderId, amountVal, paymentType, descriptionText]
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
    
    if (txn[0].type === 'settlement') {
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

      // Check if loan fully paid
      const [loan] = await conn.query('SELECT amount_paid, total_payable FROM loans WHERE id = ?', [loan_id]);
      if (loan[0] && loan[0].amount_paid >= loan[0].total_payable) {
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

    const [user] = await pool.query('SELECT fcm_token FROM users WHERE id = ?', [userId]);
    if (user[0]?.fcm_token) {
      sendNotification(user[0].fcm_token, 'Payment Successful ✅', `Your EMI payment of ₹${paidAmount} has been received.`, { screen: 'Loans' }).catch(() => {});
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
const handleWebhook = async (req, res) => {
  try {
    const signature = req.headers['x-razorpay-signature'];
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET || 'ppokket_webhook_secret_123';

    // Validate signature using raw body (Razorpay signs the raw request body)
    const shasum = crypto.createHmac('sha256', webhookSecret);
    shasum.update(req.rawBody || JSON.stringify(req.body));
    const digest = shasum.digest('hex');

    if (digest !== signature) {
      return res.status(400).json({ success: false, message: 'Invalid webhook signature' });
    }

    // Acknowledge receipt immediately to Razorpay
    res.json({ status: 'ok' });

    const event = req.body.event;

    if (event === 'order.paid') {
      const paymentEntity = req.body.payload?.payment?.entity;
      if (!paymentEntity) return;

      const razorpay_order_id = paymentEntity.order_id;
      const razorpay_payment_id = paymentEntity.id;
      const razorpay_signature = signature;
      const amount = paymentEntity.amount / 100; // paise to rupees

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

        // Check if loan fully paid
        const [loan] = await conn.query('SELECT amount_paid, total_payable FROM loans WHERE id = ?', [loan_id]);
        if (loan[0] && loan[0].amount_paid >= loan[0].total_payable) {
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
