// Builds and returns a fully configured Express app, without binding a
// port. Split out from index.js (which just requires this, calls
// `.listen()`, and wires process-level signal/crash handling) so tests can
// `supertest(require('./app'))` against a real, fully-wired app without a
// real socket.
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const compression = require('compression');
const pinoHttp = require('pino-http');

const config = require('./lib/config');
const logger = require('./lib/logger');
const metrics = require('./lib/metrics');
const { pool } = require('./lib/db');
const { AppError } = require('./lib/errors');
const auth = require('./lib/auth');
const scomSync = require('./lib/scomSync');

const serversRouter = require('./routes/servers');
const alertsRouter = require('./routes/alerts');
const dashboardRouter = require('./routes/dashboard');
const importRouter = require('./routes/importRoutes');
const reportsRouter = require('./routes/reports');
const scomRouter = require('./routes/scom');
const authRouter = require('./routes/auth');
const usersRouter = require('./routes/users');
const criticalRouter = require('./routes/critical');
const aiRouter = require('./routes/ai');
const analysisRouter = require('./routes/analysis');

const log = logger.forModule('http');

function buildApp() {
  const app = express();
  app.use(cors());
  app.use(compression());

  // Structured request/response access logging with a per-request
  // correlation id (X-Request-Id, also returned to the client so a bug
  // report can reference it).
  app.use(pinoHttp({
    logger: logger.base,
    genReqId: (req, res) => {
      const id = req.headers['x-request-id'] || require('crypto').randomUUID();
      res.setHeader('X-Request-Id', id);
      return id;
    },
    customLogLevel: (req, res, err) => {
      if (err || res.statusCode >= 500) return 'error';
      if (res.statusCode >= 400) return 'warn';
      return 'info';
    },
    // Never log request/response bodies -- login/scom-settings payloads
    // carry passwords, and nothing here needs body content for diagnosis.
    serializers: {
      req: (req) => ({ method: req.method, url: req.url, id: req.id }),
      res: (res) => ({ statusCode: res.statusCode }),
    },
  }));
  app.use(logger.requestContextMiddleware);
  app.use((req, res, next) => {
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
      metrics.recordRequest({ statusCode: res.statusCode, durationMs, method: req.method, path: req.path, requestId: req.id });
    });
    next();
  });

  app.use(express.json());

  // Liveness: the process is up and Express can respond. No dependency
  // checks -- must stay cheap and never fail just because the database is
  // slow.
  app.get('/api/health', (req, res) => {
    res.json({
      status: 'healthy',
      uptime: process.uptime(),
      pid: process.pid,
      timestamp: new Date().toISOString(),
      version: require('../package.json').version,
    });
  });

  // Readiness: can this instance actually serve real traffic right now.
  // 503 only for a failure nothing works without (the database); an
  // unconfigured/failed SCOM sync doesn't stop the dashboard/alerts/
  // reports from working, so that alone is "degraded", not "not ready".
  app.get('/api/ready', async (req, res) => {
    const checks = {};
    let overall = 'healthy';

    const dbStart = process.hrtime.bigint();
    try {
      await pool.query('SELECT 1');
      checks.database = { ok: true, latencyMs: Math.round(Number(process.hrtime.bigint() - dbStart) / 1e6) };
    } catch (err) {
      checks.database = { ok: false, error: err.message };
      overall = 'not_ready';
    }

    try {
      const settings = await scomSync.getSettings();
      const lastStatus = settings?.last_sync_status || null;
      checks.scomSync = { configured: scomSync.isConfigured(settings), lastStatus, lastSyncAt: settings?.last_sync_at || null };
      if (lastStatus === 'error' && overall === 'healthy') overall = 'degraded';
    } catch (err) {
      checks.scomSync = { ok: false, error: err.message };
    }

    const statusCode = overall === 'not_ready' ? 503 : 200;
    res.status(statusCode).json({ status: overall, checks });
  });

  app.use('/api/auth', authRouter);

  // Both roles can view servers/alerts/dashboard/reports/critical-watchlist;
  // only Admin can mutate inventory (handled per-route inside servers.js),
  // and only Admin can reach Configuration or Import Data at all.
  app.use('/api/servers', auth.requireAuth, serversRouter);
  app.use('/api/alerts', auth.requireAuth, alertsRouter);
  app.use('/api/dashboard', auth.requireAuth, dashboardRouter);
  app.use('/api/reports', auth.requireAuth, reportsRouter);
  app.use('/api/import', auth.requireAuth, auth.requireAdmin, importRouter);
  app.use('/api/scom', auth.requireAuth, auth.requireAdmin, scomRouter);
  app.use('/api/users', auth.requireAuth, auth.requireAdmin, usersRouter);
  app.use('/api/critical', auth.requireAuth, criticalRouter);
  app.use('/api/analysis', auth.requireAuth, analysisRouter);
  // Not all-admin -- GET /insights readable by any authenticated user
  // (Dashboard insights card), /settings/test/refresh are gated per-route
  // inside ai.js (requireAdmin).
  app.use('/api/ai', auth.requireAuth, aiRouter);

  app.get('/api/metrics', auth.requireAuth, auth.requireAdmin, (req, res) => {
    res.json(metrics.snapshot());
  });

  // Any /api/* path that fell through every router above is genuinely
  // unmatched -- respond JSON 404, not the SPA's index.html.
  app.use('/api', (req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  // Production mode: if a built client exists (created by `npm run build`),
  // serve it and fall back to index.html for client-side routes. In dev
  // mode `public/` doesn't exist yet -- the client runs on its own Vite dev
  // server instead.
  const publicDir = path.join(__dirname, '..', 'public');
  if (fs.existsSync(publicDir)) {
    // Vite content-hashes every filename under /assets -- safe to cache
    // those aggressively forever. index.html itself must stay uncached
    // (it's what references the current hashed filenames).
    app.use(express.static(publicDir, {
      setHeaders: (res, filePath) => {
        if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        }
      },
    }));
    app.get('*', (req, res) => res.sendFile(path.join(publicDir, 'index.html')));
  }

  // Centralized error handler -- registered last so it catches everything
  // above it. Always logs the full error server-side; only ever sends the
  // client a raw message when the error explicitly opted in via
  // `AppError({ expose: true })` (the default) -- anything else gets a
  // generic message plus `errorId` so a user can hand that id to an admin.
  app.use((err, req, res, next) => {
    const statusCode = err.statusCode || 500;
    const expose = err instanceof AppError && err.expose !== false;
    if (statusCode >= 500) {
      log.error({ err, requestId: req.id, method: req.method, path: req.path }, 'request failed');
      metrics.recordError(err, req.id);
    } else {
      log.warn({ requestId: req.id, method: req.method, path: req.path, statusCode, message: err.message }, 'request rejected');
    }
    res.status(statusCode).json(
      expose ? { error: err.message, errorId: req.id } : { error: 'Internal server error', errorId: req.id }
    );
  });

  return app;
}

module.exports = buildApp;
