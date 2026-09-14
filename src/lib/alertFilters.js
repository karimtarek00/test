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

// A LIKE pattern's own wildcards ('%' any sequence, '_' any single char)
// aren't just search-string syntax -- several real SCOM alert names contain
// a literal '%' ("Free Space (%) For Cluster Disk Alert", "...CPU
// Utilization (%) is too high"), and without escaping it here that
// character gets reinterpreted as a wildcard, silently matching unrelated
// alert names too (confirmed against real data: unescaped, that Free Space
// name also matched "Free Space (MB) For Cluster Disk Alert"). Escaping
// with a backslash + an explicit ESCAPE clause is SQLite's own documented
// way to search for a literal wildcard character.
function escapeLikeTerm(value) {
  return String(value).replace(/[\\%_]/g, '\\$&');
}
function likeParam(value) { return `%${escapeLikeTerm(value)}%`; }
const LIKE_ESCAPE = `ESCAPE '\\'`;

function buildAlertFilters(query) {
  const {
    severity = '', resolution = '', serverId = '', server = '', alertName = '', q = '', from = '', to = '',
    environment = '', dataCenter = '', businessUnit = '',
  } = query;
  const where = [];
  const params = [];

  if (severity) { params.push(severity); where.push(`a.severity = $${params.length}`); }
  if (resolution === 'open') where.push(`a.resolution_state_label != 'Closed'`);
  else if (resolution === 'closed') where.push(`a.resolution_state_label = 'Closed'`);
  if (serverId) { params.push(serverId); where.push(`a.server_id = $${params.length}`); }
  if (server) { params.push(likeParam(server), likeParam(server)); where.push(`(COALESCE(s.hostname, a.server_name_raw) LIKE $${params.length - 1} ${LIKE_ESCAPE} OR a.server_name_raw LIKE $${params.length} ${LIKE_ESCAPE})`); }
  // LIKE, not exact -- the Alarms/Analysis page dropdowns only ever send an
  // exact name (which a LIKE still matches), but the AI's search_alerts
  // tool is documented as accepting a partial term ("CPU", "backup") and
  // needs this to actually behave that way instead of matching nothing.
  if (alertName) { params.push(likeParam(alertName)); where.push(`a.alert_name LIKE $${params.length} ${LIKE_ESCAPE}`); }
  if (q) { params.push(likeParam(q), likeParam(q)); where.push(`(a.alert_name LIKE $${params.length - 1} ${LIKE_ESCAPE} OR a.server_name_raw LIKE $${params.length} ${LIKE_ESCAPE})`); }
  if (from) { params.push(from); where.push(`a.created_at >= $${params.length}`); }
  if (to) { params.push(endOfDay(to)); where.push(`a.created_at <= $${params.length}`); }
  // Joins through the servers table -- an alert with no matched server row
  // (server_id NULL) can never match any of these, same as it can't match
  // a `server` filter above.
  if (environment) { params.push(likeParam(environment)); where.push(`s.environment LIKE $${params.length} ${LIKE_ESCAPE}`); }
  if (dataCenter) { params.push(likeParam(dataCenter)); where.push(`s.data_center LIKE $${params.length} ${LIKE_ESCAPE}`); }
  if (businessUnit) { params.push(likeParam(businessUnit)); where.push(`s.business_unit LIKE $${params.length} ${LIKE_ESCAPE}`); }

  return { where, params, whereSql: where.length ? `WHERE ${where.join(' AND ')}` : '' };
}

module.exports = { buildAlertFilters, escapeLikeTerm, LIKE_ESCAPE };
