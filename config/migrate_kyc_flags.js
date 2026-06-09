const { pool } = require('./db');
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

async function run() {
  const steps = [];

  // ── Add pan_verified to users ───────────────────────────────
  steps.push(async () => {
    try {
      await pool.query(`ALTER TABLE users ADD COLUMN pan_verified TINYINT(1) DEFAULT 0 AFTER is_kyc_verified`);

    } catch (err) {
      if (err.code === 'ER_DUP_COLUMN_NAME') console.log('ℹ️  pan_verified already exists.');
      else throw err;
    }
  });

  // ── Add aadhaar_verified to users ───────────────────────────
  steps.push(async () => {
    try {
      await pool.query(`ALTER TABLE users ADD COLUMN aadhaar_verified TINYINT(1) DEFAULT 0 AFTER pan_verified`);

    } catch (err) {
      if (err.code === 'ER_DUP_COLUMN_NAME') console.log('ℹ️  aadhaar_verified already exists.');
      else throw err;
    }
  });

  // ── Add pan_verified to kyc_documents ───────────────────────
  steps.push(async () => {
    try {
      await pool.query(`ALTER TABLE kyc_documents ADD COLUMN pan_verified TINYINT(1) DEFAULT 0 AFTER selfie`);

    } catch (err) {
      if (err.code === 'ER_DUP_COLUMN_NAME') console.log('ℹ️  kyc_documents.pan_verified already exists.');
      else throw err;
    }
  });

  // ── Add aadhaar_verified to kyc_documents ───────────────────
  steps.push(async () => {
    try {
      await pool.query(`ALTER TABLE kyc_documents ADD COLUMN aadhaar_verified TINYINT(1) DEFAULT 0 AFTER pan_verified`);

    } catch (err) {
      if (err.code === 'ER_DUP_COLUMN_NAME') console.log('ℹ️  kyc_documents.aadhaar_verified already exists.');
      else throw err;
    }
  });

  // ── Add pan_verify_request_id to kyc_documents ──────────────
  steps.push(async () => {
    try {
      await pool.query(`ALTER TABLE kyc_documents ADD COLUMN pan_verify_request_id VARCHAR(100) DEFAULT NULL`);

    } catch (err) {
      if (err.code === 'ER_DUP_COLUMN_NAME') console.log('ℹ️  pan_verify_request_id already exists.');
      else throw err;
    }
  });

  try {

    for (const step of steps) await step();

  } catch (err) {
    console.error('❌ Migration failed:', err.message);
  } finally {
    process.exit(0);
  }
}

run();

