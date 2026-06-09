const express = require('express');
const router = express.Router();
const { applyLoan, getLoanHistory, getLoanDetails, emiCalculator } = require('../controllers/loanController');
const { protect } = require('../middleware/auth');

router.post('/apply', protect, applyLoan);
router.get('/history', protect, getLoanHistory);
router.get('/calculator', emiCalculator);
router.get('/details/:id', protect, getLoanDetails);

module.exports = router;
