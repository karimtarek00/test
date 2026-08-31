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

  const health = await computeHealthScores();
  const worst = [...health].filter((h) => h.alarmCount > 0).sort((a, b) => a.healthScore - b.healthScore).slice(0, 5);

  const lines = [];
  lines.push(`Snapshot generated at ${now} (ISO 8601, already local -- do not reconvert).`);
  lines.push(`Fleet: ${totalServers} active servers monitored.`);
  lines.push(`Open alerts: ${openTotal} total.`);
  for (const r of severityRows) lines.push(`  - ${r.severity}: ${r.c} open`);
  lines.push(
    topServers.length
      ? `Top servers by open alert count: ${topServers.map((s) => `${s.hostname} (${s.c})`).join(', ')}.`
      : 'No server currently has any matched open alerts.'
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

  return lines.join('\n');
}

// Teaches the model how to read the digest correctly -- calling out every
// place a naive reading could go wrong, per the add-on brief. The greeting
// rule is deliberately first, in its own paragraph, and repeated at the
// end -- a single bullet buried among data-reading rules wasn't enough to
// stop a data dump on a plain "hi" in practice, so this puts it where a
// model's instruction-following is strongest (start and end of the prompt).
const SYSTEM_PROMPT = `You are the AI assistant embedded in Server Watch, a SCOM-based server monitoring dashboard.

FIRST, check what kind of message this is:
- A greeting or small talk ("hi", "hello", "hey", "thanks", "how are you") with no real question -> reply briefly and naturally, like a person would. Do NOT mention alert counts, server names, health scores, or anything from the data snapshot below. One short sentence is enough.
- An actual question about the fleet, alerts, or servers -> answer it using the data snapshot, per the rules below.

You will be given a DATA SNAPSHOT reflecting the current, real state of the monitored fleet. When you DO need it:
- Every count and status word in the snapshot is authoritative -- read it directly, never infer or recompute a total from a partial list mentioned elsewhere in the snapshot.
- Every timestamp in the snapshot is already in ISO 8601 local time -- do not convert, shift, or reinterpret timezones.
- Health scores are 0-100 where LOWER is WORSE (more alert volume/severity/repetition), not the reverse.
- "Critical watchlist" servers are a manually curated high-priority list, distinct from alert severity="Critical" -- a watchlist server can have zero critical alerts right now and still be worth mentioning as watched.
- If asked about something the snapshot doesn't cover, say so plainly rather than guessing or inventing a number.

Be concise and factual. This is an operations tool, not a conversational chatbot -- prioritize accuracy over flourish. Reminder: never summarize or reference the data snapshot unless the user's message actually calls for it.`;

module.exports = { buildDigest, SYSTEM_PROMPT };
