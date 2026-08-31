// Shared WHERE-clause builder for the alerts table, used by both
// routes/alerts.js (the Alarms page) and routes/analysis.js (the Live Data
// & Analysis page) so the two never drift out of sync on what a given
// filter actually means -- they need to agree exactly, since Analysis's
// "Top Alarm Types" bars are meant to be a summary of the same rows the
// Alarms page would show for the same filters.
//
// Every query built from this assumes `alerts a LEFT JOIN servers s ON
// s.id = a.server_id` is in the FROM clause -- callers must include that
// join even in a bare COUNT(*), since the `server` filter references
// s.hostname.
const { endOfDay } = require('./db');

function buildAlertFilters(query) {
  const { severity = '', resolution = '', serverId = '', server = '', alertName = '', q = '', from = '', to = '' } = query;
  const where = [];
  const params = [];

  if (severity) { params.push(severity); where.push(`a.severity = $${params.length}`); }
  if (resolution === 'open') where.push(`a.resolution_state_label != 'Closed'`);
  else if (resolution === 'closed') where.push(`a.resolution_state_label = 'Closed'`);
  if (serverId) { params.push(serverId); where.push(`a.server_id = $${params.length}`); }
  if (server) { params.push(`%${server}%`, `%${server}%`); where.push(`(COALESCE(s.hostname, a.server_name_raw) LIKE $${params.length - 1} OR a.server_name_raw LIKE $${params.length})`); }
  if (alertName) { params.push(alertName); where.push(`a.alert_name = $${params.length}`); }
  if (q) { params.push(`%${q}%`, `%${q}%`); where.push(`(a.alert_name LIKE $${params.length - 1} OR a.server_name_raw LIKE $${params.length})`); }
  if (from) { params.push(from); where.push(`a.created_at >= $${params.length}`); }
  if (to) { params.push(endOfDay(to)); where.push(`a.created_at <= $${params.length}`); }

  return { where, params, whereSql: where.length ? `WHERE ${where.join(' AND ')}` : '' };
}

module.exports = { buildAlertFilters };
