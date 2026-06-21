const { pool } = require('../config/db');

async function test() {
  try {
    const [res] = await pool.query("INSERT INTO admins (name, email, password, role) VALUES ('Test DSA', 'testdsa@test.com', 'test', 'dsa_partner')");
    console.log("Inserted ID:", res.insertId);
    const [rows] = await pool.query("SELECT * FROM admins WHERE id = ?", [res.insertId]);
    console.log("Role inserted:", rows[0].role);
    await pool.query("DELETE FROM admins WHERE id = ?", [res.insertId]);
  } catch (err) {
    console.error(err);
  } finally {
    process.exit(0);
  }
}

test();
