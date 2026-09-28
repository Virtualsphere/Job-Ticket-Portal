const express = require('express');
const bcrypt = require('bcryptjs');
const { query } = require('../db');
const { verifyToken, requireRole } = require('../auth');
const { sendAccountCreatedEmail, sendPasswordChangedEmail } = require('../mailer');

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
  let sql = `SELECT u.id, u.name, u.email, u.role_id AS roleId, r.name AS role, u.created_at
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

// Admin-only: edit a user's name, email, role and (optionally) password.
// When a new password is set, the user is emailed the new credentials.
router.put('/:id', verifyToken, requireRole('admin'), async (req, res) => {
  const id = Number(req.params.id);
  const { name, email, roleId, password } = req.body;
  if (!name || !email || !roleId) {
    return res.status(400).json({ error: 'name, email and roleId are required' });
  }
  if (password && password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

  const targets = await query(
    `SELECT u.id, r.name AS role FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?`,
    [id]
  );
  if (!targets.length) return res.status(404).json({ error: 'User not found' });

  const roles = await query('SELECT id, name FROM roles WHERE id = ?', [roleId]);
  if (!roles.length) return res.status(400).json({ error: 'Selected role does not exist' });

  // An admin demoting themselves would lock them out of this panel mid-session.
  if (id === req.user.id && roles[0].name !== 'admin') {
    return res.status(400).json({ error: 'You cannot change your own role' });
  }

  const cleanEmail = email.trim().toLowerCase();
  const clash = await query('SELECT id FROM users WHERE email = ? AND id <> ?', [cleanEmail, id]);
  if (clash.length) return res.status(409).json({ error: 'Another account already uses this email' });

  await query('UPDATE users SET name = ?, email = ?, role_id = ? WHERE id = ?', [name.trim(), cleanEmail, roleId, id]);

  const updatedUser = { id, name: name.trim(), email: cleanEmail, roleId: roles[0].id, role: roles[0].name };

  let passwordChanged = false;
  let emailSent = false;
  if (password) {
    const passwordHash = await bcrypt.hash(password, 10);
    await query('UPDATE users SET password_hash = ? WHERE id = ?', [passwordHash, id]);
    passwordChanged = true;

    const emailResult = await sendPasswordChangedEmail(updatedUser, password);
    emailSent = emailResult.sent;
    if (!emailResult.sent) {
      console.warn(`[users] Password-changed email not sent for ${cleanEmail}:`, emailResult.reason || emailResult.error || 'logged only');
    }
  }

  res.json({ ...updatedUser, passwordChanged, emailSent });
});

// Admin-only: delete a user. Users still linked to jobs (as customer, PM,
// engineer, creator, or in status history / attachments) can't be removed
// without breaking that history, so MySQL's FK error becomes a clear 409.
router.delete('/:id', verifyToken, requireRole('admin'), async (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: 'You cannot delete your own account' });

  try {
    const result = await query('DELETE FROM users WHERE id = ?', [id]);
    if (!result.affectedRows) return res.status(404).json({ error: 'User not found' });
  } catch (err) {
    if (err.code === 'ER_ROW_IS_REFERENCED_2' || err.code === 'ER_ROW_IS_REFERENCED') {
      return res.status(409).json({ error: 'This user is linked to existing jobs and cannot be deleted. Reassign or remove them from those jobs first.' });
    }
    throw err;
  }
  res.status(204).end();
});

module.exports = router;
