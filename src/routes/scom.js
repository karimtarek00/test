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
  const { managementServer, fullSyncIntervalMinutes, autoFetchIntervalMinutes, winrmUsername, winrmPassword } = req.body;
  const saved = await scomSync.saveSettings({
    management_server: managementServer?.trim(),
    full_sync_interval_minutes: fullSyncIntervalMinutes,
    auto_fetch_interval_minutes: autoFetchIntervalMinutes,
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

router.post('/auto-fetch/start', asyncHandler(async (req, res) => {
  await scomSync.startAutoFetch();
  log.info({ userId: req.user?.id }, 'scom auto-fetch started');
  res.json({ ok: true });
}));

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
  const rows = items.map((a) => ({
    'Alert Name': a.alertName,
    'Resolved Hostname': a.hostname,
    'Resolution Rule': a.hostnameSource,
    'Raw NetbiosComputerName': a.rawNetbiosComputerName || '',
    'Raw PrincipalName': a.rawPrincipalName || '',
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
  // Explicit header order -- json_to_sheet silently drops a column
  // entirely if every row's value for it is null/undefined (a real bug
  // caught earlier in this app's other Excel exports), and an all-blank
  // raw field is exactly the case this diagnostic exists to show.
  const HEADER = [
    'Alert Name', 'Resolved Hostname', 'Resolution Rule',
    'Raw NetbiosComputerName', 'Raw PrincipalName', 'Raw MonitoringObjectDisplayName',
    'Severity', 'Resolution State',
    'Raw Time Raised (from SCOM, no conversion)', 'Converted Time Raised (UTC, stored in this app)',
  ];
  const sheet = XLSX.utils.json_to_sheet(rows, { header: HEADER });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet, 'Raw Sample');
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  log.info({ userId: req.user?.id, rows: rows.length }, 'scom raw alert sample downloaded');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="scom-raw-sample-${new Date().toISOString().slice(0, 10)}.xlsx"`);
  res.send(buffer);
}));

router.post('/auto-fetch/stop', asyncHandler(async (req, res) => {
  await scomSync.stopAutoFetch();
  log.info({ userId: req.user?.id }, 'scom auto-fetch stopped');
  res.json({ ok: true });
}));

module.exports = router;
