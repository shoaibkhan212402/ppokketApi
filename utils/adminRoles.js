const { pool } = require('../config/db');
const { allowEnumValue, columnInfo } = require('./schemaUpgrades');

// Every role an admin account can have.
const ADMIN_ROLES = ['super_admin', 'admin', 'reviewer', 'dsa_partner', 'bank_partner'];
// Roles the super admin can give from Admin Management.
const ASSIGNABLE_ROLES = ['admin', 'reviewer', 'dsa_partner', 'bank_partner'];
const PARTNER_ROLES = ['dsa_partner', 'bank_partner'];

const ROLE_LABELS = {
  super_admin: 'Super Admin', admin: 'Admin', reviewer: 'Reviewer',
  dsa_partner: 'DSA Partner', bank_partner: 'Bank Partner',
};

// A row whose role is none of these is not let in. On older databases
// admins.role was ENUM('super_admin','admin','reviewer'); the database there is
// lenient, so a DSA / Bank partner was saved with role '' instead of failing —
// shown as "Admin" and treated as a full admin who sees every customer.
const isKnownRole = (role) => ADMIN_ROLES.includes(role);

const ROLE_NOT_SET_MESSAGE =
  'This account has no role. The super admin has to set it (Admin Management → Role) before it can be used.';

// Makes sure admins.role can hold the partner roles, adding them to the ENUM
// when they are missing. Only ever adds: the other values and the default stay.
// Runs when the super admin gives an account a partner role, so the role is
// saved for real instead of as ''.
let partnerRolesReady = false;
const ensureRoleStorable = async (role) => {
  if (partnerRolesReady || !PARTNER_ROLES.includes(role)) return;
  const conn = await pool.getConnection();
  try {
    for (const value of PARTNER_ROLES) {
      if (await allowEnumValue(conn, 'admins', 'role', value)) {
        console.log(`✅ [schema] admins.role now allows '${value}'`);
      }
    }
    const info = await columnInfo(conn, 'admins', 'role');
    const type = String(info?.type || '').toLowerCase();
    if (/^enum\(/.test(type) && PARTNER_ROLES.some(v => !type.includes(`'${v}'`))) {
      throw new Error(`admins.role is still ${info.type}`);
    }
    partnerRolesReady = true;
  } catch (err) {
    console.error('[adminRoles] Could not let admins.role hold the partner roles:', err.message);
    const e = new Error(
      'The database cannot save the DSA / Bank Partner role yet. Run backend/config/migration_partner_roles.sql once, then try again.'
    );
    e.code = 'ROLE_NOT_STORABLE';
    throw e;
  } finally {
    conn.release();
  }
};

// Reads back what was really saved — the safety net for a lenient database.
const storedRole = async (adminId) => {
  const [[row]] = await pool.query('SELECT role FROM admins WHERE id = ?', [adminId]);
  return row ? row.role : undefined;
};

module.exports = {
  ADMIN_ROLES, ASSIGNABLE_ROLES, PARTNER_ROLES, ROLE_LABELS, ROLE_NOT_SET_MESSAGE,
  isKnownRole, ensureRoleStorable, storedRole,
};
