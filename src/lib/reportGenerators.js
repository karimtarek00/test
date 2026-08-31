// Report generation for the Reports page: three report types (inventory,
// alerts, summary) each exportable as PDF, Word (.docx), or Excel (.xlsx).
//
// Split deliberately into two layers:
//   1. build*Model() -- pure data-fetching, returns a plain {title, subtitle,
//      sections:[...]} object. No response object touched here, so a
//      generation failure (bad query, etc.) can be caught and logged to
//      report_jobs BEFORE any bytes are written to the client.
//   2. render*(model, res, filename) -- pure serialization of that model
//      into one export format. Adding a fourth report type never means
//      touching the renderers, and fixing a renderer never means touching
//      a query.
//
// The three correctness rules from the add-on brief live entirely in the
// model builders (rangedAlertsWhere / orgTime), not the renderers:
//   1. from/to are interpreted as the org's local time (orgTime), not UTC.
//   2. daily trend is bucketed by local calendar day (sqlLocalDay), not UTC.
//   3. a ranged query never filters on resolution_state_label -- a report
//      about a past window must show everything that happened in it, not
//      just what's still open today.
const PDFDocument = require('pdfkit');
const XLSX = require('xlsx');
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType,
} = require('docx');
const { pool } = require('./db');
const { AppError } = require('./errors');
const { localDateStartToUtcIso, localDateEndToUtcIso, sqlLocalDay, formatLocal } = require('./orgTime');

const BRAND_NAME = 'SERVER WATCH';
const BRAND_TAGLINE = 'SCOM Server Monitoring';
const BRAND_HEX = '2684ff'; // matches the app's own --info accent color

function describeRange(from, to) {
  if (!from && !to) return 'All time';
  if (from && to) return `${from} to ${to} (local time)`;
  if (from) return `From ${from} (local time)`;
  return `Through ${to} (local time)`;
}

// Shared WHERE-builder for the two ranged report types (alerts, summary).
// Deliberately does NOT filter on resolution_state_label -- see rule #3
// above.
function rangedAlertsWhere({ from, to, severity, server, alertName } = {}) {
  const where = [];
  const values = [];
  if (from) { values.push(localDateStartToUtcIso(from)); where.push(`a.created_at >= $${values.length}`); }
  if (to) { values.push(localDateEndToUtcIso(to)); where.push(`a.created_at <= $${values.length}`); }
  if (severity) { values.push(severity); where.push(`a.severity = $${values.length}`); }
  if (server) { values.push(`%${server}%`); where.push(`COALESCE(s.hostname, a.server_name_raw) LIKE $${values.length}`); }
  if (alertName) { values.push(alertName); where.push(`a.alert_name = $${values.length}`); }
  return { whereSql: where.length ? `WHERE ${where.join(' AND ')}` : '', values };
}

async function buildInventoryModel() {
  const { rows } = await pool.query(`
    SELECT hostname, fqdn, os_type, environment, business_unit, data_center,
           is_critical, active, source, notes, created_at
    FROM servers ORDER BY hostname ASC
  `);
  return {
    reportType: 'inventory',
    title: 'Server Inventory',
    subtitle: `Point-in-time listing of all monitored servers (${rows.length})`,
    generatedAtLocal: formatLocal(new Date().toISOString()),
    sections: [{
      type: 'table',
      title: 'Servers',
      columns: ['Hostname', 'FQDN', 'OS Type', 'Environment', 'Business Unit', 'Data Center', 'Critical', 'Active', 'Source', 'Added On', 'Notes'],
      rows: rows.map((r) => [
        r.hostname, r.fqdn || '', r.os_type || '', r.environment || '', r.business_unit || '',
        r.data_center || '', r.is_critical ? 'Yes' : 'No', r.active ? 'Yes' : 'No', r.source,
        formatLocal(r.created_at), r.notes || '',
      ]),
    }],
  };
}

async function buildAlertsModel(params = {}) {
  const { whereSql, values } = rangedAlertsWhere(params);
  const { rows } = await pool.query(`
    SELECT a.alert_name, COALESCE(s.hostname, a.server_name_raw) AS server, a.severity,
           a.resolution_state_label, a.priority, a.repeat_count, a.source,
           a.created_at, a.resolved_at
    FROM alerts a LEFT JOIN servers s ON s.id = a.server_id
    ${whereSql}
    ORDER BY a.created_at DESC
  `, values);
  return {
    reportType: 'alerts',
    title: 'Alerts Report',
    subtitle: describeRange(params.from, params.to),
    generatedAtLocal: formatLocal(new Date().toISOString()),
    sections: [{
      type: 'table',
      title: `Alerts (${rows.length})`,
      columns: ['Alert Name', 'Server', 'Severity', 'Resolution State', 'Priority', 'Repeat Count', 'Source Detail', 'Created At', 'Resolved At'],
      rows: rows.map((r) => [
        r.alert_name, r.server, r.severity, r.resolution_state_label, r.priority || '',
        r.repeat_count ?? '', r.source || '', formatLocal(r.created_at), formatLocal(r.resolved_at),
      ]),
    }],
  };
}

async function buildSummaryModel(params = {}) {
  const { whereSql, values } = rangedAlertsWhere(params);
  const JOIN = `FROM alerts a LEFT JOIN servers s ON s.id = a.server_id`;
  const [totalRow, severityRows, topAlarmTypes, topServers, resolutionRows, dailyRows] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int AS c ${JOIN} ${whereSql}`, values),
    pool.query(`SELECT a.severity AS severity, COUNT(*)::int AS c ${JOIN} ${whereSql} GROUP BY a.severity ORDER BY c DESC`, values),
    pool.query(`SELECT a.alert_name AS name, COUNT(*)::int AS c ${JOIN} ${whereSql} GROUP BY a.alert_name ORDER BY c DESC LIMIT 10`, values),
    pool.query(`SELECT COALESCE(s.hostname, a.server_name_raw) AS name, COUNT(*)::int AS c ${JOIN} ${whereSql} GROUP BY name ORDER BY c DESC LIMIT 10`, values),
    pool.query(`SELECT a.resolution_state_label AS label, COUNT(*)::int AS c ${JOIN} ${whereSql} GROUP BY label ORDER BY c DESC`, values),
    // Local-calendar-day bucketing (rule #2) -- NOT a raw date(created_at).
    pool.query(`SELECT ${sqlLocalDay('a.created_at')} AS day, COUNT(*)::int AS c ${JOIN} ${whereSql} GROUP BY day ORDER BY day ASC`, values),
  ]);

  return {
    reportType: 'summary',
    title: 'Alert Summary Report',
    subtitle: describeRange(params.from, params.to),
    generatedAtLocal: formatLocal(new Date().toISOString()),
    sections: [
      {
        type: 'kv',
        title: 'Totals',
        items: [
          { label: 'Total Alerts', value: String(totalRow.rows[0].c) },
          ...severityRows.rows.map((r) => ({ label: `${r.severity} Alerts`, value: String(r.c) })),
        ],
      },
      { type: 'table', title: 'Daily Trend (local calendar day)', columns: ['Date', 'Count'], rows: dailyRows.rows.map((r) => [r.day, String(r.c)]) },
      { type: 'table', title: 'Top Alarm Types', columns: ['Alarm Type', 'Count'], rows: topAlarmTypes.rows.map((r) => [r.name, String(r.c)]) },
      { type: 'table', title: 'Top Servers', columns: ['Server', 'Count'], rows: topServers.rows.map((r) => [r.name, String(r.c)]) },
      { type: 'table', title: 'Resolution State Split', columns: ['State', 'Count'], rows: resolutionRows.rows.map((r) => [r.label, String(r.c)]) },
    ],
  };
}

const MODEL_BUILDERS = { inventory: buildInventoryModel, alerts: buildAlertsModel, summary: buildSummaryModel };

async function buildModel(reportType, params) {
  const builder = MODEL_BUILDERS[reportType];
  if (!builder) throw AppError.badRequest(`Unknown report type: ${reportType}`);
  return builder(params);
}

// ---------------------------------------------------------------------
// PDF rendering (branding + one section at a time, manually paginated --
// pdfkit has no built-in table/pagination support).
// ---------------------------------------------------------------------
function drawPdfTable(doc, columns, rows) {
  const left = doc.page.margins.left;
  const usableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const colWidth = usableWidth / columns.length;
  const rowHeight = 16;

  const drawRow = (cells, bold) => {
    if (doc.y > doc.page.height - doc.page.margins.bottom - rowHeight) doc.addPage();
    const y = doc.y;
    doc.fontSize(8).fillColor(bold ? '#000' : '#333');
    cells.forEach((cell, i) => {
      doc.text(String(cell ?? ''), left + i * colWidth, y, { width: colWidth - 4, height: rowHeight, ellipsis: true, lineBreak: false });
    });
    doc.y = y + rowHeight;
    if (bold) {
      doc.moveTo(left, doc.y).lineTo(left + usableWidth, doc.y).strokeColor('#ccc').stroke();
      doc.y += 2;
    }
  };

  drawRow(columns, true);
  if (!rows.length) {
    doc.fontSize(9).fillColor('#999').text('No data for this range.', left, doc.y);
    doc.y += rowHeight;
    return;
  }
  for (const row of rows) drawRow(row, false);
}

function renderPdf(model, res, filename) {
  const doc = new PDFDocument({ margin: 40, size: 'A4', layout: 'landscape' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}.pdf"`);
  doc.pipe(res);

  doc.fillColor(`#${BRAND_HEX}`).fontSize(18).text(BRAND_NAME);
  doc.fillColor('#666').fontSize(9).text(BRAND_TAGLINE);
  doc.moveDown(0.8);
  doc.fillColor('#000').fontSize(15).text(model.title);
  doc.fillColor('#666').fontSize(10).text(model.subtitle);
  doc.fontSize(8).fillColor('#999').text(`Generated ${model.generatedAtLocal} (local time)`);
  doc.moveDown(1);

  for (const section of model.sections) {
    if (doc.y > doc.page.height - doc.page.margins.bottom - 100) doc.addPage();
    doc.fillColor('#000').fontSize(12).text(section.title);
    doc.moveDown(0.3);
    if (section.type === 'kv') {
      doc.fontSize(9).fillColor('#333');
      for (const item of section.items) {
        if (doc.y > doc.page.height - doc.page.margins.bottom - 16) doc.addPage();
        doc.text(`${item.label}: ${item.value}`);
      }
    } else {
      drawPdfTable(doc, section.columns, section.rows);
    }
    doc.moveDown(0.8);
  }
  doc.end();
}

// ---------------------------------------------------------------------
// Word (.docx) rendering.
// ---------------------------------------------------------------------
function buildDocxTable(columns, rows) {
  const headerRow = new TableRow({
    tableHeader: true,
    children: columns.map((c) => new TableCell({
      shading: { fill: 'DCE6F5' },
      children: [new Paragraph({ children: [new TextRun({ text: c, bold: true, size: 18 })] })],
    })),
  });
  const bodyRows = (rows.length ? rows : [[`No data for this range.`, ...Array(columns.length - 1).fill('')]]).map((row) => new TableRow({
    children: row.map((cell) => new TableCell({
      children: [new Paragraph({ children: [new TextRun({ text: String(cell ?? ''), size: 18 })] })],
    })),
  }));
  return new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [headerRow, ...bodyRows] });
}

async function renderDocx(model, res, filename) {
  const children = [
    new Paragraph({ children: [new TextRun({ text: BRAND_NAME, bold: true, size: 32, color: BRAND_HEX })] }),
    new Paragraph({ children: [new TextRun({ text: BRAND_TAGLINE, size: 18, color: '666666' })] }),
    new Paragraph({ text: '' }),
    new Paragraph({ heading: HeadingLevel.HEADING_1, text: model.title }),
    new Paragraph({ children: [new TextRun({ text: model.subtitle, italics: true, color: '666666' })] }),
    new Paragraph({ children: [new TextRun({ text: `Generated ${model.generatedAtLocal} (local time)`, size: 16, color: '999999' })] }),
    new Paragraph({ text: '' }),
  ];
  for (const section of model.sections) {
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_2, text: section.title }));
    if (section.type === 'table') {
      children.push(buildDocxTable(section.columns, section.rows));
    } else {
      for (const item of section.items) {
        children.push(new Paragraph({ children: [new TextRun({ text: `${item.label}: `, bold: true }), new TextRun(item.value)] }));
      }
    }
    children.push(new Paragraph({ text: '' }));
  }
  const doc = new Document({ sections: [{ children }] });
  const buffer = await Packer.toBuffer(doc);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}.docx"`);
  res.send(buffer);
}

// ---------------------------------------------------------------------
// Excel (.xlsx) rendering -- one sheet per section, no branding (per the
// brief: this format is tabular/detail-listing shaped and doesn't need it).
// ---------------------------------------------------------------------
function sanitizeSheetName(name) {
  return (name || 'Sheet').replace(/[:\\/?*[\]]/g, '').slice(0, 31) || 'Sheet';
}

function renderXlsx(model, res, filename) {
  const wb = XLSX.utils.book_new();
  const usedNames = new Set();
  for (const section of model.sections) {
    const aoa = section.type === 'table'
      ? [section.columns, ...section.rows]
      : [['Label', 'Value'], ...section.items.map((i) => [i.label, i.value])];
    let name = sanitizeSheetName(section.title);
    let suffix = 2;
    while (usedNames.has(name)) name = `${sanitizeSheetName(section.title).slice(0, 28)} ${suffix++}`;
    usedNames.add(name);
    const sheet = XLSX.utils.aoa_to_sheet(aoa);
    XLSX.utils.book_append_sheet(wb, sheet, name);
  }
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}.xlsx"`);
  res.send(buffer);
}

const RENDERERS = { pdf: renderPdf, docx: renderDocx, xlsx: renderXlsx };

async function generateReport(reportType, format, params, res) {
  const renderer = RENDERERS[format];
  if (!renderer) throw AppError.badRequest(`Unknown report format: ${format}`);
  const model = await buildModel(reportType, params);
  const filename = `server-watch-${reportType}-${new Date().toISOString().slice(0, 10)}`;
  await renderer(model, res, filename);
}

module.exports = { generateReport, buildModel, REPORT_TYPES: Object.keys(MODEL_BUILDERS), REPORT_FORMATS: Object.keys(RENDERERS) };
