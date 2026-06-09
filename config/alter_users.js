const { pool } = require('./db');

async function run() {
  try {

    await pool.query('ALTER TABLE users ADD COLUMN interest_rate DECIMAL(5,2) DEFAULT 2.50');

  } catch (err) {
    if (err.code === 'ER_DUP_COLUMN_NAME') {

    } else {
      console.error('❌ Alter failed:', err.message);
    }
  } finally {
    process.exit(0);
  }
}

run();

