const express = require('express');
const bcrypt = require('bcryptjs');
const { query } = require('../db');
const { verifyToken, requireRole } = require('../auth');
const { sendAccountCreatedEmail } = require('../mailer');

const router = express.Router();

// Admin: create an account for an engineer, customer, production manager,
// or any custom role the admin has created. Production Manager: create a
// customer account only — enforced below, not just hidden in the UI — so a
// PM can onboard a new customer without needing an admin in the loop, but
// still can't grant themselves or anyone else elevated access. The role is
// always a roleId from the roles table (dropdown on the frontend) — never
// free text — so there's no chance of a typo/conflicting role string.
router.post('/', verifyToken, requireRole('admin', 'production_manager'), async (req, res) => {
  const { name, email, password, roleId } = req.body;
  if (!name || !email || !password || !roleId) {
    return res.status(400).json({ error: 'name, email, password and roleId are required' });
  }
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

  const roles = await query('SELECT id, name FROM roles WHERE id = ?', [roleId]);
  if (!roles.length) return res.status(400).json({ error: 'Selected role does not exist' });

  if (req.user.role === 'production_manager' && roles[0].name !== 'customer') {
    return res.status(403).json({ error: 'Production managers can only create customer accounts' });
  }

  const existing = await query('SELECT id FROM users WHERE email = ?', [email.toLowerCase()]);
  if (existing.length) return res.status(409).json({ error: 'An account with this email already exists' });

  const passwordHash = await bcrypt.hash(password, 10);
  const result = await query(
    'INSERT INTO users (name, email, password_hash, role_id, created_by) VALUES (?, ?, ?, ?, ?)',
    [name, email.toLowerCase(), passwordHash, roleId, req.user.id]
  );

  const createdUser = { id: result.insertId, name, email: email.toLowerCase(), role: roles[0].name };

  const emailResult = await sendAccountCreatedEmail(createdUser, password, roles[0].name);
  if (!emailResult.sent) {
    console.warn(`[users] Welcome email not sent for ${createdUser.email}:`, emailResult.reason || emailResult.error || 'logged only');
  }

  res.status(201).json({ ...createdUser, emailSent: emailResult.sent });
});

// Admin + Production Manager: list users, optionally filtered by role name.
// Used for the "assign engineer" dropdown and the admin user directory.
router.get('/', verifyToken, requireRole('admin', 'production_manager'), async (req, res) => {
  const { role } = req.query;
  let sql = `SELECT u.id, u.name, u.email, r.name AS role, u.created_at
             FROM users u JOIN roles r ON r.id = u.role_id`;
  const params = [];
  if (role) {
    sql += ' WHERE r.name = ?';
    params.push(role);
  }
  sql += ' ORDER BY u.created_at DESC';
  const users = await query(sql, params);
  res.json(users);
});

// Admin + Production Manager: type-ahead search, e.g. GET /api/users/search?role=customer&q=gloup
// Powers the "type an email, pick from matches" customer field on the create-job form.
router.get('/search', verifyToken, requireRole('admin', 'production_manager'), async (req, res) => {
  const { role, q } = req.query;
  if (!role) return res.status(400).json({ error: 'role query param is required' });

  const like = `%${(q || '').trim()}%`;
  const users = await query(
    `SELECT u.id, u.name, u.email FROM users u
     JOIN roles r ON r.id = u.role_id
     WHERE r.name = ? AND (u.email LIKE ? OR u.name LIKE ?)
     ORDER BY u.email LIMIT 10`,
    [role, like, like]
  );
  res.json(users);
});

module.exports = router;
