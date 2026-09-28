const express = require('express');
const { query } = require('../db');
const { verifyToken, requireRole } = require('../auth');

const router = express.Router();

// Admin + Production Manager: list all roles (used to populate the "Role"
// dropdown when creating a user, so the value always comes from the
// database — never free text typed on the frontend). Production Manager
// only needs this to resolve the "customer" role's id — POST /users still
// rejects them for any other role.
router.get('/', verifyToken, requireRole('admin', 'production_manager'), async (req, res) => {
  const roles = await query('SELECT id, name, description, created_at FROM roles ORDER BY name');
  res.json(roles);
});

// Admin-only: create a new role (e.g. "quality_inspector").
router.post('/', verifyToken, requireRole('admin'), async (req, res) => {
  const { name, description } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Role name is required' });

  const cleanName = name.trim().toLowerCase().replace(/\s+/g, '_');
  const existing = await query('SELECT id FROM roles WHERE name = ?', [cleanName]);
  if (existing.length) return res.status(409).json({ error: 'A role with this name already exists' });

  const result = await query('INSERT INTO roles (name, description) VALUES (?, ?)', [cleanName, description || null]);
  res.status(201).json({ id: result.insertId, name: cleanName, description: description || null });
});

// Built-in roles are referenced by name throughout the permission checks
// (requireRole('admin', ...), etc.), so renaming or deleting them would
// silently break access control.
const BUILT_IN_ROLES = ['admin', 'production_manager', 'engineer', 'customer'];

// Admin-only: rename a custom role and/or change its description.
router.put('/:id', verifyToken, requireRole('admin'), async (req, res) => {
  const id = Number(req.params.id);
  const { name, description } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Role name is required' });

  const roles = await query('SELECT id, name FROM roles WHERE id = ?', [id]);
  if (!roles.length) return res.status(404).json({ error: 'Role not found' });
  if (BUILT_IN_ROLES.includes(roles[0].name)) {
    return res.status(400).json({ error: 'Built-in roles cannot be edited' });
  }

  const cleanName = name.trim().toLowerCase().replace(/\s+/g, '_');
  const clash = await query('SELECT id FROM roles WHERE name = ? AND id <> ?', [cleanName, id]);
  if (clash.length) return res.status(409).json({ error: 'A role with this name already exists' });

  await query('UPDATE roles SET name = ?, description = ? WHERE id = ?', [cleanName, description || null, id]);
  res.json({ id, name: cleanName, description: description || null });
});

// Admin-only: delete a custom role, only when no users are assigned to it.
router.delete('/:id', verifyToken, requireRole('admin'), async (req, res) => {
  const id = Number(req.params.id);
  const roles = await query('SELECT id, name FROM roles WHERE id = ?', [id]);
  if (!roles.length) return res.status(404).json({ error: 'Role not found' });
  if (BUILT_IN_ROLES.includes(roles[0].name)) {
    return res.status(400).json({ error: 'Built-in roles cannot be deleted' });
  }

  const [{ count }] = await query('SELECT COUNT(*) AS count FROM users WHERE role_id = ?', [id]);
  if (count > 0) {
    return res.status(409).json({ error: `${count} user(s) still have this role. Change their role before deleting it.` });
  }

  await query('DELETE FROM roles WHERE id = ?', [id]);
  res.status(204).end();
});

module.exports = router;
