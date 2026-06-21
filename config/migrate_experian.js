const { pool } = require('./db');

async function run() {
  console.log('🔄 Starting database migrations for CIBIL & Experian...');

  try {
    // 1. Modify users credit_score default to NULL
    console.log('🔹 Altering users.credit_score to default NULL...');
    await pool.query('ALTER TABLE users MODIFY COLUMN credit_score INT DEFAULT NULL');
    console.log('✅ Altered users.credit_score');
  } catch (err) {
    console.error('❌ Failed to alter users.credit_score default:', err.message);
  }

  try {
    // 2. Add experian_score and experian_fetched_at to users
    console.log('🔹 Adding experian_score and experian_fetched_at to users table...');
    await pool.query('ALTER TABLE users ADD COLUMN experian_score INT DEFAULT NULL, ADD COLUMN experian_fetched_at DATETIME DEFAULT NULL');
    console.log('✅ Added Experian columns to users table');
  } catch (err) {
    if (err.code === 'ER_DUP_COLUMN_NAME') {
      console.log('ℹ️ Experian columns already exist in users table');
    } else {
      console.error('❌ Failed to add Experian columns to users table:', err.message);
    }
  }

  try {
    // 3. Add loanId and loanType to cibil_reports for admin compatibility
    console.log('🔹 Adding loanId and loanType to cibil_reports...');
    await pool.query('ALTER TABLE cibil_reports ADD COLUMN loanId VARCHAR(255) NULL, ADD COLUMN loanType VARCHAR(255) NULL');
    await pool.query('ALTER TABLE cibil_reports ADD INDEX idx_cibil_loan (loanId, loanType)');
    console.log('✅ Added loan columns to cibil_reports table');
  } catch (err) {
    if (err.code === 'ER_DUP_COLUMN_NAME') {
      console.log('ℹ️ loan columns already exist in cibil_reports');
    } else {
      console.error('❌ Failed to alter cibil_reports:', err.message);
    }
  }

  try {
    // 4. Create experian_reports table
    console.log('🔹 Creating experian_reports table...');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS experian_reports (
        id INT AUTO_INCREMENT PRIMARY KEY,
        pan VARCHAR(20) NOT NULL,
        mobile VARCHAR(15) NOT NULL,
        name VARCHAR(255) NULL,
        loanId VARCHAR(255) NULL,
        loanType VARCHAR(255) NULL,
        userId INT NULL,
        experianScore INT NULL,
        creditHealth VARCHAR(50) NULL,
        htmlUrl TEXT NULL,
        parsedData JSON NULL,
        rawResponse JSON NULL,
        status VARCHAR(50) DEFAULT 'Fetched',
        apiProvider VARCHAR(50) DEFAULT 'InsightAPI_Experian',
        errorMessage TEXT NULL,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX (pan),
        INDEX (mobile),
        INDEX (userId),
        INDEX (loanId, loanType)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
    console.log('✅ Created experian_reports table');
  } catch (err) {
    console.error('❌ Failed to create experian_reports table:', err.message);
  }

  try {
    // 5. Update existing users with default 650 score to NULL if they don't have CIBIL report records
    console.log('🔹 Cleaning up default 650 scores to NULL for users without reports...');
    const [result] = await pool.query(`
      UPDATE users 
      SET credit_score = NULL 
      WHERE credit_score = 650 
        AND id NOT IN (
          SELECT DISTINCT userId 
          FROM cibil_reports 
          WHERE userId IS NOT NULL
        )
    `);
    console.log(`✅ Cleaned up ${result.affectedRows} users with default 650 scores`);
  } catch (err) {
    console.error('❌ Failed to clean up default CIBIL scores:', err.message);
  }

  console.log('🎉 Database migrations finished!');
  process.exit(0);
}

run();
