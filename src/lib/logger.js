const { AsyncLocalStorage } = require('async_hooks');
const pino = require('pino');
const config = require('./config');

// Every log line is structured JSON (message + level + timestamp + whatever
// fields the caller merges in) so it's greppable/jq-able from the CLI and
// ingestible by a log platform later. In development, pipe through
// pino-pretty for a human to read at a terminal; in production, raw JSON
// straight to stdout -- PM2 captures stdout/stderr into logs/out.log and
// logs/error.log (see ecosystem.config.js) and ops/rotateLogs.js handles
// rotation, so this file only ever needs to write to stdout.
const transport = config.isProduction
  ? undefined
  : pino.transport({ target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } });

const base = pino({
  level: config.LOG_LEVEL,
  base: { pid: process.pid },
  timestamp: pino.stdTimeFunctions.isoTime,
}, transport);

// Holds { requestId } for the lifetime of a single request. Set by
// requestContextMiddleware below (after pino-http has assigned req.id), so
// any module deep in the call stack -- db.js, healthScore.js, scomSync.js,
// none of which receive a `req` object -- can still tag its log lines with
// the requestId of whatever HTTP request triggered them, without threading
// a logger/id through every function signature. Falls back to no requestId
// outside a request (startup, the auto-sync timer, graceful shutdown).
const requestContext = new AsyncLocalStorage();

function requestContextMiddleware(req, res, next) {
  requestContext.run({ requestId: req.id }, next);
}

// Child logger tagged with the owning module's name plus, when called from
// inside a request, that request's id -- the two fields an operator needs
// to answer "where did this come from" and "which request caused it".
function forModule(moduleName) {
  return {
    debug: (...args) => rebind(moduleName).debug(...args),
    info: (...args) => rebind(moduleName).info(...args),
    warn: (...args) => rebind(moduleName).warn(...args),
    error: (...args) => rebind(moduleName).error(...args),
    fatal: (...args) => rebind(moduleName).fatal(...args),
  };
}

function rebind(moduleName) {
  const store = requestContext.getStore();
  return base.child({ module: moduleName, ...(store?.requestId ? { requestId: store.requestId } : {}) });
}

function currentRequestId() {
  return requestContext.getStore()?.requestId || null;
}

module.exports = { base, forModule, requestContext, requestContextMiddleware, currentRequestId };
