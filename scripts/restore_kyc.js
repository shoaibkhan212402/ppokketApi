const { pool } = require('../config/db');

async function restore() {
  const mobiles = ['7310249234', '9999999999'];
  let connection;
  try {
    console.log("Restoring and approving KYC for test users...");

    connection = await pool.getConnection();
    await connection.beginTransaction();

    for (const mobile of mobiles) {
      const [users] = await connection.query('SELECT id FROM users WHERE mobile = ?', [mobile]);
      if (!users.length) continue;
      const userId = users[0].id;

      // 1. Update user columns to verified
      await connection.query(`
        UPDATE users SET 
          full_name = 'Ppokket Test User',
          email = ?,
          pan_number = 'ABCDE1234F',
          aadhaar_number = '123456789012',
          is_kyc_verified = 1,
          pan_verified = 1,
          aadhaar_verified = 1,
          bank_verified = 1,
          lead_status = 'kyc_done'
        WHERE id = ?
      `, [`testuser_${mobile}@ppokket.com`, userId]);

      // 2. Insert approved KYC record
      await connection.query('DELETE FROM kyc_documents WHERE user_id = ?', [userId]);
      await connection.query(`
        INSERT INTO kyc_documents (user_id, status, pan_verified, aadhaar_verified, created_at)
        VALUES (?, 'approved', 1, 1, NOW())
      `, [userId]);

      // 3. Insert verified bank details record
      await connection.query('DELETE FROM bank_details WHERE user_id = ?', [userId]);
      await connection.query(`
        INSERT INTO bank_details (user_id, account_holder, account_number, ifsc_code, bank_name, account_type, is_verified, created_at)
        VALUES (?, 'Ppokket Test User', '1234567890', 'PYTM0123456', 'Paytm Payments Bank', 'savings', 1, NOW())
      `, [userId]);

      console.log(`User ${mobile} has been set to KYC approved and Bank verified state!`);
    }

    await connection.commit();
    console.log("Restored successfully!");
    process.exit(0);
  } catch (err) {
    if (connection) {
      try { await connection.rollback(); } catch (_) {}
    }
    console.error("Restore failed:", err.message);
    process.exit(1);
  } finally {
    if (connection) {
      connection.release();
    }
  }
}

restore();
