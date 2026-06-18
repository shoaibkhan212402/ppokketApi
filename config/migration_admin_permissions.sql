-- Migration: Add admin permissions system + DSA Partner columns
-- Run this on existing databases (schema.sql already includes these for fresh installs)

-- ── Step 1: admins table ──────────────────────────────────────────────────────
ALTER TABLE admins
  ADD COLUMN IF NOT EXISTS created_by INT DEFAULT NULL;

-- Add FK only if it doesn't already exist (ignore error if already present)
ALTER TABLE admins
  ADD CONSTRAINT IF NOT EXISTS fk_admin_created_by FOREIGN KEY (created_by) REFERENCES admins(id) ON DELETE SET NULL;

-- ── Step 2: users table — DSA Partner columns ─────────────────────────────────
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS is_dsa_partner    TINYINT(1) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS assigned_partner_id INT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS lead_status ENUM('new','contacted','docs_submitted','kyc_pending','kyc_done','loan_applied','converted','inactive') DEFAULT 'new';

ALTER TABLE users
  ADD CONSTRAINT IF NOT EXISTS fk_users_assigned_partner FOREIGN KEY (assigned_partner_id) REFERENCES admins(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_users_is_dsa_partner   ON users(is_dsa_partner);
CREATE INDEX IF NOT EXISTS idx_users_assigned_partner ON users(assigned_partner_id);

-- ── Step 3: admin_permissions table ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS admin_permissions (
  id                  INT AUTO_INCREMENT PRIMARY KEY,
  admin_id            INT NOT NULL UNIQUE,
  view_dashboard      TINYINT(1) DEFAULT 1,
  manage_users        TINYINT(1) DEFAULT 1,
  manage_loans        TINYINT(1) DEFAULT 1,
  manage_kyc          TINYINT(1) DEFAULT 1,
  view_transactions   TINYINT(1) DEFAULT 1,
  manage_transactions TINYINT(1) DEFAULT 0,
  send_notifications  TINYINT(1) DEFAULT 1,
  manage_referrals    TINYINT(1) DEFAULT 1,
  manage_settings     TINYINT(1) DEFAULT 0,
  manage_admins       TINYINT(1) DEFAULT 0,
  manage_dsa          TINYINT(1) DEFAULT 0,
  created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (admin_id) REFERENCES admins(id) ON DELETE CASCADE
);

-- Add manage_dsa to existing admin_permissions rows (if table already existed)
ALTER TABLE admin_permissions
  ADD COLUMN IF NOT EXISTS manage_dsa TINYINT(1) DEFAULT 0;

-- ── Step 4: seed default permissions for any admins that are missing a row ────
INSERT IGNORE INTO admin_permissions (admin_id)
  SELECT id FROM admins WHERE role != 'super_admin';
