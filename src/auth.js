const jwt = require('jsonwebtoken');
const { query } = require('./db');

const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_change_me';

function signToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role, name: user.name },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

// Re-reads the user from the DB on every request so that a deleted user is
// locked out immediately and role/name/email edits by an admin take effect
// without waiting for the 7-day token to expire.
async function verifyToken(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
  const rows = await query(
    `SELECT u.id, u.name, u.email, r.name AS role
     FROM users u JOIN roles r ON r.id = u.role_id
     WHERE u.id = ?`,
    [payload.id]
  );
  if (!rows.length) return res.status(401).json({ error: 'Account no longer exists' });
  req.user = rows[0];
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Not authorized for this action' });
    }
    next();
  };
}

module.exports = { signToken, verifyToken, requireRole, JWT_SECRET };
