import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { attachUser, requireAuth } from './middleware/auth.js';
import authRoutes from './routes/auth.js';
import dashboardRoutes from './routes/dashboard.js';
import alertsRoutes from './routes/alerts.js';
import serversRoutes from './routes/servers.js';
import importRoutes from './routes/importRoutes.js';
import reportsRoutes from './routes/reports.js';
import configRoutes from './routes/config.js';
import usersRoutes from './routes/users.js';
import criticalServersRoutes from './routes/criticalServers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, '..', '..');

let pkgVersion = '0.0.0';
try {
  pkgVersion = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8')).version;
} catch {
  // fall back to 0.0.0 if package.json is unreadable
}

export function createApp() {
  const app = express();

  app.use(express.json());
  app.use(cookieParser());
  app.use(attachUser);

  // Lesson learned #8: version is exposed on /api/health so ops/deploy.js's
  // health-gate can detect whether a new deploy actually took effect.
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', version: pkgVersion });
  });
  app.get('/api/ready', (req, res) => {
    res.json({ ready: true, version: pkgVersion });
  });

  app.use('/api/auth', authRoutes);
  app.use('/api/dashboard', requireAuth, dashboardRoutes);
  app.use('/api/alerts', requireAuth, alertsRoutes);
  app.use('/api/servers', requireAuth, serversRoutes);
  app.use('/api/critical-servers', requireAuth, criticalServersRoutes);
  app.use('/api/import', requireAuth, importRoutes);
  app.use('/api/reports', requireAuth, reportsRoutes);
  app.use('/api/config', requireAuth, configRoutes);
  app.use('/api/users', requireAuth, usersRoutes);

  if (process.env.NODE_ENV === 'production') {
    const distDir = path.join(rootDir, 'dist');
    app.use(express.static(distDir));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api/')) return next();
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  return app;
}

export { pkgVersion };
