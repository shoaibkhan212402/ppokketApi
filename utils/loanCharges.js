const crypto = require('crypto');
const { pool } = require('../config/db');

// Charges the super admin defines on top of the processing fee (Admin → Charges).
// Each one is a flat amount or a percentage, taken at one of two moments:
//   'disbursal'  once, out of the amount sent to the customer
//                (a percentage is of the loan amount)
//   'emi'        with every instalment, added to it
//                (a percentage is of that instalment's principal + interest)
// A percentage can instead be "of the other charges" taken at the same moment
// (percent_of: 'charges') — that is how GST on the fees is set.
//
// A loan keeps the charges that were in force when it was approved: that is
// what the customer was shown before accepting the agreement, and its EMI
// charges are written into the instalment amounts (emi_schedule.emi_amount)
// right then, with the break-up of every instalment stored beside them
// (emi_charge_items). Editing the list later only affects loans approved
// afterwards.
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
const round4 = (n) => Math.round(n * 10000) / 10000;

const invalid = (message) => Object.assign(new Error(message), { isValidation: true });

// Charges that are always in the admin's list, on top of the MAX_CHARGES of
// their own: they can be priced, renamed and hidden, but not removed. Each
// stays switched off until the admin sets it up.
const BUILT_IN_CHARGES = [
  { id: 'postservicefee', name: 'Post Service Fee', applies_to: 'emi', type: 'flat', value: 0, percent_of: 'amount', active: false },
  { id: 'techfee', name: 'Tech Fee', applies_to: 'emi', type: 'flat', value: 0, percent_of: 'amount', active: false },
  { id: 'gstoncharges', name: 'GST', applies_to: 'emi', type: 'percent', value: 18, percent_of: 'charges', active: false },
];
const isBuiltIn = (id) => BUILT_IN_CHARGES.some((c) => c.id === id);

// A percentage of the other charges taken at the same moment, not of the
// loan amount / instalment.
const onCharges = (charge) => charge.type === 'percent' && charge.percent_of === 'charges';

// Turns what the admin form sent into the list that is stored. Throws an
// error flagged `isValidation` (safe to show) when something is wrong.
const cleanCharges = (input) => {
  if (!Array.isArray(input)) throw invalid('Charges must be a list');
  if (input.length > MAX_CHARGES + BUILT_IN_CHARGES.length || input.filter((raw) => !isBuiltIn(raw?.id)).length > MAX_CHARGES) {
    throw invalid(`At most ${MAX_CHARGES} charges of your own can be added`);
  }

  const names = new Set();
  const ids = new Set();
  const charges = input.map((raw, i) => {
    const row = `Charge ${i + 1}`;
    const name = String(raw?.name ?? '').replace(/\s+/g, ' ').trim();
    if (name.length < 2 || name.length > 40) throw invalid(`${row}: the name must be 2 to 40 characters`);
    if (names.has(name.toLowerCase())) throw invalid(`"${name}" is listed twice — give each charge its own name`);
    names.add(name.toLowerCase());

    if (!['disbursal', 'emi'].includes(raw.applies_to)) throw invalid(`${name}: choose whether it is charged at disbursal or on every EMI`);
    if (!['flat', 'percent'].includes(raw.type)) throw invalid(`${name}: choose flat (₹) or percent (%)`);

    // A hidden charge may be left without an amount; one being applied may not.
    const active = raw.active !== false && raw.active !== 0;
    const value = round2(Number(raw.value));
    if (!Number.isFinite(value) || value < 0 || (active && value === 0)) throw invalid(`${name}: enter an amount greater than 0`);
    if (raw.type === 'percent' && value > 100) throw invalid(`${name}: a percentage cannot be more than 100`);
    if (raw.type === 'flat' && value > MAX_FLAT) throw invalid(`${name}: the amount is too large`);

    let id = /^[a-z0-9]{4,16}$/.test(String(raw.id || '')) ? String(raw.id) : null;
    if (!id || ids.has(id)) id = crypto.randomBytes(4).toString('hex');
    ids.add(id);

    // An admin page from before percent_of existed does not send it; a built-in
    // charge then keeps its own, so GST cannot turn into a percentage of the EMI.
    const percentOf = raw.percent_of ?? BUILT_IN_CHARGES.find((b) => b.id === id)?.percent_of;
    const percent_of = raw.type === 'percent' && percentOf === 'charges' ? 'charges' : 'amount';
    return { id, name, applies_to: raw.applies_to, type: raw.type, value, percent_of, active };
  });

  // A percentage of the other charges comes to nothing when there are none.
  for (const charge of charges) {
    if (!charge.active || !onCharges(charge)) continue;
    const hasOthers = charges.some((c) => c.active && c.applies_to === charge.applies_to && !onCharges(c));
    if (!hasOthers) {
      throw invalid(`${charge.name}: it is a percentage of the other charges ${charge.applies_to === 'emi' ? 'on every EMI' : 'at disbursal'}, but none of them is switched on`);
    }
  }
  return charges;
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

// The list the admin edits: any built-in charge that was never saved (hidden,
// waiting to be set up), then what was last saved.
const editorCharges = (versions) => {
  const saved = latestCharges(versions).map((c) => ({ ...c, percent_of: onCharges(c) ? 'charges' : 'amount' }));
  return [...BUILT_IN_CHARGES.filter((b) => !saved.some((c) => c.id === b.id)), ...saved];
};

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
  percent_of: onCharges(charge) ? 'charges' : 'amount',
  amount: charge.type === 'percent' ? round2(base * charge.value / 100) : round2(charge.value),
});
const priceAll = (charges, appliesTo, base) => {
  const group = charges.filter((c) => c.applies_to === appliesTo);
  // A percentage of the other charges (GST) is priced on what the rest add up to.
  const others = round2(group.filter((c) => !onCharges(c)).reduce((sum, c) => sum + priced(c, base).amount, 0));
  const items = group.map((c) => priced(c, onCharges(c) ? others : base)).filter((item) => item.amount > 0);
  return { items, total: round2(items.reduce((sum, item) => sum + item.amount, 0)) };
};

// The same charges for whatever describes or prices them outside this file —
// the apps' own EMI preview, "x% of EMI" labels, the agreement. They only know
// a flat amount and a percentage of the loan amount / instalment, so a
// percentage of the other charges is restated as what it comes to: one of
// those, or both when the other charges are a mix.
const plainCharges = (charges) => charges.flatMap((charge) => {
  const { id, name, applies_to, type, value } = charge;
  if (!onCharges(charge)) return [{ id, name, applies_to, type, value }];
  const others = charges.filter((c) => c.applies_to === applies_to && !onCharges(c));
  const share = (ofType) => others.filter((c) => c.type === ofType).reduce((sum, c) => sum + c.value, 0) * value / 100;
  return [
    { id, name, applies_to, type: 'percent', value: round4(share('percent')) },
    { id, name, applies_to, type: 'flat', value: round2(share('flat')) },
  ].filter((c) => c.value > 0);
});

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
    emi: plainCharges(charges).filter((c) => c.applies_to === 'emi').map(({ id, name, type, value }) => ({ id, name, type, value })),
    // All instalments together — part of total_payable, and not interest.
    emi_total: schedule
      ? round2(schedule.reduce((sum, row) => sum + (row.emi_charges || 0), 0))
      : emiChargesOverLoan(loan, charges, settings),
    processing_fee_deducted: processingFee,
    net_disbursal: Math.max(0, round2(amount - processingFee - disbursal.total)),
  };
};

// ── The break-up stored with a loan's EMI schedule ──────────────────────────
// What each instalment was charged, charge by charge, written when the loan is
// approved and its schedule is created. It lives in a table of its own, so
// nothing about the existing tables has to change; the server creates it the
// first time a loan is approved. Loans approved before it existed have no
// rows here, and their break-up is worked out from the saved versions instead.

const CREATE_EMI_CHARGE_ITEMS_SQL = `
  CREATE TABLE IF NOT EXISTS emi_charge_items (
    id             INT AUTO_INCREMENT PRIMARY KEY,
    loan_id        INT NOT NULL,
    installment_no INT NOT NULL,
    charge_id      VARCHAR(16) NOT NULL,
    name           VARCHAR(40) NOT NULL,
    type           VARCHAR(10) NOT NULL,
    value          DECIMAL(12,2) NOT NULL,
    percent_of     VARCHAR(10) NOT NULL,
    amount         DECIMAL(12,2) NOT NULL,
    created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    KEY idx_emi_charge_items_loan (loan_id, installment_no)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`;

const isMissingTable = (err) => err?.code === 'ER_NO_SUCH_TABLE';

// Makes sure the table is there. Call it BEFORE opening a transaction: creating
// a table commits whatever transaction is open. Resolves to whether it exists.
let emiChargeItemsTable = null;
const ensureEmiChargeItemsTable = () => {
  emiChargeItemsTable = emiChargeItemsTable || pool.query(CREATE_EMI_CHARGE_ITEMS_SQL).then(() => true).catch((err) => {
    console.error('[loanCharges] could not create emi_charge_items:', err.message);
    emiChargeItemsTable = null; // try again on the next approval
    return false;
  });
  return emiChargeItemsTable;
};

// Replaces a loan's stored break-up with that of `schedule` (the rows from
// generateEMISchedule). Runs on the approval's own connection, so it is saved
// or dropped together with the instalments. If the table could not be created
// the approval still goes through — the amounts in emi_schedule are what is
// charged — and the break-up is derived as for older loans.
const storeEmiChargeItems = async (conn, loanId, schedule) => {
  try {
    await conn.query('DELETE FROM emi_charge_items WHERE loan_id = ?', [loanId]);
    const rows = schedule.flatMap((row) => (row.emi_charge_items || []).map((c) => [
      loanId, row.installment_no, c.id, c.name, c.type, c.value, c.percent_of, c.amount,
    ]));
    if (rows.length) {
      await conn.query(
        'INSERT INTO emi_charge_items (loan_id, installment_no, charge_id, name, type, value, percent_of, amount) VALUES ?',
        [rows]
      );
    }
  } catch (err) {
    if (!isMissingTable(err)) throw err;
    console.error('[loanCharges] emi_charge_items is missing — the EMI charge break-up was not stored for loan', loanId);
  }
};

// A loan's stored break-up → Map(installment_no → [{ name, amount }]); empty
// when it has none. Showing a schedule must never fail on this, so errors are
// logged and read as "none".
const storedEmiChargeItems = async (loanId) => {
  const byInstalment = new Map();
  if (loanId == null) return byInstalment;
  try {
    const [rows] = await pool.query('SELECT installment_no, name, amount FROM emi_charge_items WHERE loan_id = ? ORDER BY id', [loanId]);
    for (const row of rows) {
      if (!byInstalment.has(row.installment_no)) byInstalment.set(row.installment_no, []);
      byInstalment.get(row.installment_no).push({ name: row.name, amount: parseFloat(row.amount) });
    }
  } catch (err) {
    if (!isMissingTable(err)) console.error('[loanCharges] could not read the EMI charge break-up:', err.message);
  }
  return byInstalment;
};

// The part of a stored instalment that is neither principal nor interest, with
// names where they are known: `storedItems` when the loan's break-up was
// stored, otherwise worked out from `charges`. The total always comes from the
// instalment itself, so it stays right even if the saved versions were lost.
const emiRowCharges = (row, loan, charges, storedItems = null) => {
  const none = { charges_amount: 0, charge_items: [] };
  if (row.principal_amount == null || row.interest_amount == null) return none;
  const base = round2(parseFloat(row.principal_amount) + parseFloat(row.interest_amount));
  const extra = round2(parseFloat(row.emi_amount) - base);

  const items = storedItems || emiCharges(charges, base).items.map(({ name, amount }) => ({ name, amount }));
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

// Adds charges_amount / charge_items to one loan's stored instalments (rows of
// emi_schedule, which carry its loan_id).
const attachEmiCharges = async (rows, loan, ctx) => {
  if (!rows.length) return [];
  const charges = chargesForLoan(ctx, loan);
  const stored = await storedEmiChargeItems(rows[0].loan_id);
  return rows.map((row) => ({
    ...row,
    ...emiRowCharges(row, loan, charges, stored.size ? stored.get(Number(row.installment_no)) || [] : null),
  }));
};

module.exports = {
  SETTING_KEY, MAX_CHARGES, BUILT_IN_CHARGES, CREATE_EMI_CHARGE_ITEMS_SQL,
  attachLoanCharges, attachEmiCharges,
  cleanCharges, parseVersions, chargesAsOf, latestCharges, editorCharges, plainCharges,
  loadChargeContext, loadVersionsLocked, chargesForLoan, saveCharges,
  disbursalCharges, emiCharges, processingFeeGstPct, processingFeeAtDisbursal, loanChargeSummary, emiRowCharges,
  ensureEmiChargeItemsTable, storeEmiChargeItems,
};
