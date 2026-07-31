-- ============================================
-- PPOKKET DATABASE SCHEMA  (fully updated)
-- ============================================
CREATE DATABASE IF NOT EXISTS ppokket_db;
USE ppokket_db;

-- USERS TABLE
CREATE TABLE IF NOT EXISTS users (
  id                INT AUTO_INCREMENT PRIMARY KEY,
  full_name         VARCHAR(150) NOT NULL,
  mobile            VARCHAR(15) NOT NULL UNIQUE,
  email             VARCHAR(191) UNIQUE,
  pan_number        VARCHAR(10),
  aadhaar_number    VARCHAR(12),
  full_address      VARCHAR(500) DEFAULT NULL,
  aadhaar_ref_id    VARCHAR(100) DEFAULT NULL,
  date_of_birth     DATE,
  occupation        VARCHAR(100),
  monthly_income    DECIMAL(12,2),
  credit_score      INT DEFAULT NULL,
  experian_score    INT DEFAULT NULL,
  experian_fetched_at DATETIME DEFAULT NULL,
  credit_limit      DECIMAL(12,2) DEFAULT 10000.00,
  withdrawal_limit  DECIMAL(12,2) DEFAULT NULL,  -- NULL = same as credit_limit; set lower to cap withdrawal
  wallet_balance    DECIMAL(12,2) DEFAULT 0.00,
  interest_rate     DECIMAL(5,2) DEFAULT 2.50,
  custom_processing_fee_pct DECIMAL(5,2) DEFAULT NULL,
  custom_first_emi_pct      DECIMAL(5,2) DEFAULT NULL,
  kyc_approved_tenure       INT DEFAULT NULL,
  kyc_first_emi_amount      DECIMAL(12,2) DEFAULT NULL,
  kyc_regular_emi_amount    DECIMAL(12,2) DEFAULT NULL,
  referral_code     VARCHAR(20) UNIQUE,
  referred_by       INT,
  fcm_token         TEXT,
  is_active         TINYINT(1) DEFAULT 1,
  is_kyc_verified   TINYINT(1) DEFAULT 0,
  pan_verified      TINYINT(1) DEFAULT 0,
  aadhaar_verified  TINYINT(1) DEFAULT 0,
  bank_verified     TINYINT(1) DEFAULT 0,
  is_dsa_partner    TINYINT(1) DEFAULT 0,
  assigned_partner_id INT DEFAULT NULL,
  lead_status       ENUM('new','contacted','docs_submitted','kyc_pending','kyc_done','loan_applied','converted','inactive') DEFAULT 'new',
  dsa_custom_status VARCHAR(255) DEFAULT NULL,
  dark_mode         TINYINT(1) DEFAULT 0,
  language          VARCHAR(10) DEFAULT 'en',
  created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (referred_by) REFERENCES users(id) ON DELETE SET NULL
);

-- KYC DOCUMENTS TABLE
CREATE TABLE IF NOT EXISTS kyc_documents (
  id                    INT AUTO_INCREMENT PRIMARY KEY,
  user_id               INT NOT NULL UNIQUE,
  aadhaar_front         VARCHAR(500),
  aadhaar_back          VARCHAR(500),
  pan_card              VARCHAR(500),
  selfie                VARCHAR(500),
  bank_passbook         VARCHAR(500),
  pan_verified          TINYINT(1) DEFAULT 0,
  aadhaar_verified      TINYINT(1) DEFAULT 0,
  pan_verify_request_id VARCHAR(100) DEFAULT NULL,
  status                ENUM('pending','under_review','approved','rejected') DEFAULT 'pending',
  rejection_reason      TEXT,
  reviewed_by           INT,
  reviewed_at           TIMESTAMP NULL,
  created_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- AADHAAR KYC TABLE  (populated via OTP verification)
CREATE TABLE IF NOT EXISTS aadhaar_kyc (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  user_id      INT NOT NULL UNIQUE,
  name         VARCHAR(200),
  dob          DATE,
  gender       CHAR(1),
  care_of      VARCHAR(300),
  full_address TEXT,
  address_json JSON,
  has_photo    TINYINT(1) DEFAULT 0,
  photo_base64 LONGTEXT,
  request_id   VARCHAR(100),
  created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- LOANS TABLE
CREATE TABLE IF NOT EXISTS loans (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  user_id         INT NOT NULL,
  amount          DECIMAL(12,2) NOT NULL,
  interest_rate   DECIMAL(5,2) NOT NULL DEFAULT 2.5,
  duration_months INT NOT NULL,
  emi_amount      DECIMAL(12,2) NOT NULL,
  processing_fee  DECIMAL(12,2) DEFAULT 0.00,
  processing_fee_pct DECIMAL(5,2) DEFAULT NULL,
  first_emi_pct   DECIMAL(5,2) DEFAULT NULL,
  processing_fee_in_first_emi TINYINT(1) DEFAULT NULL,
  total_payable   DECIMAL(12,2) NOT NULL,
  penalty_rate    DECIMAL(5,2) DEFAULT 1.00,
  settlement_amount DECIMAL(12,2) DEFAULT NULL,
  amount_paid     DECIMAL(12,2) DEFAULT 0.00,
  purpose         VARCHAR(255),
  status          ENUM('pending','under_review','approved','withdrawal_requested','rejected','disbursed','closed') DEFAULT 'pending',
  approved_by     INT,
  disbursed_at    TIMESTAMP NULL,
  agreement_accepted    TINYINT(1) DEFAULT 0,
  agreement_accepted_at DATETIME DEFAULT NULL,
  disburse_confirmed    TINYINT(1) DEFAULT 0,
  approved_at     TIMESTAMP NULL,
  rejected_reason TEXT,
  next_emi_date   DATE,
  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- TRANSACTIONS TABLE
CREATE TABLE IF NOT EXISTS transactions (
  id                  INT AUTO_INCREMENT PRIMARY KEY,
  user_id             INT NOT NULL,
  loan_id             INT,
  razorpay_order_id   VARCHAR(200),
  razorpay_payment_id VARCHAR(200),
  razorpay_signature  VARCHAR(500),
  amount              DECIMAL(12,2) NOT NULL,
  cashfree_order_id   VARCHAR(100) DEFAULT NULL,
  cashfree_payment_id VARCHAR(100) DEFAULT NULL,
  emi_no              INT DEFAULT NULL,
  type                ENUM('credit','debit','emi','refund','cashback','settlement','investment','investment_payout','investment_withdrawal') NOT NULL,
  status              ENUM('pending','success','failed') DEFAULT 'pending',
  description         VARCHAR(500),
  receipt_url         VARCHAR(500),
  created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (loan_id) REFERENCES loans(id) ON DELETE SET NULL
);

-- NOTIFICATIONS TABLE
CREATE TABLE IF NOT EXISTS notifications (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  user_id    INT NOT NULL,
  title      VARCHAR(255) NOT NULL,
  message    TEXT NOT NULL,
  type       ENUM('loan','payment','kyc','emi','system','promo') DEFAULT 'system',
  is_read    TINYINT(1) DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- ADMINS TABLE
CREATE TABLE IF NOT EXISTS admins (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  name       VARCHAR(150) NOT NULL,
  email      VARCHAR(191) NOT NULL UNIQUE,
  password   VARCHAR(255) NOT NULL,
  role       ENUM('super_admin','admin','reviewer') DEFAULT 'admin',
  is_active  TINYINT(1) DEFAULT 1,
  created_by INT DEFAULT NULL,
  last_login TIMESTAMP NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (created_by) REFERENCES admins(id) ON DELETE SET NULL
);

-- ADMIN PERMISSIONS TABLE (granular per-admin access control)
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

-- BANK DETAILS TABLE
CREATE TABLE IF NOT EXISTS bank_details (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  user_id        INT NOT NULL UNIQUE,
  account_holder VARCHAR(150),
  account_number VARCHAR(50),
  ifsc_code      VARCHAR(20),
  bank_name      VARCHAR(100),
  account_type   ENUM('savings','current') DEFAULT 'savings',
  ifsc_bank_name VARCHAR(150) DEFAULT NULL,
  branch         VARCHAR(100) DEFAULT NULL,
  branch_address VARCHAR(255) DEFAULT NULL,
  city           VARCHAR(100) DEFAULT NULL,
  state          VARCHAR(100) DEFAULT NULL,
  micr           VARCHAR(20)  DEFAULT NULL,
  swift          VARCHAR(20)  DEFAULT NULL,
  contact        VARCHAR(50)  DEFAULT NULL,
  neft           TINYINT(1)   DEFAULT NULL,
  rtgs           TINYINT(1)   DEFAULT NULL,
  imps           TINYINT(1)   DEFAULT NULL,
  upi            TINYINT(1)   DEFAULT NULL,
  ifsc_verified  TINYINT(1)   DEFAULT 0,
  ifsc_request_id VARCHAR(100) DEFAULT NULL,
  is_verified    TINYINT(1)   DEFAULT 0,
  created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- REFERRALS TABLE
CREATE TABLE IF NOT EXISTS referrals (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  referrer_id     INT NOT NULL,
  referred_id     INT NOT NULL,
  cashback_amount DECIMAL(10,2) DEFAULT 200.00,
  credited_amount DECIMAL(10,2) DEFAULT NULL,
  status          ENUM('pending','credited') DEFAULT 'pending',
  note            VARCHAR(500) DEFAULT NULL,
  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_referral_pair (referrer_id, referred_id),
  FOREIGN KEY (referrer_id) REFERENCES users(id),
  FOREIGN KEY (referred_id) REFERENCES users(id)
);

-- EMI SCHEDULE TABLE
CREATE TABLE IF NOT EXISTS emi_schedule (
  id               INT AUTO_INCREMENT PRIMARY KEY,
  loan_id          INT NOT NULL,
  user_id          INT NOT NULL,
  installment_no   INT NOT NULL,
  due_date         DATE NOT NULL,
  emi_amount       DECIMAL(12,2) NOT NULL,
  principal_amount DECIMAL(12,2),
  interest_amount  DECIMAL(12,2),
  paid_amount      DECIMAL(12,2) DEFAULT 0.00,
  penalty_amount   DECIMAL(10,2) DEFAULT 0.00,
  penalty_days     INT DEFAULT 0,
  status           ENUM('upcoming','paid','overdue') DEFAULT 'upcoming',
  paid_at          TIMESTAMP NULL,
  FOREIGN KEY (loan_id) REFERENCES loans(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- CONTACT US SUBMISSIONS (public contact form)
CREATE TABLE IF NOT EXISTS contact_messages (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  name       VARCHAR(150) NOT NULL,
  email      VARCHAR(191) NOT NULL,
  phone      VARCHAR(20),
  category   VARCHAR(100),
  subject    VARCHAR(255),
  message    TEXT NOT NULL,
  is_read    TINYINT(1) DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- DEFAULT ADMIN SEED
INSERT IGNORE INTO admins (name, email, password, role)
VALUES ('Super Admin', 'admin@ppokket.com', '$2b$10$yQGnMfomJsbW9fvWFhH/zO.s/I.YUx2ujz9tXTOjvgJd9laGbAZTu', 'super_admin');
-- Default password: Admin@123

-- Deferred FK: users.assigned_partner_id → admins(id) (defined here because admins table comes after users)
ALTER TABLE users ADD CONSTRAINT fk_users_assigned_partner
  FOREIGN KEY (assigned_partner_id) REFERENCES admins(id) ON DELETE SET NULL;

-- BANK MANDATES TABLE (for auto-pay e-mandate)
CREATE TABLE IF NOT EXISTS bank_mandates (
  id               INT AUTO_INCREMENT PRIMARY KEY,
  user_id          INT NOT NULL UNIQUE,
  subscription_id  VARCHAR(100) NOT NULL UNIQUE,
  plan_id          VARCHAR(100) DEFAULT NULL,
  mandate_id       VARCHAR(100) DEFAULT NULL,
  sub_reference_id VARCHAR(100) DEFAULT NULL,
  umrn             VARCHAR(100) DEFAULT NULL,
  status           ENUM('pending', 'active', 'failed', 'cancelled') DEFAULT 'pending',
  auth_link        TEXT DEFAULT NULL,
  payment_mode     VARCHAR(50) DEFAULT NULL,
  created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- CIBIL REPORTS TABLE
CREATE TABLE IF NOT EXISTS cibil_reports (
  id INT AUTO_INCREMENT PRIMARY KEY,
  pan VARCHAR(20) NOT NULL,
  mobile VARCHAR(15) NOT NULL,
  name VARCHAR(255) NULL,
  loanId VARCHAR(255) NULL,
  loanType VARCHAR(255) NULL,
  userId INT NULL,
  cibilScore INT NULL,
  creditHealth VARCHAR(50) NULL,
  populationRank INT NULL,
  htmlUrl TEXT NULL,
  parsedData JSON NULL,
  rawResponse JSON NULL,
  status VARCHAR(50) DEFAULT 'Fetched',
  apiProvider VARCHAR(50) DEFAULT 'InsightAPI',
  errorMessage TEXT NULL,
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
  updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX (pan),
  INDEX (mobile),
  INDEX (userId)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- EXPERIAN REPORTS TABLE
CREATE TABLE IF NOT EXISTS experian_reports (
  id INT AUTO_INCREMENT PRIMARY KEY,
  pan VARCHAR(20) NOT NULL,
  mobile VARCHAR(15) NOT NULL,
  name VARCHAR(255) NULL,
  loanId VARCHAR(255) NULL,
  loanType VARCHAR(255) NULL,
  userId INT NULL,
  experianScore INT NULL,
  creditHealth VARCHAR(50) NULL,
  htmlUrl TEXT NULL,
  parsedData JSON NULL,
  rawResponse JSON NULL,
  status VARCHAR(50) DEFAULT 'Fetched',
  apiProvider VARCHAR(50) DEFAULT 'InsightAPI_Experian',
  errorMessage TEXT NULL,
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
  updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX (pan),
  INDEX (mobile),
  INDEX (userId),
  INDEX (loanId, loanType)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- SYSTEM SETTINGS TABLE
CREATE TABLE IF NOT EXISTS system_settings (
  id INT AUTO_INCREMENT PRIMARY KEY,
  setting_key VARCHAR(100) NOT NULL UNIQUE,
  setting_value TEXT NOT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Default system settings
INSERT IGNORE INTO system_settings (setting_key, setting_value) VALUES
  ('first_emi_principal_pct',    '25'),
  ('gst_on_processing_fee',      '18'),
  ('processing_fee_in_first_emi','false'),
  ('step_down_emi_enabled',      'true'),
  ('penalty_rate',               '1'),
  ('grace_period_days',          '1'),
  ('investment_monthly_rate',       '1'),
  ('investment_min_amount',         '5000'),
  ('investment_max_amount',         ''),
  ('investment_min_tenure_months',  '1'),
  ('investment_max_tenure_months',  '12');

-- INVESTMENTS TABLE (fixed-return: user picks amount + tenure (months) freely;
-- interest_rate is a snapshot of the admin-configured investment_monthly_rate
-- system_setting at the time of creation, applied as simple monthly interest —
-- no separate "plans" catalog, no compounding)
--
-- Withdrawal is two-step, mirroring how loan disbursement already works in this
-- codebase (adminController.js disburseLoan): the user requests a withdrawal
-- and gives a payout destination (bank or UPI); the investment moves to
-- 'withdrawal_requested' and the payout amount/type is locked in at that
-- moment (pending_payout_amount / is_early_withdrawal) so admin timing can't
-- change what the user is owed. An admin then manually sends the money
-- outside the app and marks it complete, which is when wallet_balance is
-- actually credited and the investment reaches its terminal status
-- ('matured' or 'withdrawn').
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
  pending_payout_amount  DECIMAL(12,2) DEFAULT NULL, -- locked in at withdrawal-request time
  is_early_withdrawal    TINYINT(1) DEFAULT NULL,     -- locked in at withdrawal-request time
  withdrawal_requested_at TIMESTAMP NULL,
  matured_at             TIMESTAMP NULL, -- set when status becomes 'matured' or 'withdrawn' (terminal)
  payout_transaction_id  INT DEFAULT NULL,
  created_at             TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at             TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (payout_transaction_id) REFERENCES transactions(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Deferred FK: transactions.investment_id → investments(id) (defined here because
-- the investments table comes after transactions in this file — same reason
-- users.assigned_partner_id → admins(id) is deferred above)
ALTER TABLE transactions ADD COLUMN investment_id INT DEFAULT NULL;
ALTER TABLE transactions ADD CONSTRAINT fk_transactions_investment
  FOREIGN KEY (investment_id) REFERENCES investments(id) ON DELETE SET NULL;

-- INDEXES
CREATE INDEX idx_users_mobile           ON users(mobile);
CREATE INDEX idx_users_is_dsa_partner   ON users(is_dsa_partner);
CREATE INDEX idx_users_assigned_partner ON users(assigned_partner_id);
CREATE INDEX idx_loans_user_id          ON loans(user_id);
CREATE INDEX idx_loans_status           ON loans(status);
CREATE INDEX idx_transactions_user_id   ON transactions(user_id);
CREATE INDEX idx_notifications_user_id  ON notifications(user_id);
CREATE INDEX idx_emi_loan_id            ON emi_schedule(loan_id);
CREATE INDEX idx_emi_due_date           ON emi_schedule(due_date);
CREATE INDEX idx_investments_user_id    ON investments(user_id);
CREATE INDEX idx_investments_status     ON investments(status);
CREATE INDEX idx_investments_maturity   ON investments(maturity_date);
