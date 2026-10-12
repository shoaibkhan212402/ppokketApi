const { loadChargeContext, editorCharges, saveCharges, MAX_CHARGES, BUILT_IN_CHARGES } = require('../utils/loanCharges');
const { auditLog } = require('../utils/audit');
const { delCache } = require('../config/redis');

// GET /api/admin/loan-charges
// The charge list for the editor: as last saved (hidden ones included), with
// the built-in charges always present. max_charges counts the admin's own.
const getLoanCharges = async (req, res) => {
  try {
    const { versions } = await loadChargeContext();
    res.json({
      success: true,
      charges: editorCharges(versions),
      max_charges: MAX_CHARGES,
      built_in_ids: BUILT_IN_CHARGES.map((c) => c.id),
    });
  } catch (err) {
    console.error('[getLoanCharges]', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// PUT /api/admin/loan-charges   { charges: [{ id?, name, applies_to, type, value, percent_of?, active }] }
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
