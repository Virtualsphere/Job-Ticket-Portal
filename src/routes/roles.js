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

module.exports = router;
