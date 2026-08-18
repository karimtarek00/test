import { isPortFree } from './lib/portCheck.js';

const PORT = Number(process.env.PORT) || 4000;

async function main() {
  const free = await isPortFree(PORT);
  if (!free) {
    console.error(`Port ${PORT} is already in use - refusing to start (another instance may already be running).`);
    process.exit(1);
  }

  // Dynamic import so nothing touches the sqlite connection until the port
  // check above has passed (lesson learned #7).
  const { createApp, pkgVersion } = await import('./app.js');
  const app = createApp();

  app.listen(PORT, () => {
    console.log(`SCOM Server Dashboard v${pkgVersion} listening on :${PORT} (${process.env.NODE_ENV || 'development'})`);
  });
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
