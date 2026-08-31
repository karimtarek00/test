// SCOM sync engine: pulls alerts via the SCOM PowerShell module
// (Get-SCOMAlert) and upserts them into the local `alerts` table. Same
// lifecycle shape as the reference app's nnmiSync.js (settings persistence,
// incremental vs full run modes, closure detection gated on a complete
// fetch, run-status polling, auto-fetch + scheduled full-sync timers,
// resume-on-boot).
//
// Chosen over a direct SQL connection: a real, working PowerShell script
// (provided by the team) confirmed Get-SCOMAlert access is live in this
// environment, whereas the SQL path required guessing at OperationsManager's
// internal table schema with no way to verify it. No credentials are stored
// in scom_settings at all -- the Node process's own Windows identity (or
// whatever New-SCOMManagementGroupConnection resolves) is what authenticates,
// exactly like the working reference script.
//
// mode: 'incremental' | 'full'. Only a 'full' run (a genuinely complete
// fetch of every currently-open alert) is allowed to detect and close
// alerts that dropped out of the open list.
//
// Field mapping confirmed against a real working script's output (not
// guessed): Severity is a string enum "Information" | "Warning" | "Error" --
// "Error" is what the SCOM Console UI *displays* as "Critical", the
// underlying value is literally "Error". MonitoringObjectDisplayName is the
// correct, stable "affected server" field (far more reliable than parsing
// free-text alert descriptions). ResolutionState is numeric, 255 = Closed.
//
// This can only run on a Windows host with the OperationsManager PowerShell
// module installed (ships with the SCOM console) -- it was not possible to
// execute a real Get-SCOMAlert call from this development environment
// (Linux, no SCOM), so the PowerShell script text and JSON date parsing
// below are carefully written but unverified end-to-end. Test Connection
// on the Configuration page is the way to confirm it works once deployed.
const { execFile } = require('child_process');
const { pool, withWriteLock, yieldToEventLoop } = require('./db');
const { invalidateHealthScoreCache } = require('./healthScore');
const { normalizeServerName } = require('./serverNameMatch');
const logger = require('./logger');

const log = logger.forModule('scom-sync');

let syncing = false;
let stopRequested = false;
let currentProgress = null;
let lastResult = null;

function getRunStatus() {
  return { running: syncing, progress: syncing ? currentProgress : null, lastResult };
}

function requestStop() {
  if (syncing) stopRequested = true;
}

async function getSettings() {
  const { rows } = await pool.query('SELECT * FROM scom_settings WHERE id = 1');
  return rows[0] || null;
}

async function saveSettings(fields) {
  const current = (await getSettings()) || {};
  const merged = { ...current, ...fields };
  const fullSyncIntervalMinutes = merged.full_sync_interval_minutes !== undefined && merged.full_sync_interval_minutes !== null && merged.full_sync_interval_minutes !== ''
    ? Math.max(0, parseInt(merged.full_sync_interval_minutes, 10) || 0)
    : 30;
  await pool.query(
    `UPDATE scom_settings SET management_server=$1, full_sync_interval_minutes=$2,
       updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = 1`,
    [merged.management_server || null, fullSyncIntervalMinutes]
  );
  const saved = await getSettings();
  scheduleFullSyncTicks(saved.full_sync_interval_minutes);
  return saved;
}

// There's no required credential field for this access method -- a blank
// management_server is valid (it means "use whatever connection context is
// already active"). "Configured" just means the row exists, which it
// always does after boot's INSERT OR IGNORE.
function isConfigured() {
  return true;
}

const PS_SHELL = process.env.SCOM_POWERSHELL_PATH || 'powershell.exe';
const PS_TIMEOUT_MS = 60000;

function psStringLiteral(value) {
  // Single-quoted PowerShell string literal -- only needs '' escaping for
  // an embedded quote, no backslash escaping like double-quoted strings.
  return `'${String(value).replace(/'/g, "''")}'`;
}

function runPowerShell(script) {
  return new Promise((resolve, reject) => {
    execFile(
      PS_SHELL,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeout: PS_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          if (err.code === 'ENOENT') {
            return reject(new Error(`${PS_SHELL} not found -- this must run on a Windows host with PowerShell available.`));
          }
          if (err.killed) {
            return reject(new Error(`PowerShell command timed out after ${PS_TIMEOUT_MS / 1000}s.`));
          }
          return reject(new Error(`PowerShell error: ${(stderr || err.message || '').toString().trim().slice(0, 500)}`));
        }
        resolve(stdout);
      }
    );
  });
}

function connectSnippet(managementServer) {
  return managementServer
    ? `New-SCOMManagementGroupConnection -ComputerName ${psStringLiteral(managementServer)};`
    : '';
}

async function testConnection(settingsOverride) {
  const settings = settingsOverride || (await getSettings());
  const script = `
$ErrorActionPreference = 'Stop'
Import-Module OperationsManager
${connectSnippet(settings.management_server)}
Get-SCOMAlert -Criteria "ResolutionState < 255" | Select-Object -First 1 | Out-Null
Write-Output 'OK'
`.trim();
  const out = await runPowerShell(script);
  if (!out.includes('OK')) throw new Error(`Unexpected PowerShell output: ${out.slice(0, 300)}`);
}

function mapSeverity(text) {
  // Confirmed against a real working script: the enum's actual value is
  // "Error", not "Critical" -- "Critical" is only the SCOM Console UI's
  // display label for it.
  if (text === 'Error') return 'Critical';
  if (text === 'Warning') return 'Warning';
  return 'Information';
}

function mapResolutionLabel(code) {
  if (code === 0) return 'New';
  if (code === 255) return 'Closed';
  return 'In Progress';
}

// PowerShell's ConvertTo-Json can render a DateTime as either a plain ISO
// string (PowerShell 7/pwsh) or the legacy "/Date(ticks)/" form (Windows
// PowerShell 5.1) depending on version -- handle both rather than assuming.
function parsePsDate(value) {
  if (!value) return null;
  const legacyMatch = /\/Date\((\d+)\)\//.exec(value);
  if (legacyMatch) return new Date(Number(legacyMatch[1]));
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

// Returns every currently-open alert (mode='full') or everything changed
// since the last sync (mode='incremental'). No row cap is applied here (no
// documented pagination for Get-SCOMAlert the way SQL's TOP works), so
// stoppedEarly is always false -- a 'full' run is always safe to use for
// closure detection as long as the PowerShell call itself succeeds.
async function fetchOpenAlerts(settings, mode, sinceIso) {
  const criteria = mode === 'incremental' && sinceIso
    ? `ResolutionState < 255 AND LastModified > ${psStringLiteral(sinceIso)}`
    : 'ResolutionState < 255';

  const script = `
$ErrorActionPreference = 'Stop'
Import-Module OperationsManager
${connectSnippet(settings.management_server)}
$alerts = @(Get-SCOMAlert -Criteria ${psStringLiteral(criteria)} |
  Select-Object Id,
    Name,
    @{Name="SeverityText";Expression={$_.Severity.ToString()}},
    @{Name="SourceDisplayName";Expression={$_.MonitoringObjectDisplayName}},
    TimeRaised,
    LastModified,
    ResolutionState)
ConvertTo-Json -InputObject $alerts -Depth 5 -Compress
`.trim();

  const stdout = await runPowerShell(script);
  const trimmed = stdout.trim();
  const parsed = trimmed ? JSON.parse(trimmed) : [];
  const rows = Array.isArray(parsed) ? parsed : [parsed];

  const items = rows.map((row) => ({
    scomAlertId: String(row.Id),
    hostname: row.SourceDisplayName || 'Unknown',
    alertName: row.Name,
    severity: mapSeverity(row.SeverityText),
    resolutionState: row.ResolutionState,
    resolutionStateLabel: mapResolutionLabel(row.ResolutionState),
    source: row.SourceDisplayName || null,
    timeRaised: (parsePsDate(row.TimeRaised) || new Date()).toISOString(),
    lastModified: (parsePsDate(row.LastModified) || new Date()).toISOString(),
  }));
  return { items, stoppedEarly: false };
}

async function runOnce(options = {}) {
  const mode = options.mode === 'incremental' ? 'incremental' : 'full';
  if (syncing) return { ok: false, skipped: true, error: 'A sync is already in progress -- wait for it to finish and try again.' };
  syncing = true;
  stopRequested = false;
  currentProgress = { startedAt: Date.now(), mode };
  try {
    const settings = await getSettings();

    const { items, stoppedEarly } = await fetchOpenAlerts(settings, mode, settings.last_sync_at);
    const seenGuids = new Set(items.map((a) => a.scomAlertId));

    const { created, updated, closed } = await withWriteLock(async () => {
      const client = await pool.connect();
      let created = 0, updated = 0, closed = 0;
      try {
        await client.query('BEGIN');

        const existingRows = await client.query('SELECT id, scom_alert_id FROM alerts WHERE scom_alert_id IS NOT NULL');
        const alertIdByGuid = new Map(existingRows.rows.map((r) => [r.scom_alert_id, r.id]));

        const serverRows = await client.query('SELECT id, normalized_key FROM servers');
        const serverIdByKey = new Map(serverRows.rows.map((s) => [s.normalized_key, s.id]));

        let processed = 0;
        for (const a of items) {
          const serverKey = normalizeServerName(a.hostname);
          let serverId = serverIdByKey.get(serverKey) || null;
          if (!serverId && a.hostname !== 'Unknown') {
            const createdServer = await client.query(
              `INSERT INTO servers (hostname, normalized_key, source) VALUES ($1, $2, 'sync') RETURNING id`,
              [a.hostname, serverKey]
            );
            serverId = createdServer.rows[0].id;
            serverIdByKey.set(serverKey, serverId);
          }

          if (alertIdByGuid.has(a.scomAlertId)) {
            // UPDATE only -- created_at (sourced from TimeRaised on INSERT
            // below) is deliberately NOT in this SET list. Only
            // last_modified is allowed to keep advancing on a re-sync --
            // see the critical correctness rule in the file header.
            await client.query(
              `UPDATE alerts SET server_id=$1, server_name_raw=$2, alert_name=$3, severity=$4,
                 resolution_state=$5, resolution_state_label=$6, source=$7, last_modified=$8,
                 resolved_at=CASE WHEN $6='Closed' THEN COALESCE(resolved_at, $8) ELSE NULL END
               WHERE scom_alert_id=$9`,
              [serverId, a.hostname, a.alertName, a.severity, a.resolutionState, a.resolutionStateLabel, a.source, a.lastModified, a.scomAlertId]
            );
            updated++;
          } else {
            await client.query(
              `INSERT INTO alerts (scom_alert_id, server_id, server_name_raw, alert_name, severity,
                 resolution_state, resolution_state_label, source, created_at, last_modified, origin)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'sync')`,
              [a.scomAlertId, serverId, a.hostname, a.alertName, a.severity, a.resolutionState, a.resolutionStateLabel, a.source, a.timeRaised, a.lastModified]
            );
            created++;
          }
          if (++processed % 200 === 0) await yieldToEventLoop();
        }

        // Closure detection: only safe when this run saw SCOM's complete
        // open-alert list (a full run that wasn't stopped early).
        if (mode === 'full' && !stoppedEarly) {
          const stillOpenRows = await client.query(
            `SELECT id, scom_alert_id FROM alerts WHERE origin='sync' AND resolution_state_label != 'Closed'`
          );
          const now = new Date().toISOString();
          let closeProcessed = 0;
          for (const row of stillOpenRows.rows) {
            if (!seenGuids.has(row.scom_alert_id)) {
              await client.query(
                `UPDATE alerts SET resolution_state=255, resolution_state_label='Closed', resolved_at=$1 WHERE id=$2`,
                [now, row.id]
              );
              closed++;
            }
            if (++closeProcessed % 200 === 0) await yieldToEventLoop();
          }
        }

        await client.query('COMMIT');
        return { created, updated, closed };
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    });

    if (mode !== 'incremental') invalidateHealthScoreCache();
    const result = { ok: true, open: items.length, created, updated, closed, at: new Date().toISOString(), mode, stoppedEarly };
    log.info({ mode, open: result.open, created, updated, closed, stoppedEarly }, mode === 'incremental' ? 'auto-fetch tick completed' : 'full sync completed');
    await pool.query(
      `UPDATE scom_settings SET last_sync_at=$1, last_sync_status='ok', last_sync_error=NULL,
         last_sync_open_count=$2, last_sync_new_count=$3, last_sync_closed_count=$4, last_sync_mode=$5 WHERE id=1`,
      [result.at, result.open, result.created, result.closed, mode]
    );
    lastResult = result;
    return result;
  } catch (err) {
    await pool.query(
      `UPDATE scom_settings SET last_sync_at=$1, last_sync_status='error', last_sync_error=$2, last_sync_mode=$3 WHERE id=1`,
      [new Date().toISOString(), err.message, mode]
    );
    lastResult = { ok: false, error: err.message, at: new Date().toISOString(), mode };
    throw err;
  } finally {
    syncing = false;
    stopRequested = false;
    currentProgress = null;
  }
}

const AUTO_FETCH_INTERVAL_MS = 5 * 60 * 1000;
let autoFetchTimer = null;

function isAutoFetchRunning() {
  return !!autoFetchTimer;
}

function scheduleAutoFetchTicks() {
  if (autoFetchTimer) clearInterval(autoFetchTimer);
  autoFetchTimer = setInterval(() => {
    runOnce({ mode: 'incremental' }).catch((e) => log.error({ err: e }, 'auto-fetch tick failed'));
  }, AUTO_FETCH_INTERVAL_MS);
}

async function startAutoFetch() {
  await pool.query(`UPDATE scom_settings SET enabled=1 WHERE id=1`);
  scheduleAutoFetchTicks();
  runOnce({ mode: 'incremental' }).catch((e) => log.error({ err: e }, 'auto-fetch kick-off failed'));
}

async function stopAutoFetch() {
  if (autoFetchTimer) { clearInterval(autoFetchTimer); autoFetchTimer = null; }
  await pool.query(`UPDATE scom_settings SET enabled=0 WHERE id=1`);
}

async function resumeAutoFetchIfEnabled() {
  const settings = await getSettings();
  if (settings?.enabled) {
    scheduleAutoFetchTicks();
    log.info('auto-fetch resumed (every 5 min, incremental) from previous session');
  }
}

const MS_PER_MINUTE = 60 * 1000;
let fullSyncTimer = null;
let nextFullSyncRunAt = null;
let lastFullSyncFiredAt = null;
let lastFullSyncFireResult = null;

function scheduleFullSyncTicks(minutes) {
  if (fullSyncTimer) { clearInterval(fullSyncTimer); fullSyncTimer = null; }
  nextFullSyncRunAt = null;
  if (!minutes || minutes <= 0) return;
  nextFullSyncRunAt = new Date(Date.now() + minutes * MS_PER_MINUTE).toISOString();
  fullSyncTimer = setInterval(() => {
    lastFullSyncFiredAt = new Date().toISOString();
    nextFullSyncRunAt = new Date(Date.now() + minutes * MS_PER_MINUTE).toISOString();
    runOnce({ mode: 'full' })
      .then(() => { lastFullSyncFireResult = 'ok'; })
      .catch((e) => { lastFullSyncFireResult = 'error'; log.error({ err: e }, 'scheduled full sync failed'); });
  }, minutes * MS_PER_MINUTE);
}

function isFullSyncScheduled() {
  return !!fullSyncTimer;
}

function getFullSyncScheduleInfo() {
  return { armed: isFullSyncScheduled(), nextRunAt: nextFullSyncRunAt, lastFiredAt: lastFullSyncFiredAt, lastFireResult: lastFullSyncFireResult };
}

async function resumeFullSync() {
  const settings = await getSettings();
  const minutes = settings?.full_sync_interval_minutes;
  scheduleFullSyncTicks(minutes);
  if (minutes > 0) log.info({ minutes }, 'scheduled full sync (closure detection) armed');
}

module.exports = {
  getSettings, saveSettings, isConfigured, testConnection, runOnce, getRunStatus, requestStop,
  startAutoFetch, stopAutoFetch, isAutoFetchRunning, resumeAutoFetchIfEnabled,
  isFullSyncScheduled, resumeFullSync, getFullSyncScheduleInfo,
};
