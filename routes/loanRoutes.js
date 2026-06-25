const express = require('express');
const router = express.Router();
const { applyLoan, getLoanHistory, getLoanDetails, emiCalculator, getEmiSchedule, requestWithdrawal, getWithdrawalStatus } = require('../controllers/loanController');
const { protect } = require('../middleware/auth');

router.post('/apply', protect, applyLoan);
router.get('/history', protect, getLoanHistory);
router.get('/calculator', protect, emiCalculator);
router.get('/details/:id', protect, getLoanDetails);
router.get('/emi-schedule/:id', protect, getEmiSchedule);
router.post('/request-withdrawal/:id', protect, requestWithdrawal);
router.get('/withdrawal-status/:id', protect, getWithdrawalStatus);

module.exports = router;
