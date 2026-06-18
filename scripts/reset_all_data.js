const { pool } = require('../config/db');

async function resetAllData() {
  let connection;
  try {
    console.log("🔄 Starting optimized database reset (using a single connection & transaction)...");

    // Get a single dedicated connection from the pool
    connection = await pool.getConnection();

    // Start a transaction for speed and atomicity
    await connection.beginTransaction();

    // 1. Disable foreign keys
    await connection.query('SET FOREIGN_KEY_CHECKS = 0');

    // 2. Truncate tables
    const tablesToTruncate = [
      'loans',
      'emi_schedule',
      'transactions',
      'notifications',
      'kyc_documents',
      'aadhaar_kyc',
      'bank_details',
      'users'
    ];

    for (const table of tablesToTruncate) {
      await connection.query(`TRUNCATE TABLE ${table}`);
      console.log(`  🗑️ Truncated table: ${table}`);
    }

    // 3. Re-enable foreign keys
    await connection.query('SET FOREIGN_KEY_CHECKS = 1');
    console.log("✅ All withdrawal and KYC tables cleared.");

    // 4. Seed Test Users representing the 3 KYC states
    const dummyImage = 'https://images.unsplash.com/photo-1557683316-973673baf926?q=80&w=400';

    // User A: Pending KYC (Unclear / under review)
    console.log("👤 Creating User A: Pending KYC / Unclear...");
    const [userARes] = await connection.query(`
      INSERT INTO users (full_name, mobile, email, pan_number, aadhaar_number, date_of_birth, occupation, monthly_income, credit_score, credit_limit, is_kyc_verified, pan_verified, aadhaar_verified, bank_verified, lead_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      'Aarav Sharma', '7310249234', 'aarav.sharma@ppokket.test',
      'ABCDE1234F', '123456789012', '1995-08-15', 'salaried',
      45000.00, 720, 0.00, 0, 1, 1, 1, 'kyc_pending'
    ]);
    const userIdA = userARes.insertId;

    await connection.query(`
      INSERT INTO kyc_documents (user_id, status, aadhaar_front, aadhaar_back, pan_card, selfie, bank_passbook, pan_verified, aadhaar_verified)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [userIdA, 'pending', dummyImage, dummyImage, dummyImage, dummyImage, dummyImage, 1, 1]);

    await connection.query(`
      INSERT INTO bank_details (user_id, account_holder, account_number, ifsc_code, bank_name, account_type, is_verified)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [userIdA, 'Aarav Sharma', '917310249234', 'PYTM0123456', 'Paytm Payments Bank', 'savings', 1]);


    // User B: Rejected KYC
    console.log("👤 Creating User B: Rejected KYC...");
    const [userBRes] = await connection.query(`
      INSERT INTO users (full_name, mobile, email, pan_number, aadhaar_number, date_of_birth, occupation, monthly_income, credit_score, credit_limit, is_kyc_verified, pan_verified, aadhaar_verified, bank_verified, lead_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      'Vihaan Verma', '9999999999', 'vihaan.verma@ppokket.test',
      'XYZWP5678Q', '987654321098', '1992-04-22', 'self_employed',
      35000.00, 680, 0.00, 0, 1, 1, 0, 'new'
    ]);
    const userIdB = userBRes.insertId;

    await connection.query(`
      INSERT INTO kyc_documents (user_id, status, rejection_reason, aadhaar_front, aadhaar_back, pan_card, selfie, bank_passbook, pan_verified, aadhaar_verified)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [userIdB, 'rejected', 'Aadhaar documents are unclear/blurry.', dummyImage, dummyImage, dummyImage, dummyImage, dummyImage, 1, 1]);

    await connection.query(`
      INSERT INTO bank_details (user_id, account_holder, account_number, ifsc_code, bank_name, account_type, is_verified)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [userIdB, 'Vihaan Verma', '919999999999', 'HDFC0000123', 'HDFC Bank', 'savings', 0]);


    // User C: Approved KYC (Credit Limit active)
    console.log("👤 Creating User C: Approved KYC / Credit limit assigned...");
    const [userCRes] = await connection.query(`
      INSERT INTO users (full_name, mobile, email, pan_number, aadhaar_number, date_of_birth, occupation, monthly_income, credit_score, credit_limit, is_kyc_verified, pan_verified, aadhaar_verified, bank_verified, lead_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      'Kabir Singh', '8888888888', 'kabir.singh@ppokket.test',
      'KABIR7890S', '555566667777', '1990-11-05', 'salaried',
      60000.00, 750, 25000.00, 1, 1, 1, 1, 'kyc_done'
    ]);
    const userIdC = userCRes.insertId;

    await connection.query(`
      INSERT INTO kyc_documents (user_id, status, aadhaar_front, aadhaar_back, pan_card, selfie, bank_passbook, pan_verified, aadhaar_verified)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [userIdC, 'approved', dummyImage, dummyImage, dummyImage, dummyImage, dummyImage, 1, 1]);

    await connection.query(`
      INSERT INTO bank_details (user_id, account_holder, account_number, ifsc_code, bank_name, account_type, is_verified)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [userIdC, 'Kabir Singh', '918888888888', 'ICIC0000456', 'ICICI Bank', 'savings', 1]);

    // Commit transaction
    await connection.commit();

    console.log("\n🚀 Reset Completed Successfully!");
    console.log("-----------------------------------------");
    console.log("1. Aarav Sharma (7310249234) -> Pending (Unclear) KYC");
    console.log("2. Vihaan Verma (9999999999) -> Rejected KYC");
    console.log("3. Kabir Singh  (8888888888) -> Approved (Credit Limit: ₹25,000) KYC");
    console.log("-----------------------------------------\n");

    process.exit(0);
  } catch (err) {
    if (connection) {
      try {
        await connection.rollback();
        console.log("🔄 Transaction rolled back due to error.");
      } catch (rollbackErr) {
        console.error("❌ Rollback failed:", rollbackErr.message);
      }
    }
    console.error("❌ Reset script failed:", err.message);
    process.exit(1);
  } finally {
    if (connection) {
      connection.release();
    }
  }
}

resetAllData();
