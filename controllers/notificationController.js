const { pool } = require('../config/db');

// GET /api/notifications
const getNotifications = async (req, res) => {
  try {
    const [notifs] = await pool.query(
      'SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50',
      [req.user.id]
    );
    res.json({ success: true, notifications: notifs });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// PUT /api/notifications/read/:id
const markRead = async (req, res) => {
  try {
    await pool.query(
      'UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?',
      [req.params.id, req.user.id]
    );
    res.json({ success: true, message: 'Marked as read' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// PUT /api/notifications/read-all
const markAllRead = async (req, res) => {
  try {
    await pool.query('UPDATE notifications SET is_read = 1 WHERE user_id = ?', [req.user.id]);
    res.json({ success: true, message: 'All notifications marked as read' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

module.exports = { getNotifications, markRead, markAllRead };
