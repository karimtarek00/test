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
const { buildAlertFilters, escapeLikeTerm, LIKE_ESCAPE } = require('./alertFilters');
const { computeHealthScores } = require('./healthScore');

// A manager asking live/verbally will type or say a hostname or alert name
// with a typo, a transposed letter, or a shortened form far more often than
// a spreadsheet import will -- and a LIKE substring search (however
// permissive) still returns nothing for "RMP-DCDBS-UMSRGA" against the real
// "RMP-DCDBS-UMRSG". Rather than let that dead-end as "not found" in front
// of an audience, every lookup that comes up empty falls back to ranking
// every real candidate by edit distance and handing the closest few back to
// the model to retry with -- see the SYSTEM_PROMPT instruction to actually
// use them instead of reporting failure.
function levenshteinDistance(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prevRow = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const currRow = [i];
    for (let j = 1; j <= n; j++) {
      currRow[j] = a[i - 1] === b[j - 1]
        ? prevRow[j - 1]
        : 1 + Math.min(prevRow[j - 1], prevRow[j], currRow[j - 1]);
    }
    prevRow = currRow;
  }
  return prevRow[n];
}

// A candidate is only worth suggesting if it's actually close -- with no
// cutoff, a query for something that genuinely doesn't exist ("Proccesor",
// when every real alert name is "...CPU Utilization...", not "Processor")
// still returns the mathematically nearest names in the whole table, which
// are not close at all and would send a confident retry down a completely
// wrong path. The threshold scales with query length so short queries still
// tolerate a typo or two without matching everything.
function closestMatches(query, candidates, maxResults = 5) {
  const q = (query || '').trim().toLowerCase();
  if (!q || !candidates.length) return [];
  const maxDistance = Math.max(2, Math.ceil(q.length * 0.34));
  const uniqueCandidates = [...new Set(candidates)];
  return uniqueCandidates
    .map((c) => ({ value: c, distance: levenshteinDistance(q, c.toLowerCase()) }))
    .filter((r) => r.distance <= maxDistance)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, maxResults)
    .map((r) => r.value);
}

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_server_status',
      description: 'Look up one specific server by hostname or partial hostname and return EVERYTHING known about it: environment, business unit, data center, OS type, criticality, active state, how it entered the inventory (manual/import/sync) and when, any freeform notes, its health score, its actual open alerts, AND its recent alert history (most recent closed alerts, plus the all-time total). Use this any time a question names or clearly refers to a SPECIFIC server/node/device that is not already fully covered by the data snapshot above -- including "history"/"past alerts"/"what happened on server X" and "what OS is X running"/"when was X added"/"are there notes on X" questions. If more alert history is needed than the recent list returned here, follow up with search_alerts filtered to that server.',
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
      description: 'Search alerts by any combination of server, alert name/type, severity, resolution state (open/closed), date range, environment, data center, or business unit. Each matching row is the FULL incident record -- severity, resolution state, priority, repeat count, maintenance-mode flag, what specifically triggered it (source), when it was raised/last modified/resolved, its SCOM alert ID, and its server\'s environment/data center/business unit -- not a partial summary, so any question about one specific incident\'s details is answerable from this. Returns matching rows by default (capped by limit, sorted by recency -- NOT evenly spread across servers/types), or exact grouped counts when groupBy is set. CRITICAL: for ANY question comparing counts across multiple servers/types/severities/etc -- "which server has the most X", "top N servers/devices with X alerts", "how many X per server", "break down X by Y" -- always set groupBy, never fetch a plain row list and count occurrences yourself; the row list is truncated and sorted by recency, so a manual tally from it WILL be wrong (confirmed: a server with 8 real matches counted as 3 from a truncated list). groupBy computes the real count per group directly in the database. Use this for any question about specific alerts/alarms that the data snapshot\'s top-5 lists don\'t already answer -- e.g. "how many Warning alerts are on server X", "how many alerts in Production", "is there an alert called Y anywhere", "list open alerts for server Z", "how many alerts happened last week", "which business unit has the most critical alerts", "is this alert in maintenance mode", "what triggered this incident", "when was this last modified".',
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
          limit: { type: 'integer', description: 'How many matching rows to return. Default 20, max 100 -- raise this when asked to list/see all matches rather than just a few.' },
          groupBy: {
            type: 'string',
            enum: ['severity', 'resolution', 'alertName', 'server', 'environment', 'dataCenter', 'businessUnit'],
            description: 'If set, returns exact counts grouped by this field (sorted highest first) instead of a row listing -- use for "how many X per Y", "top N servers/devices with X alerts", or "which Y has the most X" questions. Set groupBy="server" together with alertName to get the real top-N servers for a given alert type -- never derive that by counting server names in a plain (non-grouped) row list.',
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
      description: 'List servers in the inventory filtered by environment, data center, business unit, OS type, critical-watchlist status, or active/inactive. Each returned server includes its OS type, how it entered the inventory (manual/import/sync), when it was added, and any freeform notes -- not just the filter fields. Use this for questions like "which servers are in the DR environment", "list critical servers", "what servers are in data center X" -- not covered by get_server_status (which looks up one specific named server).',
      parameters: {
        type: 'object',
        properties: {
          environment: { type: 'string', description: 'Exact or partial environment name.' },
          dataCenter: { type: 'string', description: 'Exact or partial data center.' },
          businessUnit: { type: 'string', description: 'Exact or partial business unit.' },
          osType: { type: 'string', description: 'Exact or partial OS type.' },
          onCriticalWatchlist: { type: 'boolean', description: 'true = only critical-watchlist servers, false = only non-watchlist servers, omit = both.' },
          active: { type: 'boolean', description: 'true = only active servers, false = only inactive, omit = both (defaults to active-only if omitted, since inactive servers are rarely relevant).' },
          limit: { type: 'integer', description: 'How many servers to return. Default 100, max 200.' },
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
    `SELECT id, hostname, fqdn, environment, business_unit, data_center, os_type, source, notes,
            is_critical, active, created_at
     FROM servers WHERE hostname LIKE $1 ${LIKE_ESCAPE} ORDER BY hostname LIMIT 5`,
    [`%${escapeLikeTerm(hostname.trim())}%`]
  );
  if (!servers.length) {
    const { rows: allHostnames } = await pool.query(`SELECT hostname FROM servers WHERE active = 1`);
    const closestHostnames = closestMatches(hostname, allHostnames.map((r) => r.hostname));
    return {
      found: false,
      message: `No server matching "${hostname}" found in inventory.`,
      closestHostnames,
      hint: closestHostnames.length
        ? `"${hostname}" is very likely a typo/mishearing of one of closestHostnames -- immediately retry get_server_status with the closest one and answer from that result. Do not tell the user nothing was found without trying this first.`
        : undefined,
    };
  }

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
      osType: s.os_type,
      // How this server entered the inventory -- manual (added by an
      // admin), import (spreadsheet), or sync (auto-created the first time
      // SCOM alerted on a hostname the inventory didn't have yet).
      source: s.source,
      notes: s.notes || null,
      addedOn: s.created_at,
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

  const limit = clampInt(args.limit, 20, 1, 100);
  const [{ rows: countRow }, { rows }] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int AS c ${JOIN} ${whereSql}`, params),
    pool.query(
      // Every column a question about one specific incident could ask
      // about -- not just enough to list it in a table. "source" is what
      // SCOM actually flagged (the underlying rule/monitor detail);
      // in_maintenance_mode and scom_alert_id/last_modified only ever
      // existed in the DB unexposed to the AI until this was added.
      `SELECT a.alert_name, COALESCE(s.hostname, a.server_name_raw) AS server, a.severity, a.resolution_state_label,
              a.priority, a.repeat_count, a.source, a.in_maintenance_mode, a.scom_alert_id,
              a.created_at, a.last_modified, a.resolved_at,
              s.environment, s.data_center, s.business_unit
       ${JOIN} ${whereSql} ORDER BY a.created_at DESC LIMIT $${params.length + 1}`,
      [...params, limit]
    ),
  ]);
  // A typo'd server/alertName is the single most common way this comes back
  // empty (see levenshteinDistance's comment above) -- rank the real values
  // against what was actually typed so the model can retry instead of
  // reporting a dead end.
  let closestServers, closestAlertNames;
  if (countRow[0].c === 0) {
    if (args.server) {
      const { rows: allHostnames } = await pool.query(`SELECT DISTINCT COALESCE(s.hostname, a.server_name_raw) AS name ${JOIN}`);
      closestServers = closestMatches(args.server, allHostnames.map((r) => r.name));
    }
    if (args.alertName) {
      const { rows: allAlertNames } = await pool.query(`SELECT DISTINCT alert_name FROM alerts`);
      closestAlertNames = closestMatches(args.alertName, allAlertNames.map((r) => r.alert_name));
    }
  }

  const isTruncated = rows.length < countRow[0].c;
  const distinctServersShown = new Set(rows.map((r) => r.server)).size;
  return {
    totalMatching: countRow[0].c,
    shownCount: rows.length,
    note: isTruncated ? `Showing the ${rows.length} most recent of ${countRow[0].c} total matches -- raise the limit parameter to see more.` : undefined,
    // The single most reliable way this tool gets misused: counting how many
    // times each server appears in this row list to answer "which server has
    // the most X" or "how many per server" -- reproduced directly (a server
    // with 8 real matches showed as 3 from a recency-truncated 20-of-29 list,
    // since the missing 9 rows are NOT evenly distributed across servers).
    // This list is sorted by recency, not grouped, so a per-server tally
    // from it is only reliable when nothing was truncated AND every
    // matching row was actually returned -- flag every other case loudly.
    warning: (isTruncated && distinctServersShown > 1)
      ? 'This list is truncated AND spans multiple servers -- do NOT count how many times each server appears here to answer a "how many per server" or "which server has the most" question; that arithmetic will be wrong because the missing rows are not evenly spread across servers. Call search_alerts again with the same filters plus groupBy="server" (or "alertName", etc.) instead -- it computes exact per-group counts in the database, not from this truncated list.'
      : undefined,
    closestServers,
    closestAlertNames,
    hint: (closestServers?.length || closestAlertNames?.length)
      ? 'No exact match, but this is very likely a typo/mishearing -- immediately retry search_alerts with the closest server/alertName listed above and answer from that result. Do not tell the user nothing was found without trying this first.'
      : undefined,
    alerts: rows.map((r) => ({
      name: r.alert_name, server: r.server, severity: r.severity, state: r.resolution_state_label,
      priority: r.priority || null, repeatCount: r.repeat_count ?? null,
      source: r.source || null, inMaintenanceMode: !!r.in_maintenance_mode, scomAlertId: r.scom_alert_id || null,
      raisedAt: r.created_at, lastModified: r.last_modified || null, resolvedAt: r.resolved_at || null,
      environment: r.environment || null, dataCenter: r.data_center || null, businessUnit: r.business_unit || null,
    })),
  };
}

async function listServers(args = {}) {
  const where = [];
  const params = [];
  const like = (col, val) => { params.push(`%${escapeLikeTerm(val)}%`); where.push(`${col} LIKE $${params.length} ${LIKE_ESCAPE}`); };
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

  const limit = clampInt(args.limit, 100, 1, 200);
  const { rows } = await pool.query(
    `SELECT hostname, fqdn, environment, business_unit, data_center, os_type, source, notes,
            is_critical, active, created_at
     FROM servers WHERE ${where.join(' AND ')} ORDER BY hostname LIMIT $${params.length + 1}`,
    [...params, limit]
  );
  return {
    matchCount: rows.length,
    truncated: rows.length === limit,
    servers: rows.map((s) => ({
      hostname: s.hostname, fqdn: s.fqdn, environment: s.environment, businessUnit: s.business_unit,
      dataCenter: s.data_center, osType: s.os_type, source: s.source, notes: s.notes || null, addedOn: s.created_at,
      onCriticalWatchlist: !!s.is_critical, active: !!s.active,
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
