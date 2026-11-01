const { pool } = require('../config/db');

// The KYC status a customer is shown (app + website).
//
// kyc_documents.status is 'pending' from the customer's first PAN check or
// upload, and "Submit & Verify" sets the same 'pending'. So a 'pending' KYC
// that still misses something Submit needs (kycController.autoVerifyKYC:
// PAN, Aadhaar and bank verified; Aadhaar front + back, selfie and bank
// statement uploaded) cannot have been submitted: the customer is told to
// complete their KYC ('not_submitted'), not that it is under review.
// The admin side keeps reading kyc_documents.status as it is.

const SUBMIT_DOCS = ['aadhaar_front', 'aadhaar_back', 'selfie', 'bank_passbook'];

/**
 * @param {object} p
 * @param {boolean} p.isKycVerified  users.is_kyc_verified
 * @param {object|null} p.doc        kyc_documents row (status + the 4 document columns), or null
 * @param {boolean} p.panVerified    users or kyc_documents pan_verified
 * @param {boolean} p.aadhaarVerified
 * @param {boolean} p.bankVerified   bank_details.is_verified
 */
const customerKycStatus = ({ isKycVerified, doc, panVerified, aadhaarVerified, bankVerified }) => {
  if (isKycVerified) return 'approved';
  if (!doc || !doc.status) return 'not_submitted';
  if (doc.status !== 'pending') return doc.status;
  const readyToSubmit = !!(panVerified && aadhaarVerified && bankVerified) && SUBMIT_DOCS.every((k) => !!doc[k]);
  return readyToSubmit ? 'pending' : 'not_submitted';
};

// The same, read from the database for one customer
const kycStatusOf = async (userId) => {
  const [rows] = await pool.query(
    `SELECT u.is_kyc_verified, u.pan_verified AS u_pan, u.aadhaar_verified AS u_aadhaar,
            k.status, k.pan_verified AS k_pan, k.aadhaar_verified AS k_aadhaar,
            k.aadhaar_front, k.aadhaar_back, k.selfie, k.bank_passbook,
            bd.is_verified AS bank_verified
       FROM users u
       LEFT JOIN kyc_documents k ON k.user_id = u.id
       LEFT JOIN bank_details bd ON bd.user_id = u.id
      WHERE u.id = ?`,
    [userId]
  );
  const r = rows[0];
  if (!r) return 'not_submitted';
  return customerKycStatus({
    isKycVerified: !!r.is_kyc_verified,
    doc: r.status ? r : null,
    panVerified: !!(r.u_pan || r.k_pan),
    aadhaarVerified: !!(r.u_aadhaar || r.k_aadhaar),
    bankVerified: !!r.bank_verified,
  });
};

module.exports = { customerKycStatus, kycStatusOf };
