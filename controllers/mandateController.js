const crypto = require('crypto');
const { pool } = require('../config/db');
const {
  cashfree, cashfreeSubscriptions, cashfreeErrorCode, autoPayMode,
} = require('../utils/paymentGateway');
const {
  CHARGEABLE_AT_GATEWAY, findMandate, syncMandate, retireMockMandate, handleSubscriptionEvent,
} = require('../utils/autoPay');

// Auto-Pay registration. A mandate is a Cashfree subscription the customer
// authorises once with their bank (eNACH) or UPI app; utils/autoPay.js then
// raises each EMI against it.
//
// Setting one up:
//   1. POST /mandate/create registers the subscription and returns `auth_link`,
//      the website's /autopay page for it.
//   2. That page asks GET /mandate/session for a session and opens Cashfree's
//      authorisation screen with it.
//   3. Cashfree sends the customer back through /mandate/return, which lands
//      them on the profile page; that page (or the app) calls /mandate/verify.
// A bank can take from minutes to a couple of days to confirm an eNACH
// mandate — it stays 'pending' until Cashfree reports it ACTIVE, which also
// arrives by webhook.

const frontendUrl = (req) => req?.headers?.origin || process.env.FRONTEND_URL || 'https://ppokket.com';
// Public base URL of this API, for the link Cashfree sends the browser back to.
// Cashfree's live API only accepts an https address there. Behind the host's
// proxy a request can look like plain http even though the API is only ever
// served over https, so with live keys the address is always given as https.
const apiUrl = (req) => {
  const base = process.env.API_PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
  return process.env.CASHFREE_ENV === 'production' ? base.replace(/^http:\/\//i, 'https://') : base;
};

const SETUP_AGAIN = 'Your previous Auto-Pay setup can no longer be used. Please set up Auto-Pay again.';
const GATEWAY_DOWN = 'Could not reach the bank gateway. Please try again in a few minutes.';
const UNAVAILABLE = 'Auto-Pay is temporarily unavailable. Please try again later.';

// What the customer should know about a mandate that isn't active yet.
const pendingMessage = (gatewayStatus) => (gatewayStatus === 'BANK_APPROVAL_PENDING'
  ? 'Authorisation received. Your bank is confirming the mandate — this can take from a few minutes up to 2 working days.'
  : 'Auto-Pay is not authorised yet. Please complete the authorisation with your bank.');

const savePendingMandate = (userId, { subscriptionId, authLink, paymentMode, gatewayId }) => pool.query(
  `INSERT INTO bank_mandates (user_id, subscription_id, status, auth_link, payment_mode, mandate_id)
   VALUES (?, ?, 'pending', ?, ?, ?)
   ON DUPLICATE KEY UPDATE
     subscription_id = ?, plan_id = NULL, status = 'pending', auth_link = ?, payment_mode = ?, mandate_id = ?, umrn = NULL`,
  [userId, subscriptionId, authLink, paymentMode, gatewayId, subscriptionId, authLink, paymentMode, gatewayId]
);

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

    const mode = autoPayMode();
    if (mode === 'unavailable') {
      console.error('⚠️  [createMandate] CASHFREE_APP_ID/CASHFREE_SECRET_KEY missing or placeholder in PRODUCTION — Auto-Pay cannot be set up. Fix env vars immediately.');
      return res.status(503).json({ success: false, message: UNAVAILABLE });
    }
    const isMock = mode === 'mock';

    let [[existing]] = await pool.query('SELECT * FROM bank_mandates WHERE user_id = ?', [userId]);
    // A mandate only counts if it was registered the way this server runs — a
    // simulated one is no use to a server that debits through Cashfree, and
    // the other way round.
    const sameMode = existing && (existing.payment_mode === 'mock') === isMock;

    // Decide on what Cashfree says about it, not on what was last saved here.
    if (sameMode && !isMock && ['pending', 'active'].includes(existing.status)) {
      try {
        ({ mandate: existing } = await syncMandate(existing));
      } catch (err) {
        console.error('[createMandate] Cashfree status check failed:', err.response?.data || err.message);
        return res.status(502).json({ success: false, message: GATEWAY_DOWN });
      }
    }

    if (sameMode && existing.status === 'active') {
      return res.json({
        success: true,
        message: 'Auto-Pay is already active for your account.',
        mandate: existing
      });
    }

    // A setup already under way is carried on with, instead of registering a
    // second mandate on every retry click.
    if (sameMode && existing.status === 'pending' && existing.auth_link) {
      return res.json({
        success: true,
        auth_link: existing.auth_link,
        subscription_id: existing.subscription_id,
        is_mock: isMock,
        reusing: true
      });
    }

    // The random tail keeps the id — and so the authorisation link — unguessable.
    const subscriptionId = `sub_ppokket_${userId}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

    if (isMock) {
      // Mock Mandate Creation
      const mockAuthLink = `${frontendUrl(req)}/profile?tab=Auto+Pay&mock_auth=success&sub_id=${subscriptionId}`;
      await savePendingMandate(userId, {
        subscriptionId, authLink: mockAuthLink, paymentMode: 'mock', gatewayId: 'mock_ref_id',
      });

      return res.json({
        success: true,
        auth_link: mockAuthLink,
        subscription_id: subscriptionId,
        is_mock: true
      });
    }

    const phone = String(user.mobile || '').replace(/\D/g, '').slice(-10);
    if (phone.length !== 10) {
      return res.status(400).json({ success: false, message: 'A valid 10-digit mobile number is needed to set up Auto-Pay. Please update your profile.' });
    }

    // Setting up afresh while an earlier mandate (parked when its loan closed)
    // still stands at the bank: end that one, so the customer isn't left with two.
    if (sameMode && existing.status === 'inactive') {
      await cashfreeSubscriptions.manage(existing.subscription_id, 'CANCEL')
        .catch((err) => console.warn('[createMandate] Could not cancel the replaced mandate:', err.response?.data || err.message));
    }

    const registration = {
      subscriptionId,
      customer: { name: user.full_name, email: user.email, phone },
      bank: {
        accountNumber: bank.account_number,
        ifsc: bank.ifsc_code,
        holderName: bank.account_holder,
        accountType: bank.account_type,
      },
      returnUrl: `${apiUrl(req)}/api/payment/mandate/return?sub_id=${subscriptionId}`,
    };

    let subscription;
    try {
      try {
        subscription = await cashfreeSubscriptions.create(registration);
      } catch (err) {
        // The saved account only pre-fills Cashfree's page. If Cashfree won't
        // take it as given, the customer enters it there instead.
        if (!String(cashfreeErrorCode(err) || '').includes('customer_bank')) throw err;
        console.warn('[createMandate] Cashfree rejected the saved bank details, registering without them:', err.response?.data);
        subscription = await cashfreeSubscriptions.create({ ...registration, bank: null });
      }
    } catch (err) {
      console.error('[createMandate] Cashfree Subscription Error:', err.response?.data || err.message);
      if (!err.response) {
        return res.status(502).json({ success: false, message: GATEWAY_DOWN });
      }
      // Cashfree's own reason is passed on: a refusal here is something to act
      // on (a detail on the profile to correct, or Auto-Pay not yet enabled on
      // the Cashfree account), and "please try again" alone would hide which.
      const reason = String(err.response.data?.message || '').replace(/\s+/g, ' ').trim();
      return res.status(400).json({
        success: false,
        message: reason
          ? `Could not start Auto-Pay setup with the bank gateway: ${reason}`
          : 'Could not start Auto-Pay setup with the bank gateway. Please try again.',
        gateway_code: cashfreeErrorCode(err) || undefined,
      });
    }

    // The method the customer picks isn't known until they authorise; 'enach'
    // stands in until syncMandate records the real one.
    const authLink = `${frontendUrl(req)}/autopay?sub_id=${subscriptionId}`;
    await savePendingMandate(userId, {
      subscriptionId, authLink, paymentMode: 'enach', gatewayId: subscription.cf_subscription_id || null,
    });

    res.json({
      success: true,
      auth_link: authLink,
      subscription_id: subscriptionId,
      is_mock: false
    });
  } catch (err) {
    console.error('[createMandate]', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/payment/mandate/session?sub_id=…   (public — the id is the key)
// What the website's /autopay page needs to open Cashfree's authorisation
// screen. Public because the app opens that page in the phone's browser, where
// the customer isn't signed in. Cashfree issues a fresh session on every
// lookup, so the link keeps working until the mandate is authorised.
const getMandateSession = async (req, res) => {
  try {
    const subscriptionId = String(req.query.sub_id || '');
    const mandate = await findMandate(subscriptionId);
    if (!mandate || mandate.payment_mode === 'mock' || autoPayMode() !== 'live') {
      return res.status(404).json({ success: false, message: 'This Auto-Pay link is no longer valid. Please start again from Ppokket.' });
    }

    const subscription = await cashfreeSubscriptions.fetch(subscriptionId);
    if (subscription?.subscription_status === 'INITIALIZED') {
      return res.json({
        success: true,
        state: 'authorize',
        subscription_session_id: subscription.subscription_session_id,
        cashfree_env: process.env.CASHFREE_ENV === 'production' ? 'production' : 'sandbox',
      });
    }

    // Already past the authorisation step — tell the page where things stand.
    const { mandate: refreshed, gatewayStatus } = await syncMandate(mandate, subscription);
    const state = ['active', 'inactive'].includes(refreshed.status) ? 'active'
      : refreshed.status === 'pending' ? 'awaiting_bank'
        : 'closed';
    res.json({ success: true, state, message: state === 'awaiting_bank' ? pendingMessage(gatewayStatus) : undefined });
  } catch (err) {
    console.error('[getMandateSession]', err.response?.data || err.message);
    res.status(502).json({ success: false, message: GATEWAY_DOWN });
  }
};

// GET|POST /api/payment/mandate/return?sub_id=…
// Where Cashfree sends the browser once the customer has finished (or left)
// the authorisation screen. Nothing in the request is taken on trust: the
// mandate's state is read from Cashfree, then the browser goes on to the
// profile page, which is also the App Link that reopens the app.
const handleMandateReturn = async (req, res) => {
  const frontend = process.env.FRONTEND_URL || 'https://ppokket.com';
  const subscriptionId = String(req.query.sub_id || '');
  try {
    const mandate = await findMandate(subscriptionId);
    if (mandate && mandate.payment_mode !== 'mock' && autoPayMode() === 'live') await syncMandate(mandate);
  } catch (err) {
    // The profile page verifies again on arrival and the webhook covers the
    // rest — never leave the customer stranded on an API error.
    console.error('[handleMandateReturn]', err.response?.data || err.message);
  }
  res.redirect(303, `${frontend}/profile?tab=Auto+Pay&sub_id=${encodeURIComponent(subscriptionId)}`);
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
    const mode = autoPayMode();

    if (await retireMockMandate(mandate)) {
      return res.status(400).json({ success: false, message: SETUP_AGAIN, require_reregister: true });
    }

    if (mandate.payment_mode === 'mock') {
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

    if (mode === 'unavailable') {
      return res.status(503).json({ success: false, message: UNAVAILABLE });
    }
    if (mode === 'mock') {
      // Registered with Cashfree, but this server is simulating Auto-Pay.
      return res.status(400).json({ success: false, message: SETUP_AGAIN, require_reregister: true });
    }

    let synced;
    try {
      synced = await syncMandate(mandate);
    } catch (err) {
      console.error('[verifyMandate] Cashfree Get Subscription failed:', err.response?.data || err.message);
      return res.status(502).json({ success: false, message: GATEWAY_DOWN });
    }

    if (!synced.gatewayStatus) {
      // Cashfree has no such subscription — the row is from an earlier setup
      // (or other keys) and can never activate.
      return res.status(400).json({ success: false, message: SETUP_AGAIN, require_reregister: true });
    }

    res.json({
      success: true,
      status: synced.mandate.status,
      gateway_status: synced.gatewayStatus,
      message: synced.mandate.status === 'pending' ? pendingMessage(synced.gatewayStatus) : undefined,
      mandate: synced.mandate,
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
    const mode = autoPayMode();

    if (mandate.payment_mode === 'mock' || mode === 'mock') {
      await pool.query("UPDATE bank_mandates SET status = 'cancelled' WHERE user_id = ?", [userId]);
      return res.json({ success: true, message: 'Auto-Pay deactivated successfully (Mock Mode).' });
    }
    if (mode === 'unavailable') {
      return res.status(503).json({ success: false, message: UNAVAILABLE });
    }

    try {
      await cashfreeSubscriptions.manage(mandate.subscription_id, 'CANCEL');
    } catch (err) {
      // Not an error if there is nothing left to cancel — already cancelled,
      // expired, or never known to Cashfree. Otherwise the mandate still
      // stands at the bank and must not be shown as switched off.
      let subscription;
      try {
        subscription = await cashfreeSubscriptions.fetch(mandate.subscription_id);
      } catch (_) {
        console.error('[deactivateMandate] Cashfree cancel failed:', err.response?.data || err.message);
        return res.status(502).json({ success: false, message: GATEWAY_DOWN });
      }
      const stillStands = subscription
        && ['INITIALIZED', 'BANK_APPROVAL_PENDING', ...CHARGEABLE_AT_GATEWAY].includes(subscription.subscription_status);
      if (stillStands) {
        console.error('[deactivateMandate] Cashfree cancel failed:', err.response?.data || err.message);
        return res.status(400).json({ success: false, message: 'Failed to deactivate mandate with Cashfree. Please try again.' });
      }
    }

    await pool.query("UPDATE bank_mandates SET status = 'cancelled' WHERE user_id = ?", [userId]);
    res.json({ success: true, message: 'Auto-Pay deactivated successfully.' });
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
    await retireMockMandate(mandate);

    // Fetch bank details
    const [bankRows] = await pool.query('SELECT bank_name, account_number, ifsc_code, account_type, account_holder, is_verified FROM bank_details WHERE user_id = ?', [userId]);
    const bank = bankRows.length ? bankRows[0] : null;

    res.json({
      success: true,
      hasBank: !!bank,
      bankVerified: bank ? !!bank.is_verified : false,
      bank: bank ? {
        bank_name:      bank.bank_name,
        account_number: bank.account_number,
        account_holder: bank.account_holder,
        ifsc_code:      bank.ifsc_code,
        account_type:   bank.account_type,
      } : null,
      mandate: mandate
    });
  } catch (err) {
    console.error('[getMandateStatus]', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/payment/mandate/reactivate
// Puts a mandate that was parked when its loan closed back into use for a new
// loan — but only if the bank still honours it.
const reactivateMandate = async (req, res) => {
  try {
    const userId = req.user.id;
    const [mandateRows] = await pool.query('SELECT * FROM bank_mandates WHERE user_id = ? AND status = "inactive"', [userId]);
    if (!mandateRows.length) {
      return res.status(404).json({ success: false, message: 'No inactive mandate found to reactivate.' });
    }
    const mandate = mandateRows[0];
    const mode = autoPayMode();

    if (await retireMockMandate(mandate)) {
      return res.status(400).json({ success: false, message: SETUP_AGAIN });
    }
    if (mandate.payment_mode !== 'mock') {
      if (mode === 'unavailable') {
        return res.status(503).json({ success: false, message: UNAVAILABLE });
      }
      if (mode === 'mock') {
        return res.status(400).json({ success: false, message: SETUP_AGAIN });
      }

      let synced;
      try {
        synced = await syncMandate(mandate);
      } catch (err) {
        console.error('[reactivateMandate] Cashfree status check failed:', err.response?.data || err.message);
        return res.status(502).json({ success: false, message: GATEWAY_DOWN });
      }
      if (!CHARGEABLE_AT_GATEWAY.includes(synced.gatewayStatus)) {
        return res.status(400).json({ success: false, message: SETUP_AGAIN });
      }
    }

    await pool.query("UPDATE bank_mandates SET status = 'active' WHERE user_id = ? AND status = 'inactive'", [userId]);
    await pool.query(
      'INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, ?)',
      [userId, 'Auto-Pay Reactivated 🏦', 'Your previous Auto-Pay mandate has been reactivated successfully.', 'payment']
    );
    res.json({ success: true, message: 'Mandate reactivated successfully.' });
  } catch (err) {
    console.error('[reactivateMandate]', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/payment/webhook   (events whose type starts with SUBSCRIPTION_)
// Cashfree's subscription webhook: mandate authorised / status changed, and
// the result of every debit. Signed the same way as its payment webhook.
// Add it on the Cashfree dashboard under Subscriptions → Webhooks.
const handleSubscriptionWebhook = async (req, res) => {
  try {
    const signature = req.headers['x-webhook-signature'];
    const timestamp = req.headers['x-webhook-timestamp'];

    if (!process.env.CASHFREE_SECRET_KEY) {
      console.error('[handleSubscriptionWebhook] CASHFREE_SECRET_KEY not configured — rejecting webhook.');
      return res.status(500).json({ success: false, message: 'Webhook not configured' });
    }
    if (!signature || !timestamp) {
      return res.status(400).json({ success: false, message: 'Missing webhook signature headers' });
    }
    if (!cashfree.verifyWebhookSignature(req.rawBody || JSON.stringify(req.body), timestamp, signature)) {
      console.error('[handleSubscriptionWebhook] Invalid Cashfree webhook signature');
      return res.status(400).json({ success: false, message: 'Invalid webhook signature' });
    }

    // Acknowledge receipt immediately to Cashfree
    res.json({ status: 'ok' });

    if (autoPayMode() !== 'live') return;
    await handleSubscriptionEvent(req.body);
  } catch (err) {
    console.error('❌ Subscription webhook error:', err.response?.data || err.message);
    if (!res.headersSent) {
      res.status(500).json({ success: false, message: err.message });
    }
  }
};

module.exports = {
  createMandate, verifyMandate, deactivateMandate, getMandateStatus, reactivateMandate,
  getMandateSession, handleMandateReturn, handleSubscriptionWebhook,
};
