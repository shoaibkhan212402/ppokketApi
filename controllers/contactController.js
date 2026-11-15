const { pool } = require('../config/db');
const { sendContactAcknowledgementEmail } = require('../utils/email');
const { auditLog } = require('../utils/audit');

// The WHERE for a list filter: status all | unread | read, plus free-text search
const filterSql = (status, search) => {
  let where = '';
  const params = [];
  if (status === 'unread') where += ' AND is_read = 0';
  if (status === 'read') where += ' AND is_read = 1';
  if (search) {
    where += ' AND (name LIKE ? OR email LIKE ? OR subject LIKE ? OR message LIKE ?)';
    const q = `%${search}%`;
    params.push(q, q, q, q);
  }
  return { where, params };
};

// POST /api/contact  (public)
const submitContactMessage = async (req, res) => {
  try {
    const { name, email, phone, subject, message, category } = req.body;

    if (!name || !email || !message) {
      return res.status(400).json({ success: false, message: 'Name, email and message are required' });
    }

    await pool.query(
      `INSERT INTO contact_messages (name, email, phone, category, subject, message)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [name, email, phone || null, category || null, subject || null, message]
    );

    sendContactAcknowledgementEmail({ name, email }).catch(() => {});

    res.json({ success: true, message: 'Your message has been sent. Our team will get back to you shortly.' });
  } catch (err) {
    console.error('[submitContactMessage]', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/admin/contact-messages
const getContactMessages = async (req, res) => {
  try {
    const { page = 1, limit = 25, status = 'all', search = '' } = req.query;
    const offset = (page - 1) * limit;

    const { where, params } = filterSql(status, search);

    const [messages] = await pool.query(
      `SELECT * FROM contact_messages WHERE 1=1 ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...params, Number(limit), Number(offset)]
    );

    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) AS total FROM contact_messages WHERE 1=1 ${where}`,
      params
    );

    const [[{ unread }]] = await pool.query(
      `SELECT COUNT(*) AS unread FROM contact_messages WHERE is_read = 0`
    );

    res.json({ success: true, messages, total, unread });
  } catch (err) {
    console.error('[getContactMessages]', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// PATCH /api/admin/contact-messages/:id/toggle-read
const toggleContactMessageRead = async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await pool.query('SELECT id, is_read FROM contact_messages WHERE id = ?', [id]);
    if (!rows.length) return res.status(404).json({ success: false, message: 'Message not found' });

    const nextRead = rows[0].is_read ? 0 : 1;
    await pool.query('UPDATE contact_messages SET is_read = ? WHERE id = ?', [nextRead, id]);

    res.json({ success: true, is_read: !!nextRead });
  } catch (err) {
    console.error('[toggleContactMessageRead]', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// DELETE /api/admin/contact-messages/:id  (super admin)
const deleteContactMessage = async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [result] = await pool.query('DELETE FROM contact_messages WHERE id = ?', [id]);
    if (!result.affectedRows) return res.status(404).json({ success: false, message: 'Message not found' });
    await auditLog({ req, action: 'contact_messages_deleted', entityType: 'contact_message', entityId: id, details: { count: 1 } });
    res.json({ success: true, deleted: 1, message: 'Message deleted' });
  } catch (err) {
    console.error('[deleteContactMessage]', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/admin/contact-messages/delete  (super admin)
//   { ids: [1, 2, …] }                          — the ticked messages
//   { all: true, status: 'all'|'unread'|'read', search } — every message the filter shows
const deleteContactMessages = async (req, res) => {
  try {
    const { ids, all, status = 'all', search = '' } = req.body || {};
    let result;
    let details;
    if (all === true) {
      const { where, params } = filterSql(status, search);
      [result] = await pool.query(`DELETE FROM contact_messages WHERE 1=1 ${where}`, params);
      details = { all: true, status, search: search || undefined };
    } else {
      const list = Array.isArray(ids) ? [...new Set(ids.map(n => parseInt(n)).filter(n => n > 0))] : [];
      if (!list.length) return res.status(400).json({ success: false, message: 'Choose the messages to delete' });
      if (list.length > 1000) return res.status(400).json({ success: false, message: 'Too many at once (max 1000)' });
      [result] = await pool.query('DELETE FROM contact_messages WHERE id IN (?)', [list]);
      details = { ids: list };
    }
    await auditLog({ req, action: 'contact_messages_deleted', entityType: 'contact_message', details: { ...details, count: result.affectedRows } });
    res.json({ success: true, deleted: result.affectedRows, message: `${result.affectedRows} message${result.affectedRows === 1 ? '' : 's'} deleted` });
  } catch (err) {
    console.error('[deleteContactMessages]', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

module.exports = {
  submitContactMessage, getContactMessages, toggleContactMessageRead, deleteContactMessage, deleteContactMessages,
};
