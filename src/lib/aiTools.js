// Tool-calling (function-calling) support for the AI chat, so it can look
// up ONE SPECIFIC server or alert by name instead of only ever seeing the
// digest's top-5/aggregate summaries. The digest alone can never answer
// "does server RMP-DCDB1-REAL have any alerts" for an arbitrary server not
// in a top-5 list -- there are dozens to hundreds of servers and hundreds
// to thousands of alerts, far more than any prompt budget could ever hold
// in full. Tool calls let the model query the database on demand, for
// exactly the entity actually asked about, instead of the app guessing in
// advance what might get asked and pre-computing it.
//
// Defined in the OpenAI function-calling shape (the de facto standard most
// "OpenAI-compatible" internal gateways implement) -- see aiClient.js's
// chatCompleteWithTools for the fallback behavior if a given gateway
// doesn't support this at all.
const { pool } = require('./db');
const { buildAlertFilters } = require('./alertFilters');

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_server_status',
      description: 'Look up one specific server by hostname or partial hostname and return its full current status: environment, criticality, active state, and its actual open alerts (not a top-N summary). Use this any time a question names or clearly refers to a SPECIFIC server that is not already fully covered by the data snapshot above.',
      parameters: {
        type: 'object',
        properties: {
          hostname: { type: 'string', description: 'Server hostname, or a partial/fuzzy hostname to search for.' },
        },
        required: ['hostname'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_alerts',
      description: 'Search alerts by any combination of server, alert name/type, severity, and resolution state (open/closed). Use this for any question about specific alerts/alarms that the data snapshot\'s top-5 lists don\'t already answer -- e.g. "how many Warning alerts are on server X", "is there an alert called Y anywhere", "list open alerts for server Z", "how many Critical alerts are closed".',
      parameters: {
        type: 'object',
        properties: {
          server: { type: 'string', description: 'Server hostname or partial hostname.' },
          alertName: { type: 'string', description: 'Exact or partial alert name/type to match.' },
          severity: { type: 'string', enum: ['Critical', 'Warning', 'Information'] },
          resolution: { type: 'string', enum: ['open', 'closed'], description: 'Filter to only open or only closed alerts. Omit to include both.' },
        },
      },
    },
  },
];

async function getServerStatus({ hostname } = {}) {
  if (!hostname || !hostname.trim()) return { error: 'hostname is required' };
  const { rows: servers } = await pool.query(
    `SELECT id, hostname, fqdn, environment, business_unit, data_center, is_critical, active
     FROM servers WHERE hostname LIKE $1 ORDER BY hostname LIMIT 5`,
    [`%${hostname.trim()}%`]
  );
  if (!servers.length) return { found: false, message: `No server matching "${hostname}" found in inventory.` };

  const matches = [];
  for (const s of servers) {
    const [{ rows: openAlerts }, { rows: totalRow }] = await Promise.all([
      pool.query(
        `SELECT alert_name, severity, resolution_state_label, created_at FROM alerts
         WHERE server_id = $1 AND resolution_state_label != 'Closed' ORDER BY created_at DESC LIMIT 15`,
        [s.id]
      ),
      pool.query(`SELECT COUNT(*)::int AS c FROM alerts WHERE server_id = $1`, [s.id]),
    ]);
    matches.push({
      hostname: s.hostname,
      fqdn: s.fqdn,
      environment: s.environment,
      businessUnit: s.business_unit,
      dataCenter: s.data_center,
      onCriticalWatchlist: !!s.is_critical,
      active: !!s.active,
      openAlertCount: openAlerts.length,
      allTimeAlertCount: totalRow[0].c,
      openAlerts: openAlerts.map((a) => ({ name: a.alert_name, severity: a.severity, state: a.resolution_state_label, raisedAt: a.created_at })),
    });
  }
  return { found: true, matchCount: matches.length, matches };
}

async function searchAlerts(args = {}) {
  const { where, params, whereSql } = buildAlertFilters({
    server: args.server, alertName: args.alertName, severity: args.severity, resolution: args.resolution,
  });
  if (!where.length) return { error: 'At least one filter (server, alertName, severity, or resolution) is required.' };
  const JOIN = `FROM alerts a LEFT JOIN servers s ON s.id = a.server_id`;
  const [{ rows: countRow }, { rows }] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int AS c ${JOIN} ${whereSql}`, params),
    pool.query(
      `SELECT a.alert_name, COALESCE(s.hostname, a.server_name_raw) AS server, a.severity, a.resolution_state_label, a.created_at
       ${JOIN} ${whereSql} ORDER BY a.created_at DESC LIMIT 20`,
      params
    ),
  ]);
  return {
    totalMatching: countRow[0].c,
    shownCount: rows.length,
    note: rows.length < countRow[0].c ? `Showing the ${rows.length} most recent of ${countRow[0].c} total matches.` : undefined,
    alerts: rows.map((r) => ({ name: r.alert_name, server: r.server, severity: r.severity, state: r.resolution_state_label, raisedAt: r.created_at })),
  };
}

const TOOL_IMPLS = { get_server_status: getServerStatus, search_alerts: searchAlerts };

async function executeTool(name, argsJson) {
  const impl = TOOL_IMPLS[name];
  if (!impl) return { error: `Unknown tool: ${name}` };
  let args;
  try {
    args = argsJson ? JSON.parse(argsJson) : {};
  } catch {
    return { error: 'Could not parse tool arguments as JSON.' };
  }
  try {
    return await impl(args);
  } catch (err) {
    return { error: err.message };
  }
}

module.exports = { TOOLS, executeTool };
