/**
 * migrate_system_settings.js
 * ─────────────────────────
 * Creates the system_settings table (if it doesn't exist) and
 * seeds all default values so the admin panel works out-of-the-box.
 *
 * Usage: node scripts/migrate_system_settings.js
 */

require('dotenv').config();
const { pool } = require('../config/db');

const DEFAULT_SETTINGS = [
  // ── Loan limits ──────────────────────────────────────────────
  ['default_roi',                 '2.5'],   // default interest rate % per month
  ['min_loan_amount',             '1000'],
  ['max_loan_amount',             '500000'],
  ['min_tenure_months',           '1'],
  ['max_tenure_months',           '24'],
  ['default_credit_limit',        '10000'],

  // ── Processing fee ───────────────────────────────────────────
  ['processing_fee_pct',          '2'],     // % of loan amount
  ['processing_fee_in_first_emi', 'true'],  // add fee + GST to EMI #1
  ['gst_on_processing_fee',       '18'],    // % GST on processing fee

  // ── First EMI step-down ──────────────────────────────────────
  ['first_emi_principal_pct',     '25'],    // 25 = 25% principal collected in EMI #1 (step-down)
  ['first_emi_extra_pct',         '0'],

  // ── Penalty ───────────────────────────────────────────────────
  ['penalty_grace_days',          '3'],
  ['penalty_type',                'percent'],  // 'percent' or 'flat'
  ['penalty_rate_per_day',        '1'],         // % of EMI per overdue day
  ['penalty_flat_per_day',        '50'],        // flat ₹ per overdue day
  ['penalty_max_pct_of_emi',      '50'],        // cap: % of EMI
  ['gst_on_penalty',              '18'],
  ['bounce_charge',               '500'],       // ₹ per failed auto-debit
  ['gst_on_bounce',               '18'],

  // ── Underwriting ─────────────────────────────────────────────
  ['min_cibil_score',             '650'],
];

async function run() {
  try {
    console.log('📦 Creating system_settings table (if not exists)…');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS system_settings (
        id            INT AUTO_INCREMENT PRIMARY KEY,
        setting_key   VARCHAR(100) NOT NULL UNIQUE,
        setting_value TEXT NOT NULL,
        updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    console.log('  ✅  Table ready.');

    console.log('🌱 Seeding default settings…');
    for (const [k, v] of DEFAULT_SETTINGS) {
      await pool.query(
        'INSERT IGNORE INTO system_settings (setting_key, setting_value) VALUES (?, ?)',
        [k, v]
      );
      console.log(`  ✔  ${k} = ${v}`);
    }

    console.log('\n✅  system_settings migration complete!\n');
    process.exit(0);
  } catch (err) {
    console.error('\n❌  Migration failed:', err.message, '\n');
    process.exit(1);
  }
}

run();
