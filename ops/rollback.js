#!/usr/bin/env node
// Restores a previous version from backups/ (created automatically by
// every deploy.js run) and restarts. Usage:
//   node ops/rollback.js            -- restores the most recent backup
//   node ops/rollback.js list       -- lists available backups
//   node ops/rollback.js <name>     -- restores a specific backup by name
const fs = require('fs');
const path = require('path');
const http = require('http');

const { APP_ROOT, BACKUP_DIR } = require('./lib/paths');
const { deployableEntries, copyEntries } = require('./lib/sync');
const pm2 = require('./lib/pm2');

const HEALTH_TIMEOUT_MS = 180000;

function listBackups() {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs.readdirSync(BACKUP_DIR)
    .filter((n) => fs.statSync(path.join(BACKUP_DIR, n)).isDirectory())
    .sort();
}

function resolvePort() {
  if (process.env.PORT) return Number(process.env.PORT);
  const envFile = path.join(APP_ROOT, '.env');
  if (fs.existsSync(envFile)) {
    const match = fs.readFileSync(envFile, 'utf8').match(/^PORT=(\d+)/m);
    if (match) return Number(match[1]);
  }
  return 5352;
}

function readVersion(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version;
  } catch {
    return null;
  }
}

function restartApp() {
  const result = pm2.describeApp() ? pm2.restart() : pm2.start();
  if (result.status !== 0) {
    console.warn(`⚠ PM2 reported an error restarting the app (exit ${result.status}) -- continuing to the health/version check below, which is the real verdict on whether this succeeded.`);
  }
}

function fetchJson(port, urlPath) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: urlPath, timeout: 3000 }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { resolve({ httpStatus: res.statusCode, body: JSON.parse(body) }); }
        catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

async function checkReadyAndVersion(port, expectedVersion) {
  const [ready, health] = await Promise.all([
    fetchJson(port, '/api/ready'),
    fetchJson(port, '/api/health'),
  ]);
  const readyOk = !!ready && ready.httpStatus === 200 && ready.body?.status !== 'not_ready';
  const servingVersion = health?.body?.version ?? null;
  const versionOk = !expectedVersion || servingVersion === expectedVersion;
  return { ok: readyOk && versionOk, readyStatus: ready?.body?.status, servingVersion, expectedVersion };
}

async function waitForHealthy(port, timeoutMs, expectedVersion) {
  const deadline = Date.now() + timeoutMs;
  let last = { ok: false };
  while (Date.now() < deadline) {
    last = await checkReadyAndVersion(port, expectedVersion);
    if (last.ok) return last;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return last;
}

async function main() {
  const arg = process.argv[2];
  const backups = listBackups();

  if (arg === 'list' || (!arg && !backups.length)) {
    if (!backups.length) { console.log('No backups available -- nothing to roll back to yet (a backup is created on every deploy).'); return; }
    console.log('Available backups (newest last):');
    for (const b of backups) console.log(`  ${b}`);
    if (!arg) console.log(`\nDefaulting to the most recent: ${backups[backups.length - 1]}. Pass a name to pick a different one.`);
    if (arg === 'list') return;
  }

  const target = arg && arg !== 'list' ? arg : backups[backups.length - 1];
  if (!backups.includes(target)) {
    console.error(`✗ No backup named "${target}". Run "node ops/rollback.js list" to see available ones.`);
    process.exit(1);
  }

  // Snapshot the current (about-to-be-replaced) state too, before
  // overwriting it -- if the rollback itself needs investigating, that
  // state isn't just gone.
  const entries = deployableEntries(APP_ROOT);
  const preRollbackName = `pre-rollback-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  console.log(`Snapshotting current state -> backups/${preRollbackName}/ before restoring...`);
  copyEntries(APP_ROOT, path.join(BACKUP_DIR, preRollbackName), entries);

  const targetVersion = readVersion(path.join(BACKUP_DIR, target));

  console.log(`\nRestoring backup: ${target}`);
  copyEntries(path.join(BACKUP_DIR, target), APP_ROOT, entries);
  console.log('✓ files restored');

  console.log('\nRestarting the app...');
  restartApp();

  const port = resolvePort();
  console.log(`Waiting for /api/ready on port ${port}, serving version ${targetVersion || '(unknown)'}...`);
  const result = await waitForHealthy(port, HEALTH_TIMEOUT_MS, targetVersion);
  if (result.ok) {
    console.log(`✓ Rollback complete -- running "${target}" and confirmed serving ${result.servingVersion} (status: ${result.readyStatus}).`);
  } else {
    const reason = result.servingVersion && result.servingVersion !== targetVersion
      ? `it's serving version ${result.servingVersion}, not the restored ${targetVersion} -- the restart didn't actually take effect (an old process is likely still running outside PM2's control)`
      : `it did not report healthy in time (last check: ${JSON.stringify(result)})`;
    console.error(`✗ Restored "${target}" but ${reason}. Check "npm run service:status" and "npm run logs:errors".`);
    process.exit(1);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
