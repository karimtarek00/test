const express = require('express');
const { pool } = require('../lib/db');
const { requireAdmin } = require('../lib/auth');
const { asyncHandler } = require('../lib/errors');

const router = express.Router();

// Read-only for any authenticated user -- this only ever displays live
// status, it never lets a client change anything (that's Inventory's
// per-server "Critical" toggle, requireAdmin there).
//
// Grouping is by data_center for now -- a placeholder until the user
// confirms what grouping actually fits their environment (the reference
// app's watchlist groups "by Data Center" too; this app's brief flagged
// the same question as open for servers -- see README's Known gaps).
router.get('/', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(`
    SELECT s.*,
      (SELECT COUNT(*)::int FROM alerts a WHERE a.server_id = s.id AND a.resolution_state_label != 'Closed' AND a.severity = 'Critical') AS critical_open,
      (SELECT COUNT(*)::int FROM alerts a WHERE a.server_id = s.id AND a.resolution_state_label != 'Closed' AND a.severity = 'Warning') AS warning_open
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
}));

module.exports = router;
