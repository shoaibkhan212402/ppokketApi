const express = require('express');
const router = express.Router();
const {
  getAdminDashboard, getAllUsers, getAllLoans,
  approveLoan, rejectLoan, disburseLoan,
  getPendingKYC, reviewKYC,
  getAllTransactions, sendBulkNotification,
  getLoanEMISchedule,
  updateCreditLimit, toggleUserStatus,
  changeAdminPassword, getSystemSettings, updateSystemSettings
} = require('../controllers/adminController');
const { adminProtect } = require('../middleware/auth');
const {
  adminGetReports,
  adminGetReportDetail,
  adminDeleteReport
} = require('../controllers/cibilController');

router.use(adminProtect); // All admin routes protected

router.get('/dashboard', getAdminDashboard);
router.get('/users', getAllUsers);
router.put('/users/:userId/credit-limit', updateCreditLimit);
router.put('/users/:userId/toggle-status', toggleUserStatus);
router.get('/loans', getAllLoans);
router.get('/loans/:id/emi-schedule', getLoanEMISchedule);
router.put('/approve-loan/:id', approveLoan);
router.put('/reject-loan/:id', rejectLoan);
router.put('/disburse-loan/:id', disburseLoan);
router.get('/kyc', getPendingKYC);
router.put('/kyc/:userId', reviewKYC);
router.get('/transactions', getAllTransactions);
router.post('/notify', sendBulkNotification);
router.put('/change-password', changeAdminPassword);
router.get('/system-settings', getSystemSettings);
router.put('/system-settings', updateSystemSettings);

// Admin CIBIL Reports management
router.get('/cibil/reports', adminGetReports);
router.get('/cibil/reports/:reportId', adminGetReportDetail);
router.delete('/cibil/reports/:reportId', adminDeleteReport);

module.exports = router;

