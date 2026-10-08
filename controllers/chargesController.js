const { loadChargeContext, latestCharges, saveCharges, MAX_CHARGES } = require('../utils/loanCharges');
const { auditLog } = require('../utils/audit');
const { delCache } = require('../config/redis');

// GET /api/admin/loan-charges
// The charge list as last saved (switched-off ones included), for the editor.
const getLoanCharges = async (req, res) => {
  try {
    const { versions } = await loadChargeContext();
    res.json({ success: true, charges: latestCharges(versions), max_charges: MAX_CHARGES });
  } catch (err) {
    console.error('[getLoanCharges]', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// PUT /api/admin/loan-charges   { charges: [{ id?, name, applies_to, type, value, active }] }
// Replaces the whole list. Only loans approved from now on get it — a loan
// already approved keeps the charges it was approved with (utils/loanCharges.js).
const updateLoanCharges = async (req, res) => {
  try {
    const charges = await saveCharges(req.body?.charges, req.admin?.id ?? null);

    await auditLog({ req, action: 'loan_charges_updated', entityType: 'setting', details: { charges } });
    // Apply previews and not-yet-approved loans show the current list.
    await delCache('user:*:profile', 'user:*:loans', 'user:*:dashboard');

    res.json({
      success: true,
      message: 'Charges saved. They apply to loans approved from now on.',
      charges,
    });
  } catch (err) {
    if (err.isValidation) return res.status(400).json({ success: false, message: err.message });
    console.error('[updateLoanCharges]', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

module.exports = { getLoanCharges, updateLoanCharges };
