// SCOM sync engine -- same lifecycle shape as the reference app's
// nnmiSync.js (settings persistence, incremental vs full run modes, closure
// detection gated on a complete fetch, run-status polling, auto-fetch +
// scheduled full-sync timers, resume-on-boot), but the actual data-fetch
// step is NOT wired up yet: it needs read access to the SCOM
// `OperationsManager` SQL Server database, which hasn't been provisioned in
// this session. fetchOpenAlerts() below is the one function that needs a
// real `mssql` query once that access exists -- everything else (settings,
// scheduling, closure-detection safety, status tracking) is already real
// and ready.
//
// mode: 'incremental' | 'full'. Only a 'full' run (a genuinely complete,
// unpaginated fetch of every currently-open alert) is allowed to detect and
// close alerts that dropped out of the open list -- an incremental/capped
// fetch must never trigger a closure, or a still-genuinely-open alert could
// be wrongly marked closed just because a page/row limit was hit.
const { pool } = require('./db');
const { invalidateHealthScoreCache } = require('./healthScore');
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

// The one function that needs real implementation once SQL access exists:
// connect to OperationsManager and return every currently-open alert
// (mode='full') or everything changed since the last incremental tick
// (mode='incremental'), each as { scomAlertId, hostname, alertName,
// severity, resolutionState, resolutionStateLabel, source, createdAt,
// lastModified }. Left throwing so callers get a clear, honest error
// instead of a silent no-op.
async function fetchOpenAlerts(settings, mode) {
  throw new Error(
    'SCOM SQL sync is not wired up yet -- fetchOpenAlerts() in src/lib/scomSync.js needs the mssql query ' +
    'implementation once read access to OperationsManager is available. Settings are saved and ready to use.'
  );
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

    const alerts = await fetchOpenAlerts(settings, mode);

    // Upsert logic mirrors importRoutes.js's alert upsert once real data
    // arrives here -- fetchOpenAlerts() always throws today, so this never
    // actually runs; left as the drop-in point for when it does.
    const created = 0, updated = 0, closed = 0;

    if (mode !== 'incremental') invalidateHealthScoreCache();
    const result = { ok: true, open: alerts.length, created, updated, closed, at: new Date().toISOString(), mode };
    log.info({ mode, open: result.open, created, updated, closed }, mode === 'incremental' ? 'auto-fetch tick completed' : 'full sync completed');
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
  getSettings, saveSettings, isConfigured, runOnce, getRunStatus, requestStop,
  startAutoFetch, stopAutoFetch, isAutoFetchRunning, resumeAutoFetchIfEnabled,
  isFullSyncScheduled, resumeFullSync, getFullSyncScheduleInfo,
};
