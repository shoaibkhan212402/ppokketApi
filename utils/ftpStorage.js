const ftp = require('basic-ftp');
const path = require('path');

const MIME_TO_EXT = {
  'image/jpeg':        '.jpg',
  'image/jpg':         '.jpg',
  'image/png':         '.png',
  'image/webp':        '.webp',
  'image/heic':        '.heic',
  'image/heif':        '.heif',
  'application/pdf':   '.pdf',
};

class FTPStorage {
  constructor({ host, user, password, port = 21, rootUrl, uploadDir = '/uploads/kyc' }) {
    this.host      = host ? host.replace(/^ftp:\/\//i, '').replace(/\/$/, '') : host;
    this.user      = user;
    this.password  = password;
    this.port      = Number(port) || 21;
    this.rootUrl   = rootUrl.replace(/\/$/, '');
    this.uploadDir = uploadDir;
  }

  async _handleFile(req, file, cb) {
    const client = new ftp.Client();
    client.ftp.verbose = false;

    try {
      await client.access({
        host:     this.host,
        user:     this.user,
        password: this.password,
        port:     this.port,
        secure:   false,
      });

      const userId    = req.user?.id || 'general';
      const ext       = path.extname(file.originalname) || MIME_TO_EXT[file.mimetype] || '';
      const filename  = `${file.fieldname}_${Date.now()}${ext}`;
      const remoteDir = `${this.uploadDir}/${userId}`;
      const remotePath = `${remoteDir}/${filename}`;

      await client.ensureDir(remoteDir);
      await client.uploadFrom(file.stream, remotePath);

      const publicUrl = `${this.rootUrl}${remotePath}`;

      cb(null, {
        path:         publicUrl,   // full https:// URL — picked up by getFileUrl in kycController
        filename,
        fieldname:    file.fieldname,
        originalname: file.originalname,
        mimetype:     file.mimetype,
        size:         file.size || 0,
        storage:      'ftp',
      });
    } catch (err) {
      console.error('[FTPStorage] Upload error:', err.message);
      cb(err);
    } finally {
      client.close();
    }
  }

  _removeFile(req, file, cb) {
    cb(null);
  }
}

module.exports = FTPStorage;
