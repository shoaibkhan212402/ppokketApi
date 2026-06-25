const { pool } = require('../config/db');

async function run() {
  try {
    const [rows] = await pool.query(
      `SELECT * FROM bank_mandates WHERE user_id = ?`,
      [20]
    );
    console.log('MANDATES:', JSON.stringify(rows, null, 2));
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

run();
