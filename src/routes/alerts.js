const express = require('express');
const { pool, endOfDay } = require('../lib/db');
const { asyncHandler } = require('../lib/errors');

const router = express.Router();

// GET /api/alerts?severity=&resolution=open|closed&serverId=&q=&from=&to=&page=&pageSize=
router.get('/', asyncHandler(async (req, res) => {
  const { severity = '', resolution = '', serverId = '', q = '', from = '', to = '', page = '1', pageSize = '50' } = req.query;
  const where = [];
  const params = [];

  if (severity) { params.push(severity); where.push(`a.severity = $${params.length}`); }
  if (resolution === 'open') where.push(`a.resolution_state_label != 'Closed'`);
  else if (resolution === 'closed') where.push(`a.resolution_state_label = 'Closed'`);
  if (serverId) { params.push(serverId); where.push(`a.server_id = $${params.length}`); }
  if (q) { params.push(`%${q}%`, `%${q}%`); where.push(`(a.alert_name LIKE $${params.length - 1} OR a.server_name_raw LIKE $${params.length})`); }
  if (from) { params.push(from); where.push(`a.created_at >= $${params.length}`); }
  if (to) { params.push(endOfDay(to)); where.push(`a.created_at <= $${params.length}`); }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (await pool.query(`SELECT COUNT(*)::int AS c FROM alerts a ${whereSql}`, params)).rows[0].c;

  const limit = Math.min(parseInt(pageSize, 10) || 50, 200);
  const offset = (Math.max(parseInt(page, 10) || 1, 1) - 1) * limit;
  params.push(limit, offset);

  const { rows } = await pool.query(`
    SELECT a.id, a.alert_name, a.severity, a.resolution_state_label, a.server_name_raw,
           a.source, a.created_at, s.hostname, s.id AS server_id
    FROM alerts a LEFT JOIN servers s ON s.id = a.server_id
    ${whereSql}
    ORDER BY a.created_at DESC
    LIMIT $${params.length - 1} OFFSET $${params.length}
  `, params);

  res.json({ total, page: Number(page), pageSize: limit, alerts: rows });
}));

module.exports = router;
