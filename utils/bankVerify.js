const axios = require('axios');

const BASE_URL = 'https://apitxt.com/api';
const AUTH_KEY = () => process.env.APITXT_AUTHKEY || '';

const PENNY_DROP_ERRORS = {
  105: 'Missing Authentication Key.',
  109: 'Missing IFSC code.',
  110: 'Missing bank account number.',
  208: 'Invalid IFSC code format.',
  210: 'Invalid bank account number.',
  211: 'Invalid mobile number.',
  212: 'Bank account not found at the supplied IFSC.',
  301: 'Insufficient wallet balance. Please recharge your API account.',
  304: 'Invalid Authentication Key or IP Restricted.',
  310: 'Bank verification failed (vendor/gateway error). Please try again.',
};

/**
 * Normalise a name for comparison:
 *   - uppercase, strip non-alpha chars, collapse spaces
 */
const normName = (s) =>
  (s || '').toUpperCase().replace(/[^A-Z\s]/g, '').replace(/\s+/g, ' ').trim();

/**
 * Token-based name similarity.
 * Returns { match: boolean, confidence: 'exact'|'token'|'none' }
 *
 * Rules:
 *  exact  – normalised strings are identical
 *  token  – every token of the *shorter* name is present in the *longer* name
 *           AND both first-word and last-word of the submitted name are found in the bank name
 *  none   – neither condition met
 */
const compareName = (bankName, submittedName) => {
  const bank = normName(bankName);
  const sub  = normName(submittedName);

  if (!bank || !sub) return { match: false, confidence: 'none' };
  if (bank === sub)  return { match: true,  confidence: 'exact' };

  const bankTokens = bank.split(' ').filter(Boolean);
  const subTokens  = sub.split(' ').filter(Boolean);

  const [shorter, longer] =
    subTokens.length <= bankTokens.length
      ? [subTokens, bankTokens]
      : [bankTokens, subTokens];

  const allTokensPresent = shorter.every(t => longer.includes(t));

  // Also require that the first and last tokens of the submitted name appear in the bank name
  const subFirst = subTokens[0];
  const subLast  = subTokens[subTokens.length - 1];
  const anchorOk = bankTokens.includes(subFirst) && bankTokens.includes(subLast);

  if (allTokensPresent && anchorOk) return { match: true, confidence: 'token' };
  return { match: false, confidence: 'none' };
};

/**
 * Verify bank account via APItxt Penny Drop API.
 */
const verifyBankAccount = async ({ ifsc, accountNumber, name, mobile, useCache = false }) => {
  const authKey   = AUTH_KEY();
  const ifscClean = (ifsc || '').trim().toUpperCase();
  const accClean  = (accountNumber || '').trim().replace(/\s+/g, '');

  if (!ifscClean) {
    return { success: false, verified: false, accountExists: false, message: 'IFSC code is required.', errorCode: 109 };
  }
  if (!accClean) {
    return { success: false, verified: false, accountExists: false, message: 'Account number is required.', errorCode: 110 };
  }
  if (!authKey) {
    return {
      success: false, verified: false, accountExists: false,
      message: 'Bank Verification service is not configured. Please contact support.',
      errorCode: 105,
    };
  }

  let raw;
  try {
    const url    = `${BASE_URL}/bank/${ifscClean}/accounts/${accClean}/verify`;
    const params = { authkey: authKey, use_cache: useCache ? 'true' : 'false' };
    if (name)   params.name   = name;
    if (mobile) params.mobile = mobile;

    const response = await axios.get(url, { params, timeout: 25000 });
    raw = response.data;
  } catch (err) {
    console.error('[Bank Verify] HTTP error:', err.message);
    throw new Error('Bank verification service temporarily unavailable. Please try again later.');
  }

  if (raw?.status !== 200) {
    const errDesc = PENNY_DROP_ERRORS[raw?.status] || raw?.message || `API error ${raw?.status}`;
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
    nameAtBank:      d.name_at_bank     || null,   // real name from bank — never fall back
    utr:             d.utr              || null,
    amountDeposited: d.amount_deposited || null,
    requestId:       raw.request_id     || null,
    message:         d.message          || null,
    errorCode:       null,
    raw,
  };
};

const IFSC_ERRORS = {
  105: 'Missing Authentication Key.',
  109: 'Missing IFSC code.',
  208: 'Invalid IFSC format.',
  209: 'IFSC not found — this bank branch does not exist.',
  301: 'Insufficient wallet balance.',
  304: 'Invalid Authentication Key or IP Restricted.',
  310: 'IFSC verification failed (vendor error). Please try again.',
};

/**
 * Verify an IFSC code via APItxt and return full branch details.
 */
const verifyIFSC = async (ifsc) => {
  const authKey   = AUTH_KEY();
  const ifscClean = (ifsc || '').trim().toUpperCase();

  if (!ifscClean) {
    return { success: false, message: 'IFSC code is required.', errorCode: 109 };
  }
  if (!authKey) {
    return { success: false, message: 'IFSC Verification service is not configured.', errorCode: 105 };
  }

  let raw;
  try {
    const response = await axios.get(`${BASE_URL}/bank/${ifscClean}`, {
      params: { authkey: authKey },
      timeout: 15000,
    });
    raw = response.data;
  } catch (err) {
    console.error('[IFSC Verify] HTTP error:', err.message);
    throw new Error('IFSC verification service temporarily unavailable. Please try again later.');
  }

  if (raw?.status !== 200) {
    const errDesc = IFSC_ERRORS[raw?.status] || raw?.message || `API error ${raw?.status}`;
    return { success: false, message: errDesc, errorCode: raw?.status || null, raw };
  }

  const d = raw?.data || {};
  return {
    success:    true,
    ifsc:       d.ifsc       || ifscClean,
    bank:       d.bank       || null,
    bankCode:   d.bankcode   || null,
    branch:     d.branch     || null,
    address:    d.address    || null,
    city:       d.city       || null,
    district:   d.district   || null,
    state:      d.state      || null,
    contact:    d.contact    || null,
    micr:       d.micr       || null,
    swift:      d.swift      || null,
    neft:       !!d.neft,
    rtgs:       !!d.rtgs,
    imps:       !!d.imps,
    upi:        !!d.upi,
    requestId:  raw.request_id || null,
    message:    d.message    || null,
    raw,
  };
};

module.exports = { verifyBankAccount, verifyIFSC, compareName, normName };
