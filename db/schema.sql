-- Server Watch (SCOM Server Dashboard) schema

CREATE TABLE IF NOT EXISTS servers (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  hostname        TEXT NOT NULL,
  fqdn            TEXT,
  -- Lesson learned #1 (project brief): every place that matches an incoming
  -- alert's server name against this table must compare a normalized key
  -- (trim + lowercase), never the raw string -- confirmed necessary against
  -- real SCOM data, where the same server shows up with inconsistent
  -- case/whitespace/FQDN-vs-short-hostname across different alert sources.
  normalized_key  TEXT UNIQUE NOT NULL,
  os_type         TEXT,
  environment     TEXT,
  business_unit   TEXT,
  -- Classification axis (equivalent of the NNMi app's SNMP/NON-SNMP split)
  -- is still open with the user -- data_center is what the sample data's
  -- hostname-prefix pattern suggested, kept generic/nullable so it doesn't
  -- force a decision before real inventory data confirms the right axis.
  data_center     TEXT,
  is_critical     INTEGER NOT NULL DEFAULT 0,
  source          TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','import','sync')),
  active          INTEGER NOT NULL DEFAULT 1,
  notes           TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_servers_active ON servers(active);
CREATE INDEX IF NOT EXISTS idx_servers_critical ON servers(is_critical);
CREATE INDEX IF NOT EXISTS idx_servers_data_center ON servers(data_center);

CREATE TABLE IF NOT EXISTS alerts (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  -- SCOM's own alert GUID, once the live SQL sync is wired up -- unique so
  -- an incremental sync tick can upsert by identity instead of duplicating.
  -- NULL for console-export imports, which carry no stable id.
  scom_alert_id           TEXT UNIQUE,
  server_id               INTEGER REFERENCES servers(id) ON DELETE SET NULL,
  server_name_raw         TEXT NOT NULL,
  alert_name              TEXT NOT NULL,
  severity                TEXT NOT NULL CHECK (severity IN ('Critical','Warning','Information')),
  -- SCOM's raw 0-255 ResolutionState code (0 = New, 255 = Closed, everything
  -- in between is an in-progress state) -- stored as an int, not a fixed
  -- enum, since the console export sample only showed New/Closed but SCOM's
  -- real range has more states (Acknowledged, Scheduled, etc.).
  resolution_state         INTEGER NOT NULL DEFAULT 0,
  resolution_state_label   TEXT NOT NULL DEFAULT 'New',
  source                  TEXT,
  created_at               TEXT NOT NULL,
  last_modified            TEXT,
  resolved_at               TEXT,
  imported_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  origin                   TEXT NOT NULL DEFAULT 'import' CHECK (origin IN ('import','sync'))
);
CREATE INDEX IF NOT EXISTS idx_alerts_server ON alerts(server_id);
CREATE INDEX IF NOT EXISTS idx_alerts_severity ON alerts(severity);
CREATE INDEX IF NOT EXISTS idx_alerts_resolution_label ON alerts(resolution_state_label);
CREATE INDEX IF NOT EXISTS idx_alerts_created ON alerts(created_at);

CREATE TABLE IF NOT EXISTS import_jobs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  filename        TEXT NOT NULL,
  import_type     TEXT NOT NULL,          -- 'servers' | 'alerts'
  total_rows      INTEGER NOT NULL DEFAULT 0,
  imported_rows   INTEGER NOT NULL DEFAULT 0,
  updated_rows    INTEGER NOT NULL DEFAULT 0,
  failed_rows     INTEGER NOT NULL DEFAULT 0,
  errors          TEXT NOT NULL DEFAULT '[]',
  status          TEXT NOT NULL DEFAULT 'completed',  -- 'completed' | 'failed' | 'partial'
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Single-row table holding the live SCOM SQL connection settings + last
-- sync status. Equivalent of the reference app's nnmi_settings.
CREATE TABLE IF NOT EXISTS scom_settings (
  id                          INTEGER PRIMARY KEY CHECK (id = 1),
  sql_host                    TEXT,
  sql_port                    INTEGER,
  sql_database                TEXT,
  sql_username                TEXT,
  sql_password                TEXT,
  enabled                     INTEGER NOT NULL DEFAULT 0,  -- auto-fetch (every 5 min, incremental) on/off
  last_sync_at                TEXT,
  last_sync_status            TEXT,
  last_sync_error             TEXT,
  last_sync_open_count        INTEGER,
  last_sync_new_count         INTEGER,
  last_sync_closed_count      INTEGER,
  last_sync_mode              TEXT,     -- 'full' | 'incremental'
  -- Only a 'full' sync (a genuinely complete fetch of every open alert) is
  -- ever allowed to detect and close alerts, per lesson learned #4 -- see
  -- scomSync.js. Runs independently of the 5-min incremental auto-fetch.
  -- 0 = disabled.
  full_sync_interval_minutes  INTEGER NOT NULL DEFAULT 30,
  updated_at                  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
INSERT OR IGNORE INTO scom_settings (id) VALUES (1);

-- Single-row table holding the internal-AI connection settings + cached
-- insight. Deliberately read-only in what it produces -- this integration
-- analyzes and predicts, it never writes back to servers/alerts.
CREATE TABLE IF NOT EXISTS ai_settings (
  id                  INTEGER PRIMARY KEY CHECK (id = 1),
  base_url            TEXT,
  api_key             TEXT,
  -- Header name the API key is sent in, e.g. 'Authorization' or a custom
  -- header some internal gateways use instead, e.g. 'X-API-Key'.
  auth_header         TEXT NOT NULL DEFAULT 'Authorization',
  -- Prefix placed before the key in auth_header's value, e.g. 'Bearer' for
  -- 'Authorization: Bearer <key>'. Blank means send the raw key with no
  -- prefix (some custom gateways expect that).
  auth_scheme         TEXT NOT NULL DEFAULT 'Bearer',
  -- Optional model identifier some internal gateways require in the request
  -- body (multi-model gateways). Left blank/omitted if not applicable.
  model               TEXT,
  -- An internal-only AI gateway is just as likely to sit behind a
  -- self-signed or internal-CA certificate as SCOM itself -- off by
  -- default, only meant to be switched on deliberately once that's
  -- confirmed to actually be the issue.
  allow_insecure_tls  INTEGER NOT NULL DEFAULT 0,
  enabled             INTEGER NOT NULL DEFAULT 0,
  last_test_at        TEXT,
  last_test_status    TEXT,   -- 'ok' | 'error'
  last_test_error     TEXT,
  -- Cached generated insight -- regenerating on every Dashboard load would
  -- mean a live LLM call per page view; this is cache-until-refresh.
  last_insight_text   TEXT,
  last_insight_at     TEXT,
  last_insight_error  TEXT,
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
INSERT OR IGNORE INTO ai_settings (id) VALUES (1);

-- Login accounts. Two roles: 'admin' (full access incl. Configuration and
-- Import Data) and 'viewer' (read-only). Passwords are salted + hashed with
-- scrypt -- see src/lib/auth.js. Default accounts seeded once in auth.js.
CREATE TABLE IF NOT EXISTS users (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  username        TEXT UNIQUE NOT NULL,
  password_hash   TEXT NOT NULL,
  role            TEXT NOT NULL CHECK (role IN ('admin','viewer')),
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);

-- keep updated_at fresh on server edits
DROP TRIGGER IF EXISTS trg_servers_updated_at;
CREATE TRIGGER trg_servers_updated_at
AFTER UPDATE ON servers
FOR EACH ROW
BEGIN
  UPDATE servers SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = OLD.id;
END;
