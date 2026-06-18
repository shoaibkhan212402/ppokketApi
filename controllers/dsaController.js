const { pool } = require('../config/db');

// GET /api/dsa/dashboard
const getDsaDashboard = async (req, res) => {
  try {
    const userId = req.user.id;
    if (!req.user.is_dsa_partner) {
      return res.status(403).json({ success: false, message: 'Access denied: Not a DSA Partner' });
    }

    // Sourced leads list: users referred by this DSA partner
    const [leads] = await pool.query(
      `SELECT u.id, u.full_name, u.mobile, u.created_at, u.is_kyc_verified,
              kd.status AS kyc_doc_status,
              (SELECT status FROM loans WHERE user_id = u.id ORDER BY created_at DESC LIMIT 1) AS active_loan_status
         FROM users u
         LEFT JOIN kyc_documents kd ON kd.user_id = u.id
        WHERE u.referred_by = ?
        ORDER BY u.created_at DESC`,
      [userId]
    );

    // Calculate Stats
    const totalLeads = leads.length;
    const pendingKyc = leads.filter(l => !l.is_kyc_verified && (l.kyc_doc_status === 'pending' || l.kyc_doc_status === 'under_review')).length;
    const activeLoansCount = leads.filter(l => ['approved', 'disbursed'].includes(l.active_loan_status)).length;
    const verifiedKyc = leads.filter(l => l.is_kyc_verified || l.kyc_doc_status === 'approved').length;

    // Total Commission Earned
    const [referralSum] = await pool.query(
      `SELECT COALESCE(SUM(credited_amount), 0) AS total_earned
         FROM referrals
        WHERE referrer_id = ? AND status = 'credited'`,
      [userId]
    );
    const totalCommissionEarned = parseFloat(referralSum[0]?.total_earned || 0);

    const sourcedLeads = leads.map(l => {
      let kyc_status = 'not_submitted';
      if (l.is_kyc_verified) {
        kyc_status = 'approved';
      } else if (l.kyc_doc_status) {
        kyc_status = l.kyc_doc_status;
      }
      return {
        id: l.id,
        full_name: l.full_name,
        mobile: l.mobile,
        created_at: l.created_at,
        kyc_status,
        loan_status: l.active_loan_status || 'no_loans'
      };
    });

    res.json({
      success: true,
      stats: {
        total_leads: totalLeads,
        pending_kyc: pendingKyc,
        verified_kyc: verifiedKyc,
        active_loans: activeLoansCount,
        total_earned: totalCommissionEarned
      },
      referral_code: req.user.referral_code,
      leads: sourcedLeads
    });
  } catch (err) {
    console.error('[getDsaDashboard]', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/dsa/leads
const createDsaLead = async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const userId = req.user.id;
    if (!req.user.is_dsa_partner) {
      conn.release();
      return res.status(403).json({ success: false, message: 'Access denied: Not a DSA Partner' });
    }

    const { full_name, mobile } = req.body;
    if (!full_name || !mobile || !/^\d{10}$/.test(mobile)) {
      conn.release();
      return res.status(400).json({ success: false, message: 'Please provide a valid name and 10-digit mobile number' });
    }

    await conn.beginTransaction();

    // Check if user already exists
    const [existing] = await conn.query('SELECT id FROM users WHERE mobile = ?', [mobile]);
    if (existing.length) {
      await conn.rollback();
      conn.release();
      return res.status(400).json({ success: false, message: 'Lead / user with this mobile number already exists' });
    }

    const newReferralCode = `PPK${mobile.slice(-6)}`;

    // Create user as a lead under this DSA partner
    const [result] = await conn.query(
      'INSERT INTO users (mobile, full_name, referral_code, referred_by, credit_limit, wallet_balance) VALUES (?, ?, ?, ?, ?, ?)',
      [mobile, full_name, newReferralCode, userId, 0, 0]
    );
    const newUserId = result.insertId;

    // Create referral record
    await conn.query(
      'INSERT IGNORE INTO referrals (referrer_id, referred_id) VALUES (?, ?)',
      [userId, newUserId]
    );

    // Welcome notification for lead
    await conn.query(
      'INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, ?)',
      [newUserId, 'Welcome to Ppokket! 🎉', 'Your profile has been created by your DSA Partner. Please complete KYC to unlock your credit limit.', 'system']
    );

    // Notification for DSA Partner
    await conn.query(
      'INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, ?)',
      [userId, '👥 Lead Registered!', `Lead ${full_name} (${mobile}) has been successfully registered. You will earn a bonus when they complete KYC.`, 'promo']
    );

    await conn.commit();
    conn.release();

    res.status(201).json({
      success: true,
      message: 'Lead registered successfully',
      lead: {
        id: newUserId,
        full_name,
        mobile,
        kyc_status: 'not_submitted',
        loan_status: 'no_loans'
      }
    });
  } catch (err) {
    try { await conn.rollback(); } catch (_) {}
    conn.release();
    console.error('[createDsaLead]', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

module.exports = { getDsaDashboard, createDsaLead };
