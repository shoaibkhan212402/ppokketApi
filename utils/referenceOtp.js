const { pool } = require('../config/db');
const { redisClient } = require('../config/redis');
const { sendOtpViaSms, generateOTP, isDevTestNumber, DEV_TEST_OTP } = require('../controllers/authController');
const { cleanMobile } = require('./references');

// A reference's mobile number is checked with an OTP: the code goes by SMS to
// the reference, who tells it to the customer, who types it in. So a customer
// cannot put down a made-up number, or one whose owner doesn't know them.
//
// The OTP itself lives in Redis (like the login OTP). A number that passed is
// remembered per customer in a table of its own, created on first use:
// reference_otp_checks (user_id, mobile, verified_at). Saving references
// (PUT /api/user/update) refuses a new or changed number that is not in it;
// numbers saved before this check existed are kept, and the admin sees them as
// "not verified".
//
// The SMS uses the login OTP's Orbitel template ("Your PPokket verification
// code is …") until a message of its own is approved on DLT. Then set, on the
// server: ORBITEL_REFERENCE_TEMPLATE_ID and ORBITEL_REFERENCE_SMS — the
// approved text exactly, with {otp} where the code goes and, if the template
// has it, {name} for the customer's name. Both must be set to take effect.
const referenceTemplate = (otp, customerName) => {
  const templateId = process.env.ORBITEL_REFERENCE_TEMPLATE_ID;
  const text = process.env.ORBITEL_REFERENCE_SMS;
  if (!templateId || !text) return null; // login template
  return {
    templateId,
    text: text.replace(/\{otp\}/g, otp).replace(/\{name\}/g, String(customerName || 'A customer').slice(0, 30)),
  };
};

const OTP_TTL_SECONDS = 10 * 60;           // the reference may take a while to answer
const OTP_MAX_ATTEMPTS = 5;
const RESEND_COOLDOWN_SECONDS = 60;        // per reference number
const MAX_SENDS_PER_NUMBER = 5;            // per reference number, per hour
const MAX_SENDS_PER_CUSTOMER = 10;         // per customer, per hour, all numbers together
const WINDOW_SECONDS = 60 * 60;

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS reference_otp_checks (
    user_id     INT NOT NULL,
    mobile      VARCHAR(10) NOT NULL,
    verified_at DATETIME NOT NULL,
    PRIMARY KEY (user_id, mobile)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`;

const isMissingTable = (err) => err?.code === 'ER_NO_SUCH_TABLE';
const otpKey = (userId, mobile) => `refotp:${userId}:${mobile}`;

// The numbers this customer has verified so far → Set of 10-digit numbers.
const verifiedMobiles = async (userId) => {
  try {
    const [rows] = await pool.query('SELECT mobile FROM reference_otp_checks WHERE user_id = ?', [userId]);
    return new Set(rows.map((r) => r.mobile));
  } catch (err) {
    if (!isMissingTable(err)) throw err;
    return new Set();
  }
};

const recordVerified = async (userId, mobile) => {
  const write = () => pool.query(
    `INSERT INTO reference_otp_checks (user_id, mobile, verified_at) VALUES (?, ?, NOW())
     ON DUPLICATE KEY UPDATE verified_at = NOW()`,
    [userId, mobile]
  );
  try {
    await write();
  } catch (err) {
    if (!isMissingTable(err)) throw err;
    await pool.query(CREATE_TABLE_SQL);
    await write();
  }
};

// The number as 10 digits, or { error } to show
const checkMobile = (value, ownMobile) => {
  const mobile = cleanMobile(value);
  if (!/^[6-9]\d{9}$/.test(mobile)) return { error: 'Please enter a valid 10-digit mobile number.' };
  if (mobile === cleanMobile(ownMobile).slice(-10)) return { error: "This is your own number. Please give someone else's number." };
  return { mobile };
};

// Sends the OTP to a reference's number.
// Resolves to { ok: true, already_verified? } or { ok: false, status, message }.
const sendReferenceOtp = async (user, value) => {
  const { mobile, error } = checkMobile(value, user.mobile);
  if (error) return { ok: false, status: 400, message: error };

  if ((await verifiedMobiles(user.id)).has(mobile)) return { ok: true, already_verified: true, mobile };

  const cooldown = await redisClient.ttl(`refotp_cooldown:${mobile}`);
  if (cooldown > 0) return { ok: false, status: 429, message: `Please wait ${cooldown}s before sending another OTP to this number.` };

  // Caps, so nobody can use this to flood someone's phone with SMS
  const perNumber = await redisClient.incr(`refotp_sendcount:${mobile}`);
  if (perNumber === 1) await redisClient.expire(`refotp_sendcount:${mobile}`, WINDOW_SECONDS);
  const perCustomer = await redisClient.incr(`refotp_user:${user.id}`);
  if (perCustomer === 1) await redisClient.expire(`refotp_user:${user.id}`, WINDOW_SECONDS);
  if (perNumber > MAX_SENDS_PER_NUMBER || perCustomer > MAX_SENDS_PER_CUSTOMER) {
    return { ok: false, status: 429, message: 'Too many OTPs sent. Please try again in an hour.' };
  }

  // The store-review test account gets the fixed test code and no SMS
  const testAccount = isDevTestNumber(user.mobile);
  const otp = testAccount ? DEV_TEST_OTP : generateOTP();
  await redisClient.setEx(otpKey(user.id, mobile), OTP_TTL_SECONDS, JSON.stringify({ otp, attempts: 0 }));
  if (!testAccount) await sendOtpViaSms(mobile, otp, referenceTemplate(otp, user.full_name));
  await redisClient.setEx(`refotp_cooldown:${mobile}`, RESEND_COOLDOWN_SECONDS, '1');
  return { ok: true, mobile };
};

// Checks the code the customer typed.
// Resolves to { ok: true } or { ok: false, status, message }.
const verifyReferenceOtp = async (user, value, otp) => {
  const { mobile, error } = checkMobile(value, user.mobile);
  if (error) return { ok: false, status: 400, message: error };
  if (!/^\d{6}$/.test(String(otp || ''))) return { ok: false, status: 400, message: 'Please enter the 6-digit OTP.' };

  const key = otpKey(user.id, mobile);
  const raw = await redisClient.get(key);
  if (!raw) return { ok: false, status: 400, message: 'The OTP has expired or was not sent. Please send a new one.' };

  const record = JSON.parse(raw);
  if (record.otp !== String(otp)) {
    record.attempts += 1;
    if (record.attempts >= OTP_MAX_ATTEMPTS) {
      await redisClient.del(key);
      return { ok: false, status: 400, message: 'Too many wrong attempts. Please send a new OTP.' };
    }
    const ttl = await redisClient.ttl(key);
    await redisClient.setEx(key, Math.max(ttl, 1), JSON.stringify(record));
    const left = OTP_MAX_ATTEMPTS - record.attempts;
    return { ok: false, status: 400, message: `Wrong OTP. ${left} attempt${left === 1 ? '' : 's'} left.` };
  }

  await recordVerified(user.id, mobile);
  await redisClient.del(key);
  return { ok: true, mobile };
};

// For PUT /api/user/update: the first reference whose number is new or changed
// and has not been verified, or null. `stored` = what is saved now.
const firstUnverifiedReference = async (userId, refs, stored) => {
  const savedNumbers = new Set((stored || []).map((r) => r.mobile));
  const verified = await verifiedMobiles(userId);
  return refs.find((ref) => !savedNumbers.has(ref.mobile) && !verified.has(ref.mobile)) || null;
};

module.exports = {
  CREATE_TABLE_SQL, sendReferenceOtp, verifyReferenceOtp, verifiedMobiles, firstUnverifiedReference,
};
