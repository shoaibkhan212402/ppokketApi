const axios = require('axios');
const quickekyc = require('./quickekyc');
const { compareName } = require('./bankVerify');

const APITXT_PAN_URL = 'https://apitxt.com/api/panVerify';
const AUTH_KEY = () => process.env.APITXT_AUTHKEY || '';

/**
 * Convert "DD/MM/YYYY" to "YYYY-MM-DD" for MySQL.
 */
const convertDobToMySQL = (dobStr) => {
  if (!dobStr) return null;
  const parts = String(dobStr).trim().split('/');
  if (parts.length !== 3) return null;
  const [d, m, y] = parts;
  if (!d || !m || !y || y.length !== 4) return null;
  return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
};

const APITXT_PAN_ERRORS = {
  105: 'Missing Authentication Key.',
  106: 'Missing PAN number.',
  107: 'Missing name (as per PAN).',
  108: 'Missing date of birth.',
  206: 'Invalid PAN. Format must be ABCDE1234F.',
  207: 'Invalid date of birth. Format must be DD/MM/YYYY.',
  301: 'Insufficient wallet balance. Please recharge your API account.',
  304: 'Invalid Authentication Key or IP Restricted.',
  310: 'Verification failed (vendor error). Please try again.',
};

/**
 * Verify PAN card via APItxt PAN Verification API
 *
 * @param {Object} params
 * @param {string} params.pan
 * @param {string} params.name
 * @param {string} params.dob
 *
 * @returns {Promise<{
 *   success: boolean,
 *   verified: boolean,
 *   panNumber: string|null,
 *   fullName: string|null,
 *   category: string|null,
 *   dob: string|null,
 *   dobMySQL: string|null,
 *   gender: string|null,
 *   mobileNo: string|null,
 *   email: string|null,
 *   address: Object|null,
 *   requestId: string|null,
 *   message: string|null,
 *   raw: Object
 * }>}
 */
const verifyPAN = async ({ pan, name, dob }) => {
  const authKey = AUTH_KEY();
  const panClean = (pan || '').trim().toUpperCase();
  const nameClean = (name || '').trim();
  const dobClean = (dob || '').trim();

  if (!panClean) {
    return {
      success: false, verified: false,
      message: 'PAN number is required.', errorCode: 106,
    };
  }
  if (!nameClean) {
    return {
      success: false, verified: false,
      message: 'Name is required as printed on the PAN card.', errorCode: 107,
    };
  }
  if (!dobClean) {
    return {
      success: false, verified: false,
      message: 'Date of birth is required.', errorCode: 108,
    };
  }

  // Basic client-side validation
  if (!/^[A-Z]{5}[0-9]{4}[A-Z]{1}$/.test(panClean)) {
    return {
      success: false, verified: false,
      message: 'Invalid PAN format. Must be in the format ABCDE1234F.', errorCode: 206,
    };
  }
  if (!/^\d{2}\/\d{2}\/\d{4}$/.test(dobClean)) {
    return {
      success: false, verified: false,
      message: 'Invalid date of birth format. Must be DD/MM/YYYY.', errorCode: 207,
    };
  }

  if (quickekyc.isQuickeKycOn()) {
    try {
      return await verifyPanQuickeKyc({ panClean, nameClean, dobClean });
    } catch (err) {
      // No PAN service enabled on the QuickeKYC account: APItxt, as before
      if (!err.notAllowed) throw err;
      console.warn('[PAN Verify] no PAN service is enabled on QuickeKYC — using APItxt.');
    }
  }

  if (!authKey) {
    return {
      success: false, verified: false,
      message: 'PAN Verification service is not configured. Please contact support.',
      errorCode: 105,
    };
  }

  let raw;
  try {
    const response = await axios.post(
      APITXT_PAN_URL,
      {
        authkey: authKey,
        pan: panClean,
        name: nameClean,
        dob: dobClean,
      },
      { headers: { 'Content-Type': 'application/json' }, timeout: 20000 }
    );
    raw = response.data;
  } catch (err) {
    console.error('[PAN Verify] HTTP error:', err.message);
    throw new Error('PAN verification service temporarily unavailable. Please try again later.');
  }

  if (raw?.status !== 200 || raw?.message !== 'success') {
    const errDesc = APITXT_PAN_ERRORS[raw?.status] || raw?.message || `API error ${raw?.status}`;

    return {
      success: false, verified: false,
      panNumber: null, fullName: null, category: null, dob: null, dobMySQL: null,
      gender: null, mobileNo: null, email: null, address: null,
      requestId: raw?.request_id || null, message: errDesc,
      errorCode: raw?.status || null, raw,
    };
  }

  const d = raw?.data || {};

  return {
    success: true,
    verified: !!d.verified,
    panStatus: d.status || null,      // e.g. "valid" | "invalid" | "deactivated"
    name_match: d.name_match,         // true | false | null
    dob_match: d.dob_match,           // true | false | null
    panNumber: d.pan || panClean,
    fullName: d.full_name || null,    // only from API — never fall back to submitted name
    category: d.category || 'individual',
    dob: dobClean,
    dobMySQL: convertDobToMySQL(dobClean),
    requestId: raw.request_id || null,
    message: d.message || null,
    errorCode: null,
    raw,
  };
};

// A PAN status from QuickeKYC that means the card must not be used. Anything
// else ("valid", "Existing and Valid", no status at all) does not block.
const BLOCKED_PAN_STATUS = /invalid|deactivat|delet|fake|surrender|cancel/i;

/**
 * The same check through QuickeKYC. Its PAN endpoint takes only the PAN and
 * answers with the holder's details, so name and date of birth are compared
 * here: the name with the same rule as the bank account holder (compareName),
 * the date exactly. Same result shape as the APItxt path.
 */
// PAN Advance may also give the date of birth; the basic PAN check gives the
// name only (pan_number, full_name, category — seen 2026-10-28). Advance is
// tried first; while QuickeKYC says it is not enabled on the account
// (quickekyc.js remembers that for an hour) the basic check is used.
const lookupPan = async (panClean) => {
  const opts = { label: 'PAN verification', timeout: 20000 };
  try {
    return await quickekyc.call('/pan/pan_advance', { id_number: panClean }, opts);
  } catch (err) {
    if (!err.notAllowed) throw err;
    return quickekyc.call('/pan/pan', { id_number: panClean }, opts);
  }
};

const verifyPanQuickeKyc = async ({ panClean, nameClean, dobClean }) => {
  const r = await lookupPan(panClean);

  if (!r.ok) {
    return {
      success: false, verified: false,
      panNumber: null, fullName: null, category: null, dob: null, dobMySQL: null,
      gender: null, mobileNo: null, email: null, address: null,
      requestId: r.requestId, message: r.message || 'PAN could not be verified. Please check the PAN number.',
      errorCode: r.statusCode, raw: r.raw,
    };
  }

  const d = r.data;
  const fullName = quickekyc.pick(d, 'full_name', 'name', 'registered_name', 'name_on_card');
  const panDob = quickekyc.toYmd(quickekyc.pick(d, 'dob', 'date_of_birth'));
  const typedDob = convertDobToMySQL(dobClean);
  const status = quickekyc.pick(d, 'pan_status', 'status');
  const blocked = typeof status === 'string' && BLOCKED_PAN_STATUS.test(status);

  if (!panDob) console.warn('[PAN Verify] QuickeKYC gave no date of birth for request', r.requestId || '');

  return {
    success: true,
    verified: !!fullName,
    panStatus: blocked ? status.toLowerCase() : 'valid',
    name_match: fullName ? compareName(fullName, nameClean).match : false,
    dob_match: panDob ? panDob === typedDob : null,
    // QuickeKYC did not say the date of birth, so there was nothing to compare
    dobUnchecked: !panDob,
    panNumber: quickekyc.pick(d, 'pan_number', 'pan', 'id_number') || panClean,
    fullName: fullName || null,
    category: quickekyc.pick(d, 'category') || 'individual',
    dob: dobClean,
    dobMySQL: typedDob,
    gender: quickekyc.pick(d, 'gender'),
    requestId: r.requestId,
    message: fullName ? null : 'PAN details could not be read. Please try again.',
    errorCode: null,
    raw: r.raw,
  };
};

module.exports = { verifyPAN, parseDobToMySQL: convertDobToMySQL };
