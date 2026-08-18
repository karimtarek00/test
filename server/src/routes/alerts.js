import { Router } from 'express';
import { all, get } from '../lib/db.js';

const router = Router();

router.get('/', (req, res) => {
  const { severity, resolution, q, page = '1', pageSize = '50' } = req.query;
  const conditions = [];
  const params = [];

  if (severity) {
    conditions.push('a.severity = ?');
    params.push(severity);
  }
  if (resolution === 'open') {
    conditions.push(`a.resolution_state_label != 'Closed'`);
  } else if (resolution === 'closed') {
    conditions.push(`a.resolution_state_label = 'Closed'`);
  }
  if (q) {
    conditions.push('(a.alert_name LIKE ? OR a.server_name_raw LIKE ?)');
    params.push(`%${q}%`, `%${q}%`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const total = get(`SELECT COUNT(*) as c FROM alerts a ${where}`, params).c;

  const limit = Math.min(parseInt(pageSize, 10) || 50, 200);
  const offset = (Math.max(parseInt(page, 10) || 1, 1) - 1) * limit;

  const rows = all(
    `SELECT a.id, a.alert_name, a.severity, a.resolution_state_label, a.server_name_raw,
            a.source, a.created_at, s.hostname, s.id as server_id
     FROM alerts a LEFT JOIN servers s ON s.id = a.server_id
     ${where}
     ORDER BY a.created_at DESC
     LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );

  res.json({ rows, total, page: Number(page), pageSize: limit });
});

export default router;
