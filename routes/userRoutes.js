const express = require('express');
const router = express.Router();
const {
  getProfile, updateProfile, uploadOfferLetter, getCompanies, updateBankDetails, verifyBankDetails, getDashboard,
  getNotifications, markNotificationsRead, sendReferenceOtpHandler, verifyReferenceOtpHandler,
} = require('../controllers/userController');
const { protect } = require('../middleware/auth');
// A customer in the Admin → Archive who carries on leaves it (utils/archive.js)
const { backFromArchive } = require('../utils/archive');
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
// Only a saved profile form counts, not the app refreshing its push token
router.put('/update', protect, backFromArchive('Profile saved', (req) => req.body?.full_name !== undefined), updateProfile);
// A reference's number is confirmed with an OTP sent to it before it can be saved
router.post('/references/send-otp', protect, sendReferenceOtpHandler);
router.post('/references/verify-otp', protect, verifyReferenceOtpHandler);
router.post('/offer-letter', protect, handleOfferLetterUpload, uploadOfferLetter);
// Suggestions for the "Company Name" box — open, so the sign-up form can use it too
router.get('/companies', getCompanies);
router.put('/bank-details', protect, updateBankDetails);
router.post('/bank-verify', protect, backFromArchive('Bank account verified'), verifyBankDetails);
router.get('/dashboard', protect, getDashboard);
router.get('/notifications', protect, getNotifications);
router.put('/notifications/read', protect, markNotificationsRead);

module.exports = router;
