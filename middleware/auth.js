const jwt = require('jsonwebtoken');
const { pool } = require('../config/db');
const { getCache, setCache } = require('../config/redis');

const protect = async (req, res, next) => {
  let token;
  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
    token = req.headers.authorization.split(' ')[1];
  }
  if (!token) return res.status(401).json({ success: false, message: 'Not authorized, no token' });

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    return res.status(401).json({ success: false, message: 'Invalid token' });
  }

  // 1. Try to get user from Redis cache
  const cacheKey = `user:auth:${decoded.id}`;
  try {
    const cachedUser = await getCache(cacheKey);
    if (cachedUser) {
      req.user = cachedUser;
      return next();
    }
  } catch (cacheErr) {
    console.warn('⚠️ Redis cache read failed in auth middleware:', cacheErr.message);
  }

  // 2. Fall back to MySQL database
  try {
    const [rows] = await pool.query('SELECT id, full_name, mobile, email, is_active, is_kyc_verified, is_dsa_partner, referral_code FROM users WHERE id = ?', [decoded.id]);
    if (!rows.length || !rows[0].is_active) {
      return res.status(401).json({ success: false, message: 'User not found or deactivated' });
    }
    
    req.user = rows[0];

    // Cache the user info in Redis for 60 seconds
    try {
      await setCache(cacheKey, rows[0], 60);
    } catch (cacheErr) {
      console.warn('⚠️ Redis cache write failed in auth middleware:', cacheErr.message);
    }

    next();
  } catch (err) {
    console.error('❌ Auth middleware database error:', err);
    return res.status(500).json({ success: false, message: 'Database connection error' });
  }
};

// Loads admin + their permissions into req.admin and req.adminPermissions
const adminProtect = async (req, res, next) => {
  let token;
  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
    token = req.headers.authorization.split(' ')[1];
  }
  if (!token) return res.status(401).json({ success: false, message: 'Not authorized' });

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    return res.status(401).json({ success: false, message: 'Invalid token' });
  }

  if (decoded.role !== 'admin') {
    return res.status(403).json({ success: false, message: 'Admin access required' });
  }

  // 1. Try to get admin + permissions from Redis cache
  const cacheKey = `admin:auth:${decoded.id}`;
  try {
    const cachedAdmin = await getCache(cacheKey);
    if (cachedAdmin) {
      req.admin = cachedAdmin.admin;
      req.adminPermissions = cachedAdmin.permissions;
      return next();
    }
  } catch (cacheErr) {
    console.warn('⚠️ Redis cache read failed in admin auth middleware:', cacheErr.message);
  }

  // 2. Fall back to MySQL database
  try {
    const [rows] = await pool.query(
      `SELECT a.id, a.name, a.email, a.role,
              p.view_dashboard, p.manage_users, p.manage_loans, p.manage_kyc,
              p.view_transactions, p.manage_transactions, p.send_notifications,
              p.manage_referrals, p.manage_settings, p.manage_admins, p.manage_dsa
       FROM admins a
       LEFT JOIN admin_permissions p ON p.admin_id = a.id
       WHERE a.id = ? AND a.is_active = 1`,
      [decoded.id]
    );
    if (!rows.length) return res.status(401).json({ success: false, message: 'Admin not found' });

    const row = rows[0];
    const adminData = { id: row.id, name: row.name, email: row.email, role: row.role };
    let permissionsData = {};

    // super_admin always has all permissions
    if (row.role === 'super_admin') {
      permissionsData = {
        view_dashboard: 1, manage_users: 1, manage_loans: 1, manage_kyc: 1,
        view_transactions: 1, manage_transactions: 1, send_notifications: 1,
        manage_referrals: 1, manage_settings: 1, manage_admins: 1, manage_dsa: 1,
      };
    } else {
      permissionsData = {
        view_dashboard:      row.view_dashboard      ?? 1,
        manage_users:        row.manage_users        ?? 1,
        manage_loans:        row.manage_loans        ?? 1,
        manage_kyc:          row.manage_kyc          ?? 1,
        view_transactions:   row.view_transactions   ?? 1,
        manage_transactions: row.manage_transactions ?? 0,
        send_notifications:  row.send_notifications  ?? 1,
        manage_referrals:    row.manage_referrals    ?? 1,
        manage_settings:     row.manage_settings     ?? 0,
        manage_admins:       row.manage_admins       ?? 0,
        manage_dsa:          row.manage_dsa          ?? 0,
      };
    }

    req.admin = adminData;
    req.adminPermissions = permissionsData;

    // Cache the admin info in Redis for 60 seconds
    try {
      await setCache(cacheKey, { admin: adminData, permissions: permissionsData }, 60);
    } catch (cacheErr) {
      console.warn('⚠️ Redis cache write failed in admin auth middleware:', cacheErr.message);
    }

    next();
  } catch (err) {
    console.error('❌ Admin auth middleware database error:', err);
    return res.status(500).json({ success: false, message: 'Database connection error' });
  }
};

// Only super_admin can proceed
const requireSuperAdmin = (req, res, next) => {
  if (req.admin?.role !== 'super_admin') {
    return res.status(403).json({ success: false, message: 'Super admin access required' });
  }
  next();
};

// Factory: check a specific permission key
const requirePermission = (permission) => (req, res, next) => {
  if (req.admin?.role === 'super_admin') return next();

  // Auto-grant basic operational permissions to DSA/Bank Partners
  const isPartner = ['dsa_partner', 'bank_partner'].includes(req.admin?.role);
  const partnerPermissions = [
    'view_dashboard', 
    'manage_users', 
    'manage_loans', 
    'manage_kyc', 
    'view_transactions', 
    'manage_referrals'
  ];
  if (isPartner && partnerPermissions.includes(permission)) {
    return next();
  }

  if (!req.adminPermissions?.[permission]) {
    return res.status(403).json({ success: false, message: 'You do not have permission to perform this action' });
  }
  next();
};

module.exports = { protect, adminProtect, requireSuperAdmin, requirePermission };
