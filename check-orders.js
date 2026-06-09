const { pool } = require('./config/db');

async function checkUserAndOrders() {
  try {
    const mobile = '9307232689';

    // 1. Get User Profile
    const [users] = await pool.query('SELECT * FROM users WHERE mobile = ?', [mobile]);
    if (users.length === 0) {

      process.exit(0);
    }
    
    const user = users[0];







    // 2. Get Loans
    const [loans] = await pool.query('SELECT * FROM loans WHERE user_id = ? ORDER BY created_at ASC', [user.id]);
    
    if (loans.length === 0) {

    } else {
      loans.forEach((loan, idx) => {

      });
    }

    // 3. Get Transactions
    const [transactions] = await pool.query('SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at ASC', [user.id]);
    if (transactions.length === 0) {

    } else {
      transactions.forEach((tx, idx) => {

      });
    }

    // 4. Check for duplicates created within the same minute/second
    if (loans.length > 1) {

      const timeGroups = {};
      loans.forEach(loan => {
        const timeStr = new Date(loan.created_at).toISOString().slice(0, 19); // YYYY-MM-DDTHH:MM:SS
        timeGroups[timeStr] = (timeGroups[timeStr] || 0) + 1;
      });
      
      let duplicateTimesCount = 0;
      for (const [time, count] of Object.entries(timeGroups)) {
        if (count > 1) {

          duplicateTimesCount++;
        }
      }
      if (duplicateTimesCount === 0) {

      }
    }
    
    process.exit(0);
  } catch (error) {
    console.error('❌ Error executing database checks:', error);
    process.exit(1);
  }
}

checkUserAndOrders();

