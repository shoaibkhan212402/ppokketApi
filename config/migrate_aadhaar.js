const { pool } = require('./db');
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

async function run() {
  const steps = [];

  // ── Step 1: Add aadhaar_ref_id to users table ──────────────────────────────
  steps.push(async () => {
    try {
      await pool.query(`ALTER TABLE users ADD COLUMN aadhaar_ref_id VARCHAR(100) DEFAULT NULL`);
      console.log('✅ Column aadhaar_ref_id added to users table.');
    } catch (err) {
      if (err.code === 'ER_DUP_COLUMN_NAME') {
        console.log('ℹ️  Column aadhaar_ref_id already exists in users table.');
      } else {
        throw err;
      }
    }
  });

  // ── Step 2: Create aadhaar_kyc table ───────────────────────────────────────
  steps.push(async () => {
    await pool.query(`
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
    `);
    console.log('✅ Table aadhaar_kyc created (or already exists).');
  });

  // ── Run all steps ──────────────────────────────────────────────────────────
  try {
    console.log('🔄 Running Aadhaar KYC migration...\n');
    for (const step of steps) {
      await step();
    }
    console.log('\n✅ Aadhaar KYC migration completed successfully.');
  } catch (err) {
    console.error('❌ Migration failed:', err.message);
  } finally {
    process.exit(0);
  }
}

run();
