const { delCache } = require('../config/redis');
const { listCandidates, listArchived, archiveCustomers, restoreCustomers } = require('../utils/archive');

// Admin → Archive (super admin only). Rules in utils/archive.js.

const fail = (res, err, where) => {
  if (err.isValidation) return res.status(err.status || 400).json({ success: false, message: err.message });
  console.error(`[${where}]`, err);
  return res.status(500).json({ success: false, message: err.message });
};
const clean = (s) => String(s || '').trim().slice(0, 80);

// GET /api/admin/archive?search=
const getArchived = async (req, res) => {
  try {
    const customers = await listArchived({ search: clean(req.query.search) });
    res.json({ success: true, customers });
  } catch (err) { fail(res, err, 'getArchived'); }
};

// GET /api/admin/archive/candidates?days=7&search=
const getArchiveCandidates = async (req, res) => {
  try {
    const days = [0, 3, 7, 15, 30, 60].includes(Number(req.query.days)) ? Number(req.query.days) : 7;
    const customers = await listCandidates({ days, search: clean(req.query.search) });
    res.json({ success: true, customers, days });
  } catch (err) { fail(res, err, 'getArchiveCandidates'); }
};

// POST /api/admin/archive   { user_ids: [], reason? }
const archive = async (req, res) => {
  try {
    const { archived, skipped } = await archiveCustomers(req.body?.user_ids, req.body?.reason, req);
    await delCache('admin:dashboard', 'admin:dashboard:partner:*');
    const msg = `${archived.length} customer${archived.length === 1 ? '' : 's'} moved to the archive`
      + (skipped.length ? `; ${skipped.length} skipped (${[...new Set(skipped.map((s) => s.why))].join(', ')})` : '');
    res.json({ success: true, message: msg, archived, skipped });
  } catch (err) { fail(res, err, 'archive'); }
};

// POST /api/admin/archive/restore   { user_ids: [] }
const restore = async (req, res) => {
  try {
    const n = await restoreCustomers(req.body?.user_ids, req);
    await delCache('admin:dashboard', 'admin:dashboard:partner:*');
    res.json({ success: true, message: `${n} customer${n === 1 ? '' : 's'} moved back to the active lists`, restored: n });
  } catch (err) { fail(res, err, 'restoreArchived'); }
};

module.exports = { getArchived, getArchiveCandidates, archive, restore };
