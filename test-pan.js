const https = require('https');

const API_URL = 'https://api.quickekyc.com/api/v1/pan/pan_advance';
const API_KEY = process.env.QUICKEKYC_API_KEY || 'b836431f-1e6b-45dd-8e6d-6ea81b40da99';
const TEST_PAN = 'KSJPS2535H';

function verifyPan() {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ key: API_KEY, id_number: TEST_PAN });

    const url = new URL(API_URL);
    const options = {
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { resolve(data); }
      });
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function run() {
  try {
    const result = await verifyPan();
    console.log('PAN Verify Response:', JSON.stringify(result, null, 2));
  } catch (error) {
    console.error('Error testing API:', error);
  }
}

run();
