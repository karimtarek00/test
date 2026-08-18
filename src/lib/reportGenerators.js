// PDF report generation via pdfkit. The reference app also produces
// Word/Excel reports (docx/xlsx packages, already project dependencies) --
// deliberately not ported yet since no report layout has been requested for
// this app; PDF summary is the one report the SCOM app scaffold currently
// needs. Follows the same shape (a function per report that streams
// straight into the HTTP response) so a docx/xlsx generator can be added
// alongside this one later without restructuring routes/reports.js.
const PDFDocument = require('pdfkit');
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

module.exports = { alertSummaryPdf };
