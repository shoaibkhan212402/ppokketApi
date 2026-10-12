const fs = require('fs');
const path = require('path');

// Company names offered as suggestions while a customer types where they work
// (the "Company Name" box on the website and in the app). They are only a
// help with typing: any name is still accepted when the profile is saved.
//
// The names live in config/companies.txt — one per line, `#` lines are
// headings. The file is read once, on the first request. If it cannot be read
// the forms simply get no suggestions; nothing else depends on it.

const LIST_FILE = path.join(__dirname, '..', 'config', 'companies.txt');

let names = null;

const companyNames = () => {
  if (names) return names;
  try {
    const seen = new Set();
    names = fs.readFileSync(LIST_FILE, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.replace(/\s+/g, ' ').trim())
      .filter((line) => {
        if (!line || line.startsWith('#')) return false;
        const key = line.toLowerCase();
        if (seen.has(key)) return false; // the same company listed twice
        seen.add(key);
        return true;
      });
    return names;
  } catch (err) {
    console.error('[companies] could not read the company list:', err.message);
    return [];
  }
};

module.exports = { companyNames };
