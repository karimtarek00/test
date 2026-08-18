import { getSession } from '../lib/auth.js';

export function attachUser(req, res, next) {
  const sessionId = req.cookies?.sid;
  const result = getSession(sessionId);
  req.user = result?.user || null;
  next();
}

export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  next();
}

export function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  next();
}
