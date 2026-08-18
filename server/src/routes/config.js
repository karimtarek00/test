import { Router } from 'express';
import { all, get, withWriteLock, run } from '../lib/db.js';
import { requireAdmin } from '../middleware/auth.js';

const router = Router();

// Keys intentionally kept generic - this is where the SCOM SQL connection
// (or, later, REST API) settings live once access is granted.
const KNOWN_KEYS = [
  'scom_sql_host',
  'scom_sql_port',
  'scom_sql_database',
  'scom_sql_auth_mode',
  'scom_sql_username',
  'scom_sql_password',
  'sync_incremental_interval_minutes',
  'sync_full_interval_minutes',
];

router.get('/', requireAdmin, (req, res) => {
  const rows = all('SELECT key, value FROM settings');
  const settings = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  if (settings.scom_sql_password) settings.scom_sql_password = '••••••••';
  res.json({ settings, knownKeys: KNOWN_KEYS, syncConfigured: Boolean(settings.scom_sql_host) });
});

router.put('/', requireAdmin, async (req, res) => {
  const body = req.body || {};
  await withWriteLock(() => {
    for (const key of KNOWN_KEYS) {
      if (key in body) {
        run(
          `INSERT INTO settings (key, value) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
          [key, body[key] === null ? null : String(body[key])],
        );
      }
    }
  });
  res.json({ ok: true });
});

export default router;
