const { pool } = require('../config/db');

async function deleteUserById(userId, userName) {
  const [kyc] = await pool.query('SELECT * FROM kyc_documents WHERE user_id = ?', [userId]);
  const [loans] = await pool.query('SELECT id, amount, status FROM loans WHERE user_id = ?', [userId]);
  const [txns] = await pool.query('SELECT id, amount, type, status FROM transactions WHERE user_id = ?', [userId]);
  const [notifs] = await pool.query('SELECT COUNT(*) as cnt FROM notifications WHERE user_id = ?', [userId]);
  const [bankDetails] = await pool.query('SELECT * FROM bank_details WHERE user_id = ?', [userId]);

  console.log(`\n📊 Related data for ${userName} (ID: ${userId}):`);
  console.log(`  KYC documents: ${kyc.length}`);
  console.log(`  Loans: ${loans.length}`, loans.map(l => `(${l.status} ₹${l.amount})`).join(', '));
  console.log(`  Transactions: ${txns.length}`);
  console.log(`  Notifications: ${notifs[0].cnt}`);
  console.log(`  Bank details: ${bankDetails.length}`);

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

  console.log(`✅ Deleted ${userName} (ID: ${userId}) and all related records.`);
}

async function main() {
  try {
    const targets = [
      { id: 17, name: 'RAHUL RAI' },
      { id: 25, name: 'Rahul Rai New' },
    ];

    for (const t of targets) {
      await deleteUserById(t.id, t.name);
    }

    console.log('\n✅ Done!\n');
    process.exit(0);
  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  }
}

main();
