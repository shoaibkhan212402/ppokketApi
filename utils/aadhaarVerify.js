const axios = require('axios');

const BASE_URL   = 'https://apitxt.com/api';
const AUTH_KEY   = () => process.env.PAN_VERIFY_AUTH_KEY || '';

/**
 * Error code maps
 */
const SEND_OTP_ERRORS = {
  102: 'Missing Aadhaar number.',
  105: 'Missing Authentication Key.',
  203: 'Invalid Aadhaar number. Must be exactly 12 digits.',
  301: 'Insufficient wallet balance. Please recharge your API account.',
  304: 'Invalid Authentication Key or IP Restricted.',
  310: 'Aadhaar OTP request failed (vendor/gateway error). Please try again.',
};

const VERIFY_OTP_ERRORS = {
  103: 'Missing reference_id from OTP step.',
  104: 'Missing OTP.',
  105: 'Missing Authentication Key.',
  204: 'Invalid OTP. Must be exactly 6 digits.',
  301: 'Insufficient wallet balance. Please recharge your API account.',
  304: 'Invalid Authentication Key or IP Restricted.',
  310: 'OTP verification failed (wrong OTP or vendor error).',
};

/**
 * Helper – make a POST call and return parsed body
 */
const post = async (endpoint, body) => {
  const response = await axios.post(`${BASE_URL}/${endpoint}`, body, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 15000,
  });
  return response.data;
};

/**
 * Step 1 – Send OTP to the mobile linked with an Aadhaar number.
 *
 * @param {string} aadhaarNumber  12-digit Aadhaar number
 * @returns {Promise<{
 *   success: boolean,
 *   referenceId: string|null,
 *   maskedAadhaar: string|null,
 *   requestId: string|null,
 *   message: string|null,
 *   errorCode: number|null,
 *   raw: object
 * }>}
 */
const aadhaarSendOTP = async (aadhaarNumber) => {
  const authKey = AUTH_KEY();
  if (!authKey) throw new Error('PAN_VERIFY_AUTH_KEY not configured in .env');

  const clean = (aadhaarNumber || '').replace(/\s+/g, '');
  if (!/^\d{12}$/.test(clean)) {
    return {
      success: false, referenceId: null, maskedAadhaar: null,
      requestId: null, message: 'Invalid Aadhaar number. Must be exactly 12 digits.',
      errorCode: 203, raw: null,
    };
  }

  let raw;
  try {
    raw = await post('aadhaarSendOTP', { authkey: authKey, aadhaar_number: clean });
  } catch (err) {
    console.error('[Aadhaar SendOTP] HTTP error:', err.message);
    throw new Error('Aadhaar OTP service temporarily unavailable. Please try again later.');
  }

  if (raw?.status !== 200) {
    const errDesc = SEND_OTP_ERRORS[raw?.status] || raw?.message || `API error ${raw?.status}`;

    return {
      success: false, referenceId: null, maskedAadhaar: null,
      requestId: raw?.request_id || null, message: errDesc,
      errorCode: raw?.status || null, raw,
    };
  }


  return {
    success:       true,
    referenceId:   raw.data?.reference_id   || null,
    maskedAadhaar: raw.data?.masked_aadhaar || null,
    requestId:     raw.request_id           || null,
    message:       null,
    errorCode:     null,
    raw,
  };
};

/**
 * Step 2 – Verify the OTP and get full Aadhaar KYC data.
 *
 * @param {string} referenceId   Reference ID from the Send OTP step
 * @param {string} otp           6-digit OTP entered by the user
 * @returns {Promise<{
 *   success: boolean,
 *   verified: boolean,
 *   name: string|null,
 *   dob: string|null,
 *   gender: string|null,
 *   careOf: string|null,
 *   fullAddress: string|null,
 *   address: object|null,
 *   photo: string|null,
 *   hasPhoto: boolean,
 *   requestId: string|null,
 *   message: string|null,
 *   errorCode: number|null,
 *   raw: object
 * }>}
 */
const aadhaarVerifyOTP = async (referenceId, otp) => {
  const authKey = AUTH_KEY();
  if (!authKey) throw new Error('PAN_VERIFY_AUTH_KEY not configured in .env');

  if (!referenceId) throw new Error('reference_id is required.');
  if (!otp || String(otp).length !== 6) {
    return {
      success: false, verified: false, name: null, dob: null, gender: null,
      careOf: null, fullAddress: null, address: null, photo: null, hasPhoto: false,
      requestId: null, message: 'Invalid OTP. Must be exactly 6 digits.', errorCode: 204, raw: null,
    };
  }

  let raw;
  try {
    raw = await post('aadhaarVerifyOTP', {
      authkey: authKey, reference_id: referenceId, otp: String(otp),
    });
  } catch (err) {
    console.error('[Aadhaar VerifyOTP] HTTP error:', err.message);
    throw new Error('Aadhaar OTP verification service temporarily unavailable. Please try again later.');
  }

  if (raw?.status !== 200) {
    const errDesc = VERIFY_OTP_ERRORS[raw?.status] || raw?.message || `API error ${raw?.status}`;

    return {
      success: false, verified: false, name: null, dob: null, gender: null,
      careOf: null, fullAddress: null, address: null, photo: null, hasPhoto: false,
      requestId: raw?.request_id || null, message: errDesc,
      errorCode: raw?.status || null, raw,
    };
  }

  const d = raw?.data || {};

  return {
    success:     true,
    verified:    !!d.verified,
    name:        d.name         || null,
    dob:         d.date_of_birth || null,
    gender:      d.gender       || null,
    careOf:      d.care_of      || null,
    fullAddress: d.full_address || null,
    address:     d.address      || null,
    photo:       d.photo        || null,   // base64 JPEG string
    hasPhoto:    !!d.has_photo,
    requestId:   raw.request_id || null,
    message:     null,
    errorCode:   null,
    raw,
  };
};

module.exports = { aadhaarSendOTP, aadhaarVerifyOTP };

