// Fleet-relative health score: normalized 0-100 per server, from open-alert
// volume + severity mix + type repetition + distinct active days, all
// normalized against the busiest server. Same formula shape as the
// reference app's device health score.
//
// Simplified relative to the reference implementation on purpose: that
// version adds rowid-sampling and multiple layered caches because it has to
// stay fast over multi-million-row alarm tables. This app is nowhere near
// that scale yet (hundreds to low thousands of alerts), so a single
// `computeHealthScores()` cache -- invalidated on every write, same trigger
// points -- is the right amount of complexity for now. If this app's data
// volume grows the way the reference app's did, healthScore.js there is the
// template to port the sampling strategy back in from.
const { pool } = require('./db');

let cache = null;

function invalidateHealthScoreCache() {
  cache = null;
}

function riskRaw(r, maxCount) {
  if (r.alarm_count === 0) return 0;
  const volumeNorm = r.alarm_count / maxCount;
  const sevNorm = (r.avg_severity_weight - 1) / 2;
  const repeatRatio = 1 - (r.distinct_types / r.alarm_count);
  const daysNorm = Math.min(r.distinct_days, 8) / 8;
  return volumeNorm * 40 + sevNorm * 30 + repeatRatio * 15 + daysNorm * 15;
}

function scoreServerRows(rows) {
  const maxCount = Math.max(...rows.map((r) => r.alarm_count), 1);
  const maxRisk = Math.max(...rows.map((r) => riskRaw(r, maxCount)), 1);

  return rows.map((r) => {
    const raw = riskRaw(r, maxCount);
    const riskScore = (raw / maxRisk) * 100;
    const healthScore = Math.round((100 - riskScore) * 10) / 10;
    return {
      serverId: r.server_id,
      hostname: r.hostname,
      alarmCount: r.alarm_count,
      avgSeverityWeight: Math.round(r.avg_severity_weight * 100) / 100,
      distinctTypes: r.distinct_types,
      distinctDays: r.distinct_days,
      healthScore: r.alarm_count === 0 ? 100 : healthScore,
    };
  });
}

async function computeHealthScores() {
  if (cache) return cache;

  const { rows } = await pool.query(`
    SELECT
      s.id AS server_id,
      s.hostname AS hostname,
      COUNT(a.id)::int AS alarm_count,
      COALESCE(AVG(CASE WHEN a.severity = 'Critical' THEN 3 ELSE 1 END), 1)::float AS avg_severity_weight,
      COUNT(DISTINCT a.alert_name)::int AS distinct_types,
      COUNT(DISTINCT date(a.created_at))::int AS distinct_days
    FROM servers s
    LEFT JOIN alerts a ON a.server_id = s.id AND a.resolution_state_label != 'Closed'
    WHERE s.active = 1
    GROUP BY s.id, s.hostname
  `);

  cache = scoreServerRows(rows);
  return cache;
}

module.exports = { computeHealthScores, invalidateHealthScoreCache };
