const { pool } = require('../config/db');

async function migrate() {
  try {
    console.log("Starting settlement offer database migration...");

    try {
      await pool.query(`ALTER TABLE loans ADD COLUMN settlement_amount DECIMAL(10,2) DEFAULT NULL`);
      console.log("Added settlement_amount column to loans table.");
    } catch (err) {
      if (err.code === 'ER_DUP_FIELDNAME') {
        console.log("settlement_amount already exists in loans table.");
      } else {
        console.error("Failed to add settlement_amount to loans table:", err.message);
        throw err;
      }
    }

    console.log("Settlement offer database migration completed successfully!");
    process.exit(0);
  } catch (err) {
    console.error("Migration failed:", err.message);
    process.exit(1);
  }
}

migrate();
