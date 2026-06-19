const axios = require('axios');

const BASE_URL   = 'https://apitxt.com/api';
const AUTH_KEY   = () => process.env.APITXT_AUTHKEY || '';

const PENNY_DROP_ERRORS = {
  105: 'Missing Authentication Key.',
  109: 'Missing IFSC code.',
  110: 'Missing bank account number.',
  208: 'Invalid IFSC. Must start with 4 letters followed by 7 or 8 alphanumeric characters.',
  210: 'Invalid bank account number.',
  211: 'Invalid mobile.',
  212: 'Bank account not found at the supplied IFSC.',
  301: 'Insufficient wallet balance. Please recharge your API account.',
  304: 'Invalid Authentication Key or IP Restricted.',
  310: 'Bank verification failed (vendor/gateway error). Please try again.',
};

/**
 * Verify bank account via APItxt Penny Drop API
 *
 * @param {Object} params
 * @param {string} params.ifsc
 * @param {string} params.accountNumber
 * @param {string} [params.name]
 * @param {string} [params.mobile]
 * @param {boolean} [params.useCache=false]
 *
 * @returns {Promise<{
 *   success: boolean,
 *   verified: boolean,
 *   ifsc: string|null,
 *   accountNumber: string|null,
 *   accountExists: boolean,
 *   nameAtBank: string|null,
 *   utr: string|null,
 *   amountDeposited: string|null,
 *   requestId: string|null,
 *   message: string|null,
 *   errorCode: number|null,
 *   raw: object
 * }>}
 */
const verifyBankAccount = async ({ ifsc, accountNumber, name, mobile, useCache = false }) => {
  const authKey = AUTH_KEY();
  const ifscClean = (ifsc || '').trim().toUpperCase();
  const accClean  = (accountNumber || '').trim().replace(/\s+/g, '');

  if (!ifscClean) {
    return {
      success: false, verified: false, accountExists: false,
      message: 'IFSC code is required.', errorCode: 109,
    };
  }
  if (!accClean) {
    return {
      success: false, verified: false, accountExists: false,
      message: 'Account number is required.', errorCode: 110,
    };
  }

  if (!authKey) {
    if (process.env.NODE_ENV === 'production') {
      return {
        success: false, verified: false, accountExists: false,
        message: 'Bank Verification Authentication Key is not configured.',
        errorCode: 105,
      };
    }
    // Sandbox / Mock fallback in development mode
    return {
      success:         true,
      verified:        true,
      ifsc:            ifscClean,
      accountNumber:   accClean,
      accountExists:   true,
      nameAtBank:      name || 'Test Bank Holder',
      utr:             `UTR${Date.now()}`,
      amountDeposited: "1",
      requestId:       `PNDP-VER-MOCK-${Date.now()}`,
      message:         'Bank Account details verified successfully (Mock).',
      errorCode:       null,
      raw:             { mock: true },
    };
  }

  let raw;
  try {
    const url = `${BASE_URL}/bank/${ifscClean}/accounts/${accClean}/verify`;
    const params = {
      authkey: authKey,
      use_cache: useCache ? 'true' : 'false',
    };
    if (name) params.name = name;
    if (mobile) params.mobile = mobile;

    const response = await axios.get(url, { params, timeout: 25000 });
    raw = response.data;
  } catch (err) {
    console.error('[Bank Verify] HTTP error:', err.message);
    if (process.env.NODE_ENV === 'development') {
      console.warn('[Bank Verify] Falling back to mock data in development.');
      return {
        success:         true,
        verified:        true,
        ifsc:            ifscClean,
        accountNumber:   accClean,
        accountExists:   true,
        nameAtBank:      name || 'Test Bank Holder',
        utr:             `UTR${Date.now()}`,
        amountDeposited: "1",
        requestId:       `PNDP-VER-MOCK-${Date.now()}`,
        message:         'Bank Account details verified successfully (Mock).',
        errorCode:       null,
        raw:             { mock: true, error: err.message },
      };
    }
    throw new Error('Bank verification service temporarily unavailable. Please try again later.');
  }

  if (raw?.status !== 200) {
    const errDesc = PENNY_DROP_ERRORS[raw?.status] || raw?.message || `API error ${raw?.status}`;

    if (process.env.NODE_ENV === 'development') {
      console.warn('[Bank Verify] API returned non-200. Falling back to mock data in development:', errDesc);
      return {
        success:         true,
        verified:        true,
        ifsc:            ifscClean,
        accountNumber:   accClean,
        accountExists:   true,
        nameAtBank:      name || 'Test Bank Holder',
        utr:             `UTR${Date.now()}`,
        amountDeposited: "1",
        requestId:       `PNDP-VER-MOCK-${Date.now()}`,
        message:         'Bank Account details verified successfully (Mock).',
        errorCode:       null,
        raw:             { mock: true, error: errDesc },
      };
    }

    return {
      success: false, verified: false, accountExists: false,
      ifsc: null, accountNumber: null, nameAtBank: null, utr: null, amountDeposited: null,
      requestId: raw?.request_id || null, message: errDesc,
      errorCode: raw?.status || null, raw,
    };
  }

  const d = raw?.data || {};

  return {
    success:         true,
    verified:        !!d.account_exists,
    ifsc:            d.ifsc             || ifscClean,
    accountNumber:   d.account_number   || accClean,
    accountExists:   !!d.account_exists,
    nameAtBank:      d.name_at_bank     || null,
    utr:             d.utr              || null,
    amountDeposited: d.amount_deposited || null,
    requestId:       raw.request_id     || null,
    message:         d.message          || null,
    errorCode:       null,
    raw,
  };
};

module.exports = { verifyBankAccount };
