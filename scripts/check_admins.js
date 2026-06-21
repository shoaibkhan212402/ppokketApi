const { pool } = require('../config/db');

async function run() {
  const [rows] = await pool.query('SHOW COLUMNS FROM admins');
  console.log(rows);
  process.exit(0);
}

run();
