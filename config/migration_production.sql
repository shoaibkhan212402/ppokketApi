-- ============================================================
-- PRODUCTION MIGRATION — run once against live DB
-- ============================================================

-- 1. AUDIT LOG TABLE
CREATE TABLE IF NOT EXISTS audit_log (
  id           BIGINT AUTO_INCREMENT PRIMARY KEY,
  admin_id     INT          NULL,
  admin_name   VARCHAR(100) NULL,
  admin_role   VARCHAR(50)  NULL,
  action       VARCHAR(100) NOT NULL,
  entity_type  VARCHAR(50)  NULL COMMENT 'loan | user | kyc | admin | transaction | setting',
  entity_id    INT          NULL,
  details      JSON         NULL COMMENT 'before/after values, reason, amounts',
  ip_address   VARCHAR(45)  NULL,
  created_at   TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_audit_admin  (admin_id),
  INDEX idx_audit_entity (entity_type, entity_id),
  INDEX idx_audit_action (action),
  INDEX idx_audit_time   (created_at),
  FOREIGN KEY (admin_id) REFERENCES admins(id) ON DELETE SET NULL
);

-- 2. ADD PENALTY COLUMNS TO EMI SCHEDULE
ALTER TABLE emi_schedule
  ADD COLUMN IF NOT EXISTS penalty_amount   DECIMAL(12,2) DEFAULT 0.00,
  ADD COLUMN IF NOT EXISTS penalty_days     INT           DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_due        DECIMAL(12,2)
    AS (emi_amount + COALESCE(penalty_amount,0)) STORED,
  ADD COLUMN IF NOT EXISTS penalty_waived   TINYINT(1)    DEFAULT 0;

-- 3. ADD DISBURSEMENT OTP COLUMNS TO LOANS
ALTER TABLE loans
  ADD COLUMN IF NOT EXISTS disburse_otp          VARCHAR(10)  NULL,
  ADD COLUMN IF NOT EXISTS disburse_otp_expires  TIMESTAMP   NULL,
  ADD COLUMN IF NOT EXISTS disburse_confirmed    TINYINT(1)  DEFAULT 0;

-- 4. ADD PENALTY RATE TO LOANS (admin-configurable per loan)
ALTER TABLE loans
  ADD COLUMN IF NOT EXISTS penalty_rate  DECIMAL(5,2) DEFAULT 1.00
  COMMENT 'Percent of EMI charged per overdue day';

-- 5. EMAIL VERIFICATION ON USERS
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS email_verified        TINYINT(1)   DEFAULT 0,
  ADD COLUMN IF NOT EXISTS email_verify_token    VARCHAR(64)  NULL,
  ADD COLUMN IF NOT EXISTS email_verify_expires  TIMESTAMP    NULL;

-- 6. INDEX FOR OVERDUE QUERIES
CREATE INDEX IF NOT EXISTS idx_emi_status_due ON emi_schedule(status, due_date);
