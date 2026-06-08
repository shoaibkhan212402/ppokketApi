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
  const host = process.env.DB_HOST || 'localhost';
  const port = process.env.DB_PORT || 3306;
  const user = process.env.DB_USER || 'root';
  const database = process.env.DB_NAME || 'ppokket_db';
  console.log(`⚙️ Attempting MySQL connection to ${user}@${host}:${port}/${database}...`);
  
  try {
    const conn = await pool.getConnection();
    console.log(`✅ MySQL Connected successfully to ${host}:${port}`);
    conn.release();
  } catch (err) {
    console.error('❌ MySQL Connection Error details:', err);
    console.error('❌ MySQL Connection Error message:', err.message || err);
    process.exit(1);
  }
};

module.exports = { pool, connectDB };

