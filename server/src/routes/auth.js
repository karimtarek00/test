import { Router } from 'express';
import { createSession, destroySession, findUserByUsername, verifyPassword } from '../lib/auth.js';

const router = Router();
const isProd = process.env.NODE_ENV === 'production';

router.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

  const user = findUserByUsername(username);
  if (!user || !verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const session = await createSession(user.id);
  res.cookie('sid', session.id, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProd,
    expires: new Date(session.expiresAt),
  });
  res.json({ user: { id: user.id, username: user.username, role: user.role } });
});

router.post('/logout', async (req, res) => {
  const sessionId = req.cookies?.sid;
  if (sessionId) await destroySession(sessionId);
  res.clearCookie('sid');
  res.json({ ok: true });
});

router.get('/me', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  res.json({ user: req.user });
});

export default router;
