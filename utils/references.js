const { pool } = require('../config/db');

// Two reference contacts a customer gives at onboarding — someone from their
// family and a friend or colleague — with name, mobile number and relation.
// Shown on the customer's profile and to the admin.
//
// Like user_employment, this lives in a table of its own that the first save
// creates (CREATE TABLE IF NOT EXISTS), so nothing about the existing tables
// changes and nobody has to run SQL. Reads never throw: no table yet simply
// means no references.

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS user_references (
    user_id    INT NOT NULL,
    slot       TINYINT NOT NULL,
    name       VARCHAR(100) NOT NULL,
    mobile     VARCHAR(10) NOT NULL,
    relation   VARCHAR(30) NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, slot)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`;

// Slot 1 is a family member, slot 2 anyone else who knows the customer.
// The website and the app offer the same lists.
const RELATIONS = [
  ['Father', 'Mother', 'Spouse', 'Brother', 'Sister', 'Son', 'Daughter', 'Other Relative'],
  ['Friend', 'Colleague', 'Neighbour', 'Relative', 'Other'],
];
const SLOT_NAMES = ['Family reference', 'Second reference'];

const isMissingTable = (err) => err?.code === 'ER_NO_SUCH_TABLE';
const invalid = (message) => Object.assign(new Error(message), { isValidation: true });

// Indian mobile number as its 10 digits: "+91 98765-43210" → "9876543210".
const cleanMobile = (value) => {
  let digits = String(value ?? '').replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  return digits;
};

// Checks what a profile form sent: exactly two references. `ownMobile` is the
// customer's own number, which cannot be a reference. Throws an error flagged
// `isValidation` (safe to show) when something is missing or wrong.
const cleanReferences = (input, ownMobile) => {
  if (!Array.isArray(input) || input.length !== RELATIONS.length) {
    throw invalid('Please give two references: one family member and one friend or colleague.');
  }
  const own = cleanMobile(ownMobile).slice(-10);
  const refs = input.map((ref, i) => {
    const label = SLOT_NAMES[i];
    if (!ref || typeof ref !== 'object') throw invalid(`${label}: details are missing.`);
    const name = String(ref.name ?? '').replace(/\s+/g, ' ').trim();
    const mobile = cleanMobile(ref.mobile);
    const relation = RELATIONS[i].find((r) => r.toLowerCase() === String(ref.relation ?? '').trim().toLowerCase());

    if (name.length < 2 || name.length > 100 || !/^\p{L}[\p{L}\p{M} .'-]*$/u.test(name)) {
      throw invalid(`${label}: please enter their full name (letters only).`);
    }
    if (!/^[6-9]\d{9}$/.test(mobile)) throw invalid(`${label}: please enter a valid 10-digit mobile number.`);
    if (own && mobile === own) throw invalid(`${label}: this is your own number. Please give someone else's number.`);
    if (!relation) throw invalid(`${label}: please choose how they are related to you.`);
    return { slot: i + 1, name, mobile, relation };
  });
  if (refs[0].mobile === refs[1].mobile) throw invalid('The two references must have different mobile numbers.');
  return refs;
};

// The saved references of several users at once → Map(userId → [refs]).
const referencesOf = async (userIds) => {
  const ids = [...new Set(userIds.filter((id) => id != null))];
  if (!ids.length) return new Map();
  try {
    const [rows] = await pool.query(
      'SELECT user_id, slot, name, mobile, relation, updated_at FROM user_references WHERE user_id IN (?) ORDER BY user_id, slot',
      [ids]
    );
    const byUser = new Map();
    for (const { user_id, ...ref } of rows) {
      if (!byUser.has(user_id)) byUser.set(user_id, []);
      byUser.get(user_id).push(ref);
    }
    return byUser;
  } catch (err) {
    if (!isMissingTable(err)) console.error('[references] could not read references:', err.message);
    return new Map();
  }
};

// One user's references ([] when they have given none).
const getReferences = async (userId) => (await referencesOf([userId])).get(Number(userId)) ?? [];

// Adds `references` to rows that carry a user id under `idKey`.
const attachReferences = async (rows, idKey = 'id') => {
  const byUser = await referencesOf(rows.map((row) => row[idKey]));
  for (const row of rows) row.references = byUser.get(row[idKey]) ?? [];
  return rows;
};

// For DSA / bank partners: who the references are, not their phone numbers.
const maskReferences = (refs) => (refs || []).map((ref) => ({
  ...ref,
  mobile: ref.mobile ? `••••••${String(ref.mobile).slice(-4)}` : ref.mobile,
}));

// True once a save has failed (say, the database user may not create tables).
// The forms are then told to stop requiring references, so onboarding is not
// blocked by something the customer cannot fix.
let unavailable = false;
const isReferencesUnavailable = () => unavailable;

// `refs` comes from cleanReferences(). Resolves to whether they were stored;
// it never throws.
const saveReferences = async (userId, refs) => {
  const write = async () => {
    await pool.query(
      `INSERT INTO user_references (user_id, slot, name, mobile, relation) VALUES ?
       ON DUPLICATE KEY UPDATE name = VALUES(name), mobile = VALUES(mobile), relation = VALUES(relation)`,
      [refs.map((ref) => [userId, ref.slot, ref.name, ref.mobile, ref.relation])]
    );
    await pool.query('DELETE FROM user_references WHERE user_id = ? AND slot > ?', [userId, refs.length]);
  };
  try {
    try {
      await write();
    } catch (err) {
      if (!isMissingTable(err)) throw err;
      await pool.query(CREATE_TABLE_SQL);
      await write();
    }
    unavailable = false;
    return true;
  } catch (err) {
    console.error('[references] could not save references:', err.message);
    unavailable = true;
    return false;
  }
};

module.exports = {
  CREATE_TABLE_SQL, RELATIONS, cleanMobile, cleanReferences, getReferences, attachReferences,
  maskReferences, saveReferences, isReferencesUnavailable,
};
