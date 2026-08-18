// Thin wrapper that always invokes the PM2 binary bundled inside this app's
// own node_modules (see PM2_BIN in paths.js) -- never a bare `pm2` command.
// PM2 ships as a regular dependency so `node ops/cli.js status` etc. work
// with zero network access and zero global install step.
const { spawnSync } = require('child_process');
const { ECOSYSTEM_FILE, APP_NAME, PM2_BIN } = require('./paths');

function run(args, opts = {}) {
  const result = spawnSync(process.execPath, [PM2_BIN, ...args], { stdio: opts.capture ? 'pipe' : 'inherit', encoding: 'utf8' });
  if (result.error) throw result.error;
  return result;
}

function isInstalled() {
  const result = spawnSync(process.execPath, [PM2_BIN, '--version'], { stdio: 'pipe' });
  return !result.error && result.status === 0;
}

function start() { return run(['start', ECOSYSTEM_FILE]); }
function restart() { return run(['restart', APP_NAME]); }
function stop() { return run(['stop', APP_NAME]); }
function status() { return run(['status']); }
function logs(follow = true) { return run(follow ? ['logs', APP_NAME] : ['logs', APP_NAME, '--lines', '50', '--nostream']); }
function save() { return run(['save']); }

// Machine-readable status for cli.js's `status` summary and deploy.js's
// health-gate -- `pm2 jlist` dumps every managed process as JSON.
function jlist() {
  const result = run(['jlist'], { capture: true });
  if (result.status !== 0) return [];
  try {
    return JSON.parse(result.stdout);
  } catch {
    return [];
  }
}

function describeApp() {
  return jlist().find((p) => p.name === APP_NAME) || null;
}

module.exports = { run, isInstalled, start, restart, stop, status, logs, save, jlist, describeApp };
