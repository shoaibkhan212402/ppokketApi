const { pool } = require('../config/db');
const { delCache, invalidateUserCache } = require('../config/redis');

// Aadhaar step with or without OTP (Admin → Settings → KYC, super admin only).
//
// Normally a customer proves their Aadhaar with an OTP (UIDAI, through
// APItxt). While that service is down the super admin can switch the OTP off:
// the customer then only types their Aadhaar number and carries on, and the
// admin checks it against the Aadhaar card photos when reviewing the KYC.
//
// Either way the step counts as done through users.aadhaar_verified = 1 —
// what every client and the KYC submit check already read. Which customers
// gave the number without an OTP is kept in a table of its own, created on
// first use (nothing else altered), so the admin pages can say "number only,
// no OTP" instead of "verified". A record only counts while the customer's
// Aadhaar number is still the one recorded, and a later OTP removes it.

const SETTING_KEY = 'aadhaar_otp_enabled';

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS aadhaar_without_otp (
    user_id        INT NOT NULL PRIMARY KEY,
    aadhaar_number VARCHAR(12) NOT NULL,
    created_at     DATETIME NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`;

const isMissingTable = (err) => err?.code === 'ER_NO_SUCH_TABLE';

// ── The switch ───────────────────────────────────────────────────────────────
// Nothing saved = OTP on (how it always worked).
const isAadhaarOtpOn = async () => {
  const [rows] = await pool.query('SELECT setting_value FROM system_settings WHERE setting_key = ?', [SETTING_KEY]);
  return rows[0]?.setting_value !== 'false';
};

// For responses that should not fail just because the setting could not be read
const aadhaarOtpOnOrDefault = async () => {
  try {
    return await isAadhaarOtpOn();
  } catch (err) {
    console.error('[aadhaarMode] could not read the setting:', err.message);
    return true;
  }
};

const setAadhaarOtpOn = (on) => pool.query(
  'INSERT INTO system_settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)',
  [SETTING_KEY, on ? 'true' : 'false']
);

// ── Checking a number without UIDAI ──────────────────────────────────────────
// Every Aadhaar number is 12 digits, never starts with 0 or 1, and ends in a
// Verhoeff check digit — enough to catch a mistyped or made-up number.
const VERHOEFF_D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6], [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8], [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2], [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4], [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const VERHOEFF_P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2], [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0], [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5], [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];
const verhoeffOk = (digits) => {
  let check = 0;
  [...digits].reverse().forEach((d, i) => { check = VERHOEFF_D[check][VERHOEFF_P[i % 8][Number(d)]]; });
  return check === 0;
};

const cleanAadhaar = (value) => String(value || '').replace(/[\s-]/g, '');

// What is wrong with the number, or null
const aadhaarNumberProblem = (number) => {
  if (!/^\d{12}$/.test(number)) return 'Please enter your 12-digit Aadhaar number.';
  if (/^[01]/.test(number)) return 'An Aadhaar number never starts with 0 or 1. Please check the number.';
  if (!verhoeffOk(number)) return 'This is not a valid Aadhaar number. Please check the digits and try again.';
  return null;
};

// ── Saving the number without OTP ────────────────────────────────────────────
let tableReady = null;
const ensureTable = () => {
  tableReady = tableReady || pool.query(CREATE_TABLE_SQL).then(() => true).catch((err) => {
    tableReady = null;
    throw err;
  });
  return tableReady;
};

// Completes the Aadhaar step with the number alone.
// Resolves to { ok: true } or { ok: false, status, message }.
const saveAadhaarWithoutOtp = async (userId, rawNumber) => {
  const number = cleanAadhaar(rawNumber);
  const problem = aadhaarNumberProblem(number);
  if (problem) return { ok: false, status: 400, message: problem };

  const [[user]] = await pool.query('SELECT aadhaar_number, aadhaar_verified FROM users WHERE id = ?', [userId]);
  if (!user) return { ok: false, status: 404, message: 'User not found.' };
  if (user.aadhaar_verified) {
    if (String(user.aadhaar_number || '') === number) return { ok: true };
    return { ok: false, status: 400, message: 'Your Aadhaar step is already complete. Please contact support to change the number.' };
  }

  // Nobody checked that this number is theirs, so it must not already belong
  // to another customer who has completed the step.
  const [[taken]] = await pool.query(
    'SELECT id FROM users WHERE aadhaar_number = ? AND id <> ? AND (aadhaar_verified = 1 OR is_kyc_verified = 1) LIMIT 1',
    [number, userId]
  );
  if (taken) {
    return { ok: false, status: 409, message: 'This Aadhaar number is already linked to another Ppokket account. Please contact support.' };
  }

  // The record is written in the same transaction as the step itself: no
  // customer passes the step without the admin being able to see that no OTP
  // was done.
  await ensureTable();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(
      `INSERT INTO aadhaar_without_otp (user_id, aadhaar_number, created_at) VALUES (?, ?, NOW())
       ON DUPLICATE KEY UPDATE aadhaar_number = VALUES(aadhaar_number), created_at = NOW()`,
      [userId, number]
    );
    await conn.query(
      `UPDATE users SET aadhaar_number = ?, aadhaar_verified = 1, aadhaar_ref_id = NULL, updated_at = NOW() WHERE id = ?`,
      [number, userId]
    );
    // Same as after an OTP: the KYC record keeps its own copy of the mark
    await conn.query(
      `INSERT INTO kyc_documents (user_id, aadhaar_verified, status) VALUES (?, 1, 'pending')
       ON DUPLICATE KEY UPDATE aadhaar_verified = 1, updated_at = NOW()`,
      [userId]
    );
    await conn.query(
      'INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, ?)',
      [userId, '✅ Aadhaar Number Saved', 'Your Aadhaar number has been saved. Please complete the remaining KYC steps.', 'kyc']
    );
    await conn.commit();
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }

  await invalidateUserCache(userId);
  await delCache(`user:${userId}:kyc`, 'admin:dashboard', 'admin:dashboard:partner:*');
  return { ok: true };
};

// After a successful OTP the number is verified properly. Never throws.
const clearWithoutOtp = async (userId) => {
  try {
    await pool.query('DELETE FROM aadhaar_without_otp WHERE user_id = ?', [userId]);
  } catch (err) {
    if (!isMissingTable(err)) console.error('[aadhaarMode] could not clear the record:', err.message);
  }
};

// ── Reading it back ──────────────────────────────────────────────────────────
// Whether this customer's current Aadhaar number was given without an OTP
const isWithoutOtp = async (userId) => {
  try {
    const [rows] = await pool.query(
      `SELECT 1 FROM aadhaar_without_otp w JOIN users u ON u.id = w.user_id AND u.aadhaar_number = w.aadhaar_number
        WHERE w.user_id = ?`,
      [userId]
    );
    return rows.length > 0;
  } catch (err) {
    if (!isMissingTable(err)) console.error('[aadhaarMode] could not read the record:', err.message);
    return false;
  }
};

// Adds `aadhaar_without_otp` (true / false) to rows that carry a user id under
// `idKey` and the Aadhaar number under `aadhaar_number`. Call it before the
// number is masked for the admin.
const attachAadhaarWithoutOtp = async (rows, idKey = 'user_id') => {
  const ids = [...new Set(rows.map((row) => row?.[idKey]).filter((id) => id != null))];
  let byUser = new Map();
  if (ids.length) {
    try {
      const [records] = await pool.query('SELECT user_id, aadhaar_number FROM aadhaar_without_otp WHERE user_id IN (?)', [ids]);
      byUser = new Map(records.map((r) => [r.user_id, r.aadhaar_number]));
    } catch (err) {
      if (!isMissingTable(err)) console.error('[aadhaarMode] could not read the records:', err.message);
    }
  }
  for (const row of rows) {
    if (!row) continue;
    const recorded = byUser.get(row[idKey]);
    row.aadhaar_without_otp = !!recorded && String(row.aadhaar_number || '') === recorded;
  }
  return rows;
};

// For the Settings page: customers whose Aadhaar step was done without OTP
const countWithoutOtp = async () => {
  try {
    const [[row]] = await pool.query(
      `SELECT COUNT(*) AS n FROM aadhaar_without_otp w
         JOIN users u ON u.id = w.user_id AND u.aadhaar_number = w.aadhaar_number AND u.aadhaar_verified = 1`
    );
    return Number(row.n);
  } catch (err) {
    if (!isMissingTable(err)) console.error('[aadhaarMode] could not count the records:', err.message);
    return 0;
  }
};

module.exports = {
  CREATE_TABLE_SQL,
  isAadhaarOtpOn, aadhaarOtpOnOrDefault, setAadhaarOtpOn,
  cleanAadhaar, aadhaarNumberProblem, verhoeffOk,
  saveAadhaarWithoutOtp, clearWithoutOtp, isWithoutOtp, attachAadhaarWithoutOtp, countWithoutOtp,
};
