const express = require('express');
const router = express.Router();
const { createOrder, verifyPayment, getPaymentHistory, handleWebhook, initiateRefund } = require('../controllers/paymentController');
const { protect, adminProtect, requirePermission } = require('../middleware/auth');

router.post('/create-order', protect, createOrder);
router.post('/verify',       protect, verifyPayment);
router.get('/history',       protect, getPaymentHistory);
router.post('/refund',       adminProtect, requirePermission('manage_transactions'), initiateRefund);
router.post('/webhook',      handleWebhook);

module.exports = router;
