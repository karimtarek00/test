import { Router } from 'express';
import multer from 'multer';
import { requireAdmin } from '../middleware/auth.js';
import { withWriteLock, run, all } from '../lib/db.js';
import { parseAlertsWorkbook, upsertAlerts, parseServersWorkbook, upsertServers } from '../lib/importPipeline.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
const router = Router();

function logImportJob({ type, mode, filename, result, userId }) {
  return withWriteLock(() =>
    run(
      `INSERT INTO import_jobs (type, mode, filename, rows_total, rows_inserted, rows_updated, rows_skipped, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [type, mode, filename, result.total || 0, result.inserted || 0, result.updated || 0, result.skipped || result.untagged || 0, userId],
    ),
  );
}

router.post('/alerts', requireAdmin, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const rows = parseAlertsWorkbook(req.file.buffer);
    const result = await upsertAlerts(rows, { origin: 'import' });
    const type = req.body?.alertsType === 'closed' ? 'alerts_closed' : 'alerts_active';
    await logImportJob({ type, mode: 'additive', filename: req.file.originalname, result, userId: req.user.id });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/servers', requireAdmin, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const mode = req.body?.mode === 'full_replace' ? 'full_replace' : 'additive';
  try {
    const rows = parseServersWorkbook(req.file.buffer);
    const result = await upsertServers(rows, { mode });
    await logImportJob({ type: 'servers', mode, filename: req.file.originalname, result, userId: req.user.id });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/jobs', requireAdmin, (req, res) => {
  const jobs = all('SELECT * FROM import_jobs ORDER BY created_at DESC LIMIT 50');
  res.json({ rows: jobs });
});

export default router;
