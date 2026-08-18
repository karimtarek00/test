import { Router } from 'express';
import { all, get, run, withWriteLock } from '../lib/db.js';
import { hashPassword } from '../lib/auth.js';
import { requireAdmin } from '../middleware/auth.js';

const router = Router();

router.get('/', requireAdmin, (req, res) => {
  const rows = all('SELECT id, username, role, created_at FROM users ORDER BY username ASC');
  res.json({ rows });
});

router.post('/', requireAdmin, async (req, res) => {
  const { username, password, role } = req.body || {};
  if (!username || !password || !['admin', 'viewer'].includes(role)) {
    return res.status(400).json({ error: 'username, password, and a valid role are required' });
  }
  if (get('SELECT id FROM users WHERE username = ?', [username])) {
    return res.status(409).json({ error: 'Username already exists' });
  }
  const result = await withWriteLock(() =>
    run('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)', [username, hashPassword(password), role]),
  );
  res.status(201).json({ id: Number(result.lastInsertRowid) });
});

router.delete('/:id', requireAdmin, async (req, res) => {
  if (Number(req.params.id) === req.user.id) {
    return res.status(400).json({ error: 'Cannot delete your own account' });
  }
  await withWriteLock(() => run('DELETE FROM users WHERE id = ?', [req.params.id]));
  res.json({ ok: true });
});

export default router;
