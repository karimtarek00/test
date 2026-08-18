const express = require('express');
const scomSync = require('../lib/scomSync');
const { asyncHandler } = require('../lib/errors');
const logger = require('../lib/logger');

const log = logger.forModule('scom-route');
const router = express.Router();

// Never echo the stored password back to the client.
function sanitize(settings) {
  if (!settings) return null;
  const { sql_password, ...rest } = settings;
  return { ...rest, hasPassword: !!sql_password, autoFetchEnabled: !!settings.enabled };
}

router.get('/settings', asyncHandler(async (req, res) => {
  res.json({ settings: sanitize(await scomSync.getSettings()), fullSyncSchedule: scomSync.getFullSyncScheduleInfo() });
}));

router.put('/settings', asyncHandler(async (req, res) => {
  const { sqlHost, sqlPort, sqlDatabase, sqlUsername, sqlPassword, fullSyncIntervalMinutes } = req.body;
  const current = await scomSync.getSettings();
  const saved = await scomSync.saveSettings({
    sql_host: sqlHost?.trim(),
    sql_port: sqlPort,
    sql_database: sqlDatabase?.trim(),
    sql_username: sqlUsername?.trim(),
    // Keep the existing password if the client didn't send a new one -- the
    // GET route never returns it, so an unrelated settings edit shouldn't
    // wipe out a previously saved credential.
    sql_password: sqlPassword === undefined || sqlPassword === '' ? current?.sql_password : sqlPassword,
    full_sync_interval_minutes: fullSyncIntervalMinutes,
  });
  log.info({ userId: req.user?.id }, 'scom settings updated');
  res.json({ settings: sanitize(saved) });
}));

// Manual/on-demand sync trigger. Fires runOnce() and returns immediately --
// once SQL access is wired in, a real fetch could take a while, and that
// shouldn't be tied to a single HTTP request's lifetime. Poll
// GET /run/status for progress and the final result.
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
