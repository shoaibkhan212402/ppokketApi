const express = require('express');
const router = express.Router();
const {
  createOrder, verifyPayment, getPaymentHistory, initiateRefund, cancelPayment,
  handleWebhook, handleRazorpayWebhook, handleRazorpayCallback,
} = require('../controllers/paymentController');
const {
  createMandate, verifyMandate, deactivateMandate, getMandateStatus, reactivateMandate,
  getMandateSession, handleMandateReturn, handleSubscriptionWebhook,
} = require('../controllers/mandateController');
const { protect, adminProtect, requirePermission } = require('../middleware/auth');

// Cashfree posts payment and Auto-Pay (subscription) events alike; one URL
// serves both, whichever of its dashboard webhook settings points here.
const handleCashfreeWebhook = (req, res) => (
  String(req.body?.type || '').startsWith('SUBSCRIPTION_') ? handleSubscriptionWebhook(req, res) : handleWebhook(req, res)
);

router.post('/create-order', protect, createOrder);
router.post('/verify',       protect, verifyPayment);
router.post('/cancel',       protect, cancelPayment);
router.get('/history',       protect, getPaymentHistory);
router.post('/refund',       adminProtect, requirePermission('manage_transactions'), initiateRefund);
router.post('/webhook',      handleCashfreeWebhook);
router.post('/webhook/razorpay', handleRazorpayWebhook);
// Browser return from Razorpay's redirect-mode checkout (form POST; GET if the page is reloaded)
router.route('/razorpay/callback').post(handleRazorpayCallback).get(handleRazorpayCallback);

// E-Mandate Auto-Pay Routes
router.post('/mandate/create',     protect, createMandate);
router.post('/mandate/verify',     protect, verifyMandate);
router.post('/mandate/deactivate', protect, deactivateMandate);
router.get('/mandate/status',      protect, getMandateStatus);
router.post('/mandate/reactivate', protect, reactivateMandate);
// Opened from the phone's browser / Cashfree's redirect, so neither carries a login
router.get('/mandate/session',     getMandateSession);
router.route('/mandate/return').get(handleMandateReturn).post(handleMandateReturn);

module.exports = router;
