import net from 'node:net';

// Lesson learned #7: check the port is free *before* ever touching the database.
// On a crash-loop, a doomed start that opens node:sqlite before discovering its
// port bind will fail contends with the real running instance's writes.
export function isPortFree(port, host = '0.0.0.0') {
  return new Promise((resolve) => {
    const tester = net.createServer()
      .once('error', () => resolve(false))
      .once('listening', () => tester.close(() => resolve(true)))
      .listen(port, host);
  });
}
