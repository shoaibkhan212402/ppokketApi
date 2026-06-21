const { pool } = require('../config/db');

async function findAndDeleteRahulRai() {
  try {
    // Step 1: Find Rahul Rai
    console.log('\n🔍 Searching for Rahul Rai...\n');
    const [users] = await pool.query(
      "SELECT * FROM users WHERE full_name LIKE '%Rahul%Rai%' OR full_name LIKE '%rahul%rai%'",
    );

    if (!users.length) {
      console.log('❌ No user named "Rahul Rai" found.');
      process.exit(0);
    }

    console.log(`✅ Found ${users.length} user(s):\n`);
    users.forEach(u => {
      console.log(`  ID: ${u.id}`);
      console.log(`  Name: ${u.full_name}`);
      console.log(`  Mobile: ${u.mobile}`);
      console.log(`  Email: ${u.email || '—'}`);
      console.log(`  PAN: ${u.pan_number || '—'}`);
      console.log(`  KYC Verified: ${u.is_kyc_verified ? 'Yes' : 'No'}`);
      console.log(`  Wallet Balance: ₹${u.wallet_balance}`);
      console.log(`  Credit Limit: ₹${u.credit_limit}`);
      console.log(`  Created At: ${u.created_at}`);
      console.log('  ---');
    });

    if (users.length > 1) {
      console.log('\n⚠️  Multiple users found! Aborting to be safe. Check the IDs above and narrow the search.');
      process.exit(0);
    }

    const user = users[0];
    const userId = user.id;

    // Step 2: Fetch all related data before deleting
    const [kyc] = await pool.query('SELECT * FROM kyc_documents WHERE user_id = ?', [userId]);
    const [loans] = await pool.query('SELECT id, amount, status FROM loans WHERE user_id = ?', [userId]);
    const [txns] = await pool.query('SELECT id, amount, type, status FROM transactions WHERE user_id = ?', [userId]);
    const [notifs] = await pool.query('SELECT COUNT(*) as cnt FROM notifications WHERE user_id = ?', [userId]);
    const [bankDetails] = await pool.query('SELECT * FROM bank_details WHERE user_id = ?', [userId]);

    console.log('\n📊 Related data found:');
    console.log(`  KYC documents: ${kyc.length}`);
    console.log(`  Loans: ${loans.length}`, loans.map(l => `(${l.status} ₹${l.amount})`).join(', '));
    console.log(`  Transactions: ${txns.length}`);
    console.log(`  Notifications: ${notifs[0].cnt}`);
    console.log(`  Bank details: ${bankDetails.length}`);

    // Step 3: DELETE all related data + user
    console.log(`\n🗑️  Deleting user ID ${userId} (${user.full_name}) and all related records...\n`);

    await pool.query('SET FOREIGN_KEY_CHECKS = 0');

    await pool.query('DELETE FROM emi_schedule WHERE user_id = ?', [userId]);
    await pool.query('DELETE FROM transactions WHERE user_id = ?', [userId]);
    await pool.query('DELETE FROM loans WHERE user_id = ?', [userId]);
    await pool.query('DELETE FROM kyc_documents WHERE user_id = ?', [userId]);
    await pool.query('DELETE FROM aadhaar_kyc WHERE user_id = ?', [userId]);
    await pool.query('DELETE FROM bank_details WHERE user_id = ?', [userId]);
    await pool.query('DELETE FROM notifications WHERE user_id = ?', [userId]);
    await pool.query('DELETE FROM referrals WHERE referrer_id = ? OR referred_id = ?', [userId, userId]);
    await pool.query('DELETE FROM audit_log WHERE entity_type = "user" AND entity_id = ?', [userId]);
    await pool.query('DELETE FROM users WHERE id = ?', [userId]);

    await pool.query('SET FOREIGN_KEY_CHECKS = 1');

    console.log('✅ Successfully deleted:');
    console.log(`   - User: ${user.full_name} (ID: ${userId})`);
    console.log(`   - ${kyc.length} KYC document(s)`);
    console.log(`   - ${loans.length} loan(s)`);
    console.log(`   - ${txns.length} transaction(s)`);
    console.log(`   - ${notifs[0].cnt} notification(s)`);
    console.log(`   - ${bankDetails.length} bank detail(s)`);
    console.log('\n✅ Done!\n');

    process.exit(0);
  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  }
}

findAndDeleteRahulRai();
