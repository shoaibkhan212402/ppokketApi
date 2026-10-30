const { pool } = require('../config/db');
const { delCache, invalidateUserCache } = require('../config/redis');
const { auditLog } = require('../utils/audit');
const { cleanEmployment, getEmployment, saveEmployment, saveOfferLetter } = require('../utils/employment');
const { checkGstinBeforeSave } = require('../utils/gstVerify');
const { cleanReferences, getReferences, saveReferences } = require('../utils/references');
const { isWithoutOtp } = require('../utils/aadhaarMode');

// Super admin: correct a customer's details and upload / replace their
// documents when something is missing or wrong. Everything goes through the
// same checks as the customer's own forms (and the same document rules: photos
// for Aadhaar / PAN / selfie, a PDF for the bank statement and offer letter),
// and every change is written to the audit log with what it was before.

const invalid = (message, status = 400) => Object.assign(new Error(message), { isValidation: true, status });
const fail = (res, err, where) => {
  if (err.isValidation) return res.status(err.status || 400).json({ success: false, message: err.message });
  console.error(`[${where}]`, err);
  return res.status(500).json({ success: false, message: err.message });
};

const OCCUPATIONS = ['salaried', 'self_employed', 'student', 'retired', 'unemployed'];
const DOC_FIELDS = ['aadhaar_front', 'aadhaar_back', 'pan_card', 'selfie', 'bank_passbook'];
const dateText = (d) => (d ? (d instanceof Date ? new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString() : String(d)).slice(0, 10) : null);

// GET /api/admin/users/:userId/edit-data
const getCustomerEditData = async (req, res) => {
  try {
    const userId = Number(req.params.userId);
    const [[user]] = await pool.query(
      `SELECT id, full_name, mobile, email, date_of_birth, occupation, monthly_income, full_address,
              pan_number, aadhaar_number, pan_verified, aadhaar_verified, is_kyc_verified
         FROM users WHERE id = ?`,
      [userId]
    );
    if (!user) return res.status(404).json({ success: false, message: 'Customer not found' });
    const [[bank]] = await pool.query(
      'SELECT account_holder, account_number, ifsc_code, bank_name, account_type, is_verified FROM bank_details WHERE user_id = ?',
      [userId]
    );
    const [[kyc]] = await pool.query(`SELECT status, ${DOC_FIELDS.join(', ')} FROM kyc_documents WHERE user_id = ?`, [userId]);
    const employment = await getEmployment(userId);
    res.json({
      success: true,
      customer: {
        ...user,
        date_of_birth: dateText(user.date_of_birth),
        monthly_income: user.monthly_income == null ? null : Number(user.monthly_income),
        pan_verified: !!user.pan_verified,
        aadhaar_verified: !!user.aadhaar_verified,
        // The customer gave the number while Aadhaar OTP was switched off
        aadhaar_without_otp: !!user.aadhaar_verified && await isWithoutOtp(userId),
      },
      bank: bank ? { ...bank, is_verified: !!bank.is_verified } : null,
      employment,
      references: await getReferences(userId),
      kyc_status: kyc?.status || 'not_submitted',
      documents: {
        ...Object.fromEntries(DOC_FIELDS.map((f) => [f, kyc?.[f] || null])),
        offer_letter: employment?.offer_letter || null,
      },
    });
  } catch (err) {
    fail(res, err, 'getCustomerEditData');
  }
};

// The profile part of the form → columns to set (only what was sent)
const cleanProfile = (p, current) => {
  const out = {};
  if (p.full_name !== undefined) {
    const v = String(p.full_name).replace(/\s+/g, ' ').trim();
    if (v.length < 2 || v.length > 150) throw invalid('Full name must be 2–150 characters.');
    out.full_name = v;
  }
  if (p.email !== undefined) {
    const v = String(p.email).trim().toLowerCase();
    if (v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) throw invalid('Email address is not valid.');
    out.email = v || null;
  }
  if (p.date_of_birth !== undefined) {
    const v = String(p.date_of_birth || '').slice(0, 10);
    if (v) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) throw invalid('Date of birth must be a date.');
      const eighteen = new Date(`${v}T00:00:00Z`);
      eighteen.setUTCFullYear(eighteen.getUTCFullYear() + 18);
      if (eighteen > new Date()) throw invalid('The customer must be at least 18 years old.');
    }
    out.date_of_birth = v || null;
  }
  if (p.occupation !== undefined) {
    if (p.occupation && !OCCUPATIONS.includes(p.occupation)) throw invalid('Choose an occupation from the list.');
    out.occupation = p.occupation || null;
  }
  if (p.monthly_income !== undefined) {
    const v = p.monthly_income === '' || p.monthly_income === null ? null : Number(p.monthly_income);
    if (v !== null && (!Number.isFinite(v) || v < 0)) throw invalid('Monthly income must be a number.');
    out.monthly_income = v;
  }
  if (p.full_address !== undefined) out.full_address = String(p.full_address || '').replace(/\s+/g, ' ').trim().slice(0, 500) || null;
  if (p.pan_number !== undefined) {
    const v = String(p.pan_number || '').replace(/\s/g, '').toUpperCase();
    if (v && !/^[A-Z]{5}\d{4}[A-Z]$/.test(v)) throw invalid('PAN must look like ABCDE1234F.');
    out.pan_number = v || null;
    // A number that changes is no longer the one that was verified
    if ((v || null) !== (current.pan_number || null)) out.pan_verified = 0;
  }
  if (p.aadhaar_number !== undefined) {
    const v = String(p.aadhaar_number || '').replace(/\D/g, '');
    if (v && !/^\d{12}$/.test(v)) throw invalid('Aadhaar number must be 12 digits.');
    out.aadhaar_number = v || null;
    if ((v || null) !== (current.aadhaar_number || null)) out.aadhaar_verified = 0;
  }
  return out;
};

const cleanBank = (b) => {
  const account_holder = String(b.account_holder || '').replace(/\s+/g, ' ').trim();
  const account_number = String(b.account_number || '').replace(/\s/g, '');
  const ifsc_code = String(b.ifsc_code || '').replace(/\s/g, '').toUpperCase();
  const bank_name = String(b.bank_name || '').replace(/\s+/g, ' ').trim();
  const account_type = b.account_type === 'current' ? 'current' : 'savings';
  if (account_holder.length < 2) throw invalid('Enter the account holder name.');
  if (!/^\d{6,20}$/.test(account_number)) throw invalid('Account number must be 6–20 digits.');
  if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc_code)) throw invalid('IFSC must look like SBIN0001234.');
  if (bank_name.length < 2) throw invalid('Enter the bank name.');
  return { account_holder, account_number, ifsc_code, bank_name, account_type, is_verified: b.is_verified ? 1 : 0 };
};

// PUT /api/admin/users/:userId/details   { profile?, employment?, references?, bank? }
// Each part is optional; what is sent is checked first, then saved together.
const updateCustomerDetails = async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const userId = Number(req.params.userId);
    const body = req.body || {};
    const [[current]] = await conn.query('SELECT * FROM users WHERE id = ?', [userId]);
    if (!current) { conn.release(); return res.status(404).json({ success: false, message: 'Customer not found' }); }

    // Check everything before writing anything
    const profile = body.profile ? cleanProfile(body.profile, current) : null;
    const employment = body.employment !== undefined ? cleanEmployment(body.employment) : undefined;
    const references = body.references !== undefined ? cleanReferences(body.references, current.mobile) : undefined;
    const bank = body.bank ? cleanBank(body.bank) : null;
    const [[oldBank]] = await conn.query('SELECT * FROM bank_details WHERE user_id = ?', [userId]);
    const bankChanged = !!(bank && oldBank && (oldBank.account_number !== bank.account_number || oldBank.ifsc_code !== bank.ifsc_code));
    // A new GST number must exist on the GST portal (only while QuickeKYC is on)
    if (employment?.gst_number) {
      const gst = await checkGstinBeforeSave(userId, employment.gst_number, (await getEmployment(userId))?.gst_number ?? null);
      if (!gst.ok) throw invalid(gst.message);
    }

    const changes = {};
    await conn.beginTransaction();
    if (profile && Object.keys(profile).length) {
      const cols = Object.keys(profile);
      await conn.query(`UPDATE users SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = NOW() WHERE id = ?`, [...cols.map((c) => profile[c]), userId]);
      // The KYC record keeps its own copy of the "verified" marks
      const kycFlags = ['pan_verified', 'aadhaar_verified'].filter((f) => f in profile);
      if (kycFlags.length) await conn.query(`UPDATE kyc_documents SET ${kycFlags.map((f) => `${f} = 0`).join(', ')} WHERE user_id = ?`, [userId]);
      changes.profile = Object.fromEntries(cols.map((c) => [c, { from: current[c] instanceof Date ? dateText(current[c]) : current[c], to: profile[c] }]));
    }
    if (bank) {
      if (oldBank) {
        await conn.query(
          `UPDATE bank_details SET account_holder = ?, account_number = ?, ifsc_code = ?, bank_name = ?, account_type = ?, is_verified = ? WHERE user_id = ?`,
          [bank.account_holder, bank.account_number, bank.ifsc_code, bank.bank_name, bank.account_type, bank.is_verified, userId]
        );
      } else {
        await conn.query(
          `INSERT INTO bank_details (user_id, account_holder, account_number, ifsc_code, bank_name, account_type, is_verified) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [userId, bank.account_holder, bank.account_number, bank.ifsc_code, bank.bank_name, bank.account_type, bank.is_verified]
        );
      }
      await conn.query('UPDATE users SET bank_verified = ? WHERE id = ?', [bank.is_verified, userId]);
      changes.bank = { from: oldBank ? { holder: oldBank.account_holder, account: oldBank.account_number, ifsc: oldBank.ifsc_code, bank: oldBank.bank_name, verified: !!oldBank.is_verified } : null, to: { holder: bank.account_holder, account: bank.account_number, ifsc: bank.ifsc_code, bank: bank.bank_name, verified: !!bank.is_verified } };
    }
    await conn.commit();
    conn.release();

    // Their own tables (created on first use) — saved after the main rows
    if (employment !== undefined) { await saveEmployment(userId, employment); changes.employment = employment; }
    if (references !== undefined) { await saveReferences(userId, references); changes.references = references; }

    if (!Object.keys(changes).length) return res.status(400).json({ success: false, message: 'Nothing to save.' });
    await auditLog({ req, action: 'customer_details_edited', entityType: 'user', entityId: userId, details: changes });
    await invalidateUserCache(userId);
    await delCache(`user:${userId}:kyc`, 'admin:dashboard', 'admin:dashboard:partner:*');
    res.json({
      success: true,
      message: bankChanged
        ? 'Saved. The bank account changed — the customer\'s Auto-Pay mandate is still on the old account and must be set up again.'
        : 'Customer details saved.',
    });
  } catch (err) {
    try { await conn.rollback(); } catch (_) { /* not in a transaction */ }
    try { conn.release(); } catch (_) { /* already released */ }
    if (err.code === 'ER_DUP_ENTRY' && /email/i.test(err.message)) {
      return res.status(409).json({ success: false, message: 'This email address belongs to another customer.' });
    }
    fail(res, err, 'updateCustomerDetails');
  }
};

// POST /api/admin/users/:userId/documents   multipart: any of aadhaar_front,
// aadhaar_back, pan_card, selfie, bank_passbook, offer_letter
// (the route's multer has already checked and stored the files)
const uploadCustomerDocuments = async (req, res) => {
  try {
    const userId = Number(req.params.userId);
    const files = req.files || {};
    const urlOf = (field) => {
      const f = files[field]?.[0];
      if (!f) return null;
      if (f.path && /^https?:\/\//i.test(f.path)) return f.path;
      if (f.secure_url) return f.secure_url;
      if (f.filename) return `${req.protocol}://${req.get('host')}/uploads/${f.filename}`;
      return null;
    };
    const kycUrls = Object.fromEntries(DOC_FIELDS.map((f) => [f, urlOf(f)]).filter(([, url]) => url));
    const offerLetter = urlOf('offer_letter');
    if (!Object.keys(kycUrls).length && !offerLetter) return res.status(400).json({ success: false, message: 'Choose a file to upload.' });

    const [[before]] = await pool.query(`SELECT ${DOC_FIELDS.join(', ')} FROM kyc_documents WHERE user_id = ?`, [userId]);
    if (Object.keys(kycUrls).length) {
      const cols = Object.keys(kycUrls);
      // A new KYC record starts as pending; an existing one keeps its status
      await pool.query(
        `INSERT INTO kyc_documents (user_id, ${cols.join(', ')}, status) VALUES (?, ${cols.map(() => '?').join(', ')}, 'pending')
         ON DUPLICATE KEY UPDATE ${cols.map((c) => `${c} = VALUES(${c})`).join(', ')}, updated_at = NOW()`,
        [userId, ...cols.map((c) => kycUrls[c])]
      );
    }
    if (offerLetter && !(await saveOfferLetter(userId, offerLetter))) {
      return res.status(503).json({ success: false, message: 'The offer letter could not be saved right now.' });
    }

    await auditLog({
      req, action: 'customer_documents_uploaded', entityType: 'user', entityId: userId,
      details: {
        ...Object.fromEntries(Object.entries(kycUrls).map(([f, url]) => [f, { from: before?.[f] || null, to: url }])),
        ...(offerLetter ? { offer_letter: { to: offerLetter } } : {}),
      },
    });
    await invalidateUserCache(userId);
    await delCache(`user:${userId}:kyc`, 'admin:dashboard', 'admin:dashboard:partner:*');
    res.json({ success: true, message: 'Document saved.', documents: { ...kycUrls, ...(offerLetter ? { offer_letter: offerLetter } : {}) } });
  } catch (err) {
    fail(res, err, 'uploadCustomerDocuments');
  }
};

module.exports = { getCustomerEditData, updateCustomerDetails, uploadCustomerDocuments };
