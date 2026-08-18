const XLSX = require('xlsx');

// True for real binary spreadsheet formats: .xlsx/.xlsm (ZIP, magic "PK") and
// legacy .xls (OLE compound file, magic D0 CF 11 E0). Anything else is
// treated as plain-text CSV.
function isBinarySpreadsheet(buffer) {
  if (buffer.length < 4) return false;
  if (buffer[0] === 0x50 && buffer[1] === 0x4b) return true;
  if (buffer[0] === 0xd0 && buffer[1] === 0xcf && buffer[2] === 0x11 && buffer[3] === 0xe0) return true;
  return false;
}

// Minimal RFC4180-ish CSV parser (quoted fields, "" escaped quotes, embedded
// commas/newlines inside quotes, CRLF or LF).
function parseCsvText(text) {
  const rows = [];
  let row = [];
  let fieldStart = 0;
  let inQuotes = false;
  let wasQuoted = false;
  let quoteEnd = -1;
  let hasEscapedQuote = false;
  const len = text.length;
  let i = 0;

  function pushField(terminatorPos) {
    let end = wasQuoted ? quoteEnd : terminatorPos;
    if (!wasQuoted && end > 0 && text.charCodeAt(end - 1) === 13) end -= 1;
    let s = text.slice(fieldStart, end);
    if (hasEscapedQuote) { s = s.replace(/""/g, '"'); hasEscapedQuote = false; }
    row.push(s);
    wasQuoted = false;
  }

  while (i < len) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { hasEscapedQuote = true; i += 2; continue; }
        inQuotes = false; quoteEnd = i; i += 1; continue;
      }
      i += 1; continue;
    }
    if (c === '"' && i === fieldStart) { inQuotes = true; wasQuoted = true; fieldStart = i + 1; i += 1; continue; }
    if (c === ',') { pushField(i); fieldStart = i + 1; i += 1; continue; }
    if (c === '\n') { pushField(i); rows.push(row); row = []; fieldStart = i + 1; i += 1; continue; }
    i += 1;
  }
  if (fieldStart < len || row.length > 0) { pushField(len); rows.push(row); }
  return rows;
}

function csvRowsToObjects(rows) {
  if (!rows.length) return [];
  const headers = rows[0].map((h) => h.trim());
  const out = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (row.length === 1 && row[0] === '') continue;
    const obj = {};
    for (let c = 0; c < headers.length; c++) obj[headers[c]] = row[c] !== undefined ? row[c] : '';
    out.push(obj);
  }
  return out;
}

function parseWorkbookRows(buffer) {
  if (!isBinarySpreadsheet(buffer)) {
    const text = buffer.toString('utf8').replace(/^﻿/, '');
    return csvRowsToObjects(parseCsvText(text));
  }
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });
}

// Case/space/underscore-insensitive header lookup with synonyms.
function normalizeKey(k) {
  return String(k).toLowerCase().replace(/[\s_-]+/g, '');
}

function buildHeaderAliasMap(row) {
  const map = {};
  for (const k of Object.keys(row || {})) map[normalizeKey(k)] = k;
  return map;
}

function pick(row, aliasMap, ...candidates) {
  for (const c of candidates) {
    const actualKey = aliasMap[normalizeKey(c)];
    if (actualKey === undefined) continue;
    const v = row[actualKey];
    if (v !== undefined && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}

function parseFlexibleDate(value) {
  if (!value && value !== 0) return null;
  if (typeof value === 'number') {
    const d = XLSX.SSF.parse_date_code(value);
    if (d) return new Date(Date.UTC(d.y, d.m - 1, d.d, d.H, d.M, Math.floor(d.S)));
  }
  if (value instanceof Date) return value;
  const s = String(value).trim();
  if (!s) return null;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})\s+(\d{1,2}):(\d{2}):(\d{2})\s*(AM|PM)?$/i);
  if (m) {
    let [, mo, da, yr, hh, mi, ss, ap] = m;
    yr = yr.length === 2 ? 2000 + Number(yr) : Number(yr);
    hh = Number(hh);
    if (ap) {
      const upper = ap.toUpperCase();
      if (upper === 'PM' && hh !== 12) hh += 12;
      if (upper === 'AM' && hh === 12) hh = 0;
    }
    return new Date(yr, Number(mo) - 1, Number(da), hh, Number(mi), Number(ss));
  }
  const parsed = new Date(s);
  return isNaN(parsed.getTime()) ? null : parsed;
}

// Extract a hostname/FQDN guess out of a SCOM alert's free-text Source
// field. SCOM's Source is the specific monitoring object that raised the
// alert, which is frequently NOT a hostname at all (a disk, a cluster
// resource, an app pool) -- confirmed against real SCOM Console exports. So
// this only ever returns a value when it plausibly looks like one; otherwise
// null, rather than guessing wrong and mismatching a server.
const HOSTNAME_IN_PARENS = /\(([a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+)\)/;
const LOOKS_LIKE_HOSTNAME = /^[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*$/;

function extractHostnameGuess(sourceText) {
  if (!sourceText) return null;
  const trimmed = String(sourceText).trim();
  const parenMatch = trimmed.match(HOSTNAME_IN_PARENS);
  if (parenMatch) return parenMatch[1];
  const beforeBackslash = trimmed.split('\\')[0].trim();
  if (beforeBackslash.includes('.') && LOOKS_LIKE_HOSTNAME.test(beforeBackslash)) return beforeBackslash;
  return null;
}

// ---------- Server inventory import ----------
// Column names are unknown in advance until a real export is seen, so this
// maps flexibly against common header variants rather than a fixed schema.
function parseServerRows(buffer) {
  const rows = parseWorkbookRows(buffer);
  const aliasMap = buildHeaderAliasMap(rows[0]);
  const parsed = [];
  const errors = [];
  rows.forEach((row, i) => {
    const hostname = pick(row, aliasMap, 'hostname', 'host name', 'server', 'server name', 'name', 'computer');
    if (!hostname) { errors.push({ row: i + 2, error: 'Missing hostname' }); return; }
    parsed.push({
      hostname,
      fqdn: pick(row, aliasMap, 'fqdn', 'fully qualified domain name') || null,
      osType: pick(row, aliasMap, 'os', 'os type', 'operating system') || null,
      environment: pick(row, aliasMap, 'environment', 'env', 'prod/non-prod') || null,
      businessUnit: pick(row, aliasMap, 'business unit', 'bu', 'department') || null,
      dataCenter: pick(row, aliasMap, 'data center', 'datacenter', 'site') || null,
      isCritical: /^(y|yes|true|1)$/i.test(pick(row, aliasMap, 'critical', 'is critical', 'watchlist')) ? 1 : 0,
    });
  });
  return { parsed, errors, totalRows: rows.length };
}

// ---------- SCOM alert export import ----------
// Matches the SCOM Console's Active/Closed Alerts view columns: Severity,
// Source, Name, Resolution State, Created, Age (Age is always derived from
// Created, never stored).
function parseAlertRows(buffer) {
  const rows = parseWorkbookRows(buffer);
  const aliasMap = buildHeaderAliasMap(rows[0]);
  const parsed = [];
  const errors = [];
  rows.forEach((row, i) => {
    const severity = pick(row, aliasMap, 'severity');
    const name = pick(row, aliasMap, 'name', 'alert name', 'alert');
    const source = pick(row, aliasMap, 'source');
    const resolutionLabel = pick(row, aliasMap, 'resolution state') || 'New';
    const createdRaw = pick(row, aliasMap, 'created');

    if (!severity || !['Critical', 'Warning', 'Information'].includes(severity)) return; // e.g. the console's "N results found." footer row
    if (!name) { errors.push({ row: i + 2, error: 'Missing alert name' }); return; }
    const createdAt = parseFlexibleDate(createdRaw);
    if (!createdAt) { errors.push({ row: i + 2, error: `Unparseable timestamp: "${createdRaw}"` }); return; }

    const hostGuess = extractHostnameGuess(source);
    parsed.push({
      alertName: name,
      severity,
      source: source || null,
      serverNameRaw: hostGuess || source || 'Unknown',
      resolutionStateLabel: resolutionLabel,
      resolutionState: resolutionLabel === 'Closed' ? 255 : 0,
      createdAt,
    });
  });
  return { parsed, errors, totalRows: rows.length };
}

module.exports = { parseServerRows, parseAlertRows, parseFlexibleDate, extractHostnameGuess };
