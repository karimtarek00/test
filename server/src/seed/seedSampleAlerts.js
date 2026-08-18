import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAlertsWorkbook, upsertAlerts } from '../lib/importPipeline.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, '..', '..', '..');
const seedDataDir = path.join(rootDir, 'seed-data');

const files = [
  { name: 'Active_Alerts.xlsx', label: 'active' },
  { name: 'Closed_Alerts.xlsx', label: 'closed' },
];

for (const file of files) {
  const filePath = path.join(seedDataDir, file.name);
  if (!fs.existsSync(filePath)) {
    console.log(`Skipping ${file.name} - not found in seed-data/`);
    continue;
  }
  const buffer = fs.readFileSync(filePath);
  const rows = parseAlertsWorkbook(buffer);
  const result = await upsertAlerts(rows, { origin: 'import' });
  console.log(`${file.name}: parsed ${rows.length} rows -> inserted ${result.inserted}, skipped ${result.skipped} (already present)`);
}
