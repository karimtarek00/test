import { Router } from 'express';
import { streamAlertSummaryPdf } from '../lib/reports.js';

const router = Router();

router.get('/summary.pdf', (req, res) => {
  streamAlertSummaryPdf(res);
});

export default router;
