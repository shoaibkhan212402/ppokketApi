const express = require('express');
const router  = express.Router();
const { sendOTP, verifyOTP, getAadhaarStatus } = require('../controllers/aadhaarController');
const { protect } = require('../middleware/auth');

router.post('/send-otp',   protect, sendOTP);
router.post('/verify-otp', protect, verifyOTP);
router.get('/status',      protect, getAadhaarStatus);

module.exports = router;
