const express = require('express');
const router = express.Router();
const { getProfile, updateProfile, uploadOfferLetter, updateBankDetails, verifyBankDetails, getDashboard, getNotifications, markNotificationsRead } = require('../controllers/userController');
const { protect } = require('../middleware/auth');
const upload = require('../middleware/upload');

// One file, field name "offer_letter"; multer's own errors (too large, wrong
// type) are turned into a plain 400 instead of an unhandled error page.
const offerLetterFile = upload.single('offer_letter');
const handleOfferLetterUpload = (req, res, next) => {
  offerLetterFile(req, res, (err) => {
    if (!err) return next();
    console.error('[offer-letter] upload error:', err.message);
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ success: false, message: 'File too large. Maximum size is 10MB.' });
    }
    return res.status(400).json({ success: false, message: err.message || 'Upload failed' });
  });
};

router.get('/profile', protect, getProfile);
router.put('/update', protect, updateProfile);
router.post('/offer-letter', protect, handleOfferLetterUpload, uploadOfferLetter);
router.put('/bank-details', protect, updateBankDetails);
router.post('/bank-verify', protect, verifyBankDetails);
router.get('/dashboard', protect, getDashboard);
router.get('/notifications', protect, getNotifications);
router.put('/notifications/read', protect, markNotificationsRead);

module.exports = router;
