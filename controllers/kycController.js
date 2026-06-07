const { pool } = require('../config/db');
const cloudinary = require('../config/cloudinary');
const { getCache, setCache, delCache, invalidateUserCache, CACHE_TTL } = require('../config/redis');
const { verifyPAN, formatDob } = require('../utils/panVerify');

// POST /api/kyc/upload
const uploadKYC = async (req, res) => {
  const fs = require('fs');
  const path = require('path');
  const logPath = path.join(__dirname, '../errors.log');
  
  try {
    const userId = req.user.id;
    const files = req.files;

    fs.appendFileSync(
      logPath,
      `[${new Date().toISOString()}] [uploadKYC] Called for user ${userId}. Files keys: ${Object.keys(files || {}).join(', ')}\n`
    );

    if (!files || Object.keys(files).length === 0) {
      fs.appendFileSync(logPath, `[${new Date().toISOString()}] [uploadKYC] No files uploaded. req.files is empty.\n`);
      return res.status(400).json({ success: false, message: 'No files uploaded' });
    }

    const getFileUrl = (fileArray) => {
      if (!fileArray || !fileArray[0]) return null;
      const file = fileArray[0];
      if (file.path && file.path.startsWith('http')) return file.path;
      return `/uploads/${file.filename}`;
    };

    const urls = {
      aadhaar_front: getFileUrl(files.aadhaar_front),
      aadhaar_back: getFileUrl(files.aadhaar_back),
      pan_card: getFileUrl(files.pan_card),
      selfie: getFileUrl(files.selfie),
    };

    fs.appendFileSync(
      logPath,
      `[${new Date().toISOString()}] [uploadKYC] Resolved urls: ${JSON.stringify(urls)}\n`
    );

    try {
      await pool.query(
        `INSERT INTO kyc_documents (user_id, aadhaar_front, aadhaar_back, pan_card, selfie, status)
         VALUES (?, ?, ?, ?, ?, 'pending')
         ON DUPLICATE KEY UPDATE
           aadhaar_front = COALESCE(VALUES(aadhaar_front), aadhaar_front),
           aadhaar_back  = COALESCE(VALUES(aadhaar_back), aadhaar_back),
           pan_card      = COALESCE(VALUES(pan_card), pan_card),
           selfie        = COALESCE(VALUES(selfie), selfie),
           status        = 'pending',
           updated_at    = NOW()`,
        [userId, urls.aadhaar_front || null, urls.aadhaar_back || null, urls.pan_card || null, urls.selfie || null]
      );
      fs.appendFileSync(logPath, `[${new Date().toISOString()}] [uploadKYC] Saved documents to DB successfully.\n`);
    } catch (dbErr) {
      fs.appendFileSync(logPath, `[${new Date().toISOString()}] [uploadKYC] Database insert failed: ${dbErr.message}\nStack: ${dbErr.stack}\n`);
      throw dbErr;
    }

    await pool.query(
      'INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, ?)',
      [userId, 'KYC Documents Submitted', 'Your KYC documents are under review. We will notify you within 24 hours.', 'kyc']
    );

    res.json({ success: true, message: 'KYC documents uploaded successfully', urls });
    // Invalidate KYC + user cache so fresh data loads
    await delCache(`user:${userId}:kyc`);
    await invalidateUserCache(userId);
    await delCache('admin:dashboard');
  } catch (err) {
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] [uploadKYC] Outer catch error: ${err.message}\nStack: ${err.stack}\n`);
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/kyc/status
const getKYCStatus = async (req, res) => {
  try {
    const cacheKey = `user:${req.user.id}:kyc`;
    const cached = await getCache(cacheKey);
    if (cached) return res.json(cached);

    const [rows] = await pool.query(
      `SELECT id, status, aadhaar_front, aadhaar_back, pan_card, selfie,
              pan_verified, aadhaar_verified, pan_verify_request_id,
              rejection_reason, reviewed_at, updated_at
       FROM kyc_documents WHERE user_id = ?`,
      [req.user.id]
    );

    const [userRows] = await pool.query(
      'SELECT pan_verified, aadhaar_verified FROM users WHERE id = ?',
      [req.user.id]
    );

    let response;
    if (!rows.length) {
      response = {
        success: true, status: 'not_submitted', kyc: null,
        pan_verified: !!(userRows[0]?.pan_verified),
        aadhaar_verified: !!(userRows[0]?.aadhaar_verified),
      };
    } else {
      response = {
        success: true,
        status: rows[0].status,
        kyc: rows[0],
        pan_verified: !!(rows[0].pan_verified || userRows[0]?.pan_verified),
        aadhaar_verified: !!(rows[0].aadhaar_verified || userRows[0]?.aadhaar_verified),
      };
    }
    await setCache(cacheKey, response, CACHE_TTL.MEDIUM);
    res.json(response);
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/kyc/auto-verify
const autoVerifyKYC = async (req, res) => {
  try {
    const userId = req.user.id;
    
    // Check if documents are uploaded
    const [kycRows] = await pool.query('SELECT * FROM kyc_documents WHERE user_id = ?', [userId]);
    if (!kycRows.length) {
      return res.status(400).json({ success: false, message: 'Please upload your KYC documents first.' });
    }
    
    const kyc = kycRows[0];
    
    // Check user profile details (need Aadhaar number, PAN number, full name, and date of birth to verify)
    const [userRows] = await pool.query('SELECT pan_number, aadhaar_number, full_name, date_of_birth FROM users WHERE id = ?', [userId]);
    if (!userRows.length) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    
    const { pan_number, aadhaar_number, full_name, date_of_birth } = userRows[0];
    
    if (!pan_number || !aadhaar_number) {
      return res.status(400).json({
        success: false,
        message: 'Please complete your PAN and Aadhaar number details in your profile first.'
      });
    }

    if (!date_of_birth) {
      return res.status(400).json({
        success: false,
        message: 'Please complete your Date of Birth in your profile first.'
      });
    }
    
    // Validation
    const panRegex = /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/;
    if (!panRegex.test(pan_number.toUpperCase())) {
      return res.status(400).json({ success: false, message: 'Invalid PAN card format in profile.' });
    }
    
    const aadhaarRegex = /^\d{12}$/;
    if (!aadhaarRegex.test(aadhaar_number)) {
      return res.status(400).json({ success: false, message: 'Invalid Aadhaar number format. Must be 12 digits.' });
    }
    
    if (!kyc.aadhaar_front || !kyc.aadhaar_back || !kyc.pan_card || !kyc.selfie) {
      return res.status(400).json({
        success: false,
        message: 'All 4 KYC documents (Aadhaar Front, Aadhaar Back, PAN Card, and Selfie) are required for auto-verification.'
      });
    }

    // Validate DOB
    const formattedDob = formatDob(date_of_birth);
    if (!formattedDob) {
      return res.status(400).json({ success: false, message: 'Invalid Date of Birth format in profile.' });
    }

    // Call PAN Verification API
    let panResult;
    try {
      panResult = await verifyPAN({
        pan:  pan_number,
        name: full_name,
        dob:  date_of_birth,
      });
    } catch (apiErr) {
      console.error('[autoVerifyKYC] PAN API error:', apiErr.message);
      return res.status(502).json({
        success: false,
        message: apiErr.message || 'PAN verification service temporarily unavailable. Please try again later.'
      });
    }

    if (!panResult.verified) {
      const rejectReason = panResult.message || 'PAN card could not be verified.';
      await pool.query(
        `UPDATE kyc_documents SET status = 'rejected', rejection_reason = ?, reviewed_at = NOW() WHERE user_id = ?`,
        [rejectReason, userId]
      );
      await pool.query('UPDATE users SET is_kyc_verified = 0 WHERE id = ?', [userId]);
      await pool.query(
        'INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, ?)',
        [userId, '❌ KYC Auto-Verification Failed', `Your PAN verification failed: ${rejectReason}. Please check your profile details and re-upload.`, 'kyc']
      );
      return res.json({
        success: false,
        status:  'rejected',
        message: `KYC Auto-Verification failed: ${rejectReason}`,
        detail: {
          nameMatch: panResult.nameMatch,
          dobMatch:  panResult.dobMatch,
          requestId: panResult.requestId,
        }
      });
    }
    
    // ── Successful Auto-Verification ──────────────────────────
    // Check if Aadhaar was also verified via OTP
    const [aadhaarRows] = await pool.query(
      'SELECT id FROM aadhaar_kyc WHERE user_id = ?', [userId]
    );
    const aadhaarVerified = aadhaarRows.length > 0 ? 1 : 0;

    await pool.query(
      `UPDATE kyc_documents
         SET status = 'approved', rejection_reason = NULL,
             pan_verified = 1, aadhaar_verified = ?,
             pan_verify_request_id = ?,
             reviewed_at = NOW()
       WHERE user_id = ?`,
      [aadhaarVerified, panResult.requestId, userId]
    );

    await pool.query(
      'UPDATE users SET is_kyc_verified = 1, pan_verified = 1, aadhaar_verified = ? WHERE id = ?',
      [aadhaarVerified, userId]
    );

    await pool.query(
      'INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, ?)',
      [userId, '✅ KYC Auto-Verified Successfully!',
       `Congratulations! Your PAN has been verified${aadhaarVerified ? ' and Aadhaar OTP confirmed' : ''}. You are now eligible to apply for instant credit.`,
       'kyc']
    );

    res.json({
      success: true,
      status:  'approved',
      message: 'KYC auto-verified successfully.',
      detail: {
        panVerified:     true,
        aadhaarVerified: !!aadhaarVerified,
        requestId:       panResult.requestId,
      }
    });
    // Invalidate caches
    await delCache(`user:${userId}:kyc`);
    await invalidateUserCache(userId);
    await delCache('admin:dashboard');
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/kyc/pan-verify  (standalone, one-shot PAN check)
const panVerifyEndpoint = async (req, res) => {
  try {
    const userId = req.user.id;

    let { pan, name, dob } = req.body;

    if (!pan || !name || !dob) {
      const [rows] = await pool.query(
        'SELECT pan_number, full_name, date_of_birth FROM users WHERE id = ?',
        [userId]
      );
      if (!rows.length) return res.status(404).json({ success: false, message: 'User not found.' });
      pan  = pan  || rows[0].pan_number;
      name = name || rows[0].full_name;
      dob  = dob  || rows[0].date_of_birth;
    }

    if (!pan || !name || !dob) {
      return res.status(400).json({
        success: false,
        message: 'pan, name, and dob are required (or fill your profile first).'
      });
    }

    const result = await verifyPAN({ pan, name, dob });

    // ── Persist result to DB ──────────────────────────────────
    if (result.verified) {
      // Mark pan_verified on users
      await pool.query(
        'UPDATE users SET pan_verified = 1, pan_number = COALESCE(pan_number, ?), updated_at = NOW() WHERE id = ?',
        [pan.trim().toUpperCase(), userId]
      );

      // Ensure kyc_documents row exists and mark pan_verified
      await pool.query(
        `INSERT INTO kyc_documents (user_id, pan_verified, pan_verify_request_id, status)
         VALUES (?, 1, ?, 'pending')
         ON DUPLICATE KEY UPDATE
           pan_verified = 1,
           pan_verify_request_id = VALUES(pan_verify_request_id),
           updated_at = NOW()`,
        [userId, result.requestId]
      );

      // Invalidate cache
      await delCache(`user:${userId}:kyc`);
      await invalidateUserCache(userId);
    }

    return res.json({
      success:   result.success,
      verified:  result.verified,
      status:    result.status,
      category:  result.category,
      nameMatch: result.nameMatch,
      dobMatch:  result.dobMatch,
      aadhaarSeedingStatus: result.aadhaarSeedingStatus,
      requestId: result.requestId,
      message:   result.message,
      errorCode: result.errorCode,
    });
  } catch (err) {
    console.error('[panVerifyEndpoint]', err.message);
    return res.status(502).json({ success: false, message: err.message });
  }
};

module.exports = { uploadKYC, getKYCStatus, autoVerifyKYC, panVerifyEndpoint };
