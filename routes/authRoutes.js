const express = require('express');
const router = express.Router();
const { sendOTP, verifyOTP, demoLogin, adminLogin } = require('../controllers/authController');
const rateLimit = require('express-rate-limit');

// Per-IP throttle on OTP dispatch — the app-level per-mobile cooldown in
// authController handles SMS-bombing a single number; this caps overall
// abuse/cost from one source. Tightened from the previous 50/10min, which
// was loose enough to be no real limit at all.
const otpLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: process.env.NODE_ENV === 'production' ? 8 : 99999,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many OTP requests. Please try after 10 minutes.' },
});

// Per-IP throttle on OTP verification / login attempts. This is on top of
// the per-mobile-number 5-attempt lockout already enforced in
// handleVerifyAndLogin — that stops brute-forcing one number, this stops a
// single source from hammering the endpoint across many numbers.
const verifyLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: process.env.NODE_ENV === 'production' ? 15 : 99999,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many attempts. Please try after 10 minutes.' },
});

// Admin login had no throttling at all — password-based, so far more
// brute-forceable per-attempt than a 6-digit OTP with lockout.
const adminLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many login attempts. Please try after 15 minutes.' },
});

router.post('/send-otp', otpLimiter, sendOTP);
router.post('/verify-otp', verifyLimiter, verifyOTP);
router.post('/demo-login', verifyLimiter, demoLogin);
router.post('/admin-login', adminLoginLimiter, adminLogin);

module.exports = router;
