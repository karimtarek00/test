import crypto from 'node:crypto';
import { get, run, withWriteLock } from './db.js';

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const check = crypto.scryptSync(password, salt, 64).toString('hex');
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(check, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function createSession(userId) {
  const id = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  return withWriteLock(() => {
    run('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)', [id, userId, expiresAt]);
    return { id, expiresAt };
  });
}

export function getSession(sessionId) {
  if (!sessionId) return null;
  const session = get('SELECT * FROM sessions WHERE id = ?', [sessionId]);
  if (!session) return null;
  if (new Date(session.expires_at) < new Date()) return null;
  const user = get('SELECT id, username, role FROM users WHERE id = ?', [session.user_id]);
  if (!user) return null;
  return { session, user };
}

export function destroySession(sessionId) {
  return withWriteLock(() => run('DELETE FROM sessions WHERE id = ?', [sessionId]));
}

export function findUserByUsername(username) {
  return get('SELECT * FROM users WHERE username = ?', [username]);
}
