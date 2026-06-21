const express = require('express');
const router = express.Router();
const { getProfile, updateProfile, updateBankDetails, verifyBankDetails, getDashboard, checkEligibility, getNotifications, markNotificationsRead } = require('../controllers/userController');
const { protect } = require('../middleware/auth');

router.get('/profile', protect, getProfile);
router.put('/update', protect, updateProfile);
router.put('/bank-details', protect, updateBankDetails);
router.post('/bank-verify', protect, verifyBankDetails);
router.get('/dashboard', protect, getDashboard);
router.post('/check-eligibility', protect, checkEligibility);
router.get('/notifications', protect, getNotifications);
router.put('/notifications/read', protect, markNotificationsRead);

module.exports = router;
