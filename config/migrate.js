const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const migrate = async () => {

  const connection = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    multipleStatements: true,
  });

  try {
    const schemaPath = path.join(__dirname, 'schema.sql');
    let schemaSql = fs.readFileSync(schemaPath, 'utf8');

    // Clean schema to remove CREATE DATABASE or USE statements that fail on Hostinger shared databases
    schemaSql = schemaSql
      .replace(/CREATE DATABASE[\s\S]*?;/i, '')
      .replace(/USE[\s\S]*?;/i, '');


    // Split queries by semicolon to execute one by one or run as multiple statements
    await connection.query(schemaSql);

  } catch (err) {
    console.error('❌ Migration failed:', err.message);
  } finally {
    await connection.end();
  }
};

migrate();

