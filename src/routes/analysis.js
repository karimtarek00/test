// Backing for the "Live Data & Analysis" page: aggregated breakdowns over
// the alerts table, filterable by the same server/alertName/severity/date
// params as the Alarms page (see lib/alertFilters.js) so the two stay
// consistent with each other. The filtered incidents table itself reuses
// GET /api/alerts directly rather than duplicating that query here.
//
// Deliberately does NOT invent an "alarm category" grouping (Link Down /
// Interface / Availability / etc., the way the reference Network Dashboard
// app does) -- that app's categories come from real structured SNMP trap
// data; guessing a category from this app's free-text SCOM alert names
// would be exactly the kind of fabricated structure this project has
// avoided everywhere else. Severity and resolution state are used instead
// since both are real, already-validated fields.
const express = require('express');
const { pool } = require('../lib/db');
const { buildAlertFilters } = require('../lib/alertFilters');
const { asyncHandler } = require('../lib/errors');

const router = express.Router();
const JOIN = `FROM alerts a LEFT JOIN servers s ON s.id = a.server_id`;

router.get('/summary', asyncHandler(async (req, res) => {
  const { where, params, whereSql } = buildAlertFilters(req.query);
  const andWhere = (extra) => (where.length ? `WHERE ${[...where, extra].join(' AND ')}` : `WHERE ${extra}`);

  const [
    totalRow, devicesRow, criticalRow,
    topAlarmTypes, topDevices, severitySplit, resolutionSplit,
    hourlyRows, monthlyRows, peakDayRows, mostAffectedRows,
  ] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int AS c ${JOIN} ${whereSql}`, params),
    pool.query(`SELECT COUNT(DISTINCT COALESCE(s.id, a.server_name_raw))::int AS c ${JOIN} ${whereSql}`, params),
    pool.query(`SELECT COUNT(*)::int AS c ${JOIN} ${andWhere("a.severity='Critical'")}`, params),
    pool.query(`SELECT a.alert_name AS name, COUNT(*)::int AS count ${JOIN} ${whereSql} GROUP BY a.alert_name ORDER BY count DESC LIMIT 10`, params),
    pool.query(`SELECT COALESCE(s.hostname, a.server_name_raw) AS name, COUNT(*)::int AS count ${JOIN} ${whereSql} GROUP BY name ORDER BY count DESC LIMIT 10`, params),
    pool.query(`SELECT a.severity AS severity, COUNT(*)::int AS count ${JOIN} ${whereSql} GROUP BY a.severity ORDER BY count DESC`, params),
    pool.query(`SELECT a.resolution_state_label AS label, COUNT(*)::int AS count ${JOIN} ${whereSql} GROUP BY a.resolution_state_label ORDER BY count DESC`, params),
    pool.query(`SELECT CAST(strftime('%H', a.created_at) AS INTEGER) AS hour, COUNT(*)::int AS count ${JOIN} ${whereSql} GROUP BY hour ORDER BY hour`, params),
    pool.query(`SELECT strftime('%Y-%m', a.created_at) AS month, COUNT(*)::int AS count ${JOIN} ${whereSql} GROUP BY month ORDER BY month`, params),
    pool.query(`SELECT strftime('%Y-%m-%d', a.created_at) AS day, COUNT(*)::int AS count ${JOIN} ${whereSql} GROUP BY day ORDER BY count DESC LIMIT 1`, params),
    pool.query(`SELECT COALESCE(s.hostname, a.server_name_raw) AS name, COUNT(*)::int AS count ${JOIN} ${whereSql} GROUP BY name ORDER BY count DESC LIMIT 1`, params),
  ]);

  // Zero-fill all 24 hours -- GROUP BY only returns hours that actually
  // occurred, but a bar chart with gaps at unused hours reads as missing
  // data rather than "genuinely zero alerts that hour."
  const hourlyByHour = new Map(hourlyRows.rows.map((r) => [r.hour, r.count]));
  const hourlyDistribution = Array.from({ length: 24 }, (_, hour) => ({ hour, count: hourlyByHour.get(hour) || 0 }));

  const peakHourRow = hourlyDistribution.reduce((best, r) => (r.count > (best?.count || 0) ? r : best), null);

  res.json({
    kpis: {
      totalAlarms: totalRow.rows[0].c,
      devicesAffected: devicesRow.rows[0].c,
      criticalAlarms: criticalRow.rows[0].c,
      mostAffectedDevice: mostAffectedRows.rows[0] || null,
      peakDay: peakDayRows.rows[0] || null,
      peakHour: peakHourRow && peakHourRow.count > 0 ? peakHourRow : null,
    },
    topAlarmTypes: topAlarmTypes.rows,
    topDevices: topDevices.rows,
    severitySplit: severitySplit.rows,
    resolutionSplit: resolutionSplit.rows,
    hourlyDistribution,
    monthlyTrend: monthlyRows.rows,
  });
}));

// Distinct alert names for the "Alarm Type" filter dropdown -- a real,
// bounded list (a few hundred at most in practice), not a free-text guess.
router.get('/alert-types', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(`SELECT DISTINCT alert_name FROM alerts ORDER BY alert_name ASC`);
  res.json({ alertTypes: rows.map((r) => r.alert_name) });
}));

module.exports = router;
