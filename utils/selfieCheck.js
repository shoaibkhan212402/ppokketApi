const { pool } = require('../config/db');

// Which KYC selfie passed the live check (the customer blinked in front of the
// camera before it was taken — website and app 1.0.5+). The admin sees it next
// to the selfie. The check runs on the customer's device, so this tells the
// reviewer how the photo was taken; it is not proof on its own.
//
// The selfie's file URL is stored with the result: if the customer later
// uploads another selfie without the check (an older app), the URLs no longer
// match and the admin sees "not checked". A table of its own that the first
// save creates, like user_employment.

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS kyc_selfie_checks (
    user_id    INT NOT NULL PRIMARY KEY,
    selfie     VARCHAR(500) NOT NULL,
    method     VARCHAR(20) NOT NULL,
    checked_at DATETIME NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`;

const METHODS = ['blink'];
const isMissingTable = (err) => err?.code === 'ER_NO_SUCH_TABLE';

// Never throws: a failure here must not fail the selfie upload.
const recordSelfieCheck = async (userId, selfieUrl, method) => {
  if (!selfieUrl || !METHODS.includes(method)) return false;
  const write = () => pool.query(
    `INSERT INTO kyc_selfie_checks (user_id, selfie, method, checked_at) VALUES (?, ?, ?, NOW())
     ON DUPLICATE KEY UPDATE selfie = VALUES(selfie), method = VALUES(method), checked_at = NOW()`,
    [userId, selfieUrl, method]
  );
  try {
    try {
      await write();
    } catch (err) {
      if (!isMissingTable(err)) throw err;
      await pool.query(CREATE_TABLE_SQL);
      await write();
    }
    return true;
  } catch (err) {
    console.error('[selfieCheck] could not record the selfie check:', err.message);
    return false;
  }
};

// Adds `selfie_check` ({ method, checked_at } or null) to KYC rows that carry
// a user id under `idKey` and the selfie URL under `selfie`.
const attachSelfieChecks = async (rows, idKey = 'user_id') => {
  const ids = [...new Set(rows.map((row) => row[idKey]).filter((id) => id != null))];
  let byUser = new Map();
  if (ids.length) {
    try {
      const [checks] = await pool.query('SELECT user_id, selfie, method, checked_at FROM kyc_selfie_checks WHERE user_id IN (?)', [ids]);
      byUser = new Map(checks.map((c) => [c.user_id, c]));
    } catch (err) {
      if (!isMissingTable(err)) console.error('[selfieCheck] could not read selfie checks:', err.message);
    }
  }
  for (const row of rows) {
    const check = byUser.get(row[idKey]);
    row.selfie_check = check && row.selfie && check.selfie === row.selfie
      ? { method: check.method, checked_at: check.checked_at }
      : null;
  }
  return rows;
};

module.exports = { CREATE_TABLE_SQL, recordSelfieCheck, attachSelfieChecks };
