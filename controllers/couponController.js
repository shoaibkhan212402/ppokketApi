const { pool } = require('../config/db');
const { auditLog } = require('../utils/audit');
const { sendNotification } = require('../utils/fcm');
const { listCoupons, createCoupon, updateCoupon, deleteCoupon, discountText, APPLIES_TO } = require('../utils/coupons');

// Admin → Settings → Coupons (super admin only). The rules for using a coupon
// live in utils/coupons.js.

const fail = (res, err, where) => {
  if (err.isValidation) return res.status(err.status || 400).json({ success: false, message: err.message });
  console.error(`[${where}]`, err);
  return res.status(500).json({ success: false, message: err.message });
};

// Tells the one customer a coupon is for (in-app notification + push).
const notifyCustomer = async (coupon) => {
  if (!coupon.only_mobile) return false;
  const [[user]] = await pool.query('SELECT id, fcm_token FROM users WHERE mobile = ? OR mobile = ? LIMIT 1', [coupon.only_mobile, `+91${coupon.only_mobile}`]);
  if (!user) return false;
  const title = '🎁 A coupon for you';
  const message = `Use code ${coupon.code} — ${coupon.title || `${discountText(coupon)} on ${APPLIES_TO[coupon.applies_to].toLowerCase()}`} — when you request the money of your approved loan (My Loans → Request Withdrawal).`
    + (coupon.valid_until ? ` Valid till ${coupon.valid_until}.` : '');
  await pool.query('INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, ?)', [user.id, title, message, 'loan']);
  // Opens My Loans (older apps know it as Profile → LoanHistory)
  if (user.fcm_token) sendNotification(user.fcm_token, title, message, { screen: 'Profile', params: { screen: 'LoanHistory' } }).catch(() => {});
  return true;
};

// GET /api/admin/coupons
const getCoupons = async (req, res) => {
  try {
    res.json({ success: true, coupons: await listCoupons() });
  } catch (err) {
    fail(res, err, 'getCoupons');
  }
};

// POST /api/admin/coupons   { ...coupon, notify?: true }
const addCoupon = async (req, res) => {
  try {
    const id = await createCoupon(req.body, req.admin?.id);
    const coupon = (await listCoupons()).find((c) => c.id === id);
    const notified = req.body?.notify ? await notifyCustomer(coupon) : false;
    await auditLog({ req, action: 'coupon_created', entityType: 'setting', entityId: id, details: { ...coupon, notified } });
    res.status(201).json({
      success: true,
      message: `Coupon ${coupon.code} created${notified ? ' and sent to the customer' : ''}.`,
      coupon,
    });
  } catch (err) {
    fail(res, err, 'addCoupon');
  }
};

// PUT /api/admin/coupons/:id
const editCoupon = async (req, res) => {
  try {
    const id = Number(req.params.id);
    await updateCoupon(id, req.body);
    const coupon = (await listCoupons()).find((c) => c.id === id);
    const notified = req.body?.notify ? await notifyCustomer(coupon) : false;
    await auditLog({ req, action: 'coupon_updated', entityType: 'setting', entityId: id, details: { ...coupon, notified } });
    res.json({ success: true, message: `Coupon ${coupon.code} saved${notified ? ' and sent to the customer' : ''}.`, coupon });
  } catch (err) {
    fail(res, err, 'editCoupon');
  }
};

// DELETE /api/admin/coupons/:id   (only a coupon nobody has used)
const removeCoupon = async (req, res) => {
  try {
    const id = Number(req.params.id);
    await deleteCoupon(id);
    await auditLog({ req, action: 'coupon_deleted', entityType: 'setting', entityId: id });
    res.json({ success: true, message: 'Coupon deleted.' });
  } catch (err) {
    fail(res, err, 'removeCoupon');
  }
};

module.exports = { getCoupons, addCoupon, editCoupon, removeCoupon };
