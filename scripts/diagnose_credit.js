const { pool } = require('../config/db');

async function main() {
  // 1. Check what credit-related columns exist in users table
  const [cols] = await pool.query("SHOW COLUMNS FROM users WHERE Field LIKE '%credit%' OR Field LIKE '%limit%' OR Field LIKE '%occupied%'");
  console.log('\n📋 users table credit columns:');
  cols.forEach(c => console.log(`   ${c.Field}  [${c.Type}]  default=${c.Default}`));

  // 2. Get user
  const [users] = await pool.query(
    'SELECT id, credit_limit, withdrawal_limit FROM users WHERE mobile = ?',
    ['7310249234']
  );
  if (!users.length) { console.log('User not found'); process.exit(1); }
  const user = users[0];
  console.log('\n👤 User ID:', user.id, '| credit_limit:', user.credit_limit, '| withdrawal_limit:', user.withdrawal_limit);

  // 3. Get all active loans
  const [loans] = await pool.query(
    "SELECT id, amount, status, amount_paid FROM loans WHERE user_id = ? AND status NOT IN ('rejected','closed')",
    [user.id]
  );
  console.log('\n📋 Active (non-closed) loans:');
  loans.forEach(l => console.log(`   Loan #${l.id}: amount=${l.amount}, status=${l.status}, amount_paid=${l.amount_paid}`));

  // 4. Fixed calculation
  let occupied = 0;
  loans.forEach(l => { occupied += parseFloat(l.amount); });
  console.log('\n💰 Fixed calculation (loan.amount, not revolving):');
  console.log('   occupied  =', occupied);
  console.log('   available =', parseFloat(user.credit_limit) - occupied);

  // 5. Revolving calculation (what old code was doing)
  let occupiedRevolving = 0;
  loans.forEach(l => { occupiedRevolving += parseFloat(l.amount) - parseFloat(l.amount_paid); });
  console.log('\n🔄 OLD revolving calculation (loan.amount - amount_paid):');
  console.log('   occupied  =', occupiedRevolving);
  console.log('   available =', parseFloat(user.credit_limit) - occupiedRevolving);

  // 6. Check which matches the UI value of 5445.13
  const uiValue = 5445.13;
  console.log(`\n🔍 UI shows ₹${uiValue}. Matches fixed? ${Math.abs((parseFloat(user.credit_limit) - occupied) - uiValue) < 1}. Matches revolving? ${Math.abs((parseFloat(user.credit_limit) - occupiedRevolving) - uiValue) < 1}`);

  process.exit(0);
}

main().catch(e => { console.error(e.message); process.exit(1); });
