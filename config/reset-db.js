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
  // Safety guard: this script drops every table. Require explicit,
  // hard-to-fat-finger confirmation before it can run against production.
  if (process.env.NODE_ENV === 'production') {
    const confirmation = process.env.CONFIRM_PRODUCTION_RESET;
    if (confirmation !== `RESET ${DB_NAME}`) {
      console.error(
        `❌ Refusing to reset database "${DB_NAME}" — NODE_ENV=production.\n` +
        `   This would DROP ALL TABLES. If you are absolutely sure, re-run with:\n` +
        `   CONFIRM_PRODUCTION_RESET="RESET ${DB_NAME}" node config/reset-db.js`
      );
      process.exit(1);
    }
    console.warn(`⚠️  Production reset confirmed for "${DB_NAME}" — proceeding.`);
  }

  console.log('🔄 Resetting database:', DB_NAME);

  const connection = await mysql.createConnection({
    host: DB_HOST,
    port: DB_PORT,
    user: DB_USER,
    password: DB_PASSWORD,
    database: DB_NAME, // Connect directly to selected database
    multipleStatements: true,
  });

  try {
    // Drop all existing tables in the database (since DROP DATABASE/CREATE DATABASE is blocked on Hostinger)
    const [tables] = await connection.query('SHOW TABLES');
    if (tables.length > 0) {
      console.log('🧹 Found existing tables. Dropping all tables...');
      await connection.query('SET FOREIGN_KEY_CHECKS = 0');
      for (const row of tables) {
        const tableName = Object.values(row)[0];
        await connection.query(`DROP TABLE IF EXISTS \`${tableName}\``);
        console.log(`  🗑️ Dropped table: ${tableName}`);
      }
      await connection.query('SET FOREIGN_KEY_CHECKS = 1');
      console.log('✅ Dropped all existing tables.');
    } else {
      console.log('✅ Database is already empty.');
    }

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
