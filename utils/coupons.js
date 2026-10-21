const { pool } = require('../config/db');
const {
  loadChargeContext, chargesForLoan, disbursalCharges, processingFeeGstPct, processingFeeAtDisbursal,
} = require('./loanCharges');

// Coupon codes (Admin → Settings → Coupons). A customer types one when asking
// for the money of an approved loan (the withdrawal request) and it takes a
// flat amount or a percentage off the loan's FEES — never the principal or the
// interest:
//   processing_fee  the processing fee (+ its GST)
//   charges         the extra charges of Admin → Charges (at disbursal and in
//                   every EMI: Post Service Fee, Tech Fee, GST …)
//   all_fees        both
// What it takes off the amount deducted at disbursal is paid out instead;
// what it takes off the instalments is taken off those EMIs (they are not due
// yet — the loan has not been disbursed). Percent coupons reduce every fee by
// the same share; flat coupons are used up on the money deducted at disbursal
// first, then on the EMIs in order.
//
// Two tables of their own, created by the first use (no hand-run SQL):
// `coupons` (the codes) and `loan_coupons` (which loan used which code and
// what it took off). A coupon on a loan that is later rejected stops counting
// towards its limits.

const CREATE_COUPONS_SQL = `
  CREATE TABLE IF NOT EXISTS coupons (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    code            VARCHAR(20) NOT NULL,
    title           VARCHAR(80) DEFAULT NULL,
    applies_to      VARCHAR(20) NOT NULL,
    discount_type   VARCHAR(10) NOT NULL,
    discount_value  DECIMAL(12,2) NOT NULL,
    max_discount    DECIMAL(12,2) DEFAULT NULL,
    min_loan_amount DECIMAL(12,2) DEFAULT NULL,
    valid_from      DATE DEFAULT NULL,
    valid_until     DATE DEFAULT NULL,
    usage_limit     INT DEFAULT NULL,
    per_user_limit  INT NOT NULL DEFAULT 1,
    only_mobile     VARCHAR(10) DEFAULT NULL,
    is_active       TINYINT(1) NOT NULL DEFAULT 1,
    created_by      INT DEFAULT NULL,
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_coupons_code (code)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`;

const CREATE_LOAN_COUPONS_SQL = `
  CREATE TABLE IF NOT EXISTS loan_coupons (
    loan_id         INT NOT NULL PRIMARY KEY,
    coupon_id       INT NOT NULL,
    code            VARCHAR(20) NOT NULL,
    title           VARCHAR(80) DEFAULT NULL,
    user_id         INT NOT NULL,
    discount_total  DECIMAL(12,2) NOT NULL,
    off_disbursal   DECIMAL(12,2) NOT NULL DEFAULT 0,
    off_emis        DECIMAL(12,2) NOT NULL DEFAULT 0,
    detail          TEXT,
    applied_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    KEY idx_loan_coupons_coupon (coupon_id),
    KEY idx_loan_coupons_user (user_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`;

const APPLIES_TO = {
  processing_fee: 'Processing fee',
  charges: 'Extra charges',
  all_fees: 'Processing fee + extra charges',
};

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const invalid = (message, status = 400) => Object.assign(new Error(message), { isValidation: true, status });
const isMissingTable = (err) => err?.code === 'ER_NO_SUCH_TABLE';

// Creates both tables if needed. Call it BEFORE opening a transaction: a
// CREATE TABLE commits whatever transaction is open.
let tablesReady = null;
const ensureCouponTables = () => {
  tablesReady = tablesReady || Promise.all([pool.query(CREATE_COUPONS_SQL), pool.query(CREATE_LOAN_COUPONS_SQL)])
    .then(() => true)
    .catch((err) => {
      console.error('[coupons] could not create the coupon tables:', err.message);
      tablesReady = null;
      return false;
    });
  return tablesReady;
};

const cleanCode = (value) => String(value ?? '').trim().toUpperCase().replace(/\s+/g, '');

const dateOrNull = (value, label) => {
  if (value === undefined || value === null || value === '') return null;
  const text = String(value).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(Date.parse(`${text}T00:00:00Z`))) throw invalid(`${label} must be a date (YYYY-MM-DD).`);
  return text;
};
const moneyOrNull = (value, label) => {
  if (value === undefined || value === null || value === '') return null;
  const n = round2(value);
  if (!Number.isFinite(n) || n <= 0) throw invalid(`${label} must be more than ₹0.`);
  return n;
};
const countOrNull = (value, label) => {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw invalid(`${label} must be a whole number, at least 1.`);
  return n;
};

// What the admin form sent → what is stored. Throws `isValidation` errors.
const cleanCoupon = (input) => {
  if (!input || typeof input !== 'object') throw invalid('Coupon details are missing.');
  const code = cleanCode(input.code);
  if (!/^[A-Z0-9]{4,20}$/.test(code)) throw invalid('Coupon code: 4 to 20 letters or digits, no spaces (e.g. NOFEE50).');
  const applies_to = String(input.applies_to || '');
  if (!APPLIES_TO[applies_to]) throw invalid('Choose what the coupon takes money off.');
  const discount_type = String(input.discount_type || '');
  if (!['percent', 'flat'].includes(discount_type)) throw invalid('Choose a flat amount (₹) or a percentage (%).');
  const discount_value = round2(input.discount_value);
  if (!Number.isFinite(discount_value) || discount_value <= 0) throw invalid('Enter the discount (more than 0).');
  if (discount_type === 'percent' && discount_value > 100) throw invalid('A percentage discount cannot be more than 100%.');
  const valid_from = dateOrNull(input.valid_from, 'Valid from');
  const valid_until = dateOrNull(input.valid_until, 'Valid until');
  if (valid_from && valid_until && valid_until < valid_from) throw invalid('"Valid until" is before "Valid from".');
  let only_mobile = String(input.only_mobile ?? '').replace(/\D/g, '');
  if (only_mobile.length === 12 && only_mobile.startsWith('91')) only_mobile = only_mobile.slice(2);
  if (only_mobile && !/^[6-9]\d{9}$/.test(only_mobile)) throw invalid('"Only for customer" must be a 10-digit mobile number.');

  return {
    code,
    title: String(input.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 80) || null,
    applies_to,
    discount_type,
    discount_value,
    max_discount: discount_type === 'percent' ? moneyOrNull(input.max_discount, 'Maximum discount') : null,
    min_loan_amount: moneyOrNull(input.min_loan_amount, 'Minimum loan amount'),
    valid_from,
    valid_until,
    usage_limit: countOrNull(input.usage_limit, 'Total uses'),
    per_user_limit: countOrNull(input.per_user_limit, 'Uses per customer') || 1,
    only_mobile: only_mobile || null,
    is_active: input.is_active === false || input.is_active === 0 ? 0 : 1,
  };
};

// "₹200 off" / "50% off (up to ₹500)"
const discountText = (c) => (c.discount_type === 'percent'
  ? `${Number(c.discount_value)}% off${c.max_discount ? ` (up to ₹${Number(c.max_discount)})` : ''}`
  : `₹${Number(c.discount_value)} off`);

const shapeCoupon = (row) => row && ({
  id: row.id,
  code: row.code,
  title: row.title,
  applies_to: row.applies_to,
  applies_to_label: APPLIES_TO[row.applies_to] || row.applies_to,
  discount_type: row.discount_type,
  discount_value: Number(row.discount_value),
  max_discount: row.max_discount == null ? null : Number(row.max_discount),
  min_loan_amount: row.min_loan_amount == null ? null : Number(row.min_loan_amount),
  valid_from: row.valid_from ? String(row.valid_from instanceof Date ? row.valid_from.toISOString() : row.valid_from).slice(0, 10) : null,
  valid_until: row.valid_until ? String(row.valid_until instanceof Date ? row.valid_until.toISOString() : row.valid_until).slice(0, 10) : null,
  usage_limit: row.usage_limit,
  per_user_limit: row.per_user_limit,
  only_mobile: row.only_mobile,
  is_active: !!row.is_active,
  discount_text: discountText(row),
  uses: Number(row.uses || 0),
  total_discount: round2(row.total_discount || 0),
  created_at: row.created_at,
});

// Uses that count: the loan was not rejected afterwards.
const USES_SQL = `
  SELECT lc.coupon_id, COUNT(*) AS uses, SUM(lc.discount_total) AS total_discount
    FROM loan_coupons lc JOIN loans l ON l.id = lc.loan_id
   WHERE l.status <> 'rejected'
   GROUP BY lc.coupon_id`;

const listCoupons = async () => {
  await ensureCouponTables();
  const [rows] = await pool.query(
    `SELECT c.*, u.uses, u.total_discount FROM coupons c LEFT JOIN (${USES_SQL}) u ON u.coupon_id = c.id ORDER BY c.created_at DESC, c.id DESC`
  );
  return rows.map(shapeCoupon);
};

const createCoupon = async (input, adminId) => {
  const c = cleanCoupon(input);
  if (!(await ensureCouponTables())) throw invalid('Coupons cannot be saved right now. Please try again later.', 503);
  try {
    const [r] = await pool.query(
      `INSERT INTO coupons (code, title, applies_to, discount_type, discount_value, max_discount, min_loan_amount,
                            valid_from, valid_until, usage_limit, per_user_limit, only_mobile, is_active, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [c.code, c.title, c.applies_to, c.discount_type, c.discount_value, c.max_discount, c.min_loan_amount,
        c.valid_from, c.valid_until, c.usage_limit, c.per_user_limit, c.only_mobile, c.is_active, adminId || null]
    );
    return r.insertId;
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') throw invalid(`The code ${c.code} already exists.`, 409);
    throw err;
  }
};

const updateCoupon = async (id, input) => {
  const c = cleanCoupon(input);
  await ensureCouponTables();
  try {
    const [r] = await pool.query(
      `UPDATE coupons SET code = ?, title = ?, applies_to = ?, discount_type = ?, discount_value = ?, max_discount = ?,
              min_loan_amount = ?, valid_from = ?, valid_until = ?, usage_limit = ?, per_user_limit = ?, only_mobile = ?, is_active = ?
        WHERE id = ?`,
      [c.code, c.title, c.applies_to, c.discount_type, c.discount_value, c.max_discount, c.min_loan_amount,
        c.valid_from, c.valid_until, c.usage_limit, c.per_user_limit, c.only_mobile, c.is_active, id]
    );
    if (!r.affectedRows) throw invalid('Coupon not found.', 404);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') throw invalid(`The code ${c.code} already exists.`, 409);
    throw err;
  }
};

// A coupon that was ever used is kept (loans point to it): it can be switched off.
const deleteCoupon = async (id) => {
  await ensureCouponTables();
  const [[used]] = await pool.query('SELECT COUNT(*) AS n FROM loan_coupons WHERE coupon_id = ?', [id]);
  if (used.n > 0) throw invalid('This coupon has been used, so it cannot be deleted. Switch it off instead.', 409);
  const [r] = await pool.query('DELETE FROM coupons WHERE id = ?', [id]);
  if (!r.affectedRows) throw invalid('Coupon not found.', 404);
};

// ── Pricing a coupon on one loan ───────────────────────────────────────────

const loadSettings = async (conn) => {
  const [rows] = await conn.query('SELECT setting_key, setting_value FROM system_settings');
  return Object.fromEntries(rows.map((r) => [r.setting_key, r.setting_value]));
};

// The fees of an approved loan a coupon can reduce, as parts:
// { where: 'disbursal' | 'emi', no?: instalment, fee: 'processing_fee' | 'charges', label, amount }
const feeParts = async (conn, loan) => {
  const settings = await loadSettings(conn);
  const ctx = await loadChargeContext(conn);
  const charges = chargesForLoan(ctx, loan);
  const [emis] = await conn.query(
    'SELECT installment_no, emi_amount, principal_amount, interest_amount FROM emi_schedule WHERE loan_id = ? ORDER BY installment_no',
    [loan.id]
  );
  const fee = parseFloat(loan.processing_fee || 0);
  const feeWithGst = round2(fee + round2(fee * processingFeeGstPct(settings) / 100));
  const feeInFirstEmi = loan.processing_fee_in_first_emi ? feeWithGst : 0;
  const parts = [];

  const pfAtDisbursal = processingFeeAtDisbursal(loan, settings);
  if (pfAtDisbursal > 0) parts.push({ where: 'disbursal', fee: 'processing_fee', label: 'Processing fee + GST', amount: pfAtDisbursal });
  const extrasAtDisbursal = disbursalCharges(charges, loan.amount).total;
  if (extrasAtDisbursal > 0) parts.push({ where: 'disbursal', fee: 'charges', label: 'Charges at disbursal', amount: extrasAtDisbursal });

  for (const emi of emis) {
    const no = Number(emi.installment_no);
    const extra = round2(parseFloat(emi.emi_amount) - parseFloat(emi.principal_amount) - parseFloat(emi.interest_amount));
    if (extra <= 0) continue;
    const pf = no === 1 ? Math.min(feeInFirstEmi, extra) : 0;
    if (pf > 0) parts.push({ where: 'emi', no, fee: 'processing_fee', label: 'Processing fee + GST (1st EMI)', amount: round2(pf) });
    const rest = round2(extra - pf);
    if (rest > 0) parts.push({ where: 'emi', no, fee: 'charges', label: `EMI ${no} charges`, amount: rest });
  }
  return { parts, emis };
};

// Works out what `coupon` takes off a loan with these fee parts.
const priceCoupon = (coupon, parts) => {
  const wanted = parts.filter((p) => coupon.applies_to === 'all_fees' || p.fee === coupon.applies_to);
  const base = round2(wanted.reduce((sum, p) => sum + p.amount, 0));
  if (base <= 0) {
    throw invalid(coupon.applies_to === 'processing_fee'
      ? 'This coupon is for the processing fee, and this loan has none.'
      : 'This coupon is for extra charges, and this loan has none.');
  }
  const value = Number(coupon.discount_value);
  let total = coupon.discount_type === 'percent' ? round2(base * value / 100) : Math.min(round2(value), base);
  if (coupon.discount_type === 'percent' && coupon.max_discount != null) total = Math.min(total, round2(coupon.max_discount));
  total = round2(Math.min(total, base));

  // Share it out over the fee parts
  const off = wanted.map((p) => ({ ...p, off: 0 }));
  if (coupon.discount_type === 'percent') {
    let given = 0;
    off.forEach((p, i) => {
      p.off = i === off.length - 1 ? round2(total - given) : round2(p.amount * total / base);
      p.off = Math.min(p.amount, Math.max(0, p.off));
      given = round2(given + p.off);
    });
  } else {
    let left = total;
    for (const p of off) { // disbursal parts come first, then EMIs in order
      p.off = round2(Math.min(p.amount, left));
      left = round2(left - p.off);
    }
  }
  const used = off.filter((p) => p.off > 0);
  const offDisbursal = round2(used.filter((p) => p.where === 'disbursal').reduce((s, p) => s + p.off, 0));
  const byInstalment = {};
  for (const p of used.filter((x) => x.where === 'emi')) byInstalment[p.no] = round2((byInstalment[p.no] || 0) + p.off);
  return {
    discount_total: round2(offDisbursal + Object.values(byInstalment).reduce((s, v) => s + v, 0)),
    off_disbursal: offDisbursal,
    off_emis: round2(Object.values(byInstalment).reduce((s, v) => s + v, 0)),
    by_instalment: byInstalment,
    parts: used.map(({ label, off: amount }) => ({ label, amount })),
  };
};

const todayIst = () => new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);

// Can this customer use `coupon` on `loan` now? Throws a message they can read.
const checkCoupon = async (conn, coupon, loan, user) => {
  const today = todayIst();
  if (!coupon || !coupon.is_active) throw invalid('This coupon code is not valid.');
  const from = coupon.valid_from ? String(coupon.valid_from instanceof Date ? coupon.valid_from.toISOString() : coupon.valid_from).slice(0, 10) : null;
  const until = coupon.valid_until ? String(coupon.valid_until instanceof Date ? coupon.valid_until.toISOString() : coupon.valid_until).slice(0, 10) : null;
  if (from && today < from) throw invalid('This coupon is not active yet.');
  if (until && today > until) throw invalid('This coupon has expired.');
  if (coupon.only_mobile && String(user?.mobile || '').replace(/\D/g, '').slice(-10) !== coupon.only_mobile) {
    throw invalid('This coupon code is not valid for your account.');
  }
  if (coupon.min_loan_amount != null && parseFloat(loan.amount) < parseFloat(coupon.min_loan_amount)) {
    throw invalid(`This coupon needs a loan of at least ₹${Number(coupon.min_loan_amount).toLocaleString('en-IN')}.`);
  }
  const [[all]] = await conn.query(
    `SELECT COUNT(*) AS n FROM loan_coupons lc JOIN loans l ON l.id = lc.loan_id
      WHERE lc.coupon_id = ? AND l.status <> 'rejected' AND lc.loan_id <> ?`,
    [coupon.id, loan.id]
  );
  if (coupon.usage_limit != null && all.n >= coupon.usage_limit) throw invalid('This coupon has been fully used.');
  const [[mine]] = await conn.query(
    `SELECT COUNT(*) AS n FROM loan_coupons lc JOIN loans l ON l.id = lc.loan_id
      WHERE lc.coupon_id = ? AND lc.user_id = ? AND l.status <> 'rejected' AND lc.loan_id <> ?`,
    [coupon.id, loan.user_id, loan.id]
  );
  if (mine.n >= (coupon.per_user_limit || 1)) throw invalid('You have already used this coupon.');
};

// Shared by preview and apply: the coupon row, the loan, and what it takes off.
const evaluate = async (conn, { loanId, userId, code, lock = false }) => {
  const clean = cleanCode(code);
  if (!clean) throw invalid('Enter a coupon code.');
  const [[loan]] = await conn.query(
    `SELECT *, UNIX_TIMESTAMP(approved_at) AS approved_ts FROM loans WHERE id = ? AND user_id = ?${lock ? ' FOR UPDATE' : ''}`,
    [loanId, userId]
  );
  if (!loan) throw invalid('Loan not found.', 404);
  if (loan.status !== 'approved') throw invalid('A coupon can only be used while the loan is approved and the money has not been requested yet.');
  const [[existing]] = await conn.query('SELECT code FROM loan_coupons WHERE loan_id = ?', [loanId]);
  if (existing) throw invalid(`Coupon ${existing.code} is already applied to this loan.`);
  const [[coupon]] = await conn.query(`SELECT * FROM coupons WHERE code = ?${lock ? ' FOR UPDATE' : ''}`, [clean]);
  const [[user]] = await conn.query('SELECT mobile FROM users WHERE id = ?', [userId]);
  await checkCoupon(conn, coupon, loan, user);
  const { parts, emis } = await feeParts(conn, loan);
  return { loan, coupon, emis, pricing: priceCoupon(coupon, parts) };
};

// What the coupon would do, for the customer's screen. Nothing is saved.
const previewCoupon = async ({ loanId, userId, code }) => {
  if (!(await ensureCouponTables())) throw invalid('Coupons are not available right now.', 503);
  const { loan, coupon, emis, pricing } = await evaluate(pool, { loanId, userId, code });
  const settings = await loadSettings(pool);
  const ctx = await loadChargeContext(pool);
  const netBefore = round2(parseFloat(loan.amount) - processingFeeAtDisbursal(loan, settings) - disbursalCharges(chargesForLoan(ctx, loan), loan.amount).total);
  const first = emis[0];
  return {
    code: coupon.code,
    title: coupon.title || `${discountText(coupon)} on ${APPLIES_TO[coupon.applies_to].toLowerCase()}`,
    applies_to: coupon.applies_to,
    discount_text: discountText(coupon),
    ...pricing,
    you_receive_before: Math.max(0, netBefore),
    you_receive_after: Math.max(0, round2(netBefore + pricing.off_disbursal)),
    first_emi_before: first ? round2(first.emi_amount) : null,
    first_emi_after: first ? round2(parseFloat(first.emi_amount) - (pricing.by_instalment[first.installment_no] || 0)) : null,
    total_payable_before: round2(loan.total_payable),
    total_payable_after: round2(parseFloat(loan.total_payable) - pricing.off_emis),
  };
};

// Applies the coupon inside the caller's transaction (on `conn`, with the loan
// about to be moved to withdrawal_requested). Call ensureCouponTables() before
// the transaction is opened. Returns what was applied.
const applyCoupon = async (conn, { loanId, userId, code }) => {
  const { loan, coupon, pricing } = await evaluate(conn, { loanId, userId, code, lock: true });
  const title = coupon.title || `${discountText(coupon)} on ${APPLIES_TO[coupon.applies_to].toLowerCase()}`;
  await conn.query(
    `INSERT INTO loan_coupons (loan_id, coupon_id, code, title, user_id, discount_total, off_disbursal, off_emis, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [loan.id, coupon.id, coupon.code, title, userId, pricing.discount_total, pricing.off_disbursal, pricing.off_emis,
      JSON.stringify({ by_instalment: pricing.by_instalment, parts: pricing.parts, applies_to: coupon.applies_to, discount_type: coupon.discount_type, discount_value: Number(coupon.discount_value) })]
  );
  for (const [no, amount] of Object.entries(pricing.by_instalment)) {
    await conn.query(
      "UPDATE emi_schedule SET emi_amount = ROUND(emi_amount - ?, 2) WHERE loan_id = ? AND installment_no = ? AND status <> 'paid'",
      [amount, loan.id, Number(no)]
    );
    // The instalment's charge break-up gets the discount as its own line, so
    // the named charges still add up to what the EMI holds
    try {
      await conn.query(
        `INSERT INTO emi_charge_items (loan_id, installment_no, charge_id, name, type, value, percent_of, amount)
         VALUES (?, ?, 'coupon', ?, 'flat', ?, 'amount', ?)`,
        [loan.id, Number(no), `Coupon ${coupon.code}`.slice(0, 40), -amount, -amount]
      );
    } catch (err) {
      if (!isMissingTable(err)) throw err;
    }
  }
  if (pricing.off_emis > 0) {
    await conn.query('UPDATE loans SET total_payable = ROUND(total_payable - ?, 2) WHERE id = ?', [pricing.off_emis, loan.id]);
  }
  return { code: coupon.code, title, ...pricing };
};

// The coupon a loan carries, for several loans → Map(loanId → coupon)
const couponsOf = async (loanIds) => {
  const ids = [...new Set(loanIds.filter((id) => id != null))];
  if (!ids.length) return new Map();
  try {
    const [rows] = await pool.query(
      'SELECT loan_id, code, title, discount_total, off_disbursal, off_emis, applied_at FROM loan_coupons WHERE loan_id IN (?)',
      [ids]
    );
    return new Map(rows.map((r) => [r.loan_id, {
      code: r.code, title: r.title, discount_total: round2(r.discount_total),
      off_disbursal: round2(r.off_disbursal), off_emis: round2(r.off_emis), applied_at: r.applied_at,
    }]));
  } catch (err) {
    if (!isMissingTable(err)) console.error('[coupons] could not read loan coupons:', err.message);
    return new Map();
  }
};

// Adds `coupon` (or null) to loan rows, and folds it into `loan.charges`
// (what reaches the bank account, the EMI charges over the loan).
const attachCoupons = async (loans, idKey = 'id') => {
  const byLoan = await couponsOf(loans.map((l) => l[idKey]));
  for (const loan of loans) {
    const coupon = byLoan.get(loan[idKey]) || null;
    loan.coupon = coupon;
    if (coupon && loan.charges) {
      loan.charges = {
        ...loan.charges,
        net_disbursal: round2((loan.charges.net_disbursal || 0) + coupon.off_disbursal),
        emi_total: Math.max(0, round2((loan.charges.emi_total || 0) - coupon.off_emis)),
        coupon_off_disbursal: coupon.off_disbursal,
      };
    }
  }
  return loans;
};

// For disbursal: how much less is deducted from this loan's payout.
const couponOffDisbursal = async (conn, loanId) => {
  try {
    const [[row]] = await conn.query('SELECT code, off_disbursal FROM loan_coupons WHERE loan_id = ?', [loanId]);
    return row ? { code: row.code, amount: round2(row.off_disbursal) } : null;
  } catch (err) {
    if (isMissingTable(err)) return null;
    throw err;
  }
};

module.exports = {
  APPLIES_TO, CREATE_COUPONS_SQL, CREATE_LOAN_COUPONS_SQL,
  ensureCouponTables, cleanCoupon, cleanCode, listCoupons, createCoupon, updateCoupon, deleteCoupon,
  priceCoupon, previewCoupon, applyCoupon, attachCoupons, couponOffDisbursal, discountText,
};
