const fs = require('fs');
const path = require('path');
let schemaSql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
schemaSql = schemaSql.replace(/CREATE DATABASE[\s\S]*?;/gi, '').replace(/USE[\s\S]*?;/gi, '');
schemaSql = schemaSql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--.*$/gm, '');
const statements = schemaSql.split(/;/g).map(s => s.trim()).filter(Boolean);
console.log('statements', statements.length);
for (let i = 0; i < Math.min(12, statements.length); i += 1) {
  console.log('---', i + 1);
  console.log(statements[i].slice(0, 500));
  console.log('');
}
