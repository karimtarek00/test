const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

const dbPath = config.SQLITE_PATH;
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new DatabaseSync(dbPath);
// Without this, a second OS process that briefly opens this same file while
// another connection holds the write lock gets an immediate "database is
// locked" failure (SQLite's busy_timeout defaults to 0) instead of quietly
// waiting for the lock to clear -- matters most during a stuck PM2 restart
// loop, where every failed attempt still opens its own connection and
// contends with the real running instance's writes before hitting index.js's
// port-free check and exiting.
db.exec('PRAGMA busy_timeout = 5000');
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
// NORMAL is the standard pairing with WAL: still fsyncs at checkpoints, just
// not after every single write like FULL does.
db.exec('PRAGMA synchronous = NORMAL');
// Bigger page cache than SQLite's ~2MB default -- dashboard/report queries
// repeatedly rescan the same hot pages as the alerts table grows.
db.exec('PRAGMA cache_size = -64000');
db.exec('PRAGMA mmap_size = 268435456');

// A database created before scom_settings switched access methods (direct
// SQL -> local PowerShell module -> WinRM Invoke-Command) won't have these
// columns, and schema.sql's CREATE TABLE IF NOT EXISTS is a no-op against an
// existing table -- add them here first if missing. Old columns from
// earlier approaches (sql_*) are deliberately left in place rather than
// dropped: harmless orphaned columns are a much smaller risk than a DROP
// COLUMN on a production database this app doesn't otherwise need to touch.
const scomSettingsTableExists = !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='scom_settings'").get();
if (scomSettingsTableExists) {
  const scomSettingsCols = db.prepare('PRAGMA table_info(scom_settings)').all().map((c) => c.name);
  if (!scomSettingsCols.includes('management_server')) {
    db.exec('ALTER TABLE scom_settings ADD COLUMN management_server TEXT');
  }
  if (!scomSettingsCols.includes('winrm_username')) {
    db.exec('ALTER TABLE scom_settings ADD COLUMN winrm_username TEXT');
  }
  if (!scomSettingsCols.includes('winrm_password')) {
    db.exec('ALTER TABLE scom_settings ADD COLUMN winrm_password TEXT');
  }
}

const alertsTableExists = !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='alerts'").get();
if (alertsTableExists) {
  const alertsCols = db.prepare('PRAGMA table_info(alerts)').all().map((c) => c.name);
  if (!alertsCols.includes('priority')) {
    db.exec('ALTER TABLE alerts ADD COLUMN priority TEXT');
  }
  if (!alertsCols.includes('repeat_count')) {
    db.exec('ALTER TABLE alerts ADD COLUMN repeat_count INTEGER');
  }
  if (!alertsCols.includes('in_maintenance_mode')) {
    db.exec('ALTER TABLE alerts ADD COLUMN in_maintenance_mode INTEGER NOT NULL DEFAULT 0');
  }
}

// Zero-setup: apply the schema on first run (and no-op on every run after,
// since every statement in schema.sql is CREATE ... IF NOT EXISTS).
const schemaPath = path.join(__dirname, '..', '..', 'db', 'schema.sql');
db.exec(fs.readFileSync(schemaPath, 'utf8'));

// Refreshes the query planner's row-distribution statistics on every boot --
// cheap at this app's current scale, and avoids a stale-statistics query
// plan after a large import/sync changes the data shape.
db.exec('ANALYZE');

// A thin pg-compatible shim over node:sqlite, so route/lib code can use
// `pool.query(sql, params)` / `await pool.connect()` exactly like the `pg`
// API. Translates $1,$2.. placeholders to SQLite's ?1,?2 (same
// repeat-binding semantics as Postgres), strips harmless Postgres type
// casts, and normalizes params (Date -> ISO string, undefined -> null).
//
// Built on Node's built-in `node:sqlite` instead of the `better-sqlite3`
// native module -- avoids requiring a C++ toolchain just to install
// dependencies on a target machine with no internet access.
function toSqlite(sql) {
  return sql
    .replace(/\$(\d+)/g, '?$1')
    .replace(/::(int|integer|float|numeric|bool|boolean|text)\b/gi, '');
}

// Turns a date-only "YYYY-MM-DD" filter value into an inclusive end-of-day
// bound matching how timestamps are actually stored (full ISO 8601 with a
// 'T' separator). Naively appending " 23:59:59" sorts BEFORE any real
// timestamp on that day in a plain string comparison (' ' < 'T' in ASCII).
function endOfDay(dateOnly) {
  return `${dateOnly}T23:59:59.999Z`;
}

function normalizeParams(params) {
  return params.map((p) => {
    if (p instanceof Date) return p.toISOString();
    if (p === undefined) return null;
    return p;
  });
}

// node:sqlite's db.prepare() parses/compiles the SQL text, which is wasted
// work when the exact same statement runs many times in a row (an import
// loop) -- cache compiled statements by their translated SQL text.
const stmtCache = new Map();
function prepareCached(sqliteSql) {
  let stmt = stmtCache.get(sqliteSql);
  if (!stmt) {
    stmt = db.prepare(sqliteSql);
    stmtCache.set(sqliteSql, stmt);
  }
  return stmt;
}

function run(sql, params = []) {
  const sqliteSql = toSqlite(sql);
  const bound = normalizeParams(params);
  const isControl = /^\s*(BEGIN|COMMIT|ROLLBACK)\s*$/i.test(sql.trim());
  if (isControl) {
    db.exec(sql.trim().toUpperCase());
    return { rows: [], rowCount: 0 };
  }
  const stmt = prepareCached(sqliteSql);
  const returnsRows = /^\s*(SELECT|WITH)/i.test(sql) || /\bRETURNING\b/i.test(sql);
  if (returnsRows) {
    const rows = stmt.all(...bound);
    return { rows, rowCount: rows.length };
  }
  const info = stmt.run(...bound);
  return { rows: [], rowCount: info.changes, lastInsertRowid: info.lastInsertRowid };
}

const pool = {
  query: (sql, params) => Promise.resolve(run(sql, params)),
  connect: () => Promise.resolve({
    query: (sql, params) => Promise.resolve(run(sql, params)),
    release: () => {},
  }),
  exec: (sql) => db.exec(sql),
  end: () => {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.close();
  },
};

// node:sqlite's UNIQUE-constraint error looks nothing like Postgres's --
// it's `err.code === 'ERR_SQLITE_ERROR'` with `err.message` containing
// "UNIQUE constraint failed". Centralized here so every route that wants a
// friendly 409 instead of a raw 500 checks the same way.
function isUniqueViolation(err) {
  return err?.code === 'ERR_SQLITE_ERROR' && /UNIQUE constraint failed/.test(err.message || '');
}

// `pool.query` above is a synchronous node:sqlite call wrapped in an
// already-resolved Promise -- awaiting it only defers to the microtask
// queue. A loop that awaits thousands of these in a row (a large import)
// would block the entire server for the whole loop's duration otherwise.
// setImmediate genuinely defers to the next event loop iteration, giving
// Express a chance to serve other pending connections in between batches.
function yieldToEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

// Reads a large SELECT's rows one at a time via node:sqlite's
// stmt.iterate() (a real cursor, unlike stmt.all() which materializes every
// row in one synchronous call) so a table-wide scan can yield to the event
// loop periodically. Used for the "load existing rows to dedupe/upsert
// against" pattern (import routes, sync).
async function queryEachRow(sql, params, onRow, yieldEvery = 5000) {
  const sqliteSql = toSqlite(sql);
  const bound = normalizeParams(params || []);
  // Deliberately NOT prepareCached() here -- stmt.iterate() returns a paused
  // generator resumed across `await yieldToEventLoop()` boundaries; a
  // statement shared via the cache is a single mutable cursor that
  // node:sqlite invalidates the instant anything else touches it, which can
  // surface as "iterator was invalidated" errors under concurrent requests.
  const stmt = db.prepare(sqliteSql);
  let i = 0;
  for (const row of stmt.iterate(...bound)) {
    onRow(row);
    if (++i % yieldEvery === 0) await yieldToEventLoop();
  }
}

// pool.connect() doesn't hand out a real separate connection -- node:sqlite
// only has one. A BEGIN...COMMIT transaction that yields to the event loop
// partway through is no longer atomic from the process's point of view: a
// second concurrent transactional write can get its own BEGIN interleaved
// into the first one's still-open transaction (SQLite rejects the second
// BEGIN, and the first writer's later COMMIT then fails too). withWriteLock
// serializes only the transactional write sections so at most one is ever
// mid-transaction at a time -- a second one queues instead of interleaving.
// Plain reads never take this lock and stay fully concurrent/responsive
// during a long write.
let writeLockTail = Promise.resolve();
function withWriteLock(fn) {
  const result = writeLockTail.then(fn, fn);
  writeLockTail = result.then(() => {}, () => {});
  return result;
}

module.exports = { pool, yieldToEventLoop, queryEachRow, withWriteLock, endOfDay, isUniqueViolation };
