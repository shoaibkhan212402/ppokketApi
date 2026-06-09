require('dotenv').config();
const multer = require('multer');
const path = require('path');
const fs = require('fs');

let storage;
const hasCloudinaryConfig =
  process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET &&
  process.env.CLOUDINARY_CLOUD_NAME !== 'your_cloud_name' &&
  process.env.CLOUDINARY_API_KEY !== 'your_api_key' &&
  process.env.CLOUDINARY_API_SECRET !== 'your_api_secret';

// Check if Cloudinary is configured
if (hasCloudinaryConfig) {
  try {
    const { CloudinaryStorage } = require('multer-storage-cloudinary');
    const cloudinary = require('../config/cloudinary');
    storage = new CloudinaryStorage({
      cloudinary,
      params: async (req, file) => {
        const folder = `ppokket/kyc/${req.user?.id || 'general'}`;
        return {
          folder,
          allowed_formats: ['jpg', 'jpeg', 'png', 'pdf', 'heic', 'heif', 'webp'],
          transformation: [{ quality: 'auto', fetch_format: 'auto' }],
          public_id: `${file.fieldname}_${Date.now()}`,
        };
      },
    });

  } catch (err) {
    console.error('⚠️ CloudinaryStorage initialization failed, falling back to disk storage:', err.stack || err.message);
  }
} else {

}

if (!storage) {
  // Local storage fallback
  const uploadDir = path.join(__dirname, '../uploads');
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
  }
  
  storage = multer.diskStorage({
    destination: (req, file, cb) => {
      cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
      const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
      cb(null, `${file.fieldname}-${uniqueSuffix}${path.extname(file.originalname)}`);
    }
  });

}

const fileFilter = (req, file, cb) => {
  const allowed = [
    'image/jpeg', 'image/png', 'image/jpg', 'application/pdf',
    'image/heic', 'image/heif', 'image/webp',
    'application/octet-stream', // React Native often sends this for camera/gallery picks
  ];
  if (allowed.includes(file.mimetype) || file.mimetype.startsWith('image/')) {
    cb(null, true);
  } else {
    cb(new Error('Only images (including HEIC, HEIF, WEBP) and PDF files are allowed'), false);
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});

module.exports = upload;

