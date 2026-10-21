// Where uploaded customer documents can be opened.
//
// Documents go over FTP to the WEBSITE's storage, so they are served at
// https://ppokket.com/uploads/… — never by this API server. FTP_ROOT_URL says
// which address to put in the saved link; when it is set to this API's own
// address (as happened on the live server, giving links that answer 404), the
// website's address (FRONTEND_URL) is used instead.

const hostOf = (url) => {
  try { return new URL(url).host.toLowerCase(); } catch { return ''; }
};

const API_HOST = hostOf(process.env.API_PUBLIC_URL) || 'api.ppokket.com';

const filesOrigin = () => {
  const ftp = (process.env.FTP_ROOT_URL || '').trim().replace(/\/+$/, '');
  if (ftp && hostOf(ftp) && hostOf(ftp) !== API_HOST) return ftp;
  return (process.env.FRONTEND_URL || 'https://ppokket.com').trim().replace(/\/+$/, '');
};

module.exports = { hostOf, filesOrigin, API_HOST };
