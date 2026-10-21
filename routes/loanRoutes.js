const express = require('express');
const router = express.Router();
const { applyLoan, getLoanHistory, getLoanDetails, emiCalculator, getEmiSchedule, requestWithdrawal, previewLoanCoupon, getWithdrawalStatus } = require('../controllers/loanController');
const { protect } = require('../middleware/auth');
// A customer in the Admin → Archive who carries on leaves it (utils/archive.js)
const { backFromArchive } = require('../utils/archive');

router.post('/apply', protect, backFromArchive('Loan applied for'), applyLoan);
router.get('/history', protect, getLoanHistory);
router.get('/calculator', protect, emiCalculator);
router.get('/details/:id', protect, getLoanDetails);
router.get('/emi-schedule/:id', protect, getEmiSchedule);
router.post('/request-withdrawal/:id', protect, requestWithdrawal);
// What a coupon code would take off an approved loan (applied by request-withdrawal)
router.post('/coupon-preview/:id', protect, previewLoanCoupon);
router.get('/withdrawal-status/:id', protect, getWithdrawalStatus);

module.exports = router;
