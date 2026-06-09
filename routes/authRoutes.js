const express = require('express');
const router = express.Router();
const { sendOTP, verifyOTP, demoLogin, adminLogin } = require('../controllers/authController');
const rateLimit = require('express-rate-limit');

const otpLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 50,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many OTP requests. Please try after 10 minutes.' },
});

router.post('/send-otp', otpLimiter, sendOTP);
router.post('/verify-otp', verifyOTP);
router.post('/demo-login', demoLogin);
router.post('/admin-login', adminLogin);

module.exports = router;
