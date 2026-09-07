const express = require('express');
const XLSX = require('xlsx');
const scomSync = require('../lib/scomSync');
const { AppError, asyncHandler } = require('../lib/errors');
const logger = require('../lib/logger');

const log = logger.forModule('scom-route');
const router = express.Router();

function sanitize(settings) {
  if (!settings) return null;
  const { winrm_password, ...rest } = settings;
  return { ...rest, hasPassword: !!winrm_password, autoFetchEnabled: !!settings.enabled };
}

router.get('/settings', asyncHandler(async (req, res) => {
  res.json({ settings: sanitize(await scomSync.getSettings()), fullSyncSchedule: scomSync.getFullSyncScheduleInfo() });
}));

router.put('/settings', asyncHandler(async (req, res) => {
  const { managementServer, fullSyncIntervalMinutes, autoFetchIntervalMinutes, timestampAdjustmentMinutes, winrmUsername, winrmPassword } = req.body;
  const saved = await scomSync.saveSettings({
    management_server: managementServer?.trim(),
    full_sync_interval_minutes: fullSyncIntervalMinutes,
    auto_fetch_interval_minutes: autoFetchIntervalMinutes,
    timestamp_adjustment_minutes: timestampAdjustmentMinutes,
    winrm_username: winrmUsername?.trim(),
    // A blank password here means "keep the existing one" -- see
    // saveSettings, which only overwrites on a non-empty value. The form
    // never receives the real password back, so it can't send it unchanged.
    winrm_password: winrmPassword || undefined,
  });
  log.info({ userId: req.user?.id }, 'scom settings updated');
  res.json({ settings: sanitize(saved) });
}));

// Validates WinRM/Get-SCOMAlert access using the currently-entered
// (not-yet-saved) values, falling back to the stored ones for anything left
// blank (most commonly the password, which the form never redisplays).
// Deliberately always responds 200: {ok:false, error} is a normal outcome
// of a connectivity/access test, not a server error.
router.post('/test', asyncHandler(async (req, res) => {
  const current = await scomSync.getSettings();
  const { managementServer, winrmUsername, winrmPassword } = req.body || {};
  const candidate = {
    management_server: managementServer !== undefined ? managementServer : current?.management_server,
    winrm_username: winrmUsername !== undefined ? winrmUsername : current?.winrm_username,
    winrm_password: winrmPassword || current?.winrm_password,
  };
  try {
    await scomSync.testConnection(candidate);
    res.json({ ok: true });
  } catch (err) {
    log.warn({ err }, 'scom connection test failed');
    res.json({ ok: false, error: err.message });
  }
}));

// Manual/on-demand sync trigger. Fires runOnce() and returns immediately --
// a real Get-SCOMAlert call can take a while, and that shouldn't be tied to
// a single HTTP request's lifetime. Poll GET /run/status for progress and
// the final result.
router.post('/run', (req, res) => {
  const status = scomSync.getRunStatus();
  if (status.running) {
    return res.json({ ok: false, skipped: true, error: 'A sync is already in progress -- wait for it to finish and try again.' });
  }
  scomSync.runOnce({ mode: req.body?.mode }).catch((err) => log.error({ err }, 'scom sync run failed'));
  res.json({ ok: true, started: true });
});

router.get('/run/status', (req, res) => {
  res.json(scomSync.getRunStatus());
});

router.post('/stop', (req, res) => {
  scomSync.requestStop();
  res.json({ ok: true });
});

// One-time historical correction for alerts synced before a timezone fix
// shipped -- their created_at/last_modified were computed with the old,
// wrong logic and stay wrong forever otherwise (a normal sync deliberately
// never rewrites an existing alert's created_at). Only reaches currently-
// open alerts; SCOM's live query can't return anything already closed.
// Same fire-and-forget + poll-status shape as /run, since a live
// Get-SCOMAlert call can take a while.
router.post('/recalculate-timestamps', (req, res) => {
  const status = scomSync.getRunStatus();
  if (status.running) {
    return res.json({ ok: false, skipped: true, error: 'A sync is already in progress -- wait for it to finish and try again.' });
  }
  scomSync.recalculateTimestamps().catch((err) => log.error({ err }, 'scom timestamp recalculation failed'));
  res.json({ ok: true, started: true });
});

// One-time historical correction for alerts that are already Closed and
// stuck with a server name computed by an older, since-fixed hostname
// resolution rule -- a normal sync (even a full one) can never touch these,
// because it only ever re-fetches SCOM's current OPEN alert list. This
// re-queries SCOM directly by alert ID (which has no open/closed filter)
// for just the closed, sync-origin alerts, so it can reach what a normal
// sync structurally cannot. Same fire-and-forget + poll-status shape as
// /run and /recalculate-timestamps.
router.post('/recalculate-server-names', (req, res) => {
  const status = scomSync.getRunStatus();
  if (status.running) {
    return res.json({ ok: false, skipped: true, error: 'A sync is already in progress -- wait for it to finish and try again.' });
  }
  scomSync.recalculateServerNames().catch((err) => log.error({ err }, 'scom server-name recalculation failed'));
  res.json({ ok: true, started: true });
});

// Irreversible, user-requested last resort for closed alerts whose server
// name is wrong AND unrecoverable (SCOM has already groomed the alert
// away, so recalculate-server-names has nothing left to re-fetch). Deletes
// EVERY closed alert, not just the ones that were ever wrong -- there is
// no way to distinguish "closed and correct" from "closed and wrong" once
// the decision is to wipe the category wholesale, and that tradeoff was
// explicitly explained to and accepted by the user. A plain DELETE, not
// the fire-and-forget + poll-status shape the other actions use above --
// no SCOM round trip involved, so this finishes fast enough to just
// respond directly. Requires a literal confirmation phrase in the body as
// defense-in-depth beyond the frontend's own confirm() dialog, since a
// bare POST to this endpoint (a stray retry, a copy-pasted curl command)
// would otherwise be enough to trigger it.
router.post('/purge-closed-alerts', asyncHandler(async (req, res) => {
  if (req.body?.confirm !== 'DELETE ALL CLOSED ALERTS') {
    throw AppError.badRequest('Confirmation phrase missing or incorrect.');
  }
  const result = await scomSync.purgeClosedAlerts();
  log.warn({ userId: req.user?.id, deletedCount: result.deletedCount }, 'all closed alerts purged via admin request');
  res.json(result);
}));

router.post('/auto-fetch/start', asyncHandler(async (req, res) => {
  await scomSync.startAutoFetch();
  log.info({ userId: req.user?.id }, 'scom auto-fetch started');
  res.json({ ok: true });
}));

// Shared by both raw-export routes below (the small bounded sample and the
// full unbounded export) so their output columns can never drift apart --
// a wrong server name traced in one should look identical in the other.
const RAW_EXPORT_HEADER = [
  'Alert Name', 'Resolved Hostname', 'Resolution Rule',
  'Raw NetbiosComputerName', 'Raw PrincipalName', 'Raw MonitoringObjectPath', 'Raw MonitoringObjectDisplayName',
  'Severity', 'Resolution State',
  'Raw Time Raised (from SCOM, no conversion)', 'Converted Time Raised (UTC, stored in this app)',
];

function toRawExportRows(items) {
  return items.map((a) => ({
    'Alert Name': a.alertName,
    'Resolved Hostname': a.hostname,
    'Resolution Rule': a.hostnameSource,
    'Raw NetbiosComputerName': a.rawNetbiosComputerName || '',
    'Raw PrincipalName': a.rawPrincipalName || '',
    'Raw MonitoringObjectPath': a.rawMonitoringObjectPath || '',
    'Raw MonitoringObjectDisplayName': a.rawMonitoringObjectDisplayName || '',
    'Severity': a.severity,
    'Resolution State': a.resolutionStateLabel,
    // Both the literal string SCOM returned (compare this directly against
    // what the SCOM Console shows for the same alert) and what this app
    // converted it to -- the only way to verify a timezone fix against
    // real data instead of guessing at it again.
    'Raw Time Raised (from SCOM, no conversion)': a.rawTimeRaisedLocal || '',
    'Converted Time Raised (UTC, stored in this app)': a.timeRaised,
  }));
}

function sendRawExportXlsx(res, items, { sheetName, filenamePrefix }) {
  const rows = toRawExportRows(items);
  // Explicit header order -- json_to_sheet silently drops a column
  // entirely if every row's value for it is null/undefined (a real bug
  // caught earlier in this app's other Excel exports), and an all-blank
  // raw field is exactly the case this diagnostic exists to show.
  const sheet = XLSX.utils.json_to_sheet(rows, { header: RAW_EXPORT_HEADER });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet, sheetName);
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filenamePrefix}-${new Date().toISOString().slice(0, 10)}.xlsx"`);
  res.send(buffer);
  return rows.length;
}

// Read-only diagnostic: pulls a small live sample straight from SCOM (no
// database writes at all) and returns it as an Excel file with the raw
// NetbiosComputerName/PrincipalName/MonitoringObjectDisplayName fields
// alongside the hostname this app resolved from them and which rule
// produced it -- for tracing a specific wrong server name back to the
// actual SCOM data that caused it, rather than guessing.
router.get('/run/raw-sample', asyncHandler(async (req, res) => {
  let items;
  try {
    items = await scomSync.fetchRawAlertSample(null, req.query.limit);
  } catch (err) {
    log.warn({ err }, 'scom raw alert sample failed');
    throw AppError.badRequest(err.message);
  }
  const rowCount = sendRawExportXlsx(res, items, { sheetName: 'Raw Sample', filenamePrefix: 'scom-raw-sample' });
  log.info({ userId: req.user?.id, rows: rowCount }, 'scom raw alert sample downloaded');
}));

// Same shape as the sample above, but with no `-First N` cap at all --
// every currently-open alert, fetched via the exact same live query a real
// full sync uses (already proven at this org's real fleet scale, ~18,750
// alerts, in one Invoke-Command round trip -- see scomSync.js's file
// header). For "I want ALL the raw data, not just a couple hundred", not
// for a quick look at a handful of alerts (use the sample route for that).
router.get('/export/raw-all', asyncHandler(async (req, res) => {
  let items;
  try {
    items = await scomSync.fetchAllRawAlerts();
  } catch (err) {
    log.warn({ err }, 'scom full raw alert export failed');
    throw AppError.badRequest(err.message);
  }
  const rowCount = sendRawExportXlsx(res, items, { sheetName: 'All Raw Alerts', filenamePrefix: 'scom-raw-export-all' });
  log.info({ userId: req.user?.id, rows: rowCount }, 'scom full raw alert export downloaded');
}));

router.post('/auto-fetch/stop', asyncHandler(async (req, res) => {
  await scomSync.stopAutoFetch();
  log.info({ userId: req.user?.id }, 'scom auto-fetch stopped');
  res.json({ ok: true });
}));

module.exports = router;
