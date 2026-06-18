require('dotenv').config();
const { pool } = require('../config/db');
async function run() {
  await pool.query("UPDATE system_settings SET setting_value='true' WHERE setting_key='processing_fee_in_first_emi'");
  const [[row]] = await pool.query("SELECT setting_value FROM system_settings WHERE setting_key='processing_fee_in_first_emi'");
  console.log('processing_fee_in_first_emi updated to:', row.setting_value);
  process.exit(0);
}
run().catch(e => { console.error(e.message); process.exit(1); });
