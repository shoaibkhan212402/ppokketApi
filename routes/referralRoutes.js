const express = require('express');
const router  = express.Router();
const { getMyReferrals } = require('../controllers/referralController');
const { protect } = require('../middleware/auth');

router.get('/my-referrals', protect, getMyReferrals);

module.exports = router;
