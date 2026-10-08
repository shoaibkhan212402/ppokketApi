const crypto = require('crypto');
const { pool } = require('../config/db');

// Charges the super admin defines on top of the processing fee (Admin → Charges).
// Each one is a flat amount or a percentage, taken at one of two moments:
//   'disbursal'  once, out of the amount sent to the customer
//                (a percentage is of the loan amount)
//   'emi'        with every instalment, added to it
//                (a percentage is of that instalment's principal + interest)
//
// A loan keeps the charges that were in force when it was approved: that is
// what the customer was shown before accepting the agreement, and its EMI
// charges are written into the instalment amounts (emi_schedule.emi_amount)
// right then. Editing the list later only affects loans approved afterwards.
//
// "In force when it was approved" is answered without a column per loan: every
// save is kept as a dated version in one system_settings row, and a loan is
// matched to a version through its approved_at. Both sides of that comparison
// are the database's own clock in epoch seconds (UNIX_TIMESTAMP) — never a
// parsed date — so the connection's time-zone setting cannot shift it.

const SETTING_KEY = 'loan_charges';
const MAX_CHARGES = 10;
const MAX_VERSIONS = 40;
const MAX_FLAT = 1000000;
// Statuses in which a loan's terms have been fixed by an approval.
const APPROVED_STATUSES = ['approved', 'withdrawal_requested', 'disbursed', 'closed'];

const round2 = (n) => Math.round(n * 100) / 100;

const invalid = (message) => Object.assign(new Error(message), { isValidation: true });

// Turns what the admin form sent into the list that is stored. Throws an
// error flagged `isValidation` (safe to show) when something is wrong.
const cleanCharges = (input) => {
  if (!Array.isArray(input)) throw invalid('Charges must be a list');
  if (input.length > MAX_CHARGES) throw invalid(`At most ${MAX_CHARGES} charges can be set`);

  const names = new Set();
  return input.map((raw, i) => {
    const row = `Charge ${i + 1}`;
    const name = String(raw?.name ?? '').replace(/\s+/g, ' ').trim();
    if (name.length < 2 || name.length > 40) throw invalid(`${row}: the name must be 2 to 40 characters`);
    if (names.has(name.toLowerCase())) throw invalid(`"${name}" is listed twice — give each charge its own name`);
    names.add(name.toLowerCase());

    if (!['disbursal', 'emi'].includes(raw.applies_to)) throw invalid(`${name}: choose whether it is charged at disbursal or on every EMI`);
    if (!['flat', 'percent'].includes(raw.type)) throw invalid(`${name}: choose flat (₹) or percent (%)`);

    const value = round2(Number(raw.value));
    if (!Number.isFinite(value) || value <= 0) throw invalid(`${name}: enter an amount greater than 0`);
    if (raw.type === 'percent' && value > 100) throw invalid(`${name}: a percentage cannot be more than 100`);
    if (raw.type === 'flat' && value > MAX_FLAT) throw invalid(`${name}: the amount is too large`);

    const id = /^[a-z0-9]{4,16}$/.test(String(raw.id || '')) ? String(raw.id) : crypto.randomBytes(4).toString('hex');
    return { id, name, applies_to: raw.applies_to, type: raw.type, value, active: raw.active !== false && raw.active !== 0 };
  });
};

const parseVersions = (raw) => {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.versions) ? parsed.versions.filter((v) => Number.isFinite(v?.from) && Array.isArray(v?.charges)) : [];
  } catch (_) {
    return [];
  }
};

// The charges being applied at `ts` (database epoch seconds): the active ones
// of the newest version that had started by then.
const chargesAsOf = (versions, ts) => {
  let found = null;
  for (const v of versions) {
    if (v.from <= ts && (!found || v.from >= found.from)) found = v;
  }
  return found ? found.charges.filter((c) => c.active) : [];
};

// The list as the admin last saved it, switched-off charges included.
const latestCharges = (versions) => (versions.length ? versions[versions.length - 1].charges : []);

// { versions, now, settings } — everything needed to price loans for one request.
const loadChargeContext = async (conn = pool) => {
  const [[row]] = await conn.query(
    `SELECT (SELECT setting_value FROM system_settings WHERE setting_key = ?) AS versions,
            (SELECT setting_value FROM system_settings WHERE setting_key = 'gst_on_processing_fee') AS gst,
            UNIX_TIMESTAMP() AS now`,
    [SETTING_KEY]
  );
  return {
    versions: parseVersions(row?.versions),
    now: Number(row?.now),
    settings: { gst_on_processing_fee: row?.gst },
  };
};

// For use inside the transaction that approves a loan: holds the settings row
// so a save can't land between reading the versions and stamping approved_at.
const loadVersionsLocked = async (conn) => {
  const [rows] = await conn.query('SELECT setting_value FROM system_settings WHERE setting_key = ? FOR UPDATE', [SETTING_KEY]);
  return rows.length ? parseVersions(rows[0].setting_value) : [];
};

// The charges that belong to `loan` (needs its status and approved_ts =
// UNIX_TIMESTAMP(approved_at)). Not approved yet → what an approval would give
// it right now. Approved before any charges existed → none.
const chargesForLoan = ({ versions, now }, loan) => {
  if (APPROVED_STATUSES.includes(loan.status)) {
    return loan.approved_ts != null ? chargesAsOf(versions, Number(loan.approved_ts)) : [];
  }
  return chargesAsOf(versions, now);
};

// Saves a new list. It takes effect from the next second on, so a loan being
// approved in this very second is not re-priced after the fact.
const saveCharges = async (input, adminId = null) => {
  const charges = cleanCharges(input);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(
      'INSERT IGNORE INTO system_settings (setting_key, setting_value) VALUES (?, ?)',
      [SETTING_KEY, JSON.stringify({ versions: [] })]
    );
    const versions = await loadVersionsLocked(conn);
    // Saving an unchanged list adds nothing.
    if (JSON.stringify(latestCharges(versions)) !== JSON.stringify(charges)) {
      const [[{ now }]] = await conn.query('SELECT UNIX_TIMESTAMP() AS now');
      const next = [...versions, { from: Number(now) + 1, by: adminId, charges }].slice(-MAX_VERSIONS);
      await conn.query('UPDATE system_settings SET setting_value = ? WHERE setting_key = ?', [JSON.stringify({ versions: next }), SETTING_KEY]);
    }
    await conn.commit();
    return charges;
  } catch (err) {
    try { await conn.rollback(); } catch (_) {}
    throw err;
  } finally {
    conn.release();
  }
};

const priced = (charge, base) => ({
  id: charge.id,
  name: charge.name,
  type: charge.type,
  value: charge.value,
  amount: charge.type === 'percent' ? round2(base * charge.value / 100) : round2(charge.value),
});
const priceAll = (charges, appliesTo, base) => {
  const items = charges.filter((c) => c.applies_to === appliesTo).map((c) => priced(c, base));
  return { items, total: round2(items.reduce((sum, item) => sum + item.amount, 0)) };
};

// Taken once from the amount disbursed.
const disbursalCharges = (charges, loanAmount) => priceAll(charges, 'disbursal', parseFloat(loanAmount) || 0);
// Added to one instalment; `instalmentBase` is its principal + interest.
const emiCharges = (charges, instalmentBase) => priceAll(charges, 'emi', parseFloat(instalmentBase) || 0);

// GST % on the processing fee, read the way disburseLoan reads it: 18 unless
// the setting is there (a saved 0 means 0).
const processingFeeGstPct = (settings = {}) => {
  const value = settings.gst_on_processing_fee;
  return value === undefined || value === null || value === '' ? 18 : parseFloat(value);
};

// Processing fee + GST as disburseLoan deducts it (nothing when the fee is
// collected with the first EMI instead).
const processingFeeAtDisbursal = (loan, settings) => {
  if (loan.processing_fee_in_first_emi) return 0;
  const fee = parseFloat(loan.processing_fee || 0);
  return round2(fee + round2(fee * processingFeeGstPct(settings) / 100));
};

// The per-EMI charges added up over the whole loan. Worked out from the loan's
// own terms with the same schedule generator that wrote its instalments, so it
// matches them to the paisa.
const emiChargesOverLoan = (loan, charges, settings) => {
  if (!charges.some((c) => c.applies_to === 'emi')) return 0;
  if (loan.interest_rate == null || !loan.duration_months) return 0;
  const { generateEMISchedule } = require('./loanUtils'); // required here: loanUtils itself requires this file
  const rows = generateEMISchedule(
    { amount: loan.amount, interest_rate: loan.interest_rate, duration_months: loan.duration_months, emi_amount: loan.emi_amount, processing_fee: loan.processing_fee },
    null,
    { first_emi_principal_pct: loan.first_emi_pct, processing_fee_in_first_emi: !!loan.processing_fee_in_first_emi, gst_on_processing_fee: processingFeeGstPct(settings) },
    charges
  );
  return round2(rows.reduce((sum, row) => sum + row.emi_charges, 0));
};

// What a customer (or admin) is shown about one loan's charges. `settings` is
// the system_settings map (for the GST % on the processing fee). Pass the
// `schedule` when it has just been generated; otherwise it is derived.
const loanChargeSummary = (loan, charges, settings = {}, schedule = null) => {
  const amount = parseFloat(loan.amount) || 0;
  const disbursal = disbursalCharges(charges, amount);
  const processingFee = processingFeeAtDisbursal(loan, settings);
  return {
    disbursal: disbursal.items,
    disbursal_total: disbursal.total,
    // How each instalment is topped up; the rupee amounts are on the instalments.
    emi: charges.filter((c) => c.applies_to === 'emi').map(({ id, name, type, value }) => ({ id, name, type, value })),
    // All instalments together — part of total_payable, and not interest.
    emi_total: schedule
      ? round2(schedule.reduce((sum, row) => sum + (row.emi_charges || 0), 0))
      : emiChargesOverLoan(loan, charges, settings),
    processing_fee_deducted: processingFee,
    net_disbursal: Math.max(0, round2(amount - processingFee - disbursal.total)),
  };
};

// The part of a stored instalment that is neither principal nor interest, with
// names where they are known. The total always comes from the instalment
// itself, so it stays right even if the saved versions were lost.
const emiRowCharges = (row, loan, charges) => {
  const none = { charges_amount: 0, charge_items: [] };
  if (row.principal_amount == null || row.interest_amount == null) return none;
  const base = round2(parseFloat(row.principal_amount) + parseFloat(row.interest_amount));
  const extra = round2(parseFloat(row.emi_amount) - base);

  const items = emiCharges(charges, base).items.map(({ name, amount }) => ({ name, amount }));
  const named = round2(items.reduce((sum, item) => sum + item.amount, 0));
  const rest = round2(extra - named);

  // A paisa or two either way is rounding, not a charge.
  if (Math.abs(rest) < 0.05) return named > 0 ? { charges_amount: named, charge_items: items } : none;
  // The instalment holds less than the saved charges say: don't put names to it.
  if (rest < 0) return extra >= 0.05 ? { charges_amount: extra, charge_items: [{ name: 'Charges', amount: extra }] } : none;

  // What the named charges don't account for — the processing fee, when it is
  // collected with the first EMI.
  const feeInFirstEmi = Number(row.installment_no) === 1 && !!loan.processing_fee_in_first_emi;
  return {
    charges_amount: extra,
    charge_items: [{ name: feeInFirstEmi ? 'Processing fee + GST' : 'Other charges', amount: rest }, ...items],
  };
};

// Adds `charges` to loan rows read with status, amount, processing_fee,
// processing_fee_in_first_emi and approved_ts.
const attachLoanCharges = (loans, ctx) => {
  for (const loan of loans) loan.charges = loanChargeSummary(loan, chargesForLoan(ctx, loan), ctx.settings);
  return loans;
};

// Adds charges_amount / charge_items to a loan's stored instalments.
const attachEmiCharges = (rows, loan, ctx) => {
  const charges = chargesForLoan(ctx, loan);
  return rows.map((row) => ({ ...row, ...emiRowCharges(row, loan, charges) }));
};

module.exports = {
  SETTING_KEY, MAX_CHARGES,
  attachLoanCharges, attachEmiCharges,
  cleanCharges, parseVersions, chargesAsOf, latestCharges,
  loadChargeContext, loadVersionsLocked, chargesForLoan, saveCharges,
  disbursalCharges, emiCharges, processingFeeGstPct, processingFeeAtDisbursal, loanChargeSummary, emiRowCharges,
};
