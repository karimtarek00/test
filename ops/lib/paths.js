// Shared path/constant definitions for every ops/ script -- one place so
// "where do logs live", "what's the app called in PM2", etc. can't drift
// between setup.js/deploy.js/rollback.js/cli.js.
const path = require('path');

const APP_ROOT = path.join(__dirname, '..', '..');
const APP_NAME = 'server-watch';
const LOG_DIR = path.join(APP_ROOT, 'logs');
const OUT_LOG = path.join(LOG_DIR, 'out.log');
const ERROR_LOG = path.join(LOG_DIR, 'error.log');
const BACKUP_DIR = path.join(APP_ROOT, 'backups');
const ECOSYSTEM_FILE = path.join(APP_ROOT, 'ecosystem.config.js');
// PM2 ships bundled in node_modules (a real dependency, not global) so this
// app never needs `npm install -g pm2` -- some production machines this
// runs on have no registry access at all. Always invoked as
// `node PM2_BIN ...args`, never a bare `pm2` command that depends on
// PATH/a global install existing.
const PM2_BIN = path.join(APP_ROOT, 'node_modules', 'pm2', 'bin', 'pm2');
// What actually gets swapped by deploy.js/rollback.js -- everything the
// running app needs except its persistent state (data/, .env, logs/,
// backups/, node_modules-adjacent ops/ tooling itself).
const DEPLOYABLE_ENTRIES = ['dist', 'public', 'node_modules', 'package.json', 'db', 'seed'];

module.exports = { APP_ROOT, APP_NAME, LOG_DIR, OUT_LOG, ERROR_LOG, BACKUP_DIR, ECOSYSTEM_FILE, PM2_BIN, DEPLOYABLE_ENTRIES };
