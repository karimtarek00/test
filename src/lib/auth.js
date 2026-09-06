// Minimal auth: two roles (admin / viewer), scrypt password hashing (Node's
// built-in crypto -- no bcrypt/native dependency), token sessions stored in
// SQLite and handed out as an httpOnly cookie. Default accounts are seeded
// once, on first run.
const crypto = require('crypto');
const { pool } = require('./db');
const config = require('./config');
const logger = require('./logger');
const { AppError } = require('./errors');

const log = logger.forModule('auth');

const SESSION_DAYS = 7;
// A generic name like "sid" collides with other internal apps that use the
// same default -- cookies are scoped by domain+path only, NOT by port, so
// two different apps on the same hostname (even on different ports) sharing
// a cookie name silently overwrite each other's session, signing one out
// whenever the other logs in. Namespaced to this specific app to avoid it.
const COOKIE_NAME = 'server_watch_sid';

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, hash] = parts;
  const check = crypto.scryptSync(password, salt, 64).toString('hex');
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(check, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Seeds one admin and one viewer account the first time the app runs
// against a fresh database. Safe to call on every boot -- no-ops once any
// user exists.
async function seedDefaultUsers() {
  const { rows } = await pool.query('SELECT COUNT(*)::int AS c FROM users');
  if (rows[0].c > 0) return;
  await pool.query(`INSERT INTO users (username, password_hash, role) VALUES ($1,$2,'admin')`,
    ['admin', hashPassword('admin123')]);
  await pool.query(`INSERT INTO users (username, password_hash, role) VALUES ($1,$2,'viewer')`,
    ['viewer', hashPassword('viewer123')]);
  // Deliberately does NOT log the actual default passwords -- this log line
  // ends up in logs/out.log, which may eventually feed a log
  // aggregator/monitoring platform. An admin who needs the defaults looks
  // in the runbook/README.
  log.info('seeded default accounts (admin, viewer) -- see README for default credentials, change them after first login');
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  header.split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    out[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
  });
  return out;
}

async function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  await pool.query('INSERT INTO sessions (token, user_id, expires_at) VALUES ($1,$2,$3)', [token, userId, expiresAt]);
  return { token, expiresAt };
}

// Secure requires HTTPS -- a browser silently drops a Secure cookie sent
// over plain HTTP, which would break login entirely on an HTTP-only LAN
// deployment. Defaults off (see config.js's comment on SESSION_COOKIE_SECURE).
const cookieFlags = () => `Path=/; HttpOnly; SameSite=Lax${config.SESSION_COOKIE_SECURE ? '; Secure' : ''}`;

function setSessionCookie(res, token, expiresAt) {
  const expires = new Date(expiresAt).toUTCString();
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${token}; ${cookieFlags()}; Expires=${expires}`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; ${cookieFlags()}; Max-Age=0`);
}

async function destroySession(token) {
  if (token) await pool.query('DELETE FROM sessions WHERE token = $1', [token]);
}

// Attaches req.user ({id, username, role}) when a valid session cookie is
// present; otherwise responds 401.
async function requireAuth(req, res, next) {
  try {
    const token = parseCookies(req)[COOKIE_NAME];
    if (!token) return next(AppError.unauthorized('Not logged in', 'NOT_LOGGED_IN'));
    const { rows } = await pool.query(
      `SELECT u.id, u.username, u.role, s.expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token = $1`,
      [token]
    );
    const session = rows[0];
    if (!session || new Date(session.expires_at) < new Date()) {
      if (session) await pool.query('DELETE FROM sessions WHERE token = $1', [token]);
      log.warn({ hadSession: !!session }, 'rejected request with missing/expired session');
      return next(AppError.unauthorized('Session expired -- please log in again.', 'SESSION_EXPIRED'));
    }
    req.user = { id: session.id, username: session.username, role: session.role };
    req.sessionToken = token;
    next();
  } catch (err) {
    next(err);
  }
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') {
    log.warn({ userId: req.user?.id, username: req.user?.username }, 'rejected admin-only request from non-admin user');
    return next(AppError.forbidden('Admin access required.', 'ADMIN_REQUIRED'));
  }
  next();
}

module.exports = {
  hashPassword, verifyPassword, seedDefaultUsers,
  createSession, setSessionCookie, clearSessionCookie, destroySession,
  requireAuth, requireAdmin, parseCookies, COOKIE_NAME,
};
