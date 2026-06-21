const express = require('express');
const router = express.Router();
const { createOrder, verifyPayment, getPaymentHistory, handleWebhook, initiateRefund } = require('../controllers/paymentController');
const { createMandate, verifyMandate, deactivateMandate, getMandateStatus } = require('../controllers/mandateController');
const { protect, adminProtect, requirePermission } = require('../middleware/auth');

router.post('/create-order', protect, createOrder);
router.post('/verify',       protect, verifyPayment);
router.get('/history',       protect, getPaymentHistory);
router.post('/refund',       adminProtect, requirePermission('manage_transactions'), initiateRefund);
router.post('/webhook',      handleWebhook);

// E-Mandate Auto-Pay Routes
router.post('/mandate/create',     protect, createMandate);
router.post('/mandate/verify',     protect, verifyMandate);
router.post('/mandate/deactivate', protect, deactivateMandate);
router.get('/mandate/status',      protect, getMandateStatus);

module.exports = router;
