#!/usr/bin/env node
// Day-to-day operator commands -- one entry point instead of remembering
// raw `pm2` invocations and log file paths. Run directly
// (`node ops/cli.js <command>`) or via the `service:*`/`logs*` npm scripts.
const http = require('http');
const pm2 = require('./lib/pm2');
const logsLib = require('./lib/logs');
const { APP_NAME } = require('./lib/paths');

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (const arg of argv) {
    const m = arg.match(/^--([^=]+)=(.*)$/);
    if (m) flags[m[1]] = m[2];
    else positional.push(arg);
  }
  return { flags, positional };
}

function fetchJson(port, path) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path, timeout: 2000 }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(body) }); }
        catch { resolve({ status: res.statusCode, body: null }); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

async function cmdStatus() {
  const proc = pm2.describeApp();
  if (!proc) {
    console.log(`${APP_NAME}: not running under PM2 (pm2 status shows nothing for this app).`);
    console.log(`Start it with: npm run service:start`);
    return;
  }
  const env = proc.pm2_env || {};
  console.log(`${APP_NAME}`);
  console.log(`  status:       ${env.status}`);
  console.log(`  pid:          ${proc.pid}`);
  console.log(`  uptime:       ${env.pm_uptime ? formatUptime(Date.now() - env.pm_uptime) : 'n/a'}`);
  console.log(`  restarts:     ${env.restart_time ?? 0}`);
  console.log(`  unstable:     ${env.unstable_restarts ?? 0}`);
  console.log(`  memory:       ${proc.monit ? Math.round(proc.monit.memory / 1024 / 1024) + ' MB' : 'n/a'}`);
  console.log(`  cpu:          ${proc.monit ? proc.monit.cpu + '%' : 'n/a'}`);

  const port = Number(process.env.PORT) || 8080;
  const ready = await fetchJson(port, '/api/ready');
  if (ready) {
    console.log(`  /api/ready:   HTTP ${ready.status} -- ${ready.body?.status}`);
    if (ready.body?.checks) {
      for (const [name, check] of Object.entries(ready.body.checks)) {
        console.log(`    ${name}: ${JSON.stringify(check)}`);
      }
    }
  } else {
    console.log(`  /api/ready:   unreachable on port ${port}`);
  }

  const entries = logsLib.readAll();
  const recentErrors = entries.filter(logsLib.isErrorEntry).slice(-5);
  console.log(`  recent errors (last ${recentErrors.length} of ${entries.filter(logsLib.isErrorEntry).length} total):`);
  if (!recentErrors.length) console.log('    none');
  for (const e of recentErrors) console.log('    ' + logsLib.formatEntry(e).split('\n')[0]);
}

function formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return `${d}d ${h}h ${m}m`;
}

function cmdLogs() { pm2.logs(true); }

function cmdLogsErrors() {
  const entries = logsLib.readAll().filter(logsLib.isErrorEntry);
  if (!entries.length) { console.log('No errors logged.'); return; }
  for (const e of entries) console.log(logsLib.formatEntry(e) + '\n');
}

function cmdLogsTail(flags) {
  const n = Number(flags.n || flags.lines || 100);
  const entries = logsLib.readAll().slice(-n);
  for (const e of entries) console.log(logsLib.formatEntry(e));
}

function cmdLogsSearch(flags) {
  let entries = logsLib.readAll();
  if (flags.date) entries = logsLib.filterByDate(entries, flags.date);
  if (flags.q) entries = logsLib.filterByQuery(entries, flags.q);
  if (flags.requestId) entries = logsLib.filterByRequestId(entries, flags.requestId);
  if (!flags.date && !flags.q && !flags.requestId) {
    console.log('Usage: logs:search --date=YYYY-MM-DD | --q=<term> | --requestId=<id> (combinable)');
    return;
  }
  if (!entries.length) { console.log('No matching log entries.'); return; }
  for (const e of entries) console.log(logsLib.formatEntry(e) + '\n');
}

const COMMANDS = {
  status: cmdStatus,
  logs: cmdLogs,
  'logs:errors': cmdLogsErrors,
  'logs:tail': (flags) => cmdLogsTail(flags),
  'logs:search': (flags) => cmdLogsSearch(flags),
  'logs:rotate': () => require('child_process').execFileSync(process.execPath, [require('path').join(__dirname, 'rotateLogs.js')], { stdio: 'inherit' }),
  restart: () => pm2.restart(),
  stop: () => pm2.stop(),
  start: () => pm2.start(),
};

async function main() {
  const [, , cmd, ...rest] = process.argv;
  const { flags } = parseArgs(rest);
  const handler = COMMANDS[cmd];
  if (!handler) {
    console.log('Usage: node ops/cli.js <command> [--flags]');
    console.log('Commands: ' + Object.keys(COMMANDS).join(', '));
    process.exit(cmd ? 1 : 0);
  }
  if (!pm2.isInstalled() && cmd !== 'logs:errors' && cmd !== 'logs:tail' && cmd !== 'logs:search') {
    console.error('Bundled PM2 not found -- node_modules looks incomplete. Re-extract the app bundle and try again.');
    process.exit(1);
  }
  await handler(flags);
}

main().catch((err) => { console.error(err); process.exit(1); });
