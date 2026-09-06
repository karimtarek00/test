const express = require('express');
const rateLimit = require('express-rate-limit');
const { pool } = require('../lib/db');
const auth = require('../lib/auth');
const { AppError, asyncHandler } = require('../lib/errors');
const logger = require('../lib/logger');

const log = logger.forModule('auth-route');
const router = express.Router();

// Login has no other brute-force protection -- rate-limiting by IP is the
// minimum viable defense against a password-guessing script. Keyed by IP
// alone so cycling usernames against the same IP doesn't dodge the limit.
const LOGIN_RATE_LIMIT_MESSAGE = { error: 'Too many login attempts. Please wait a few minutes and try again.' };
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    log.warn({ ip: req.ip }, 'login rate limit exceeded');
    res.status(429).json(LOGIN_RATE_LIMIT_MESSAGE);
  },
});

router.post('/login', loginLimiter, asyncHandler(async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) throw AppError.badRequest('Username and password are required.');
  const { rows } = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
  const user = rows[0];
  if (!user || !auth.verifyPassword(password, user.password_hash)) {
    log.warn({ username, ip: req.ip }, 'failed login attempt');
    throw AppError.unauthorized('Invalid username or password.');
  }
  const { token, expiresAt } = await auth.createSession(user.id);
  auth.setSessionCookie(res, token, expiresAt);
  await pool.query(`UPDATE users SET last_login_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = $1`, [user.id]);
  log.info({ userId: user.id, username: user.username, role: user.role }, 'login succeeded');
  res.json({ user: { username: user.username, role: user.role } });
}));

router.post('/logout', asyncHandler(async (req, res) => {
  // Was reading the generic 'sid' key here -- a leftover from before the
  // session cookie was renamed to server_watch_sid (to stop colliding with
  // other apps on the same host). Logout still cleared the browser's
  // cookie either way, but never actually looked up/deleted the right
  // session server-side, leaving it live in the sessions table until it
  // naturally expired 7 days later.
  const token = auth.parseCookies(req)[auth.COOKIE_NAME];
  await auth.destroySession(token);
  auth.clearSessionCookie(res);
  res.json({ ok: true });
}));

router.get('/me', auth.requireAuth, (req, res) => {
  res.json({ user: { username: req.user.username, role: req.user.role } });
});

router.post('/change-password', auth.requireAuth, asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) throw AppError.badRequest('Current and new password are required.');
  if (newPassword.length < 6) throw AppError.badRequest('New password must be at least 6 characters.');
  const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [req.user.id]);
  const user = rows[0];
  if (!auth.verifyPassword(currentPassword, user.password_hash)) {
    throw AppError.unauthorized('Current password is incorrect.');
  }
  await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [auth.hashPassword(newPassword), req.user.id]);
  log.info({ userId: user.id }, 'password changed');
  res.json({ ok: true });
}));

module.exports = router;
