const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const {
    userCheckExperian,
    userGetLatestReport,
    userDeleteLatestReport
} = require('../controllers/experianController');

// All Experian user routes require token authentication
router.use(protect);

// POST /api/experian/check  — user fetches/checks Experian score
router.post('/check', userCheckExperian);

// GET  /api/experian/latest  — user fetches latest score details
router.get('/latest', userGetLatestReport);

// DELETE /api/experian/delete  — user deletes report cache
router.delete('/delete', userDeleteLatestReport);

module.exports = router;
