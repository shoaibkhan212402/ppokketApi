require('dotenv').config();
const axios = require('axios');

const QUICKEKYC_BASE_URL = 'https://api.quickekyc.com/api/v1/pan/pan_advance';
const API_KEY = process.env.QUICKEKYC_API_KEY;
const testPAN = 'KCRPK9812F';

async function testRawAPI() {
  console.log(`\n========================================`);
  console.log(`Raw API Test - PAN Verification`);
  console.log(`========================================\n`);
  
  console.log(`API URL: ${QUICKEKYC_BASE_URL}`);
  console.log(`API Key: ${API_KEY ? API_KEY.substring(0, 10) + '...' : 'NOT SET'}`);
  console.log(`PAN: ${testPAN}\n`);
  
  if (!API_KEY) {
    console.error('❌ API Key not configured!');
    return;
  }

  try {
    console.log('Sending request to QuickEKYC API...\n');
    
    const response = await axios.post(
      QUICKEKYC_BASE_URL,
      { 
        key: API_KEY, 
        id_number: testPAN 
      },
      { 
        headers: { 'Content-Type': 'application/json' }, 
        timeout: 15000 
      }
    );

    console.log('✓ Request successful!\n');
    console.log('Raw API Response:');
    console.log(JSON.stringify(response.data, null, 2));

  } catch (error) {
    console.error('❌ API Request Failed!\n');
    
    if (error.response) {
      console.log(`Status Code: ${error.response.status}`);
      console.log(`Status Text: ${error.response.statusText}`);
      console.log(`\nResponse Data:`);
      console.log(JSON.stringify(error.response.data, null, 2));
      
      console.log(`\n========================================`);
      console.log(`Error Analysis:`);
      console.log(`========================================`);
      
      const data = error.response.data;
      if (data.message === 'Service not allowed') {
        console.log('⚠️  "Service not allowed" - Possible causes:');
        console.log('   1. API key does not have PAN verification permission');
        console.log('   2. Service is disabled/suspended in your plan');
        console.log('   3. IP address is not whitelisted');
      } else if (data.status === 'error') {
        console.log(`⚠️  API Error: ${data.message}`);
      }
      
    } else if (error.message === 'getaddrinfo ENOTFOUND api.quickekyc.com') {
      console.error('❌ Network Error: Cannot reach api.quickekyc.com');
      console.log('   Check your internet connection');
    } else {
      console.error(`Error: ${error.message}`);
    }
    
    console.log(`========================================\n`);
  }
}

testRawAPI();
