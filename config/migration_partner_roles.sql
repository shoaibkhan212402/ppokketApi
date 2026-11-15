-- ============================================
-- MIGRATION: let admins.role hold the DSA / Bank Partner roles
-- Run this once against an existing Ppokket database.
-- (fresh installs get it from schema.sql directly)
--
-- Usually NOT needed: the server adds these two values by itself the first
-- time the super admin creates a DSA / Bank partner (utils/adminRoles.js), or
-- at start-up when AUTO_SCHEMA_UPGRADE=true. Run it by hand only if the admin
-- panel says "Run backend/config/migration_partner_roles.sql".
--
-- Bug: the column was ENUM('super_admin','admin','reviewer'). On this lenient
-- database a DSA / Bank partner was saved with role '' — shown as "Admin" in
-- Admin Management and let in as a full admin who saw every customer.
-- The server now refuses to sign such an account in; set its role in
-- Admin Management → Role (or delete it and create it again).
--
-- Only ADDS two values; existing values, rows and the default are kept.
-- ============================================

ALTER TABLE admins
  MODIFY COLUMN role ENUM('super_admin','admin','reviewer','dsa_partner','bank_partner') DEFAULT 'admin';

-- See which accounts are affected (role shows empty):
-- SELECT id, name, email, role FROM admins WHERE role = '' OR role IS NULL;
