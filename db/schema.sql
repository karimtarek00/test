-- SCOM Server Dashboard schema
-- Mirrors the Network Dashboard app's shape (see project brief) with servers/alerts
-- swapped in for devices/incidents, and a SCOM-specific resolution_state code.

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','viewer')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);

-- Servers = SCOM "Agents" / monitored computers.
-- normalized_key is the lesson-#1 dedupe key (trim+lowercase of the identity field).
CREATE TABLE IF NOT EXISTS servers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hostname TEXT NOT NULL,
  fqdn TEXT,
  normalized_key TEXT NOT NULL UNIQUE,
  os_type TEXT,
  environment TEXT,
  business_unit TEXT,
  data_center TEXT,
  is_critical INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','import','sync')),
  active INTEGER NOT NULL DEFAULT 1,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_servers_active ON servers(active);
CREATE INDEX IF NOT EXISTS idx_servers_critical ON servers(is_critical);

-- Alerts = SCOM Alerts. resolution_state is the raw SCOM 0-255 code
-- (0 = New, 255 = Closed, everything else is an in-progress state) - see brief S3.
CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scom_alert_id TEXT UNIQUE,
  server_id INTEGER REFERENCES servers(id) ON DELETE SET NULL,
  server_name_raw TEXT NOT NULL,
  alert_name TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('Critical','Warning','Information')),
  resolution_state INTEGER NOT NULL DEFAULT 0,
  resolution_state_label TEXT NOT NULL DEFAULT 'New',
  source TEXT,
  created_at TEXT NOT NULL,
  last_modified TEXT,
  resolved_at TEXT,
  imported_at TEXT NOT NULL DEFAULT (datetime('now')),
  origin TEXT NOT NULL DEFAULT 'import' CHECK (origin IN ('import','sync'))
);

CREATE INDEX IF NOT EXISTS idx_alerts_server ON alerts(server_id);
CREATE INDEX IF NOT EXISTS idx_alerts_severity ON alerts(severity);
CREATE INDEX IF NOT EXISTS idx_alerts_resolution_label ON alerts(resolution_state_label);
CREATE INDEX IF NOT EXISTS idx_alerts_created ON alerts(created_at);

CREATE TABLE IF NOT EXISTS import_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL CHECK (type IN ('servers','alerts_active','alerts_closed')),
  mode TEXT NOT NULL CHECK (mode IN ('full_replace','additive')),
  filename TEXT,
  rows_total INTEGER NOT NULL DEFAULT 0,
  rows_inserted INTEGER NOT NULL DEFAULT 0,
  rows_updated INTEGER NOT NULL DEFAULT 0,
  rows_skipped INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'completed',
  error TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Generic key/value settings store (SCOM SQL connection config, sync intervals, etc).
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
