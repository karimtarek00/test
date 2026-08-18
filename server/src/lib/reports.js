import PDFDocument from 'pdfkit';
import { all, get } from './db.js';

export function streamAlertSummaryPdf(res) {
  const doc = new PDFDocument({ margin: 50 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename="scom-alert-summary.pdf"');
  doc.pipe(res);

  const generatedAt = new Date().toLocaleString();
  doc.fontSize(20).text('SCOM Server Dashboard - Alert Summary', { align: 'left' });
  doc.fontSize(10).fillColor('#666').text(`Generated ${generatedAt}`);
  doc.moveDown(1.5);

  const severityCounts = all(
    `SELECT severity, COUNT(*) as count FROM alerts
     WHERE resolution_state_label != 'Closed' GROUP BY severity`,
  );
  const totalOpen = get(`SELECT COUNT(*) as count FROM alerts WHERE resolution_state_label != 'Closed'`).count;
  const totalServers = get(`SELECT COUNT(*) as count FROM servers WHERE active = 1`).count;

  doc.fillColor('#000').fontSize(14).text('Open Alerts by Severity');
  doc.fontSize(11);
  for (const row of severityCounts) {
    doc.text(`${row.severity}: ${row.count}`);
  }
  doc.moveDown(0.5);
  doc.text(`Total open alerts: ${totalOpen}`);
  doc.text(`Servers monitored: ${totalServers}`);
  doc.moveDown(1);

  const topServers = all(`
    SELECT s.hostname, COUNT(a.id) as alert_count
    FROM alerts a
    JOIN servers s ON s.id = a.server_id
    WHERE a.resolution_state_label != 'Closed'
    GROUP BY s.id
    ORDER BY alert_count DESC
    LIMIT 15
  `);

  doc.fontSize(14).text('Top Servers by Open Alert Count');
  doc.fontSize(11);
  if (topServers.length === 0) {
    doc.text('No matched servers yet - import the server inventory to populate this section.');
  }
  for (const row of topServers) {
    doc.text(`${row.hostname}: ${row.alert_count}`);
  }

  doc.end();
}
