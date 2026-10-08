const { pool } = require('../config/db');

// Small schema changes that newer code depends on, applied by the server
// itself at start-up — so a deploy doesn't also need someone to run SQL by
// hand. Off unless AUTO_SCHEMA_UPGRADE=true.
//
// Everything here only ever ADDS (a column, an index, one more allowed value
// for an ENUM). Nothing is dropped, renamed or emptied, each step first checks
// whether it is still needed, and an ENUM is extended from the definition the
// database actually has — never replaced by a list written here — so values
// this file doesn't know about are kept. The matching hand-run file is
// config/migration_autopay.sql.

const LOCK = 'ppokket_schema_upgrade';

const columnInfo = async (conn, table, column) => {
  const [[info]] = await conn.query(
    `SELECT COLUMN_TYPE AS type, IS_NULLABLE AS nullable, COLUMN_DEFAULT AS dflt
       FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column]
  );
  return info || null;
};

// Adds `value` to the end of an ENUM column, keeping its other values, its
// NULL-ability and its default. Resolves to false when there was nothing to do
// (already allowed, or the table / column isn't there).
const allowEnumValue = async (conn, table, column, value) => {
  const info = await columnInfo(conn, table, column);
  if (!info || !/^enum\(/i.test(info.type)) return false;
  if (info.type.toLowerCase().includes(`'${value}'`)) return false;

  const type = info.type.replace(/\)\s*$/, `,'${value}')`);
  const notNull = info.nullable === 'NO' ? ' NOT NULL' : '';
  // MySQL reports the default bare (pending); MariaDB reports it quoted ('pending').
  const dflt = info.dflt == null || /^null$/i.test(info.dflt) ? null : String(info.dflt).replace(/^'(.*)'$/, '$1');
  const defaultSql = dflt != null ? ` DEFAULT ${conn.escape(dflt)}` : (notNull ? '' : ' DEFAULT NULL');

  await conn.query(`ALTER TABLE \`${table}\` MODIFY COLUMN \`${column}\` ${type}${notNull}${defaultSql}`);
  return true;
};

const UPGRADES = [
  {
    // Code parks a mandate as 'inactive' when its loan closes.
    name: "bank_mandates.status allows 'inactive'",
    async apply(conn) {
      if (!await allowEnumValue(conn, 'bank_mandates', 'status', 'inactive')) return false;
      // Without the value, a lenient database stored '' for rows being parked.
      await conn.query("UPDATE bank_mandates SET status = 'inactive' WHERE status = ''");
      return true;
    },
  },
];

// Runs every upgrade that is still needed. Never throws: a failed step is
// logged and the server starts anyway (the feature that needs it stays off).
const applySchemaUpgrades = async () => {
  if (process.env.AUTO_SCHEMA_UPGRADE !== 'true') return;

  let conn;
  try {
    conn = await pool.getConnection();
    // Several server processes may start together; only one does the work.
    const [[{ locked }]] = await conn.query('SELECT GET_LOCK(?, 15) AS locked', [LOCK]);
    if (Number(locked) !== 1) {
      console.warn('[schema] Another process is applying schema upgrades — skipped here.');
      return;
    }
    try {
      for (const upgrade of UPGRADES) {
        try {
          if (await upgrade.apply(conn)) console.log(`✅ [schema] Applied: ${upgrade.name}`);
        } catch (err) {
          console.error(`❌ [schema] Could not apply "${upgrade.name}":`, err.message);
        }
      }
    } finally {
      await conn.query('SELECT RELEASE_LOCK(?)', [LOCK]).catch(() => {});
    }
  } catch (err) {
    console.error('❌ [schema] Schema upgrade check failed:', err.message);
  } finally {
    if (conn) conn.release();
  }
};

module.exports = { applySchemaUpgrades };
