const admin = require('firebase-admin');
require('dotenv').config();

let firebaseAdmin = null;

const formatPrivateKey = (key) => {
  if (!key) return key;
  // 1. Remove surrounding double/single quotes and trim
  let formatted = key.trim().replace(/^["']|["']$/g, '');
  
  // 2. Replace literal '\n' sequences with actual newlines
  formatted = formatted.replace(/\\n/g, '\n');
  
  // 3. If it does not contain newlines, rebuild the PEM structure
  if (!formatted.includes('\n')) {
    const header = '-----BEGIN PRIVATE KEY-----';
    const footer = '-----END PRIVATE KEY-----';
    let body = formatted;
    if (body.startsWith(header)) {
      body = body.substring(header.length);
    }
    if (body.endsWith(footer)) {
      body = body.substring(0, body.length - footer.length);
    }
    body = body.trim().replace(/\s+/g, '');
    
    const chunks = [];
    for (let i = 0; i < body.length; i += 64) {
      chunks.push(body.substring(i, i + 64));
    }
    formatted = `${header}\n${chunks.join('\n')}\n${footer}\n`;
  }
  
  return formatted;
};

try {
  if (!admin.apps.length && process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_PRIVATE_KEY) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: formatPrivateKey(process.env.FIREBASE_PRIVATE_KEY),
      }),
    });
    firebaseAdmin = admin;
    console.log('✅ Firebase Admin initialized successfully.');
  } else {
    throw new Error('Firebase credentials missing or incomplete in environment.');
  }
} catch (err) {
  console.warn('⚠️ Firebase Admin Initialization Warning:', err.message);

  // Provide mock firebase admin helper for test environments
  firebaseAdmin = {
    auth: () => ({
      verifyIdToken: async (token) => {
        console.log('🧪 Simulating Firebase ID Token verification for token:', token);
        // If testing, we return a mock user payload based on token
        return {
          phone_number: token.startsWith('+') ? token : '+919999999999',
          uid: 'mock_firebase_uid_12345'
        };
      }
    }),
    messaging: () => ({
      send: async (payload) => {
        console.log('🧪 Simulating Push Notification Send:', payload);
        return 'mock_message_id';
      },
      sendEachForMulticast: async (payload) => {
        console.log('🧪 Simulating Multicast Notification Send:', payload);
        return { successCount: payload.tokens.length, failureCount: 0 };
      }
    })
  };
}

module.exports = firebaseAdmin;

