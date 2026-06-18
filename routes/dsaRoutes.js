const express = require('express');
const router  = express.Router();
const { getDsaDashboard, createDsaLead } = require('../controllers/dsaController');
const { protect } = require('../middleware/auth');

router.get('/dashboard', protect, getDsaDashboard);
router.post('/leads',    protect, createDsaLead);

module.exports = router;
