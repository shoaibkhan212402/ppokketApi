const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const { createClient } = require('redis');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const DB_HOST = process.env.DB_HOST || 'localhost';
const DB_PORT = process.env.DB_PORT || 3306;
const DB_USER = process.env.DB_USER || 'root';
const DB_PASSWORD = process.env.DB_PASSWORD || '';
const DB_NAME = process.env.DB_NAME || 'ppokket_db';
const REDIS_HOST = process.env.REDIS_HOST;
const REDIS_PORT = process.env.REDIS_PORT || 6379;
const REDIS_USER = process.env.REDIS_USER || 'default';
const REDIS_PASSWORD = process.env.REDIS_PASSWORD || '';

const run = async () => {
  console.log('🔄 Resetting database:', DB_NAME);

  const connection = await mysql.createConnection({
    host: DB_HOST,
    port: DB_PORT,
    user: DB_USER,
    password: DB_PASSWORD,
    multipleStatements: true,
  });

  try {
    await connection.query(`DROP DATABASE IF EXISTS \`${DB_NAME}\`;`);
    console.log('✅ Dropped database if it existed.');

    await connection.query(`CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\`;`);
    await connection.query(`USE \`${DB_NAME}\`;`);
    console.log('✅ Created and selected database.');

    const schemaPath = path.join(__dirname, 'schema.sql');
    let schemaSql = fs.readFileSync(schemaPath, 'utf8');
    
    // Safely remove CREATE DATABASE and USE statements without affecting fields like user_id
    schemaSql = schemaSql
      .replace(/CREATE DATABASE IF NOT EXISTS ppokket_db;/gi, '')
      .replace(/\bUSE ppokket_db;/gi, '');

    // Execute the entire schema file at once using the multipleStatements connection option
    await connection.query(schemaSql);
    console.log('✅ Schema imported successfully.');

    if (REDIS_HOST) {
      try {
        const redisUrl = `redis://${REDIS_USER}:${REDIS_PASSWORD}@${REDIS_HOST}:${REDIS_PORT}`;
        const client = createClient({ url: redisUrl });
        await client.connect();
        await client.flushAll();
        await client.quit();
        console.log('✅ Redis cache flushed.');
      } catch (redisErr) {
        console.warn('⚠️ Redis flush skipped:', redisErr.message);
      }
    }

    console.log('🎉 Database reset completed.');
  } catch (err) {
    console.error('❌ Reset failed:', err.message || err);
    process.exit(1);
  } finally {
    await connection.end();
  }
};

run();
