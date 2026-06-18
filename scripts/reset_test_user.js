const { pool } = require('../config/db');

async function reset() {
  const mobiles = ['7310249234', '9999999999'];
  let connection;
  try {
    console.log("Starting test user database reset...");

    connection = await pool.getConnection();
    await connection.beginTransaction();

    for (const mobile of mobiles) {
      // Find user
      const [users] = await connection.query('SELECT id FROM users WHERE mobile = ?', [mobile]);
      if (!users.length) {
        console.log(`User with mobile ${mobile} not found, skipping.`);
        continue;
      }
      const userId = users[0].id;
      console.log(`Resetting user ${userId} (mobile: ${mobile})...`);

      // Delete child records
      await connection.query('DELETE FROM emi_schedule WHERE user_id = ?', [userId]);
      await connection.query('DELETE FROM transactions WHERE user_id = ?', [userId]);
      await connection.query('DELETE FROM loans WHERE user_id = ?', [userId]);
      await connection.query('DELETE FROM kyc_documents WHERE user_id = ?', [userId]);
      await connection.query('DELETE FROM aadhaar_kyc WHERE user_id = ?', [userId]);
      await connection.query('DELETE FROM bank_details WHERE user_id = ?', [userId]);
      await connection.query('DELETE FROM notifications WHERE user_id = ?', [userId]);

      // Reset user columns
      await connection.query(`
        UPDATE users SET 
          full_name = 'Ppokket User',
          email = NULL,
          pan_number = NULL,
          aadhaar_number = NULL,
          aadhaar_ref_id = NULL,
          date_of_birth = NULL,
          occupation = NULL,
          monthly_income = NULL,
          credit_score = 650,
          credit_limit = 0.00,
          withdrawal_limit = NULL,
          wallet_balance = 0.00,
          is_active = 1,
          is_kyc_verified = 0,
          pan_verified = 0,
          aadhaar_verified = 0,
          bank_verified = 0,
          assigned_partner_id = NULL,
          lead_status = 'new'
        WHERE id = ?
      `, [userId]);

      console.log(`User ${mobile} has been fully reset to new state!`);
    }

    await connection.commit();
    console.log("Database reset completed successfully!");
    process.exit(0);
  } catch (err) {
    if (connection) {
      try { await connection.rollback(); } catch (_) {}
    }
    console.error("Reset failed:", err.message);
    process.exit(1);
  } finally {
    if (connection) {
      connection.release();
    }
  }
}

reset();
