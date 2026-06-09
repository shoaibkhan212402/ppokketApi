const axios = require('axios');

const PAN_VERIFY_BASE_URL = process.env.PAN_VERIFY_BASE_URL || 'https://apitxt.com/api/panVerify';
const PAN_VERIFY_AUTH_KEY = process.env.PAN_VERIFY_AUTH_KEY || '';

/**
 * Error code map from apitxt PAN Verification API
 */
const API_ERROR_CODES = {
  105: 'Missing Authentication Key.',
  106: 'Missing PAN number.',
  107: 'Missing name (as per PAN).',
  108: 'Missing date of birth.',
  206: 'Invalid PAN format. Must be ABCDE1234F.',
  207: 'Invalid date of birth format. Must be DD/MM/YYYY.',
  301: 'Insufficient wallet balance. Please recharge your API account.',
  304: 'Invalid Authentication Key or IP Restricted.',
  310: 'Verification failed due to vendor/gateway error.',
};

/**
 * Format a MySQL/JS Date to DD/MM/YYYY required by the API
 * @param {Date|string} dob
 * @returns {string} formatted date or empty string on failure
 */
const formatDob = (dob) => {
  if (!dob) return '';
  const d = new Date(dob);
  if (isNaN(d.getTime())) return '';
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();
  return `${day}/${month}/${year}`;
};

/**
 * Verify a PAN card using the apitxt.com gateway.
 *
 * @param {Object} params
 * @param {string} params.pan       - 10-character PAN (e.g. ABCDE1234F)
 * @param {string} params.name      - Name as on PAN card
 * @param {string|Date} params.dob  - Date of birth (JS Date, ISO string, or DD/MM/YYYY)
 *
 * @returns {Promise<{
 *   success: boolean,
 *   verified: boolean,
 *   status: string,
 *   category: string,
 *   fullName: string|null,
 *   nameMatch: boolean,
 *   dobMatch: boolean,
 *   aadhaarSeedingStatus: string,
 *   requestId: string,
 *   message: string|null,
 *   errorCode: number|null,
 *   raw: Object
 * }>}
 */
const verifyPAN = async ({ pan, name, dob }) => {
  const authKey = PAN_VERIFY_AUTH_KEY;
  if (!authKey) {
    throw new Error('PAN_VERIFY_AUTH_KEY is not configured in .env');
  }

  // Normalize inputs
  const panClean = (pan || '').trim().toUpperCase();
  const nameClean = (name || '').trim();

  // Accept DD/MM/YYYY directly or format from Date/ISO
  const dobFormatted = /^\d{2}\/\d{2}\/\d{4}$/.test(dob)
    ? dob
    : formatDob(dob);

  if (!panClean) throw new Error('PAN number is required for verification.');
  if (!nameClean) throw new Error('Name is required for PAN verification.');
  if (!dobFormatted) throw new Error('Valid date of birth is required for PAN verification.');

  let rawResponse;
  try {
    const response = await axios.post(
      PAN_VERIFY_BASE_URL,
      { authkey: authKey, pan: panClean, name: nameClean, dob: dobFormatted },
      { headers: { 'Content-Type': 'application/json' }, timeout: 15000 }
    );
    rawResponse = response.data;
  } catch (err) {
    const statusCode = err.response?.status;
    const apiBody = err.response?.data;
    console.error('[PAN Verify] HTTP error:', statusCode, apiBody || err.message);

    if (process.env.NODE_ENV === 'development') {

      return {
        success: true,
        verified: true,
        status: 'valid',
        category: 'individual',
        fullName: nameClean.toUpperCase(),
        nameMatch: true,
        dobMatch: true,
        aadhaarSeedingStatus: 'y',
        requestId: `PAN-MOCK-${Date.now()}`,
        message: null,
        errorCode: null,
        raw: { mock: true, error: err.message },
      };
    }
    throw new Error('PAN verification service is temporarily unavailable. Please try again later.');
  }

  const httpStatus = rawResponse?.status;
  const data = rawResponse?.data || {};
  const requestId = rawResponse?.request_id || null;

  // Handle known API error codes
  if (httpStatus !== 200) {
    const errorDesc = API_ERROR_CODES[httpStatus] || rawResponse?.message || `API error code ${httpStatus}`;

    if (process.env.NODE_ENV === 'development') {

      return {
        success: true,
        verified: true,
        status: 'valid',
        category: 'individual',
        fullName: nameClean.toUpperCase(),
        nameMatch: true,
        dobMatch: true,
        aadhaarSeedingStatus: 'y',
        requestId: requestId || `PAN-MOCK-${Date.now()}`,
        message: null,
        errorCode: null,
        raw: rawResponse,
      };
    }

    return {
      success: false,
      verified: false,
      status: 'error',
      category: null,
      fullName: null,
      nameMatch: false,
      dobMatch: false,
      aadhaarSeedingStatus: null,
      requestId,
      message: errorDesc,
      errorCode: httpStatus,
      raw: rawResponse,
    };
  }

  const verified = !!(data.verified && data.status === 'valid');
  const nameMatch = !!data.name_match;
  const dobMatch = !!data.dob_match;

  // Build human-readable rejection reason if not verified
  let message = null;
  if (!verified) {
    if (!nameMatch && !dobMatch) message = 'Name and date of birth do not match PAN records.';
    else if (!nameMatch) message = 'Name does not match PAN records.';
    else if (!dobMatch) message = 'Date of birth does not match PAN records.';
    else message = data.message || 'PAN card could not be verified.';
  }


  return {
    success: true,
    verified,
    status: data.status || 'unknown',
    category: data.category || null,
    fullName: data.full_name || null,
    nameMatch,
    dobMatch,
    aadhaarSeedingStatus: data.aadhaar_seeding_status || null,
    requestId,
    message,
    errorCode: null,
    raw: rawResponse,
  };
};

module.exports = { verifyPAN, formatDob };

