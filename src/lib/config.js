const fs = require('fs');
const path = require('path');

// Loads app/.env (if present) into process.env before anything else reads
// it. Silent no-op when the file doesn't exist (a fresh dev checkout, or a
// production install using real OS-level env vars set by
// ecosystem.config.js instead).
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env'), quiet: true });

// Single place every module reads runtime configuration from, instead of
// scattering raw `process.env.X` reads around the codebase.
const NODE_ENV = process.env.NODE_ENV || 'development';
const isProduction = NODE_ENV === 'production';

const PORT = Number(process.env.PORT) || 8080;

const SQLITE_PATH = process.env.SQLITE_PATH || path.join(__dirname, '..', '..', 'data', 'server_watch.db');

const LOG_LEVEL = process.env.LOG_LEVEL || (isProduction ? 'info' : 'debug');

const LOG_DIR = process.env.LOG_DIR || path.join(__dirname, '..', '..', 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });

// Browsers silently refuse to STORE a Secure cookie over plain HTTP -- not
// an error, not a warning, the Set-Cookie header is just dropped. This app
// has no built-in TLS termination, and the overwhelmingly common
// deployment is an internal LAN app reached over plain http://, still with
// NODE_ENV=production set (for logging/perf, unrelated to whether TLS is
// in front of it). Defaulting this to true whenever NODE_ENV=production
// would cause login to appear to succeed (the server sets a valid session)
// while the browser never actually keeps the cookie -- a silent, total
// login lockout. Defaulting off is the safe choice: only set true if this
// instance is genuinely served over HTTPS (directly or via a reverse proxy).
const SESSION_COOKIE_SECURE = process.env.SESSION_COOKIE_SECURE === 'true';

module.exports = {
  NODE_ENV,
  isProduction,
  PORT,
  SQLITE_PATH,
  LOG_LEVEL,
  LOG_DIR,
  SESSION_COOKIE_SECURE,
};
