import { Router } from 'express';
import { all, get } from '../lib/db.js';
import { computeFleetHealthScore } from '../lib/healthScore.js';

const router = Router();

router.get('/summary', (req, res) => {
  // Every KPI gets its own COUNT(*) - never derived from a display-limited
  // list (lesson learned #5).
  const totalOpen = get(`SELECT COUNT(*) as c FROM alerts WHERE resolution_state_label != 'Closed'`).c;
  const critical = get(`SELECT COUNT(*) as c FROM alerts WHERE resolution_state_label != 'Closed' AND severity='Critical'`).c;
  const warning = get(`SELECT COUNT(*) as c FROM alerts WHERE resolution_state_label != 'Closed' AND severity='Warning'`).c;
  const serversMonitored = get(`SELECT COUNT(*) as c FROM servers WHERE active = 1`).c;
  const closedLast7d = get(
    `SELECT COUNT(*) as c FROM alerts WHERE resolution_state_label = 'Closed' AND created_at >= datetime('now','-7 days')`,
  ).c;

  const openByServer = all(
    `SELECT server_id, severity, created_at FROM alerts WHERE resolution_state_label != 'Closed' AND server_id IS NOT NULL`,
  );
  const grouped = {};
  for (const row of openByServer) {
    grouped[row.server_id] = grouped[row.server_id] || [];
    grouped[row.server_id].push(row);
  }
  const healthScore = computeFleetHealthScore(grouped);

  const recentAlerts = all(
    `SELECT a.id, a.alert_name, a.severity, a.resolution_state_label, a.server_name_raw, a.created_at, s.hostname
     FROM alerts a LEFT JOIN servers s ON s.id = a.server_id
     ORDER BY a.created_at DESC LIMIT 10`,
  );

  const severityBreakdown = all(
    `SELECT severity, COUNT(*) as count FROM alerts WHERE resolution_state_label != 'Closed' GROUP BY severity`,
  );

  res.json({
    kpis: { totalOpen, critical, warning, serversMonitored, closedLast7d, healthScore },
    severityBreakdown,
    recentAlerts,
  });
});

export default router;
