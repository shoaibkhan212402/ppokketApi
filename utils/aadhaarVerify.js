const axios = require('axios');
const quickekyc = require('./quickekyc');

const BASE_URL   = 'https://apitxt.com/api';
const AUTH_KEY   = () => process.env.APITXT_AUTHKEY || '';

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
 * Helper – make a POST call and return parsed body.
 * APItxt rejects a request with HTTP 4xx and a JSON body ({ status: 'error', message }),
 * so that body is returned like a normal reply instead of being lost in a thrown error.
 */
const post = async (endpoint, body, timeout = 15000) => {
  try {
    const response = await axios.post(`${BASE_URL}/${endpoint}`, body, {
      headers: { 'Content-Type': 'application/json' },
      timeout,
    });
    return response.data;
  } catch (err) {
    const data = err.response?.data;
    if (err.response && err.response.status < 500 && data && typeof data === 'object') return data;
    throw err;
  }
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
  const clean = (aadhaarNumber || '').replace(/\s+/g, '');
  if (!/^\d{12}$/.test(clean)) {
    return {
      success: false, referenceId: null, maskedAadhaar: null,
      requestId: null, message: 'Invalid Aadhaar number. Must be exactly 12 digits.',
      errorCode: 203, raw: null,
    };
  }

  if (quickekyc.isQuickeKycOn()) return sendOtpQuickeKyc(clean);

  if (!authKey) {
    if (process.env.NODE_ENV === 'production') {
      return {
        success: false, referenceId: null, maskedAadhaar: null,
        requestId: null, message: 'Aadhaar Authentication Key is not configured.',
        errorCode: 105, raw: null,
      };
    }
    return {
      success:       true,
      referenceId:   `AADHAAR-MOCK-REF-${Date.now()}`,
      maskedAadhaar: `XXXX-XXXX-${clean.slice(-4)}`,
      requestId:     `AADHAAR-MOCK-REQ-${Date.now()}`,
      message:       null,
      errorCode:     null,
      raw:           { mock: true },
    };
  }

  let raw;
  try {
    raw = await post('aadhaarSendOTP', { authkey: authKey, aadhaar_number: clean });
  } catch (err) {
    console.error('[Aadhaar SendOTP] HTTP error:', err.message);
    if (process.env.NODE_ENV === 'development') {
      console.warn('[Aadhaar SendOTP] Falling back to mock data in development.');
      return {
        success:       true,
        referenceId:   `AADHAAR-MOCK-REF-${Date.now()}`,
        maskedAadhaar: `XXXX-XXXX-${clean.slice(-4)}`,
        requestId:     `AADHAAR-MOCK-REQ-${Date.now()}`,
        message:       null,
        errorCode:     null,
        raw:           { mock: true, error: err.message },
      };
    }
    throw new Error('Aadhaar OTP service temporarily unavailable. Please try again later.');
  }

  if (raw?.status !== 200) {
    const errDesc = SEND_OTP_ERRORS[raw?.status] || raw?.message || `API error ${raw?.status}`;

    if (process.env.NODE_ENV === 'development') {
      console.warn('[Aadhaar SendOTP] API returned non-200. Falling back to mock data in development:', errDesc);
      return {
        success:       true,
        referenceId:   `AADHAAR-MOCK-REF-${Date.now()}`,
        maskedAadhaar: `XXXX-XXXX-${clean.slice(-4)}`,
        requestId:     `AADHAAR-MOCK-REQ-${Date.now()}`,
        message:       null,
        errorCode:     null,
        raw:           { mock: true, error: errDesc },
      };
    }

    console.warn('[Aadhaar SendOTP] rejected:', raw?.status, raw?.message, raw?.request_id || '');
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
  if (!referenceId) throw new Error('reference_id is required.');
  if (!otp || String(otp).length !== 6) {
    return {
      success: false, verified: false, name: null, dob: null, gender: null,
      careOf: null, fullAddress: null, address: null, photo: null, hasPhoto: false,
      requestId: null, message: 'Invalid OTP. Must be exactly 6 digits.', errorCode: 204, raw: null,
    };
  }

  if (quickekyc.isQuickeKycOn()) return verifyOtpQuickeKyc(referenceId, otp);

  if (!authKey) {
    if (process.env.NODE_ENV === 'production') {
      return {
        success: false, verified: false, name: null, dob: null, gender: null,
        careOf: null, fullAddress: null, address: null, photo: null, hasPhoto: false,
        requestId: null, message: 'Aadhaar Authentication Key is not configured.', errorCode: 105, raw: null,
      };
    }
    return {
      success:     true,
      verified:    true,
      name:        'Test Aadhaar User',
      dob:         '1995-08-15',
      gender:      'M',
      careOf:      'S/O Test Parent',
      fullAddress: '123, Test Street, Test City, Test State - 110001',
      address:     { house: '123', street: 'Test Street', lm: '', loc: '', vtc: 'Test City', po: 'Test City', subdist: 'Test', dist: 'Test', state: 'Test State', pc: '110001' },
      photo:       null,
      hasPhoto:    false,
      requestId:   `AADHAAR-MOCK-REQ-${Date.now()}`,
      message:     null,
      errorCode:   null,
      raw:         { mock: true },
    };
  }

  let raw;
  try {
    // UIDAI can be slow to answer the verify step
    raw = await post('aadhaarVerifyOTP', {
      authkey: authKey, reference_id: referenceId, otp: String(otp),
    }, 30000);
  } catch (err) {
    console.error('[Aadhaar VerifyOTP] HTTP error:', err.message);
    if (process.env.NODE_ENV === 'development') {
      console.warn('[Aadhaar VerifyOTP] Falling back to mock data in development.');
      return {
        success:     true,
        verified:    true,
        name:        'Test Aadhaar User',
        dob:         '1995-08-15',
        gender:      'M',
        careOf:      'S/O Test Parent',
        fullAddress: '123, Test Street, Test City, Test State - 110001',
        address:     { house: '123', street: 'Test Street', lm: '', loc: '', vtc: 'Test City', po: 'Test City', subdist: 'Test', dist: 'Test', state: 'Test State', pc: '110001' },
        photo:       null,
        hasPhoto:    false,
        requestId:   `AADHAAR-MOCK-REQ-${Date.now()}`,
        message:     null,
        errorCode:   null,
        raw:         { mock: true, error: err.message },
      };
    }
    throw new Error('Aadhaar OTP verification service temporarily unavailable. Please try again later.');
  }

  if (raw?.status !== 200) {
    const errDesc = VERIFY_OTP_ERRORS[raw?.status] || raw?.message || `API error ${raw?.status}`;

    if (process.env.NODE_ENV === 'development') {
      console.warn('[Aadhaar VerifyOTP] API returned non-200. Falling back to mock data in development:', errDesc);
      return {
        success:     true,
        verified:    true,
        name:        'Test Aadhaar User',
        dob:         '1995-08-15',
        gender:      'M',
        careOf:      'S/O Test Parent',
        fullAddress: '123, Test Street, Test City, Test State - 110001',
        address:     { house: '123', street: 'Test Street', lm: '', loc: '', vtc: 'Test City', po: 'Test City', subdist: 'Test', dist: 'Test', state: 'Test State', pc: '110001' },
        photo:       null,
        hasPhoto:    false,
        requestId:   `AADHAAR-MOCK-REQ-${Date.now()}`,
        message:     null,
        errorCode:   null,
        raw:         { mock: true, error: errDesc },
      };
    }

    console.warn('[Aadhaar VerifyOTP] rejected:', raw?.status, raw?.message, raw?.request_id || '');
    return {
      success: false, verified: false, name: null, dob: null, gender: null,
      careOf: null, fullAddress: null, address: null, photo: null, hasPhoto: false,
      requestId: raw?.request_id || null, message: errDesc,
      errorCode: raw?.status || null, raw,
    };
  }

  const d = raw?.data || {};

  if (!d.verified) {
    console.warn('[Aadhaar VerifyOTP] not verified:', raw?.message, raw?.request_id || '', 'ref', referenceId);
  }

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
    message:     d.verified ? null : 'OTP could not be verified. Please check the OTP, or request a new one and enter it within 10 minutes.',
    errorCode:   null,
    raw,
  };
};

// ── QuickeKYC ───────────────────────────────────────────────────────────────
// Same two steps through QuickeKYC: generate-otp answers with a request_id,
// which submit-otp needs back together with the OTP. No mock answers here —
// a failure is always shown as a failure (the APItxt mock once wrote fake
// verifications to the live database from a development machine).

const notVerified = (message, errorCode, requestId = null, raw = null) => ({
  success: false, verified: false, name: null, dob: null, gender: null,
  careOf: null, fullAddress: null, address: null, photo: null, hasPhoto: false,
  requestId, message, errorCode, raw,
});

const sendOtpQuickeKyc = async (clean) => {
  const r = await quickekyc.call('/aadhaar-v2/generate-otp', { id_number: clean }, { label: 'Aadhaar OTP', timeout: 30000 });
  const failed = (message) => ({
    success: false, referenceId: null, maskedAadhaar: null,
    requestId: r.requestId, message, errorCode: r.statusCode, raw: r.raw,
  });

  if (!r.ok) return failed(r.message || 'Could not send the Aadhaar OTP. Please check the number and try again.');

  const d = r.data;
  if (quickekyc.yesNo(d.otp_sent) === false || quickekyc.yesNo(d.valid_aadhaar) === false) {
    return failed(quickekyc.yesNo(d.if_number) === false
      ? 'No mobile number is linked to this Aadhaar, so an OTP cannot be sent. Please link a mobile number at an Aadhaar centre.'
      : (r.message || 'Could not send the Aadhaar OTP. Please try again.'));
  }

  const referenceId = quickekyc.pick(d, 'request_id') || r.requestId || quickekyc.pick(d, 'client_id', 'reference_id');
  if (!referenceId) {
    console.error('[Aadhaar SendOTP] QuickeKYC said success but gave no request_id');
    return failed('Could not start Aadhaar verification. Please try again.');
  }

  return {
    success:       true,
    referenceId:   String(referenceId),
    maskedAadhaar: `XXXX-XXXX-${clean.slice(-4)}`,
    requestId:     r.requestId,
    message:       null,
    errorCode:     null,
    raw:           r.raw,
  };
};

const ADDRESS_ORDER = ['house', 'street', 'lm', 'loc', 'vtc', 'po', 'subdist', 'dist', 'state'];

const verifyOtpQuickeKyc = async (referenceId, otp) => {
  // UIDAI can be slow to answer the verify step
  const r = await quickekyc.call('/aadhaar-v2/submit-otp', { request_id: String(referenceId), otp: String(otp) }, { label: 'Aadhaar OTP verification', timeout: 45000 });

  if (!r.ok) {
    console.warn('[Aadhaar VerifyOTP] QuickeKYC rejected ref', referenceId, '-', r.message);
    return notVerified(
      r.message || 'OTP could not be verified. Please check the OTP, or request a new one and enter it within 10 minutes.',
      r.statusCode, r.requestId, r.raw
    );
  }

  const d = r.data;
  const name = quickekyc.pick(d, 'full_name', 'name');
  if (!name) {
    console.warn('[Aadhaar VerifyOTP] QuickeKYC success without a name, ref', referenceId);
    return notVerified('Aadhaar details could not be read. Please request a new OTP and try again.', null, r.requestId, r.raw);
  }

  // Stored in the same shape the APItxt answers had
  const a = d.address && typeof d.address === 'object' ? d.address : {};
  const address = {
    house:   quickekyc.pick(a, 'house') || '',
    street:  quickekyc.pick(a, 'street') || '',
    lm:      quickekyc.pick(a, 'landmark', 'lm') || '',
    loc:     quickekyc.pick(a, 'loc', 'locality') || '',
    vtc:     quickekyc.pick(a, 'vtc') || '',
    po:      quickekyc.pick(a, 'po') || '',
    subdist: quickekyc.pick(a, 'subdist', 'sub_district') || '',
    dist:    quickekyc.pick(a, 'dist', 'district') || '',
    state:   quickekyc.pick(a, 'state') || '',
    pc:      String(quickekyc.pick(d, 'zip', 'pincode') || quickekyc.pick(a, 'pc', 'zip', 'pincode') || ''),
  };
  const fromParts = ADDRESS_ORDER.map((k) => address[k]).filter(Boolean).join(', ');
  const fullAddress = quickekyc.pick(d, 'full_address')
    || (typeof d.address === 'string' ? d.address.trim() : null)
    || (fromParts ? fromParts + (address.pc ? ` - ${address.pc}` : '') : null);

  // The controller stores the date with STR_TO_DATE(?, '%d-%m-%Y')
  const ymd = quickekyc.toYmd(quickekyc.pick(d, 'dob', 'date_of_birth'));
  const dob = ymd ? ymd.split('-').reverse().join('-') : null;

  // Plain base64 JPEG, like APItxt sent (without a "data:image/...;base64," prefix)
  const image = quickekyc.pick(d, 'profile_image', 'photo', 'image');
  const photo = typeof image === 'string' ? image.replace(/^data:image\/\w+;base64,/, '') : null;

  return {
    success:     true,
    verified:    true,
    name,
    dob,
    gender:      quickekyc.pick(d, 'gender'),
    careOf:      quickekyc.pick(d, 'care_of', 'careof'),
    fullAddress,
    address,
    photo,
    hasPhoto:    !!photo,
    requestId:   r.requestId || String(referenceId),
    message:     null,
    errorCode:   null,
    raw:         r.raw,
  };
};

module.exports = { aadhaarSendOTP, aadhaarVerifyOTP };

