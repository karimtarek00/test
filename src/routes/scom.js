const express = require('express');
const scomSync = require('../lib/scomSync');
const { asyncHandler } = require('../lib/errors');
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

router.post('/auto-fetch/stop', asyncHandler(async (req, res) => {
  await scomSync.stopAutoFetch();
  log.info({ userId: req.user?.id }, 'scom auto-fetch stopped');
  res.json({ ok: true });
}));

module.exports = router;
