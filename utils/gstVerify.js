const { pool } = require('../config/db');
const quickekyc = require('./quickekyc');
const { recordKycCheck } = require('./kycChecks');

// GST number check on the GST portal, through QuickeKYC. Only while
// KYC_PROVIDER=quickekyc; otherwise a GST number is format-checked only
// (utils/gst.js), as before.
//
// A GST number the customer types for the first time (or changes) must exist
// on the portal, or the save is refused. If the service is down it is saved
// anyway, just without a check — the GST number is optional and must not
// block onboarding. The answer is kept per customer in a table of its own,
// created by the first save (CREATE TABLE IF NOT EXISTS) like user_employment,
// so the same number is not paid for twice and the admin sees the registered
// business, its status and its last filed return. A "not found" answer is
// asked again after a day (new registrations take time to appear).

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS gst_verifications (
    user_id        INT NOT NULL PRIMARY KEY,
    gstin          VARCHAR(15) NOT NULL,
    found          TINYINT(1) NOT NULL DEFAULT 0,
    gst_status     VARCHAR(50) DEFAULT NULL,
    legal_name     VARCHAR(200) DEFAULT NULL,
    trade_name     VARCHAR(200) DEFAULT NULL,
    registered_on  VARCHAR(30) DEFAULT NULL,
    constitution   VARCHAR(100) DEFAULT NULL,
    taxpayer_type  VARCHAR(50) DEFAULT NULL,
    address        VARCHAR(500) DEFAULT NULL,
    last_filing    VARCHAR(120) DEFAULT NULL,
    request_id     VARCHAR(100) DEFAULT NULL,
    checked_at     DATETIME NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`;

const NOT_FOUND_RECHECK_MS = 24 * 60 * 60 * 1000;

const isMissingTable = (err) => err?.code === 'ER_NO_SUCH_TABLE';
const text = (value, max) => (value == null || value === '' ? null : String(value).replace(/\s+/g, ' ').trim().slice(0, max) || null);

// The portal's address comes as one line of text (seen 2026-10-30), or as parts.
const addressText = (a) => {
  if (!a) return null;
  if (typeof a === 'string') return a;
  if (typeof a !== 'object') return null;
  const known = ['bno', 'bnm', 'flno', 'building_name', 'st', 'street', 'loc', 'locality', 'city', 'dst', 'district', 'stcd', 'state', 'pncd', 'pincode'];
  const filled = (v) => (typeof v === 'string' || typeof v === 'number') && String(v).trim();
  let parts = known.map((k) => a[k]).filter(filled);
  // Other key names: take whatever plain text values there are, in order
  if (!parts.length) parts = Object.values(a).filter(filled);
  return parts.length ? parts.join(', ') : null;
};

// The most recently filed return, e.g. "GSTR3B · September 2026-2027 · filed 2026-10-19".
// filing_status comes as a list of lists of returns.
const lastFiling = (filingStatus) => {
  const returns = (Array.isArray(filingStatus) ? filingStatus.flat(2) : [])
    .filter((f) => f && typeof f === 'object' && quickekyc.toYmd(f.date_of_filing));
  if (!returns.length) return null;
  const latest = returns.reduce((a, b) => (quickekyc.toYmd(b.date_of_filing) > quickekyc.toYmd(a.date_of_filing) ? b : a));
  const period = [latest.tax_period, latest.financial_year].filter(Boolean).join(' ');
  return [latest.return_type, period, `filed ${quickekyc.toYmd(latest.date_of_filing)}`].filter(Boolean).join(' · ');
};

/**
 * Ask QuickeKYC about one GSTIN. Resolves to { found: false, message } when
 * the portal does not know it, or { found: true, status, legalName, … }.
 * Throws when the service could not answer.
 */
const lookupGstin = async (gstin) => {
  // filing_status_get must be true: with false every call answered "Backend
  // Timed Out" on 2026-10-30, with true the same numbers answered in ~2 s.
  // It runs inside the customer's profile save, which the app and website give
  // 15 s (old APKs too), and never blocks the save when the service is slow —
  // so 8 s at most (good answers came in 1–2 s).
  const r = await quickekyc.call('/corporate/gstin', { id_number: gstin, filing_status_get: true }, { label: 'GST verification', timeout: 8000 });
  if (!r.ok) return { found: false, message: r.message, requestId: r.requestId, raw: r.raw };

  const d = r.data;
  return {
    raw: r.raw,
    found: true,
    status: quickekyc.pick(d, 'gstin_status', 'sts', 'status'),
    legalName: quickekyc.pick(d, 'legal_name', 'lgnm'),
    tradeName: quickekyc.pick(d, 'business_name', 'trade_name', 'tradeNam'),
    registeredOn: quickekyc.pick(d, 'date_of_registration', 'rgdt'),
    constitution: quickekyc.pick(d, 'constitution_of_business', 'ctb'),
    taxpayerType: quickekyc.pick(d, 'taxpayer_type', 'dty'),
    address: addressText(d.address) || addressText(d.address_details) || addressText(d.pradr?.addr || d.principal_address),
    lastFiling: lastFiling(d.filing_status),
    requestId: r.requestId,
  };
};

const readRow = async (userId) => {
  try {
    const [[row]] = await pool.query('SELECT * FROM gst_verifications WHERE user_id = ?', [userId]);
    return row || null;
  } catch (err) {
    if (!isMissingTable(err)) console.error('[gst] could not read the GST check:', err.message);
    return null;
  }
};

const writeRow = async (userId, gstin, result) => {
  const write = () => pool.query(
    `INSERT INTO gst_verifications
       (user_id, gstin, found, gst_status, legal_name, trade_name, registered_on, constitution, taxpayer_type, address, last_filing, request_id, checked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
     ON DUPLICATE KEY UPDATE
       gstin = VALUES(gstin), found = VALUES(found), gst_status = VALUES(gst_status),
       legal_name = VALUES(legal_name), trade_name = VALUES(trade_name), registered_on = VALUES(registered_on),
       constitution = VALUES(constitution), taxpayer_type = VALUES(taxpayer_type), address = VALUES(address),
       last_filing = VALUES(last_filing), request_id = VALUES(request_id), checked_at = NOW()`,
    [
      userId, gstin, result.found ? 1 : 0, text(result.status, 50), text(result.legalName, 200), text(result.tradeName, 200),
      text(result.registeredOn, 30), text(result.constitution, 100), text(result.taxpayerType, 50), text(result.address, 500),
      text(result.lastFiling, 120), text(result.requestId, 100),
    ]
  );
  try {
    try {
      await write();
    } catch (err) {
      if (!isMissingTable(err)) throw err;
      await pool.query(CREATE_TABLE_SQL);
      await write();
    }
  } catch (err) {
    console.error('[gst] could not save the GST check:', err.message);
  }
};

const notFoundMessage = (gstin) =>
  `GST number ${gstin} was not found on the GST portal. Please check it, or leave it empty if your business is not registered for GST.`;

/**
 * Called before a GST number is saved. `gstin` is already cleaned and
 * format-checked; `storedGstin` is the one saved now (or null).
 * Resolves to { ok: true } or { ok: false, message } (safe to show).
 * A number that was saved before is never refused, only checked for the admin.
 */
const checkGstinBeforeSave = async (userId, gstin, storedGstin) => {
  if (!gstin || !quickekyc.isQuickeKycOn()) return { ok: true };
  const isNew = gstin !== storedGstin;

  const known = await readRow(userId);
  if (known && known.gstin === gstin) {
    const fresh = known.found || Date.now() - new Date(known.checked_at).getTime() < NOT_FOUND_RECHECK_MS;
    if (fresh) return known.found || !isNew ? { ok: true } : { ok: false, message: notFoundMessage(gstin) };
  }

  let result;
  try {
    result = await lookupGstin(gstin);
  } catch (err) {
    // Service down: save without a check rather than block the customer
    console.warn('[gst] GST check skipped for user', userId, '-', err.message);
    await recordKycCheck({
      userId, type: 'gst', outcome: 'failed', summary: err.details?.reason || err.message,
      input: { gstin }, response: err.details?.raw || null, provider: err.details?.provider,
    });
    return { ok: true };
  }

  await recordKycCheck({
    userId, type: 'gst', requestId: result.requestId, input: { gstin }, response: result.raw || null,
    outcome: result.found ? (result.status && !/^active/i.test(result.status) ? 'not_active' : 'verified') : 'not_found',
    summary: result.found
      ? `${gstin} → ${result.legalName || result.tradeName || '—'} · ${result.status || 'status unknown'}${result.lastFiling ? ` · last return ${result.lastFiling}` : ''}`
      : result.message || `${gstin} not found on the GST portal`,
  });
  await writeRow(userId, gstin, result);
  if (!result.found && isNew) return { ok: false, message: notFoundMessage(gstin) };
  return { ok: true };
};

// Saved checks of several users → Map(userId → row). Never throws.
const gstChecksOf = async (userIds) => {
  if (!userIds.length) return new Map();
  try {
    const [rows] = await pool.query('SELECT * FROM gst_verifications WHERE user_id IN (?)', [userIds]);
    return new Map(rows.map((row) => [row.user_id, row]));
  } catch (err) {
    if (!isMissingTable(err)) console.error('[gst] could not read GST checks:', err.message);
    return new Map();
  }
};

// What the admin is shown for a saved GST number, or null when it was never
// checked (or the check was for a different number).
const gstCheckView = (row, gstNumber) => {
  if (!row || !gstNumber || row.gstin !== gstNumber) return null;
  return {
    found: !!row.found,
    status: row.gst_status,
    legal_name: row.legal_name,
    trade_name: row.trade_name,
    registered_on: row.registered_on,
    constitution: row.constitution,
    last_filing: row.last_filing,
    checked_at: row.checked_at,
  };
};

module.exports = { CREATE_TABLE_SQL, checkGstinBeforeSave, gstChecksOf, gstCheckView, lookupGstin, lastFiling };
