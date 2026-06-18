const { pool } = require('../config/db');

async function migrate() {
  try {
    console.log("Starting withdrawal_limit migration...");

    // 1. Add withdrawal_limit to users table if it doesn't exist
    try {
      await pool.query(`
        ALTER TABLE users 
        ADD COLUMN withdrawal_limit DECIMAL(12,2) DEFAULT NULL AFTER credit_limit
      `);
      console.log("Added withdrawal_limit column to users table.");
    } catch (err) {
      if (err.code === 'ER_DUP_FIELDNAME') {
        console.log("withdrawal_limit column already exists in users table.");
      } else {
        console.error("Failed to add withdrawal_limit column:", err.message);
        throw err;
      }
    }

    console.log("Migration completed successfully!");
    process.exit(0);
  } catch (err) {
    console.error("Migration failed:", err.message);
    process.exit(1);
  }
}

migrate();
