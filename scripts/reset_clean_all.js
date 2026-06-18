const { pool } = require('../config/db');

async function cleanAll() {
  let connection;
  try {
    console.log("Starting total database purge...");

    connection = await pool.getConnection();
    await connection.beginTransaction();

    // Disable foreign keys
    await connection.query('SET FOREIGN_KEY_CHECKS = 0');

    // Tables to truncate
    const tables = [
      'users',
      'kyc_documents',
      'aadhaar_kyc',
      'loans',
      'transactions',
      'notifications',
      'bank_details',
      'referrals',
      'emi_schedule',
      'audit_log',
      'admin_permissions',
      'admins'
    ];

    for (const table of tables) {
      await connection.query(`TRUNCATE TABLE ${table}`);
      console.log(`Truncated table: ${table}`);
    }

    // Re-enable foreign keys
    await connection.query('SET FOREIGN_KEY_CHECKS = 1');

    console.log("All tables cleared successfully. Re-generating Super Admin account...");

    // Insert Super Admin
    await connection.query(`
      INSERT INTO admins (name, email, password, role)
      VALUES ('Super Admin', 'admin@ppokket.com', '$2b$10$yQGnMfomJsbW9fvWFhH/zO.s/I.YUx2ujz9tXTOjvgJd9laGbAZTu', 'super_admin')
    `);

    await connection.commit();

    console.log("Super Admin account generated successfully!");
    console.log("Email: admin@ppokket.com");
    console.log("Password: Admin@123");
    
    process.exit(0);
  } catch (err) {
    if (connection) {
      try { await connection.rollback(); } catch (_) {}
    }
    console.error("Purge failed:", err.message);
    process.exit(1);
  } finally {
    if (connection) {
      connection.release();
    }
  }
}

cleanAll();
