const { pool } = require('../config/db');
const { getCache, setCache, delCache, invalidateUserCache, CACHE_TTL } = require('../config/redis');
const { aadhaarSendOTP, aadhaarVerifyOTP } = require('../utils/aadhaarVerify');

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

    let result;
    try {
      result = await aadhaarSendOTP(aadhaar_number);
    } catch (apiErr) {
      return res.status(502).json({ success: false, message: apiErr.message });
    }

    if (!result.success) {
      return res.status(400).json({
        success:   false,
        message:   result.message,
        errorCode: result.errorCode,
      });
    }

    const cleanAadhaar = String(aadhaar_number).replace(/\s+/g, '');

    // Store Aadhaar number + reference_id so verify/auto-verify can use them
    await pool.query(
      `UPDATE users SET aadhaar_number = ?, aadhaar_ref_id = ?, updated_at = NOW() WHERE id = ?`,
      [cleanAadhaar, result.referenceId, userId]
    );

    return res.json({
      success:       true,
      referenceId:   result.referenceId,
      maskedAadhaar: result.maskedAadhaar,
      requestId:     result.requestId,
      message:       'OTP sent to your Aadhaar-linked mobile number.',
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
        success:   false,
        verified:  false,
        message:   result.message || 'Aadhaar OTP verification failed.',
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

    // ── Update kyc_documents: aadhaar_verified flag ─────────────
    // Also auto-approve KYC fully if PAN is already verified
    await pool.query(
      `INSERT INTO kyc_documents (user_id, aadhaar_verified, status)
       VALUES (?, 1, 'pending')
       ON DUPLICATE KEY UPDATE
         aadhaar_verified = 1,
         status = IF(pan_verified = 1, 'approved', status),
         reviewed_at = IF(pan_verified = 1, NOW(), reviewed_at),
         updated_at = NOW()`,
      [userId]
    );

    // Check if KYC is now fully approved (both PAN + Aadhaar)
    const [kycRows] = await pool.query(
      'SELECT status, pan_verified FROM kyc_documents WHERE user_id = ?', [userId]
    );
    const bothVerified = kycRows[0]?.pan_verified === 1;
    if (bothVerified) {
      await pool.query(
        'UPDATE users SET is_kyc_verified = 1, aadhaar_verified = 1 WHERE id = ?', [userId]
      );
    }

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

    // Notify
    const notifMsg = bothVerified
      ? '🎉 Full KYC Complete! Your PAN and Aadhaar have both been verified. You are now eligible for instant credit.'
      : 'Your Aadhaar has been verified and KYC data has been saved to your profile.';
    await pool.query(
      'INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, ?)',
      [userId, bothVerified ? '✅ KYC Fully Verified!' : '✅ Aadhaar Verified!', notifMsg, 'kyc']
    );

    // Invalidate user cache
    await invalidateUserCache(userId);
    await delCache(`user:${userId}:kyc`);

    return res.json({
      success:       true,
      verified:      true,
      fullyVerified: bothVerified,   // true when both PAN + Aadhaar done
      message:  bothVerified
        ? 'Aadhaar verified. KYC is now fully complete!'
        : 'Aadhaar verified successfully.',
      data: {
        name:        result.name,
        dob:         result.dob,
        gender:      result.gender,
        careOf:      result.careOf,
        fullAddress: result.fullAddress,
        address:     result.address,
        hasPhoto:    result.hasPhoto,
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
      return res.json({ success: true, verified: false, data: null });
    }

    const row = rows[0];
    let address = null;
    try { address = row.address_json ? JSON.parse(row.address_json) : null; } catch (_) {}

    return res.json({
      success:  true,
      verified: true,
      data: {
        name:        row.name,
        dob:         row.dob,
        gender:      row.gender,
        careOf:      row.care_of,
        fullAddress: row.full_address,
        address,
        hasPhoto:    !!row.has_photo,
        requestId:   row.request_id,
        createdAt:   row.created_at,
        updatedAt:   row.updated_at,
      },
    });
  } catch (err) {
    console.error('[getAadhaarStatus]', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
};

module.exports = { sendOTP, verifyOTP, getAadhaarStatus };
