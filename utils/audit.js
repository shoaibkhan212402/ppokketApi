const { pool } = require('../config/db');

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
    const adminId   = req?.admin?.id   || null;
    const adminName = req?.admin?.name || null;
    const adminRole = req?.admin?.role || null;
    const ip        = req?.headers?.['x-forwarded-for']?.split(',')[0]?.trim()
                   || req?.socket?.remoteAddress
                   || null;

    await pool.query(
      `INSERT INTO audit_log (admin_id, admin_name, admin_role, action, entity_type, entity_id, details, ip_address)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [adminId, adminName, adminRole, action, entityType, entityId, JSON.stringify(details), ip]
    );
  } catch (err) {
    // Audit failure must never crash the main request
    console.error('[audit]', err.message);
  }
};

module.exports = { auditLog };
