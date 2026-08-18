#!/usr/bin/env node
// One-time bootstrap for a fresh install on a new machine: create the
// persistent directories/config a deploy will need, start the app under
// PM2, and print the (OS-specific, requires admin/sudo so not run
// automatically) commands to make PM2 itself survive a reboot and to
// schedule log rotation. Safe to re-run -- every step is idempotent.
//
// Needs NO network access at all: PM2 ships bundled inside this app's own
// node_modules, and log rotation is a small built-in script
// (ops/rotateLogs.js) instead of the pm2-logrotate module.
const fs = require('fs');
const path = require('path');
const pm2 = require('./lib/pm2');
const { APP_ROOT, LOG_DIR, BACKUP_DIR, PM2_BIN } = require('./lib/paths');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  console.log(`✓ ${path.relative(APP_ROOT, dir) || '.'}/ ready`);
}

function ensureEnvFile() {
  const envPath = path.join(APP_ROOT, '.env');
  const examplePath = path.join(APP_ROOT, '.env.example');
  if (fs.existsSync(envPath)) {
    console.log('✓ .env already exists (left untouched)');
    return;
  }
  if (fs.existsSync(examplePath)) {
    fs.copyFileSync(examplePath, envPath);
    console.log('✓ .env created from .env.example -- review it, especially NODE_ENV and PORT');
  }
}

function main() {
  console.log('Server Watch -- production setup (no network access required)\n');

  if (!pm2.isInstalled()) {
    console.error(`✗ Bundled PM2 not found at ${PM2_BIN}`);
    console.error('  This usually means node_modules is missing or incomplete -- re-extract the bundle and try again.');
    process.exit(1);
  }
  console.log('✓ PM2 is available (bundled in node_modules, no install needed)');

  ensureDir(LOG_DIR);
  ensureDir(BACKUP_DIR);
  ensureEnvFile();

  console.log('\nStarting the app under PM2...');
  pm2.start();
  pm2.save();
  console.log('✓ app started and saved to PM2\'s process list');

  const nodeExe = process.execPath;
  const rotateScript = path.join(APP_ROOT, 'ops', 'rotateLogs.js');

  console.log('\n--- Two remaining manual steps (both need admin/sudo, so not run automatically) ---\n');

  if (process.platform === 'win32') {
    console.log('1) Make PM2 survive a reboot -- run this ONCE in an elevated (Run as Administrator) prompt:');
    console.log(`   schtasks /create /tn "ServerWatchPM2" /sc onstart /ru SYSTEM /rl highest /f /tr "\\"${nodeExe}\\" \\"${PM2_BIN}\\" resurrect"`);
    console.log('\n2) Schedule log rotation (daily) -- run this ONCE:');
    console.log(`   schtasks /create /tn "ServerWatchLogRotate" /sc daily /st 03:00 /ru SYSTEM /rl highest /f /tr "\\"${nodeExe}\\" \\"${rotateScript}\\""`);
  } else {
    console.log('1) Make PM2 survive a reboot -- generate and run the boot-startup command for your init system:');
    console.log(`   node "${PM2_BIN}" startup`);
    console.log('   (it prints a command that needs sudo -- copy/paste and run it, then re-run `npm run service:start` and `pm2 save`)');
    console.log('\n2) Schedule log rotation (daily) -- add this line via `crontab -e`:');
    console.log(`   0 3 * * * ${nodeExe} "${rotateScript}" >> "${path.join(LOG_DIR, 'rotate.log')}" 2>&1`);
  }

  console.log('\nSetup complete. Check status any time with: npm run service:status');
}

main();
