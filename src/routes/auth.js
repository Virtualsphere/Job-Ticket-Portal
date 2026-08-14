const express = require('express');
const bcrypt = require('bcryptjs');
const { query } = require('../db');
const { signToken, verifyToken } = require('../auth');

const router = express.Router();

// No public /register anymore — accounts are created by an admin from the
// Admin panel (POST /api/users). See scripts/seed-admin.js for creating the
// very first admin account.

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email and password are required' });

  const rows = await query(
    `SELECT u.id, u.name, u.email, u.password_hash, r.name AS role
     FROM users u JOIN roles r ON r.id = u.role_id
     WHERE u.email = ?`,
    [email.toLowerCase()]
  );
  if (!rows.length) return res.status(401).json({ error: 'Invalid email or password' });

  const user = rows[0];
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Invalid email or password' });

  const token = signToken(user);
  res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
});

router.get('/me', verifyToken, (req, res) => {
  res.json({ user: req.user });
});

module.exports = router;
