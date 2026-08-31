#!/usr/bin/env node
// Installs Server Watch as a real Windows Service via NSSM, as an
// alternative to PM2 for environments where PM2 itself turns out to be the
// unreliable part (its own bundled node_modules files intermittently
// missing/quarantined by endpoint AV, which breaks PM2 -- not the app it's
// meant to supervise). NSSM wraps `node dist/index.js` directly instead, so
// there's one fewer moving part between the OS and the running app.
//
// Must be run from an elevated (Run as Administrator) prompt -- installing
// a Windows Service requires it. Needs NO network access: NSSM itself has
// to be vendored into ops/vendor/nssm.exe ahead of time (see
// ops/vendor/README.md) since neither the production server nor this
// project's own dev sandbox can reach nssm.cc to fetch it automatically.
const { WINDOWS_SERVICE_NAME, NSSM_BIN } = require('./lib/paths');
const windowsService = require('./lib/windowsService');

function main() {
  console.log('Server Watch -- Windows Service setup (via NSSM)\n');

  if (process.platform !== 'win32') {
    console.error(`✗ This only applies on Windows (detected: ${process.platform}). Use "npm run setup" + PM2 instead.`);
    process.exit(1);
  }

  if (!windowsService.isVendored()) {
    console.error(`✗ NSSM binary not found at ${NSSM_BIN}`);
    console.error('  See ops/vendor/README.md for how to get it (one manual download, on any machine with internet access).');
    process.exit(1);
  }
  console.log('✓ NSSM found (ops/vendor/nssm.exe)');

  const result = windowsService.install();
  if (!result.ok) {
    console.error(`✗ ${result.error}`);
    process.exit(1);
  }

  console.log(`✓ Service "${result.serviceName}" installed (auto-start on boot, restarts on crash).`);
  console.log('\nNext steps:');
  console.log(`  sc start "${WINDOWS_SERVICE_NAME}"`);
  console.log('  npm run service:status');
  console.log('\nIf it doesn\'t come up healthy, check:');
  console.log('  logs\\nssm-stdout.log and logs\\nssm-stderr.log  (raw process output -- catches crashes before the app\'s own logger starts)');
  console.log('  logs\\out.log and logs\\error.log               (the app\'s own structured logs, once it does start)');
}

main();
