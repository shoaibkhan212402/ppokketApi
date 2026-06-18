const express = require('express');
const router = express.Router();
const {
  getAdminDashboard, getAllUsers, getAllLoans,
  approveLoan, rejectLoan, disburseLoan,
  processLoan, previewEMI, setWithdrawalLimit,
  getPendingKYC, reviewKYC,
  getAllTransactions, sendBulkNotification,
  getLoanEMISchedule,
  updateCreditLimit, toggleUserStatus,
  changeAdminPassword, getSystemSettings, updateSystemSettings,
  // Admin management
  getAllAdmins, createAdmin, updateAdmin, deleteAdmin,
  toggleAdminStatus, updateAdminPermissions,
  // Notification history
  getNotificationHistory,
  // DSA management
  getAllDsaPartners, toggleUserDsaStatus, getAllDsaLeads,
  // New Partner endpoints
  getDsaBankPartners, assignUserPartner,
  // Lead management (DSA partner CRM)
  updateLeadStatus, getLeadKycDetails,
  // Audit
  getAuditLog,
} = require('../controllers/adminController');
const { adminProtect, requireSuperAdmin, requirePermission } = require('../middleware/auth');
const {
  adminGetReports,
  adminGetReportDetail,
  adminDeleteReport
} = require('../controllers/cibilController');
const { adminGetReferrals, adminCreditReferral } = require('../controllers/referralController');

router.use(adminProtect); // All admin routes protected

// Returns logged-in admin's own permissions (frontend refresh after permission change)
router.get('/me', (req, res) => {
  const isSuper = req.admin.role === 'super_admin';
  res.json({
    success: true,
    admin: { id: req.admin.id, name: req.admin.name, email: req.admin.email, role: req.admin.role },
    permissions: isSuper ? {
      view_dashboard: true, manage_users: true, manage_loans: true, manage_kyc: true,
      view_transactions: true, manage_transactions: true, send_notifications: true,
      manage_referrals: true, manage_settings: true, manage_admins: true, manage_dsa: true,
    } : req.adminPermissions,
  });
});

router.get('/dashboard', requirePermission('view_dashboard'), getAdminDashboard);
router.get('/users', requirePermission('manage_users'), getAllUsers);
router.put('/users/:userId/credit-limit', requirePermission('manage_users'), updateCreditLimit);
router.put('/users/:userId/toggle-status', requirePermission('manage_users'), toggleUserStatus);
router.put('/users/:userId/withdrawal-limit', requirePermission('manage_users'), setWithdrawalLimit);
router.get('/loans', requirePermission('manage_loans'), getAllLoans);
router.get('/loans/:id/emi-schedule', requirePermission('manage_loans'), getLoanEMISchedule);
router.put('/approve-loan/:id', requirePermission('manage_loans'), approveLoan);
router.put('/process-loan/:id', requirePermission('manage_loans'), processLoan);
router.get('/preview-emi', requirePermission('manage_loans'), previewEMI);
router.put('/reject-loan/:id', requirePermission('manage_loans'), rejectLoan);
router.put('/disburse-loan/:id', requirePermission('manage_loans'), disburseLoan);
router.get('/kyc', requirePermission('manage_kyc'), getPendingKYC);
router.put('/kyc/:userId', requirePermission('manage_kyc'), reviewKYC);
router.get('/transactions', requirePermission('view_transactions'), getAllTransactions);
router.post('/notify', requirePermission('send_notifications'), sendBulkNotification);
router.get('/notifications/history', requirePermission('send_notifications'), getNotificationHistory);
router.put('/change-password', changeAdminPassword);
router.get('/system-settings', requirePermission('manage_settings'), getSystemSettings);
router.put('/system-settings', requirePermission('manage_settings'), updateSystemSettings);

// CIBIL reports
router.get('/cibil/reports', requirePermission('view_transactions'), adminGetReports);
router.get('/cibil/reports/:reportId', requirePermission('view_transactions'), adminGetReportDetail);
router.delete('/cibil/reports/:reportId', requirePermission('manage_settings'), adminDeleteReport);

// Referrals
router.get('/referrals', requirePermission('manage_referrals'), adminGetReferrals);
router.post('/referrals/:id/credit', requirePermission('manage_referrals'), adminCreditReferral);

// DSA Management
router.get('/dsa/partners', requirePermission('manage_dsa'), getAllDsaPartners);
router.get('/dsa/leads', requirePermission('manage_dsa'), getAllDsaLeads);
router.put('/users/:userId/dsa', requirePermission('manage_dsa'), toggleUserDsaStatus);

// Partner Management
router.get('/dsa-bank-list', requirePermission('manage_users'), getDsaBankPartners);
router.put('/users/:userId/assign-partner', requireSuperAdmin, assignUserPartner);

// Lead CRM (DSA / bank partners update their lead pipeline)
router.put('/users/:userId/lead-status', requirePermission('manage_users'), updateLeadStatus);
router.get('/users/:userId/kyc-details', requirePermission('manage_users'), getLeadKycDetails);

// Audit log (super_admin only)
router.get('/audit-log', requireSuperAdmin, getAuditLog);

// Admin management (super_admin only)
router.get('/admins', requireSuperAdmin, getAllAdmins);
router.post('/admins', requireSuperAdmin, createAdmin);
router.put('/admins/:id', requireSuperAdmin, updateAdmin);
router.put('/admins/:id/permissions', requireSuperAdmin, updateAdminPermissions);
router.put('/admins/:id/toggle-status', requireSuperAdmin, toggleAdminStatus);
router.delete('/admins/:id', requireSuperAdmin, deleteAdmin);

module.exports = router;
