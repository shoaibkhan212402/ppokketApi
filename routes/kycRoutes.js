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
]);

router.post('/upload',      protect, kycFields, uploadKYC);
router.get('/status',       protect, getKYCStatus);
router.post('/auto-verify', protect, autoVerifyKYC);
router.post('/pan-verify',  protect, panVerifyEndpoint);

module.exports = router;

