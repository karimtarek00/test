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
// Tracked separately from lastResult (a differently-shaped {open, created,
// updated, closed} sync result) so the two outcomes can never render as
// each other's fields in the UI.
let lastRecalculateResult = null;

function getRunStatus() {
  return { running: syncing, progress: syncing ? currentProgress : null, lastResult, lastRecalculateResult };
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
  // Signed (can be negative) -- a manual correction on top of
  // parseScomTimestamp()'s "raw digits are already UTC" default, for
  // whatever residual gap this specific management server turns out to
  // have. 0 = no adjustment, the confirmed-correct default.
  const timestampAdjustmentMinutes = merged.timestamp_adjustment_minutes !== undefined && merged.timestamp_adjustment_minutes !== null && merged.timestamp_adjustment_minutes !== ''
    ? parseInt(merged.timestamp_adjustment_minutes, 10) || 0
    : 0;
  // A blank password in the incoming fields means "leave the stored
  // password alone" (the settings form never receives the real password
  // back to redisplay, so it can't round-trip it) -- only overwrite when a
  // non-empty value was actually provided.
  const winrmPassword = fields.winrm_password ? fields.winrm_password : current.winrm_password || null;
  await pool.query(
    `UPDATE scom_settings SET management_server=$1, winrm_username=$2, winrm_password=$3,
       full_sync_interval_minutes=$4, auto_fetch_interval_minutes=$5, timestamp_adjustment_minutes=$6,
       updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = 1`,
    [merged.management_server || null, merged.winrm_username || null, winrmPassword, fullSyncIntervalMinutes, autoFetchIntervalMinutes, timestampAdjustmentMinutes]
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

// Confirmed against both this app's own seed/demo data and a real
// production dump: when an alert is raised directly against the
// "Operating System" class instance itself (a huge category -- memory/CPU/
// disk alerts), MonitoringObjectDisplayName is just the OS platform's own
// display name -- "Microsoft Windows Server 2019 Standard", "Red Hat
// Enterprise Linux Server release 7.9 (Maipo)", etc -- describing the
// software running on the server, not identifying which server it is.
// This is exactly how ~1,495 real alerts ended up "hosted" on a fake
// device literally named "Microsoft Windows Server 2019 Standard": Path
// had no backslash for these (see hostnameFromPath above), so resolution
// fell through all the way to this display name and accepted it as-is.
const GENERIC_OS_PLATFORM_NAME_PATTERNS = [
  /^Microsoft Windows Server\b/i,
  /^Microsoft Windows\b/i,
  /^Red Hat Enterprise Linux\b/i,
  /^CentOS\b/i,
  /^Ubuntu\b/i,
  /^SUSE Linux Enterprise\b/i,
  /^Oracle Linux\b/i,
];
function isGenericOsPlatformName(name) {
  return GENERIC_OS_PLATFORM_NAME_PATTERNS.some((re) => re.test(name.trim()));
}

function hostnameFromDisplayName(displayName) {
  if (!displayName) return null;
  // A cluster resource group's display name is "<RoleName> (<Server>)" --
  // confirmed against a real alert ("ECMDB2Role (RMP-DCDB2-ECMCS)") where
  // NetbiosComputerName/PrincipalName were both blank for that alert's
  // target class. The parenthetical part is the real server. Checked
  // before the generic-OS-name exclusion since "Red Hat Enterprise Linux
  // Server release 7.9 (Maipo)" also ends in parens but that parenthetical
  // is a codename, not a server -- isGenericOsPlatformName's prefix match
  // catches it either way since it tests the start of the raw string.
  if (isGenericOsPlatformName(displayName)) return null;
  const clusterMatch = displayName.match(/\(([^)]+)\)\s*$/);
  if (clusterMatch) return clusterMatch[1];
  if (SQL_SYSTEM_DATABASES.has(displayName.trim().toLowerCase())) return null;
  return displayName;
}

// The SCOM Console's own "Path" field (shown in Alert Details) -- confirmed
// against a real screenshot -- is always formatted
// "<hostname>.<domain>\<class/component chain>", e.g.
// "RMP-ITAPP-PCB1.SEC.se.com.sa\Microsoft Windows Server 2022 Standard".
// The segment before the FIRST backslash is always the actual hosting
// Windows Computer object's path, regardless of how deeply nested the
// alerting object itself is (a SQL database, a cluster resource group,
// etc.) -- this is what makes it reliable exactly where
// NetbiosComputerName/PrincipalName/MonitoringObjectDisplayName all fail
// (the "master"/"msdb"/"DBA_Inventory" fake-server problem): those three
// fields describe the alerting OBJECT, but Path always starts from the
// real server that object lives on.
// Confirmed against a real production dump: for an alert raised directly
// against the "Operating System" instance itself (a huge category --
// memory/CPU/disk alerts), this org's SCOM environment returns a Path with
// NO backslash at all -- just the object's own class name (e.g. "Microsoft
// Windows Server 2019 Standard"), because that object has no recorded
// "hosted by" chain to walk up to the real computer. A path with no
// backslash carries no server identity whatsoever, so returning it as if
// it were a hostname was exactly how ~1,495 real alerts ended up with
// "Microsoft Windows Server 2019 Standard" as their "server name" -- must
// require a backslash (an actual "<hostname>\<class chain>" shape) before
// trusting the first segment.
function hostnameFromPath(path) {
  if (!path || !path.includes('\\')) return null;
  const serverSegment = path.split('\\')[0];
  if (!serverSegment) return null;
  return serverSegment.split('.')[0];
}

// Two different code-only assumptions about this SCOM management server's
// clock/timezone behavior have now each shipped and turned out wrong,
// neither catchable without live production data to check against:
//   1. .ToUniversalTime() on the SCOM server, assuming Kind=Unspecified
//      meant "this server's own local time" -- a no-op if Kind was
//      already Utc, or if that server's OS clock is itself set to UTC.
//   2. Subtracting this org's confirmed UTC+3 offset from the raw
//      wall-clock digits, assuming those digits were Saudi local time --
//      confirmed WRONG by a live report: every alert then displayed
//      exactly 3 hours EARLIER than the real event time, which is the
//      unambiguous signature of subtracting an offset from a value that
//      was already correct UTC.
//
// That live report is the actual evidence this now runs on: the raw
// digits Get-SCOMAlert returns for TimeRaised/LastModified on THIS
// deployment's management server already ARE UTC-equivalent -- no
// arithmetic needed, just an explicit 'Z' suffix so Node's own parser
// can't apply yet another ambiguous local-timezone guess (the ORIGINAL
// bug, before either fix above). See ALERT_SELECT_PROPERTIES for why the
// raw string itself is trustworthy: .ToString("yyyy-MM-dd HH:mm:ss")
// applies no timezone math regardless of Kind, so this reflects exactly
// what Get-SCOMAlert returned.
//
// `adjustmentMinutes` (scom_settings.timestamp_adjustment_minutes, default
// 0) is a manual escape hatch on top of that -- added after getting this
// wrong twice already, so a still-real gap can be corrected from the
// Configuration page without waiting on another guess-and-deploy cycle.
function parseScomTimestamp(rawWallClock, adjustmentMinutes = 0) {
  if (!rawWallClock) return null;
  const asUtc = new Date(`${rawWallClock.replace(' ', 'T')}.000Z`);
  if (isNaN(asUtc.getTime())) return null;
  return new Date(asUtc.getTime() + (adjustmentMinutes || 0) * 60000).toISOString();
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

// Shared property list for both a real sync fetch and the read-only raw
// diagnostic sample below -- keeping this in one place means the debug
// view can never drift out of sync with what a real sync actually sees.
const ALERT_SELECT_PROPERTIES = `Select-Object Id,
    Name,
    @{Name="SeverityText";Expression={$_.Severity.ToString()}},
    @{Name="PriorityText";Expression={$_.Priority.ToString()}},
    ResolutionState,
    @{Name="TimeRaisedLocal";Expression={ if ($_.TimeRaised) { $_.TimeRaised.ToString("yyyy-MM-dd HH:mm:ss") } else { $null } }},
    @{Name="LastModifiedLocal";Expression={ if ($_.LastModified) { $_.LastModified.ToString("yyyy-MM-dd HH:mm:ss") } else { $null } }},
    RepeatCount,
    NetbiosComputerName,
    PrincipalName,
    MonitoringObjectDisplayName,
    MonitoringObjectPath,
    MonitoringObjectInMaintenanceMode`;

// Maps one raw Get-SCOMAlert row (already narrowed to
// ALERT_SELECT_PROPERTIES) to this app's internal alert shape. Kept as one
// shared function -- used both by the real sync (fetchOpenAlerts) and the
// read-only raw diagnostic sample (fetchRawAlertSample) -- so a hostname
// resolution question raised against the debug view is guaranteed to
// reflect the exact same logic a real sync actually applied, not a
// reimplementation that could quietly drift from it.
function mapAlertRow(row, adjustmentMinutes) {
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
  // cluster role names.
  //
  // MonitoringObjectPath (the SCOM Console's own "Path" field, confirmed
  // against a real screenshot) fixes this properly: it's always
  // "<hostname>.<domain>\<class chain>", and the segment before the first
  // backslash is always the real hosting server regardless of how deeply
  // nested the alerting object is -- so it catches exactly the cases
  // NetbiosComputerName/PrincipalName miss, without needing to guess at
  // display-name patterns. hostnameFromDisplayName()'s cluster-role/
  // SQL-system-database handling is kept only as a last-resort fallback
  // for the rare case Path itself is also blank.
  const pathHostname = hostnameFromPath(row.MonitoringObjectPath);
  const displayFallback = hostnameFromDisplayName(row.MonitoringObjectDisplayName);
  const hostname = row.NetbiosComputerName
    || (row.PrincipalName ? row.PrincipalName.split('.')[0] : null)
    || pathHostname
    || displayFallback
    || 'Unknown';
  // Records WHICH rule actually produced the hostname above -- not used by
  // the real sync itself, only surfaced by fetchRawAlertSample() so a wrong
  // name can be traced back to a specific field/rule instead of guessed at.
  const hostnameSource = row.NetbiosComputerName ? 'NetbiosComputerName'
    : row.PrincipalName ? 'PrincipalName (FQDN, first label)'
    : pathHostname ? 'MonitoringObjectPath (server segment before first backslash)'
    : displayFallback ? 'MonitoringObjectDisplayName (cluster-role-style fallback)'
    : 'Unknown -- NetbiosComputerName/PrincipalName/MonitoringObjectPath blank, and MonitoringObjectDisplayName was blank or an excluded SQL system database name';
  return {
    scomAlertId: String(row.Id),
    hostname,
    hostnameSource,
    rawNetbiosComputerName: row.NetbiosComputerName || null,
    rawPrincipalName: row.PrincipalName || null,
    rawMonitoringObjectPath: row.MonitoringObjectPath || null,
    rawMonitoringObjectDisplayName: row.MonitoringObjectDisplayName || null,
    alertName: row.Name,
    severity: mapSeverity(row.SeverityText),
    priority: row.PriorityText || null,
    resolutionState: row.ResolutionState,
    resolutionStateLabel: mapResolutionLabel(row.ResolutionState),
    source: row.MonitoringObjectDisplayName || null,
    repeatCount: typeof row.RepeatCount === 'number' ? row.RepeatCount : null,
    inMaintenanceMode: !!row.MonitoringObjectInMaintenanceMode,
    // Raw, unconverted wall-clock strings kept on the item too (not just
    // the converted ISO values below) so fetchRawAlertSample can show
    // exactly what SCOM returned side by side with what this app
    // converted it to -- the only way to verify a timezone fix against
    // real production data without guessing.
    rawTimeRaisedLocal: row.TimeRaisedLocal || null,
    rawLastModifiedLocal: row.LastModifiedLocal || null,
    timeRaised: parseScomTimestamp(row.TimeRaisedLocal, adjustmentMinutes) || new Date().toISOString(),
    lastModified: parseScomTimestamp(row.LastModifiedLocal, adjustmentMinutes) || new Date().toISOString(),
  };
}

// Returns every currently-open alert (mode='full') or everything changed
// since the last sync, minus a clock-skew buffer (mode='incremental'). No
// row cap is applied here (no documented pagination for Get-SCOMAlert the
// way SQL's TOP works), so stoppedEarly is always false -- a 'full' run is
// always safe to use for closure detection as long as the PowerShell call
// itself succeeds. Tested end-to-end against the real environment at
// 18,750 active alerts with no truncation -- Invoke-Command's remoting
// envelope handled that volume fine.
//
// TimeRaised/LastModified timezone handling: ALERT_SELECT_PROPERTIES
// formats these with .ToString("yyyy-MM-dd HH:mm:ss") on the SCOM server --
// a literal component read (year/month/day/hour/minute/second exactly as
// stored) with NO timezone conversion applied by .NET, regardless of the
// value's DateTime.Kind. parseScomTimestamp() (above) then treats that
// literal string as UTC directly plus scom_settings.timestamp_adjustment_
// minutes -- see that function's comment for the two prior, live-data-
// confirmed-wrong assumptions this replaced.
async function fetchOpenAlerts(settings, mode, sinceIso) {
  assertCredentialsPresent(settings);
  const criteria = mode === 'incremental' && sinceIso
    ? `ResolutionState < 255 AND LastModified > ${psStringLiteral(incrementalCutoff(sinceIso))}`
    : 'ResolutionState < 255';

  const inner = `
Import-Module OperationsManager -ErrorAction Stop
$alerts = @(Get-SCOMAlert -Criteria ${psStringLiteral(criteria)} |
  ${ALERT_SELECT_PROPERTIES})
ConvertTo-Json -InputObject $alerts -Depth 5 -Compress
`.trim();
  const script = buildRemoteScript(settings.management_server, settings.winrm_username, inner);

  const stdout = await runPowerShell(script, { SCOM_WINRM_PASSWORD: settings.winrm_password });
  const trimmed = stdout.trim();
  const parsed = trimmed ? JSON.parse(trimmed) : [];
  const rows = Array.isArray(parsed) ? parsed : [parsed];

  const adjustmentMinutes = settings.timestamp_adjustment_minutes || 0;
  const items = rows.map((row) => mapAlertRow(row, adjustmentMinutes));
  return { items, stoppedEarly: false };
}

const RAW_SAMPLE_MAX_LIMIT = 2000;

// Read-only diagnostic: pulls a small, bounded sample of alerts straight
// from SCOM (via the exact same Select-Object shape and mapAlertRow logic
// a real sync uses) and returns it WITHOUT writing anything to the
// database -- purely a way to see the raw NetbiosComputerName/
// PrincipalName/MonitoringObjectDisplayName fields side by side with the
// hostname this app resolved from them, so a wrong server name can be
// traced to a specific field/rule instead of guessed at. `-First N` is
// applied on the SCOM server itself (before Select-Object even runs), so
// a small sample stays fast regardless of how many alerts are actually
// open fleet-wide.
async function fetchRawAlertSample(settingsOverride, limit) {
  const settings = settingsOverride || (await getSettings());
  assertCredentialsPresent(settings);
  const boundedLimit = Math.max(1, Math.min(RAW_SAMPLE_MAX_LIMIT, parseInt(limit, 10) || 300));

  const inner = `
Import-Module OperationsManager -ErrorAction Stop
$alerts = @(Get-SCOMAlert -Criteria ${psStringLiteral('ResolutionState < 255')} |
  Select-Object -First ${boundedLimit} |
  ${ALERT_SELECT_PROPERTIES})
ConvertTo-Json -InputObject $alerts -Depth 5 -Compress
`.trim();
  const script = buildRemoteScript(settings.management_server, settings.winrm_username, inner);

  const stdout = await runPowerShell(script, { SCOM_WINRM_PASSWORD: settings.winrm_password });
  const trimmed = stdout.trim();
  const parsed = trimmed ? JSON.parse(trimmed) : [];
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const adjustmentMinutes = settings.timestamp_adjustment_minutes || 0;
  return rows.map((row) => mapAlertRow(row, adjustmentMinutes));
}

// Full, unbounded raw export -- every currently-open alert, with the same
// raw diagnostic fields as fetchRawAlertSample(), but with no `-First N`
// cap. Reuses fetchOpenAlerts()'s exact live query (mode 'full', no
// since-cutoff) -- the same one runOnce() already uses for a real sync,
// already proven to handle this org's real fleet scale (~18,750 alerts,
// see file header) in one Invoke-Command round trip. fetchRawAlertSample's
// bounded sample exists for a *fast* look at a handful of alerts; this is
// for "I want everything," where a `-First N` cap risks silently missing
// whole alert categories if SCOM doesn't return rows in a representative
// order. Still read-only -- nothing is written to the database.
async function fetchAllRawAlerts(settingsOverride) {
  const settings = settingsOverride || (await getSettings());
  assertCredentialsPresent(settings);
  const { items } = await fetchOpenAlerts(settings, 'full', null);
  return items;
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

// One-time historical correction, deliberately separate from runOnce()'s
// normal sync path. created_at is immutable there on purpose (a re-sync
// must never overwrite "when did this alert really first fire" just
// because SCOM was polled again) -- but that protection is exactly what
// keeps an alert's ORIGINALLY-WRONG timestamp permanent once a timezone
// bug like the one fixed in parseScomTimestamp() has already stored it.
// A brand-new alert synced after that fix is correct from the start; an
// alert synced before it keeps the old, wrong value forever unless
// something explicitly overwrites it -- this is that something.
//
// Only covers currently-OPEN alerts: Get-SCOMAlert's live "ResolutionState
// < 255" criteria can't return an alert that's already closed, so there's
// no way to re-derive a corrected timestamp for one from SCOM anymore --
// its original (possibly wrong) created_at is what history is stuck with.
async function recalculateTimestamps() {
  if (syncing) return { ok: false, skipped: true, error: 'A sync is already in progress -- wait for it to finish and try again.' };
  syncing = true;
  currentProgress = { startedAt: Date.now(), mode: 'recalculate' };
  try {
    const settings = await getSettings();
    assertCredentialsPresent(settings);
    const { items } = await fetchOpenAlerts(settings, 'full');

    let checked = 0, corrected = 0;
    await withWriteLock(async () => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const existingRows = await client.query(
          `SELECT id, scom_alert_id, created_at, last_modified FROM alerts WHERE scom_alert_id IS NOT NULL AND origin='sync'`
        );
        const existingByGuid = new Map(existingRows.rows.map((r) => [r.scom_alert_id, r]));

        for (const a of items) {
          const existing = existingByGuid.get(a.scomAlertId);
          if (!existing) continue; // not yet synced -- runOnce() will INSERT it normally
          checked++;
          if (existing.created_at !== a.timeRaised || existing.last_modified !== a.lastModified) {
            await client.query(
              `UPDATE alerts SET created_at=$1, last_modified=$2 WHERE id=$3`,
              [a.timeRaised, a.lastModified, existing.id]
            );
            corrected++;
          }
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    });

    if (corrected > 0) invalidateHealthScoreCache();
    const result = { ok: true, checked, corrected, at: new Date().toISOString() };
    log.info(result, 'one-time timestamp recalculation completed');
    lastRecalculateResult = result;
    return result;
  } catch (err) {
    lastRecalculateResult = { ok: false, error: err.message, at: new Date().toISOString() };
    throw err;
  } finally {
    syncing = false;
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
  fetchRawAlertSample, fetchAllRawAlerts, recalculateTimestamps,
};
