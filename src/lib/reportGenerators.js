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
const { localDateStartToUtcIso, localDateEndToUtcIso, sqlLocalDay, sqlLocalMonth, formatLocal } = require('./orgTime');

const BRAND_NAME = 'SERVER WATCH';
const BRAND_TAGLINE = 'SCOM Server Monitoring';
const BRAND_HEX = '2684ff'; // matches the app's own --info accent color
const BRAND_HEX_2 = '7c3aed'; // gradient end for the PDF header bar

// Matches the app's own CSS custom properties (client/src/styles) exactly,
// so a chart in an exported report never disagrees with the color a user
// already associates with that severity/state on-screen.
const SEVERITY_COLORS = { Critical: '#ff4d4f', Warning: '#ffb020', Information: '#2684ff' };
const RESOLUTION_COLORS_FALLBACK = ['#00c896', '#8899aa', '#ffb020', '#2684ff', '#ff4d4f'];
function colorForSeverity(label) { return SEVERITY_COLORS[label] || '#8899aa'; }
function colorForResolution(label, index) {
  if (label === 'Closed') return '#00c896';
  if (label === 'New') return '#ff4d4f';
  return RESOLUTION_COLORS_FALLBACK[index % RESOLUTION_COLORS_FALLBACK.length];
}

function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }

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
  const [
    totalRow, severityRows, topAlarmTypes, topServers, resolutionRows, dailyRows,
    monthlyRows, devicesMonitoredRow, devicesAffectedRow, healthRows,
  ] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int AS c ${JOIN} ${whereSql}`, values),
    pool.query(`SELECT a.severity AS severity, COUNT(*)::int AS c ${JOIN} ${whereSql} GROUP BY a.severity ORDER BY c DESC`, values),
    pool.query(`SELECT a.alert_name AS name, COUNT(*)::int AS c ${JOIN} ${whereSql} GROUP BY a.alert_name ORDER BY c DESC LIMIT 10`, values),
    pool.query(`SELECT COALESCE(s.hostname, a.server_name_raw) AS name, COUNT(*)::int AS c ${JOIN} ${whereSql} GROUP BY name ORDER BY c DESC LIMIT 10`, values),
    pool.query(`SELECT a.resolution_state_label AS label, COUNT(*)::int AS c ${JOIN} ${whereSql} GROUP BY label ORDER BY c DESC`, values),
    // Local-calendar-day bucketing (rule #2) -- NOT a raw date(created_at).
    pool.query(`SELECT ${sqlLocalDay('a.created_at')} AS day, COUNT(*)::int AS c ${JOIN} ${whereSql} GROUP BY day ORDER BY day ASC`, values),
    pool.query(`SELECT ${sqlLocalMonth('a.created_at')} AS month, COUNT(*)::int AS c ${JOIN} ${whereSql} GROUP BY month ORDER BY month ASC`, values),
    pool.query(`SELECT COUNT(*)::int AS c FROM servers WHERE active = 1`),
    pool.query(`SELECT COUNT(DISTINCT COALESCE(s.hostname, a.server_name_raw))::int AS c ${JOIN} ${whereSql}`, values),
    pool.query(`
      SELECT COALESCE(s.hostname, a.server_name_raw) AS device, COUNT(*)::int AS alarms,
             COUNT(DISTINCT a.alert_name)::int AS distinct_types,
             COUNT(DISTINCT ${sqlLocalDay('a.created_at')})::int AS distinct_days
      ${JOIN} ${whereSql} GROUP BY device ORDER BY alarms DESC LIMIT 10
    `, values),
  ]);

  const totalAlerts = totalRow.rows[0].c;
  const criticalCount = severityRows.rows.find((r) => r.severity === 'Critical')?.c || 0;
  const topDevice = topServers.rows[0] ? `${topServers.rows[0].name} (${topServers.rows[0].c})` : '—';
  const peakDay = dailyRows.rows.reduce((best, r) => (!best || r.c > best.c ? r : best), null);

  // Health score is a simple, explainable heuristic (not a SCOM concept) --
  // it exists only to rank "which devices need attention first" within a
  // report, weighted so a device with many DIFFERENT recurring problems
  // (distinct_types) or a problem spread across many days (distinct_days)
  // ranks worse than one with the same alarm count from a single repeating
  // alert on one bad day.
  const healthTableRows = healthRows.rows.map((r) => ({
    ...r,
    healthScore: clamp(Math.round(100 - r.alarms * 2 - r.distinct_types * 3 - r.distinct_days * 1), 0, 100),
  })).sort((a, b) => a.healthScore - b.healthScore);

  return {
    reportType: 'summary',
    title: 'Alert Summary Report',
    subtitle: describeRange(params.from, params.to),
    generatedAtLocal: formatLocal(new Date().toISOString()),
    sections: [
      {
        type: 'kpiCards',
        title: 'Overview',
        cards: [
          { label: 'Devices Monitored', value: String(devicesMonitoredRow.rows[0].c) },
          { label: 'Total Alarms', value: String(totalAlerts) },
          { label: 'Devices Affected', value: String(devicesAffectedRow.rows[0].c) },
          { label: 'Critical Alarms', value: String(criticalCount) },
          { label: 'Top Device', value: topDevice },
          { label: 'Peak Day', value: peakDay ? `${peakDay.day} (${peakDay.c})` : '—' },
        ],
      },
      {
        type: 'donut',
        title: 'Severity Breakdown',
        slices: severityRows.rows.map((r) => ({ label: r.severity, value: r.c, color: colorForSeverity(r.severity) })),
      },
      {
        type: 'donut',
        title: 'Resolution State Breakdown',
        slices: resolutionRows.rows.map((r, i) => ({ label: r.label, value: r.c, color: colorForResolution(r.label, i) })),
      },
      {
        type: 'monthlyBars',
        title: 'Monthly Trend (local calendar month)',
        labels: monthlyRows.rows.map((r) => r.month),
        values: monthlyRows.rows.map((r) => r.c),
      },
      {
        type: 'rankedBars',
        title: 'Top Alarm Types',
        items: topAlarmTypes.rows.map((r) => ({ label: r.name, value: r.c })),
        color: `#${BRAND_HEX}`,
      },
      {
        type: 'rankedBars',
        title: 'Top Devices by Alarm Volume',
        items: topServers.rows.map((r) => ({ label: r.name, value: r.c })),
        color: `#${BRAND_HEX_2}`,
      },
      {
        type: 'table',
        title: 'Least-Healthy Devices',
        columns: ['Device', 'Alarms', 'Distinct Types', 'Distinct Days', 'Health Score'],
        rows: healthTableRows.map((r) => [r.device, String(r.alarms), String(r.distinct_types), String(r.distinct_days), String(r.healthScore)]),
      },
      { type: 'table', title: 'Daily Trend (local calendar day)', columns: ['Date', 'Count'], rows: dailyRows.rows.map((r) => [r.day, String(r.c)]) },
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

// Below this point are the hand-drawn chart primitives for the redesigned
// PDF (KPI cards, donuts, bar charts). Deliberately built on pdfkit's own
// vector drawing (rect/circle/fill) rather than a canvas-based charting
// library -- this app has to run fully offline on a production server with
// no internet access, and a canvas-backed renderer needs prebuilt native
// binaries that can't be vendored the same way a pure-JS dependency can.

function ensureSpace(doc, neededHeight) {
  if (doc.y + neededHeight > doc.page.height - doc.page.margins.bottom) doc.addPage();
}

function drawKpiCards(doc, cards) {
  const left = doc.page.margins.left;
  const usableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const gap = 10;
  const cardWidth = (usableWidth - gap * (cards.length - 1)) / cards.length;
  const cardHeight = 52;
  ensureSpace(doc, cardHeight + 10);
  const top = doc.y;
  cards.forEach((card, i) => {
    const x = left + i * (cardWidth + gap);
    doc.roundedRect(x, top, cardWidth, cardHeight, 5).fillColor('#f4f7fb').fill();
    doc.fontSize(7.5).fillColor('#667').text(card.label.toUpperCase(), x + 8, top + 8, { width: cardWidth - 16 });
    doc.fontSize(13).fillColor('#111').text(card.value, x + 8, top + 23, { width: cardWidth - 16, ellipsis: true, lineBreak: false });
  });
  doc.y = top + cardHeight + 14;
}

function polarPoint(cx, cy, radius, angleRad) {
  return [cx + radius * Math.cos(angleRad), cy + radius * Math.sin(angleRad)];
}

// Draws one donut (pie with a hollow center) at (cx,cy), plus a title above
// and a color-key legend below. Slices are hand-built as filled polygon fans
// approximating the arc -- pdfkit has no native pie/arc-fill primitive.
function drawDonut(doc, cx, cy, radius, section) {
  const { title, slices } = section;
  doc.fontSize(10).fillColor('#000').text(title, cx - radius, cy - radius - 16, { width: radius * 2, align: 'center' });
  const total = slices.reduce((sum, s) => sum + s.value, 0);
  if (!total) {
    doc.fontSize(9).fillColor('#999').text('No data for this range.', cx - radius, cy - 5, { width: radius * 2, align: 'center' });
    return cy + radius + 20;
  }
  let angle = -Math.PI / 2; // 12 o'clock start, matches the reference design
  for (const slice of slices) {
    if (!slice.value) continue;
    const sweep = (slice.value / total) * Math.PI * 2;
    const segments = Math.max(1, Math.round((sweep / (Math.PI * 2)) * 72));
    doc.moveTo(cx, cy);
    const [sx, sy] = polarPoint(cx, cy, radius, angle);
    doc.lineTo(sx, sy);
    for (let i = 1; i <= segments; i++) {
      const [px, py] = polarPoint(cx, cy, radius, angle + (sweep * i) / segments);
      doc.lineTo(px, py);
    }
    doc.closePath().fillColor(slice.color).fill();
    angle += sweep;
  }
  doc.circle(cx, cy, radius * 0.55).fillColor('#fff').fill();

  let legendY = cy + radius + 12;
  doc.fontSize(8);
  for (const slice of slices) {
    doc.rect(cx - radius, legendY, 8, 8).fillColor(slice.color).fill();
    doc.fillColor('#333').text(`${slice.label} (${slice.value})`, cx - radius + 12, legendY - 1, { width: radius * 2 - 12, ellipsis: true, lineBreak: false });
    legendY += 12;
  }
  return legendY + 8;
}

// Renders one or two donut sections side by side (the reference design pairs
// severity + resolution-state donuts on one row); a lone trailing donut
// still renders correctly, just centered on the left half.
function drawDonutPair(doc, left, right) {
  const usableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const radius = 55;
  const legendRows = Math.max(left.slices.length, right ? right.slices.length : 0);
  ensureSpace(doc, radius * 2 + 40 + legendRows * 12);
  const top = doc.y;
  const colWidth = usableWidth / 2;
  const leftCx = doc.page.margins.left + colWidth / 2;
  const rightCx = doc.page.margins.left + colWidth + colWidth / 2;
  const cy = top + radius + 18;
  const leftBottom = drawDonut(doc, leftCx, cy, radius, left);
  const rightBottom = right ? drawDonut(doc, rightCx, cy, radius, right) : cy;
  doc.y = Math.max(leftBottom, rightBottom) + 6;
}

function drawMonthlyBarChart(doc, section) {
  const { title, labels, values } = section;
  const left = doc.page.margins.left;
  const usableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const chartHeight = 110;
  ensureSpace(doc, chartHeight + 40);
  doc.fontSize(11).fillColor('#000').text(title, left, doc.y);
  const chartTop = doc.y + 6;
  if (!values.length) {
    doc.fontSize(9).fillColor('#999').text('No data for this range.', left, chartTop + 10);
    doc.y = chartTop + 30;
    return;
  }
  const max = Math.max(1, ...values);
  const slot = usableWidth / values.length;
  const barWidth = Math.min(40, slot * 0.55);
  values.forEach((v, i) => {
    const barHeight = (v / max) * chartHeight;
    const bx = left + i * slot + (slot - barWidth) / 2;
    const by = chartTop + chartHeight - barHeight;
    doc.rect(bx, by, barWidth, Math.max(1, barHeight)).fillColor(`#${BRAND_HEX}`).fill();
    doc.fontSize(7).fillColor('#333').text(String(v), bx - 5, by - 10, { width: barWidth + 10, align: 'center' });
    doc.fontSize(7).fillColor('#666').text(labels[i] || '', left + i * slot, chartTop + chartHeight + 4, { width: slot, align: 'center' });
  });
  doc.moveTo(left, chartTop + chartHeight).lineTo(left + usableWidth, chartTop + chartHeight).strokeColor('#ccc').stroke();
  doc.y = chartTop + chartHeight + 20;
}

function drawRankedBars(doc, section) {
  const { title, items, color } = section;
  const left = doc.page.margins.left;
  const usableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const rowHeight = 16;
  ensureSpace(doc, 20 + Math.max(1, items.length) * rowHeight);
  doc.fontSize(11).fillColor('#000').text(title, left, doc.y);
  doc.y += 16;
  if (!items.length) {
    doc.fontSize(9).fillColor('#999').text('No data for this range.', left, doc.y);
    doc.y += rowHeight;
    return;
  }
  const max = Math.max(1, ...items.map((i) => i.value));
  const labelWidth = usableWidth * 0.4;
  const valueColWidth = 40;
  const barAreaWidth = usableWidth - labelWidth - valueColWidth - 8;
  for (const item of items) {
    ensureSpace(doc, rowHeight);
    const y = doc.y;
    doc.fontSize(8).fillColor('#333').text(item.label, left, y + 3, { width: labelWidth - 6, ellipsis: true, lineBreak: false });
    const barWidth = Math.max(2, (item.value / max) * barAreaWidth);
    doc.rect(left + labelWidth, y + 2, barWidth, rowHeight - 6).fillColor(color).fill();
    doc.fontSize(8).fillColor('#000').text(String(item.value), left + labelWidth + barAreaWidth + 8, y + 3, { width: valueColWidth });
    doc.y = y + rowHeight;
  }
}

function renderPdf(model, res, filename) {
  const doc = new PDFDocument({ margin: 40, size: 'A4', layout: 'landscape' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}.pdf"`);
  doc.pipe(res);

  doc.fillColor(`#${BRAND_HEX}`).fontSize(18).text(BRAND_NAME);
  doc.fillColor('#666').fontSize(9).text(BRAND_TAGLINE);
  doc.moveDown(0.5);
  const left = doc.page.margins.left;
  const usableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const gradient = doc.linearGradient(left, doc.y, left + usableWidth, doc.y);
  gradient.stop(0, `#${BRAND_HEX}`).stop(1, `#${BRAND_HEX_2}`);
  doc.rect(left, doc.y, usableWidth, 3).fill(gradient);
  doc.moveDown(0.6);
  doc.fillColor('#000').fontSize(15).text(model.title);
  doc.fillColor('#666').fontSize(10).text(model.subtitle);
  doc.fontSize(8).fillColor('#999').text(`Generated ${model.generatedAtLocal} (local time)`);
  doc.moveDown(1);

  const sections = model.sections;
  for (let i = 0; i < sections.length; i++) {
    const section = sections[i];
    if (section.type === 'donut') {
      const next = sections[i + 1];
      if (next && next.type === 'donut') {
        drawDonutPair(doc, section, next);
        i++;
      } else {
        drawDonutPair(doc, section, null);
      }
      doc.moveDown(0.5);
      continue;
    }
    if (section.type === 'kpiCards') {
      drawKpiCards(doc, section.cards);
      continue;
    }
    if (section.type === 'monthlyBars') {
      drawMonthlyBarChart(doc, section);
      continue;
    }
    if (section.type === 'rankedBars') {
      drawRankedBars(doc, section);
      doc.moveDown(0.5);
      continue;
    }

    ensureSpace(doc, 100);
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

// Word and Excel have no chart-drawing story here (unlike the PDF renderer's
// hand-drawn vector charts) -- both fall back to the same underlying data as
// a plain table, so the new visual section types added for the PDF redesign
// never lose data in the other two formats, they just look like a table.
function toTabularSection(section) {
  if (section.type === 'kpiCards') {
    return { type: 'table', title: section.title, columns: ['Metric', 'Value'], rows: section.cards.map((c) => [c.label, c.value]) };
  }
  if (section.type === 'donut') {
    return { type: 'table', title: section.title, columns: ['Label', 'Count'], rows: section.slices.map((s) => [s.label, String(s.value)]) };
  }
  if (section.type === 'monthlyBars') {
    return { type: 'table', title: section.title, columns: ['Month', 'Count'], rows: section.labels.map((l, i) => [l, String(section.values[i])]) };
  }
  if (section.type === 'rankedBars') {
    return { type: 'table', title: section.title, columns: ['Rank', 'Label', 'Count'], rows: section.items.map((it, i) => [String(i + 1), it.label, String(it.value)]) };
  }
  return section;
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
  for (const rawSection of model.sections) {
    const section = toTabularSection(rawSection);
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
  for (const rawSection of model.sections) {
    const section = toTabularSection(rawSection);
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
