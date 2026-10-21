const { Readable } = require('stream');
const { needsPassword } = require('./pdfLock');

// Every uploaded customer document is checked by what the file really IS
// (its first bytes), not by the name or type the phone / browser claims, so
// that whatever is stored opens for the team:
//   • Aadhaar front / back, PAN card, selfie → a photo (JPG, PNG or WebP)
//   • bank statement, offer letter           → a PDF, not locked with a password
// Empty, damaged and HEIC files are refused with a message the customer can
// act on. The stored file is then named after what it really is (.pdf / .jpg
// / .png / .webp), so it is served with the right type and opens.

const KINDS = {
  pdf: { ext: '.pdf', mime: 'application/pdf' },
  jpeg: { ext: '.jpg', mime: 'image/jpeg' },
  png: { ext: '.png', mime: 'image/png' },
  webp: { ext: '.webp', mime: 'image/webp' },
};
const PHOTO = ['jpeg', 'png', 'webp'];
const PDF = ['pdf'];

const RULES = {
  aadhaar_front: { label: 'Aadhaar front', allow: PHOTO },
  aadhaar_back: { label: 'Aadhaar back', allow: PHOTO },
  pan_card: { label: 'PAN card', allow: PHOTO },
  selfie: { label: 'Selfie', allow: PHOTO },
  bank_passbook: { label: 'Bank statement', allow: PDF },
  offer_letter: { label: 'Offer letter', allow: PDF },
};

const detectKind = (buf) => {
  if (!buf || buf.length < 12) return null;
  if (buf.slice(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.slice(0, 8).toString('hex') === '89504e470d0a1a0a') return 'png';
  if (buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return 'webp';
  if (buf.slice(4, 8).toString('latin1') === 'ftyp') return 'heic'; // HEIC / HEIF / AVIF photos
  return null;
};

const refuse = (message) => Object.assign(new Error(message), { isValidation: true, status: 400 });

// Resolves the field's rule and what the file is, or throws a refusal.
const checkDocument = (field, buf) => {
  const rule = RULES[field] || { label: 'Document', allow: [...PHOTO, ...PDF] };
  const wantsPdf = rule.allow.includes('pdf') && rule.allow.length === 1;
  const wantsPhoto = !rule.allow.includes('pdf');

  if (!buf || buf.length === 0) throw refuse(`${rule.label}: the file is empty. Please choose the file again.`);
  const kind = detectKind(buf);

  if (kind === 'heic') {
    throw refuse(wantsPdf
      ? `${rule.label} must be a PDF file, not a photo.`
      : `${rule.label}: this photo is in HEIC format, which cannot be opened. Please take the photo with the camera, or choose a JPG or PNG photo.`);
  }
  if (!kind) {
    throw refuse(wantsPdf
      ? `${rule.label} must be a PDF file. This file is not a PDF (or it is damaged).`
      : `${rule.label} must be a photo (JPG or PNG). This file is not a photo we can open (or it is damaged).`);
  }
  if (!rule.allow.includes(kind)) {
    throw refuse(wantsPdf ? `${rule.label} must be a PDF file, not a photo.` : `${rule.label} must be a photo (JPG or PNG), not a PDF.`);
  }
  if (kind === 'pdf') {
    const tail = buf.slice(Math.max(0, buf.length - 4096)).toString('latin1');
    if (!tail.includes('%%EOF')) {
      throw refuse(`${rule.label}: this PDF is incomplete or damaged. Please download it again and upload the new copy.`);
    }
    // Locked = needs a password to open. PDFs that are encrypted only against
    // printing / editing open without one and are accepted.
    if (needsPassword(buf) === true) {
      throw refuse(`${rule.label}: this PDF is locked with a password, so our team cannot open it. Please upload the PDF without a password.`);
    }
  }
  if (wantsPhoto && buf.length < 2048) {
    throw refuse(`${rule.label}: this photo is too small to read. Please take a clear photo.`);
  }
  return kind;
};

// Wraps a multer storage engine: reads the whole file (multer's limit keeps it
// at 10 MB), checks it, corrects its name and type, then hands it on.
class CheckedStorage {
  constructor(inner) {
    this.inner = inner;
  }

  _handleFile(req, file, cb) {
    const chunks = [];
    let tooBig = false;
    let done = false;
    const finish = (err, info) => { if (!done) { done = true; cb(err, info); } };

    file.stream.on('limit', () => { tooBig = true; });
    file.stream.on('data', (chunk) => chunks.push(chunk));
    file.stream.on('error', (err) => finish(err));
    file.stream.on('end', () => {
      if (tooBig) return finish(Object.assign(new Error('File too large. Maximum size is 10MB.'), { code: 'LIMIT_FILE_SIZE' }));
      const buf = Buffer.concat(chunks);
      let kind;
      try {
        kind = checkDocument(file.fieldname, buf);
      } catch (err) {
        return finish(err);
      }
      const { ext, mime } = KINDS[kind];
      file.mimetype = mime;
      file.originalname = `${file.fieldname}${ext}`;
      file.size = buf.length;
      Object.defineProperty(file, 'stream', { configurable: true, enumerable: false, value: Readable.from([buf]) });
      return this.inner._handleFile(req, file, finish);
    });
  }

  _removeFile(req, file, cb) {
    this.inner._removeFile(req, file, cb);
  }
}

module.exports = { RULES, KINDS, detectKind, checkDocument, CheckedStorage };
