const mysql = require('mysql2/promise');
require('dotenv').config();

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'ppokket_db',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  timezone: '+05:30',
});

const connectDB = async () => {
  try {
    const conn = await pool.getConnection();
    console.log(`✅ MySQL Connected: ${process.env.DB_HOST}`);
    conn.release();
  } catch (err) {
    console.error('❌ MySQL Connection Error:', err.message);
    process.exit(1);
  }
};

module.exports = { pool, connectDB };
