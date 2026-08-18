#!/usr/bin/env node
// Replaces the pm2-logrotate module (which PM2 would normally fetch from
// the npm registry -- not viable on a machine with no registry access at
// all). Rotates the log file on disk, then tells PM2 to reopen fresh file
// handles at the original path via `pm2 reloadLogs`. Uses only Node's
// built-in fs/zlib -- nothing to install.
//
// Intended to run periodically as its own short-lived process (Windows Task
// Scheduler / cron), NOT from inside the running app -- renaming a file
// that's still open for writing by another process is unreliable on
// Windows, so rotation has to happen from outside, then hand control back
// to PM2 via reloadLogs.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const { OUT_LOG, ERROR_LOG } = require('./lib/paths');
const pm2 = require('./lib/pm2');

const MAX_SIZE_BYTES = 20 * 1024 * 1024; // 20MB
const MAX_ROTATED_FILES = 10;

function rotateIfNeeded(filePath) {
  if (!fs.existsSync(filePath)) return false;
  const { size } = fs.statSync(filePath);
  if (size < MAX_SIZE_BYTES) return false;

  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const rotatedPath = path.join(dir, `${base}.${timestamp}.gz`);

  const content = fs.readFileSync(filePath);
  fs.writeFileSync(rotatedPath, zlib.gzipSync(content));
  fs.rmSync(filePath, { force: true });
  console.log(`Rotated ${path.relative(process.cwd(), filePath)} (${(size / 1024 / 1024).toFixed(1)}MB) -> ${path.relative(process.cwd(), rotatedPath)}`);

  pruneOldRotations(dir, base);
  return true;
}

function pruneOldRotations(dir, base) {
  const rotated = fs.readdirSync(dir).filter((f) => f.startsWith(`${base}.`) && f.endsWith('.gz')).sort();
  const toRemove = rotated.slice(0, Math.max(0, rotated.length - MAX_ROTATED_FILES));
  for (const f of toRemove) {
    fs.unlinkSync(path.join(dir, f));
    console.log(`  pruned old rotation: ${f}`);
  }
}

function main() {
  const rotatedOut = rotateIfNeeded(OUT_LOG);
  const rotatedErr = rotateIfNeeded(ERROR_LOG);
  if (rotatedOut || rotatedErr) {
    console.log('Telling PM2 to reopen log files...');
    pm2.run(['reloadLogs']);
  } else {
    console.log('Nothing to rotate (both log files under 20MB).');
  }
}

main();
