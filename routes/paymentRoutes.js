const express = require('express');
const router = express.Router();
const { createOrder, verifyPayment, getPaymentHistory, handleWebhook, initiateRefund, cancelPayment } = require('../controllers/paymentController');
const { createMandate, verifyMandate, deactivateMandate, getMandateStatus, reactivateMandate } = require('../controllers/mandateController');
const { protect, adminProtect, requirePermission } = require('../middleware/auth');

router.post('/create-order', protect, createOrder);
router.post('/verify',       protect, verifyPayment);
router.post('/cancel',       protect, cancelPayment);
router.get('/history',       protect, getPaymentHistory);
router.post('/refund',       adminProtect, requirePermission('manage_transactions'), initiateRefund);
router.post('/webhook',      handleWebhook);

// E-Mandate Auto-Pay Routes
router.post('/mandate/create',     protect, createMandate);
router.post('/mandate/verify',     protect, verifyMandate);
router.post('/mandate/deactivate', protect, deactivateMandate);
router.get('/mandate/status',      protect, getMandateStatus);
router.post('/mandate/reactivate', protect, reactivateMandate);

module.exports = router;
