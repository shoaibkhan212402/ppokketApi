const { pool } = require('./config/db');

async function checkUserAndOrders() {
  try {
    const mobile = '9307232689';
    console.log(`\n=== CHECKING DETAILS FOR MOBILE: ${mobile} ===\n`);
    
    // 1. Get User Profile
    const [users] = await pool.query('SELECT * FROM users WHERE mobile = ?', [mobile]);
    if (users.length === 0) {
      console.log('❌ No user found with this mobile number in the database.');
      process.exit(0);
    }
    
    const user = users[0];
    console.log('👤 USER PROFILE:');
    console.log(`- ID: ${user.id}`);
    console.log(`- Name: ${user.full_name}`);
    console.log(`- Email: ${user.email}`);
    console.log(`- Credit Limit: ₹${user.credit_limit}`);
    console.log(`- Wallet Balance: ₹${user.wallet_balance}`);
    console.log(`- Created At: ${user.created_at}`);
    
    // 2. Get Loans
    const [loans] = await pool.query('SELECT * FROM loans WHERE user_id = ? ORDER BY created_at ASC', [user.id]);
    console.log(`\n📋 LOANS/ORDERS (${loans.length} total):`);
    
    if (loans.length === 0) {
      console.log('  No loans found.');
    } else {
      loans.forEach((loan, idx) => {
        console.log(`  [${idx + 1}] ID: ${loan.id} | Amount: ₹${loan.amount} | Status: ${loan.status} | Created At: ${loan.created_at}`);
      });
    }

    // 3. Get Transactions
    const [transactions] = await pool.query('SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at ASC', [user.id]);
    console.log(`\n💳 TRANSACTIONS (${transactions.length} total):`);
    if (transactions.length === 0) {
      console.log('  No transactions found.');
    } else {
      transactions.forEach((tx, idx) => {
        console.log(`  [${idx + 1}] ID: ${tx.id} | Loan ID: ${tx.loan_id} | Amount: ₹${tx.amount} | Type: ${tx.type} | Status: ${tx.status} | Order ID: ${tx.razorpay_order_id} | Created At: ${tx.created_at}`);
      });
    }

    // 4. Check for duplicates created within the same minute/second
    if (loans.length > 1) {
      console.log('\n⚠️ DUPLICATE ANALYSIS:');
      const timeGroups = {};
      loans.forEach(loan => {
        const timeStr = new Date(loan.created_at).toISOString().slice(0, 19); // YYYY-MM-DDTHH:MM:SS
        timeGroups[timeStr] = (timeGroups[timeStr] || 0) + 1;
      });
      
      let duplicateTimesCount = 0;
      for (const [time, count] of Object.entries(timeGroups)) {
        if (count > 1) {
          console.log(`  - ${count} loans created at exactly: ${time}`);
          duplicateTimesCount++;
        }
      }
      if (duplicateTimesCount === 0) {
        console.log('  No multiple loans created at the exact same second.');
      }
    }
    
    process.exit(0);
  } catch (error) {
    console.error('❌ Error executing database checks:', error);
    process.exit(1);
  }
}

checkUserAndOrders();
