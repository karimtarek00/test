const express = require('express');
const { pool, isUniqueViolation } = require('../lib/db');
const auth = require('../lib/auth');
const { AppError, asyncHandler } = require('../lib/errors');
const logger = require('../lib/logger');

const log = logger.forModule('users-route');
const router = express.Router();

// Everything here is Admin-only (mounted with requireAuth + requireAdmin in
// app.js) -- account management for the two roles, not something a Viewer
// should ever see or reach.

router.get('/', asyncHandler(async (req, res) => {
  const { rows } = await pool.query('SELECT id, username, role, created_at, last_login_at FROM users ORDER BY created_at ASC');
  res.json({ users: rows });
}));

router.post('/', asyncHandler(async (req, res) => {
  const { username, password, role } = req.body || {};
  if (!username || !password || !['admin', 'viewer'].includes(role)) {
    throw AppError.badRequest('Username, password, and a valid role (admin or viewer) are required.');
  }
  if (password.length < 6) throw AppError.badRequest('Password must be at least 6 characters.');
  try {
    const { rows } = await pool.query(
      `INSERT INTO users (username, password_hash, role) VALUES ($1,$2,$3) RETURNING id, username, role, created_at`,
      [username.trim(), auth.hashPassword(password), role]
    );
    log.info({ createdUserId: rows[0].id, role, byUserId: req.user.id }, 'user created');
    res.status(201).json({ user: rows[0] });
  } catch (err) {
    if (isUniqueViolation(err)) throw AppError.conflict('That username is already taken.');
    throw err;
  }
}));

// Change a user's role and/or reset their password. Refuses to demote the
// last remaining admin, since that would leave nobody able to reach
// Configuration or manage accounts at all.
router.put('/:id', asyncHandler(async (req, res) => {
  const { role, password } = req.body || {};
  const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [req.params.id]);
  if (!rows.length) throw AppError.notFound('User not found.');
  const user = rows[0];

  if (role && !['admin', 'viewer'].includes(role)) throw AppError.badRequest('Invalid role.');
  if (password && password.length < 6) throw AppError.badRequest('Password must be at least 6 characters.');

  if (role === 'viewer' && user.role === 'admin') {
    const { rows: adminCount } = await pool.query(`SELECT COUNT(*)::int AS c FROM users WHERE role = 'admin'`);
    if (adminCount[0].c <= 1) throw AppError.badRequest('Cannot demote the last remaining Admin.');
  }

  await pool.query(
    'UPDATE users SET role = $1, password_hash = $2 WHERE id = $3',
    [role || user.role, password ? auth.hashPassword(password) : user.password_hash, req.params.id]
  );
  log.info({ targetUserId: req.params.id, byUserId: req.user.id, roleChanged: !!role, passwordReset: !!password }, 'user updated');
  res.json({ ok: true });
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  if (String(req.user.id) === String(req.params.id)) {
    throw AppError.badRequest("You can't delete your own account while logged in as it.");
  }
  const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [req.params.id]);
  if (!rows.length) throw AppError.notFound('User not found.');

  if (rows[0].role === 'admin') {
    const { rows: adminCount } = await pool.query(`SELECT COUNT(*)::int AS c FROM users WHERE role = 'admin'`);
    if (adminCount[0].c <= 1) throw AppError.badRequest('Cannot delete the last remaining Admin.');
  }

  await pool.query('DELETE FROM sessions WHERE user_id = $1', [req.params.id]);
  await pool.query('DELETE FROM users WHERE id = $1', [req.params.id]);
  log.info({ targetUserId: req.params.id, byUserId: req.user.id }, 'user deleted');
  res.status(204).end();
}));

module.exports = router;
