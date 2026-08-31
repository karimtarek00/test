const express = require('express');
const multer = require('multer');
const { pool, yieldToEventLoop, queryEachRow, withWriteLock } = require('../lib/db');
const { parseServerRows, parseAlertRows } = require('../lib/importParsers');
const { invalidateHealthScoreCache } = require('../lib/healthScore');
const { normalizeServerName } = require('../lib/serverNameMatch');
const { AppError, asyncHandler } = require('../lib/errors');
const logger = require('../lib/logger');

const log = logger.forModule('import');
const router = express.Router();
// 25MB headroom -- comfortably above a large SCOM Console export.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

// POST /api/import/servers  (multipart field "file", optional "mode": 'full_replace' | 'additive')
router.post('/servers', upload.single('file'), asyncHandler(async (req, res, next) => {
  if (!req.file) throw AppError.badRequest('No file uploaded');
  const mode = req.body.mode === 'full_replace' ? 'full_replace' : 'additive';

  await withWriteLock(async () => {
    const client = await pool.connect();
    try {
      const { parsed, errors, totalRows } = parseServerRows(req.file.buffer);
      let imported = 0, updated = 0, untagged = 0;

      const existingByKey = new Map();
      const existingRows = await client.query(`SELECT id, normalized_key FROM servers`);
      for (const r of existingRows.rows) existingByKey.set(r.normalized_key, r.id);

      await client.query('BEGIN');

      // Lesson learned #2: full-replace untags anything currently
      // import-sourced that's missing from a fresh authoritative upload,
      // rather than only ever growing. Manually-added servers (source =
      // 'manual') are exempt -- a full-replace upload shouldn't silently
      // deactivate a server an admin added by hand.
      if (mode === 'full_replace') {
        const newFileKeys = new Set(parsed.map((s) => normalizeServerName(s.fqdn || s.hostname)));
        const currentlyImported = await client.query(`SELECT id, normalized_key FROM servers WHERE source = 'import' AND active = 1`);
        let untagProcessed = 0;
        for (const r of currentlyImported.rows) {
          if (!newFileKeys.has(r.normalized_key)) {
            await client.query(`UPDATE servers SET active = 0 WHERE id = $1`, [r.id]);
            untagged++;
          }
          if (++untagProcessed % 200 === 0) await yieldToEventLoop();
        }
      }

      let processed = 0;
      for (const s of parsed) {
        const key = normalizeServerName(s.fqdn || s.hostname);
        if (existingByKey.has(key)) {
          await client.query(
            `UPDATE servers SET hostname=$1, fqdn=$2, os_type=$3, environment=$4, business_unit=$5,
               data_center=$6, is_critical=$7, source='import', active=1, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
             WHERE id=$8`,
            [s.hostname, s.fqdn, s.osType, s.environment, s.businessUnit, s.dataCenter, s.isCritical, existingByKey.get(key)]
          );
          updated++;
        } else {
          const created = await client.query(
            `INSERT INTO servers (hostname, fqdn, normalized_key, os_type, environment, business_unit, data_center, is_critical, source)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'import') RETURNING id`,
            [s.hostname, s.fqdn, key, s.osType, s.environment, s.businessUnit, s.dataCenter, s.isCritical]
          );
          existingByKey.set(key, created.rows[0].id);
          imported++;
        }
        if (++processed % 200 === 0) await yieldToEventLoop();
      }

      const status = errors.length === 0 ? 'completed' : (parsed.length === 0 ? 'failed' : 'partial');
      const jobRes = await client.query(
        `INSERT INTO import_jobs (filename, import_type, total_rows, imported_rows, updated_rows, failed_rows, errors, status)
         VALUES ($1,'servers',$2,$3,$4,$5,$6,$7) RETURNING *`,
        [req.file.originalname, totalRows, imported, updated, errors.length, JSON.stringify(errors.slice(0, 50)), status]
      );
      await client.query('COMMIT');
      invalidateHealthScoreCache();
      log.info({ filename: req.file.originalname, mode, totalRows, imported, updated, untagged, failed: errors.length }, 'server import completed');

      res.json({ job: jobRes.rows[0], summary: { totalRows, imported, updated, untagged, failed: errors.length }, errors: errors.slice(0, 50) });
    } catch (err) {
      await client.query('ROLLBACK');
      log.error({ err, filename: req.file?.originalname }, 'server import failed, rolled back');
      next(err);
    } finally {
      client.release();
    }
  });
}));

// POST /api/import/alerts  (multipart field "file", optional "alertsType": 'active' | 'closed')
router.post('/alerts', upload.single('file'), asyncHandler(async (req, res, next) => {
  if (!req.file) throw AppError.badRequest('No file uploaded');

  await withWriteLock(async () => {
    const client = await pool.connect();
    try {
      const { parsed, errors, totalRows } = parseAlertRows(req.file.buffer);
      let imported = 0;
      let duplicates = 0;

      // Re-exported "current alerts" snapshots typically re-list every
      // still-open alert, not just new ones -- the same alert can show up
      // in file after file. Dedupe on (server_name_raw, alert_name,
      // created_at) since a console export carries no stable alert GUID.
      const existingKeys = new Set();
      await queryEachRow(
        `SELECT (server_name_raw || '|' || alert_name || '|' || created_at) AS k FROM alerts`,
        [],
        (r) => existingKeys.add(r.k),
      );

      const serverRows = await client.query(`SELECT id, normalized_key FROM servers`);
      const serverIdByKey = new Map(serverRows.rows.map((s) => [s.normalized_key, s.id]));

      await client.query('BEGIN');
      let processed = 0;
      for (const a of parsed) {
        const createdAtIso = a.createdAt instanceof Date ? a.createdAt.toISOString() : a.createdAt;
        const key = `${a.serverNameRaw}|${a.alertName}|${createdAtIso}`;
        if (existingKeys.has(key)) { duplicates++; continue; }
        existingKeys.add(key);

        const serverId = serverIdByKey.get(normalizeServerName(a.serverNameRaw)) || null;
        // Console exports carry only one timestamp per alert -- no separate
        // "time resolved" column -- so a Closed row's created_at is the best
        // available approximation for resolved_at. Leaving it NULL would
        // permanently break any "resolved in the last N days" metric for
        // imported data, since that column would never be populated at all.
        const resolvedAtIso = a.resolutionStateLabel === 'Closed' ? createdAtIso : null;
        await client.query(
          `INSERT INTO alerts (server_id, server_name_raw, alert_name, severity, resolution_state, resolution_state_label, source, created_at, resolved_at, origin)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'import')`,
          [serverId, a.serverNameRaw, a.alertName, a.severity, a.resolutionState, a.resolutionStateLabel, a.source, createdAtIso, resolvedAtIso]
        );
        imported++;
        if (++processed % 200 === 0) await yieldToEventLoop();
      }

      const status = errors.length === 0 ? 'completed' : (parsed.length === 0 ? 'failed' : 'partial');
      const jobRes = await client.query(
        `INSERT INTO import_jobs (filename, import_type, total_rows, imported_rows, updated_rows, failed_rows, errors, status)
         VALUES ($1,'alerts',$2,$3,$4,$5,$6,$7) RETURNING *`,
        [req.file.originalname, totalRows, imported, duplicates, errors.length, JSON.stringify(errors.slice(0, 50)), status]
      );
      await client.query('COMMIT');
      invalidateHealthScoreCache();
      log.info({ filename: req.file.originalname, totalRows, imported, duplicates, failed: errors.length }, 'alert import completed');

      res.json({ job: jobRes.rows[0], summary: { totalRows, imported, duplicates, failed: errors.length }, errors: errors.slice(0, 50) });
    } catch (err) {
      await client.query('ROLLBACK');
      log.error({ err, filename: req.file?.originalname }, 'alert import failed, rolled back');
      next(err);
    } finally {
      client.release();
    }
  });
}));

router.get('/jobs', asyncHandler(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM import_jobs ORDER BY created_at DESC LIMIT 50');
  res.json({ jobs: rows });
}));

module.exports = router;
