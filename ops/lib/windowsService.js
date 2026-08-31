// Wraps the vendored NSSM binary + Windows' own `sc` command, mirroring
// lib/pm2.js's interface (isInstalled/start/stop/restart/describe) so
// cli.js can use either supervisor without its command handlers caring
// which one is actually in play. Only ever invoked on win32 -- callers must
// check that themselves (see cli.js's useWindowsService()).
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { APP_ROOT, LOG_DIR, NSSM_BIN, WINDOWS_SERVICE_NAME, NSSM_STDOUT_LOG, NSSM_STDERR_LOG } = require('./paths');

function isVendored() {
  return fs.existsSync(NSSM_BIN);
}

function runNssm(args) {
  return spawnSync(NSSM_BIN, args, { stdio: 'pipe', encoding: 'utf8' });
}

// `sc query <name>` exits 0 whether the service is running or stopped, and
// non-zero (1060, "service does not exist") if it was never installed --
// that distinction is what serviceExists() checks, separate from whether
// it's currently running.
function serviceExists(name = WINDOWS_SERVICE_NAME) {
  const result = spawnSync('sc', ['query', name], { stdio: 'pipe', encoding: 'utf8' });
  return !result.error && result.status === 0;
}

// Parses the STATE line out of `sc query` output, e.g.
// "        STATE              : 4  RUNNING" -> "RUNNING". Returns null if
// the service doesn't exist or `sc` itself couldn't run.
function describe(name = WINDOWS_SERVICE_NAME) {
  const result = spawnSync('sc', ['query', name], { stdio: 'pipe', encoding: 'utf8' });
  if (result.error || result.status !== 0) return null;
  const match = (result.stdout || '').match(/STATE\s*:\s*\d+\s+(\w+)/);
  return { name, state: match ? match[1] : 'UNKNOWN', raw: result.stdout };
}

function start(name = WINDOWS_SERVICE_NAME) {
  return spawnSync('sc', ['start', name], { stdio: 'inherit' });
}

function stop(name = WINDOWS_SERVICE_NAME) {
  return spawnSync('sc', ['stop', name], { stdio: 'inherit' });
}

// No atomic "restart" in `sc` -- stop, then start. The real protection
// against the resulting EADDRINUSE risk (OS hasn't released the port yet)
// is AppRestartDelay set at install time for NSSM's own crash-restart loop;
// this manual stop/start path waits a beat too, for the same reason.
function restart(name = WINDOWS_SERVICE_NAME) {
  stop(name);
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const d = describe(name);
    if (!d || d.state === 'STOPPED') break;
  }
  return start(name);
}

function remove(name = WINDOWS_SERVICE_NAME) {
  return runNssm(['remove', name, 'confirm']);
}

// Reads KEY=VALUE lines out of a .env file (if present) to pass through to
// the service's environment -- same file ops/setup.js already creates from
// .env.example, so this doesn't introduce a second place to configure
// PORT/etc. Skips blank lines and #-comments.
function readEnvFileVars() {
  const envPath = path.join(APP_ROOT, '.env');
  if (!fs.existsSync(envPath)) return [];
  return fs.readFileSync(envPath, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && l.includes('='));
}

// install() intentionally refuses to touch an already-installed service --
// reinstalling over one in place is exactly the kind of action that should
// require an explicit `sc delete` first, not happen implicitly on a re-run.
function install() {
  if (!isVendored()) {
    return { ok: false, error: `NSSM binary not found at ${NSSM_BIN}. See ops/vendor/README.md for how to get it.` };
  }
  if (serviceExists()) {
    return { ok: false, error: `Service "${WINDOWS_SERVICE_NAME}" already exists. Run "sc delete ${WINDOWS_SERVICE_NAME}" first if you want to reinstall it.` };
  }

  fs.mkdirSync(LOG_DIR, { recursive: true });

  const nodeExe = process.execPath;
  const distIndex = path.join(APP_ROOT, 'dist', 'index.js');

  // Install with ONLY the program path -- no trailing arguments here. NSSM's
  // `install <name> <program> [args...]` joins those trailing args into one
  // internal AppParameters string itself, and does NOT auto-quote any of
  // them -- a path containing a space (like an app folder named "Servers
  // Dashboard") comes out split in two, and the launched Node process then
  // fails with "Cannot find module" on the truncated first half. Setting
  // AppParameters explicitly afterward, as one value this code fully
  // controls (with the path quoted itself), avoids that entirely.
  let result = runNssm(['install', WINDOWS_SERVICE_NAME, nodeExe]);
  if (result.status !== 0) return { ok: false, error: `nssm install failed: ${result.stderr || result.stdout}` };

  const sets = [
    ['AppDirectory', APP_ROOT],
    ['AppParameters', `--max-old-space-size=4096 "${distIndex}"`],
    ['AppStdout', NSSM_STDOUT_LOG],
    ['AppStderr', NSSM_STDERR_LOG],
    // A real delay -- 0 risks EADDRINUSE if the OS hasn't released the
    // previous process's port yet when NSSM immediately restarts it.
    ['AppRestartDelay', '3000'],
    ['Start', 'SERVICE_AUTO_START'],
  ];
  const envLines = ['NODE_ENV=production', ...readEnvFileVars()];
  // NSSM takes AppEnvironmentExtra as one multi-line value (one VAR=val per
  // line) -- passed as a single argv entry here, not shell-joined, so no
  // quoting/escaping concerns the way a shell one-liner would have.
  sets.push(['AppEnvironmentExtra', envLines.join('\r\n')]);

  for (const [key, value] of sets) {
    result = runNssm(['set', WINDOWS_SERVICE_NAME, key, value]);
    if (result.status !== 0) return { ok: false, error: `nssm set ${key} failed: ${result.stderr || result.stdout}` };
  }

  return { ok: true, serviceName: WINDOWS_SERVICE_NAME };
}

module.exports = { isVendored, serviceExists, describe, start, stop, restart, remove, install };
