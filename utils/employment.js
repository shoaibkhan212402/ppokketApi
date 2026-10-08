const { pool } = require('../config/db');

// Where a customer works — asked with the profile at onboarding and shown on
// their profile and to the admin: the employer (or their own business), their
// role there, how many years they have worked, and optionally the current
// employer's offer letter.
//
// It lives in a table of its own, so nothing about the existing tables has to
// change. The table is created by the first save (CREATE TABLE IF NOT EXISTS);
// until then every read simply finds no details. Reading these details must
// never be what breaks a profile or an admin screen, so reads swallow errors.

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS user_employment (
    user_id           INT NOT NULL PRIMARY KEY,
    company_name      VARCHAR(150) DEFAULT NULL,
    designation       VARCHAR(100) DEFAULT NULL,
    experience_years  DECIMAL(4,1) DEFAULT NULL,
    current_job_years DECIMAL(4,1) DEFAULT NULL,
    office_city       VARCHAR(100) DEFAULT NULL,
    offer_letter      VARCHAR(500) DEFAULT NULL,
    offer_letter_at   DATETIME DEFAULT NULL,
    updated_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`;

const COLUMNS = 'user_id, company_name, designation, experience_years, current_job_years, office_city, offer_letter, offer_letter_at, updated_at';

const isMissingTable = (err) => err?.code === 'ER_NO_SUCH_TABLE';
const invalid = (message) => Object.assign(new Error(message), { isValidation: true });

const text = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const years = (value, label) => {
  if (value === undefined || value === null || value === '') return null;
  const n = Math.round(Number(value) * 10) / 10;
  if (!Number.isFinite(n) || n < 0 || n > 60) throw invalid(`${label} must be between 0 and 60 years`);
  return n;
};

// Turns what a profile form sent into what is stored. `null` means "no
// employer" (student, unemployed, …). Throws an error flagged `isValidation`
// (safe to show) when something is missing or wrong.
const cleanEmployment = (input) => {
  if (input === null) return null;
  if (typeof input !== 'object' || Array.isArray(input)) throw invalid('Invalid employment details');

  const company_name = text(input.company_name, 150);
  const designation = text(input.designation, 100);
  const experience_years = years(input.experience_years, 'Work experience');
  const current_job_years = years(input.current_job_years, 'Time in the current job');

  if (company_name.length < 2) throw invalid('Company / business name is required');
  if (designation.length < 2) throw invalid('Designation is required');
  if (experience_years === null) throw invalid('Work experience (in years) is required');
  if (current_job_years !== null && current_job_years > experience_years) {
    throw invalid('Time in the current job cannot be more than your total work experience');
  }
  return { company_name, designation, experience_years, current_job_years, office_city: text(input.office_city, 100) || null };
};

const num = (value) => (value == null ? null : Number(value));
const shape = (row) => ({
  company_name: row.company_name,
  designation: row.designation,
  experience_years: num(row.experience_years),
  current_job_years: num(row.current_job_years),
  office_city: row.office_city,
  offer_letter: row.offer_letter,
  offer_letter_at: row.offer_letter_at,
  updated_at: row.updated_at,
});

// The saved details of several users at once → Map(userId → details).
const employmentOf = async (userIds) => {
  const ids = [...new Set(userIds.filter((id) => id != null))];
  if (!ids.length) return new Map();
  try {
    const [rows] = await pool.query(`SELECT ${COLUMNS} FROM user_employment WHERE user_id IN (?)`, [ids]);
    return new Map(rows.map((row) => [row.user_id, shape(row)]));
  } catch (err) {
    if (!isMissingTable(err)) console.error('[employment] could not read employment details:', err.message);
    return new Map();
  }
};

// One user's details, or null when they have given none.
const getEmployment = async (userId) => (await employmentOf([userId])).get(Number(userId)) ?? null;

// Adds `employment` (or null) to rows that carry a user id under `idKey`.
const attachEmployment = async (rows, idKey = 'id') => {
  const byUser = await employmentOf(rows.map((row) => row[idKey]));
  for (const row of rows) row.employment = byUser.get(row[idKey]) ?? null;
  return rows;
};

// The same details for someone who may see that a document exists but not open it.
const withoutDocument = (employment) => {
  if (!employment) return null;
  const { offer_letter, ...rest } = employment;
  return { ...rest, has_offer_letter: !!offer_letter };
};

// True once a save has failed because the table could not be written or
// created (say, the database user may not create tables). The profile forms
// are told, so that these details stop being compulsory instead of blocking
// onboarding on something the customer cannot fix.
let unavailable = false;
const isEmploymentUnavailable = () => unavailable;

// Runs a write, creating the table first if this is the very first one.
// Resolves to whether it was stored; it never throws.
const store = async (write) => {
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
    console.error('[employment] could not save employment details:', err.message);
    unavailable = true;
    return false;
  }
};

// `details` comes from cleanEmployment(). null clears the employer details
// (the customer no longer has one) but keeps any uploaded offer letter.
// Resolves to false when the details could not be stored.
const saveEmployment = async (userId, details) => {
  if (details === null) {
    try {
      await pool.query(
        `UPDATE user_employment
            SET company_name = NULL, designation = NULL, experience_years = NULL, current_job_years = NULL, office_city = NULL
          WHERE user_id = ?`,
        [userId]
      );
    } catch (err) {
      // No table yet means there is nothing to clear.
      if (!isMissingTable(err)) console.error('[employment] could not clear employment details:', err.message);
    }
    return true;
  }
  return store(() => pool.query(
    `INSERT INTO user_employment (user_id, company_name, designation, experience_years, current_job_years, office_city)
     VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       company_name = VALUES(company_name), designation = VALUES(designation),
       experience_years = VALUES(experience_years), current_job_years = VALUES(current_job_years),
       office_city = VALUES(office_city)`,
    [userId, details.company_name, details.designation, details.experience_years, details.current_job_years, details.office_city]
  ));
};

// Resolves to false when it could not be stored.
const saveOfferLetter = (userId, url) => store(() => pool.query(
  `INSERT INTO user_employment (user_id, offer_letter, offer_letter_at) VALUES (?, ?, NOW())
   ON DUPLICATE KEY UPDATE offer_letter = VALUES(offer_letter), offer_letter_at = NOW()`,
  [userId, url]
));

module.exports = {
  CREATE_TABLE_SQL, cleanEmployment, getEmployment, attachEmployment, withoutDocument,
  saveEmployment, saveOfferLetter, isEmploymentUnavailable,
};
