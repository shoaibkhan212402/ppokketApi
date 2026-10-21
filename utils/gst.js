// GST number (GSTIN) of a customer's business: 15 characters — a 2-digit
// state code, the business's PAN, an entity number, a 'Z' and a check
// character. The check character catches most typing mistakes.

const CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const PATTERN = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

// Spaces and dashes removed, upper case.
const normalizeGstin = (value) => String(value ?? '').replace(/[\s-]/g, '').toUpperCase();

const checkCharacter = (gstin) => {
  let sum = 0;
  for (let i = 0; i < 14; i += 1) {
    const product = CHARS.indexOf(gstin[i]) * (i % 2 ? 2 : 1);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return CHARS[(36 - (sum % 36)) % 36];
};

// State codes run from 01 to 38; 97 and 99 are used for special registrations.
const validState = (gstin) => {
  const code = Number(gstin.slice(0, 2));
  return (code >= 1 && code <= 38) || code === 97 || code === 99;
};

const isValidGstin = (value) => {
  const gstin = normalizeGstin(value);
  return PATTERN.test(gstin) && validState(gstin) && checkCharacter(gstin) === gstin[14];
};

module.exports = { normalizeGstin, isValidGstin };
