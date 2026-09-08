// Builds a compact, plain-text (not raw JSON) summary of this app's real,
// current data for the AI to read. Prose costs far fewer tokens than JSON
// and models follow it just as reliably.
//
// IMPORTANT: every figure here must come from a real query against current
// data -- never a hardcoded example or a stale cached value passed off as
// current. The system prompt below tells the model how to read this
// correctly; this function is what keeps it honest in the first place.
const { pool } = require('./db');
const { computeHealthScores } = require('./healthScore');

async function buildDigest() {
  const now = new Date().toISOString();

  const totalServers = (await pool.query(`SELECT COUNT(*)::int AS c FROM servers WHERE active = 1`)).rows[0].c;
  const openTotal = (await pool.query(`SELECT COUNT(*)::int AS c FROM alerts WHERE resolution_state_label != 'Closed'`)).rows[0].c;

  const { rows: severityRows } = await pool.query(
    `SELECT severity, COUNT(*)::int AS c FROM alerts WHERE resolution_state_label != 'Closed' GROUP BY severity`
  );

  const { rows: topServers } = await pool.query(`
    SELECT s.hostname, COUNT(a.id)::int AS c
    FROM alerts a JOIN servers s ON s.id = a.server_id
    WHERE a.resolution_state_label != 'Closed'
    GROUP BY s.id ORDER BY c DESC LIMIT 5
  `);

  const { rows: criticalServers } = await pool.query(`
    SELECT s.hostname,
      (SELECT COUNT(*)::int FROM alerts a WHERE a.server_id = s.id AND a.resolution_state_label != 'Closed' AND a.severity = 'Critical') AS critical_open
    FROM servers s WHERE s.is_critical = 1 AND s.active = 1
  `);

  const { rows: recentCritical } = await pool.query(`
    SELECT alert_name, server_name_raw, created_at FROM alerts
    WHERE severity = 'Critical' AND resolution_state_label != 'Closed'
    ORDER BY created_at DESC LIMIT 5
  `);

  // Same breakdowns the Live Data & Analysis page shows, at top-5/top-hour
  // granularity here to keep this digest compact (that page has the full
  // filterable detail) -- lets the chat actually answer "what's our most
  // common alarm type" or "when do most alerts happen" instead of only
  // being able to talk about per-server counts.
  const { rows: topAlarmTypes } = await pool.query(`
    SELECT alert_name, COUNT(*)::int AS c FROM alerts
    WHERE resolution_state_label != 'Closed'
    GROUP BY alert_name ORDER BY c DESC LIMIT 5
  `);
  const { rows: peakHourRows } = await pool.query(`
    SELECT CAST(strftime('%H', created_at) AS INTEGER) AS hour, COUNT(*)::int AS c
    FROM alerts GROUP BY hour ORDER BY c DESC LIMIT 1
  `);
  const allTimeTotal = (await pool.query(`SELECT COUNT(*)::int AS c FROM alerts`)).rows[0].c;

  const health = await computeHealthScores();
  const worst = [...health].filter((h) => h.alarmCount > 0).sort((a, b) => a.healthScore - b.healthScore).slice(0, 5);

  // Everything below covers the app's other tools/pages (Inventory,
  // Configuration/SCOM sync status, Reports, Import Data, Users) -- added
  // because the chat was refusing plenty of legitimate in-app questions
  // that simply weren't represented anywhere in the digest yet. Kept to
  // aggregates/top-N/most-recent rather than raw dumps, same pattern as
  // the fleet data above, so this stays a bounded prose summary instead of
  // growing unbounded with the database.
  const { rows: resolutionFunnel } = await pool.query(
    `SELECT resolution_state_label, COUNT(*)::int AS c FROM alerts GROUP BY resolution_state_label`
  );
  const { rows: envBreakdown } = await pool.query(
    `SELECT COALESCE(environment, 'Unspecified') AS label, COUNT(*)::int AS c FROM servers WHERE active = 1 GROUP BY label ORDER BY c DESC`
  );
  const { rows: dcBreakdown } = await pool.query(
    `SELECT COALESCE(data_center, 'Unspecified') AS label, COUNT(*)::int AS c FROM servers WHERE active = 1 GROUP BY label ORDER BY c DESC`
  );
  const { rows: osBreakdown } = await pool.query(
    `SELECT COALESCE(os_type, 'Unspecified') AS label, COUNT(*)::int AS c FROM servers WHERE active = 1 GROUP BY label ORDER BY c DESC LIMIT 5`
  );
  const { rows: monthlyTrend } = await pool.query(
    `SELECT strftime('%Y-%m', created_at) AS month, COUNT(*)::int AS c FROM alerts GROUP BY month ORDER BY month DESC LIMIT 6`
  );
  const scomSettings = (await pool.query(`SELECT * FROM scom_settings WHERE id = 1`)).rows[0] || null;
  const { rows: recentReports } = await pool.query(`
    SELECT rj.report_type, rj.format, rj.status, rj.created_at, u.username
    FROM report_jobs rj LEFT JOIN users u ON u.id = rj.requested_by
    ORDER BY rj.created_at DESC LIMIT 5
  `);
  const lastImport = (await pool.query(
    `SELECT filename, import_type, imported_rows, updated_rows, failed_rows, status, created_at FROM import_jobs ORDER BY created_at DESC LIMIT 1`
  )).rows[0] || null;
  const { rows: usersByRole } = await pool.query(`SELECT role, COUNT(*)::int AS c FROM users GROUP BY role`);

  const lines = [];
  lines.push(`LIVE SNAPSHOT -- fetched directly from the production database just now, at ${now} (ISO 8601, already local -- do not reconvert). This is the current, real state -- more current than anything you were previously shown, trained on, or given as a file.`);
  lines.push(`Total open incidents right now: ${openTotal}.`);
  lines.push(`Fleet: ${totalServers} active servers monitored.`);
  for (const r of severityRows) lines.push(`  - ${r.severity}: ${r.c} open`);
  lines.push(
    topServers.length
      ? `Top servers by open alert count: ${topServers.map((s) => `${s.hostname} (${s.c})`).join(', ')}.`
      : 'No server currently has any matched open alerts.'
  );
  lines.push(
    topServers.length
      ? `Most affected device right now: ${topServers[0].hostname}, with ${topServers[0].c} open alert(s).`
      : 'No single device currently stands out as most affected -- there are no open alerts.'
  );
  lines.push(
    criticalServers.length
      ? `Critical watchlist servers (${criticalServers.length}): ${criticalServers.map((s) => `${s.hostname} [${s.critical_open} critical open]`).join(', ')}.`
      : 'No servers are currently on the critical watchlist.'
  );
  lines.push(
    recentCritical.length
      ? `Most recent open Critical alerts: ${recentCritical.map((a) => `"${a.alert_name}" on ${a.server_name_raw} (raised ${a.created_at})`).join('; ')}.`
      : 'No open Critical alerts.'
  );
  lines.push(
    worst.length
      ? `Lowest fleet health scores (0-100, lower = worse): ${worst.map((h) => `${h.hostname}=${h.healthScore}`).join(', ')}.`
      : 'No servers currently have alert history to score.'
  );
  lines.push(`All-time alert count (open + closed, all history): ${allTimeTotal}.`);
  lines.push(
    topAlarmTypes.length
      ? `Top open alarm types by volume: ${topAlarmTypes.map((r) => `"${r.alert_name}" (${r.c})`).join(', ')}. The Live Data & Analysis page has the full ranked list and lets it be filtered by server/type/severity/date.`
      : 'No open alarm-type breakdown available yet.'
  );
  if (peakHourRows.length) {
    lines.push(`Alerts cluster most around ${String(peakHourRows[0].hour).padStart(2, '0')}:00 (all-time, local time) -- ${peakHourRows[0].c} alerts historically raised in that hour.`);
  }

  // --- Inventory (all-time, all servers, not just active/open-alert ones covered above) ---
  lines.push(
    resolutionFunnel.length
      ? `Alert resolution funnel (all-time, all alerts): ${resolutionFunnel.map((r) => `${r.resolution_state_label}=${r.c}`).join(', ')}.`
      : 'No alerts recorded yet.'
  );
  lines.push(
    envBreakdown.length
      ? `Active servers by environment: ${envBreakdown.map((r) => `${r.label} (${r.c})`).join(', ')}.`
      : 'No environment data recorded on any server.'
  );
  lines.push(
    dcBreakdown.length
      ? `Active servers by data center: ${dcBreakdown.map((r) => `${r.label} (${r.c})`).join(', ')}.`
      : 'No data center recorded on any server.'
  );
  lines.push(
    osBreakdown.length
      ? `Active servers by OS type (top 5): ${osBreakdown.map((r) => `${r.label} (${r.c})`).join(', ')}.`
      : 'No OS type recorded on any server.'
  );
  lines.push(
    monthlyTrend.length
      ? `Alert volume by month (most recent 6, local calendar month): ${monthlyTrend.map((r) => `${r.month}=${r.c}`).join(', ')}.`
      : 'No monthly trend data yet.'
  );

  // --- Configuration / SCOM sync status (the Configuration page) ---
  if (scomSettings?.management_server) {
    lines.push(
      `SCOM sync is configured against management server "${scomSettings.management_server}". `
      + `Last sync: ${scomSettings.last_sync_at || 'never'} (status: ${scomSettings.last_sync_status || 'n/a'}${scomSettings.last_sync_error ? `, error: ${scomSettings.last_sync_error}` : ''}), `
      + `mode: ${scomSettings.last_sync_mode || 'n/a'}. `
      + `Auto-fetch (incremental) is ${scomSettings.enabled ? `ON, every ${scomSettings.auto_fetch_interval_minutes} minute(s), ${scomSettings.auto_fetch_run_count} tick(s) run so far, last tick status ${scomSettings.last_autofetch_status || 'n/a'}` : 'OFF'}. `
      + `Full sync (the only kind that can detect closed alerts) runs every ${scomSettings.full_sync_interval_minutes} minute(s)${scomSettings.full_sync_interval_minutes === 0 ? ' (disabled)' : ''}.`
    );
  } else {
    lines.push('SCOM sync is not yet configured (no management server set on the Configuration page) -- alert data on this app comes only from manual imports until it is.');
  }

  // --- Reports page ---
  lines.push(
    recentReports.length
      ? `Most recently generated reports: ${recentReports.map((r) => `${r.report_type}/${r.format} by ${r.username || 'unknown user'} at ${r.created_at} (${r.status})`).join('; ')}. The Reports page can generate Inventory, Alerts, or Summary reports, each exportable as PDF, Word, or Excel.`
      : 'No reports have been generated yet. The Reports page can generate Inventory, Alerts, or Summary reports, each exportable as PDF, Word, or Excel.'
  );

  // --- Import Data page ---
  lines.push(
    lastImport
      ? `Most recent data import: "${lastImport.filename}" (${lastImport.import_type}) at ${lastImport.created_at} -- ${lastImport.imported_rows} imported, ${lastImport.updated_rows} updated, ${lastImport.failed_rows} failed, status ${lastImport.status}.`
      : 'No spreadsheet imports have been run yet.'
  );

  // --- Users page ---
  lines.push(
    usersByRole.length
      ? `User accounts by role: ${usersByRole.map((r) => `${r.role}=${r.c}`).join(', ')}. Admins can access Configuration, Import Data, and manage users; viewers have read-only access to everything else.`
      : 'No user accounts found.'
  );

  return lines.join('\n');
}

// Teaches the model how to read the digest correctly -- calling out every
// place a naive reading could go wrong, per the add-on brief. The greeting
// rule is deliberately first, in its own paragraph, and repeated at the
// end -- a single bullet buried among data-reading rules wasn't enough to
// stop a data dump on a plain "hi" in practice, so this puts it where a
// model's instruction-following is strongest (start and end of the prompt).
const SYSTEM_PROMPT = `You are the AI assistant embedded in Server Watch, a SCOM-based server monitoring dashboard. Your job is to answer any question about this app -- both "what does the data say" and "how do I use this tool" -- not just fleet-health questions. Use the APP FEATURES reference and the DATA SNAPSHOT below together; between the two, most in-app questions have a real answer.

FIRST, check what kind of message this is:
- A greeting or small talk ("hi", "hello", "hey", "thanks", "how are you") with no real question -> reply briefly and naturally, like a person would. Do NOT mention alert counts, server names, health scores, or anything from the data snapshot below. One short sentence is enough.
- A "how do I..." / "what does X do" / "where do I find..." question about a page or feature -> answer it directly from the APP FEATURES reference below. These don't need the data snapshot at all.
- A question about current data (counts, servers, alerts, sync status, reports, users, etc.) -> answer it using the DATA SNAPSHOT, per the rules below.

APP FEATURES reference (how the app itself works -- static, not live data):
- Dashboard: KPI cards (open/critical/warning counts, servers monitored, resolved in last 7 days, fleet health score), a severity breakdown, the 10 most recent alerts, and an AI Insight card that auto-refreshes in the background. Auto-refreshes every 30 seconds.
- Live Data & Analysis: filter alerts by server, alarm type, severity, and date range; shows KPIs, top alarm types, top devices, severity/resolution split charts, hourly distribution, monthly trend, and a filtered incidents table.
- Alarms: the full alerts list/table with the same filters (server, severity, resolution state, date range, free-text search), paginated.
- Critical Servers: a manually curated watchlist of high-priority servers (set per-server on the Inventory page), separate from alert severity -- a watchlist server can currently have zero Critical alerts and still be on the list.
- Inventory: the full server list (hostname, FQDN, OS type, environment, business unit, data center, critical-watchlist flag, active/inactive, source). Admins can add/edit/deactivate servers here.
- Import Data: admins can bulk-import servers or alerts from an Excel spreadsheet; each import is logged with row counts (imported/updated/failed) and shown in its own history.
- Reports: generates three report types -- Inventory (point-in-time server listing, no date range), Alerts (a filtered row-by-row listing over a date range, includes alerts since resolved/closed if they occurred in that range), and Summary (totals, daily trend, top offenders over a date range) -- each exportable as PDF, Word (.docx), or Excel (.xlsx). Date ranges are interpreted in the organization's local time. A generation history table shows what was run, by whom, and lets you re-download.
- Configuration (admin-only): sets up the SCOM connection (management server hostname, WinRM username/password), auto-fetch interval (incremental sync, catches new/changed alerts), full-sync interval (the only sync mode that can detect and close alerts that are no longer open in SCOM), and the AI integration's own connection settings (base URL, API key, model).
- Users (admin-only): manage login accounts. Two roles -- admin (full access, including Configuration and Import Data) and viewer (read-only everywhere else).

IMPORTANT: The DATA SNAPSHOT below is pulled live from the production database on every single message -- it is not a fixed file, export, or training example. It is always the current, real state of the app as of right now, and it OVERRIDES any older data you may have seen before (an earlier export, an earlier conversation, anything you were previously shown or trained on). Never answer a question about current counts, sync status, or affected devices from memory of an older snapshot -- always re-read the DATA SNAPSHOT given with THIS message, since it reflects this exact moment, not whenever you last saw data.

You will be given a DATA SNAPSHOT reflecting the current, real state of the app -- fleet/alerts, inventory breakdowns, SCOM sync status, recent reports, recent imports, and user accounts. When you DO need it:
- Every count and status word in the snapshot is authoritative -- read it directly, never infer or recompute a total from a partial list mentioned elsewhere in the snapshot.
- Every timestamp in the snapshot is already in ISO 8601 local time -- do not convert, shift, or reinterpret timezones.
- Health scores are 0-100 where LOWER is WORSE (more alert volume/severity/repetition), not the reverse.
- "Critical watchlist" servers are a manually curated high-priority list, distinct from alert severity="Critical" -- a watchlist server can have zero critical alerts right now and still be worth mentioning as watched.
- The snapshot's breakdowns are aggregates and top-N/most-recent lists, not a full row-by-row export of the alerts/servers tables -- but you have live database tools for exactly that gap. NEVER say a granular question "can't be answered" or "isn't in the data I have" and redirect the user to a page instead -- call the appropriate tool and answer from its result:
  - Any question about SPECIFIC alerts/incidents not already fully covered by the snapshot's top-N lists -- "list every alert on server X", "how many closed incidents happened last month", "is there an open incident called Y", "break down incidents by severity for server Z", "how many alerts in Production", "which business unit has the most critical alerts", "alerts in the DR data center", open vs. closed counts for any specific server/date-range/type/environment/data-center/business-unit combination -- use search_alerts (filters and can group by server, alert name, severity, resolution state, date range, environment, data center, or business unit).
  - Any question about a SPECIFIC named server not already fully covered above -- including "history"/"past alerts"/"what's happened on server X" -- use get_server_status (includes that server's health score, its open alerts, AND its recent closed-alert history with an all-time count; if the tool result says more history exists than it returned, follow up with search_alerts filtered to that server for the rest instead of stopping at the recent list).
  - Any question about which servers match some inventory criteria (environment, data center, business unit, OS type, critical-watchlist, active/inactive) -- use list_servers.
  - Any question about health scores beyond the snapshot's fixed top-5 worst list -- "which servers are healthiest", "top 15 servers needing attention", "best health scores" -- use get_health_rankings (direction: worst or best, any limit).
  - Only say something can't be answered when it genuinely needs data outside both the APP FEATURES reference, the DATA SNAPSHOT, AND every available tool (e.g. something entirely outside this app, or a field this app doesn't track at all).

Be concise and factual. This is an operations tool, not a conversational chatbot -- prioritize accuracy over flourish. Reminder: never summarize or reference the data snapshot unless the user's message actually calls for it.`;

module.exports = { buildDigest, SYSTEM_PROMPT };
