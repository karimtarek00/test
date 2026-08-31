// SCOM sync engine: connects to the SCOM `OperationsManager` SQL Server
// database, pulls alerts, and upserts them into the local `alerts` table.
// Same lifecycle shape as the reference app's nnmiSync.js (settings
// persistence, incremental vs full run modes, closure detection gated on a
// complete fetch, run-status polling, auto-fetch + scheduled full-sync
// timers, resume-on-boot).
//
// mode: 'incremental' | 'full'. Only a 'full' run (a genuinely complete,
// unpaginated fetch of every currently-open alert) is allowed to detect and
// close alerts that dropped out of the open list -- an incremental/capped
// fetch must never trigger a closure, or a still-genuinely-open alert could
// be wrongly marked closed just because a row limit was hit.
//
// Table/column names below (Alert, BaseManagedEntity, ResolutionState,
// TimeRaised, LastModified, Severity) match SCOM's documented
// OperationsManager schema, but have not been run against a live instance in
// this environment -- verify them against the real database once SQL access
// is available, and adjust the query in fetchOpenAlerts() if this
// installation's schema differs (management-pack customizations, a
// non-standard view, etc).
const sql = require('mssql');
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
    `UPDATE scom_settings SET sql_host=$1, sql_port=$2, sql_database=$3, sql_username=$4, sql_password=$5,
       full_sync_interval_minutes=$6, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id = 1`,
    [
      merged.sql_host || null,
      merged.sql_port || null,
      merged.sql_database || null,
      merged.sql_username || null,
      merged.sql_password || null,
      fullSyncIntervalMinutes,
    ]
  );
  const saved = await getSettings();
  scheduleFullSyncTicks(saved.full_sync_interval_minutes);
  return saved;
}

function isConfigured(settings) {
  return !!(settings?.sql_host && settings?.sql_database && settings?.sql_username);
}

function mssqlConfig(settings) {
  if (!isConfigured(settings)) throw new Error('SCOM SQL connection is not configured yet -- set it on the Configuration page.');
  return {
    server: settings.sql_host,
    port: settings.sql_port ? Number(settings.sql_port) : 1433,
    database: settings.sql_database,
    user: settings.sql_username,
    password: settings.sql_password || '',
    // Most on-prem SQL Server instances SCOM runs against use a self-signed
    // or internal-CA certificate -- trustServerCertificate:true is the
    // common, expected setting for this kind of internal-only connection
    // (not exposed as its own toggle, unlike ai_settings.allow_insecure_tls,
    // since this add-on brief didn't ask for one here).
    options: { encrypt: true, trustServerCertificate: true },
    connectionTimeout: 15000,
    requestTimeout: 60000,
  };
}

// A trivial connectivity/credential check -- connects and runs SELECT 1,
// without touching the Alert table at all. Accepts an optional settings
// override so the Configuration page can test currently-entered values
// before they're saved (same pattern as the AI integration's Test
// Connection).
async function testConnection(settingsOverride) {
  const settings = settingsOverride || (await getSettings());
  const pool2 = await sql.connect(mssqlConfig(settings));
  try {
    await pool2.request().query('SELECT 1 AS ok');
  } finally {
    await pool2.close();
  }
}

function mapSeverity(code) {
  // SCOM AlertSeverity: 0 = Information, 1 = Warning, 2 = Critical.
  if (code === 2) return 'Critical';
  if (code === 1) return 'Warning';
  return 'Information';
}

function mapResolutionLabel(code) {
  if (code === 0) return 'New';
  if (code === 255) return 'Closed';
  return 'In Progress';
}

// Returns every currently-open alert (mode='full') or everything changed
// since the last sync (mode='incremental'), each as { scomAlertId, hostname,
// alertName, severity, resolutionState, resolutionStateLabel, source,
// timeRaised, lastModified }.
//
// timeRaised vs lastModified is the critical correctness rule from the
// add-on brief: SCOM tracks "when this alert was first raised" (TimeRaised)
// separately from "when it was last touched/re-observed" (LastModified).
// Only lastModified feeds the incremental cursor and only it may keep
// advancing on every re-sync -- timeRaised must be written once, on
// INSERT, and never touched again (see runOnce below), or a long-running
// still-open alert would look like it just started every sync cycle.
async function fetchOpenAlerts(settings, mode, sinceIso) {
  const connection = await sql.connect(mssqlConfig(settings));
  try {
    const request = connection.request();
    const whereParts = ['a.ResolutionState < 255'];
    if (mode === 'incremental' && sinceIso) {
      request.input('since', sql.DateTime2, new Date(sinceIso));
      whereParts.push('a.LastModified > @since');
    }
    // No TOP/row cap on a 'full' run -- capping it would silently make
    // closure detection unsafe (see runOnce). An incremental run is
    // naturally bounded by the LastModified filter, but still gets a
    // generous safety cap; if it's ever hit, treat the run as stopped early
    // so it can never be mistaken for a complete list.
    const capClause = mode === 'incremental' ? 'TOP 5000 ' : '';
    const result = await request.query(`
      SELECT ${capClause}
        a.AlertGuid, a.Name AS AlertName, a.Severity, a.ResolutionState,
        a.TimeRaised, a.LastModified, bme.DisplayName AS ComputerName
      FROM Alert a
      LEFT JOIN BaseManagedEntity bme ON bme.BaseManagedEntityId = a.MonitoringObjectId
      WHERE ${whereParts.join(' AND ')}
      ORDER BY a.LastModified ASC
    `);

    const stoppedEarly = mode === 'incremental' && result.recordset.length >= 5000;
    const items = result.recordset.map((row) => ({
      scomAlertId: row.AlertGuid,
      hostname: row.ComputerName || 'Unknown',
      alertName: row.AlertName,
      severity: mapSeverity(row.Severity),
      resolutionState: row.ResolutionState,
      resolutionStateLabel: mapResolutionLabel(row.ResolutionState),
      source: row.ComputerName || null,
      timeRaised: row.TimeRaised instanceof Date ? row.TimeRaised.toISOString() : row.TimeRaised,
      lastModified: row.LastModified instanceof Date ? row.LastModified.toISOString() : row.LastModified,
    }));
    return { items, stoppedEarly };
  } finally {
    await connection.close();
  }
}

async function runOnce(options = {}) {
  const mode = options.mode === 'incremental' ? 'incremental' : 'full';
  if (syncing) return { ok: false, skipped: true, error: 'A sync is already in progress -- wait for it to finish and try again.' };
  syncing = true;
  stopRequested = false;
  currentProgress = { startedAt: Date.now(), mode };
  try {
    const settings = await getSettings();
    if (!isConfigured(settings)) throw new Error('SCOM SQL connection is not configured yet -- set it on the Configuration page.');

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
            // last_modified is allowed to keep advancing on a re-sync.
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
        // open-alert list (a full run that wasn't capped/stopped early).
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
  if (settings?.enabled && isConfigured(settings)) {
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
  if (isConfigured(settings)) {
    scheduleFullSyncTicks(minutes);
    if (minutes > 0) log.info({ minutes }, 'scheduled full sync (closure detection) armed');
  }
}

module.exports = {
  getSettings, saveSettings, isConfigured, testConnection, runOnce, getRunStatus, requestStop,
  startAutoFetch, stopAutoFetch, isAutoFetchRunning, resumeAutoFetchIfEnabled,
  isFullSyncScheduled, resumeFullSync, getFullSyncScheduleInfo,
};
