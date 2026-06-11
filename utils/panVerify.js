const axios = require('axios');

const QUICKEKYC_BASE_URL = 'https://api.quickekyc.com/api/v1/pan/pan_advance';
const QUICKEKYC_API_KEY = process.env.QUICKEKYC_API_KEY || '';

/**
 * Parse "DD-MM-YYYY" (quickekyc format) to "YYYY-MM-DD" for MySQL.
 */
const parseDobToMySQL = (dob) => {
  if (!dob) return null;
  const parts = String(dob).trim().split('-');
  if (parts.length !== 3) return null;
  const [d, m, y] = parts;
  if (!d || !m || !y || y.length !== 4) return null;
  return `${y}-${m}-${d}`;
};

/**
 * Fetch PAN holder details from quickekyc.com pan_advance endpoint.
 *
 * @param {Object} params
 * @param {string} params.pan - 10-character PAN (e.g. ABCDE1234F)
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
 *   requestId: number|null,
 *   message: string|null,
 *   raw: Object
 * }>}
 */
const verifyPAN = async ({ pan }) => {
  const apiKey = QUICKEKYC_API_KEY;
  if (!apiKey) {
    throw new Error('QUICKEKYC_API_KEY is not configured in .env');
  }

  const panClean = (pan || '').trim().toUpperCase();
  if (!panClean) throw new Error('PAN number is required for verification.');

  let rawResponse;
  try {
    const response = await axios.post(
      QUICKEKYC_BASE_URL,
      { key: apiKey, id_number: panClean },
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
        panNumber: panClean,
        fullName: 'MOCK USER',
        category: 'individual',
        dob: '01-01-1990',
        dobMySQL: '1990-01-01',
        gender: 'M',
        mobileNo: null,
        email: null,
        address: null,
        requestId: `PAN-MOCK-${Date.now()}`,
        message: null,
        raw: { mock: true, error: err.message },
      };
    }
    throw new Error('PAN verification service is temporarily unavailable. Please try again later.');
  }

  const statusCode = rawResponse?.status_code;
  const status = rawResponse?.status;
  const data = rawResponse?.data || {};
  const requestId = rawResponse?.request_id || null;

  if (statusCode !== 200 || status !== 'success') {
    const errorMsg = rawResponse?.message || `PAN verification failed (code: ${statusCode})`;

    if (process.env.NODE_ENV === 'development') {
      return {
        success: true,
        verified: true,
        panNumber: panClean,
        fullName: 'MOCK USER',
        category: 'individual',
        dob: '01-01-1990',
        dobMySQL: '1990-01-01',
        gender: 'M',
        mobileNo: null,
        email: null,
        address: null,
        requestId: requestId || `PAN-MOCK-${Date.now()}`,
        message: null,
        raw: rawResponse,
      };
    }

    return {
      success: false,
      verified: false,
      panNumber: null,
      fullName: null,
      category: null,
      dob: null,
      dobMySQL: null,
      gender: null,
      mobileNo: null,
      email: null,
      address: null,
      requestId,
      message: errorMsg,
      raw: rawResponse,
    };
  }

  const dobMySQL = parseDobToMySQL(data.dob);

  const address = {
    line1: data.address_line_1 || null,
    line2: data.address_line_2 || null,
    line3: data.address_line_3 || null,
    line4: data.address_line_4 || null,
    line5: data.address_line_5 || null,
    subDist: data.sub_dist || null,
    dist: data.dist || null,
    state: data.state || null,
    pincode: data.pincode || null,
  };

  return {
    success: true,
    verified: true,
    panNumber: data.pan_number || panClean,
    fullName: data.full_name || null,
    category: data.category || null,
    dob: data.dob || null,
    dobMySQL,
    gender: data.gender || null,
    mobileNo: data.mobile_no || null,
    email: data.email || null,
    address,
    requestId,
    message: null,
    raw: rawResponse,
  };
};

module.exports = { verifyPAN, parseDobToMySQL };
