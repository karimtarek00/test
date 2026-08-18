import xlsx from 'xlsx';
import { get, run, transaction } from './db.js';
import { normalizeServerName, extractHostnameGuess } from './normalize.js';

function sheetToRows(buffer) {
  const workbook = xlsx.read(buffer, { type: 'buffer', cellDates: true });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  return xlsx.utils.sheet_to_json(sheet, { defval: null });
}

function findColumn(row, candidates) {
  const keys = Object.keys(row);
  for (const candidate of candidates) {
    const hit = keys.find((k) => k.trim().toLowerCase() === candidate);
    if (hit) return hit;
  }
  return null;
}

// SCOM console alert exports (Active/Closed) use: Severity, Source, Name,
// Resolution State, Created, Age. Age is always derived, never stored.
function normalizeAlertRow(row) {
  const severity = row['Severity'];
  const source = row['Source'];
  const name = row['Name'];
  const resolutionLabel = row['Resolution State'];
  const created = row['Created'];

  if (!severity || !name || !created) return null; // skips the "N results found." footer row
  if (!['Critical', 'Warning', 'Information'].includes(severity)) return null;

  const createdAt = created instanceof Date ? created.toISOString() : new Date(created).toISOString();
  const hostGuess = extractHostnameGuess(source);

  return {
    severity,
    source,
    server_name_raw: hostGuess || source || 'Unknown',
    alert_name: name,
    resolution_state_label: resolutionLabel || 'New',
    resolution_state: resolutionLabel === 'Closed' ? 255 : 0,
    created_at: createdAt,
  };
}

export function parseAlertsWorkbook(buffer) {
  return sheetToRows(buffer).map(normalizeAlertRow).filter(Boolean);
}

export function upsertAlerts(rows, { origin = 'import' } = {}) {
  return transaction(() => {
    let inserted = 0;
    let skipped = 0;
    for (const row of rows) {
      const normalized = normalizeServerName(row.server_name_raw);
      const server = normalized
        ? get('SELECT id FROM servers WHERE normalized_key = ?', [normalized])
        : null;

      // No SCOM alert GUID available from a console export, so de-dupe on the
      // combination that identifies "the same alert row" well enough for seed data.
      const existing = get(
        'SELECT id FROM alerts WHERE alert_name = ? AND server_name_raw = ? AND created_at = ?',
        [row.alert_name, row.server_name_raw, row.created_at],
      );
      if (existing) {
        skipped += 1;
        continue;
      }

      run(
        `INSERT INTO alerts
          (server_id, server_name_raw, alert_name, severity, resolution_state, resolution_state_label, source, created_at, origin)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          server ? server.id : null,
          row.server_name_raw,
          row.alert_name,
          row.severity,
          row.resolution_state,
          row.resolution_state_label,
          row.source,
          row.created_at,
          origin,
        ],
      );
      inserted += 1;
    }
    return { inserted, skipped, total: rows.length };
  });
}

// Server inventory imports have unknown-in-advance column names until we see
// a real export, so map flexibly against common header variants.
function normalizeServerRow(row) {
  const hostnameKey = findColumn(row, ['hostname', 'host name', 'server', 'server name', 'name', 'computer']);
  const fqdnKey = findColumn(row, ['fqdn', 'fully qualified domain name']);
  const osKey = findColumn(row, ['os', 'os type', 'operating system']);
  const envKey = findColumn(row, ['environment', 'env', 'prod/non-prod']);
  const buKey = findColumn(row, ['business unit', 'bu', 'department']);
  const dcKey = findColumn(row, ['data center', 'datacenter', 'site']);
  const criticalKey = findColumn(row, ['critical', 'is critical', 'watchlist']);

  const hostname = hostnameKey ? row[hostnameKey] : null;
  if (!hostname) return null;

  return {
    hostname: String(hostname).trim(),
    fqdn: fqdnKey && row[fqdnKey] ? String(row[fqdnKey]).trim() : null,
    os_type: osKey ? row[osKey] : null,
    environment: envKey ? row[envKey] : null,
    business_unit: buKey ? row[buKey] : null,
    data_center: dcKey ? row[dcKey] : null,
    is_critical: criticalKey && /^(y|yes|true|1)$/i.test(String(row[criticalKey] ?? '')) ? 1 : 0,
  };
}

export function parseServersWorkbook(buffer) {
  return sheetToRows(buffer).map(normalizeServerRow).filter(Boolean);
}

// Lesson learned #2: build both full-replace and additive explicitly.
export function upsertServers(rows, { mode = 'additive' } = {}) {
  return transaction(() => {
    let inserted = 0;
    let updated = 0;
    const seenKeys = [];

    for (const row of rows) {
      const normalized = normalizeServerName(row.fqdn || row.hostname);
      seenKeys.push(normalized);
      const existing = get('SELECT id FROM servers WHERE normalized_key = ?', [normalized]);

      if (existing) {
        run(
          `UPDATE servers SET hostname=?, fqdn=?, os_type=?, environment=?, business_unit=?, data_center=?,
             is_critical=?, source='import', active=1, updated_at=datetime('now') WHERE id=?`,
          [row.hostname, row.fqdn, row.os_type, row.environment, row.business_unit, row.data_center, row.is_critical, existing.id],
        );
        updated += 1;
      } else {
        run(
          `INSERT INTO servers (hostname, fqdn, normalized_key, os_type, environment, business_unit, data_center, is_critical, source)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'import')`,
          [row.hostname, row.fqdn, normalized, row.os_type, row.environment, row.business_unit, row.data_center, row.is_critical],
        );
        inserted += 1;
      }
    }

    let untagged = 0;
    if (mode === 'full_replace' && seenKeys.length > 0) {
      const placeholders = seenKeys.map(() => '?').join(',');
      const result = run(
        `UPDATE servers SET active=0, updated_at=datetime('now')
         WHERE source='import' AND normalized_key NOT IN (${placeholders})`,
        seenKeys,
      );
      untagged = result.changes;
    }

    return { inserted, updated, untagged, total: rows.length };
  });
}
