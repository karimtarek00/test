#!/usr/bin/env node
// Deploys a new build without ever manually unzipping a bundle and running
// `node dist/index.js`: extract -> validate (tests) -> snapshot the
// current version -> swap in the new one -> restart under PM2 -> health-gate
// -> automatically roll back if the new version doesn't come up healthy.
//
// Usage: node ops/deploy.js <path-to-bundle.zip-or-directory>
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const { spawnSync } = require('child_process');
const AdmZip = require('adm-zip');

const { APP_ROOT, BACKUP_DIR } = require('./lib/paths');
const { deployableEntries, copyEntries } = require('./lib/sync');
const pm2 = require('./lib/pm2');

// A schema/index change that needs a one-time migration on an existing
// database runs synchronously at boot, before the server starts accepting
// connections at all -- this timeout has headroom for that, not just an
// ordinary restart (well under a second with no pending migration).
const HEALTH_TIMEOUT_MS = 180000;
const HEALTH_POLL_INTERVAL_MS = 1000;
const BACKUP_RETENTION = 5;

function fail(message) {
  console.error(`\n✗ Deploy failed: ${message}`);
  process.exit(1);
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

function extractIfZip(sourcePath) {
  const stat = fs.statSync(sourcePath);
  if (stat.isDirectory()) return sourcePath;
  if (!sourcePath.endsWith('.zip')) fail(`${sourcePath} is neither a directory nor a .zip file.`);

  const staging = path.join(os.tmpdir(), `server-watch-deploy-${crypto.randomBytes(6).toString('hex')}`);
  console.log(`Extracting ${sourcePath} -> ${staging}`);
  new AdmZip(sourcePath).extractAllTo(staging, true);
  return staging;
}

function validateStaging(staging) {
  const distIndex = path.join(staging, 'dist', 'index.js');
  const pkgJson = path.join(staging, 'package.json');
  if (!fs.existsSync(distIndex)) fail(`${distIndex} not found -- this doesn't look like a built app bundle (run "npm run build" before packaging it).`);
  if (!fs.existsSync(pkgJson)) fail(`${pkgJson} not found.`);
  console.log('✓ bundle looks valid (dist/index.js, package.json present)');
}

function runTests(staging) {
  const testDir = path.join(staging, 'test');
  if (!fs.existsSync(testDir)) {
    console.log('⚠ no test/ directory in this bundle -- skipping the test gate (nothing to run).');
    return;
  }
  console.log('\nRunning automated tests against the new build...');
  const result = spawnSync(process.execPath, ['--test'], { cwd: staging, stdio: 'inherit' });
  if (result.status !== 0) fail('automated tests failed -- see output above. The current version was left untouched.');
  console.log('✓ tests passed');
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

// A passing /api/ready alone isn't proof the NEW version is what's actually
// serving -- a healthy process serving the WRONG version is exactly as much
// a failure as an unhealthy one. Comparing /api/health's reported `version`
// against the version actually being deployed catches that.
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
    await new Promise((r) => setTimeout(r, HEALTH_POLL_INTERVAL_MS));
  }
  return last;
}

function pruneOldBackups() {
  const backups = fs.readdirSync(BACKUP_DIR).filter((n) => fs.statSync(path.join(BACKUP_DIR, n)).isDirectory()).sort();
  const toRemove = backups.slice(0, Math.max(0, backups.length - BACKUP_RETENTION));
  for (const name of toRemove) {
    fs.rmSync(path.join(BACKUP_DIR, name), { recursive: true, force: true });
    console.log(`  pruned old backup: ${name}`);
  }
}

async function main() {
  const source = process.argv[2];
  if (!source) {
    console.log('Usage: node ops/deploy.js <path-to-bundle.zip-or-directory>');
    process.exit(1);
  }
  if (!fs.existsSync(source)) fail(`${source} does not exist.`);

  const staging = extractIfZip(path.resolve(source));
  validateStaging(staging);
  runTests(staging);

  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const backupName = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(BACKUP_DIR, backupName);
  const entries = deployableEntries(APP_ROOT);
  console.log(`\nSnapshotting current version -> backups/${backupName}/ (${entries.join(', ')})`);
  copyEntries(APP_ROOT, backupPath, entries);
  console.log('✓ backup created -- this is what a rollback would restore');

  const newVersion = readVersion(staging);
  const previousVersion = readVersion(APP_ROOT);

  console.log('\nSwapping in the new version...');
  const stagingEntries = deployableEntries(staging);
  copyEntries(staging, APP_ROOT, stagingEntries);
  console.log('✓ new version copied into place');

  console.log('\nRestarting the app...');
  restartApp();

  const port = resolvePort();
  console.log(`\nWaiting for /api/ready on port ${port}, serving version ${newVersion || '(unknown)'} (up to ${HEALTH_TIMEOUT_MS / 1000}s)...`);
  const result = await waitForHealthy(port, HEALTH_TIMEOUT_MS, newVersion);

  if (result.ok) {
    console.log(`✓ new version is healthy and confirmed serving ${result.servingVersion} (status: ${result.readyStatus})`);
    pruneOldBackups();
    console.log('\n✓ Deploy complete.');
    return;
  }

  const reason = result.servingVersion && result.servingVersion !== newVersion
    ? `it's serving version ${result.servingVersion}, not the deployed ${newVersion} -- the restart didn't actually take effect (an old process is likely still running)`
    : `never became ready (last check: ${JSON.stringify(result)})`;
  console.error(`\n✗ New version did not come up correctly: ${reason}.`);
  console.error('Automatically rolling back to the previous version...');
  copyEntries(backupPath, APP_ROOT, entries);
  restartApp();
  const rollbackResult = await waitForHealthy(port, HEALTH_TIMEOUT_MS, previousVersion);
  if (rollbackResult.ok) {
    console.error(`✓ rolled back successfully -- the previous version (${rollbackResult.servingVersion}) is running and healthy again.`);
  } else {
    console.error(`✗ rollback also did not come up correctly (last check: ${JSON.stringify(rollbackResult)}) -- check "npm run service:status" and "npm run logs:errors" immediately.`);
  }
  process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
