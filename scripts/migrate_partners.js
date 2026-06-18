const { pool } = require('../config/db');

async function migrate() {
  try {
    console.log("Starting partners and lead assignment migration...");

    // 1. Update admins.role column enum values
    try {
      await pool.query(`
        ALTER TABLE admins 
        MODIFY COLUMN role ENUM('super_admin', 'admin', 'reviewer', 'dsa_partner', 'bank_partner') DEFAULT 'admin'
      `);
      console.log("Updated admins.role enum options.");
    } catch (err) {
      console.error("Failed to update admins role enum:", err.message);
      throw err;
    }

    // 2. Add assigned_partner_id to users table if it doesn't exist
    try {
      await pool.query(`
        ALTER TABLE users 
        ADD COLUMN assigned_partner_id INT DEFAULT NULL
      `);
      console.log("Added assigned_partner_id column to users table.");
    } catch (err) {
      if (err.code === 'ER_DUP_FIELDNAME') {
        console.log("assigned_partner_id column already exists in users table.");
      } else {
        console.error("Failed to add assigned_partner_id:", err.message);
        throw err;
      }
    }

    // 3. Add foreign key constraint to users table
    try {
      await pool.query(`
        ALTER TABLE users
        ADD CONSTRAINT fk_assigned_partner 
        FOREIGN KEY (assigned_partner_id) REFERENCES admins(id) 
        ON DELETE SET NULL
      `);
      console.log("Added fk_assigned_partner foreign key constraint to users table.");
    } catch (err) {
      if (err.code === 'ER_DUP_KEYNAME' || err.code === 'ER_FK_DUP_NAME' || err.message.includes('Duplicate key name') || err.message.includes('Duplicate foreign key')) {
        console.log("fk_assigned_partner foreign key constraint already exists.");
      } else {
        console.error("Failed to add foreign key constraint:", err.message);
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
