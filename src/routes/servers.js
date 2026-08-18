const express = require('express');
const { pool, isUniqueViolation } = require('../lib/db');
const { computeHealthScores, invalidateHealthScoreCache } = require('../lib/healthScore');
const { requireAdmin } = require('../lib/auth');
const { AppError, asyncHandler } = require('../lib/errors');
const { normalizeServerName } = require('../lib/serverNameMatch');

const router = express.Router();

// GET /api/servers?search=&environment=&dataCenter=&critical=&page=&pageSize=&sort=&dir=
router.get('/', asyncHandler(async (req, res) => {
  const {
    search = '', environment = '', dataCenter = '', critical = '', active = '1',
    page = '1', pageSize = '50', sort = 'hostname', dir = 'asc',
  } = req.query;

  const allowedSort = ['hostname', 'os_type', 'environment', 'data_center', 'created_at'];
  const sortCol = allowedSort.includes(sort) ? sort : 'hostname';
  const sortDir = dir === 'desc' ? 'DESC' : 'ASC';

  const where = [];
  const params = [];
  if (active !== 'all') { params.push(active === '0' ? 0 : 1); where.push(`s.active = $${params.length}`); }
  if (search) { params.push(`%${search}%`); where.push(`(s.hostname LIKE $${params.length} OR s.fqdn LIKE $${params.length})`); }
  if (environment) { params.push(environment); where.push(`s.environment = $${params.length}`); }
  if (dataCenter) { params.push(dataCenter); where.push(`s.data_center = $${params.length}`); }
  if (critical === '1') where.push('s.is_critical = 1');
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const limit = Math.min(parseInt(pageSize, 10) || 50, 200);
  const offset = (Math.max(parseInt(page, 10) || 1, 1) - 1) * limit;

  const countRes = await pool.query(`SELECT COUNT(*)::int AS total FROM servers s ${whereSql}`, params);
  const total = countRes.rows[0].total;

  params.push(limit, offset);
  const { rows } = await pool.query(`
    WITH paged AS (
      SELECT * FROM servers s
      ${whereSql}
      ORDER BY ${sortCol} ${sortDir}
      LIMIT $${params.length - 1} OFFSET $${params.length}
    )
    SELECT paged.*,
      (SELECT COUNT(*)::int FROM alerts a WHERE a.server_id = paged.id AND a.resolution_state_label != 'Closed') AS open_alert_count
    FROM paged
    ORDER BY ${sortCol} ${sortDir}
  `, params);

  res.json({ total, page: Number(page), pageSize: limit, servers: rows });
}));

// GET /api/servers/:id
router.get('/:id', asyncHandler(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM servers WHERE id = $1', [req.params.id]);
  if (!rows.length) throw AppError.notFound('Server not found');

  // "Total alerts" must be the server's real total, not derived from the
  // capped history list below -- that list only bounds the table's size.
  const [alerts, totals] = await Promise.all([
    pool.query(`SELECT * FROM alerts WHERE server_id = $1 ORDER BY created_at DESC LIMIT 200`, [req.params.id]),
    pool.query(
      `SELECT COUNT(*)::int AS total, SUM(CASE WHEN severity = 'Critical' AND resolution_state_label != 'Closed' THEN 1 ELSE 0 END)::int AS critical
         FROM alerts WHERE server_id = $1`,
      [req.params.id],
    ),
  ]);
  const health = await computeHealthScores();
  const serverHealth = health.find((h) => String(h.serverId) === String(req.params.id)) || null;

  res.json({
    server: rows[0],
    alerts: alerts.rows,
    totalAlertCount: totals.rows[0].total,
    totalCriticalOpenCount: totals.rows[0].critical || 0,
    health: serverHealth,
  });
}));

// POST /api/servers -- manual single-record add, independent of bulk import.
// No matter how good the bulk import is, there's always an edge case (a
// server SCOM knows about that isn't in anyone's spreadsheet yet).
router.post('/', requireAdmin, asyncHandler(async (req, res) => {
  const { hostname, fqdn, os_type, environment, business_unit, data_center, is_critical, notes } = req.body || {};
  if (!hostname) throw AppError.badRequest('hostname is required');
  const normalizedKey = normalizeServerName(fqdn || hostname);
  try {
    const { rows } = await pool.query(
      `INSERT INTO servers (hostname, fqdn, normalized_key, os_type, environment, business_unit, data_center, is_critical, notes, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'manual') RETURNING *`,
      [hostname, fqdn || null, normalizedKey, os_type || null, environment || null, business_unit || null, data_center || null, is_critical ? 1 : 0, notes || null]
    );
    invalidateHealthScoreCache();
    res.status(201).json(rows[0]);
  } catch (err) {
    if (isUniqueViolation(err)) throw AppError.conflict('A server with this identity already exists');
    throw err;
  }
}));

router.put('/:id', requireAdmin, asyncHandler(async (req, res) => {
  const { rows: existingRows } = await pool.query('SELECT * FROM servers WHERE id = $1', [req.params.id]);
  if (!existingRows.length) throw AppError.notFound('Server not found');
  const existing = existingRows[0];

  const hostname = req.body.hostname ?? existing.hostname;
  const fqdn = req.body.fqdn ?? existing.fqdn;
  const normalizedKey = normalizeServerName(fqdn || hostname);
  try {
    const { rows } = await pool.query(
      `UPDATE servers SET hostname=$1, fqdn=$2, normalized_key=$3, os_type=$4, environment=$5, business_unit=$6,
         data_center=$7, is_critical=$8, active=$9, notes=$10, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id=$11 RETURNING *`,
      [
        hostname, fqdn, normalizedKey,
        req.body.os_type ?? existing.os_type,
        req.body.environment ?? existing.environment,
        req.body.business_unit ?? existing.business_unit,
        req.body.data_center ?? existing.data_center,
        req.body.is_critical === undefined ? existing.is_critical : (req.body.is_critical ? 1 : 0),
        req.body.active === undefined ? existing.active : (req.body.active ? 1 : 0),
        req.body.notes ?? existing.notes,
        req.params.id,
      ]
    );
    invalidateHealthScoreCache();
    res.json(rows[0]);
  } catch (err) {
    if (isUniqueViolation(err)) throw AppError.conflict('A server with this identity already exists');
    throw err;
  }
}));

router.delete('/:id', requireAdmin, asyncHandler(async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM servers WHERE id = $1', [req.params.id]);
  if (!rowCount) throw AppError.notFound('Server not found');
  invalidateHealthScoreCache();
  res.status(204).end();
}));

module.exports = router;
