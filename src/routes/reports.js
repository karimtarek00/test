const express = require('express');
const { alertSummaryPdf, alertsExportXlsx } = require('../lib/reportGenerators');
const { asyncHandler } = require('../lib/errors');

const router = express.Router();

router.get('/summary.pdf', asyncHandler(async (req, res) => {
  await alertSummaryPdf(res);
}));

router.get('/alerts.xlsx', asyncHandler(async (req, res) => {
  await alertsExportXlsx(res);
}));

module.exports = router;
