// Enumerates the app root and copies/snapshots everything EXCEPT persistent
// local state -- an exclude-list instead of an include-list, so a new
// file/directory added to the app in the future is swapped by default
// instead of silently staying stale until someone remembers to add it to
// an include-list.
//
// - data/, .env, logs/, backups/, run.pid: live state/local config that
//   must never be touched by a deploy or rollback.
// - ops/: excluded from the auto-swept set specifically because deploy.js
//   is itself a running script inside ops/ -- overwriting the file that's
//   currently executing is an unnecessary risk.
const fs = require('fs');
const path = require('path');

const NEVER_TOUCH = new Set(['data', '.env', 'logs', 'backups', 'run.pid', 'ops', '.git']);

function deployableEntries(root) {
  return fs.readdirSync(root).filter((name) => !NEVER_TOUCH.has(name));
}

function copyEntries(fromRoot, toRoot, entries) {
  fs.mkdirSync(toRoot, { recursive: true });
  for (const name of entries) {
    const src = path.join(fromRoot, name);
    const dest = path.join(toRoot, name);
    if (!fs.existsSync(src)) continue;
    fs.rmSync(dest, { recursive: true, force: true });
    fs.cpSync(src, dest, { recursive: true });
  }
}

function removeEntries(root, entries) {
  for (const name of entries) {
    fs.rmSync(path.join(root, name), { recursive: true, force: true });
  }
}

module.exports = { deployableEntries, copyEntries, removeEntries, NEVER_TOUCH };
