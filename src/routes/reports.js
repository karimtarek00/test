const express = require('express');
const { alertSummaryPdf } = require('../lib/reportGenerators');
const { asyncHandler } = require('../lib/errors');

const router = express.Router();

router.get('/summary.pdf', asyncHandler(async (req, res) => {
  await alertSummaryPdf(res);
}));

module.exports = router;
