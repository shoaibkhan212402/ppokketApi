const { pool } = require('../config/db');
const { getCache, setCache, delCache } = require('../config/redis');
const { PARTNER_ROLES } = require('./adminRoles');

// What a DSA Partner and a Bank Partner may do with the leads assigned to them
// (super admin → Admin Management → Roles). Every partner account of a role
// gets the same switches. Whatever is switched on, a partner only ever sees
// the leads assigned to them, and never approves loans or KYC, changes limits,
// sends notifications or opens settings — the API refuses those to partners.
//
// Kept as one JSON row in system_settings (nothing new in the schema).
// Nothing saved yet = everything on, which is how partners worked before.

const SETTING_KEY = 'partner_role_capabilities';
const CACHE_KEY = 'partner_role_capabilities';

const CAPABILITIES = [
  { key: 'view_contact', label: 'Contact leads',      desc: 'See the mobile number and email, with Call and WhatsApp buttons' },
  { key: 'update_stage', label: 'Change lead stage',  desc: 'Move a lead along: New → Contacted → … → Converted' },
  { key: 'add_notes',    label: 'Notes & follow-ups', desc: 'Write notes on a lead and set the next follow-up date' },
  { key: 'view_kyc',     label: 'See KYC details',    desc: 'PAN, last 4 digits of Aadhaar, which documents are uploaded' },
  { key: 'view_loans',   label: 'See loans & EMIs',   desc: "The lead's loans and EMI schedule (never the payout bank account)" },
];
const CAPABILITY_KEYS = CAPABILITIES.map(c => c.key);

const isPartnerRole = (role) => PARTNER_ROLES.includes(role);

// Fills in every role × switch; anything not saved counts as on.
const normalise = (saved) => {
  const roles = {};
  for (const role of PARTNER_ROLES) {
    roles[role] = {};
    for (const key of CAPABILITY_KEYS) {
      const v = saved?.[role]?.[key];
      roles[role][key] = typeof v === 'boolean' ? v : true;
    }
  }
  return roles;
};

const loadPartnerRoles = async () => {
  const cached = await getCache(CACHE_KEY);
  if (cached) return normalise(cached);
  const [rows] = await pool.query('SELECT setting_value FROM system_settings WHERE setting_key = ?', [SETTING_KEY]);
  let saved = null;
  if (rows[0]) {
    try { saved = JSON.parse(rows[0].setting_value); } catch { saved = null; }
  }
  const roles = normalise(saved);
  await setCache(CACHE_KEY, roles, 60);
  return roles;
};

const capabilitiesFor = async (role) => (isPartnerRole(role) ? (await loadPartnerRoles())[role] : null);

// input: { dsa_partner: { view_contact: true, … }, bank_partner: { … } }
// Roles / switches left out keep what they had. Throws { isValidation } on bad input.
const savePartnerRoles = async (input) => {
  if (!input || typeof input !== 'object') throw Object.assign(new Error('Nothing to save'), { isValidation: true });
  const current = await loadPartnerRoles();
  for (const [role, caps] of Object.entries(input)) {
    if (!isPartnerRole(role)) throw Object.assign(new Error(`Unknown partner role: ${role}`), { isValidation: true });
    if (!caps || typeof caps !== 'object') throw Object.assign(new Error(`Switches for ${role} are missing`), { isValidation: true });
    for (const [key, value] of Object.entries(caps)) {
      if (!CAPABILITY_KEYS.includes(key)) throw Object.assign(new Error(`Unknown switch: ${key}`), { isValidation: true });
      if (typeof value !== 'boolean') throw Object.assign(new Error(`${key} must be on or off`), { isValidation: true });
      current[role][key] = value;
    }
  }
  await pool.query(
    'INSERT INTO system_settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)',
    [SETTING_KEY, JSON.stringify(current)]
  );
  await delCache(CACHE_KEY);
  return current;
};

// Mobile shown as its last 4 digits — enough to tell two leads apart,
// not enough to call. Used when "Contact leads" is off.
const maskMobile = (mobile) => {
  const s = String(mobile || '');
  return s.length > 4 ? `••••••${s.slice(-4)}` : s;
};
const hideContact = (rows, caps) => {
  if (!caps || caps.view_contact) return rows;
  for (const row of rows) {
    if (!row) continue;
    if ('mobile' in row) row.mobile = maskMobile(row.mobile);
    if ('email' in row) row.email = null;
  }
  return rows;
};

// Everything a partner's role does not cover is taken out of the rows before
// they leave the server — hiding it on the screen alone is not enough.
//   always: credit bureau scores (CIBIL / Experian are never for partners)
//   "Contact leads" off: mobile → last 4 digits, no email
//   "See KYC details" off: no PAN, no Aadhaar (not even the last 4)
const trimForPartner = (rows, caps) => {
  for (const row of rows) {
    if (!row) continue;
    delete row.credit_score; delete row.experian_score; delete row.experian_fetched_at;
    if (!caps?.view_kyc) {
      if ('pan_number' in row) row.pan_number = null;
      if ('aadhaar_number' in row) row.aadhaar_number = null;
    }
  }
  return hideContact(rows, caps);
};

module.exports = {
  CAPABILITIES, CAPABILITY_KEYS, isPartnerRole,
  loadPartnerRoles, capabilitiesFor, savePartnerRoles, hideContact, trimForPartner,
};
