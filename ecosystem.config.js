// PM2 process file - fork mode only (node:sqlite is a single process-local
// connection; cluster mode would corrupt data under concurrent writes).
export default {
  apps: [
    {
      name: 'scom-server-dashboard',
      script: 'server/src/index.js',
      exec_mode: 'fork',
      instances: 1,
      env: {
        NODE_ENV: 'production',
        PORT: 4000,
      },
    },
  ],
};
