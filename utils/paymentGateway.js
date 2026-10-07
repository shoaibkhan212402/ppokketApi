const crypto = require('crypto');
const axios = require('axios');
const { pool } = require('../config/db');

// One-time payments (EMI, settlement, investment funding) can be collected
// through either gateway; the admin picks which one in Settings → Payment
// Gateway (system_settings.payment_gateway). Auto-debit mandates are not part
// of this switch — they are always Cashfree subscriptions (cashfreeSubscriptions
// below, driven by utils/autoPay.js and mandateController).
const GATEWAYS = ['cashfree', 'razorpay'];
const GATEWAY_NAMES = { cashfree: 'Cashfree', razorpay: 'Razorpay' };
const DEFAULT_GATEWAY = 'cashfree';
const SETTING_KEY = 'payment_gateway';
const TIMEOUT_MS = 15000;

const usable = (v) => !!v && !v.includes('placeholder');

// An amount as a gateway wants it: rupees with at most two decimals. Adding
// DECIMAL values in floating point (an EMI plus its late penalty, say) can come
// out as 2003.9699999999998, which Cashfree rejects as "Invalid amount entered".
const toRupees = (amount) => Math.round(parseFloat(amount) * 100) / 100;

// Keys present in the environment (not whether the gateway accepts them — see checkCredentials).
const isConfigured = (gateway) => {
  if (gateway === 'cashfree') return usable(process.env.CASHFREE_APP_ID) && usable(process.env.CASHFREE_SECRET_KEY);
  if (gateway === 'razorpay') return usable(process.env.RAZORPAY_KEY_ID) && usable(process.env.RAZORPAY_KEY_SECRET);
  return false;
};

const gatewayMode = (gateway) => {
  if (gateway === 'cashfree') return process.env.CASHFREE_ENV === 'production' ? 'live' : 'test';
  if (gateway === 'razorpay') return (process.env.RAZORPAY_KEY_ID || '').startsWith('rzp_live_') ? 'live' : 'test';
  return null;
};

// A simulated ("mock") payment settles as paid with no money collected. That is
// a development convenience for test data only: never in production, and never
// on a server whose gateway has been switched to live keys — there a failed
// order has to surface as an error, not quietly turn into a free "payment".
const mockPaymentsAllowed = () => process.env.NODE_ENV !== 'production'
  && !GATEWAYS.some((g) => isConfigured(g) && gatewayMode(g) === 'live');

const describeGateway = (gateway) => ({
  id: gateway,
  name: GATEWAY_NAMES[gateway],
  configured: isConfigured(gateway),
  mode: gatewayMode(gateway),
});

// The gateway the admin has selected for new payments.
const getSelectedGateway = async () => {
  const [rows] = await pool.query('SELECT setting_value FROM system_settings WHERE setting_key = ?', [SETTING_KEY]);
  const value = rows[0]?.setting_value;
  return GATEWAYS.includes(value) ? value : DEFAULT_GATEWAY;
};

const setSelectedGateway = (gateway) => pool.query(
  'INSERT INTO system_settings (setting_key,setting_value) VALUES (?,?) ON DUPLICATE KEY UPDATE setting_value=?',
  [SETTING_KEY, gateway, gateway]
);

// The gateway a new order should be created on. The admin's selection wins,
// unless this client can't open that checkout: app builds released before
// Razorpay support only understand a Cashfree order, so they are kept on
// Cashfree rather than handed an order they have no way to pay.
// `clientCanUse` is false when there is nothing this client can pay through.
const pickGatewayForOrder = async (clientSupports) => {
  const selected = await getSelectedGateway();
  const supported = Array.isArray(clientSupports) && clientSupports.length ? clientSupports : ['cashfree'];
  if (supported.includes(selected)) return { gateway: selected, clientCanUse: true };

  const fallback = supported.find((g) => GATEWAYS.includes(g) && isConfigured(g));
  return fallback ? { gateway: fallback, clientCanUse: true } : { gateway: selected, clientCanUse: false };
};

// Which gateway an existing order belongs to. Derived from the order id rather
// than stored, so it needs no schema change and also covers every order made
// before Razorpay was added:
//   mock      order_mock_<hex>               minted by createOrder outside production
//   cashfree  order_<loan|invN>_<timestamp>  we choose this id — note the second underscore
//   razorpay  order_<alphanumerics>          Razorpay chooses it — never a second underscore
// Keep cashfree.createOrder's id format in step with this.
const gatewayOfOrder = (orderId = '') => {
  if (orderId.startsWith('order_mock')) return 'mock';
  return /^order_[A-Za-z0-9]+$/.test(orderId) ? 'razorpay' : 'cashfree';
};

const safeEqual = (a, b) => {
  const bufA = Buffer.from(String(a || ''));
  const bufB = Buffer.from(String(b || ''));
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
};

// 401/403 from a gateway means it rejected our keys; anything else is "couldn't tell".
const isAuthError = (err) => [401, 403].includes(err.response?.status);

// ── Cashfree ──────────────────────────────────────────────────────────────────
const cashfreeBase = () => (process.env.CASHFREE_ENV === 'production'
  ? 'https://api.cashfree.com/pg'
  : 'https://sandbox.cashfree.com/pg');

const cashfreeConfig = () => ({
  timeout: TIMEOUT_MS,
  headers: {
    'x-client-id': process.env.CASHFREE_APP_ID,
    'x-client-secret': process.env.CASHFREE_SECRET_KEY,
    'x-api-version': '2023-08-01',
    'Content-Type': 'application/json',
  },
});

const cashfree = {
  // Returns { orderId, checkout } — `checkout` is what the client needs to open the payment page.
  async createOrder({ reference, amount, customer, returnUrl }) {
    const { data } = await axios.post(`${cashfreeBase()}/orders`, {
      order_id: `order_${reference}_${Date.now()}`,
      order_amount: toRupees(amount),
      order_currency: 'INR',
      customer_details: {
        customer_id: String(customer.id),
        customer_email: customer.email || 'customer@ppokket.com',
        customer_phone: customer.phone || '9999999999',
        customer_name: customer.name || 'Customer',
      },
      order_meta: { return_url: returnUrl },
    }, cashfreeConfig());

    if (!data?.payment_session_id) throw new Error('Cashfree did not return a payment session');
    return { orderId: data.order_id, checkout: { payment_session_id: data.payment_session_id } };
  },

  async fetchPayment(orderId) {
    const { data } = await axios.get(`${cashfreeBase()}/orders/${orderId}`, cashfreeConfig());
    return data?.order_status === 'PAID'
      ? { paid: true, paymentId: String(data.cf_order_id || `cf_${orderId}`) }
      : { paid: false };
  },

  // Returns the gateway's refund id.
  async refund({ orderId, amount, note }) {
    const { data } = await axios.post(`${cashfreeBase()}/orders/${orderId}/refunds`, {
      refund_amount: toRupees(amount),
      refund_id: `ref_${orderId.replace('order_', '')}_${Date.now()}`,
      refund_note: note,
      refund_speed: 'STANDARD',
    }, cashfreeConfig());

    if (!data?.refund_id) throw new Error('Invalid refund response from Cashfree');
    return data.refund_id;
  },

  // Throws unless Cashfree accepts the configured keys. Looking up an order
  // that doesn't exist is the cheapest authenticated call: valid keys answer
  // 404, bad keys answer 401.
  async checkCredentials() {
    try {
      await axios.get(`${cashfreeBase()}/orders/ppokket_key_check`, cashfreeConfig());
    } catch (err) {
      if (err.response?.status === 404) return;
      throw err;
    }
  },

  // Cashfree signs every webhook — payments and subscriptions alike — with
  // base64(HMAC-SHA256(timestamp + rawBody, secret key)).
  verifyWebhookSignature(rawBody, timestamp, signature) {
    const expected = crypto
      .createHmac('sha256', process.env.CASHFREE_SECRET_KEY || '')
      .update(String(timestamp) + rawBody)
      .digest('base64');
    return safeEqual(expected, signature);
  },
};

// ── Cashfree Subscriptions (Auto-Pay mandates) ────────────────────────────────
// An Auto-Pay mandate is a Cashfree subscription on an ON_DEMAND plan: the
// customer authorises it once (eNACH or UPI Autopay) and every EMI is then
// raised against it as its own charge. Both are addressed by ids we choose
// (subscription_id, payment_id).
// Docs: https://www.cashfree.com/docs/api-reference/payments/latest/subscription/create-subscription
const SUBSCRIPTION_API_VERSION = '2025-01-01';
const AUTOPAY_METHODS = ['enach', 'upi'];
const AUTOPAY_VALIDITY_YEARS = 10;
const BANK_ACCOUNT_TYPES = ['SAVINGS', 'CURRENT'];

const subscriptionConfig = () => {
  const config = cashfreeConfig();
  return { ...config, headers: { ...config.headers, 'x-api-version': SUBSCRIPTION_API_VERSION } };
};

// Cashfree's machine-readable error code ('subscription_not_active', …), if it sent one.
const cashfreeErrorCode = (err) => err.response?.data?.code || null;
const cashfreeErrorMessage = (err) => err.response?.data?.message || err.message;

// The largest single debit a new mandate allows; the customer sees this figure
// when authorising. An EMI above it can't be auto-debited.
const autoPayMaxAmount = () => parseFloat(process.env.AUTOPAY_MAX_AMOUNT) || 50000;

// How Auto-Pay runs on this server:
//   'live'        against Cashfree (its sandbox or production, per CASHFREE_ENV)
//   'mock'        simulated, no gateway call — never in production
//   'unavailable' production without usable keys. Refused rather than
//                 simulated: a simulated debit marks an EMI paid with no money
//                 collected.
// Outside production the gateway is only used when AUTOPAY_USE_GATEWAY=true,
// so local work isn't left waiting on a sandbox bank to approve a mandate.
const autoPayMode = () => {
  if (process.env.NODE_ENV === 'production') return isConfigured('cashfree') ? 'live' : 'unavailable';
  return process.env.AUTOPAY_USE_GATEWAY === 'true' && isConfigured('cashfree') ? 'live' : 'mock';
};

const cashfreeSubscriptions = {
  // Registers a mandate for the customer to authorise. `bank` is their
  // KYC-verified account, passed so the authorisation page starts from it.
  // Returns Cashfree's subscription, including the subscription_session_id
  // that opens the authorisation page.
  async create({ subscriptionId, customer, bank, returnUrl }) {
    const accountType = String(bank?.accountType || '').toUpperCase();
    const expiry = new Date();
    expiry.setFullYear(expiry.getFullYear() + AUTOPAY_VALIDITY_YEARS);

    const { data } = await axios.post(`${cashfreeBase()}/subscriptions`, {
      subscription_id: subscriptionId,
      customer_details: {
        customer_name: customer.name || 'Customer',
        customer_email: customer.email || 'customer@ppokket.com',
        customer_phone: customer.phone,
        ...(bank?.accountNumber && bank?.ifsc ? {
          customer_bank_account_number: String(bank.accountNumber),
          customer_bank_ifsc: String(bank.ifsc).toUpperCase(),
          ...(bank.holderName ? { customer_bank_account_holder_name: String(bank.holderName).slice(0, 40) } : {}),
          ...(BANK_ACCOUNT_TYPES.includes(accountType) ? { customer_bank_account_type: accountType } : {}),
        } : {}),
      },
      plan_details: {
        plan_name: 'Ppokket EMI Auto-Pay',
        plan_type: 'ON_DEMAND',
        plan_currency: 'INR',
        plan_max_amount: autoPayMaxAmount(),
        plan_note: 'On-demand auto-debit of loan EMIs',
      },
      authorization_details: {
        authorization_amount: 1,
        authorization_amount_refund: true,
        payment_methods: AUTOPAY_METHODS,
      },
      subscription_meta: {
        return_url: returnUrl,
        notification_channel: ['SMS', 'EMAIL'],
      },
      subscription_expiry_time: expiry.toISOString(),
    }, subscriptionConfig());

    if (!data?.subscription_session_id) throw new Error('Cashfree did not return a subscription session');
    return data;
  },

  // The subscription as Cashfree has it now, with a fresh subscription_session_id.
  // Resolves to null when Cashfree has no subscription with this id.
  async fetch(subscriptionId) {
    try {
      const { data } = await axios.get(`${cashfreeBase()}/subscriptions/${encodeURIComponent(subscriptionId)}`, subscriptionConfig());
      return data;
    } catch (err) {
      if (cashfreeErrorCode(err) === 'subscription_not_found') return null;
      throw err;
    }
  },

  // action: 'CANCEL' ends the mandate; 'ACTIVATE' lifts the hold Cashfree puts
  // on a subscription after a failed charge.
  async manage(subscriptionId, action) {
    const { data } = await axios.post(
      `${cashfreeBase()}/subscriptions/${encodeURIComponent(subscriptionId)}/manage`,
      { subscription_id: subscriptionId, action },
      subscriptionConfig()
    );
    return data;
  },

  // Raises one debit against an authorised mandate. `scheduleDate` is the
  // YYYY-MM-DD day it should be presented to the bank — Cashfree accepts
  // tomorrow up to 14 days out (a debit can't be presented the day it is
  // raised). The result arrives later by webhook; see utils/autoPay.js.
  async charge({ subscriptionId, paymentId, amount, scheduleDate, remarks }) {
    const { data } = await axios.post(`${cashfreeBase()}/subscriptions/pay`, {
      subscription_id: subscriptionId,
      payment_id: paymentId,
      payment_type: 'CHARGE',
      payment_amount: toRupees(amount),
      // Only the date part counts. Midday IST is the same calendar day in UTC.
      payment_schedule_date: `${scheduleDate}T12:00:00+05:30`,
      payment_remarks: remarks,
    }, subscriptionConfig());
    return data;
  },

  // One debit as Cashfree has it now. Resolves to null when Cashfree has no
  // such payment — i.e. the charge never reached it.
  async fetchPayment(subscriptionId, paymentId) {
    try {
      const { data } = await axios.get(
        `${cashfreeBase()}/subscriptions/${encodeURIComponent(subscriptionId)}/payments/${encodeURIComponent(paymentId)}`,
        subscriptionConfig()
      );
      return data;
    } catch (err) {
      if (['payment_id_not_found', 'subscription_not_found'].includes(cashfreeErrorCode(err))) return null;
      throw err;
    }
  },

  // Sends a collected debit (or part of it) back to the customer. `paymentMode`
  // is the mandate's method: Cashfree refunds UPI debits at STANDARD speed only
  // and eNACH ones at INSTANT only. Returns Cashfree's refund.
  // (Cashfree's own cf_payment_id is optional here and deliberately left out:
  // it is a 19-digit integer, which JSON numbers in JS can't carry exactly.)
  async refund({ subscriptionId, paymentId, amount, note, paymentMode }) {
    const speed = { upi: 'STANDARD', enach: 'INSTANT', pnach: 'INSTANT' }[String(paymentMode || '').toLowerCase()];
    const { data } = await axios.post(`${cashfreeBase()}/subscriptions/${encodeURIComponent(subscriptionId)}/refunds`, {
      subscription_id: subscriptionId,
      payment_id: paymentId,
      refund_id: `ref_${paymentId.replace('auto_', '')}_${Date.now()}`,
      refund_amount: toRupees(amount),
      refund_note: note,
      ...(speed ? { refund_speed: speed } : {}),
    }, subscriptionConfig());

    if (!data?.refund_id) throw new Error('Invalid refund response from Cashfree');
    return data;
  },

  // Withdraws a debit that has been scheduled but not yet presented.
  async cancelPayment(subscriptionId, paymentId) {
    const { data } = await axios.post(
      `${cashfreeBase()}/subscriptions/${encodeURIComponent(subscriptionId)}/payments/${encodeURIComponent(paymentId)}/manage`,
      { subscription_id: subscriptionId, payment_id: paymentId, action: 'CANCEL' },
      subscriptionConfig()
    );
    return data;
  },
};

// ── Razorpay ──────────────────────────────────────────────────────────────────
const RAZORPAY_API = 'https://api.razorpay.com/v1';
const razorpayConfig = () => ({
  timeout: TIMEOUT_MS,
  auth: { username: process.env.RAZORPAY_KEY_ID, password: process.env.RAZORPAY_KEY_SECRET },
});
const toPaise = (amount) => Math.round(parseFloat(amount) * 100);

const razorpay = {
  // Returns { orderId, checkout }. `notes` values must be strings.
  async createOrder({ reference, amount, notes }) {
    const { data } = await axios.post(`${RAZORPAY_API}/orders`, {
      amount: toPaise(amount),
      currency: 'INR',
      receipt: `rcpt_${reference}_${Date.now()}`, // Razorpay caps this at 40 chars
      notes,
    }, razorpayConfig());

    if (!data?.id) throw new Error('Razorpay did not return an order id');
    return { orderId: data.id, checkout: { key_id: process.env.RAZORPAY_KEY_ID, amount_paise: data.amount } };
  },

  // Checkout signs "<order_id>|<payment_id>" with the key secret when a payment succeeds.
  verifySignature(orderId, paymentId, signature) {
    const expected = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET || '')
      .update(`${orderId}|${paymentId}`)
      .digest('hex');
    return safeEqual(expected, signature);
  },

  // Webhooks are signed over the raw request body with the webhook secret
  // (a separate secret from the API key, set on the Razorpay dashboard).
  verifyWebhookSignature(rawBody, signature) {
    const expected = crypto
      .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET || '')
      .update(rawBody)
      .digest('hex');
    return safeEqual(expected, signature);
  },

  // An order is paid once one of its payments is captured. An account that
  // isn't set to auto-capture leaves a successful payment at 'authorized' —
  // and Razorpay refunds it if nobody captures — so it is captured here.
  async fetchPayment(orderId) {
    const listPayments = async () => {
      const { data } = await axios.get(`${RAZORPAY_API}/orders/${orderId}/payments`, razorpayConfig());
      return data?.items || [];
    };
    const capturedIn = (payments) => payments.find((p) => p.status === 'captured');

    const payments = await listPayments();
    const captured = capturedIn(payments);
    if (captured) return { paid: true, paymentId: captured.id };

    const authorized = payments.find((p) => p.status === 'authorized');
    if (!authorized) return { paid: false };

    try {
      const { data } = await axios.post(
        `${RAZORPAY_API}/payments/${authorized.id}/capture`,
        { amount: authorized.amount, currency: authorized.currency },
        razorpayConfig()
      );
      if (data?.status === 'captured') return { paid: true, paymentId: data.id };
    } catch (err) {
      // A webhook / second verify may have captured it between the two calls — look again.
      const retry = capturedIn(await listPayments());
      if (retry) return { paid: true, paymentId: retry.id };
      throw err;
    }
    return { paid: false };
  },

  // Returns the gateway's refund id.
  async refund({ paymentId, amount, note }) {
    const { data } = await axios.post(`${RAZORPAY_API}/payments/${paymentId}/refund`, {
      amount: toPaise(amount),
      speed: 'normal',
      notes: { reason: String(note || '').slice(0, 250) },
    }, razorpayConfig());

    if (!data?.id) throw new Error('Invalid refund response from Razorpay');
    return data.id;
  },

  // Throws unless Razorpay accepts the configured keys.
  async checkCredentials() {
    await axios.get(`${RAZORPAY_API}/orders`, { ...razorpayConfig(), params: { count: 1 } });
  },
};

const clients = { cashfree, razorpay };

module.exports = {
  GATEWAYS, GATEWAY_NAMES,
  isConfigured, describeGateway, isAuthError, gatewayMode, mockPaymentsAllowed, toRupees,
  getSelectedGateway, setSelectedGateway, pickGatewayForOrder, gatewayOfOrder,
  cashfree, razorpay, clients,
  cashfreeSubscriptions, cashfreeErrorCode, cashfreeErrorMessage, autoPayMode, autoPayMaxAmount,
};
