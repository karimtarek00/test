// Minimal in-process request metrics -- no Prometheus/StatsD dependency,
// just enough to answer "is this app healthy right now" from GET
// /api/metrics or the `status` CLI command: request volume, error rate, and
// response times. Deliberately not persisted across restarts -- PM2's own
// restart counter (`pm2 describe`) is the durable version of that number.
const startedAt = Date.now();
let totalRequests = 0;
const byStatusClass = { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 };
let errorCount = 0;
let lastError = null;
let totalDurationMs = 0;
let lastRequest = null;

function recordRequest({ statusCode, durationMs, method, path, requestId }) {
  totalRequests++;
  totalDurationMs += durationMs;
  const cls = `${Math.floor(statusCode / 100)}xx`;
  if (byStatusClass[cls] != null) byStatusClass[cls]++;
  lastRequest = { method, path, statusCode, durationMs, requestId, at: new Date().toISOString() };
}

function recordError(err, requestId) {
  errorCount++;
  lastError = {
    message: err?.message || String(err),
    requestId: requestId || null,
    at: new Date().toISOString(),
  };
}

function snapshot() {
  return {
    processStartedAt: new Date(startedAt).toISOString(),
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    requests: {
      total: totalRequests,
      byStatusClass,
      avgDurationMs: totalRequests ? Math.round((totalDurationMs / totalRequests) * 10) / 10 : 0,
      last: lastRequest,
    },
    errors: {
      total: errorCount,
      last: lastError,
    },
    process: {
      pid: process.pid,
      memory: process.memoryUsage(),
      cpu: process.cpuUsage(),
    },
  };
}

module.exports = { recordRequest, recordError, snapshot };
