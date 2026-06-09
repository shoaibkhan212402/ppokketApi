const admin = require('../config/firebase');

const sendNotification = async (fcmToken, title, body, data = {}) => {
  if (!fcmToken) return;
  try {
    const message = {
      notification: { title, body },
      data: { ...data, click_action: 'FLUTTER_NOTIFICATION_CLICK' },
      token: fcmToken,
    };
    const response = await admin.messaging().send(message);

    return response;
  } catch (err) {
    console.error('FCM Error:', err.message);
  }
};

const sendMulticast = async (tokens, title, body, data = {}) => {
  if (!tokens || !tokens.length) return;
  try {
    const message = {
      notification: { title, body },
      data,
      tokens,
    };
    const response = await admin.messaging().sendEachForMulticast(message);

    return response;
  } catch (err) {
    console.error('FCM Multicast Error:', err.message);
  }
};

module.exports = { sendNotification, sendMulticast };

