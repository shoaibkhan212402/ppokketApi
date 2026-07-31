-- ============================================
-- MIGRATION: Investment (fixed-return) feature
-- Run this once against an existing Ppokket database.
-- (fresh installs get the same tables via schema.sql directly)
--
-- Model: no admin-managed "plans" catalog — a single admin-configured
-- monthly interest rate (system_settings.investment_monthly_rate) applies to
-- every investment. Users freely pick their own amount and tenure (months,
-- bounded by investment_min_tenure_months / investment_max_tenure_months).
-- Interest is simple monthly interest: maturity = principal + principal *
-- (rate/100) * tenure_months.
--
-- Withdrawal is two-step (mirrors loan disbursement): user requests a
-- withdrawal with a payout destination (bank or UPI) -> status
-- 'withdrawal_requested', payout amount/type locked in immediately
-- (principal-only if before maturity_date, full maturity_amount if on/after
-- it). Admin manually sends the money and marks it complete, which is when
-- wallet_balance is credited and the investment reaches its terminal status.
-- ============================================

CREATE TABLE IF NOT EXISTS investments (
  id                     INT AUTO_INCREMENT PRIMARY KEY,
  user_id                INT NOT NULL,
  principal_amount       DECIMAL(12,2) NOT NULL,
  interest_rate          DECIMAL(5,2) NOT NULL,
  tenure_months          INT NOT NULL,
  maturity_amount        DECIMAL(12,2) NOT NULL,
  start_date             DATE DEFAULT NULL,
  maturity_date          DATE DEFAULT NULL,
  status                 ENUM('pending','active','withdrawal_requested','matured','cancelled','withdrawn') DEFAULT 'pending',
  payout_method          ENUM('bank','upi') DEFAULT NULL,
  payout_account_holder  VARCHAR(150) DEFAULT NULL,
  payout_account_number  VARCHAR(50)  DEFAULT NULL,
  payout_ifsc            VARCHAR(20)  DEFAULT NULL,
  payout_upi_id          VARCHAR(100) DEFAULT NULL,
  pending_payout_amount  DECIMAL(12,2) DEFAULT NULL,
  is_early_withdrawal    TINYINT(1) DEFAULT NULL,
  withdrawal_requested_at TIMESTAMP NULL,
  matured_at             TIMESTAMP NULL,
  payout_transaction_id  INT DEFAULT NULL,
  created_at             TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at             TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (payout_transaction_id) REFERENCES transactions(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE INDEX idx_investments_user_id  ON investments(user_id);
CREATE INDEX idx_investments_status   ON investments(status);
CREATE INDEX idx_investments_maturity ON investments(maturity_date);

ALTER TABLE transactions
  MODIFY COLUMN type ENUM('credit','debit','emi','refund','cashback','settlement','investment','investment_payout','investment_withdrawal') NOT NULL;

ALTER TABLE transactions ADD COLUMN investment_id INT DEFAULT NULL;
ALTER TABLE transactions ADD CONSTRAINT fk_transactions_investment
  FOREIGN KEY (investment_id) REFERENCES investments(id) ON DELETE SET NULL;

INSERT IGNORE INTO system_settings (setting_key, setting_value) VALUES
  ('investment_monthly_rate',      '1'),
  ('investment_min_amount',        '5000'),
  ('investment_max_amount',        ''),
  ('investment_min_tenure_months', '1'),
  ('investment_max_tenure_months', '12');

-- Investment management (viewing all investments, completing withdrawal
-- payouts, editing the rate/min/max settings) is super_admin-only — no
-- per-admin permission column needed.
