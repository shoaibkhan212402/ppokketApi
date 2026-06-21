const crypto = require('crypto');
const { pool } = require('../config/db');
const { sendNotification } = require('../utils/fcm');

// Helper to check environment and mode
const getCashfreeConfig = () => {
  const appId = process.env.CASHFREE_APP_ID;
  const secretKey = process.env.CASHFREE_SECRET_KEY;
  const cfEnv = process.env.CASHFREE_ENV === 'production' ? 'production' : 'sandbox';
  const isMock = !appId || appId.includes('placeholder') || !secretKey || secretKey.includes('placeholder');

  const baseUrl = cfEnv === 'production' ? 'https://api.cashfree.com' : 'https://sandbox.cashfree.com';

  return { appId, secretKey, cfEnv, isMock, baseUrl };
};

// POST /api/payment/mandate/create
const createMandate = async (req, res) => {
  try {
    const userId = req.user.id;

    // 1. Check if user has verified bank account
    const [bankRows] = await pool.query(
      'SELECT * FROM bank_details WHERE user_id = ? AND is_verified = 1',
      [userId]
    );

    if (!bankRows.length) {
      return res.status(400).json({
        success: false,
        message: 'Please link and verify your bank account in KYC before setting up Auto-Pay.'
      });
    }

    const bank = bankRows[0];

    // Get user details
    const [userRows] = await pool.query('SELECT full_name, mobile, email FROM users WHERE id = ?', [userId]);
    const user = userRows[0];

    // Check if active mandate already exists
    const [existing] = await pool.query('SELECT * FROM bank_mandates WHERE user_id = ?', [userId]);
    if (existing.length && existing[0].status === 'active') {
      return res.json({
        success: true,
        message: 'Auto-Pay is already active for your account.',
        mandate: existing[0]
      });
    }

    const config = getCashfreeConfig();
    const subscriptionId = `sub_ppokket_${userId}_${Date.now()}`;
    const planId = 'ppokket_ondemand_v1';

    if (config.isMock) {
      // Mock Mandate Creation
      const mockAuthLink = `${req.headers.origin || 'http://localhost:5173'}/profile?tab=Auto+Pay&mock_auth=success&sub_id=${subscriptionId}`;

      // Insert or update mandate in database
      if (existing.length) {
        await pool.query(
          `UPDATE bank_mandates SET
            subscription_id = ?, plan_id = ?, status = 'pending',
            auth_link = ?, payment_mode = 'mock', umrn = NULL, mandate_id = 'mock_ref_id'
           WHERE user_id = ?`,
          [subscriptionId, planId, mockAuthLink, userId]
        );
      } else {
        await pool.query(
          `INSERT INTO bank_mandates (user_id, subscription_id, plan_id, status, auth_link, payment_mode, mandate_id)
           VALUES (?, ?, ?, 'pending', ?, 'mock', 'mock_ref_id')`,
          [userId, subscriptionId, planId, mockAuthLink]
        );
      }

      return res.json({
        success: true,
        auth_link: mockAuthLink,
        subscription_id: subscriptionId,
        is_mock: true
      });
    }

    // Live Cashfree API calls
    // Step 1: Ensure Plan exists
    try {
      const planUrl = `${config.baseUrl}/api/v2/subscription-plans`;
      const planRes = await fetch(planUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Client-Id': config.appId,
          'X-Client-Secret': config.secretKey
        },
        body: JSON.stringify({
          planId: planId,
          planName: 'Ppokket On-Demand Auto-Pay Plan',
          type: 'ON_DEMAND',
          maxAmount: 50000,
          note: 'On-demand recurring auto-pay plan for loan EMI recovery'
        })
      });

      const planData = await planRes.json();
      if (planRes.status !== 200 && planData.message && !planData.message.includes('already exists')) {
        console.warn('[createMandate] Plan creation response code:', planRes.status, planData);
      }
    } catch (err) {
      console.warn('[createMandate] Plan check/create error, continuing:', err.message);
    }

    // Step 2: Create Subscription
    const subUrl = `${config.baseUrl}/api/v2/subscriptions`;
    const cleanPhone = user.mobile.replace(/\D/g, '').slice(-10);
    const expiresOn = new Date();
    expiresOn.setFullYear(expiresOn.getFullYear() + 10); // 10 years expiry
    const formattedExpiry = expiresOn.toISOString().replace('T', ' ').substring(0, 19);

    const subRes = await fetch(subUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Client-Id': config.appId,
        'X-Client-Secret': config.secretKey
      },
      body: JSON.stringify({
        subscriptionId: subscriptionId,
        planId: planId,
        customerName: user.full_name || 'Customer',
        customerPhone: cleanPhone,
        customerEmail: user.email || 'customer@ppokket.com',
        authAmount: 1.00,
        expiresOn: formattedExpiry,
        returnUrl: `${req.headers.origin || 'http://localhost:5173'}/profile?tab=Auto+Pay&sub_id={subscription_id}`,
        notificationChannels: ['SMS', 'EMAIL']
      })
    });

    const subData = await subRes.json();

    if (subRes.status !== 200 || !subData.authLink) {
      console.error('[createMandate] Cashfree Subscription Error:', subData);
      return res.status(400).json({
        success: false,
        message: subData.message || 'Failed to initialize mandate registration with Cashfree.'
      });
    }

    // Insert or update mandate in database
    if (existing.length) {
      await pool.query(
        `UPDATE bank_mandates SET
          subscription_id = ?, plan_id = ?, status = 'pending',
          auth_link = ?, payment_mode = 'enach', umrn = NULL, mandate_id = ?
         WHERE user_id = ?`,
        [subscriptionId, planId, subData.authLink, subData.subReferenceId || null, userId]
      );
    } else {
      await pool.query(
        `INSERT INTO bank_mandates (user_id, subscription_id, plan_id, status, auth_link, payment_mode, mandate_id)
         VALUES (?, ?, ?, 'pending', ?, 'enach', ?)`,
        [userId, subscriptionId, planId, subData.authLink, subData.subReferenceId || null]
      );
    }

    res.json({
      success: true,
      auth_link: subData.authLink,
      subscription_id: subscriptionId,
      is_mock: false
    });
  } catch (err) {
    console.error('[createMandate]', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/payment/mandate/verify
const verifyMandate = async (req, res) => {
  try {
    const userId = req.user.id;
    const [mandateRows] = await pool.query('SELECT * FROM bank_mandates WHERE user_id = ?', [userId]);

    if (!mandateRows.length) {
      return res.status(404).json({ success: false, message: 'Mandate registration not found.' });
    }

    const mandate = mandateRows[0];
    const config = getCashfreeConfig();

    if (config.isMock || mandate.payment_mode === 'mock') {
      // Mock flow: set pending to active instantly
      if (mandate.status === 'pending') {
        await pool.query(
          "UPDATE bank_mandates SET status = 'active', umrn = ? WHERE user_id = ?",
          [`UMRN_MOCK_${crypto.randomBytes(6).toString('hex').toUpperCase()}`, userId]
        );
        // Also verify the bank connection
        await pool.query('UPDATE bank_details SET is_verified = 1 WHERE user_id = ?', [userId]);
        await pool.query('UPDATE users SET bank_verified = 1 WHERE id = ?', [userId]);

        // Send confirmation notification
        await pool.query(
          'INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, ?)',
          [userId, 'Auto-Pay Enabled successfully! 🏦', 'Your e-mandate has been successfully linked to your bank account.', 'payment']
        );
      }

      const [updated] = await pool.query('SELECT * FROM bank_mandates WHERE user_id = ?', [userId]);
      return res.json({
        success: true,
        status: updated[0].status,
        mandate: updated[0],
        is_mock: true
      });
    }

    // Call Cashfree API to verify subscription status
    const verifyUrl = `${config.baseUrl}/api/v2/subscriptions/${mandate.subscription_id}`;
    const subRes = await fetch(verifyUrl, {
      method: 'GET',
      headers: {
        'X-Client-Id': config.appId,
        'X-Client-Secret': config.secretKey
      }
    });

    const subData = await subRes.json();

    if (subRes.status !== 200) {
      console.error('[verifyMandate] Cashfree Get Subscription details failed:', subData);
      return res.status(400).json({
        success: false,
        message: subData.message || 'Failed to verify mandate status from Cashfree.'
      });
    }

    let localStatus = 'pending';
    const cfStatus = String(subData.status).toUpperCase();

    if (['ACTIVE', 'ACTIVATED', 'COMPLETED'].includes(cfStatus)) {
      localStatus = 'active';
    } else if (['CANCELLED', 'PAUSED'].includes(cfStatus)) {
      localStatus = 'cancelled';
    } else if (['FAILED', 'REJECTED'].includes(cfStatus)) {
      localStatus = 'failed';
    }

    // Update database status
    await pool.query(
      `UPDATE bank_mandates SET
        status = ?, umrn = ?, payment_mode = ?
       WHERE user_id = ?`,
      [localStatus, subData.umrn || mandate.umrn || null, subData.paymentMode || mandate.payment_mode || null, userId]
    );

    if (localStatus === 'active' && mandate.status !== 'active') {
      // Send confirmation notification on first activation
      await pool.query(
        'INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, ?)',
        [userId, 'Auto-Pay Activated Successfully! 🏦', 'Automatic deduction of EMIs has been set up on your bank account.', 'payment']
      );

      const [user] = await pool.query('SELECT fcm_token FROM users WHERE id = ?', [userId]);
      if (user[0]?.fcm_token) {
        sendNotification(user[0].fcm_token, 'Auto-Pay Activated 🏦', 'Your bank account is now linked for automatic EMI recovery.', { screen: 'Profile' }).catch(() => {});
      }
    }

    const [updated] = await pool.query('SELECT * FROM bank_mandates WHERE user_id = ?', [userId]);
    res.json({
      success: true,
      status: localStatus,
      mandate: updated[0],
      is_mock: false
    });
  } catch (err) {
    console.error('[verifyMandate]', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/payment/mandate/deactivate
const deactivateMandate = async (req, res) => {
  try {
    const userId = req.user.id;
    const [mandateRows] = await pool.query('SELECT * FROM bank_mandates WHERE user_id = ?', [userId]);

    if (!mandateRows.length) {
      return res.status(404).json({ success: false, message: 'Mandate registration not found.' });
    }

    const mandate = mandateRows[0];
    const config = getCashfreeConfig();

    if (config.isMock || mandate.payment_mode === 'mock') {
      await pool.query("UPDATE bank_mandates SET status = 'cancelled' WHERE user_id = ?", [userId]);
      return res.json({ success: true, message: 'Auto-Pay deactivated successfully (Mock Mode).' });
    }

    // Call Cashfree API to cancel subscription
    const cancelUrl = `${config.baseUrl}/api/v2/subscriptions/${mandate.subscription_id}/cancel`;
    const cancelRes = await fetch(cancelUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Client-Id': config.appId,
        'X-Client-Secret': config.secretKey
      }
    });

    const cancelData = await cancelRes.json();

    // If cancellation returns 200 or is already cancelled, mark it cancelled locally
    if (cancelRes.status === 200 || (cancelData.message && cancelData.message.includes('already cancelled'))) {
      await pool.query("UPDATE bank_mandates SET status = 'cancelled' WHERE user_id = ?", [userId]);
      return res.json({ success: true, message: 'Auto-Pay deactivated successfully.' });
    }

    console.error('[deactivateMandate] Cashfree cancel failed:', cancelData);
    return res.status(400).json({
      success: false,
      message: cancelData.message || 'Failed to deactivate mandate with Cashfree.'
    });
  } catch (err) {
    console.error('[deactivateMandate]', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/payment/mandate/status
const getMandateStatus = async (req, res) => {
  try {
    const userId = req.user.id;

    // Fetch mandate details
    const [mandateRows] = await pool.query('SELECT * FROM bank_mandates WHERE user_id = ?', [userId]);
    const mandate = mandateRows.length ? mandateRows[0] : null;

    // Fetch bank details
    const [bankRows] = await pool.query('SELECT bank_name, account_number, is_verified FROM bank_details WHERE user_id = ?', [userId]);
    const bank = bankRows.length ? bankRows[0] : null;

    res.json({
      success: true,
      hasBank: !!bank,
      bankVerified: bank ? !!bank.is_verified : false,
      bankName: bank ? bank.bank_name : null,
      accountNumber: bank ? bank.account_number : null,
      mandate: mandate
    });
  } catch (err) {
    console.error('[getMandateStatus]', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

module.exports = { createMandate, verifyMandate, deactivateMandate, getMandateStatus };
