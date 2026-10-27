const { pool } = require('../config/db');
const { getCache, setCache, delCache, invalidateUserCache, CACHE_TTL } = require('../config/redis');
const { aadhaarSendOTP, aadhaarVerifyOTP } = require('../utils/aadhaarVerify');
const {
  isAadhaarOtpOn, aadhaarOtpOnOrDefault, setAadhaarOtpOn,
  saveAadhaarWithoutOtp, clearWithoutOtp, isWithoutOtp, countWithoutOtp,
} = require('../utils/aadhaarMode');
const { notArchivedSql } = require('../utils/archive');
const { auditLog } = require('../utils/audit');

// ─────────────────────────────────────────────────────────────
// POST /api/aadhaar/save-number
// Body: { aadhaar_number }
// The Aadhaar step without OTP — only while the super admin has
// switched the OTP off (utils/aadhaarMode.js).
// ─────────────────────────────────────────────────────────────
const saveNumber = async (req, res) => {
  try {
    if (await isAadhaarOtpOn()) {
      return res.status(409).json({
        success: false,
        otp_required: true,
        message: 'Please verify your Aadhaar with the OTP sent to your Aadhaar-linked mobile number.',
      });
    }
    const saved = await saveAadhaarWithoutOtp(req.user.id, req.body?.aadhaar_number);
    if (!saved.ok) return res.status(saved.status).json({ success: false, message: saved.message });
    return res.json({ success: true, aadhaar_saved: true, message: 'Aadhaar number saved. Please continue with the next step.' });
  } catch (err) {
    console.error('[saveNumber]', err.message);
    return res.status(500).json({ success: false, message: 'Could not save your Aadhaar number. Please try again.' });
  }
};

// ─────────────────────────────────────────────────────────────
// POST /api/aadhaar/send-otp
// Body: { aadhaar_number? }  – falls back to profile if omitted
// ─────────────────────────────────────────────────────────────
const sendOTP = async (req, res) => {
  try {
    const userId = req.user.id;
    let { aadhaar_number } = req.body;

    // Fall back to stored Aadhaar if not provided
    if (!aadhaar_number) {
      const [rows] = await pool.query('SELECT aadhaar_number FROM users WHERE id = ?', [userId]);
      if (!rows.length) return res.status(404).json({ success: false, message: 'User not found.' });
      aadhaar_number = rows[0].aadhaar_number;
    }

    if (!aadhaar_number) {
      return res.status(400).json({
        success: false,
        message: 'Aadhaar number is required. Please add it to your profile first.',
      });
    }

    // OTP switched off by the super admin: the number alone completes the step.
    // Reached by app versions from before the switch (they only know "send
    // OTP"), and by a page opened before it was switched. Such an app shows
    // any reply other than "OTP sent" as an error, so this one is worded as
    // what happened and what to do; newer clients read `aadhaar_saved`.
    if (!(await isAadhaarOtpOn())) {
      const saved = await saveAadhaarWithoutOtp(userId, aadhaar_number);
      if (!saved.ok) return res.status(saved.status).json({ success: false, message: saved.message });
      return res.json({
        success: false,
        aadhaar_saved: true,
        message: 'Your Aadhaar number is saved. No OTP is needed right now — please go back and open KYC again to continue.',
      });
    }

    let result;
    try {
      result = await aadhaarSendOTP(aadhaar_number);
    } catch (apiErr) {
      return res.status(502).json({ success: false, message: apiErr.message });
    }

    if (!result.success) {
      return res.status(400).json({
        success: false,
        message: result.message,
        errorCode: result.errorCode,
      });
    }

    const cleanAadhaar = String(aadhaar_number).replace(/\s+/g, '');

    // Store Aadhaar number + reference_id so verify/auto-verify can use them
    await pool.query(
      `UPDATE users SET aadhaar_number = ?, aadhaar_ref_id = ?, updated_at = NOW() WHERE id = ?`,
      [cleanAadhaar, result.referenceId, userId]
    );

    await invalidateUserCache(userId);

    return res.json({
      success: true,
      referenceId: result.referenceId,
      maskedAadhaar: result.maskedAadhaar,
      requestId: result.requestId,
      message: 'OTP sent to your Aadhaar-linked mobile number.',
    });
  } catch (err) {
    console.error('[sendOTP]', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ─────────────────────────────────────────────────────────────
// POST /api/aadhaar/verify-otp
// Body: { otp, reference_id? }
// ─────────────────────────────────────────────────────────────
const verifyOTP = async (req, res) => {
  try {
    const userId = req.user.id;
    let { otp, reference_id } = req.body;

    if (!otp) {
      return res.status(400).json({ success: false, message: 'OTP is required.' });
    }

    // Fall back to stored reference_id if not provided
    if (!reference_id) {
      const [rows] = await pool.query('SELECT aadhaar_ref_id FROM users WHERE id = ?', [userId]);
      reference_id = rows[0]?.aadhaar_ref_id || null;
    }

    if (!reference_id) {
      return res.status(400).json({
        success: false,
        message: 'reference_id not found. Please request an OTP first.',
      });
    }

    let result;
    try {
      result = await aadhaarVerifyOTP(reference_id, otp);
    } catch (apiErr) {
      return res.status(502).json({ success: false, message: apiErr.message });
    }

    if (!result.success || !result.verified) {
      return res.status(400).json({
        success: false,
        verified: false,
        message: result.message || 'Aadhaar OTP verification failed.',
        errorCode: result.errorCode,
      });
    }

    // ── Mark aadhaar_verified on users ─────────────────────────
    await pool.query(
      `UPDATE users SET
         aadhaar_verified = 1,
         full_name        = COALESCE(NULLIF(full_name, ''), ?),
         date_of_birth    = COALESCE(date_of_birth, STR_TO_DATE(?, '%d-%m-%Y')),
         aadhaar_ref_id   = NULL,
         updated_at       = NOW()
       WHERE id = ?`,
      [result.name, result.dob, userId]
    );

    // ── Update kyc_documents: mark aadhaar_verified only ────────
    // NOTE: status stays 'pending' – only admin can approve KYC
    await pool.query(
      `INSERT INTO kyc_documents (user_id, aadhaar_verified, status)
       VALUES (?, 1, 'pending')
       ON DUPLICATE KEY UPDATE
         aadhaar_verified = 1,
         updated_at = NOW()`,
      [userId]
    );

    // Mark aadhaar_verified on the users row (personal field only)
    // is_kyc_verified stays 0 until admin approves
    await pool.query(
      'UPDATE users SET aadhaar_verified = 1 WHERE id = ?', [userId]
    );
    // Verified by OTP now, so no longer "number only"
    await clearWithoutOtp(userId);

    // Save Aadhaar KYC record (address, photo, etc.)
    await pool.query(
      `INSERT INTO aadhaar_kyc
         (user_id, name, dob, gender, care_of, full_address, address_json, has_photo, photo_base64, request_id)
       VALUES (?, ?, STR_TO_DATE(?, '%d-%m-%Y'), ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         name          = VALUES(name),
         dob           = VALUES(dob),
         gender        = VALUES(gender),
         care_of       = VALUES(care_of),
         full_address  = VALUES(full_address),
         address_json  = VALUES(address_json),
         has_photo     = VALUES(has_photo),
         photo_base64  = VALUES(photo_base64),
         request_id    = VALUES(request_id),
         updated_at    = NOW()`,
      [
        userId,
        result.name,
        result.dob,
        result.gender,
        result.careOf,
        result.fullAddress,
        result.address ? JSON.stringify(result.address) : null,
        result.hasPhoto ? 1 : 0,
        result.photo || null,
        result.requestId,
      ]
    );

    // Notify – always 'pending admin review'
    const notifMsg = 'Your Aadhaar has been verified. Please complete the remaining KYC steps.';
    await pool.query(
      'INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, ?)',
      [userId, '✅ Aadhaar Verified!', notifMsg, 'kyc']
    );

    // Invalidate user cache
    await invalidateUserCache(userId);
    await delCache(`user:${userId}:kyc`);

    return res.json({
      success: true,
      verified: true,
      fullyVerified: false,  // admin must approve – never auto-fully-verified
      message: 'Aadhaar verified successfully. Please complete remaining KYC steps.',
      data: {
        name: result.name,
        dob: result.dob,
        gender: result.gender,
        careOf: result.careOf,
        fullAddress: result.fullAddress,
        address: result.address,
        hasPhoto: result.hasPhoto,
      },
    });
  } catch (err) {
    console.error('[verifyOTP]', err.message);
    // Handle missing aadhaar_kyc table gracefully on first run
    if (err.message?.includes("aadhaar_kyc")) {
      return res.status(500).json({
        success: false,
        message: 'Aadhaar KYC table not found. Please run migrations.',
      });
    }
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ─────────────────────────────────────────────────────────────
// GET /api/aadhaar/status
// Returns saved Aadhaar KYC data (without photo) for the user
// ─────────────────────────────────────────────────────────────
const getAadhaarStatus = async (req, res) => {
  try {
    const userId = req.user.id;
    const [rows] = await pool.query(
      'SELECT name, dob, gender, care_of, full_address, address_json, has_photo, request_id, created_at, updated_at FROM aadhaar_kyc WHERE user_id = ?',
      [userId]
    );

    if (!rows.length) {
      return res.json({
        success: true, verified: false, data: null,
        otp_enabled: await aadhaarOtpOnOrDefault(),
        without_otp: await isWithoutOtp(userId),
      });
    }

    const row = rows[0];
    let address = null;
    try { address = row.address_json ? JSON.parse(row.address_json) : null; } catch (_) { }

    return res.json({
      success: true,
      verified: true,
      data: {
        name: row.name,
        dob: row.dob,
        gender: row.gender,
        careOf: row.care_of,
        fullAddress: row.full_address,
        address,
        hasPhoto: !!row.has_photo,
        requestId: row.request_id,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      },
    });
  } catch (err) {
    console.error('[getAadhaarStatus]', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ─────────────────────────────────────────────────────────────
// Admin → Settings → KYC (super admin)
// GET /api/admin/aadhaar-otp          → { enabled, without_otp_count, waiting_count }
// PUT /api/admin/aadhaar-otp { enabled: true|false }
// ─────────────────────────────────────────────────────────────
const aadhaarOtpConfig = async () => {
  const [[waiting]] = await pool.query(
    `SELECT COUNT(*) AS n FROM users u
      WHERE u.pan_verified = 1 AND COALESCE(u.aadhaar_verified, 0) = 0${await notArchivedSql('u')}`
  );
  return {
    enabled: await isAadhaarOtpOn(),
    without_otp_count: await countWithoutOtp(),
    // Customers who finished PAN and stopped at the Aadhaar step
    waiting_count: Number(waiting.n),
  };
};

const getAadhaarOtpSetting = async (req, res) => {
  try {
    res.json({ success: true, ...(await aadhaarOtpConfig()) });
  } catch (err) {
    console.error('[getAadhaarOtpSetting]', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};

const setAadhaarOtpSetting = async (req, res) => {
  try {
    const { enabled } = req.body || {};
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ success: false, message: 'Say whether Aadhaar OTP should be on or off.' });
    }
    await setAadhaarOtpOn(enabled);
    await auditLog({ req, action: 'aadhaar_otp_switched', entityType: 'setting', details: { aadhaar_otp_enabled: enabled } });
    res.json({
      success: true,
      message: enabled
        ? 'Aadhaar OTP is on. New customers verify their Aadhaar with an OTP.'
        : 'Aadhaar OTP is off. New customers only enter their Aadhaar number.',
      ...(await aadhaarOtpConfig()),
    });
  } catch (err) {
    console.error('[setAadhaarOtpSetting]', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};

module.exports = { sendOTP, verifyOTP, saveNumber, getAadhaarStatus, getAadhaarOtpSetting, setAadhaarOtpSetting };
