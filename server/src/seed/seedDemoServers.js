// Not real inventory data - just derives a demo server list from the hostnames
// that already show up in the seeded alert samples, so Inventory / Critical
// Dashboard / server-linked alert counts aren't empty while waiting on the
// real server export. Replace via Import Data once that's available.
import { all, get, run, transaction } from '../lib/db.js';
import { normalizeServerName } from '../lib/normalize.js';

const HOSTNAME_LIKE = /^[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+$/;

const rows = all(`SELECT DISTINCT server_name_raw FROM alerts WHERE server_id IS NULL`);

// Hostnames in this environment look like <SITE>-<ROLE>-<NAME>[.domain] -
// e.g. RMP-DCDBS-UMRSG.SEC.se.com.sa. The leading segment is a plausible
// site/data-center code; used here only to seed a demo grouping, not as a
// confirmed classification (still TBD with the user).
function guessDataCenter(hostname) {
  const match = hostname.match(/^([A-Za-z]+)-/);
  return match ? match[1].toUpperCase() : null;
}

let created = 0;
await transaction(() => {
  for (const row of rows) {
    const raw = row.server_name_raw;
    if (!raw || !HOSTNAME_LIKE.test(raw.trim())) continue; // skip non-hostname sources (disks, app pools, etc.)

    const normalized = normalizeServerName(raw);
    if (get('SELECT id FROM servers WHERE normalized_key = ?', [normalized])) continue;

    const hostname = raw.split('.')[0];
    const dataCenter = guessDataCenter(hostname);

    run(
      `INSERT INTO servers (hostname, fqdn, normalized_key, data_center, is_critical, source)
       VALUES (?, ?, ?, ?, ?, 'import')`,
      [hostname, raw, normalized, dataCenter, created < 5 ? 1 : 0],
    );
    created += 1;
  }
});

console.log(`Seeded ${created} demo servers derived from alert hostnames (marked first 5 as critical for the watchlist demo).`);

// Link previously-unmatched alerts to the servers we just created.
const relinked = await transaction(() => {
  const orphaned = all(`SELECT id, server_name_raw FROM alerts WHERE server_id IS NULL`);
  let linkedCount = 0;
  for (const alert of orphaned) {
    const normalized = normalizeServerName(alert.server_name_raw);
    const server = get('SELECT id FROM servers WHERE normalized_key = ?', [normalized]);
    if (server) {
      run('UPDATE alerts SET server_id = ? WHERE id = ?', [server.id, alert.id]);
      linkedCount += 1;
    }
  }
  return linkedCount;
});

console.log(`Linked ${relinked} alerts to seeded servers.`);
