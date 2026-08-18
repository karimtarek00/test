import { Router } from 'express';
import { all, get, run, withWriteLock } from '../lib/db.js';
import { normalizeServerName } from '../lib/normalize.js';
import { requireAdmin } from '../middleware/auth.js';

const router = Router();

router.get('/', (req, res) => {
  const { q, environment, dataCenter, critical, active = '1' } = req.query;
  const conditions = [];
  const params = [];

  if (active !== 'all') {
    conditions.push('active = ?');
    params.push(active === '0' ? 0 : 1);
  }
  if (q) {
    conditions.push('(hostname LIKE ? OR fqdn LIKE ?)');
    params.push(`%${q}%`, `%${q}%`);
  }
  if (environment) {
    conditions.push('environment = ?');
    params.push(environment);
  }
  if (dataCenter) {
    conditions.push('data_center = ?');
    params.push(dataCenter);
  }
  if (critical === '1') {
    conditions.push('is_critical = 1');
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = all(
    `SELECT s.*,
       (SELECT COUNT(*) FROM alerts a WHERE a.server_id = s.id AND a.resolution_state_label != 'Closed') as open_alert_count
     FROM servers s ${where} ORDER BY hostname ASC`,
    params,
  );
  res.json({ rows, total: rows.length });
});

router.get('/:id', (req, res) => {
  const server = get('SELECT * FROM servers WHERE id = ?', [req.params.id]);
  if (!server) return res.status(404).json({ error: 'Not found' });
  const alerts = all('SELECT * FROM alerts WHERE server_id = ? ORDER BY created_at DESC LIMIT 100', [server.id]);
  const totalAlertCount = get('SELECT COUNT(*) as c FROM alerts WHERE server_id = ?', [server.id]).c;
  res.json({ server, alerts, totalAlertCount });
});

// Lesson learned #3: manual single-record override in the UI, independent of bulk import.
router.post('/', requireAdmin, async (req, res) => {
  const { hostname, fqdn, os_type, environment, business_unit, data_center, is_critical } = req.body || {};
  if (!hostname) return res.status(400).json({ error: 'hostname is required' });

  const normalized = normalizeServerName(fqdn || hostname);
  const existing = get('SELECT id FROM servers WHERE normalized_key = ?', [normalized]);
  if (existing) return res.status(409).json({ error: 'A server with this identity already exists' });

  const result = await withWriteLock(() =>
    run(
      `INSERT INTO servers (hostname, fqdn, normalized_key, os_type, environment, business_unit, data_center, is_critical, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'manual')`,
      [hostname, fqdn || null, normalized, os_type || null, environment || null, business_unit || null, data_center || null, is_critical ? 1 : 0],
    ),
  );
  res.status(201).json({ id: Number(result.lastInsertRowid) });
});

router.put('/:id', requireAdmin, async (req, res) => {
  const server = get('SELECT * FROM servers WHERE id = ?', [req.params.id]);
  if (!server) return res.status(404).json({ error: 'Not found' });

  const { hostname, fqdn, os_type, environment, business_unit, data_center, is_critical, active, notes } = req.body || {};
  const normalized = normalizeServerName(fqdn ?? server.fqdn ?? hostname ?? server.hostname);

  await withWriteLock(() =>
    run(
      `UPDATE servers SET hostname=?, fqdn=?, normalized_key=?, os_type=?, environment=?, business_unit=?,
         data_center=?, is_critical=?, active=?, notes=?, updated_at=datetime('now') WHERE id=?`,
      [
        hostname ?? server.hostname,
        fqdn ?? server.fqdn,
        normalized,
        os_type ?? server.os_type,
        environment ?? server.environment,
        business_unit ?? server.business_unit,
        data_center ?? server.data_center,
        is_critical === undefined ? server.is_critical : (is_critical ? 1 : 0),
        active === undefined ? server.active : (active ? 1 : 0),
        notes ?? server.notes,
        server.id,
      ],
    ),
  );
  res.json({ ok: true });
});

export default router;
