const { pool } = require('../config/db');
const { auditLog } = require('./audit');

// Archive (Admin → Archive, super admin): customers set aside because they are
// not needed right now — typically someone who started KYC and left it half
// done. An archived customer is only hidden from the admin's working lists
// (Users, KYC Review, leads, dashboard counts); nothing about their account
// changes and they can still log in. If they come back and carry on (KYC step,
// profile save, loan application) they leave the archive by themselves.
//
// One table of its own, created on first use (no hand-run SQL, nothing else
// altered). A customer with a loan in progress cannot be archived.

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS user_archive (
    user_id          INT NOT NULL PRIMARY KEY,
    reason           VARCHAR(255) DEFAULT NULL,
    stage            VARCHAR(60) DEFAULT NULL,
    archived_by      INT DEFAULT NULL,
    archived_by_name VARCHAR(100) DEFAULT NULL,
    archived_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`;

const ACTIVE_LOAN_STATUSES = ['pending', 'under_review', 'approved', 'withdrawal_requested', 'disbursed'];
const isMissingTable = (err) => err?.code === 'ER_NO_SUCH_TABLE';

// The table has to exist before a list query can leave archived customers
// out. Resolves to whether it does (false = lists simply show everyone).
let ready = null;
const ensureArchiveTable = () => {
  ready = ready || pool.query(CREATE_TABLE_SQL).then(() => true).catch((err) => {
    console.error('[archive] could not create user_archive:', err.message);
    ready = null;
    return false;
  });
  return ready;
};

// "AND <alias> is not archived", or '' when the table is unavailable
const notArchivedSql = async (alias = 'u') => (
  (await ensureArchiveTable()) ? ` AND NOT EXISTS (SELECT 1 FROM user_archive ua WHERE ua.user_id = ${alias}.id)` : ''
);

// Where a customer stopped, in words the admin understands.
const kycStage = (r) => {
  if (r.is_kyc_verified || r.kyc_status === 'approved') return 'KYC approved';
  if (r.kyc_status === 'rejected') return 'KYC rejected, not re-submitted';
  if (!r.full_name || !r.email || !r.date_of_birth) return 'Profile not completed';
  if (!r.pan_verified) return 'Stopped at PAN';
  if (!r.aadhaar_verified) return 'Stopped at Aadhaar';
  if (!r.bank_verified) return 'Stopped at bank account';
  const docs = ['aadhaar_front', 'aadhaar_back', 'pan_card', 'selfie', 'bank_passbook'].filter((f) => r[f]).length;
  if (docs < 5) return `Documents ${docs}/5 uploaded`;
  return 'KYC submitted — waiting for review';
};

const CUSTOMER_COLUMNS = `
  u.id, u.full_name, u.mobile, u.email, u.date_of_birth, u.created_at, u.updated_at, u.is_kyc_verified,
  u.pan_verified, u.aadhaar_verified, u.bank_verified,
  kd.status AS kyc_status, kd.aadhaar_front, kd.aadhaar_back, kd.pan_card, kd.selfie, kd.bank_passbook, kd.updated_at AS kyc_updated_at,
  GREATEST(u.updated_at, COALESCE(kd.updated_at, u.created_at), u.created_at) AS last_activity`;

const shape = (r) => ({
  id: r.id, full_name: r.full_name, mobile: r.mobile, email: r.email, created_at: r.created_at,
  last_activity: r.last_activity, kyc_status: r.kyc_status || 'not_started', stage: kycStage(r),
  ...(r.archived_at ? { archived_at: r.archived_at, reason: r.reason, archived_by_name: r.archived_by_name, archived_stage: r.archived_stage } : {}),
});

const searchSql = (search) => (search ? { sql: ' AND (u.full_name LIKE ? OR u.mobile LIKE ? OR u.email LIKE ?)', params: Array(3).fill(`%${search}%`) } : { sql: '', params: [] });

// Customers who started but did not finish KYC, have no loan in progress,
// are not archived and have done nothing for `days` days.
const listCandidates = async ({ days = 7, search = '' } = {}) => {
  if (!(await ensureArchiveTable())) return [];
  const s = searchSql(search);
  const [rows] = await pool.query(
    `SELECT ${CUSTOMER_COLUMNS}
       FROM users u
       LEFT JOIN kyc_documents kd ON kd.user_id = u.id
      WHERE COALESCE(u.is_kyc_verified, 0) = 0
        AND COALESCE(kd.status, '') <> 'approved'
        AND NOT EXISTS (SELECT 1 FROM user_archive ua WHERE ua.user_id = u.id)
        AND NOT EXISTS (SELECT 1 FROM loans l WHERE l.user_id = u.id AND l.status IN (?))
        AND GREATEST(u.updated_at, COALESCE(kd.updated_at, u.created_at), u.created_at) < NOW() - INTERVAL ? DAY
        ${s.sql}
      ORDER BY last_activity ASC
      LIMIT 500`,
    [ACTIVE_LOAN_STATUSES, Math.max(0, Number(days) || 0), ...s.params]
  );
  // A KYC that is complete and waiting for review is the team's to act on, not abandoned
  return rows.map(shape).filter((c) => c.stage !== 'KYC submitted — waiting for review');
};

const listArchived = async ({ search = '' } = {}) => {
  if (!(await ensureArchiveTable())) return [];
  const s = searchSql(search);
  const [rows] = await pool.query(
    `SELECT ${CUSTOMER_COLUMNS}, ua.archived_at, ua.reason, ua.archived_by_name, ua.stage AS archived_stage
       FROM user_archive ua
       JOIN users u ON u.id = ua.user_id
       LEFT JOIN kyc_documents kd ON kd.user_id = u.id
      WHERE 1 = 1 ${s.sql}
      ORDER BY ua.archived_at DESC
      LIMIT 1000`,
    s.params
  );
  return rows.map(shape);
};

const archivedCount = async () => {
  if (!(await ensureArchiveTable())) return 0;
  const [[r]] = await pool.query('SELECT COUNT(*) AS n FROM user_archive');
  return r.n;
};

// Archives customers; one with a loan in progress is skipped (with the reason).
const archiveCustomers = async (userIds, reason, req) => {
  const ids = [...new Set((userIds || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 500);
  if (!ids.length) throw Object.assign(new Error('Choose at least one customer.'), { isValidation: true });
  if (!(await ensureArchiveTable())) throw Object.assign(new Error('The archive is not available right now.'), { isValidation: true, status: 503 });

  const [rows] = await pool.query(
    `SELECT ${CUSTOMER_COLUMNS},
            (SELECT COUNT(*) FROM loans l WHERE l.user_id = u.id AND l.status IN (?)) AS active_loans
       FROM users u LEFT JOIN kyc_documents kd ON kd.user_id = u.id
      WHERE u.id IN (?)`,
    [ACTIVE_LOAN_STATUSES, ids]
  );
  const archived = [];
  const skipped = [];
  const note = String(reason || '').replace(/\s+/g, ' ').trim().slice(0, 255) || null;
  for (const r of rows) {
    if (r.active_loans > 0) { skipped.push({ id: r.id, name: r.full_name, why: 'has a loan in progress' }); continue; }
    await pool.query(
      `INSERT INTO user_archive (user_id, reason, stage, archived_by, archived_by_name) VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE reason = VALUES(reason), stage = VALUES(stage), archived_by = VALUES(archived_by),
                               archived_by_name = VALUES(archived_by_name), archived_at = CURRENT_TIMESTAMP`,
      [r.id, note, kycStage(r).slice(0, 60), req?.admin?.id || null, req?.admin?.name || null]
    );
    archived.push({ id: r.id, name: r.full_name, mobile: r.mobile, stage: kycStage(r) });
  }
  for (const id of ids) if (!rows.some((r) => r.id === id)) skipped.push({ id, why: 'not found' });
  if (archived.length) await auditLog({ req, action: 'customers_archived', entityType: 'user', details: { reason: note, customers: archived } });
  return { archived, skipped };
};

const restoreCustomers = async (userIds, req) => {
  const ids = [...new Set((userIds || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (!ids.length) throw Object.assign(new Error('Choose at least one customer.'), { isValidation: true });
  if (!(await ensureArchiveTable())) return 0;
  const [r] = await pool.query('DELETE FROM user_archive WHERE user_id IN (?)', [ids]);
  if (r.affectedRows) await auditLog({ req, action: 'customers_restored', entityType: 'user', details: { user_ids: ids } });
  return r.affectedRows;
};

// The customer is active again (KYC step, profile save, loan application):
// out of the archive. Never throws — it must not break what they are doing.
const leaveArchive = async (userId, why) => {
  try {
    const [r] = await pool.query('DELETE FROM user_archive WHERE user_id = ?', [userId]);
    if (r.affectedRows) {
      await auditLog({ req: null, action: 'customer_left_archive', entityType: 'user', entityId: userId, details: { why } });
    }
  } catch (err) {
    if (!isMissingTable(err)) console.error('[archive] could not take the customer out of the archive:', err.message);
  }
};

// Route middleware (after `protect`) for the customer's own actions: once the
// request has succeeded, an archived customer leaves the archive.
// `when(req)` can narrow it (e.g. a profile save, not a token refresh).
const backFromArchive = (why, when = () => true) => (req, res, next) => {
  res.on('finish', () => {
    if (res.statusCode < 400 && req.user?.id && when(req)) leaveArchive(req.user.id, why);
  });
  next();
};

module.exports = {
  CREATE_TABLE_SQL, ensureArchiveTable, notArchivedSql, kycStage,
  listCandidates, listArchived, archivedCount, archiveCustomers, restoreCustomers, leaveArchive, backFromArchive,
};
