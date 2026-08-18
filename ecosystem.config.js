// PM2 process definition -- this is what "production" actually runs
// instead of a human typing `node dist/index.js` in a terminal.
// `ops/setup.js` bootstraps everything this file needs the first time it
// runs on a machine.
module.exports = {
  apps: [{
    name: 'server-watch',
    script: './dist/index.js',
    cwd: __dirname,
    // A large server/alert import loads the whole file into memory
    // (multer) and parses it into JS objects (xlsx), which can need several
    // hundred MB for a big spreadsheet -- matches the old direct
    // `node --max-old-space-size=4096 dist/index.js` invocation this
    // replaces, since PM2 doesn't inherit that automatically.
    node_args: ['--max-old-space-size=4096'],

    // MUST stay a single fork-mode instance. node:sqlite (src/lib/db.js) is
    // one process-local connection with its own in-process write
    // serialization (withWriteLock) -- PM2 cluster mode would run multiple
    // Node processes against the same SQLite file with zero coordination
    // between them, corrupting data under any concurrent write. Do not
    // change this to exec_mode: 'cluster' or instances > 1.
    instances: 1,
    exec_mode: 'fork',

    autorestart: true,
    // A crash within 10s of starting doesn't count toward "recovered" --
    // guards against silently crash-looping forever on a bad deploy while
    // still tolerating a normal transient blip.
    min_uptime: '10s',
    max_restarts: 15,
    restart_delay: 2000,
    // Belt-and-suspenders against a slow memory leak: PM2 restarts the
    // process itself if it ever exceeds this, rather than waiting for the
    // OS to OOM-kill it. Set comfortably above the heap size (node_args)
    // plus off-heap memory a large import's file buffer can use.
    max_memory_restart: '3G',

    // Longer than index.js's own 10s force-exit timer (see its
    // gracefulShutdown), so PM2 always waits for the app's own clean
    // shutdown to finish before escalating to SIGKILL.
    kill_timeout: 12000,

    out_file: './logs/out.log',
    error_file: './logs/error.log',
    merge_logs: true,
    // Every app log line is already a pino JSON object with its own "time"
    // field -- PM2's own per-line timestamp prefix would corrupt that JSON,
    // breaking every log-search/jq-based tool.
    time: false,

    env: {
      NODE_ENV: 'production',

      // If the SCOM SQL Server (Configuration page) sits behind a
      // certificate signed by an internal/corporate CA rather than a public
      // one, point this at a PEM file containing that CA's certificate so
      // Node trusts it for the connection, without disabling verification
      // entirely:
      // NODE_EXTRA_CA_CERTS: 'C:\\path\\to\\internal-ca.pem',
    },
  }],
};
