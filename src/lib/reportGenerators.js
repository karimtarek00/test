// PDF report generation via pdfkit, plus a raw-data Excel export via xlsx
// (already a project dependency for the Import Data side). Each report is
// a function that streams straight into the HTTP response, so this can
// grow with more report types without restructuring routes/reports.js.
const PDFDocument = require('pdfkit');
const XLSX = require('xlsx');
const { pool } = require('./db');

async function alertSummaryPdf(res) {
  const doc = new PDFDocument({ margin: 50 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename="server-watch-alert-summary.pdf"');
  doc.pipe(res);

  doc.fontSize(20).text('Server Watch - Alert Summary', { align: 'left' });
  doc.fontSize(10).fillColor('#666').text(`Generated ${new Date().toLocaleString()}`);
  doc.moveDown(1.5);

  const { rows: severityCounts } = await pool.query(
    `SELECT severity, COUNT(*)::int AS count FROM alerts WHERE resolution_state_label != 'Closed' GROUP BY severity`
  );
  const { rows: [{ count: totalOpen }] } = await pool.query(
    `SELECT COUNT(*)::int AS count FROM alerts WHERE resolution_state_label != 'Closed'`
  );
  const { rows: [{ count: totalServers }] } = await pool.query(`SELECT COUNT(*)::int AS count FROM servers WHERE active = 1`);

  doc.fillColor('#000').fontSize(14).text('Open Alerts by Severity');
  doc.fontSize(11);
  for (const row of severityCounts) doc.text(`${row.severity}: ${row.count}`);
  doc.moveDown(0.5);
  doc.text(`Total open alerts: ${totalOpen}`);
  doc.text(`Servers monitored: ${totalServers}`);
  doc.moveDown(1);

  const { rows: topServers } = await pool.query(`
    SELECT s.hostname, COUNT(a.id)::int AS alert_count
    FROM alerts a JOIN servers s ON s.id = a.server_id
    WHERE a.resolution_state_label != 'Closed'
    GROUP BY s.id
    ORDER BY alert_count DESC
    LIMIT 15
  `);

  doc.fontSize(14).text('Top Servers by Open Alert Count');
  doc.fontSize(11);
  if (topServers.length === 0) doc.text('No matched servers yet -- import the server inventory to populate this section.');
  for (const row of topServers) doc.text(`${row.hostname}: ${row.alert_count}`);

  doc.end();
}

// Every alert, every column, no pagination -- the point of this export is
// a complete raw dataset to analyze externally (or feed to the AI chat as
// reference context), not a formatted report. Timestamps are left as the
// same ISO strings stored in the DB rather than reformatted, so the file
// re-imports cleanly and sorts correctly in Excel.
async function alertsExportXlsx(res) {
  const { rows } = await pool.query(`
    SELECT
      a.scom_alert_id     AS "SCOM Alert ID",
      a.severity          AS "Severity",
      a.alert_name        AS "Alert Name",
      COALESCE(s.hostname, a.server_name_raw) AS "Server",
      a.source            AS "Source Detail",
      a.resolution_state_label AS "Resolution State",
      a.priority          AS "Priority",
      a.repeat_count      AS "Repeat Count",
      CASE WHEN a.in_maintenance_mode = 1 THEN 'Yes' ELSE 'No' END AS "In Maintenance Mode",
      a.created_at        AS "Created At",
      a.last_modified     AS "Last Modified",
      a.resolved_at       AS "Resolved At",
      a.origin            AS "Origin"
    FROM alerts a LEFT JOIN servers s ON s.id = a.server_id
    ORDER BY a.created_at DESC
  `);

  // json_to_sheet silently drops any column that's null/undefined across
  // every row instead of writing an empty cell -- confirmed by testing
  // against this app's own seed data, where scom_alert_id/priority/
  // repeat_count/last_modified are null for every imported row (only a
  // live SCOM sync populates them) and vanished from the sheet entirely
  // without an explicit header. Pinning the header guarantees a consistent
  // set of columns regardless of which fields happen to be null right now.
  const HEADER = [
    'SCOM Alert ID', 'Severity', 'Alert Name', 'Server', 'Source Detail',
    'Resolution State', 'Priority', 'Repeat Count', 'In Maintenance Mode',
    'Created At', 'Last Modified', 'Resolved At', 'Origin',
  ];
  const sheet = XLSX.utils.json_to_sheet(rows, { header: HEADER });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet, 'Alerts');
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="server-watch-alerts-export-${new Date().toISOString().slice(0, 10)}.xlsx"`);
  res.send(buffer);
}

module.exports = { alertSummaryPdf, alertsExportXlsx };
