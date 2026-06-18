const mysql = require('mysql2/promise');
require('dotenv').config();

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'ppokket_db',
  waitForConnections: true,
  connectionLimit: 25,
  queueLimit: 0,
  timezone: '+05:30',
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000,
  connectTimeout: 5000,
});

const connectDB = async () => {
  const host = process.env.DB_HOST || 'localhost';
  const port = process.env.DB_PORT || 3306;
  const user = process.env.DB_USER || 'root';
  const database = process.env.DB_NAME || 'ppokket_db';

  try {
    const conn = await pool.getConnection();
    console.log(`✅ MySQL Database Connected successfully to ${user}@${host}:${port}/${database}`);
    conn.release();
    return true;
  } catch (err) {
    console.error('❌ MySQL Connection Error details:', err);
    console.error('❌ MySQL Connection Error message:', err.message || err);
    console.warn('⚠️ Server will run but database operations will fail until connection is restored.');
    return false;
  }
};

module.exports = { pool, connectDB };


