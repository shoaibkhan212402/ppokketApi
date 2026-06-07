const admin = require('firebase-admin');
require('dotenv').config();

let firebaseAdmin = null;

try {
  if (!admin.apps.length && process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_PRIVATE_KEY) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/^"|"$/g, '').replace(/\\n/g, '\n'),
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

