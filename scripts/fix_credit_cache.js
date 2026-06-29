const { pool } = require('../config/db');
const { redisClient, connectRedis, invalidateUserCache } = require('../config/redis');

async function main() {
  try {
    await connectRedis();
    await new Promise(r => setTimeout(r, 500)); // wait for redis connection

    // Find user by mobile
    const [users] = await pool.query(
      'SELECT id, full_name, mobile, credit_limit, withdrawal_limit FROM users WHERE mobile = ?',
      ['7310249234']
    );

    if (!users.length) {
      console.log('❌ User not found with mobile 7310249234');
      process.exit(1);
    }

    const user = users[0];
    console.log(`\n👤 User: ${user.full_name} (ID: ${user.id})`);
    console.log(`   Credit Limit : ₹${user.credit_limit}`);
    console.log(`   Withdrawal Limit: ${user.withdrawal_limit ?? 'None'}`);

    // Get all active loans
    const [loans] = await pool.query(
      `SELECT id, amount, status, amount_paid FROM loans
       WHERE user_id = ? AND status NOT IN ('rejected', 'closed')`,
      [user.id]
    );

    let occupiedCredit = 0;
    console.log(`\n📋 Active Loans:`);
    if (!loans.length) {
      console.log('   None');
    } else {
      for (const loan of loans) {
        console.log(`   Loan #${loan.id}: amount=₹${loan.amount}, status=${loan.status}, amount_paid=₹${loan.amount_paid}`);
        occupiedCredit += parseFloat(loan.amount);
      }
    }

    const effectiveLimit = user.withdrawal_limit !== null
      ? Math.min(parseFloat(user.credit_limit), parseFloat(user.withdrawal_limit))
      : parseFloat(user.credit_limit);

    const availableCredit = Math.max(0, effectiveLimit - occupiedCredit);

    console.log(`\n💰 Credit Calculation (FIXED — no revolving):`);
    console.log(`   Effective Limit : ₹${effectiveLimit}`);
    console.log(`   Occupied Credit : ₹${occupiedCredit}  (original loan amount, not remaining balance)`);
    console.log(`   Available Credit: ₹${availableCredit}  ← should show this after restart`);

    // Clear Redis cache for this user
    console.log(`\n🧹 Clearing Redis cache for user ${user.id}...`);
    await invalidateUserCache(user.id);
    console.log(`✅ Cache cleared!`);

    console.log(`\n⚠️  IMPORTANT: Restart the backend server to pick up the new code.`);
    console.log(`   After restart, profile will show Available = ₹${availableCredit}\n`);

    process.exit(0);
  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  }
}

main();
