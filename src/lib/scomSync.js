// SCOM sync engine: pulls alerts via PowerShell Remoting (Invoke-Command)
// into the real SCOM Management Server, which runs Get-SCOMAlert locally
// there (where the OperationsManager module is already installed), and
// upserts the results into the local `alerts` table. Same lifecycle shape
// as the reference app's nnmiSync.js (settings persistence, incremental vs
// full run modes, closure detection gated on a complete fetch, run-status
// polling, auto-fetch + scheduled full-sync timers, resume-on-boot).
//
// Why WinRM/Invoke-Command and not the two earlier approaches: a direct SQL
// connection required guessing at OperationsManager's internal schema with
// no way to verify it, and a *local* Get-SCOMAlert call requires the
// OperationsManager PowerShell module to be installed on this app's own
// host, which isn't possible here (no SCOM console/command-shell install,
// no license, not co-located with a management server). Invoke-Command
// sidesteps both: nothing is installed locally, the module runs entirely on
// the remote management server, and this was verified end-to-end against
// the real environment (confirmed WinRM reachable on port 5985, confirmed
// 18,750 real active alerts returned with full field data -- far more than
// the SCOM web console's own 200-row display cap, which turned out to be a
// pure UI limit with no bearing on the actual dataset size).
//
// mode: 'incremental' | 'full'. Only a 'full' run (a genuinely complete
// fetch of every currently-open alert) is allowed to detect and close
// alerts that dropped out of the open list.
//
// Field mapping confirmed against a real Get-SCOMAlert dump (not guessed):
// Severity is a string enum "Information" | "Warning" | "Error" -- "Error"
// is what the SCOM Console UI *displays* as "Critical", the underlying
// value is literally "Error". The affected server is NetbiosComputerName
// (fallback PrincipalName's FQDN) -- NOT MonitoringObjectDisplayName, which
// is often a component of the server (a disk, a service) rather than the
// server itself; MonitoringObjectDisplayName is kept as the `source` detail
// field instead. ResolutionState is numeric, 255 = Closed. RepeatCount and
// MonitoringObjectInMaintenanceMode are both real fields worth capturing
// that weren't available from the earlier local-script approach.
//
// Both the Windows account's Remote Management Users membership on the
// management server AND its SCOM Read-Only Operator role must be on the
// SAME account -- Invoke-Command authenticates as exactly one identity, so
// there's no way to supply two different credentials for the two checks.
// The password is passed to the child PowerShell process via an env var
// (SCOM_WINRM_PASSWORD), never embedded in the script text or argv, so it
// doesn't show up in process listings or anywhere this app might log a
// command line.
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
  const autoFetchIntervalMinutes = merged.auto_fetch_interval_minutes !== undefined && merged.auto_fetch_interval_minutes !== null && merged.auto_fetch_interval_minutes !== ''
    ? Math.max(1, parseInt(merged.auto_fetch_interval_minutes, 10) || 5)
    : 5;
  // A blank password in the incoming fields means "leave the stored
  // password alone" (the settings form never receives the real password
  // back to redisplay, so it can't round-trip it) -- only overwrite when a
  // non-empty value was actually provided.
  const winrmPassword = fields.winrm_password ? fields.winrm_password : current.winrm_password || null;
  await pool.query(
    `UPDATE scom_settings SET management_server=$1, winrm_username=$2, winrm_password=$3,
       full_sync_interval_minutes=$4, auto_fetch_interval_minutes=$5,
       updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = 1`,
    [merged.management_server || null, merged.winrm_username || null, winrmPassword, fullSyncIntervalMinutes, autoFetchIntervalMinutes]
  );
  const saved = await getSettings();
  scheduleFullSyncTicks(saved.full_sync_interval_minutes);
  // If auto-fetch is already running, apply the new interval immediately
  // instead of waiting for the next restart to pick it up.
  if (isAutoFetchRunning()) scheduleAutoFetchTicks(saved.auto_fetch_interval_minutes);
  return saved;
}

function isConfigured(settings) {
  return !!(settings && settings.management_server && settings.winrm_username && settings.winrm_password);
}

const PS_SHELL = process.env.SCOM_POWERSHELL_PATH || 'powershell.exe';
const PS_TIMEOUT_MS = 120000;

function psStringLiteral(value) {
  // Single-quoted PowerShell string literal -- only needs '' escaping for
  // an embedded quote, no backslash escaping like double-quoted strings.
  return `'${String(value).replace(/'/g, "''")}'`;
}

function runPowerShell(script, envOverrides) {
  return new Promise((resolve, reject) => {
    execFile(
      PS_SHELL,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      {
        timeout: PS_TIMEOUT_MS,
        maxBuffer: 256 * 1024 * 1024,
        env: envOverrides ? { ...process.env, ...envOverrides } : process.env,
      },
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

// Wraps innerScriptBlockBody in a remote Invoke-Command call authenticated
// with the single account that must hold both the Remote Management Users
// and SCOM Read-Only Operator grants. The password never appears in this
// script text -- it's read from an env var set only on this child process
// (see runPowerShell's envOverrides), so it can't leak into a process list
// or any logged command line.
function buildRemoteScript(managementServer, username, innerScriptBlockBody) {
  return `
$ErrorActionPreference = 'Stop'
$securePwd = ConvertTo-SecureString $env:SCOM_WINRM_PASSWORD -AsPlainText -Force
$cred = New-Object System.Management.Automation.PSCredential(${psStringLiteral(username)}, $securePwd)
Invoke-Command -ComputerName ${psStringLiteral(managementServer)} -Credential $cred -ScriptBlock {
${innerScriptBlockBody}
}
`.trim();
}

function assertCredentialsPresent(settings) {
  if (!settings?.management_server) throw new Error('Management server is required.');
  if (!settings?.winrm_username) throw new Error('Username is required.');
  if (!settings?.winrm_password) throw new Error('Password is required.');
}

async function testConnection(settingsOverride) {
  const settings = settingsOverride || (await getSettings());
  assertCredentialsPresent(settings);
  const inner = `
Import-Module OperationsManager -ErrorAction Stop
Get-SCOMAlert -Criteria "ResolutionState < 255" | Select-Object -First 1 | Out-Null
Write-Output 'OK'
`.trim();
  const script = buildRemoteScript(settings.management_server, settings.winrm_username, inner);
  const out = await runPowerShell(script, { SCOM_WINRM_PASSWORD: settings.winrm_password });
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

// SQL Server's own fixed, universal system database names -- not
// org-specific, not guessed. A monitored SQL Server database's
// MonitoringObjectDisplayName is just the database name, which is one of
// these for every SQL Server instance that exists.
const SQL_SYSTEM_DATABASES = new Set(['master', 'model', 'msdb', 'tempdb']);

function hostnameFromDisplayName(displayName) {
  if (!displayName) return null;
  // A cluster resource group's display name is "<RoleName> (<Server>)" --
  // confirmed against a real alert ("ECMDB2Role (RMP-DCDB2-ECMCS)") where
  // NetbiosComputerName/PrincipalName were both blank for that alert's
  // target class. The parenthetical part is the real server.
  const clusterMatch = displayName.match(/\(([^)]+)\)\s*$/);
  if (clusterMatch) return clusterMatch[1];
  if (SQL_SYSTEM_DATABASES.has(displayName.trim().toLowerCase())) return null;
  return displayName;
}

// PowerShell's ConvertTo-Json can render a DateTime as either a plain ISO
// string (PowerShell 7/pwsh) or the legacy "/Date(ticks)/" form (Windows
// PowerShell 5.1) depending on version -- handle both rather than assuming.
// Both forms are safe here ONLY because fetchOpenAlerts explicitly converts
// every DateTime to UTC (.ToUniversalTime()) before ConvertTo-Json ever
// touches it -- see the comment there for why that matters.
function parsePsDate(value) {
  if (!value) return null;
  const legacyMatch = /\/Date\((\d+)\)\//.exec(value);
  if (legacyMatch) return new Date(Number(legacyMatch[1]));
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

// An incremental tick's cutoff (sinceIso) is stamped by THIS app server's
// own clock, but LastModified on each row is stamped by the remote SCOM
// management server's clock -- a real, common gap between two machines
// (even a few minutes of NTP drift, or just the time an Invoke-Command
// round trip itself takes between when SCOM evaluates the criteria and
// when this app records the new checkpoint) is enough for a genuinely
// brand-new alert to compare as "not after" the cutoff and get silently
// skipped forever after, on every subsequent tick -- since the checkpoint
// only ever moves forward. Subtracting a buffer before filtering re-fetches
// a small, harmless overlap of already-seen alerts each tick (a redundant
// UPDATE, never touching created_at) in exchange for never permanently
// losing a new one to clock skew.
const INCREMENTAL_LOOKBACK_BUFFER_MS = 10 * 60 * 1000;

function incrementalCutoff(sinceIso) {
  return new Date(new Date(sinceIso).getTime() - INCREMENTAL_LOOKBACK_BUFFER_MS).toISOString();
}

// Returns every currently-open alert (mode='full') or everything changed
// since the last sync, minus a clock-skew buffer (mode='incremental'). No
// row cap is applied here (no documented pagination for Get-SCOMAlert the
// way SQL's TOP works), so stoppedEarly is always false -- a 'full' run is
// always safe to use for closure detection as long as the PowerShell call
// itself succeeds. Tested end-to-end against the real environment at
// 18,750 active alerts with no truncation -- Invoke-Command's remoting
// envelope handled that volume fine.
async function fetchOpenAlerts(settings, mode, sinceIso) {
  assertCredentialsPresent(settings);
  const criteria = mode === 'incremental' && sinceIso
    ? `ResolutionState < 255 AND LastModified > ${psStringLiteral(incrementalCutoff(sinceIso))}`
    : 'ResolutionState < 255';

  // TimeRaised/LastModified come back from Get-SCOMAlert as .NET DateTime
  // values with Kind=Unspecified -- they represent this SCOM management
  // server's own local wall-clock time, but carry no marker saying so.
  // ConvertTo-Json then renders an Unspecified-Kind DateTime with NO
  // timezone offset at all (PowerShell 7/pwsh) or as epoch-ms UTC ticks
  // (Windows PowerShell 5.1, unambiguous). The pwsh case is exactly the bug
  // reported live: a Node Date parses a timezone-less "2026-09-01T07:17:23"
  // string as LOCAL to whatever timezone *the app server's own process*
  // happens to run in -- not this management server's timezone -- so the
  // exact same alert stores a different UTC instant depending purely on
  // the app host's OS/TZ setting, shifting every displayed alert time by
  // that offset (confirmed: reproduces a 3-hour shift between TZ=UTC and
  // TZ=Asia/Riyadh parsing the identical raw string). Calling
  // .ToUniversalTime() HERE, on the management server itself, resolves an
  // Unspecified-Kind value using that server's own correct local-to-UTC
  // offset before it ever leaves the machine that actually knows what
  // timezone the value was in -- so the JSON string is always an
  // unambiguous UTC instant, immune to the app server's own TZ entirely.
  const inner = `
Import-Module OperationsManager -ErrorAction Stop
$alerts = @(Get-SCOMAlert -Criteria ${psStringLiteral(criteria)} |
  Select-Object Id,
    Name,
    @{Name="SeverityText";Expression={$_.Severity.ToString()}},
    @{Name="PriorityText";Expression={$_.Priority.ToString()}},
    ResolutionState,
    @{Name="TimeRaisedUtc";Expression={ if ($_.TimeRaised) { $_.TimeRaised.ToUniversalTime().ToString("o") } else { $null } }},
    @{Name="LastModifiedUtc";Expression={ if ($_.LastModified) { $_.LastModified.ToUniversalTime().ToString("o") } else { $null } }},
    RepeatCount,
    NetbiosComputerName,
    PrincipalName,
    MonitoringObjectDisplayName,
    MonitoringObjectInMaintenanceMode)
ConvertTo-Json -InputObject $alerts -Depth 5 -Compress
`.trim();
  const script = buildRemoteScript(settings.management_server, settings.winrm_username, inner);

  const stdout = await runPowerShell(script, { SCOM_WINRM_PASSWORD: settings.winrm_password });
  const trimmed = stdout.trim();
  const parsed = trimmed ? JSON.parse(trimmed) : [];
  const rows = Array.isArray(parsed) ? parsed : [parsed];

  const items = rows.map((row) => {
    // NetbiosComputerName/PrincipalName are the real owning server --
    // confirmed against a live dump where MonitoringObjectDisplayName was
    // "Cluster Service" (a component) while these two correctly held the
    // actual hostname/FQDN. MonitoringObjectDisplayName is kept separately
    // as the `source` detail (what specifically triggered the alert), not
    // used for server identity -- same lesson as the seed data's hostname
    // filtering, caught here before it reached real synced data.
    //
    // Both fields come back blank for some monitored classes though (SQL
    // Server databases, cluster resource groups) -- confirmed against a
    // real 19k-row production export, where this fell through to
    // MonitoringObjectDisplayName and created fake "servers" named
    // "master"/"msdb"/"model"/"DBA_Inventory" (SQL system databases) and
    // cluster role names. hostnameFromDisplayName() handles the two
    // confirmed cases: a cluster role's display format embeds the real
    // server in parentheses ("ECMDB2Role (RMP-DCDB2-ECMCS)"), and SQL
    // Server's own fixed system database names are excluded outright
    // rather than guessed at, since a real server *could* coincidentally
    // share a name with some other unverified string but never with these
    // four reserved names.
    const hostname = row.NetbiosComputerName
      || (row.PrincipalName ? row.PrincipalName.split('.')[0] : null)
      || hostnameFromDisplayName(row.MonitoringObjectDisplayName)
      || 'Unknown';
    return {
      scomAlertId: String(row.Id),
      hostname,
      alertName: row.Name,
      severity: mapSeverity(row.SeverityText),
      priority: row.PriorityText || null,
      resolutionState: row.ResolutionState,
      resolutionStateLabel: mapResolutionLabel(row.ResolutionState),
      source: row.MonitoringObjectDisplayName || null,
      repeatCount: typeof row.RepeatCount === 'number' ? row.RepeatCount : null,
      inMaintenanceMode: !!row.MonitoringObjectInMaintenanceMode,
      timeRaised: (parsePsDate(row.TimeRaisedUtc) || new Date()).toISOString(),
      lastModified: (parsePsDate(row.LastModifiedUtc) || new Date()).toISOString(),
    };
  });
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
                 priority=$9, repeat_count=$10, in_maintenance_mode=$11,
                 resolved_at=CASE WHEN $6='Closed' THEN COALESCE(resolved_at, $8) ELSE NULL END
               WHERE scom_alert_id=$12`,
              [serverId, a.hostname, a.alertName, a.severity, a.resolutionState, a.resolutionStateLabel, a.source, a.lastModified,
                a.priority, a.repeatCount, a.inMaintenanceMode ? 1 : 0, a.scomAlertId]
            );
            updated++;
          } else {
            await client.query(
              `INSERT INTO alerts (scom_alert_id, server_id, server_name_raw, alert_name, severity,
                 resolution_state, resolution_state_label, source, priority, repeat_count, in_maintenance_mode,
                 created_at, last_modified, origin)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'sync')`,
              [a.scomAlertId, serverId, a.hostname, a.alertName, a.severity, a.resolutionState, a.resolutionStateLabel, a.source,
                a.priority, a.repeatCount, a.inMaintenanceMode ? 1 : 0, a.timeRaised, a.lastModified]
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
    // Tracked separately from last_sync_* above -- those reflect whichever
    // run happened most recently (full or incremental), which would hide a
    // successful auto-fetch tick's own history the next time a full sync
    // runs and overwrites the same fields. auto_fetch_run_count only counts
    // incremental ticks, so it answers "is the background sync actually
    // running" independent of manual full syncs.
    if (mode === 'incremental') {
      await pool.query(
        `UPDATE scom_settings SET auto_fetch_run_count = auto_fetch_run_count + 1,
           last_autofetch_at=$1, last_autofetch_status='ok', last_autofetch_error=NULL WHERE id=1`,
        [result.at]
      );
    }
    lastResult = result;
    return result;
  } catch (err) {
    await pool.query(
      `UPDATE scom_settings SET last_sync_at=$1, last_sync_status='error', last_sync_error=$2, last_sync_mode=$3 WHERE id=1`,
      [new Date().toISOString(), err.message, mode]
    );
    if (mode === 'incremental') {
      await pool.query(
        `UPDATE scom_settings SET auto_fetch_run_count = auto_fetch_run_count + 1,
           last_autofetch_at=$1, last_autofetch_status='error', last_autofetch_error=$2 WHERE id=1`,
        [new Date().toISOString(), err.message]
      );
    }
    lastResult = { ok: false, error: err.message, at: new Date().toISOString(), mode };
    throw err;
  } finally {
    syncing = false;
    stopRequested = false;
    currentProgress = null;
  }
}

const DEFAULT_AUTO_FETCH_MINUTES = 5;
let autoFetchTimer = null;

function isAutoFetchRunning() {
  return !!autoFetchTimer;
}

// minutes comes from scom_settings.auto_fetch_interval_minutes (user-
// configurable) -- falls back to the 5-minute default only if unset.
function scheduleAutoFetchTicks(minutes) {
  if (autoFetchTimer) clearInterval(autoFetchTimer);
  const intervalMs = Math.max(1, minutes || DEFAULT_AUTO_FETCH_MINUTES) * 60 * 1000;
  autoFetchTimer = setInterval(() => {
    runOnce({ mode: 'incremental' }).catch((e) => log.error({ err: e }, 'auto-fetch tick failed'));
  }, intervalMs);
}

async function startAutoFetch() {
  await pool.query(`UPDATE scom_settings SET enabled=1 WHERE id=1`);
  const settings = await getSettings();
  scheduleAutoFetchTicks(settings.auto_fetch_interval_minutes);
  runOnce({ mode: 'incremental' }).catch((e) => log.error({ err: e }, 'auto-fetch kick-off failed'));
}

async function stopAutoFetch() {
  if (autoFetchTimer) { clearInterval(autoFetchTimer); autoFetchTimer = null; }
  await pool.query(`UPDATE scom_settings SET enabled=0 WHERE id=1`);
}

async function resumeAutoFetchIfEnabled() {
  const settings = await getSettings();
  if (settings?.enabled) {
    scheduleAutoFetchTicks(settings.auto_fetch_interval_minutes);
    log.info({ minutes: settings.auto_fetch_interval_minutes }, 'auto-fetch resumed (incremental) from previous session');
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
  incrementalCutoff, INCREMENTAL_LOOKBACK_BUFFER_MS,
};
