const { pool } = require('../config/db');

// Every identity check a customer goes through — PAN, Aadhaar OTP send and
// verify, bank account, IFSC, GST number — kept with the provider's complete
// answer, so the super admin can see exactly what came back and when
// (Admin → Users → a customer → Verification data). Failed checks are kept too.
//
// A table of its own, created by the first save (CREATE TABLE IF NOT EXISTS),
// like user_employment. Saving or reading these must never break a check or
// an admin screen, so every function here swallows its errors.

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS kyc_checks (
    id            INT AUTO_INCREMENT PRIMARY KEY,
    user_id       INT NOT NULL,
    check_type    VARCHAR(30) NOT NULL,
    provider      VARCHAR(20) DEFAULT NULL,
    outcome       VARCHAR(30) NOT NULL,
    summary       VARCHAR(500) DEFAULT NULL,
    request_id    VARCHAR(100) DEFAULT NULL,
    input_json    TEXT DEFAULT NULL,
    response_json LONGTEXT DEFAULT NULL,
    response_size INT DEFAULT NULL,
    created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_kyc_checks_user (user_id, created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`;

// A single answer larger than this (Aadhaar replies can carry an XML, a PDF
// and a photo) has its biggest text fields left out, so one row stays well
// inside MySQL's packet limit. Which fields were left out is recorded.
const MAX_RESPONSE_CHARS = 6 * 1024 * 1024;
const BIG_FIELD_CHARS = 512 * 1024;

const isMissingTable = (err) => err?.code === 'ER_NO_SUCH_TABLE';
const text = (value, max) => (value == null || value === '' ? null : String(value).slice(0, max));

const trimHuge = (response) => {
  let json = JSON.stringify(response);
  if (json.length <= MAX_RESPONSE_CHARS) return json;
  const left = [];
  const strip = (obj, at) => {
    if (!obj || typeof obj !== 'object') return;
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === 'string' && v.length > BIG_FIELD_CHARS) { obj[k] = `[left out: ${v.length} characters]`; left.push(`${at}${k}`); }
      else if (v && typeof v === 'object') strip(v, `${at}${k}.`);
    }
  };
  const copy = JSON.parse(json);
  strip(copy, '');
  copy._left_out = left;
  json = JSON.stringify(copy);
  return json.length <= MAX_RESPONSE_CHARS ? json : JSON.stringify({ _left_out: 'whole answer', size: json.length });
};

// Which provider answered, from the shape of its reply: QuickeKYC replies
// carry status_code, APItxt ones a numeric status.
const providerOf = (raw) => {
  if (!raw || typeof raw !== 'object') return null;
  if ('status_code' in raw) return 'quickekyc';
  if (typeof raw.status === 'number') return 'apitxt';
  return null;
};

/**
 * Saves one check. Never throws.
 * { userId, type, outcome, summary?, requestId?, input?, response?, provider? }
 * type: pan | aadhaar_otp | aadhaar | bank | ifsc | gst
 * outcome: e.g. verified, otp_sent, not_verified, name_mismatch, dob_mismatch, not_found, failed
 */
const recordKycCheck = async ({ userId, type, outcome, summary, requestId, input, response, provider }) => {
  if (!userId || !type) return;
  try {
    const responseJson = response === undefined || response === null ? null : trimHuge(response);
    const write = () => pool.query(
      `INSERT INTO kyc_checks (user_id, check_type, provider, outcome, summary, request_id, input_json, response_json, response_size)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        userId, type, text(provider || providerOf(response), 20), text(outcome || 'unknown', 30), text(summary, 500),
        text(requestId, 100), input ? JSON.stringify(input).slice(0, 60000) : null, responseJson,
        responseJson ? responseJson.length : null,
      ]
    );
    try {
      await write();
    } catch (err) {
      if (!isMissingTable(err)) throw err;
      await pool.query(CREATE_TABLE_SQL);
      await write();
    }
  } catch (err) {
    console.error('[kycChecks] could not save a check:', err.message);
  }
};

// A customer's checks, newest first, without the (possibly large) answers.
const listKycChecks = async (userId) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, check_type, provider, outcome, summary, request_id, input_json, response_size, created_at
         FROM kyc_checks WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 200`,
      [userId]
    );
    return rows.map((r) => ({ ...r, input: parse(r.input_json), input_json: undefined }));
  } catch (err) {
    if (!isMissingTable(err)) console.error('[kycChecks] could not list checks:', err.message);
    return [];
  }
};

// One check with the provider's full answer, or null.
const getKycCheck = async (id) => {
  try {
    const [[row]] = await pool.query('SELECT * FROM kyc_checks WHERE id = ?', [id]);
    if (!row) return null;
    return { ...row, input: parse(row.input_json), response: parse(row.response_json), input_json: undefined, response_json: undefined };
  } catch (err) {
    if (!isMissingTable(err)) console.error('[kycChecks] could not read a check:', err.message);
    return null;
  }
};

function parse(json) {
  if (!json) return null;
  try { return JSON.parse(json); } catch { return json; }
}

// "XXXX XXXX 4399" — the full Aadhaar number is already on the customer's row;
// the log does not need another copy of it.
const maskAadhaar = (n) => {
  const d = String(n || '').replace(/\D/g, '');
  return d.length === 12 ? `XXXX XXXX ${d.slice(-4)}` : null;
};

module.exports = { CREATE_TABLE_SQL, recordKycCheck, listKycChecks, getKycCheck, maskAadhaar };
