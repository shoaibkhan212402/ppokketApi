const crypto = require('crypto');

// Does this PDF need a password to OPEN? Many PDFs (bank statements among
// them) are encrypted only to stop printing or editing: they open with an
// empty "user" password and are fine. Only a PDF whose user password is not
// empty is really locked. This follows the PDF standard security handler
// (ISO 32000: algorithms 2, 4 and 5 for revisions 2–4, 2.A/2.B for 5–6) and
// tries the empty password.
//
// Returns true (locked), false (opens without a password, or not encrypted),
// or null when the file could not be understood — callers treat null as
// "not locked" so an odd PDF is never refused by mistake.

const PAD = Buffer.from('28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a', 'hex');

const rc4 = (key, data) => {
  const s = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 0, j = 0; i < 256; i += 1) {
    j = (j + s[i] + key[i % key.length]) & 255;
    [s[i], s[j]] = [s[j], s[i]];
  }
  const out = Buffer.alloc(data.length);
  for (let n = 0, i = 0, j = 0; n < data.length; n += 1) {
    i = (i + 1) & 255;
    j = (j + s[i]) & 255;
    [s[i], s[j]] = [s[j], s[i]];
    out[n] = data[n] ^ s[(s[i] + s[j]) & 255];
  }
  return out;
};

const md5 = (...parts) => crypto.createHash('md5').update(Buffer.concat(parts)).digest();

// A PDF string starting at `pos` (literal "(…)" or hex "<…>") → Buffer
const readString = (text, pos) => {
  while (/\s/.test(text[pos])) pos += 1;
  if (text[pos] === '<') {
    const end = text.indexOf('>', pos);
    if (end < 0) return null;
    let hex = text.slice(pos + 1, end).replace(/\s+/g, '');
    if (hex.length % 2) hex += '0';
    return Buffer.from(hex, 'hex');
  }
  if (text[pos] !== '(') return null;
  const bytes = [];
  let depth = 1;
  for (let i = pos + 1; i < text.length; i += 1) {
    const c = text[i];
    if (c === '\\') {
      const n = text[i + 1];
      const map = { n: 10, r: 13, t: 9, b: 8, f: 12, '(': 40, ')': 41, '\\': 92 };
      if (n in map) { bytes.push(map[n]); i += 1; continue; }
      if (/[0-7]/.test(n)) {
        const oct = text.slice(i + 1, i + 4).match(/^[0-7]{1,3}/)[0];
        bytes.push(parseInt(oct, 8) & 255);
        i += oct.length;
        continue;
      }
      if (n === '\r') { i += text[i + 2] === '\n' ? 2 : 1; continue; } // line continuation
      if (n === '\n') { i += 1; continue; }
      continue; // a lone backslash is ignored
    }
    if (c === '(') depth += 1;
    if (c === ')') { depth -= 1; if (depth === 0) return Buffer.from(bytes); }
    bytes.push(c.charCodeAt(0) & 255);
  }
  return null;
};

const stringAfter = (dict, key) => {
  const m = new RegExp(`/${key}(?![A-Za-z])\\s*`).exec(dict);
  return m ? readString(dict, m.index + m[0].length) : null;
};
const numberAfter = (dict, key) => {
  const m = new RegExp(`/${key}(?![A-Za-z])\\s+(-?\\d+)`).exec(dict);
  return m ? Number(m[1]) : null;
};

// The dictionary text starting at `start` ("<<" … matching ">>")
const dictAt = (text, start) => {
  let depth = 0;
  for (let i = start; i < text.length - 1; i += 1) {
    if (text[i] === '(') { // skip strings, which may contain << or >>
      i = skipString(text, i);
      continue;
    }
    if (text[i] === '<' && text[i + 1] === '<') { depth += 1; i += 1; } else if (text[i] === '>' && text[i + 1] === '>') {
      depth -= 1; i += 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
};

// Revision 6 (AES-256) hash, ISO 32000-2 algorithm 2.B
const hashR6 = (password, salt, udata) => {
  let k = crypto.createHash('sha256').update(Buffer.concat([password, salt, udata])).digest();
  for (let round = 0; ; round += 1) {
    const k1 = Buffer.concat(Array(64).fill(Buffer.concat([password, k, udata])));
    const cipher = crypto.createCipheriv('aes-128-cbc', k.slice(0, 16), k.slice(16, 32));
    cipher.setAutoPadding(false);
    const e = Buffer.concat([cipher.update(k1), cipher.final()]);
    let sum = 0;
    for (let i = 0; i < 16; i += 1) sum += e[i];
    const algo = ['sha256', 'sha384', 'sha512'][sum % 3];
    k = crypto.createHash(algo).update(e).digest();
    // at least 64 rounds; then stop once the last byte <= (rounds done) - 32
    if (round >= 63 && e[e.length - 1] <= round - 31) break;
  }
  return k.slice(0, 32);
};

// Skips the PDF string starting at text[i] === '(' → index of its ')'
const skipString = (text, i) => {
  let depth = 1;
  for (i += 1; i < text.length && depth; i += 1) {
    if (text[i] === '\\') i += 1;
    else if (text[i] === '(') depth += 1;
    else if (text[i] === ')') depth -= 1;
  }
  return i - 1;
};

// The dictionary without the dictionaries nested in it, so that the /Length
// of a crypt filter is not mistaken for the top-level one
const topLevel = (dict) => {
  let out = '<<';
  for (let i = 2; i < dict.length - 2; i += 1) {
    if (dict[i] === '(') {
      const end = skipString(dict, i);
      out += dict.slice(i, end + 1);
      i = end;
    } else if (dict[i] === '<' && dict[i + 1] === '<') {
      const inner = dictAt(dict, i);
      if (!inner) return dict;
      out += ' ';
      i += inner.length - 1;
    } else {
      out += dict[i];
    }
  }
  return `${out}>>`;
};

const needsPassword = (buf) => {
  try {
    const text = buf.toString('latin1');
    // The last /Encrypt key (not /EncryptMetadata) belongs to the newest trailer
    const re = /\/Encrypt(?![A-Za-z])/g;
    let at = -1;
    for (let m = re.exec(text); m; m = re.exec(text)) at = m.index;
    if (at < 0) return false;
    const after = text.slice(at + 8, at + 200);
    let dict;
    const ref = /^\s*(\d+)\s+(\d+)\s+R/.exec(after);
    if (ref) {
      const objRe = new RegExp(`(?:^|[^0-9])${ref[1]}\\s+${ref[2]}\\s+obj\\b`, 'g');
      let m; let last = null;
      while ((m = objRe.exec(text))) last = m;
      if (!last) return null;
      const open = text.indexOf('<<', last.index);
      if (open < 0) return null;
      dict = dictAt(text, open);
    } else {
      const open = text.indexOf('<<', at + 8);
      if (open < 0) return null;
      dict = dictAt(text, open);
    }
    if (!dict) return null;
    dict = topLevel(dict);
    if (!/\/Filter\s*\/Standard/.test(dict)) return null; // certificate / other handlers: don't guess

    const R = numberAfter(dict, 'R');
    const O = stringAfter(dict, 'O');
    const U = stringAfter(dict, 'U');
    if (!R || !O || !U) return null;

    if (R >= 5) {
      if (U.length < 48) return null;
      const empty = Buffer.alloc(0);
      const validationSalt = U.slice(32, 40);
      const hash = R === 5
        ? crypto.createHash('sha256').update(Buffer.concat([empty, validationSalt])).digest()
        : hashR6(empty, validationSalt, Buffer.alloc(0));
      return !hash.equals(U.slice(0, 32));
    }

    const P = numberAfter(dict, 'P');
    if (P == null) return null;
    // The first /ID string of the trailer that holds this /Encrypt
    const idMatch = /\/ID\s*\[\s*/.exec(text.slice(Math.max(0, at - 4000), at + 4000));
    let id0 = Buffer.alloc(0);
    if (idMatch) {
      const base = Math.max(0, at - 4000);
      id0 = readString(text, base + idMatch.index + idMatch[0].length) || id0;
    }
    const V = numberAfter(dict, 'V') || 0;
    // V4 (AES-128 / crypt filters) always uses a 128-bit key
    const keyLen = R === 2 ? 5 : V >= 4 ? 16 : Math.min(16, Math.max(5, (numberAfter(dict, 'Length') || 40) / 8));
    const p = Buffer.alloc(4);
    p.writeInt32LE(P);
    const noMetadata = R >= 4 && /\/EncryptMetadata\s+false/.test(dict) ? Buffer.from([255, 255, 255, 255]) : Buffer.alloc(0);
    let key = md5(PAD, O.slice(0, 32), p, id0, noMetadata);
    if (R >= 3) for (let i = 0; i < 50; i += 1) key = md5(key.slice(0, keyLen));
    key = key.slice(0, keyLen);

    if (R === 2) return !rc4(key, PAD).equals(U.slice(0, 32));
    let x = rc4(key, md5(PAD, id0));
    for (let i = 1; i <= 19; i += 1) x = rc4(Buffer.from(key.map((b) => b ^ i)), x);
    return !x.equals(U.slice(0, 16));
  } catch {
    return null;
  }
};

module.exports = { needsPassword };
