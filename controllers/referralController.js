const { pool } = require('../config/db');
const { invalidateUserCache } = require('../config/redis');

// GET /api/referral/my-referrals  (user)
const getMyReferrals = async (req, res) => {
  try {
    const userId = req.user.id;

    const [userRow] = await pool.query(
      'SELECT referral_code, credit_limit FROM users WHERE id = ?',
      [userId]
    );
    if (!userRow.length) return res.status(404).json({ success: false, message: 'User not found' });

    const { referral_code, credit_limit } = userRow[0];

    const [referrals] = await pool.query(
      `SELECT r.id, r.status, r.cashback_amount, r.credited_amount, r.note, r.created_at,
              u.full_name AS referred_name, u.mobile AS referred_mobile,
              u.is_kyc_verified, u.kyc_status,
              kd.status AS kyc_doc_status
         FROM referrals r
         JOIN users u ON u.id = r.referred_id
         LEFT JOIN kyc_documents kd ON kd.user_id = u.id
        WHERE r.referrer_id = ?
        ORDER BY r.created_at DESC`,
      [userId]
    );

    const total       = referrals.length;
    const credited    = referrals.filter(r => r.status === 'credited').length;
    const totalEarned = referrals
      .filter(r => r.status === 'credited')
      .reduce((s, r) => s + Number(r.credited_amount || 0), 0);

    res.json({
      success: true,
      referral_code,
      credit_limit: Number(credit_limit),
      stats: { total, credited, pending: total - credited, total_earned: totalEarned },
      referrals,
    });
  } catch (err) {
    console.error('[getMyReferrals]', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/admin/referrals  (admin)
const adminGetReferrals = async (req, res) => {
  try {
    const { page = 1, limit = 25, status = 'all', search = '' } = req.query;
    const offset = (page - 1) * limit;
    const isPartner = ['dsa_partner', 'bank_partner'].includes(req.admin.role);

    let where = '';
    const params = [];
    if (status !== 'all') { where += ' AND r.status = ?'; params.push(status); }
    if (search) {
      where += ' AND (referrer.full_name LIKE ? OR referrer.mobile LIKE ? OR referred.full_name LIKE ? OR referred.mobile LIKE ?)';
      const q = `%${search}%`;
      params.push(q, q, q, q);
    }
    if (isPartner) {
      where += ' AND referred.assigned_partner_id = ?';
      params.push(req.admin.id);
    }

    const [referrals] = await pool.query(
      `SELECT r.id, r.status, r.cashback_amount, r.credited_amount, r.note, r.created_at,
              referrer.id AS referrer_id, referrer.full_name AS referrer_name, referrer.mobile AS referrer_mobile,
              referrer.credit_limit AS referrer_credit_limit,
              referred.id AS referred_id, referred.full_name AS referred_name, referred.mobile AS referred_mobile,
              referred.is_kyc_verified AS referred_kyc
         FROM referrals r
         JOIN users referrer ON referrer.id = r.referrer_id
         JOIN users referred ON referred.id = r.referred_id
        WHERE 1=1 ${where}
        ORDER BY r.created_at DESC
        LIMIT ? OFFSET ?`,
      [...params, Number(limit), Number(offset)]
    );

    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) AS total FROM referrals r
         JOIN users referrer ON referrer.id = r.referrer_id
         JOIN users referred ON referred.id = r.referred_id
        WHERE 1=1 ${where}`,
      params
    );

    let statsQuery = `
      SELECT
         COUNT(*) AS total,
         SUM(r.status = 'pending')  AS pending,
         SUM(r.status = 'credited') AS credited,
         COALESCE(SUM(CASE WHEN r.status='credited' THEN r.credited_amount ELSE 0 END), 0) AS total_credited
       FROM referrals r
    `;
    const statsParams = [];
    if (isPartner) {
      statsQuery += ` JOIN users referred ON referred.id = r.referred_id WHERE referred.assigned_partner_id = ?`;
      statsParams.push(req.admin.id);
    }

    const [[stats]] = await pool.query(statsQuery, statsParams);

    res.json({ success: true, referrals, total, stats });
  } catch (err) {
    console.error('[adminGetReferrals]', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/admin/referrals/:id/credit  (admin)
const adminCreditReferral = async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const { id } = req.params;
    const { amount, note } = req.body;
    const creditAmount = parseFloat(amount);

    if (!creditAmount || creditAmount <= 0) {
      conn.release();
      return res.status(400).json({ success: false, message: 'Valid amount required' });
    }

    await conn.beginTransaction();

    const [ref] = await conn.query('SELECT * FROM referrals WHERE id = ? FOR UPDATE', [id]);
    if (!ref.length) {
      await conn.rollback(); conn.release();
      return res.status(404).json({ success: false, message: 'Referral not found' });
    }
    if (ref[0].status === 'credited') {
      await conn.rollback(); conn.release();
      return res.status(400).json({ success: false, message: 'Already credited' });
    }

    const referrerId = ref[0].referrer_id;

    // Increase credit limit
    await conn.query(
      'UPDATE users SET credit_limit = credit_limit + ? WHERE id = ?',
      [creditAmount, referrerId]
    );

    // Mark referral credited
    await conn.query(
      `UPDATE referrals SET status = 'credited', credited_amount = ?, note = ? WHERE id = ?`,
      [creditAmount, note || `Admin credited ₹${creditAmount}`, id]
    );

    // Notification to referrer
    const [[referrer]] = await conn.query('SELECT full_name, credit_limit FROM users WHERE id = ?', [referrerId]);
    await conn.query(
      'INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, ?)',
      [referrerId,
       '🎁 Referral Bonus Credited!',
       `Your credit limit has been increased by ₹${creditAmount} as a referral reward! New limit: ₹${referrer.credit_limit}.${note ? ' Note: ' + note : ''}`,
       'promo']
    );

    await conn.commit();
    conn.release();

    await invalidateUserCache(referrerId);

    res.json({ success: true, message: `Credit limit increased by ₹${creditAmount} for referrer`, credited_amount: creditAmount });
  } catch (err) {
    try { await conn.rollback(); } catch (_) {}
    conn.release();
    console.error('[adminCreditReferral]', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

module.exports = { getMyReferrals, adminGetReferrals, adminCreditReferral };
