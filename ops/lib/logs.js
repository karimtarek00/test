// Reads/filters/formats the app's structured JSON logs for cli.js. Pino
// writes every level (including errors) to stdout -> logs/out.log; PM2's
// error_file (logs/error.log) only ever gets raw stderr (Node's own
// experimental-feature warnings, a crash before pino was even set up) --
// so "find the errors" always has to scan out.log's JSON `level` field.
const fs = require('fs');
const { OUT_LOG, ERROR_LOG } = require('./paths');

const LEVEL_NAMES = { 10: 'TRACE', 20: 'DEBUG', 30: 'INFO', 40: 'WARN', 50: 'ERROR', 60: 'FATAL' };
const ERROR_THRESHOLD = 50;

function readEntries(file) {
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, 'utf8');
  return text.split('\n').filter(Boolean).map((raw) => {
    try {
      return { raw, json: JSON.parse(raw) };
    } catch {
      return { raw, json: null };
    }
  });
}

function readAll() {
  return [...readEntries(OUT_LOG), ...readEntries(ERROR_LOG)]
    .sort((a, b) => (a.json?.time || '').localeCompare(b.json?.time || ''));
}

function isErrorEntry(entry) {
  if (entry.json) return (entry.json.level || 0) >= ERROR_THRESHOLD;
  return true;
}

function formatEntry(entry) {
  if (!entry.json) return entry.raw;
  const { level, time, module: mod, msg, requestId, req, res, err, ...rest } = entry.json;
  const levelName = (LEVEL_NAMES[level] || level || '').toString().padEnd(5);
  const parts = [`[${time || ''}]`, levelName, mod ? `(${mod})` : '', msg || ''].filter(Boolean);
  let line = parts.join(' ');
  const reqId = requestId || req?.id;
  if (reqId) line += ` requestId=${reqId}`;
  if (req) line += ` ${req.method} ${req.url}`;
  if (res) line += ` -> ${res.statusCode}`;
  const extraKeys = Object.keys(rest).filter((k) => !['pid', 'hostname'].includes(k));
  if (extraKeys.length) line += ` ${JSON.stringify(Object.fromEntries(extraKeys.map((k) => [k, rest[k]])))}`;
  if (err) {
    line += `\n  error: ${err.message || err.type || JSON.stringify(err)}`;
    if (err.stack) line += `\n${String(err.stack).split('\n').map((l) => `    ${l}`).join('\n')}`;
  }
  return line;
}

function filterByDate(entries, dateStr) {
  return entries.filter((e) => (e.json?.time || '').startsWith(dateStr));
}

function filterByQuery(entries, q) {
  const needle = q.toLowerCase();
  return entries.filter((e) => e.raw.toLowerCase().includes(needle));
}

function filterByRequestId(entries, id) {
  return entries.filter((e) => e.json && (e.json.requestId === id || e.json.req?.id === id));
}

module.exports = { readAll, isErrorEntry, formatEntry, filterByDate, filterByQuery, filterByRequestId };
