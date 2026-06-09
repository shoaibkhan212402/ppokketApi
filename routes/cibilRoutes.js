const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const {
    userCheckCibil,
    userGetLatestReport,
    userDeleteLatestReport
} = require('../controllers/cibilController');

// All CIBIL user routes require token authentication
router.use(protect);

// POST /api/cibil/check  — user fetches/checks CIBIL score
router.post('/check', userCheckCibil);

// GET  /api/cibil/latest  — user fetches latest score details
router.get('/latest', userGetLatestReport);

// DELETE /api/cibil/delete  — user deletes report cache
router.delete('/delete', userDeleteLatestReport);

module.exports = router;
