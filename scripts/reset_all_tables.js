const { pool } = require('../config/db');

async function resetAll() {
  let connection;
  try {
    console.log("Starting optimized full database reset (preserving admins and permissions)...");

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
      'audit_log'
    ];

    for (const table of tables) {
      await connection.query(`TRUNCATE TABLE ${table}`);
      console.log(`Truncated table: ${table}`);
    }

    // Re-enable foreign keys
    await connection.query('SET FOREIGN_KEY_CHECKS = 1');

    await connection.commit();
    console.log("Database cleanup completed successfully! Admins and permissions preserved.");
    process.exit(0);
  } catch (err) {
    if (connection) {
      try { await connection.rollback(); } catch (_) {}
    }
    console.error("Database reset failed:", err.message);
    process.exit(1);
  } finally {
    if (connection) {
      connection.release();
    }
  }
}

resetAll();
