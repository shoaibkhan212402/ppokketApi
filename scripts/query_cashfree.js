const dotenv = require('dotenv');
dotenv.config();

async function run() {
  const appId = process.env.CASHFREE_APP_ID;
  const secretKey = process.env.CASHFREE_SECRET_KEY;
  const baseUrl = 'https://sandbox.cashfree.com';

  const subId = '3176157';
  const url = `${baseUrl}/api/v2/subscriptions/${subId}`;
  
  console.log('Querying Cashfree Sandbox for Subscription Reference:', subId);
  console.log('URL:', url);

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'X-Client-Id': appId,
        'X-Client-Secret': secretKey
      }
    });

    const data = await res.json();
    console.log('STATUS CODE:', res.status);
    console.log('RESPONSE:', JSON.stringify(data, null, 2));
    
    // Also try custom subscription id if the reference fails
    const customSubId = 'sub_ppokket_20_1782399893382';
    const customUrl = `${baseUrl}/api/v2/subscriptions/${customSubId}`;
    console.log('\nQuerying Cashfree Sandbox for Custom Subscription ID:', customSubId);
    
    const customRes = await fetch(customUrl, {
      method: 'GET',
      headers: {
        'X-Client-Id': appId,
        'X-Client-Secret': secretKey
      }
    });
    const customData = await customRes.json();
    console.log('STATUS CODE:', customRes.status);
    console.log('RESPONSE:', JSON.stringify(customData, null, 2));

    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

run();
