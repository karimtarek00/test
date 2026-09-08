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
const { computeHealthScores } = require('./healthScore');

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_server_status',
      description: 'Look up one specific server by hostname or partial hostname and return its full current status: environment, criticality, active state, its actual open alerts, AND its recent alert history (most recent closed alerts, plus the all-time total). Use this any time a question names or clearly refers to a SPECIFIC server that is not already fully covered by the data snapshot above -- including "history"/"past alerts"/"what happened on server X" questions. If more history rows are needed than the recent list returned here, follow up with search_alerts filtered to that server.',
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
      description: 'Search alerts by any combination of server, alert name/type, severity, resolution state (open/closed), date range, environment, data center, or business unit. Returns matching rows by default, or grouped counts (e.g. "how many alerts per severity", "alerts by environment") when groupBy is set. Use this for any question about specific alerts/alarms that the data snapshot\'s top-5 lists don\'t already answer -- e.g. "how many Warning alerts are on server X", "how many alerts in Production", "is there an alert called Y anywhere", "list open alerts for server Z", "how many alerts happened last week", "break down alerts by severity for server X", "which business unit has the most critical alerts", "alerts in the DR data center".',
      parameters: {
        type: 'object',
        properties: {
          server: { type: 'string', description: 'Server hostname or partial hostname.' },
          alertName: { type: 'string', description: 'Exact or partial alert name/type to match.' },
          severity: { type: 'string', enum: ['Critical', 'Warning', 'Information'] },
          resolution: { type: 'string', enum: ['open', 'closed'], description: 'Filter to only open or only closed alerts. Omit to include both.' },
          from: { type: 'string', description: 'Start of date range, "YYYY-MM-DD". Omit for no lower bound.' },
          to: { type: 'string', description: 'End of date range, "YYYY-MM-DD". Omit for no upper bound.' },
          environment: { type: 'string', description: 'Exact or partial environment name (e.g. "Production", "DR"). Matches via the alert\'s server.' },
          dataCenter: { type: 'string', description: 'Exact or partial data center. Matches via the alert\'s server.' },
          businessUnit: { type: 'string', description: 'Exact or partial business unit. Matches via the alert\'s server.' },
          groupBy: {
            type: 'string',
            enum: ['severity', 'resolution', 'alertName', 'server', 'environment', 'dataCenter', 'businessUnit'],
            description: 'If set, returns counts grouped by this field instead of a row listing -- use for "how many X per Y" questions.',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_health_rankings',
      description: 'Rank active servers by health score (0-100, LOWER is WORSE -- more alert volume/severity/repetition). Use this for "which servers are unhealthy", "worst health score", "healthiest servers", "top N servers needing attention" -- not covered by the snapshot\'s fixed top-5 worst list when a different count or the BEST servers are asked for.',
      parameters: {
        type: 'object',
        properties: {
          direction: { type: 'string', enum: ['worst', 'best'], description: 'worst = lowest health scores first (default), best = highest first.' },
          limit: { type: 'integer', description: 'How many servers to return. Default 10, max 50.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_servers',
      description: 'List servers in the inventory filtered by environment, data center, business unit, OS type, critical-watchlist status, or active/inactive. Use this for questions like "which servers are in the DR environment", "list critical servers", "what servers are in data center X" -- not covered by get_server_status (which looks up one specific named server).',
      parameters: {
        type: 'object',
        properties: {
          environment: { type: 'string', description: 'Exact or partial environment name.' },
          dataCenter: { type: 'string', description: 'Exact or partial data center.' },
          businessUnit: { type: 'string', description: 'Exact or partial business unit.' },
          osType: { type: 'string', description: 'Exact or partial OS type.' },
          onCriticalWatchlist: { type: 'boolean', description: 'true = only critical-watchlist servers, false = only non-watchlist servers, omit = both.' },
          active: { type: 'boolean', description: 'true = only active servers, false = only inactive, omit = both (defaults to active-only if omitted, since inactive servers are rarely relevant).' },
        },
      },
    },
  },
];

// Fixed field->column mapping for groupBy -- never taken as a raw column
// name from the model/user, so this can't be turned into SQL injection no
// matter what a model is prompted to send.
const GROUP_BY_COLUMNS = {
  severity: 'a.severity',
  resolution: 'a.resolution_state_label',
  alertName: 'a.alert_name',
  server: `COALESCE(s.hostname, a.server_name_raw)`,
  environment: `COALESCE(s.environment, 'Unspecified')`,
  dataCenter: `COALESCE(s.data_center, 'Unspecified')`,
  businessUnit: `COALESCE(s.business_unit, 'Unspecified')`,
};

async function getServerStatus({ hostname } = {}) {
  if (!hostname || !hostname.trim()) return { error: 'hostname is required' };
  const { rows: servers } = await pool.query(
    `SELECT id, hostname, fqdn, environment, business_unit, data_center, is_critical, active
     FROM servers WHERE hostname LIKE $1 ORDER BY hostname LIMIT 5`,
    [`%${hostname.trim()}%`]
  );
  if (!servers.length) return { found: false, message: `No server matching "${hostname}" found in inventory.` };

  const health = await computeHealthScores();
  const matches = [];
  for (const s of servers) {
    const [{ rows: openAlerts }, { rows: closedAlerts }, { rows: totalRow }] = await Promise.all([
      pool.query(
        `SELECT alert_name, severity, resolution_state_label, created_at FROM alerts
         WHERE server_id = $1 AND resolution_state_label != 'Closed' ORDER BY created_at DESC LIMIT 15`,
        [s.id]
      ),
      // "History"/"past alerts" questions about a specific server need
      // actual closed-alert rows, not just the bare allTimeAlertCount below
      // -- that count alone gave the model nothing to answer a history
      // question from, so it was reporting it "didn't have" history data
      // that in fact just wasn't being returned by this tool at all.
      pool.query(
        `SELECT alert_name, severity, resolution_state_label, created_at, resolved_at FROM alerts
         WHERE server_id = $1 AND resolution_state_label = 'Closed' ORDER BY created_at DESC LIMIT 15`,
        [s.id]
      ),
      pool.query(`SELECT COUNT(*)::int AS c FROM alerts WHERE server_id = $1`, [s.id]),
    ]);
    const serverHealth = health.find((h) => h.serverId === s.id) || null;
    matches.push({
      hostname: s.hostname,
      fqdn: s.fqdn,
      environment: s.environment,
      businessUnit: s.business_unit,
      dataCenter: s.data_center,
      onCriticalWatchlist: !!s.is_critical,
      active: !!s.active,
      // null (not 0) when inactive -- computeHealthScores only scores
      // active servers, and 0 would misread as "worst possible health"
      // rather than "not scored."
      healthScore: serverHealth ? serverHealth.healthScore : null,
      openAlertCount: openAlerts.length,
      allTimeAlertCount: totalRow[0].c,
      openAlerts: openAlerts.map((a) => ({ name: a.alert_name, severity: a.severity, state: a.resolution_state_label, raisedAt: a.created_at })),
      recentClosedAlertCount: closedAlerts.length,
      recentClosedAlerts: closedAlerts.map((a) => ({ name: a.alert_name, severity: a.severity, raisedAt: a.created_at, resolvedAt: a.resolved_at })),
      historyNote: totalRow[0].c > openAlerts.length + closedAlerts.length
        ? `Showing the ${openAlerts.length} most recent open and ${closedAlerts.length} most recent closed alerts out of ${totalRow[0].c} all-time -- use search_alerts with server="${s.hostname}" for the full history or a specific date range.`
        : undefined,
    });
  }
  return { found: true, matchCount: matches.length, matches };
}

async function getHealthRankings(args = {}) {
  const direction = args.direction === 'best' ? 'best' : 'worst';
  const limit = clampInt(args.limit, 10, 1, 50);
  const health = await computeHealthScores();
  const sorted = [...health].sort((a, b) => (direction === 'worst' ? a.healthScore - b.healthScore : b.healthScore - a.healthScore));
  return {
    direction,
    servers: sorted.slice(0, limit).map((h) => ({
      hostname: h.hostname, healthScore: h.healthScore, openAlarmCount: h.alarmCount,
      distinctAlertTypes: h.distinctTypes, distinctActiveDays: h.distinctDays,
    })),
  };
}

function clampInt(value, fallback, min, max) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

async function searchAlerts(args = {}) {
  const { where, params, whereSql } = buildAlertFilters({
    server: args.server, alertName: args.alertName, severity: args.severity, resolution: args.resolution,
    from: args.from, to: args.to,
    environment: args.environment, dataCenter: args.dataCenter, businessUnit: args.businessUnit,
  });
  const JOIN = `FROM alerts a LEFT JOIN servers s ON s.id = a.server_id`;

  if (args.groupBy) {
    const column = GROUP_BY_COLUMNS[args.groupBy];
    if (!column) return { error: `Unknown groupBy value: ${args.groupBy}. Use one of: ${Object.keys(GROUP_BY_COLUMNS).join(', ')}.` };
    const { rows } = await pool.query(
      `SELECT ${column} AS group_value, COUNT(*)::int AS c ${JOIN} ${whereSql} GROUP BY group_value ORDER BY c DESC LIMIT 25`,
      params
    );
    return { groupedBy: args.groupBy, groups: rows.map((r) => ({ value: r.group_value, count: r.c })) };
  }

  if (!where.length) return { error: 'At least one filter (server, alertName, severity, resolution, from, to, environment, dataCenter, or businessUnit) is required unless groupBy is set.' };

  const [{ rows: countRow }, { rows }] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int AS c ${JOIN} ${whereSql}`, params),
    pool.query(
      `SELECT a.alert_name, COALESCE(s.hostname, a.server_name_raw) AS server, a.severity, a.resolution_state_label,
              a.priority, a.repeat_count, a.created_at, a.resolved_at
       ${JOIN} ${whereSql} ORDER BY a.created_at DESC LIMIT 20`,
      params
    ),
  ]);
  return {
    totalMatching: countRow[0].c,
    shownCount: rows.length,
    note: rows.length < countRow[0].c ? `Showing the ${rows.length} most recent of ${countRow[0].c} total matches.` : undefined,
    alerts: rows.map((r) => ({
      name: r.alert_name, server: r.server, severity: r.severity, state: r.resolution_state_label,
      priority: r.priority || null, repeatCount: r.repeat_count ?? null, raisedAt: r.created_at, resolvedAt: r.resolved_at || null,
    })),
  };
}

async function listServers(args = {}) {
  const where = [];
  const params = [];
  const like = (col, val) => { params.push(`%${val}%`); where.push(`${col} LIKE $${params.length}`); };
  if (args.environment) like('environment', args.environment);
  if (args.dataCenter) like('data_center', args.dataCenter);
  if (args.businessUnit) like('business_unit', args.businessUnit);
  if (args.osType) like('os_type', args.osType);
  if (args.onCriticalWatchlist !== undefined) { params.push(args.onCriticalWatchlist ? 1 : 0); where.push(`is_critical = $${params.length}`); }
  // Defaults to active-only when the caller doesn't specify -- an inactive
  // (decommissioned) server showing up unasked-for in "which servers are in
  // X" answers would be misleading more often than it would help.
  params.push(args.active === false ? 0 : 1);
  where.push(`active = $${params.length}`);

  const { rows } = await pool.query(
    `SELECT hostname, fqdn, environment, business_unit, data_center, os_type, is_critical, active
     FROM servers WHERE ${where.join(' AND ')} ORDER BY hostname LIMIT 100`,
    params
  );
  return {
    matchCount: rows.length,
    truncated: rows.length === 100,
    servers: rows.map((s) => ({
      hostname: s.hostname, fqdn: s.fqdn, environment: s.environment, businessUnit: s.business_unit,
      dataCenter: s.data_center, osType: s.os_type, onCriticalWatchlist: !!s.is_critical, active: !!s.active,
    })),
  };
}

const TOOL_IMPLS = {
  get_server_status: getServerStatus, search_alerts: searchAlerts, list_servers: listServers,
  get_health_rankings: getHealthRankings,
};

// argsJson is a JSON string for a real OpenAI-shaped tool call (function
// .arguments is always a string there), but extractTextToolCalls() below
// hands over an already-parsed object for the plain-text convention -- so
// this accepts either rather than assuming a string.
async function executeTool(name, argsJson) {
  const impl = TOOL_IMPLS[name];
  if (!impl) return { error: `Unknown tool: ${name}` };
  let args;
  try {
    args = typeof argsJson === 'object' && argsJson !== null ? argsJson : (argsJson ? JSON.parse(argsJson) : {});
  } catch {
    return { error: 'Could not parse tool arguments as JSON.' };
  }
  try {
    return await impl(args);
  } catch (err) {
    return { error: err.message };
  }
}

// Some gateways/models aren't wired to the OpenAI tools API at all and
// instead emit a tool-call *request* as literal text in the message
// content, using the Hermes/NousResearch-style convention:
//   <tool_call>
//   {"name": "get_server_status", "arguments": {"hostname": "X"}}
//   </tool_call>
// (confirmed live: this app's chat widget showed exactly this raw markup
// to a user instead of it being executed, because chatCompleteWithTools
// only recognized the structured tool_calls field). This scans a
// message's plain-text content for one or more such blocks and returns
// them normalized to the same {id, function:{name, arguments}} shape a
// real tool_calls array would have, so routes/ai.js's loop can treat both
// conventions identically.
function extractTextToolCalls(content) {
  if (!content || typeof content !== 'string') return [];
  const calls = [];
  const re = /<tool_call>([\s\S]*?)<\/tool_call>/g;
  let match;
  let i = 0;
  while ((match = re.exec(content))) {
    try {
      const parsed = JSON.parse(match[1].trim());
      if (parsed && parsed.name) {
        calls.push({
          id: `text_tool_call_${i++}`,
          function: { name: parsed.name, arguments: parsed.arguments || {} },
        });
      }
    } catch {
      // Malformed JSON inside the tag -- skip it rather than crash the
      // whole chat turn over one unparsable block.
    }
  }
  return calls;
}

// Defensive strip for whatever's left in a final reply -- a model can
// emit a tool_call block alongside ordinary prose, or the tool-call round
// budget can run out mid-conversation; either way, raw <tool_call>/
// <tool_response> markup must never reach the chat UI.
function stripToolCallMarkup(text) {
  if (!text || typeof text !== 'string') return text;
  return text.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '').replace(/<tool_response>[\s\S]*?<\/tool_response>/g, '').trim();
}

module.exports = { TOOLS, executeTool, extractTextToolCalls, stripToolCallMarkup };
