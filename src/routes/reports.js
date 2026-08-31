const express = require('express');
const { pool } = require('../lib/db');
const { generateReport, REPORT_TYPES, REPORT_FORMATS } = require('../lib/reportGenerators');
const { asyncHandler } = require('../lib/errors');
const logger = require('../lib/logger');

const log = logger.forModule('reports');
const router = express.Router();

router.get('/types', (req, res) => {
  res.json({ reportTypes: REPORT_TYPES, formats: REPORT_FORMATS });
});

// One generic endpoint for all 3 report types x 3 formats -- see
// lib/reportGenerators.js for why the type/format matrix is handled by two
// small dispatch tables instead of nine separate route handlers.
router.get('/generate/:type/:format', asyncHandler(async (req, res) => {
  const { type, format } = req.params;
  const { from = '', to = '', severity = '', server = '', alertName = '' } = req.query;
  const params = { from, to, severity, server, alertName };

  try {
    await generateReport(type, format, params, res);
    await pool.query(
      `INSERT INTO report_jobs (report_type, format, params, requested_by, status) VALUES ($1, $2, $3, $4, 'completed')`,
      [type, format, JSON.stringify(params), req.user?.id || null]
    );
  } catch (err) {
    // Response may not have been written yet (model-build failures happen
    // before any renderer touches `res`) -- safe to still log the failure
    // either way, and safe to let asyncHandler's error middleware respond
    // only when headers haven't already gone out.
    await pool.query(
      `INSERT INTO report_jobs (report_type, format, params, requested_by, status, error) VALUES ($1, $2, $3, $4, 'failed', $5)`,
      [type, format, JSON.stringify(params), req.user?.id || null, err.message]
    ).catch((logErr) => log.error({ err: logErr }, 'failed to log failed report_jobs row'));
    if (res.headersSent) { log.error({ err }, 'report generation failed after streaming began'); return; }
    throw err;
  }
}));

router.get('/history', asyncHandler(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  const { rows } = await pool.query(`
    SELECT rj.id, rj.report_type, rj.format, rj.params, rj.status, rj.error, rj.created_at, u.username AS requested_by
    FROM report_jobs rj LEFT JOIN users u ON u.id = rj.requested_by
    ORDER BY rj.created_at DESC LIMIT $1
  `, [limit]);
  res.json({ jobs: rows.map((r) => ({ ...r, params: JSON.parse(r.params || '{}') })) });
}));

// Re-download: re-runs the same query against current data rather than
// storing the generated file (see the report_jobs schema comment) -- so a
// redownload of an old job can legitimately return different row counts if
// data changed since, which is expected, not a bug.
router.get('/history/:id/redownload', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(`SELECT * FROM report_jobs WHERE id = $1`, [req.params.id]);
  const job = rows[0];
  if (!job) return res.status(404).json({ error: 'Report job not found' });
  const params = JSON.parse(job.params || '{}');
  await generateReport(job.report_type, job.format, params, res);
}));

module.exports = router;
