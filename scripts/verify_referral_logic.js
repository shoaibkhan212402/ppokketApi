const { pool } = require('../config/db');
const { redisClient, connectRedis } = require('../config/redis');

const API_BASE = 'http://localhost:5000/api';

async function runTests() {
  try {
    console.log('🔄 Connecting to Redis...');
    await connectRedis();

    // Clean up any old test users if they exist
    console.log('🧹 Cleaning up old test data...');
    await pool.query('DELETE FROM referrals WHERE referrer_id IN (SELECT id FROM users WHERE mobile IN ("9999999999", "8888888888")) OR referred_id IN (SELECT id FROM users WHERE mobile IN ("9999999999", "8888888888"))');
    await pool.query('DELETE FROM notifications WHERE user_id IN (SELECT id FROM users WHERE mobile IN ("9999999999", "8888888888"))');
    await pool.query('DELETE FROM users WHERE mobile IN ("9999999999", "8888888888")');

    console.log('\n--- TEST 1: Request OTP for User 1 ---');
    const sendOtpRes1 = await fetch(`${API_BASE}/auth/send-otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mobile: '9999999999' }),
    });
    const sendOtpData1 = await sendOtpRes1.json();
    console.log('Send OTP response:', sendOtpData1);
    if (!sendOtpData1.success) throw new Error('Send OTP failed');

    // Retrieve OTP from Redis
    const otpRaw1 = await redisClient.get('otp:9999999999');
    if (!otpRaw1) throw new Error('OTP not found in Redis');
    const { otp: otp1 } = JSON.parse(otpRaw1);
    console.log(`Fetched OTP from Redis: ${otp1}`);

    console.log('\n--- TEST 2: Verify OTP with INVALID Referral Code ---');
    const verifyInvalidRes = await fetch(`${API_BASE}/auth/verify-otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mobile: '9999999999', otp: otp1, referral_code: 'INVALIDCODE123' }),
    });
    const verifyInvalidData = await verifyInvalidRes.json();
    console.log('Verify OTP (Invalid Ref) status:', verifyInvalidRes.status);
    console.log('Verify OTP (Invalid Ref) body:', verifyInvalidData);
    if (verifyInvalidRes.status !== 400 || verifyInvalidData.success !== false) {
      throw new Error('Expected 400 Bad Request for invalid referral code!');
    }
    console.log('✅ Correctly rejected invalid referral code.');

    console.log('\n--- TEST 3: Verify OTP with NO Referral Code (Create User 1) ---');
    const verifyValidRes1 = await fetch(`${API_BASE}/auth/verify-otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mobile: '9999999999', otp: otp1 }),
    });
    const verifyValidData1 = await verifyValidRes1.json();
    console.log('Verify OTP (Valid) status:', verifyValidRes1.status);
    console.log('Verify OTP (Valid) body:', verifyValidData1);
    if (verifyValidRes1.status !== 200 || !verifyValidData1.success) {
      throw new Error('Verify OTP failed for valid credentials without referral code');
    }
    const token1 = verifyValidData1.token;
    const user1Id = verifyValidData1.user.id;
    console.log(`✅ User 1 created. ID: ${user1Id}, Token: ${token1.slice(0, 15)}...`);

    // Fetch User 1 referral code from database
    const [u1Row] = await pool.query('SELECT referral_code FROM users WHERE id = ?', [user1Id]);
    const u1ReferralCode = u1Row[0].referral_code;
    console.log(`User 1 Referral Code: ${u1ReferralCode}`);

    console.log('\n--- TEST 4: Request OTP for User 2 ---');
    const sendOtpRes2 = await fetch(`${API_BASE}/auth/send-otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mobile: '8888888888' }),
    });
    const sendOtpData2 = await sendOtpRes2.json();
    if (!sendOtpData2.success) throw new Error('Send OTP failed for User 2');

    // Retrieve OTP from Redis
    const otpRaw2 = await redisClient.get('otp:8888888888');
    const { otp: otp2 } = JSON.parse(otpRaw2);
    console.log(`Fetched OTP from Redis: ${otp2}`);

    console.log('\n--- TEST 5: Verify OTP with VALID Referral Code (Create User 2 referred by User 1) ---');
    const verifyValidRes2 = await fetch(`${API_BASE}/auth/verify-otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mobile: '8888888888', otp: otp2, referral_code: u1ReferralCode }),
    });
    const verifyValidData2 = await verifyValidRes2.json();
    console.log('Verify OTP status:', verifyValidRes2.status);
    console.log('Verify OTP body:', verifyValidData2);
    if (verifyValidRes2.status !== 200 || !verifyValidData2.success) {
      throw new Error('Failed to verify OTP with valid referral code');
    }
    const token2 = verifyValidData2.token;
    const user2Id = verifyValidData2.user.id;
    console.log(`✅ User 2 created. ID: ${user2Id}, Token: ${token2.slice(0, 15)}...`);

    // Check DB to verify link
    const [u2Row] = await pool.query('SELECT referred_by, referral_code FROM users WHERE id = ?', [user2Id]);
    const u2ReferralCode = u2Row[0].referral_code;
    console.log(`User 2 referred_by in DB: ${u2Row[0].referred_by} (Expected: ${user1Id}), Referral Code: ${u2ReferralCode}`);
    if (u2Row[0].referred_by !== user1Id) {
      throw new Error('Database referred_by does not match User 1 ID');
    }

    const [refRows] = await pool.query('SELECT * FROM referrals WHERE referrer_id = ? AND referred_id = ?', [user1Id, user2Id]);
    console.log(`Referral record exists: ${refRows.length > 0}`);
    if (refRows.length === 0) {
      throw new Error('Referral record was not created in referrals table!');
    }
    console.log('✅ Referral link successfully established in verify-otp.');

    console.log('\n--- TEST 6: Verify User 1 cannot self-refer in profile update ---');
    const selfReferRes = await fetch(`${API_BASE}/user/update`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token1}`
      },
      body: JSON.stringify({
        full_name: 'Test User One',
        email: 'test1@test.com',
        referral_code: u1ReferralCode
      })
    });
    const selfReferData = await selfReferRes.json();
    console.log('Self-refer status:', selfReferRes.status);
    console.log('Self-refer body:', selfReferData);
    if (selfReferRes.status !== 400 || selfReferData.success !== false || selfReferData.message !== 'You cannot refer yourself.') {
      throw new Error('Expected 400 Bad Request with self-referral warning!');
    }
    console.log('✅ Correctly rejected self-referral in update profile.');

    console.log('\n--- TEST 7: Verify User 1 cannot use invalid referral code in profile update ---');
    const invalidReferRes = await fetch(`${API_BASE}/user/update`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token1}`
      },
      body: JSON.stringify({
        full_name: 'Test User One',
        email: 'test1@test.com',
        referral_code: 'BADCODE123'
      })
    });
    const invalidReferData = await invalidReferRes.json();
    console.log('Invalid refer status:', invalidReferRes.status);
    console.log('Invalid refer body:', invalidReferData);
    if (invalidReferRes.status !== 400 || invalidReferData.success !== false) {
      throw new Error('Expected 400 Bad Request with invalid referral code warning!');
    }
    console.log('✅ Correctly rejected invalid referral code in update profile.');

    console.log('\n--- TEST 8: Linking pre-existing user via verify-otp ---');
    // We will create User 3 (mobile 9999999999 was deleted above, so let's create 9999999999 again)
    // Wait, let's request OTP for 9999999999
    await fetch(`${API_BASE}/auth/send-otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mobile: '9999999999' }),
    });
    const otpRaw3 = await redisClient.get('otp:9999999999');
    const { otp: otp3 } = JSON.parse(otpRaw3);

    // Verify OTP first without referral code -> creates User 3
    const verifyValidRes3 = await fetch(`${API_BASE}/auth/verify-otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mobile: '9999999999', otp: otp3 }),
    });
    const verifyValidData3 = await verifyValidRes3.json();
    const token3 = verifyValidData3.token;
    const user3Id = verifyValidData3.user.id;
    console.log(`Created User 3 without referrer. ID: ${user3Id}`);

    // Request OTP again for User 3 to simulate a new session where they enter a referral code
    await fetch(`${API_BASE}/auth/send-otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mobile: '9999999999' }),
    });
    const otpRaw4 = await redisClient.get('otp:9999999999');
    const { otp: otp4 } = JSON.parse(otpRaw4);

    // Verify OTP with User 2's referral code. User 3 exists but referred_by is null.
    console.log('Logging in existing User 3 with User 2 referral code...');
    const verifyExistingRes = await fetch(`${API_BASE}/auth/verify-otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mobile: '9999999999', otp: otp4, referral_code: u2ReferralCode }),
    });
    const verifyExistingData = await verifyExistingRes.json();
    console.log('Existing login status:', verifyExistingRes.status);
    console.log('Existing login body:', verifyExistingData);
    if (verifyExistingRes.status !== 200 || !verifyExistingData.success) {
      throw new Error('Failed to verify OTP for existing user with referral code');
    }

    // Verify in DB that User 3 is now referred by User 2
    const [u3Row] = await pool.query('SELECT referred_by FROM users WHERE id = ?', [user3Id]);
    console.log(`User 3 referred_by in DB: ${u3Row[0].referred_by} (Expected: ${user2Id})`);
    if (u3Row[0].referred_by !== user2Id) {
      throw new Error('Pre-existing user was not linked during verify-otp');
    }
    console.log('✅ Pre-existing user successfully linked via verify-otp referralCode.');

    // Clean up
    console.log('\n🧹 Cleaning up test data...');
    await pool.query('DELETE FROM referrals WHERE referrer_id IN (SELECT id FROM users WHERE mobile IN ("9999999999", "8888888888")) OR referred_id IN (SELECT id FROM users WHERE mobile IN ("9999999999", "8888888888"))');
    await pool.query('DELETE FROM notifications WHERE user_id IN (SELECT id FROM users WHERE mobile IN ("9999999999", "8888888888"))');
    await pool.query('DELETE FROM users WHERE mobile IN ("9999999999", "8888888888")');

    console.log('\n🎉 ALL TESTS PASSED SUCCESSFULLY! Referral logic is fully working.');
    await redisClient.quit();
    process.exit(0);
  } catch (err) {
    console.error('\n❌ TEST FAILED:', err);
    await redisClient.quit();
    process.exit(1);
  }
}

runTests();
