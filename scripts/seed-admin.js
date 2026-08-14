// One-time CLI script to create the first admin account.
// This is intentionally NOT an HTTP endpoint — admins must be created by
// whoever controls the server/.env file, never through a public form.
//
// Usage: set ADMIN_NAME, ADMIN_EMAIL, ADMIN_PASSWORD in .env, then:
//   npm run seed:admin

require('dotenv').config();
const bcrypt = require('bcryptjs');
const { pool, query } = require('../src/db');

async function main() {
  const name = process.env.ADMIN_NAME;
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;

  if (!name || !email || !password) {
    console.error('Set ADMIN_NAME, ADMIN_EMAIL and ADMIN_PASSWORD in .env before running this script.');
    process.exit(1);
  }
  if (password.length < 6) {
    console.error('ADMIN_PASSWORD must be at least 6 characters.');
    process.exit(1);
  }

  const roles = await query("SELECT id FROM roles WHERE name = 'admin'");
  if (!roles.length) {
    console.error('Role "admin" not found — run "npm run migrate" first.');
    process.exit(1);
  }
  const adminRoleId = roles[0].id;

  const existing = await query('SELECT id FROM users WHERE email = ?', [email.toLowerCase()]);
  if (existing.length) {
    console.log(`An account with ${email} already exists — nothing to do.`);
    process.exit(0);
  }

  const passwordHash = await bcrypt.hash(password, 10);
  await query(
    'INSERT INTO users (name, email, password_hash, role_id) VALUES (?, ?, ?, ?)',
    [name, email.toLowerCase(), passwordHash, adminRoleId]
  );

  console.log(`Admin account created: ${email}`);
  console.log('You can now log in and create engineer/customer/PM accounts from the Admin panel.');
  process.exit(0);
}

main().catch((err) => {
  console.error('Seeding admin failed:', err.message);
  process.exit(1);
}).finally(() => pool.end());
