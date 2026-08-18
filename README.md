# Server Watch — SCOM Server Dashboard

Server monitoring dashboard sourcing data from Microsoft SCOM. Express +
`node:sqlite` backend, React/Vite frontend, PM2-managed (fork mode only).

## Status

Early scaffold. The SCOM sync engine (`server/src/lib/scomSync.js`) is stubbed
out pending SQL read access to the `OperationsManager` database — see
Configuration page. Everything else (auth, inventory, alarms, import,
reports, critical watchlist) is functional against locally imported/seeded
data.

## Quick start

```bash
npm install
npm run seed      # creates admin/viewer users + loads seed-data/*.xlsx sample alerts
npm run dev        # backend on :4000, frontend on :5173 (proxies /api to :4000)
```

Open http://localhost:5173 and sign in with:
- `admin` / `ChangeMe123!` (full access)
- `viewer` / `ChangeMe123!` (read-only)

**Change these passwords after first login** (Users page, admin only).

## Production build

```bash
npm run build      # builds client into dist/
npm start           # serves dist/ + API on :4000 (NODE_ENV=production)
```

Or via PM2 (fork mode only — see `ecosystem.config.js`):

```bash
npx pm2 start ecosystem.config.js
```

## Project layout

- `server/src/` — Express app, routes, lib (db, auth, import, health score, reports, SCOM sync stub)
- `client/src/` — React app (pages, components, API client)
- `db/schema.sql` — SQLite schema (users, sessions, servers, alerts, import_jobs, settings)
- `seed-data/` — sample SCOM Console alert exports used by `npm run seed`

## Known gaps (next steps)

1. SCOM SQL sync engine not wired in — needs `OperationsManager` DB credentials (Configuration page has the form; `scomSync.js` needs the `mssql` client implementation once access is available).
2. Server inventory is currently seeded/derived from alert data only — import a real export via Import Data once available.
3. Classification axis (OS/Prod-Non-Prod/business unit) and Critical Servers grouping are placeholders — currently grouped by a guessed data-center prefix.
4. `ops/` deploy/rollback tooling from the reference architecture not yet ported.
5. AI insights integration not yet ported (pending confirmation of an internal AI gateway to reuse).
