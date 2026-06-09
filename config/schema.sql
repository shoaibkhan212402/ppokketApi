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
  aadhaar_ref_id    VARCHAR(100) DEFAULT NULL,
  date_of_birth     DATE,
  occupation        VARCHAR(100),
  monthly_income    DECIMAL(12,2),
  credit_score      INT DEFAULT 650,
  credit_limit      DECIMAL(12,2) DEFAULT 10000.00,
  wallet_balance    DECIMAL(12,2) DEFAULT 0.00,
  interest_rate     DECIMAL(5,2) DEFAULT 2.50,
  referral_code     VARCHAR(20) UNIQUE,
  referred_by       INT,
  fcm_token         TEXT,
  is_active         TINYINT(1) DEFAULT 1,
  is_kyc_verified   TINYINT(1) DEFAULT 0,
  pan_verified      TINYINT(1) DEFAULT 0,
  aadhaar_verified  TINYINT(1) DEFAULT 0,
  bank_verified     TINYINT(1) DEFAULT 0,
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
  total_payable   DECIMAL(12,2) NOT NULL,
  amount_paid     DECIMAL(12,2) DEFAULT 0.00,
  purpose         VARCHAR(255),
  status          ENUM('pending','under_review','approved','rejected','disbursed','closed') DEFAULT 'pending',
  approved_by     INT,
  disbursed_at    TIMESTAMP NULL,
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
  type                ENUM('credit','debit','emi','refund','cashback') NOT NULL,
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
  last_login TIMESTAMP NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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
  is_verified    TINYINT(1) DEFAULT 0,
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
  status          ENUM('pending','credited') DEFAULT 'pending',
  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
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
  status           ENUM('upcoming','paid','overdue') DEFAULT 'upcoming',
  paid_at          TIMESTAMP NULL,
  FOREIGN KEY (loan_id) REFERENCES loans(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- DEFAULT ADMIN SEED
INSERT IGNORE INTO admins (name, email, password, role)
VALUES ('Super Admin', 'admin@ppokket.com', '$2b$10$yQGnMfomJsbW9fvWFhH/zO.s/I.YUx2ujz9tXTOjvgJd9laGbAZTu', 'super_admin');
-- Default password: Admin@123

-- INDEXES
CREATE INDEX IF NOT EXISTS idx_users_mobile        ON users(mobile);
CREATE INDEX IF NOT EXISTS idx_loans_user_id       ON loans(user_id);
CREATE INDEX IF NOT EXISTS idx_loans_status        ON loans(status);
CREATE INDEX IF NOT EXISTS idx_transactions_user_id ON transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_emi_loan_id         ON emi_schedule(loan_id);
CREATE INDEX IF NOT EXISTS idx_emi_due_date        ON emi_schedule(due_date);
