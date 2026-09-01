// Thin process entrypoint: builds the app (src/app.js), binds a port, and
// owns everything that's specifically about being a real running process --
// startup/shutdown logging, crash handling, graceful shutdown, and a lock
// file that stops a second accidental `node dist/index.js` from ever
// running alongside the one PM2 is already supervising.
const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');

const config = require('./lib/config');
const logger = require('./lib/logger');

const log = logger.forModule('startup');

const LOCK_FILE = path.join(__dirname, '..', 'run.pid');

// Cheap bind-and-release probe, run before acquireLock()/opening the
// database at all -- so a doomed startup attempt costs nothing more than
// one quick socket check instead of a full SQLite connection + schema/
// ANALYZE run that then contends with whatever already holds the port.
function isPortFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', (err) => resolve(err.code !== 'EADDRINUSE'));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port);
  });
}

// True only if something is actually answering our own health endpoint on
// our configured port -- distinguishes "the previous instance is genuinely
// still running" from "the OS has reassigned that PID to something
// unrelated since".
function isOurAppServing(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 1500 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function acquireLock() {
  if (fs.existsSync(LOCK_FILE)) {
    const existingPid = Number(fs.readFileSync(LOCK_FILE, 'utf8').trim());
    if (existingPid && existingPid !== process.pid) {
      let pidAlive = false;
      try {
        process.kill(existingPid, 0);
        pidAlive = true;
      } catch {
        // ESRCH: no such process -- the previous instance crashed/was
        // killed without cleaning up its lock file. Stale, safe to take over.
      }

      if (pidAlive) {
        // A live PID alone isn't proof it's actually THIS app still
        // running -- PIDs get reused by the OS. The one thing that
        // actually distinguishes "still running" from "coincidentally
        // reused PID" is whether our own app is actually answering on our
        // own port.
        const stillServing = await isOurAppServing(config.PORT);
        if (stillServing) {
          log.fatal({ existingPid }, 'another instance is already running (run.pid) -- refusing to start a second one');
          process.exit(1);
        }
        log.warn({ existingPid, port: config.PORT }, 'run.pid names a live PID, but nothing of ours is answering on our port -- treating as a stale lock and taking over');
      } else {
        log.warn({ stalePid: existingPid }, 'found a stale lock file from a previous instance, taking over');
      }
    }
  }
  fs.writeFileSync(LOCK_FILE, String(process.pid));
}

function releaseLock() {
  try {
    if (fs.existsSync(LOCK_FILE) && Number(fs.readFileSync(LOCK_FILE, 'utf8').trim()) === process.pid) {
      fs.unlinkSync(LOCK_FILE);
    }
  } catch {
    // best-effort cleanup -- a leftover lock file is harmless noise.
  }
}

// pool/auth/scomSync are intentionally NOT required at the top of this file
// -- requiring './lib/db' opens a real connection to the SQLite file and
// runs schema/ANALYZE against it as a side effect of module load, and the
// same is true transitively for './app'. Deferred into main() below, after
// acquireLock() confirms we're actually meant to be the running instance --
// otherwise every refused startup attempt still opens its own extra
// connection to the live database file before exiting.
let pool = null;
let scomSync = null;

let server = null;
let shuttingDown = false;
function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, 'graceful shutdown starting');

  // Ask any in-flight sync to wind down rather than being killed mid-run.
  // Optional-chained since a signal can arrive before main() has required
  // scomSync (e.g. during the brief acquireLock() await).
  scomSync?.requestStop();

  const forceExitTimer = setTimeout(() => {
    log.warn('graceful shutdown timed out after 10s, forcing exit');
    process.exit(1);
  }, 10000);
  forceExitTimer.unref();

  const finish = (err) => {
    try {
      pool?.end();
    } catch (closeErr) {
      log.error({ err: closeErr }, 'error while closing database');
    }
    releaseLock();
    log.info('graceful shutdown complete');
    process.exit(err ? 1 : 0);
  };

  if (server && server.listening) {
    server.close((err) => {
      if (err) log.error({ err }, 'error while closing http server');
      finish(err);
    });
  } else {
    finish();
  }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Both indicate the process is in an unknown/possibly-corrupt state --
// logging full detail and then exiting is the safe choice, since PM2
// immediately restarts a fresh, known-good process.
process.on('uncaughtException', (err) => {
  log.fatal({ err }, 'uncaught exception -- shutting down for a clean restart');
  gracefulShutdown('uncaughtException');
});
process.on('unhandledRejection', (reason) => {
  log.fatal({ err: reason }, 'unhandled promise rejection -- shutting down for a clean restart');
  gracefulShutdown('unhandledRejection');
});

async function main() {
  if (!(await isPortFree(config.PORT))) {
    log.fatal({ port: config.PORT }, 'port already in use -- refusing to start (checked before opening the database, so this never contends with whatever already holds the port)');
    process.exit(1);
  }

  await acquireLock();

  // Only required now -- after the lock is confirmed ours -- since each of
  // these opens/queries the real SQLite database as a side effect of being
  // loaded.
  pool = require('./lib/db').pool;
  const auth = require('./lib/auth');
  scomSync = require('./lib/scomSync');
  const aiInsight = require('./lib/aiInsight');
  const buildApp = require('./app');

  const app = buildApp();
  server = app.listen(config.PORT, () => {
    log.info({ port: config.PORT, nodeEnv: config.NODE_ENV, pid: process.pid }, 'Server Watch app listening');
  });
  // Narrow remaining race: isPortFree() above and this actual bind aren't
  // atomic. Handling 'error' explicitly here gives one clear fatal log
  // instead of a confusing pileup, and still routes through
  // gracefulShutdown so the lock/database get released properly.
  server.on('error', (err) => {
    log.fatal({ err, port: config.PORT }, err.code === 'EADDRINUSE'
      ? 'port was taken between our startup probe and actually binding to it -- refusing to start'
      : 'failed to bind http server');
    gracefulShutdown('listen-error');
  });

  auth.seedDefaultUsers().catch((err) => log.error({ err }, 'failed to seed default users'));
  scomSync.resumeAutoFetchIfEnabled().catch((err) => log.error({ err }, 'failed to resume scom auto-fetch'));
  scomSync.resumeFullSync().catch((err) => log.error({ err }, 'failed to arm scheduled full sync'));
  aiInsight.resumeInsightAutoRefreshIfEnabled().catch((err) => log.error({ err }, 'failed to arm ai insight auto-refresh'));
}

main().catch((err) => {
  log.fatal({ err }, 'failed to start');
  process.exit(1);
});
