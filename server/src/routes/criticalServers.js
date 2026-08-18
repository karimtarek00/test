import { Router } from 'express';
import { all } from '../lib/db.js';

const router = Router();

// Critical Servers watchlist, grouped for the dashboard. Grouping field
// (data_center for now) is a placeholder until the user confirms what
// grouping makes sense for their environment - see brief S5.
router.get('/', (req, res) => {
  const rows = all(`
    SELECT s.*,
      (SELECT COUNT(*) FROM alerts a WHERE a.server_id = s.id AND a.resolution_state_label != 'Closed' AND a.severity = 'Critical') as critical_open,
      (SELECT COUNT(*) FROM alerts a WHERE a.server_id = s.id AND a.resolution_state_label != 'Closed' AND a.severity = 'Warning') as warning_open
    FROM servers s
    WHERE s.is_critical = 1 AND s.active = 1
    ORDER BY COALESCE(s.data_center, 'Ungrouped') ASC, s.hostname ASC
  `);

  const groups = {};
  for (const row of rows) {
    const key = row.data_center || 'Ungrouped';
    groups[key] = groups[key] || [];
    const status = row.critical_open > 0 ? 'red' : row.warning_open > 0 ? 'yellow' : 'green';
    groups[key].push({ ...row, status });
  }

  res.json({ groups });
});

export default router;
