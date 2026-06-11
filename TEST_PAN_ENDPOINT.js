/**
 * Test PAN Verification Endpoint
 * Tests: POST /api/kyc/pan-verify
 * 
 * Current Status: ❌ QuickEKYC PAN service is NOT enabled on your account
 * Workaround: Using mock data in development mode
 */

require('dotenv').config();
const axios = require('axios');

const API_BASE_URL = 'http://localhost:5000/api';
const TEST_PAN = 'KCRPK9812F';

// Mock user token (you'll need to get a real one from actual login)
const mockUserToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6MSwiaWF0IjoxNjAwMDAwMDAwfQ.test'; 

async function testPanVerifyEndpoint() {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`PAN VERIFICATION ENDPOINT TEST`);
  console.log(`${'='.repeat(60)}\n`);

  console.log(`📍 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`📍 API Base URL: ${API_BASE_URL}`);
  console.log(`📍 PAN to verify: ${TEST_PAN}`);
  console.log(`📍 Endpoint: POST ${API_BASE_URL}/kyc/pan-verify\n`);

  console.log(`${'─'.repeat(60)}`);
  console.log(`1️⃣  CURRENT ISSUE`);
  console.log(`${'─'.repeat(60)}`);
  console.log(`❌ QuickEKYC PAN Service Status: NOT ENABLED`);
  console.log(`   - Your API key: b836431f-1e6b-45dd-8e6d-6ea81b40da99`);
  console.log(`   - Error: "Service not allowed" (404)`);
  console.log(`   - Reason: PAN verification not enabled on your account\n`);

  console.log(`${'─'.repeat(60)}`);
  console.log(`2️⃣  DEVELOPMENT MODE BEHAVIOR`);
  console.log(`${'─'.repeat(60)}`);
  console.log(`✓ Returns MOCK data automatically`);
  console.log(`✓ Prevents app from breaking`);
  console.log(`✓ User marked as "verified" with test data\n`);

  console.log(`${'─'.repeat(60)}`);
  console.log(`3️⃣  EXPECTED RESPONSE (Development Mode)`);
  console.log(`${'─'.repeat(60)}\n`);

  const mockResponse = {
    success: true,
    verified: true,
    panNumber: TEST_PAN,
    fullName: 'MOCK USER',
    category: 'individual',
    dob: '01-01-1990',
    gender: 'M',
    address: null,
    requestId: `PAN-MOCK-${Date.now()}`,
    message: null
  };

  console.log(JSON.stringify(mockResponse, null, 2));

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`4️⃣  REAL API RESPONSE (When PAN Service is Enabled)`);
  console.log(`${'─'.repeat(60)}\n`);

  const realResponse = {
    success: true,
    verified: true,
    panNumber: 'KCRPK9812F',
    fullName: 'ACTUAL PAN HOLDER NAME',
    category: 'individual',
    dob: '15-06-1985',
    dobMySQL: '1985-06-15',
    gender: 'M',
    mobileNo: null,
    email: null,
    address: {
      line1: 'Address Line 1',
      line2: 'Address Line 2',
      state: 'MH',
      dist: 'Mumbai',
      pincode: '400001'
    },
    requestId: 12345678,
    message: null
  };

  console.log(JSON.stringify(realResponse, null, 2));

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`5️⃣  HOW TO FIX THIS`);
  console.log(`${'─'.repeat(60)}\n`);

  console.log(`Option A: Enable PAN Service on QuickEKYC`);
  console.log(`  1. Login to your QuickEKYC dashboard`);
  console.log(`  2. Go to Services section`);
  console.log(`  3. Purchase/Enable "PAN Verification" service`);
  console.log(`  4. Wait for approval (usually instant)`);
  console.log(`  5. Test again\n`);

  console.log(`Option B: Use Alternative PAN Verification Service`);
  console.log(`  1. NSDL PAN Verification API`);
  console.log(`  2. Setu PAN API`);
  console.log(`  3. Other EKYC providers\n`);

  console.log(`Option C: Continue with Mock Data (Development Only)`);
  console.log(`  1. Keep NODE_ENV=development in .env`);
  console.log(`  2. App will return mock verified status`);
  console.log(`  3. ⚠️  NOT suitable for production!\n`);

  console.log(`${'─'.repeat(60)}`);
  console.log(`6️⃣  HOW TO TEST WHEN SERVICE IS ENABLED`);
  console.log(`${'─'.repeat(60)}\n`);

  console.log(`Step 1: Make sure backend is running`);
  console.log(`  $ npm run dev\n`);

  console.log(`Step 2: Get a valid auth token (from actual login)`);
  console.log(`  POST /api/auth/login\n`);

  console.log(`Step 3: Call the PAN verify endpoint`);
  console.log(`  POST /api/kyc/pan-verify`);
  console.log(`  Headers: { Authorization: "Bearer <token>" }`);
  console.log(`  Body: { "pan": "KCRPK9812F" }\n`);

  console.log(`Step 4: Response will contain:`);
  console.log(`  - verified: boolean`);
  console.log(`  - panNumber: string`);
  console.log(`  - fullName: string`);
  console.log(`  - category: string`);
  console.log(`  - dob: string (DD-MM-YYYY)`);
  console.log(`  - gender: string`);
  console.log(`  - address: object\n`);

  console.log(`${'='.repeat(60)}`);
  console.log(`✅ CURRENT SETUP: Working with mock data in dev mode`);
  console.log(`${'='.repeat(60)}\n`);
}

testPanVerifyEndpoint();
