const { pool } = require('../config/db');

// Who did what in the admin panel (and the system jobs that act for it):
// approvals, disbursals, cancellations, role changes, deletions…
//
// The table creates itself on first use (CREATE TABLE IF NOT EXISTS, no
// foreign keys) — the live database never had it, so every write used to fail
// silently. Rows carry their own time, written in India time (the pool's
// timezone), because the database server's own clock runs on UTC.
const CREATE_AUDIT_LOG_SQL = `
  CREATE TABLE IF NOT EXISTS audit_log (
    id          BIGINT AUTO_INCREMENT PRIMARY KEY,
    admin_id    INT NULL,
    admin_name  VARCHAR(150) NULL,
    admin_role  VARCHAR(30) NULL,
    action      VARCHAR(80) NOT NULL,
    entity_type VARCHAR(40) NULL,
    entity_id   VARCHAR(64) NULL,
    details     MEDIUMTEXT NULL,
    ip_address  VARCHAR(64) NULL,
    created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_audit_created (created_at),
    INDEX idx_audit_entity (entity_type, entity_id),
    INDEX idx_audit_admin (admin_id, created_at),
    INDEX idx_audit_action (action)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`;

const isMissingTable = (err) => err?.code === 'ER_NO_SUCH_TABLE';

let tableReady = null;
const ensureAuditTable = () => {
  tableReady = tableReady || pool.query(CREATE_AUDIT_LOG_SQL).then(() => true).catch((err) => {
    tableReady = null; // try again next time
    throw err;
  });
  return tableReady;
};

/**
 * Log an admin action to audit_log.
 * Call this after every financial or sensitive mutation.
 *
 * @param {object} opts
 * @param {object} opts.req         - Express request (for admin + IP)
 * @param {string} opts.action      - e.g. 'loan_disbursed', 'kyc_approved', 'admin_created'
 * @param {string} [opts.entityType]- 'loan' | 'user' | 'kyc' | 'admin' | 'transaction' | 'setting'
 * @param {number} [opts.entityId]  - Primary key of the affected row
 * @param {object} [opts.details]   - Any extra context (amounts, reasons, before/after)
 */
const auditLog = async ({ req, action, entityType = null, entityId = null, details = {} }) => {
  try {
    await ensureAuditTable();
    const adminId   = req?.admin?.id   || null;
    const adminName = req?.admin?.name || null;
    const adminRole = req?.admin?.role || null;
    const ip        = req?.headers?.['x-forwarded-for']?.split(',')[0]?.trim()
                   || req?.socket?.remoteAddress
                   || null;

    await pool.query(
      `INSERT INTO audit_log (admin_id, admin_name, admin_role, action, entity_type, entity_id, details, ip_address, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [adminId, adminName, adminRole, action, entityType, entityId == null ? null : String(entityId),
        JSON.stringify(details ?? {}), ip, new Date()]
    );
  } catch (err) {
    // Audit failure must never crash the main request
    console.error('[audit]', err.message);
  }
};

// For the super admin's Audit Log page. Newest first.
//   filters: { page, limit, action, entityType, entityId, adminId, from, to (YYYY-MM-DD, India dates) }
const listAuditLog = async ({ page = 1, limit = 50, action, entityType, entityId, adminId, from, to } = {}) => {
  const size = Math.min(Math.max(parseInt(limit) || 50, 1), 200);
  const pageNo = Math.max(parseInt(page) || 1, 1);
  const where = [];
  const params = [];
  if (action) { where.push('action LIKE ?'); params.push(`%${action}%`); }
  if (entityType) { where.push('entity_type = ?'); params.push(entityType); }
  if (entityId) { where.push('entity_id = ?'); params.push(String(entityId)); }
  if (adminId) { where.push('admin_id = ?'); params.push(parseInt(adminId)); }
  if (/^\d{4}-\d{2}-\d{2}$/.test(from || '')) { where.push('created_at >= ?'); params.push(`${from} 00:00:00`); }
  if (/^\d{4}-\d{2}-\d{2}$/.test(to || '')) { where.push('created_at <= ?'); params.push(`${to} 23:59:59`); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  try {
    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM audit_log ${whereSql}`, params);
    const [rows] = await pool.query(
      `SELECT id, admin_id, admin_name, admin_role, action, entity_type, entity_id, details, ip_address, created_at
         FROM audit_log ${whereSql} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
      [...params, size, (pageNo - 1) * size]
    );
    for (const r of rows) {
      try { r.details = r.details ? JSON.parse(r.details) : {}; } catch { /* keep the text */ }
    }
    // Who appears in the log, for the "by" filter
    const [admins] = await pool.query(
      'SELECT admin_id, MAX(admin_name) AS admin_name, MAX(admin_role) AS admin_role FROM audit_log WHERE admin_id IS NOT NULL GROUP BY admin_id ORDER BY admin_name'
    );
    const [types] = await pool.query('SELECT DISTINCT entity_type FROM audit_log WHERE entity_type IS NOT NULL ORDER BY entity_type');
    return { logs: rows, total: Number(total), page: pageNo, pages: Math.ceil(Number(total) / size), admins, entity_types: types.map(t => t.entity_type) };
  } catch (err) {
    if (isMissingTable(err)) return { logs: [], total: 0, page: pageNo, pages: 0, admins: [], entity_types: [] };
    throw err;
  }
};

module.exports = { auditLog, listAuditLog, ensureAuditTable, CREATE_AUDIT_LOG_SQL };
