const nanoid = (length = 8) => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
};

const formatCurrency = (amount) => {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: 0,
  }).format(amount);
};

const maskAadhaar = (aadhaar) => {
  if (!aadhaar || aadhaar.length < 12) return aadhaar;
  return `XXXX XXXX ${aadhaar.slice(-4)}`;
};

// A bank account number with only its last four digits readable.
const maskAccount = (account) => {
  const text = String(account || '');
  return text.length > 4 ? `XXXX${text.slice(-4)}` : text;
};

// The bank's own reference for a transfer (UTR / IMPS / UPI reference), as an
// admin typed it → the form it is stored in, or null when it cannot be one.
// It is what the customer is told, so it is never made up by the server.
const cleanBankReference = (value) => {
  const reference = String(value ?? '').replace(/\s+/g, '').toUpperCase();
  return /^[A-Z0-9][A-Z0-9/-]{5,39}$/.test(reference) && /\d/.test(reference) ? reference : null;
};

const maskPAN = (pan) => {
  if (!pan || pan.length < 10) return pan;
  return `${pan.slice(0,2)}XXXXXX${pan.slice(-2)}`;
};

module.exports = { nanoid, formatCurrency, maskAadhaar, maskPAN, maskAccount, cleanBankReference };
