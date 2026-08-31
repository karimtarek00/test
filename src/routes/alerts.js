const express = require('express');
const { pool } = require('../lib/db');
const { buildAlertFilters } = require('../lib/alertFilters');
const { asyncHandler } = require('../lib/errors');

const router = express.Router();

// GET /api/alerts?severity=&resolution=open|closed&serverId=&server=&alertName=&q=&from=&to=&page=&pageSize=
router.get('/', asyncHandler(async (req, res) => {
  const { page = '1', pageSize = '50' } = req.query;
  const { params, whereSql } = buildAlertFilters(req.query);

  // LEFT JOIN needed here too since the `server` filter can reference
  // s.hostname -- the count query has to see exactly the same rows the
  // paginated query below does, or `total` and the actual result set
  // disagree the moment that filter is used.
  const total = (await pool.query(`SELECT COUNT(*)::int AS c FROM alerts a LEFT JOIN servers s ON s.id = a.server_id ${whereSql}`, params)).rows[0].c;

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
