/**
 * Migration: add KYC EMI snapshot columns to users table
 *
 * New columns:
 *   kyc_approved_tenure    — tenure (months) the admin used in the KYC preview
 *   kyc_first_emi_amount   — computed first EMI ₹ total (step-down principal + fee, or regular + fee)
 *   kyc_regular_emi_amount — computed regular EMI ₹ (EMIs 2..N in step-down, or all in standard mode)
 */
const { pool } = require('../config/db');

async function migrate() {
  try {
    console.log('🔄 Running KYC EMI snapshot migration...');

    const colsToAdd = [
      { name: 'kyc_approved_tenure',    definition: 'INT           DEFAULT NULL' },
      { name: 'kyc_first_emi_amount',   definition: 'DECIMAL(12,2) DEFAULT NULL' },
      { name: 'kyc_regular_emi_amount', definition: 'DECIMAL(12,2) DEFAULT NULL' },
    ];

    for (const col of colsToAdd) {
      try {
        await pool.query(`ALTER TABLE users ADD COLUMN ${col.name} ${col.definition}`);
        console.log(`  ✅ Added column '${col.name}'.`);
      } catch (err) {
        if (err.code === 'ER_DUP_FIELDNAME') {
          console.log(`  ⏭  Column '${col.name}' already exists — skipping.`);
        } else {
          throw err;
        }
      }
    }

    console.log('✅ Migration complete.');
    process.exit(0);
  } catch (err) {
    console.error('❌ Migration failed:', err.message);
    process.exit(1);
  }
}

migrate();
