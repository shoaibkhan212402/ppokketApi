const { pool } = require('../config/db');

async function migrate() {
  try {
    console.log("Starting full DSA & Admin Permissions migration...");
    
    // 1. Add is_dsa_partner to users table if it doesn't exist
    try {
      await pool.query(`
        ALTER TABLE users 
        ADD COLUMN is_dsa_partner TINYINT(1) DEFAULT 0
      `);
      console.log("Added is_dsa_partner column to users table.");
    } catch (err) {
      if (err.code === 'ER_DUP_FIELDNAME') {
        console.log("is_dsa_partner column already exists in users table.");
      } else {
        throw err;
      }
    }
    
    // 2. Add created_by to admins table if it doesn't exist
    try {
      await pool.query(`
        ALTER TABLE admins
        ADD COLUMN created_by INT DEFAULT NULL,
        ADD CONSTRAINT fk_admin_created_by FOREIGN KEY (created_by) REFERENCES admins(id) ON DELETE SET NULL
      `);
      console.log("Added created_by column and foreign key to admins table.");
    } catch (err) {
      if (err.code === 'ER_DUP_FIELDNAME' || err.code === 'ER_DUP_KEYNAME' || err.code === 'ER_FK_DUP_NAME' || err.message.includes('Duplicate column')) {
        console.log("created_by column or foreign key already exists in admins table.");
      } else {
        throw err;
      }
    }

    // 3. Create admin_permissions table if it doesn't exist
    await pool.query(`
      CREATE TABLE IF NOT EXISTS admin_permissions (
        id                  INT AUTO_INCREMENT PRIMARY KEY,
        admin_id            INT NOT NULL UNIQUE,
        view_dashboard      TINYINT(1) DEFAULT 1,
        manage_users        TINYINT(1) DEFAULT 1,
        manage_loans        TINYINT(1) DEFAULT 1,
        manage_kyc          TINYINT(1) DEFAULT 1,
        view_transactions   TINYINT(1) DEFAULT 1,
        manage_transactions TINYINT(1) DEFAULT 0,
        send_notifications  TINYINT(1) DEFAULT 1,
        manage_referrals    TINYINT(1) DEFAULT 1,
        manage_settings     TINYINT(1) DEFAULT 0,
        manage_admins       TINYINT(1) DEFAULT 0,
        manage_dsa          TINYINT(1) DEFAULT 0,
        created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (admin_id) REFERENCES admins(id) ON DELETE CASCADE
      )
    `);
    console.log("Verified / Created admin_permissions table (including manage_dsa).");

    // 4. Just in case admin_permissions table existed but without manage_dsa, let's try to add manage_dsa column
    try {
      await pool.query(`
        ALTER TABLE admin_permissions 
        ADD COLUMN manage_dsa TINYINT(1) DEFAULT 0
      `);
      console.log("Added manage_dsa column to admin_permissions table.");
    } catch (err) {
      if (err.code === 'ER_DUP_FIELDNAME') {
        console.log("manage_dsa column already exists in admin_permissions table.");
      } else {
        throw err;
      }
    }
    
    // 5. Add credited_amount to referrals table if it doesn't exist
    try {
      await pool.query(`
        ALTER TABLE referrals 
        ADD COLUMN credited_amount DECIMAL(10,2) DEFAULT NULL
      `);
      console.log("Added credited_amount column to referrals table.");
    } catch (err) {
      if (err.code === 'ER_DUP_FIELDNAME') {
        console.log("credited_amount column already exists in referrals table.");
      } else {
        throw err;
      }
    }

    // 6. Add note to referrals table if it doesn't exist
    try {
      await pool.query(`
        ALTER TABLE referrals 
        ADD COLUMN note VARCHAR(500) DEFAULT NULL
      `);
      console.log("Added note column to referrals table.");
    } catch (err) {
      if (err.code === 'ER_DUP_FIELDNAME') {
        console.log("note column already exists in referrals table.");
      } else {
        throw err;
      }
    }

    // 7. Seed default permissions for any existing admins
    const [admins] = await pool.query('SELECT id, role FROM admins');
    for (const admin of admins) {
      const isSuper = admin.role === 'super_admin';
      await pool.query(`
        INSERT INTO admin_permissions (
          admin_id, view_dashboard, manage_users, manage_loans, manage_kyc,
          view_transactions, manage_transactions, send_notifications,
          manage_referrals, manage_settings, manage_admins, manage_dsa
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE admin_id = admin_id
      `, [
        admin.id,
        1, 1, 1, 1,
        1, isSuper ? 1 : 0, 1,
        1, isSuper ? 1 : 0, isSuper ? 1 : 0, isSuper ? 1 : 0
      ]);
    }
    console.log("Seeded / verified default admin permissions.");
    
    console.log("Migration completed successfully!");
    process.exit(0);
  } catch (err) {
    console.error("Migration failed:", err.message);
    process.exit(1);
  }
}

migrate();
