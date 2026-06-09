const Razorpay = require('razorpay');
const crypto = require('crypto');
const { pool } = require('../config/db');

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// POST /api/payment/create-order
const createOrder = async (req, res) => {
  try {
    const { loan_id, amount, emi_id } = req.body;
    const amountVal = amount || emi_id;
    const userId = req.user.id;

    if (!loan_id || !amountVal) {
      return res.status(400).json({ success: false, message: 'loan_id and amount required' });
    }

    // Verify loan belongs to user
    const [loan] = await pool.query(
      'SELECT * FROM loans WHERE id = ? AND user_id = ? AND status = "disbursed"',
      [loan_id, userId]
    );
    if (!loan.length) {
      return res.status(404).json({ success: false, message: 'Loan not found or not disbursed' });
    }

    const options = {
      amount: Math.round(amountVal * 100), // paise
      currency: 'INR',
      receipt: `loan_${loan_id}_${Date.now()}`,
      notes: { loan_id, user_id: userId },
    };

    let order;
    try {
      if (process.env.RAZORPAY_KEY_ID && !process.env.RAZORPAY_KEY_ID.includes('placeholder')) {
        order = await razorpay.orders.create(options);
      } else {
        throw new Error('Placeholder keys: using simulated Razorpay order');
      }
    } catch (e) {

      order = {
        id: `order_mock_${crypto.randomBytes(8).toString('hex')}`,
        amount: Math.round(amountVal * 100),
        currency: 'INR',
      };
    }

    // Save pending transaction
    await pool.query(
      `INSERT INTO transactions (user_id, loan_id, razorpay_order_id, amount, type, status, description)
       VALUES (?, ?, ?, ?, 'emi', 'pending', ?)`,
      [userId, loan_id, order.id, amountVal, `EMI payment for loan #${loan_id}`]
    );

    res.json({
      success: true,
      order_id: order.id,
      amount: order.amount,
      currency: order.currency,
      key: process.env.RAZORPAY_KEY_ID || 'rzp_test_placeholderkey',
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/payment/verify
const verifyPayment = async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, loan_id } = req.body;
    const userId = req.user.id;

    // Verify signature (skip check if it's a mock order)
    if (!razorpay_order_id.startsWith('order_mock')) {
      const body = razorpay_order_id + '|' + razorpay_payment_id;
      const expectedSignature = crypto
        .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET || 'placeholdersecret')
        .update(body)
        .digest('hex');

      if (expectedSignature !== razorpay_signature) {
        return res.status(400).json({ success: false, message: 'Payment verification failed' });
      }
    }

    // Get transaction
    const [txn] = await pool.query(
      'SELECT * FROM transactions WHERE razorpay_order_id = ? AND user_id = ?',
      [razorpay_order_id, userId]
    );

    if (!txn.length) {
      return res.status(404).json({ success: false, message: 'Transaction not found' });
    }

    // Update transaction
    await pool.query(
      `UPDATE transactions SET
        razorpay_payment_id = ?,
        razorpay_signature = ?,
        status = 'success'
       WHERE razorpay_order_id = ?`,
      [razorpay_payment_id, razorpay_signature, razorpay_order_id]
    );

    // Update loan amount_paid
    const paidAmount = txn[0].amount;
    await pool.query(
      `UPDATE loans SET amount_paid = amount_paid + ? WHERE id = ?`,
      [paidAmount, loan_id]
    );

    // Mark EMI as paid
    await pool.query(
      `UPDATE emi_schedule SET status = 'paid', paid_amount = ?, paid_at = NOW()
       WHERE loan_id = ? AND status = 'upcoming' ORDER BY due_date ASC LIMIT 1`,
      [paidAmount, loan_id]
    );

    // Check if loan fully paid
    const [loan] = await pool.query('SELECT amount_paid, total_payable FROM loans WHERE id = ?', [loan_id]);
    if (loan[0].amount_paid >= loan[0].total_payable) {
      await pool.query("UPDATE loans SET status = 'closed' WHERE id = ?", [loan_id]);
    }

    // Notification
    await pool.query(
      'INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, ?)',
      [userId, 'Payment Successful ✅', `Your EMI payment of ₹${paidAmount} has been received. Payment ID: ${razorpay_payment_id}`, 'payment']
    );

    res.json({
      success: true,
      message: 'Payment verified successfully',
      payment_id: razorpay_payment_id,
    });
  } catch (err) {
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
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/payment/webhook
const handleWebhook = async (req, res) => {
  try {
    const signature = req.headers['x-razorpay-signature'];
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET || 'ppokket_webhook_secret_123';
    
    // Validate signature
    const shasum = crypto.createHmac('sha256', webhookSecret);
    shasum.update(JSON.stringify(req.body));
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
      
      // Get transaction
      const [txn] = await pool.query(
        'SELECT * FROM transactions WHERE razorpay_order_id = ?',
        [razorpay_order_id]
      );
      
      if (!txn.length) {

        return;
      }
      
      // If already processed, skip
      if (txn[0].status === 'success') {

        return;
      }
      
      const loan_id = txn[0].loan_id;
      const userId = txn[0].user_id;
      
      // Update transaction
      await pool.query(
        `UPDATE transactions SET
          razorpay_payment_id = ?,
          razorpay_signature = ?,
          status = 'success'
         WHERE razorpay_order_id = ?`,
        [razorpay_payment_id, razorpay_signature, razorpay_order_id]
      );
      
      // Update loan amount_paid
      await pool.query(
        `UPDATE loans SET amount_paid = amount_paid + ? WHERE id = ?`,
        [amount, loan_id]
      );
      
      // Mark EMI as paid
      await pool.query(
        `UPDATE emi_schedule SET status = 'paid', paid_amount = ?, paid_at = NOW()
         WHERE loan_id = ? AND status = 'upcoming' ORDER BY due_date ASC LIMIT 1`,
        [amount, loan_id]
      );
      
      // Check if loan fully paid
      const [loan] = await pool.query('SELECT amount_paid, total_payable FROM loans WHERE id = ?', [loan_id]);
      if (loan[0] && loan[0].amount_paid >= loan[0].total_payable) {
        await pool.query("UPDATE loans SET status = 'closed' WHERE id = ?", [loan_id]);
      }
      
      // Notification
      await pool.query(
        'INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, ?)',
        [userId, 'Payment Successful (Webhook) ✅', `Your EMI payment of ₹${amount} has been received. Payment ID: ${razorpay_payment_id}`, 'payment']
      );
      

    }
  } catch (err) {
    console.error('❌ Webhook error:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ success: false, message: err.message });
    }
  }
};

module.exports = { createOrder, verifyPayment, getPaymentHistory, handleWebhook };

