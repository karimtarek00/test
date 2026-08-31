// Seeds the database from the two sample SCOM Console alert exports
// (seed-data/Active_Alerts.xlsx, Closed_Alerts.xlsx) so the app starts with
// real, realistic data instead of an empty database. Also derives a demo
// server list from the hostname-looking alert sources in that data, since a
// real server inventory export hasn't been provided yet -- replace via
// Import Data once it is (see README's Known gaps).
const fs = require('fs');
const path = require('path');
const { pool } = require('../src/lib/db');
const { parseAlertRows } = require('../src/lib/importParsers');
const { normalizeServerName } = require('../src/lib/serverNameMatch');

// Only auto-create a demo server for sources that plausibly look like a
// hostname/FQDN (same rule importParsers.extractHostnameGuess already
// applies) -- otherwise disks, cluster resources, and app pool names from
// the sample data would seed nonsense "servers".
const HOSTNAME_LIKE = /^[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+$/;

// Hostnames in this sample environment look like <SITE>-<ROLE>-<NAME>[.domain]
// (e.g. RMP-DCDBS-UMRSG.SEC.se.com.sa) -- the leading segment is a plausible
// site/data-center code, used here only to seed a demo grouping for the
// Critical Servers watchlist, not as a confirmed classification.
function guessDataCenter(hostname) {
  const m = hostname.match(/^([A-Za-z]+)-/);
  return m ? m[1].toUpperCase() : null;
}

async function seedFile(client, filePath) {
  const buffer = fs.readFileSync(filePath);
  const { parsed, errors, totalRows } = parseAlertRows(buffer);
  console.log(`${path.basename(filePath)}: parsed ${parsed.length}/${totalRows} rows (${errors.length} skipped).`);

  const serverIdByKey = new Map();
  let inserted = 0, serversCreated = 0;

  for (const a of parsed) {
    let serverId = null;
    if (HOSTNAME_LIKE.test(a.serverNameRaw)) {
      const key = normalizeServerName(a.serverNameRaw);
      serverId = serverIdByKey.get(key);
      if (serverId === undefined) {
        const existing = await client.query('SELECT id FROM servers WHERE normalized_key = $1', [key]);
        if (existing.rows.length) {
          serverId = existing.rows[0].id;
        } else {
          const hostname = a.serverNameRaw.split('.')[0];
          const created = await client.query(
            `INSERT INTO servers (hostname, fqdn, normalized_key, data_center, source) VALUES ($1,$2,$3,$4,'import') RETURNING id`,
            [hostname, a.serverNameRaw, key, guessDataCenter(hostname)]
          );
          serverId = created.rows[0].id;
          serversCreated++;
        }
        serverIdByKey.set(key, serverId);
      }
    }

    const createdAtIso = a.createdAt instanceof Date ? a.createdAt.toISOString() : a.createdAt;
    // Console exports carry only one timestamp per alert -- no separate
    // "time resolved" column -- so a Closed row's created_at is the best
    // available approximation for resolved_at. Same fix as importRoutes.js.
    const resolvedAtIso = a.resolutionStateLabel === 'Closed' ? createdAtIso : null;
    await client.query(
      `INSERT INTO alerts (server_id, server_name_raw, alert_name, severity, resolution_state, resolution_state_label, source, created_at, resolved_at, origin)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'import')`,
      [serverId, a.serverNameRaw, a.alertName, a.severity, a.resolutionState, a.resolutionStateLabel, a.source, createdAtIso, resolvedAtIso]
    );
    inserted++;
  }

  await client.query(
    `INSERT INTO import_jobs (filename, import_type, total_rows, imported_rows, failed_rows, status)
     VALUES ($1, 'alerts', $2, $3, $4, $5)`,
    [`${path.basename(filePath)} (initial seed)`, totalRows, inserted, errors.length, errors.length ? 'partial' : 'completed']
  );

  return { inserted, serversCreated };
}

async function seed() {
  const seedDataDir = path.join(__dirname, '..', 'seed-data');
  const files = ['Active_Alerts.xlsx', 'Closed_Alerts.xlsx'].map((f) => path.join(seedDataDir, f)).filter(fs.existsSync);
  if (!files.length) {
    console.log('No files found in seed-data/ -- nothing to seed.');
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    console.log('Clearing existing data...');
    await client.query('DELETE FROM alerts');
    await client.query('DELETE FROM servers');
    await client.query('DELETE FROM import_jobs');
    await client.query(`DELETE FROM sqlite_sequence WHERE name IN ('alerts','servers','import_jobs')`);

    let totalInserted = 0, totalServers = 0;
    for (const file of files) {
      const { inserted, serversCreated } = await seedFile(client, file);
      totalInserted += inserted;
      totalServers += serversCreated;
    }

    await client.query('COMMIT');
    console.log(`Seeded ${totalServers} demo servers and ${totalInserted} alerts.`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
