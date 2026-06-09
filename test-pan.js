const https = require('https');

const API_URL = 'https://apitxt.com/api/panVerify';
const AUTH_KEY = 'RtA9FdfvRkK7E4sRn8DfejJ4OVfvaGcQ1tSBhRxzTEY';
const TEST_PAN = 'KSJPS2535H';
const TEST_NAME = 'mohammad shoaib khan';
const TEST_DOB = '15/05/2002';

function verifyPanPost() {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      authkey: AUTH_KEY,
      pan: TEST_PAN,
      name: TEST_NAME,
      dob: TEST_DOB
    });

    const options = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    };

    const req = https.request(API_URL, options, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          resolve(data);
        }
      });
    });

    req.on('error', (err) => {
      reject(err);
    });

    req.write(payload);
    req.end();
  });
}

function verifyPanGet() {
  return new Promise((resolve, reject) => {
    const url = `${API_URL}?authkey=${encodeURIComponent(AUTH_KEY)}&pan=${encodeURIComponent(TEST_PAN)}&name=${encodeURIComponent(TEST_NAME)}&dob=${encodeURIComponent(TEST_DOB)}`;

    https.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          resolve(data);
        }
      });
    }).on('error', (err) => {
      reject(err);
    });
  });
}

async function run() {



  try {

    const postRes = await verifyPanPost();


    const getRes = await verifyPanGet();
  } catch (error) {
    console.error('Error testing API:', error);
  }
}

run();
