/**
 * PAN Verification Step-by-Step Test Script
 * Run: node backend/scripts/test_pan_verify.js
 *
 * Tests each validation layer independently so you can see
 * exactly which step passes or fails for each case.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { verifyPAN } = require('../utils/panVerify');

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

/** Run all validation steps and print results for one test case. */
async function runCase({ label, pan, name, dob }) {
  title(`TEST: ${label}`);
  sep();
  info(`PAN: ${pan}  |  Name: ${name}  |  DOB: ${dob}`);

  // ── Step 1: PAN format ──────────────────────────────────────
  console.log('\n  [Step 1] PAN format check');
  if (!/^[A-Z]{5}[0-9]{4}[A-Z]{1}$/.test(pan.toUpperCase())) {
    fail(`Invalid PAN format — must be ABCDE1234F`);
    return;
  }
  pass('PAN format is valid');

  // ── Step 2: Surname initial ──────────────────────────────────
  console.log('\n  [Step 2] Surname initial check (5th char of PAN = first letter of last name)');
  const panUpper     = pan.toUpperCase();
  const nameParts    = name.trim().toUpperCase().split(/\s+/).filter(Boolean);
  const panFifthChar = panUpper.charAt(4);
  const surnameInit  = nameParts.length ? nameParts[nameParts.length - 1].charAt(0) : '';
  info(`  PAN 5th char: "${panFifthChar}" | Surname initial: "${surnameInit}"`);
  if (panFifthChar !== surnameInit) {
    fail(`Mismatch — "${panFifthChar}" ≠ "${surnameInit}". PAN does not match this surname.`);
    return;
  }
  pass(`Surname initial matches (${panFifthChar} = ${surnameInit})`);

  // ── Step 3: Call verification API ───────────────────────────
  console.log('\n  [Step 3] Calling APItxt PAN verification API...');
  let result;
  try {
    result = await verifyPAN({ pan, name, dob });
  } catch (err) {
    fail(`API call failed: ${err.message}`);
    return;
  }

  // Show raw API response for debugging
  info(`  API response: verified=${result.verified}, panStatus=${result.panStatus}, name_match=${result.name_match}, dob_match=${result.dob_match}, full_name=${result.fullName}`);

  if (!result.success || !result.verified) {
    fail(`PAN not found or invalid: ${result.message}`);
    return;
  }
  pass('PAN exists in authority database');

  // ── Step 4: PAN active status ────────────────────────────────
  console.log('\n  [Step 4] PAN active status check');
  if (result.panStatus && result.panStatus !== 'valid') {
    fail(`PAN is not active (status: ${result.panStatus})`);
    return;
  }
  pass(`PAN status: ${result.panStatus || 'valid (not specified by API)'}`);

  // ── Step 5: Name match ───────────────────────────────────────
  console.log('\n  [Step 5] Name match check');
  if (result.name_match !== true) {
    fail(`Name does not match PAN records (API returned name_match=${result.name_match})`);
    return;
  }
  pass(`Name matched (API confirmed)`);

  // ── Step 6: DOB match ────────────────────────────────────────
  console.log('\n  [Step 6] Date of Birth match check');
  if (result.dob_match !== true) {
    fail(`DOB does not match PAN records (API returned dob_match=${result.dob_match})`);
    return;
  }
  pass(`DOB matched (API confirmed)`);

  // ── All steps passed ─────────────────────────────────────────
  console.log('');
  sep();
  console.log(`${GREEN}${BOLD}  ✔ PAN VERIFIED SUCCESSFULLY${RESET}`);
  console.log(`${GREEN}  PAN     : ${result.panNumber}${RESET}`);
  console.log(`${GREEN}  Name    : ${result.fullName || name + ' (submitted — API did not return name)'}${RESET}`);
  console.log(`${GREEN}  DOB     : ${result.dob}${RESET}`);
  sep();
}

async function main() {
  console.log(`\n${BOLD}══════════════════════════════════════════════════════════${RESET}`);
  console.log(`${BOLD}  PAN VERIFICATION — STEP-BY-STEP TEST${RESET}`);
  console.log(`${BOLD}══════════════════════════════════════════════════════════${RESET}`);
  console.log(`  API Key configured: ${process.env.APITXT_AUTHKEY ? GREEN + 'YES' + RESET : RED + 'NO (mock mode)' + RESET}`);

  const cases = [
    {
      label: '1 — Wrong PAN (G instead of F) — should fail if API is reliable',
      pan:  'KCRPK9812G',
      name: 'MOHAMMAD SHOAIB KHAN',
      dob:  '30/05/2002',
    },
    {
      label: '2 — Correct PAN (user\'s actual PAN)',
      pan:  'KCRPK9812F',
      name: 'MOHAMMAD SHOAIB KHAN',
      dob:  '30/05/2002',
    },
    {
      label: '3 — Invalid PAN format (lowercase / wrong chars)',
      pan:  'KCRPK9812!',
      name: 'MOHAMMAD SHOAIB KHAN',
      dob:  '30/05/2002',
    },
    {
      label: '4 — Surname initial mismatch (K in PAN but surname is SHARMA)',
      pan:  'KCRPK9812F',
      name: 'MOHAMMAD SHOAIB SHARMA',
      dob:  '30/05/2002',
    },
    {
      label: '5 — Wrong name (completely different person)',
      pan:  'KCRPK9812F',
      name: 'RAHUL KUMAR SINGH',
      dob:  '15/08/1990',
    },
    {
      label: '6 — Correct PAN + name but wrong DOB',
      pan:  'KCRPK9812F',
      name: 'MOHAMMAD SHOAIB KHAN',
      dob:  '01/01/1990',
    },
  ];

  for (const c of cases) {
    await runCase(c);
    await new Promise(r => setTimeout(r, 600)); // small delay between API calls
  }

  console.log(`\n${BOLD}══════════════════════════════════════════════════════════${RESET}`);
  console.log(`${BOLD}  TEST COMPLETE${RESET}`);
  console.log(`\n  ${YELLOW}IMPORTANT:${RESET} If cases 1, 5, or 6 show "✔ PAN VERIFIED SUCCESSFULLY",`);
  console.log(`  the APItxt API is ${RED}NOT performing real name/DOB validation${RESET} and is`);
  console.log(`  returning name_match=true for any valid PAN format. This is an`);
  console.log(`  API quality issue — consider switching to a stricter provider`);
  console.log(`  (Signzy / IDfy / Karza) that returns the actual PAN holder name.`);
  console.log(`${BOLD}══════════════════════════════════════════════════════════${RESET}\n`);

  process.exit(0);
}

main().catch(err => {
  console.error('Script error:', err);
  process.exit(1);
});
