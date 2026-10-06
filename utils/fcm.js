const admin = require('../config/firebase');

// FCM rejects the whole message if any data value isn't a string, so nested
// values (e.g. `params: { screen: 'LoanHistory' }`) are JSON-encoded here and
// decoded again by the app's notification-tap handler.
const stringifyData = (data = {}) =>
  Object.fromEntries(
    Object.entries(data)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)])
  );

const sendNotification = async (fcmToken, title, body, data = {}) => {
  if (!fcmToken) return;
  try {
    const message = {
      notification: { title, body },
      data: { ...stringifyData(data), click_action: 'FLUTTER_NOTIFICATION_CLICK' },
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
      data: stringifyData(data),
      tokens,
    };
    const response = await admin.messaging().sendEachForMulticast(message);

    return response;
  } catch (err) {
    console.error('FCM Multicast Error:', err.message);
  }
};

module.exports = { sendNotification, sendMulticast };

