const { pool } = require('../config/db');
const { connectRedis, redisClient } = require('../config/redis');
const crypto = require('crypto');

const API_BASE = 'http://localhost:5000/api';

async function runTests() {
  try {
    console.log('🔄 Connecting to Redis...');
    await connectRedis();

    console.log('🧹 Cleaning up old test data...');
    // Delete any previous test users/loans
    await pool.query('DELETE FROM referrals WHERE referrer_id IN (SELECT id FROM users WHERE mobile = "7777777777") OR referred_id IN (SELECT id FROM users WHERE mobile = "7777777777")');
    await pool.query('DELETE FROM notifications WHERE user_id IN (SELECT id FROM users WHERE mobile = "7777777777")');
    await pool.query('DELETE FROM emi_schedule WHERE user_id IN (SELECT id FROM users WHERE mobile = "7777777777")');
    await pool.query('DELETE FROM transactions WHERE user_id IN (SELECT id FROM users WHERE mobile = "7777777777")');
    await pool.query('DELETE FROM loans WHERE user_id IN (SELECT id FROM users WHERE mobile = "7777777777")');
    await pool.query('DELETE FROM bank_mandates WHERE user_id IN (SELECT id FROM users WHERE mobile = "7777777777")');
    await pool.query('DELETE FROM bank_details WHERE user_id IN (SELECT id FROM users WHERE mobile = "7777777777")');
    await pool.query('DELETE FROM users WHERE mobile = "7777777777"');

    // Create a test user
    const [userRes] = await pool.query(
      `INSERT INTO users (mobile, full_name, referral_code, credit_limit, wallet_balance, is_kyc_verified)
       VALUES ("7777777777", "Disbursal Test User", "PPK777777", 50000, 0, 1)`
    );
    const userId = userRes.insertId;
    console.log(`Created test user ID: ${userId}`);

    // Insert bank details for the user
    await pool.query(
      `INSERT INTO bank_details (user_id, account_holder, account_number, ifsc_code, bank_name, account_type, is_verified)
       VALUES (?, "Disbursal Test User", "1234567890", "ICIC0001234", "ICICI Bank", "savings", 1)`,
      [userId]
    );
    console.log('Inserted bank details.');

    // Insert approved KYC document
    await pool.query(
      `INSERT INTO kyc_documents (user_id, status) VALUES (?, 'approved')`,
      [userId]
    );
    console.log('Inserted approved KYC document.');

    // Request OTP to generate JWT token for the user
    await fetch(`${API_BASE}/auth/send-otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mobile: '7777777777' }),
    });
    const otpRaw = await redisClient.get('otp:7777777777');
    const { otp } = JSON.parse(otpRaw);

    const loginRes = await fetch(`${API_BASE}/auth/verify-otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mobile: '7777777777', otp }),
    });
    const loginData = await loginRes.json();
    const token = loginData.token;
    console.log(`Logged in. User Token: ${token.slice(0, 15)}...`);

    // Ensure system_settings has processing_fee_in_first_emi = 'false'
    const [settingsRows] = await pool.query('SELECT setting_key, setting_value FROM system_settings');
    const settings = {};
    for (const r of settingsRows) {
      settings[r.setting_key] = r.setting_value;
    }
    console.log(`System setting processing_fee_in_first_emi: ${settings.processing_fee_in_first_emi}`);
    if (settings.processing_fee_in_first_emi !== 'false') {
      throw new Error('Expected processing_fee_in_first_emi to be false in database settings!');
    }

    // Apply for a loan
    console.log('\n--- TEST 1: Applying for a loan ---');
    const applyRes = await fetch(`${API_BASE}/loan/apply`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        amount: 10000,
        duration_months: 3,
        purpose: 'Medical emergency'
      })
    });
    const applyData = await applyRes.json();
    console.log('Apply response:', applyData);
    if (!applyData.success) throw new Error('Loan application failed');
    const loanId = applyData.loan.id;

    // Admin approves the loan
    console.log('\n--- TEST 2: Admin approves the loan ---');
    // We will bypass the admin API validation for simplicity and update the loan status/fields directly, or call the admin endpoint if possible.
    // Wait, let's call the admin endpoint! We need admin token. We can log in as super_admin.
    const adminLoginRes = await fetch(`${API_BASE}/auth/admin-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@ppokket.com', password: 'Admin@123' })
    });
    const adminLoginData = await adminLoginRes.json();
    const adminToken = adminLoginData.token;
    console.log(`Logged in as Admin. Token: ${adminToken.slice(0, 15)}...`);

    const approveRes = await fetch(`${API_BASE}/admin/approve-loan/${loanId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${adminToken}`
      },
      body: JSON.stringify({
        approved_amount: 10000,
        duration_months: 3,
        interest_rate: 2.5,
        first_emi_date: '2026-07-03',
        processing_fee_pct: 2 // ₹200 fee
      })
    });
    const approveData = await approveRes.json();
    console.log('Approve response:', approveData);
    if (!approveData.success) throw new Error('Loan approval failed');

    // Confirm loan is approved in DB
    const [loanAfterApprove] = await pool.query('SELECT * FROM loans WHERE id = ?', [loanId]);
    console.log(`Loan status after approve: ${loanAfterApprove[0].status}`);

    // Insert mock active bank mandate
    await pool.query(
      `INSERT INTO bank_mandates (user_id, subscription_id, status)
       VALUES (?, "SUB_TEST_12345", "active")`,
      [userId]
    );
    console.log('Mock active bank mandate inserted.');

    // User requests withdrawal
    console.log('\n--- TEST 2.5: User accepts agreement and requests withdrawal ---');
    const requestRes = await fetch(`${API_BASE}/loan/request-withdrawal/${loanId}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ agreementAccepted: true })
    });
    const requestData = await requestRes.json();
    console.log('Request withdrawal response:', requestData);
    if (!requestData.success) throw new Error('Request withdrawal failed');

    // Confirm loan status is withdrawal_requested
    const [loanAfterRequest] = await pool.query('SELECT status FROM loans WHERE id = ?', [loanId]);
    console.log(`Loan status after request: ${loanAfterRequest[0].status}`);
    if (loanAfterRequest[0].status !== 'withdrawal_requested') {
      throw new Error(`Expected status to be withdrawal_requested, got ${loanAfterRequest[0].status}`);
    }

    // Verify EMI schedule is hidden from user
    console.log('\n--- TEST 3: Verify user cannot see EMI schedule for approved loan ---');
    const detailsRes = await fetch(`${API_BASE}/loan/details/${loanId}`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const detailsData = await detailsRes.json();
    console.log('detailsData:', detailsData);
    console.log('Loan details emi_schedule count:', detailsData.emi_schedule?.length);
    if (detailsData.emi_schedule?.length !== 0) {
      throw new Error('EMI schedule should be empty before disbursal!');
    }

    const scheduleRes = await fetch(`${API_BASE}/loan/emi-schedule/${loanId}`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const scheduleData = await scheduleRes.json();
    console.log('Emi schedule endpoint schedule count:', scheduleData.schedule.length);
    if (scheduleData.schedule.length !== 0) {
      throw new Error('EMI schedule endpoint should return empty array before disbursal!');
    }

    // Verify dashboard does not return next_emi
    const dashRes = await fetch(`${API_BASE}/user/dashboard`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const dashData = await dashRes.json();
    console.log('Dashboard next_emi:', dashData.dashboard?.next_emi);
    if (dashData.dashboard?.next_emi !== null) {
      throw new Error('Dashboard next_emi should be null before disbursal!');
    }

    // Verify order creation fails for approved loan
    console.log('\n--- TEST 4: Verify order creation fails for approved loan ---');
    const orderRes = await fetch(`${API_BASE}/payment/create-order`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        loan_id: loanId,
        amount: 3500
      })
    });
    const orderData = await orderRes.json();
    console.log('Create order status:', orderRes.status);
    console.log('Create order response:', orderData);
    if (orderRes.status !== 404 || orderData.success !== false) {
      throw new Error('Expected 404 error for order creation before disbursal');
    }

    // Admin disburses the loan
    console.log('\n--- TEST 5: Admin disburses the loan (checking processing fee deduction) ---');
    const disburseRes = await fetch(`${API_BASE}/admin/disburse-loan/${loanId}`, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${adminToken}` }
    });
    const disburseData = await disburseRes.json();
    console.log('Disburse response:', disburseData);
    if (!disburseRes.ok || !disburseData.success) {
      throw new Error('Loan disbursement failed');
    }

    // Verify wallet balance of user in DB.
    // Loan amount = 10000. Processing fee = 2% of 10000 = 200. GST = 18% of 200 = 36.
    // Total deduction = 236. Payout amount = 10000 - 236 = 9764.
    const [userAfterDisburse] = await pool.query('SELECT wallet_balance FROM users WHERE id = ?', [userId]);
    const walletBalance = parseFloat(userAfterDisburse[0].wallet_balance);
    console.log(`User wallet balance after disbursal: ₹${walletBalance} (Expected: ₹9764)`);
    if (walletBalance !== 9764) {
      throw new Error(`Expected wallet balance of ₹9764, got ₹${walletBalance}`);
    }

    // Verify transaction record has the correct deducted amount
    const [txnRows] = await pool.query('SELECT * FROM transactions WHERE loan_id = ? AND type = "credit"', [loanId]);
    console.log(`Transaction amount: ₹${txnRows[0].amount} (Expected: ₹9764)`);
    console.log(`Transaction description: "${txnRows[0].description}"`);
    if (parseFloat(txnRows[0].amount) !== 9764) {
      throw new Error(`Expected transaction amount to be ₹9764, got ₹${txnRows[0].amount}`);
    }

    // Verify EMI schedule is now visible
    console.log('\n--- TEST 6: Verify user can see EMI schedule after disbursal ---');
    const detailsAfterDisburseRes = await fetch(`${API_BASE}/loan/details/${loanId}`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const detailsAfterDisburseData = await detailsAfterDisburseRes.json();
    console.log('EMI schedule count after disbursal:', detailsAfterDisburseData.emi_schedule.length);
    if (detailsAfterDisburseData.emi_schedule.length === 0) {
      throw new Error('EMI schedule should be visible after disbursal!');
    }

    // Verify dashboard returns next_emi
    const dashAfterDisburseRes = await fetch(`${API_BASE}/user/dashboard`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const dashAfterDisburseData = await dashAfterDisburseRes.json();
    console.log('Dashboard next_emi after disbursal:', dashAfterDisburseData.dashboard?.next_emi);
    if (!dashAfterDisburseData.dashboard?.next_emi) {
      throw new Error('Dashboard next_emi should not be null after disbursal!');
    }

    // Clean up
    console.log('\n🧹 Cleaning up test data...');
    await pool.query('DELETE FROM referrals WHERE referrer_id IN (SELECT id FROM users WHERE mobile = "7777777777") OR referred_id IN (SELECT id FROM users WHERE mobile = "7777777777")');
    await pool.query('DELETE FROM notifications WHERE user_id IN (SELECT id FROM users WHERE mobile = "7777777777")');
    await pool.query('DELETE FROM emi_schedule WHERE user_id IN (SELECT id FROM users WHERE mobile = "7777777777")');
    await pool.query('DELETE FROM transactions WHERE user_id IN (SELECT id FROM users WHERE mobile = "7777777777")');
    await pool.query('DELETE FROM loans WHERE user_id IN (SELECT id FROM users WHERE mobile = "7777777777")');
    await pool.query('DELETE FROM bank_mandates WHERE user_id IN (SELECT id FROM users WHERE mobile = "7777777777")');
    await pool.query('DELETE FROM bank_details WHERE user_id IN (SELECT id FROM users WHERE mobile = "7777777777")');
    await pool.query('DELETE FROM users WHERE mobile = "7777777777"');

    console.log('\n🎉 ALL DISBURSAL AND EMI TESTS PASSED SUCCESSFULLY!');
    await redisClient.quit();
    process.exit(0);
  } catch (err) {
    console.error('\n❌ TEST FAILED:', err);
    await redisClient.quit();
    process.exit(1);
  }
}

runTests();
