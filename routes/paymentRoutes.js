const express = require('express');
const router = express.Router();
const { createOrder, verifyPayment, getPaymentHistory, handleWebhook } = require('../controllers/paymentController');
const { protect } = require('../middleware/auth');

router.post('/create-order', protect, createOrder);
router.post('/verify', protect, verifyPayment);
router.get('/history', protect, getPaymentHistory);
router.post('/webhook', handleWebhook);

module.exports = router;
