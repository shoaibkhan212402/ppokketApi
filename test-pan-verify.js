require('dotenv').config();
const { verifyPAN } = require('./utils/panVerify');

async function testPANVerification() {
  const testPAN = 'KCRPK9812F';
  
  console.log(`\n========================================`);
  console.log(`Testing PAN Verification`);
  console.log(`========================================\n`);
  console.log(`PAN to verify: ${testPAN}`);
  console.log(`Node Environment: ${process.env.NODE_ENV || 'not set'}`);
  console.log(`API Key configured: ${process.env.QUICKEKYC_API_KEY ? 'Yes' : 'No'}\n`);

  try {
    console.log('Sending verification request...\n');
    const result = await verifyPAN({ pan: testPAN });
    
    console.log('Response received:\n');
    console.log(JSON.stringify(result, null, 2));
    
    console.log(`\n========================================`);
    console.log(`Verification Result Summary:`);
    console.log(`========================================`);
    console.log(`✓ Request successful: ${result.success}`);
    console.log(`✓ PAN verified: ${result.verified}`);
    if (result.verified) {
      console.log(`✓ Full Name: ${result.fullName}`);
      console.log(`✓ Category: ${result.category}`);
      console.log(`✓ DOB: ${result.dob}`);
      console.log(`✓ Gender: ${result.gender}`);
      console.log(`✓ Request ID: ${result.requestId}`);
    } else {
      console.log(`✗ Verification failed: ${result.message}`);
    }
    console.log(`========================================\n`);

  } catch (error) {
    console.error('\n❌ Error during verification:');
    console.error(`Message: ${error.message}`);
    console.error(`Stack: ${error.stack}`);
    console.log(`\n========================================`);
    console.log(`Possible Issues:`);
    console.log(`1. QUICKEKYC_API_KEY not set in .env`);
    console.log(`2. API service is down or unavailable`);
    console.log(`3. Invalid PAN format`);
    console.log(`4. Network connectivity issue`);
    console.log(`========================================\n`);
  }
}

testPANVerification();
