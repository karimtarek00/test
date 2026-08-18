import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, '..', '..', '..');
const dataDir = path.join(rootDir, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const dbPath = process.env.DB_PATH || path.join(dataDir, 'app.db');
export const db = new DatabaseSync(dbPath);

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

const schema = fs.readFileSync(path.join(rootDir, 'db', 'schema.sql'), 'utf8');
db.exec(schema);

export function all(sql, params = []) {
  return db.prepare(sql).all(...params);
}

export function get(sql, params = []) {
  return db.prepare(sql).get(...params);
}

export function run(sql, params = []) {
  return db.prepare(sql).run(...params);
}

// Lesson learned #6: node:sqlite is a single, process-local, synchronous
// connection. Every write path (imports, sync upserts, manual edits) must go
// through this serialized lock so a concurrent import and a sync tick can't
// interleave transactions on the same connection.
let writeQueue = Promise.resolve();

export function withWriteLock(fn) {
  const result = writeQueue.then(() => fn());
  writeQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export function transaction(fn) {
  return withWriteLock(() => {
    db.exec('BEGIN');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  });
}
