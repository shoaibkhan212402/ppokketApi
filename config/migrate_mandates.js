const { pool } = require('./db');
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

async function run() {
  console.log('🏁 Starting migration: Creating bank_mandates table...');

  const query = `
    CREATE TABLE IF NOT EXISTS bank_mandates (
      id               INT AUTO_INCREMENT PRIMARY KEY,
      user_id          INT NOT NULL UNIQUE,
      subscription_id  VARCHAR(100) NOT NULL UNIQUE,
      plan_id          VARCHAR(100) DEFAULT NULL,
      mandate_id       VARCHAR(100) DEFAULT NULL,
      umrn             VARCHAR(100) DEFAULT NULL,
      status           ENUM('pending', 'active', 'failed', 'cancelled') DEFAULT 'pending',
      auth_link        TEXT DEFAULT NULL,
      payment_mode     VARCHAR(50) DEFAULT NULL,
      created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `;

  try {
    await pool.query(query);
    console.log('✅ bank_mandates table created successfully or already exists.');
  } catch (err) {
    console.error('❌ Migration failed:', err.message);
    process.exit(1);
  }

  process.exit(0);
}

run();
