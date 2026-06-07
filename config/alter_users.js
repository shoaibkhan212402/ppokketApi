const { pool } = require('./db');

async function run() {
  try {
    console.log('Running database alter migration to add interest_rate to users table...');
    await pool.query('ALTER TABLE users ADD COLUMN interest_rate DECIMAL(5,2) DEFAULT 2.50');
    console.log('✅ Column interest_rate added successfully to users table.');
  } catch (err) {
    if (err.code === 'ER_DUP_COLUMN_NAME') {
      console.log('ℹ️ Column interest_rate already exists in users table.');
    } else {
      console.error('❌ Alter failed:', err.message);
    }
  } finally {
    process.exit(0);
  }
}

run();
