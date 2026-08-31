const express = require('express');
const { pool } = require('../lib/db');
const { computeHealthScores } = require('../lib/healthScore');
const { asyncHandler } = require('../lib/errors');

const router = express.Router();

router.get('/summary', asyncHandler(async (req, res) => {
  // Every KPI gets its own COUNT(*) query -- never derived from a
  // display-limited list. A real bug in the reference app's device detail
  // page did exactly that (a "Total alarms" KPI silently capped at 200
  // because it reused a history-table query with a LIMIT) -- worth
  // guarding against explicitly here too.
  const [totalOpen, critical, warning, serversMonitored, closedLast7d] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int AS c FROM alerts WHERE resolution_state_label != 'Closed'`),
    pool.query(`SELECT COUNT(*)::int AS c FROM alerts WHERE resolution_state_label != 'Closed' AND severity='Critical'`),
    pool.query(`SELECT COUNT(*)::int AS c FROM alerts WHERE resolution_state_label != 'Closed' AND severity='Warning'`),
    pool.query(`SELECT COUNT(*)::int AS c FROM servers WHERE active = 1`),
    // resolved_at (when it was actually closed), not created_at (when it
    // was first raised) -- these diverge for any alert open more than a
    // few minutes, which is nearly all of them.
    pool.query(`SELECT COUNT(*)::int AS c FROM alerts WHERE resolution_state_label = 'Closed' AND resolved_at >= datetime('now','-7 days')`),
  ]);

  const health = await computeHealthScores();
  const withAlerts = health.filter((h) => h.alarmCount > 0);
  const fleetHealthScore = withAlerts.length
    ? Math.round(withAlerts.reduce((sum, h) => sum + h.healthScore, 0) / withAlerts.length)
    : 100;
  const worstHealthServers = [...withAlerts].sort((a, b) => a.healthScore - b.healthScore).slice(0, 10);

  const { rows: severityBreakdown } = await pool.query(
    `SELECT severity, COUNT(*)::int AS count FROM alerts WHERE resolution_state_label != 'Closed' GROUP BY severity`
  );
  const { rows: recentAlerts } = await pool.query(`
    SELECT a.id, a.alert_name, a.severity, a.resolution_state_label, a.server_name_raw, a.created_at, s.hostname
    FROM alerts a LEFT JOIN servers s ON s.id = a.server_id
    ORDER BY a.created_at DESC LIMIT 10
  `);

  res.json({
    kpis: {
      totalOpen: totalOpen.rows[0].c,
      critical: critical.rows[0].c,
      warning: warning.rows[0].c,
      serversMonitored: serversMonitored.rows[0].c,
      closedLast7d: closedLast7d.rows[0].c,
      healthScore: fleetHealthScore,
    },
    severityBreakdown,
    recentAlerts,
    worstHealthServers,
  });
}));

router.get('/health-scores', asyncHandler(async (req, res) => {
  const health = await computeHealthScores();
  health.sort((a, b) => a.healthScore - b.healthScore);
  res.json({ health });
}));

module.exports = router;
