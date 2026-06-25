require('dotenv').config();
const multer = require('multer');
const path   = require('path');
const fs     = require('fs');

let storage;

// ── Priority 1: FTP ──────────────────────────────────────────────────────────
const hasFtpConfig =
  process.env.FTP_HOST &&
  process.env.FTP_USER &&
  process.env.FTP_PASS &&
  process.env.FTP_ROOT_URL;

if (hasFtpConfig) {
  try {
    const FTPStorage = require('../utils/ftpStorage');
    storage = new FTPStorage({
      host:      process.env.FTP_HOST,
      user:      process.env.FTP_USER,
      password:  process.env.FTP_PASS,
      port:      process.env.FTP_PORT || 21,
      rootUrl:   process.env.FTP_ROOT_URL,
      uploadDir: process.env.FTP_UPLOAD_DIR || '/uploads/kyc',
    });
    console.log('📁 Storage: FTP —', process.env.FTP_HOST);
  } catch (err) {
    console.error('⚠️ FTP storage init failed, trying Cloudinary:', err.message);
  }
}

// ── Priority 2: Cloudinary ───────────────────────────────────────────────────
const hasCloudinaryConfig =
  process.env.CLOUDINARY_CLOUD_NAME &&
  process.env.CLOUDINARY_API_KEY    &&
  process.env.CLOUDINARY_API_SECRET &&
  process.env.CLOUDINARY_CLOUD_NAME !== 'your_cloud_name' &&
  process.env.CLOUDINARY_API_KEY    !== 'your_api_key'    &&
  process.env.CLOUDINARY_API_SECRET !== 'your_api_secret';

if (!storage && hasCloudinaryConfig) {
  try {
    const { CloudinaryStorage } = require('multer-storage-cloudinary');
    const cloudinary = require('../config/cloudinary');

    storage = new CloudinaryStorage({
      cloudinary,
      params: async (req, file) => {
        const folder = `ppokket/kyc/${req.user?.id || 'general'}`;
        const isPdf  = file.mimetype === 'application/pdf';

        if (isPdf) {
          // raw resource_type: Cloudinary stores the PDF as-is, all pages preserved
          return {
            folder,
            resource_type: 'raw',
            public_id: `${file.fieldname}_${Date.now()}.pdf`,
          };
        }

        return {
          folder,
          allowed_formats: ['jpg', 'jpeg', 'png', 'heic', 'heif', 'webp'],
          transformation: [{ quality: 'auto', fetch_format: 'auto' }],
          public_id: `${file.fieldname}_${Date.now()}`,
        };
      },
    });

    console.log('☁️  Storage: Cloudinary —', process.env.CLOUDINARY_CLOUD_NAME);
  } catch (err) {
    console.error('⚠️ Cloudinary storage init failed, falling back to disk:', err.message);
  }
}

// ── Priority 3: Local disk ───────────────────────────────────────────────────
if (!storage) {
  const uploadDir = path.join(__dirname, '../uploads');
  if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

  storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename:    (req, file, cb) => {
      const suffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
      cb(null, `${file.fieldname}-${suffix}${path.extname(file.originalname)}`);
    },
  });

  console.log('💾 Storage: local disk —', path.join(__dirname, '../uploads'));
}

// ── File filter ──────────────────────────────────────────────────────────────
const fileFilter = (req, file, cb) => {
  const allowed = [
    'image/jpeg', 'image/png', 'image/jpg',
    'image/heic', 'image/heif', 'image/webp',
    'application/pdf',
    'application/octet-stream', // React Native camera/gallery picks
  ];
  if (allowed.includes(file.mimetype) || file.mimetype.startsWith('image/')) {
    cb(null, true);
  } else {
    cb(new Error('Only images (JPEG, PNG, WebP, HEIC) and PDF files are allowed'), false);
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
});

module.exports = upload;
