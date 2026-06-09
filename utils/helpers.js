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

const maskPAN = (pan) => {
  if (!pan || pan.length < 10) return pan;
  return `${pan.slice(0,2)}XXXXXX${pan.slice(-2)}`;
};

module.exports = { nanoid, formatCurrency, maskAadhaar, maskPAN };
