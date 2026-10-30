const axios = require('axios');

// QuickeKYC (quickekyc.com) — PAN, Aadhaar OTP, bank account and GST checks
// (GST: utils/gstVerify.js).
//
// Switched on with KYC_PROVIDER=quickekyc plus QUICKEKYC_API_KEY. Without the
// switch, PAN / Aadhaar / bank stay on APItxt and a GST number is only
// format-checked, exactly as before. QUICKEKYC_BASE_URL picks live
// (https://api.quickekyc.com, the default) or sandbox (https://sandbox.quickekyc.com);
// each has its own key.
//
// Every endpoint is a JSON POST with the key in the body. Answers come back as
// HTTP 200 with { status_code, status: 'success' | 'error', message, data, request_id };
// a missing or wrong key gets HTTP 401. Endpoints refuse any field they do not
// know ("\"name\" is not allowed"), so only the documented ones are sent.

const DEFAULT_BASE_URL = 'https://api.quickekyc.com';

const apiKey = () => String(process.env.QUICKEKYC_API_KEY || '').trim();
const baseUrl = () => String(process.env.QUICKEKYC_BASE_URL || DEFAULT_BASE_URL).trim().replace(/\/+$/, '');

let warnedNoKey = false;
const isQuickeKycOn = () => {
  if (String(process.env.KYC_PROVIDER || '').trim().toLowerCase() !== 'quickekyc') return false;
  if (apiKey()) return true;
  if (!warnedNoKey) {
    warnedNoKey = true;
    console.warn('[QuickeKYC] KYC_PROVIDER=quickekyc but QUICKEKYC_API_KEY is empty — PAN, Aadhaar and bank checks stay on APItxt.');
  }
  return false;
};

// Codes that mean the service itself failed (key, wallet, rate limit, their
// backend) rather than something about what the customer typed.
const isServiceProblem = (code) => code === 401 || code === 402 || code === 403 || code === 429 || code >= 500;

// Field names of each endpoint's successful reply are logged once (names only,
// never values), so the mapping below can be checked against real answers.
const loggedFields = new Set();

// Each service has to be enabled on the QuickeKYC account; one that is not
// answers "Service not allowed" (seen 2026-10-28 for PAN Advance). Such a
// refusal is remembered for an hour, so customers are not kept waiting on it,
// and callers can fall back (error.notAllowed).
const notAllowedSince = new Map();
const NOT_ALLOWED_RETRY_MS = 60 * 60 * 1000;

/**
 * POST to one endpoint, e.g. call('/pan/pan_advance', { id_number }).
 *
 * Resolves to { ok, statusCode, message, data, requestId, raw } when QuickeKYC
 * answered about the input (ok = true only for status 'success').
 * Throws an Error whose message is safe to show a customer when the service
 * could not answer (network, timeout, bad key, empty wallet, their outage);
 * `error.notAllowed` is set when the service is not enabled on the account,
 * and `error.details` = { provider, path, statusCode, reason, raw } says what
 * went wrong (kept with the check for the super admin — utils/kycChecks.js).
 */
const call = async (path, body, { label = 'Verification', timeout = 30000 } = {}) => {
  const unavailable = (details = {}) => Object.assign(
    new Error(`${label} service is temporarily unavailable. Please try again in a few minutes.`),
    { details: { provider: 'quickekyc', path, ...details } }
  );
  const notAllowed = (details) => Object.assign(unavailable({ reason: 'Service not allowed', ...details }), { notAllowed: true });

  const refusedAt = notAllowedSince.get(path);
  if (refusedAt && Date.now() - refusedAt < NOT_ALLOWED_RETRY_MS) throw notAllowed({ reason: 'Service not allowed (remembered)' });

  let res;
  try {
    res = await axios.post(`${baseUrl()}/api/v1${path}`, { key: apiKey(), ...body }, {
      headers: { 'Content-Type': 'application/json' },
      timeout,
      validateStatus: () => true,
    });
  } catch (err) {
    console.error(`[QuickeKYC] ${path} request failed:`, err.code || err.message);
    throw unavailable({ reason: `No answer: ${err.code || err.message}` });
  }

  const raw = res.data;
  if (!raw || typeof raw !== 'object' || !('status' in raw)) {
    // Not a QuickeKYC answer at all (an HTML 404 page = wrong base URL or path)
    console.error(`[QuickeKYC] ${path} unexpected reply, HTTP ${res.status}`);
    throw unavailable({ statusCode: res.status, reason: `Unexpected reply (HTTP ${res.status})` });
  }

  const statusCode = Number(raw.status_code) || res.status;
  const requestId = raw.request_id != null && raw.request_id !== '' ? String(raw.request_id) : null;
  const ok = statusCode === 200 && raw.status === 'success';

  if (!ok && /service not allowed/i.test(String(raw.message || ''))) {
    notAllowedSince.set(path, Date.now());
    console.error(`[QuickeKYC] ${path} is not enabled on this QuickeKYC account ("${raw.message}") — ask QuickeKYC to enable it.`);
    throw notAllowed({ statusCode, raw });
  }
  if (!ok) {
    console.warn(`[QuickeKYC] ${path} answered ${statusCode}:`, raw.message || '(no message)', requestId || '');
    if (isServiceProblem(statusCode)) throw unavailable({ statusCode, reason: raw.message || `Error ${statusCode}`, raw });
  }
  if (ok) notAllowedSince.delete(path);

  const data = raw.data && typeof raw.data === 'object' ? raw.data : {};
  if (ok && !loggedFields.has(path)) {
    loggedFields.add(path);
    console.info(`[QuickeKYC] ${path} reply fields: ${Object.keys(data).join(', ') || '(none)'}; top level: ${Object.keys(raw).join(', ')}`);
  }

  return { ok, statusCode, message: raw.message || null, data, requestId, raw };
};

// First of `keys` on `obj` that holds a non-empty value (strings trimmed).
const pick = (obj, ...keys) => {
  if (!obj || typeof obj !== 'object') return null;
  for (const key of keys) {
    const value = obj[key];
    if (value === undefined || value === null) continue;
    if (typeof value === 'string') {
      if (value.trim()) return value.trim();
      continue;
    }
    return value;
  }
  return null;
};

// "1990-08-15", "15-08-1990", "15/08/1990", "1990/08/15" or an ISO timestamp
// → "1990-08-15"; anything else → null.
const toYmd = (value) => {
  if (!value) return null;
  const s = String(value).trim();
  let m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return null;
};

// true / "true" / "yes" / 1 → true; false / "false" / "no" / 0 → false; else null.
const yesNo = (value) => {
  if (value === true || value === false) return value;
  if (value === 1 || value === 0) return value === 1;
  const s = String(value ?? '').trim().toLowerCase();
  if (['true', 'yes', 'y', '1'].includes(s)) return true;
  if (['false', 'no', 'n', '0'].includes(s)) return false;
  return null;
};

module.exports = { isQuickeKycOn, call, pick, toYmd, yesNo };
