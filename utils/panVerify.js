const axios = require('axios');

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

module.exports = { verifyPAN, parseDobToMySQL: convertDobToMySQL };
