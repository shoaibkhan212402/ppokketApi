const { pool } = require('../config/db');
const { getCache, setCache, delCache, invalidateUserCache, CACHE_TTL } = require('../config/redis');
const { verifyPAN } = require('../utils/panVerify');

// POST /api/kyc/upload
const uploadKYC = async (req, res) => {
  const fs = require('fs');
  const path = require('path');
  const logPath = path.join(__dirname, '../errors.log');

  const writeLog = (msg) => {
    console.log(msg);
    if (process.env.NODE_ENV !== 'production') {
      try {
        fs.appendFileSync(logPath, msg + '\n');
      } catch (_) {}
    }
  };

  try {
    const userId = req.user.id;
    const files = req.files;

    writeLog(`[${new Date().toISOString()}] [uploadKYC] Called for user ${userId}. Content-Type: ${req.headers['content-type'] || 'unknown'}. Body keys: ${Object.keys(req.body || {}).join(', ')}. Files keys: ${Object.keys(files || {}).join(', ')}`);

    // Log detailed file info for diagnostics
    try {
      for (const field of Object.keys(files || {})) {
        for (const f of files[field]) {
          writeLog(`[${new Date().toISOString()}] [uploadKYC] File - field: ${field}, originalname: ${f.originalname || ''}, filename: ${f.filename || ''}, mimetype: ${f.mimetype || ''}, size: ${f.size || 0}, path: ${f.path || ''}`);
        }
      }
    } catch (logErr) {
      writeLog(`[${new Date().toISOString()}] [uploadKYC] File logging failed: ${logErr.message}`);
    }

    // Basic server-side validation: mimetype and size
    const allowedMimes = [
      'image/jpeg', 'image/png', 'image/jpg', 'application/pdf',
      'image/heic', 'image/heif', 'image/webp',
      'application/octet-stream',
    ];
    const MAX_BYTES = 10 * 1024 * 1024; // 10MB
    const errors = [];
    if (files && Object.keys(files).length > 0) {
      for (const field of Object.keys(files)) {
        const arr = files[field] || [];
        for (const f of arr) {
          const mime = f.mimetype || '';
          if (mime && !allowedMimes.includes(mime) && !mime.startsWith('image/')) {
            errors.push(`${field}: invalid file type ${mime}`);
          }
          if (f.size && f.size > MAX_BYTES) {
            errors.push(`${field}: file too large (${Math.round(f.size / 1024)} KB)`);
          }
        }
      }
    }
    if (errors.length) {
      // Cleanup any locally saved files
      try {
        for (const field of Object.keys(files || {})) {
          for (const f of files[field]) {
            if (f.path && f.path.startsWith(require('path').join(__dirname, '..', 'uploads')) && fs.existsSync(f.path)) {
              fs.unlinkSync(f.path);
            }
          }
        }
      } catch (cleanupErr) {
        writeLog(`[${new Date().toISOString()}] [uploadKYC] Cleanup failed: ${cleanupErr.message}`);
      }
      writeLog(`[${new Date().toISOString()}] [uploadKYC] Validation errors: ${errors.join('; ')}`);
      return res.status(400).json({ success: false, message: 'Invalid uploads', errors });
    }

    if (!files || Object.keys(files).length === 0) {
      writeLog(`[${new Date().toISOString()}] [uploadKYC] No files uploaded. req.files is empty.`);
      return res.status(400).json({ success: false, message: 'No files uploaded' });
    }

    const getFileUrl = (fileArray) => {
      if (!fileArray || !fileArray[0]) return null;
      const file = fileArray[0];

      // multer-storage-cloudinary sets file.path to the full https:// Cloudinary URL
      if (file.path && /^https?:\/\//i.test(file.path)) return file.path;

      // multer-storage-cloudinary also sets file.secure_url (preferred)
      if (file.secure_url) return file.secure_url;

      // Fallback: local disk storage — build absolute URL from request host
      try {
        const host = req.protocol + '://' + req.get('host');
        if (file.filename) return `${host}/uploads/${file.filename}`;
        if (file.path) return file.path.startsWith('/') ? `${host}${file.path}` : `${host}/${file.path}`;
      } catch (_) {
        if (file.filename) return `/uploads/${file.filename}`;
        if (file.path) return file.path;
      }

      return null;
    };

    const urls = {
      aadhaar_front: getFileUrl(files.aadhaar_front),
      aadhaar_back: getFileUrl(files.aadhaar_back),
      pan_card: getFileUrl(files.pan_card),
      selfie: getFileUrl(files.selfie),
      bank_passbook: getFileUrl(files.bank_passbook),
    };

    writeLog(`[${new Date().toISOString()}] [uploadKYC] Resolved urls: ${JSON.stringify(urls)}`);

    try {
      await pool.query(
        `INSERT INTO kyc_documents (user_id, aadhaar_front, aadhaar_back, pan_card, selfie, bank_passbook, status)
         VALUES (?, ?, ?, ?, ?, ?, 'pending')
         ON DUPLICATE KEY UPDATE
           aadhaar_front = COALESCE(VALUES(aadhaar_front), aadhaar_front),
           aadhaar_back  = COALESCE(VALUES(aadhaar_back), aadhaar_back),
           pan_card      = COALESCE(VALUES(pan_card), pan_card),
           selfie        = COALESCE(VALUES(selfie), selfie),
           bank_passbook = COALESCE(VALUES(bank_passbook), bank_passbook),
           status        = IF(status = 'approved', 'approved', 'pending'),
           updated_at    = NOW()`,
        [userId, urls.aadhaar_front || null, urls.aadhaar_back || null, urls.pan_card || null, urls.selfie || null, urls.bank_passbook || null]
      );
      writeLog(`[${new Date().toISOString()}] [uploadKYC] Saved documents to DB successfully.`);
    } catch (dbErr) {
      writeLog(`[${new Date().toISOString()}] [uploadKYC] Database insert failed: ${dbErr.message}\nStack: ${dbErr.stack}`);
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
    console.error('[uploadKYC]', err);
    writeLog(`[${new Date().toISOString()}] [uploadKYC] Outer catch error: ${err.message}\nStack: ${err.stack}`);
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
      `SELECT id, status, aadhaar_front, aadhaar_back, pan_card, selfie, bank_passbook,
              pan_verified, aadhaar_verified, pan_verify_request_id,
              rejection_reason, reviewed_at, updated_at
       FROM kyc_documents WHERE user_id = ?`,
      [req.user.id]
    );

    const [userRows] = await pool.query(
      'SELECT pan_verified, aadhaar_verified, is_kyc_verified FROM users WHERE id = ?',
      [req.user.id]
    );
    const [bankRows] = await pool.query(
      'SELECT is_verified FROM bank_details WHERE user_id = ?',
      [req.user.id]
    );

    let response;
    if (!rows.length) {
      response = {
        success: true, status: 'not_submitted', kyc: null,
        pan_verified: !!(userRows[0]?.pan_verified),
        aadhaar_verified: !!(userRows[0]?.aadhaar_verified),
        bank_verified: !!(bankRows[0]?.is_verified),
        is_kyc_verified: !!(userRows[0]?.is_kyc_verified),
      };
    } else {
      response = {
        success: true,
        status: rows[0].status,
        kyc: { ...rows[0], bank_verified: !!(bankRows[0]?.is_verified) },
        pan_verified: !!(rows[0].pan_verified || userRows[0]?.pan_verified),
        aadhaar_verified: !!(rows[0].aadhaar_verified || userRows[0]?.aadhaar_verified),
        bank_verified: !!(bankRows[0]?.is_verified),
        is_kyc_verified: !!(userRows[0]?.is_kyc_verified),
      };
    }
    await setCache(cacheKey, response, CACHE_TTL.MEDIUM);
    res.json(response);
  } catch (err) {
    console.error('[getKYCStatus]', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/kyc/auto-verify  (submit KYC for admin review — no auto-approval)
const autoVerifyKYC = async (req, res) => {
  try {
    const userId = req.user.id;

    // Already approved — nothing to do
    const [kycRows] = await pool.query('SELECT * FROM kyc_documents WHERE user_id = ?', [userId]);
    if (kycRows.length && kycRows[0].status === 'approved') {
      return res.json({ success: true, status: 'approved', message: 'Your KYC is already approved.' });
    }

    if (!kycRows.length) {
      return res.status(400).json({ success: false, message: 'Please upload your KYC documents first.' });
    }

    const kyc = kycRows[0];

    // Validate all required documents are uploaded
    if (!kyc.aadhaar_front || !kyc.aadhaar_back || !kyc.selfie || !kyc.bank_passbook) {
      return res.status(400).json({
        success: false,
        message: 'All KYC documents (Aadhaar Front, Aadhaar Back, Selfie, Bank Passbook) are required.',
      });
    }

    // Validate digital verifications are complete
    const [userRows] = await pool.query(
      'SELECT pan_verified, aadhaar_verified FROM users WHERE id = ?',
      [userId]
    );
    if (!userRows.length) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    const { pan_verified, aadhaar_verified } = userRows[0];

    if (!pan_verified) {
      return res.status(400).json({ success: false, message: 'Please complete PAN verification first.' });
    }
    if (!aadhaar_verified) {
      return res.status(400).json({ success: false, message: 'Please complete Aadhaar OTP verification first.' });
    }

    const [bankRows] = await pool.query('SELECT is_verified FROM bank_details WHERE user_id = ?', [userId]);
    if (!bankRows[0]?.is_verified) {
      return res.status(400).json({ success: false, message: 'Please verify your bank account before submitting.' });
    }

    // Mark as pending for admin review (reset any prior rejection)
    await pool.query(
      `UPDATE kyc_documents
         SET status = 'pending', rejection_reason = NULL, reviewed_at = NULL, updated_at = NOW()
       WHERE user_id = ?`,
      [userId]
    );

    await pool.query(
      'INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, ?)',
      [userId,
        '📋 KYC Submitted for Review',
        'Your KYC documents have been submitted and are under review by our team. This process takes 24–48 working hours. We will notify you once verified.',
        'kyc']
    );

    await delCache(`user:${userId}:kyc`);
    await invalidateUserCache(userId);
    await delCache('admin:dashboard');

    res.json({
      success: true,
      status: 'pending',
      message: 'KYC submitted successfully. Our team will verify your documents within 24–48 working hours.',
    });
  } catch (err) {
    console.error('[autoVerifyKYC]', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/kyc/pan-verify  (standalone, one-shot PAN check)
const panVerifyEndpoint = async (req, res) => {
  try {
    const userId = req.user.id;

    let { pan } = req.body;

    if (!pan) {
      const [rows] = await pool.query(
        'SELECT pan_number FROM users WHERE id = ?',
        [userId]
      );
      if (!rows.length) return res.status(404).json({ success: false, message: 'User not found.' });
      pan = rows[0].pan_number;
    }

    if (!pan) {
      return res.status(400).json({
        success: false,
        message: 'pan is required (or save your PAN in your profile first).'
      });
    }

    const result = await verifyPAN({ pan });

    if (result.verified) {
      // Mark pan_verified and update profile with data returned by API
      await pool.query(
        `UPDATE users SET
          pan_verified = 1,
          pan_number = ?,
          full_name = COALESCE(NULLIF(?, ''), full_name),
          date_of_birth = COALESCE(date_of_birth, ?),
          updated_at = NOW()
         WHERE id = ?`,
        [
          result.panNumber,
          result.fullName || '',
          result.dobMySQL || null,
          userId,
        ]
      );

      // Ensure kyc_documents row exists and mark pan_verified
      await pool.query(
        `INSERT INTO kyc_documents (user_id, pan_verified, pan_verify_request_id, status)
         VALUES (?, 1, ?, 'pending')
         ON DUPLICATE KEY UPDATE
           pan_verified = 1,
           pan_verify_request_id = VALUES(pan_verify_request_id),
           updated_at = NOW()`,
        [userId, String(result.requestId || '')]
      );

      await delCache(`user:${userId}:kyc`);
      await invalidateUserCache(userId);
    }

    return res.json({
      success: result.success,
      verified: result.verified,
      panNumber: result.panNumber,
      fullName: result.fullName,
      category: result.category,
      dob: result.dob,
      gender: result.gender,
      address: result.address,
      requestId: result.requestId,
      message: result.message,
    });
  } catch (err) {
    console.error('[panVerifyEndpoint]', err.message);
    return res.status(502).json({ success: false, message: err.message });
  }
};

module.exports = { uploadKYC, getKYCStatus, autoVerifyKYC, panVerifyEndpoint };
