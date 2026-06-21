const { pool } = require('../config/db');

async function run() {
  try {
    await pool.query("ALTER TABLE admins MODIFY COLUMN role ENUM('super_admin', 'admin', 'reviewer', 'dsa_partner', 'bank_partner') DEFAULT 'admin'");
    console.log("Successfully updated the role ENUM in the admins table.");
  } catch (err) {
    console.error("Error:", err);
  } finally {
    process.exit(0);
  }
}

run();
