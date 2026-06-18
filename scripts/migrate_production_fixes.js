const { pool } = require('../config/db');

async function migrate() {
  try {
    console.log("Starting production database schema synchronization...");

    // 1. Create audit_log table
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS audit_log (
          id           BIGINT AUTO_INCREMENT PRIMARY KEY,
          admin_id     INT          NULL,
          admin_name   VARCHAR(100) NULL,
          admin_role   VARCHAR(50)  NULL,
          action       VARCHAR(100) NOT NULL,
          entity_type  VARCHAR(50)  NULL,
          entity_id    INT          NULL,
          details      JSON         NULL,
          ip_address   VARCHAR(45)  NULL,
          created_at   TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_audit_admin  (admin_id),
          INDEX idx_audit_entity (entity_type, entity_id),
          INDEX idx_audit_action (action),
          INDEX idx_audit_time   (created_at),
          FOREIGN KEY (admin_id) REFERENCES admins(id) ON DELETE SET NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
      `);
      console.log("Verified audit_log table.");
    } catch (err) {
      console.error("Failed to create audit_log table:", err.message);
      throw err;
    }

    // 2. Add penalty columns to emi_schedule
    const emiScheduleCols = [
      { name: 'penalty_amount', type: 'DECIMAL(12,2) DEFAULT 0.00' },
      { name: 'penalty_days', type: 'INT DEFAULT 0' },
      { name: 'total_due', type: 'DECIMAL(12,2) AS (emi_amount + COALESCE(penalty_amount,0)) STORED' },
      { name: 'penalty_waived', type: 'TINYINT(1) DEFAULT 0' }
    ];

    for (const col of emiScheduleCols) {
      try {
        await pool.query(`ALTER TABLE emi_schedule ADD COLUMN ${col.name} ${col.type}`);
        console.log(`Added ${col.name} to emi_schedule table.`);
      } catch (err) {
        if (err.code === 'ER_DUP_FIELDNAME') {
          console.log(`${col.name} already exists in emi_schedule table.`);
        } else {
          console.error(`Failed to add ${col.name} to emi_schedule:`, err.message);
          throw err;
        }
      }
    }

    const loansCols = [
      { name: 'disburse_otp', type: 'VARCHAR(10) DEFAULT NULL' },
      { name: 'disburse_otp_expires', type: 'TIMESTAMP NULL DEFAULT NULL' },
      { name: 'disburse_confirmed', type: 'TINYINT(1) DEFAULT 0' },
      { name: 'penalty_rate', type: 'DECIMAL(5,2) DEFAULT 1.00' },
      { name: 'processing_fee_pct', type: 'DECIMAL(5,2) DEFAULT NULL' },
      { name: 'first_emi_pct', type: 'DECIMAL(5,2) DEFAULT NULL' },
      { name: 'processing_fee_in_first_emi', type: 'TINYINT(1) DEFAULT NULL' }
    ];

    for (const col of loansCols) {
      try {
        await pool.query(`ALTER TABLE loans ADD COLUMN ${col.name} ${col.type}`);
        console.log(`Added ${col.name} to loans table.`);
      } catch (err) {
        if (err.code === 'ER_DUP_FIELDNAME') {
          console.log(`${col.name} already exists in loans table.`);
        } else {
          console.error(`Failed to add ${col.name} to loans:`, err.message);
          throw err;
        }
      }
    }

    // 4. Add email verification columns to users
    const usersCols = [
      { name: 'email_verified', type: 'TINYINT(1) DEFAULT 0' },
      { name: 'email_verify_token', type: 'VARCHAR(64) DEFAULT NULL' },
      { name: 'email_verify_expires', type: 'TIMESTAMP NULL DEFAULT NULL' }
    ];

    for (const col of usersCols) {
      try {
        await pool.query(`ALTER TABLE users ADD COLUMN ${col.name} ${col.type}`);
        console.log(`Added ${col.name} to users table.`);
      } catch (err) {
        if (err.code === 'ER_DUP_FIELDNAME') {
          console.log(`${col.name} already exists in users table.`);
        } else {
          console.error(`Failed to add ${col.name} to users:`, err.message);
          throw err;
        }
      }
    }

    // 5. Add index on emi_schedule
    try {
      await pool.query(`CREATE INDEX idx_emi_status_due ON emi_schedule(status, due_date)`);
      console.log("Created index idx_emi_status_due on emi_schedule.");
    } catch (err) {
      if (err.code === 'ER_DUP_KEYNAME') {
        console.log("index idx_emi_status_due already exists.");
      } else {
        console.error("Failed to create index on emi_schedule:", err.message);
        throw err;
      }
    }

    console.log("Production schema synchronization completed successfully!");
    process.exit(0);
  } catch (err) {
    console.error("Synchronization failed:", err.message);
    process.exit(1);
  }
}

migrate();
