/**
 * Bank Account Verification — Step-by-Step Test Script
 * Run: node backend/scripts/test_bank_verify.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { verifyBankAccount, compareName } = require('../utils/bankVerify');

const RESET  = '\x1b[0m';
const GREEN  = '\x1b[32m';
const RED    = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN   = '\x1b[36m';
const BOLD   = '\x1b[1m';

const pass  = (msg) => console.log(`  ${GREEN}✔${RESET} ${msg}`);
const fail  = (msg) => console.log(`  ${RED}✘${RESET} ${msg}`);
const info  = (msg) => console.log(`  ${YELLOW}→${RESET} ${msg}`);
const title = (msg) => console.log(`\n${BOLD}${CYAN}${msg}${RESET}`);
const sep   = ()    => console.log('─'.repeat(60));

async function runCase({ label, ifsc, accountNumber, name }) {
  title(`TEST: ${label}`);
  sep();
  info(`IFSC: ${ifsc}  |  Account: ${accountNumber}  |  Name: ${name}`);

  // ── Step 1: Account number format ────────────────────────────────────────
  console.log('\n  [Step 1] Account number format check');
  const cleanAcc = accountNumber.trim().replace(/[\s-]/g, '');
  if (!/^\d{9,18}$/.test(cleanAcc)) {
    fail(`Invalid account number — must be 9–18 digits`);
    return;
  }
  pass('Account number format is valid');

  // ── Step 2: IFSC format ───────────────────────────────────────────────────
  console.log('\n  [Step 2] IFSC format check');
  const cleanIfsc = ifsc.trim().toUpperCase();
  if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(cleanIfsc)) {
    fail(`Invalid IFSC format — must be like HDFC0001234`);
    return;
  }
  pass(`IFSC format is valid: ${cleanIfsc}`);

  // ── Step 3: Call API ──────────────────────────────────────────────────────
  console.log('\n  [Step 3] Calling APItxt Penny Drop API...');
  let result;
  try {
    result = await verifyBankAccount({ ifsc: cleanIfsc, accountNumber: cleanAcc, name, useCache: false });
  } catch (err) {
    fail(`API call failed: ${err.message}`);
    return;
  }

  info(`  API response: accountExists=${result.accountExists}, nameAtBank="${result.nameAtBank}", utr=${result.utr}`);

  // ── Step 4: Account must exist ────────────────────────────────────────────
  console.log('\n  [Step 4] Account existence check');
  if (!result.success || !result.accountExists) {
    fail(`Account not found: ${result.message}`);
    return;
  }
  pass('Account exists at this IFSC');

  // ── Step 5: IFSC echo-back ────────────────────────────────────────────────
  console.log('\n  [Step 5] IFSC match check');
  const returnedIfsc = (result.ifsc || '').trim().toUpperCase();
  if (returnedIfsc && returnedIfsc !== cleanIfsc) {
    fail(`IFSC mismatch — bank returned: ${returnedIfsc}, submitted: ${cleanIfsc}`);
    return;
  }
  pass(`IFSC confirmed: ${returnedIfsc || cleanIfsc}`);

  // ── Step 6: Account number echo-back ─────────────────────────────────────
  console.log('\n  [Step 6] Account number match check');
  const returnedAcc = (result.accountNumber || '').trim().replace(/[\s-]/g, '');
  if (returnedAcc && returnedAcc !== cleanAcc) {
    fail(`Account number mismatch — bank returned: ${returnedAcc}, submitted: ${cleanAcc}`);
    return;
  }
  pass(`Account number confirmed`);

  // ── Step 7: Name match ────────────────────────────────────────────────────
  console.log('\n  [Step 7] Account holder name match');
  if (!result.nameAtBank) {
    fail(`Bank did not return account holder name — cannot verify`);
    return;
  }
  info(`  Name at bank : "${result.nameAtBank}"`);
  info(`  Name entered : "${name}"`);
  const nameResult = compareName(result.nameAtBank, name);
  if (!nameResult.match) {
    fail(`Name mismatch (confidence: ${nameResult.confidence})`);
    return;
  }
  pass(`Name matched (confidence: ${nameResult.confidence})`);

  // ── All steps passed ───────────────────────────────────────────────────────
  console.log('');
  sep();
  console.log(`${GREEN}${BOLD}  ✔ BANK ACCOUNT VERIFIED SUCCESSFULLY${RESET}`);
  console.log(`${GREEN}  IFSC         : ${result.ifsc}${RESET}`);
  console.log(`${GREEN}  Account      : ${result.accountNumber}${RESET}`);
  console.log(`${GREEN}  Name at Bank : ${result.nameAtBank}${RESET}`);
  console.log(`${GREEN}  UTR          : ${result.utr}${RESET}`);
  sep();
}

async function main() {
  console.log(`\n${BOLD}══════════════════════════════════════════════════════════${RESET}`);
  console.log(`${BOLD}  BANK VERIFICATION — STEP-BY-STEP TEST${RESET}`);
  console.log(`${BOLD}══════════════════════════════════════════════════════════${RESET}`);
  console.log(`  API Key configured: ${process.env.APITXT_AUTHKEY ? GREEN + 'YES' + RESET : RED + 'NO' + RESET}`);

  // ── Replace these with real test values ───────────────────────────────────
  const REAL_IFSC    = 'SBIN0000001';       // replace with your actual IFSC
  const REAL_ACCOUNT = '12345678901';       // replace with your actual account number
  const REAL_NAME    = 'MOHAMMAD SHOAIB KHAN';

  const cases = [
    {
      label: '1 — Correct IFSC + account + name  (should PASS)',
      ifsc: REAL_IFSC, accountNumber: REAL_ACCOUNT, name: REAL_NAME,
    },
    {
      label: '2 — Invalid IFSC format  (should FAIL at Step 2)',
      ifsc: 'INVALID', accountNumber: REAL_ACCOUNT, name: REAL_NAME,
    },
    {
      label: '3 — Invalid account number format  (should FAIL at Step 1)',
      ifsc: REAL_IFSC, accountNumber: '123', name: REAL_NAME,
    },
    {
      label: '4 — Wrong account number  (should FAIL at Step 4 — account not found)',
      ifsc: REAL_IFSC, accountNumber: '00000000001', name: REAL_NAME,
    },
    {
      label: '5 — Correct account but wrong name  (should FAIL at Step 7)',
      ifsc: REAL_IFSC, accountNumber: REAL_ACCOUNT, name: 'RAHUL KUMAR SHARMA',
    },
    {
      label: '6 — Partial name match (first + last only)  (should PASS if tokens match)',
      ifsc: REAL_IFSC, accountNumber: REAL_ACCOUNT, name: 'MOHAMMAD KHAN',
    },
  ];

  for (const c of cases) {
    await runCase(c);
    await new Promise(r => setTimeout(r, 700));
  }

  console.log(`\n${BOLD}══════════════════════════════════════════════════════════${RESET}`);
  console.log(`${BOLD}  TEST COMPLETE${RESET}`);
  console.log(`${BOLD}══════════════════════════════════════════════════════════${RESET}\n`);
  process.exit(0);
}

main().catch(err => { console.error('Script error:', err); process.exit(1); });
