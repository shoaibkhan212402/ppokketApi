const express = require('express');
const router  = express.Router();
const { sendOTP, verifyOTP, getAadhaarStatus } = require('../controllers/aadhaarController');
const { protect } = require('../middleware/auth');
// A customer in the Admin → Archive who carries on leaves it (utils/archive.js)
const { backFromArchive } = require('../utils/archive');

router.post('/send-otp',   protect, sendOTP);
router.post('/verify-otp', protect, backFromArchive('Aadhaar verified'), verifyOTP);
router.get('/status',      protect, getAadhaarStatus);

module.exports = router;
