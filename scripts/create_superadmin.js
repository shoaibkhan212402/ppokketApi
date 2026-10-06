// Creates a super_admin account, or promotes/resets an existing one.
// Credentials are passed as arguments so they never get committed:
//   node scripts/create_superadmin.js <email> <password> [name]
const bcrypt = require('bcrypt');
const { pool } = require('../config/db');

async function createSuperAdmin() {
  const [, , rawEmail, password, rawName] = process.argv;
  if (!rawEmail || !password) {
    console.error('Usage: node scripts/create_superadmin.js <email> <password> [name]');
    process.exit(1);
  }
  if (password === 'Admin@123') {
    console.error('That was the old seeded password and is refused at login. Choose a different one.');
    process.exit(1);
  }

  const email = rawEmail.toLowerCase().trim();
  const localPart = email.split('@')[0];
  const name = rawName || localPart.charAt(0).toUpperCase() + localPart.slice(1);

  try {
    const hashedPwd = await bcrypt.hash(password, await bcrypt.genSalt(10));
    const [existing] = await pool.query('SELECT id FROM admins WHERE email = ?', [email]);

    if (existing.length) {
      await pool.query(
        "UPDATE admins SET password = ?, role = 'super_admin', is_active = 1 WHERE id = ?",
        [hashedPwd, existing[0].id]
      );
      console.log(`Updated ${email} (id ${existing[0].id}) to super_admin with the new password.`);
    } else {
      const [result] = await pool.query(
        "INSERT INTO admins (name, email, password, role) VALUES (?, ?, ?, 'super_admin')",
        [name, email, hashedPwd]
      );
      console.log(`Created super_admin ${email} (id ${result.insertId}).`);
    }
    process.exit(0);
  } catch (err) {
    console.error('Failed to create super admin:', err.message);
    process.exit(1);
  }
}

createSuperAdmin();
