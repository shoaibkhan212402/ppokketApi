const express = require('express');
const router = express.Router();
const {
  getInvestmentSettings, previewMaturity,
  createInvestment, cancelInvestment, withdrawInvestment,
  getMyInvestments, getInvestmentDetails, getPortfolioSummary,
} = require('../controllers/investmentController');
const { protect } = require('../middleware/auth');

router.get('/settings', protect, getInvestmentSettings);
router.get('/calculator', protect, previewMaturity);
router.post('/create', protect, createInvestment);
router.post('/cancel/:id', protect, cancelInvestment);
router.post('/withdraw/:id', protect, withdrawInvestment);
router.get('/my-investments', protect, getMyInvestments);
router.get('/my-investments/:id', protect, getInvestmentDetails);
router.get('/portfolio-summary', protect, getPortfolioSummary);

module.exports = router;
