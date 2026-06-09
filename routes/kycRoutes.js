const express = require('express');
const router = express.Router();
const { uploadKYC, getKYCStatus, autoVerifyKYC, panVerifyEndpoint } = require('../controllers/kycController');
const { protect } = require('../middleware/auth');
const upload = require('../middleware/upload');

const kycFields = upload.fields([
  { name: 'aadhaar_front', maxCount: 1 },
  { name: 'aadhaar_back',  maxCount: 1 },
  { name: 'pan_card',      maxCount: 1 },
  { name: 'selfie',        maxCount: 1 },
  { name: 'bank_passbook',  maxCount: 1 },
]);

const handleKycUpload = (req, res, next) => {
  kycFields(req, res, (err) => {
    if (!err) return next();
    
    // Log error for debugging
    try {
      const fs = require('fs');
      const path = require('path');
      const logPath = path.join(__dirname, '../errors.log');
      fs.appendFileSync(
        logPath,
        `[${new Date().toISOString()}] [handleKycUpload] Multer error: ${err.message || 'Unknown'}\nStack: ${err.stack || ''}\n`
      );
    } catch (logErr) {
      console.error('Failed to write to error log:', logErr.message);
    }
    console.error('❌ Multer error:', err);

    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ success: false, message: 'File too large. Maximum size is 10MB per file.' });
    }
    if (err.code === 'LIMIT_UNEXPECTED_FILE') {
      return res.status(400).json({ success: false, message: 'Unexpected file field. Use: aadhaar_front, aadhaar_back, pan_card, selfie, bank_passbook.' });
    }
    return res.status(400).json({ success: false, message: err.message || 'Upload failed' });
  });
};

router.post('/upload',      protect, handleKycUpload, uploadKYC);
router.get('/status',       protect, getKYCStatus);
router.post('/auto-verify', protect, autoVerifyKYC);
router.post('/pan-verify',  protect, panVerifyEndpoint);

module.exports = router;

