# Server Watch — SCOM Server Dashboard

Server monitoring dashboard sourcing data from Microsoft SCOM. Same
reference architecture as the Network Dashboard app: Express + `node:sqlite`
backend (CommonJS, pino structured logging, session auth), React/Vite
frontend, PM2-managed (fork mode only), with the same `ops/` deploy/rollback/
service tooling.

## Status

Early scaffold. The SCOM sync engine (`src/lib/scomSync.js`) has its full
settings/scheduling/run-status lifecycle wired up, but the actual SQL query
(`fetchOpenAlerts`) is a stub pending read access to the `OperationsManager`
database — see the Configuration page. Everything else (auth, inventory,
alerts, import, reports, critical watchlist, health score) is functional
against locally imported/seeded data.

## Quick start

```bash
npm install
npm run seed          # loads seed-data/*.xlsx sample SCOM alert exports
npm run dev:server      # backend on :5352
npm run dev:client      # frontend on :5173 (proxies /api to :5352), separate terminal
```

Open http://localhost:5173 and sign in with:
- `admin` / `admin123` (full access)
- `viewer` / `viewer123` (read-only)

**Change these passwords after first login** (Users page, admin only).

## Production build & run

```bash
npm run build     # builds client into public/, copies src/ -> dist/
npm start           # runs dist/index.js directly (NODE_ENV must be set separately)
```

Or via PM2 (fork mode only — see `ecosystem.config.js`):

```bash
node ops/setup.js     # one-time: creates logs/, backups/, starts under PM2
npm run service:status
npm run logs:tail
```

### Alternative: Windows Service via NSSM (no PM2)

For a Windows server where PM2 itself turns out to be the unreliable part
(seen in practice: PM2's own bundled files intermittently missing, usually
endpoint AV quarantining something during a crash-restart loop) — NSSM
wraps `node dist/index.js` directly as a real Windows Service instead, one
fewer moving part between the OS and the app.

NSSM itself has to be vendored in once (`ops/vendor/nssm.exe`) since neither
a locked-down production server nor this project's own build environment
can reach nssm.cc — see `ops/vendor/README.md` for the one-time manual
download. Once it's in place, from an elevated (Administrator) prompt:

```bash
npm run setup:windows-service
sc start "server-watch-svc"
npm run service:status
```

`service:status` / `:start` / `:stop` / `:restart` all detect automatically
whether the NSSM service is installed and use it instead of PM2 — same
commands either way, nothing else to remember.

### Deploy / rollback

```bash
node ops/deploy.js <path-to-built-bundle.zip-or-dir>   # backs up current version, swaps in new, health-gates, auto-rolls-back on failure
node ops/rollback.js list                               # show available backups
node ops/rollback.js                                    # restore the most recent
```

Every deploy snapshots the current version into `backups/<timestamp>/`
before swapping anything — that backup is what a rollback restores.

## Project layout

- `src/` — server source (dev runs this directly via `npm run dev:server`)
- `dist/` — built server (`src/` copied verbatim by `scripts/build-server.js`; what production/PM2 actually runs)
- `client/` — React app source
- `public/` — built client assets (Vite output, served by Express in production)
- `db/schema.sql` — SQLite schema (servers, alerts, import_jobs, scom_settings, users, sessions)
- `ops/` — deploy, rollback, setup, cli, log rotation tooling
- `seed/` — `seed.js` + sample SCOM Console alert exports (`seed-data/`)
- `backups/` — snapshots created by `ops/deploy.js`/`ops/rollback.js` (and one pre-restructure snapshot from this session)
- `logs/` — PM2-captured stdout/stderr (pino JSON), rotated by `ops/rotateLogs.js`

## SCOM SQL sync

`src/lib/scomSync.js` connects to `OperationsManager` via `mssql` and syncs the
`Alert`/`BaseManagedEntity` tables (incremental + full modes, closure
detection gated on a complete fetch, first-seen `created_at`/TimeRaised vs
last-seen `last_modified`/LastModified kept as two separate fields per the
correctness rule that bit a similar integration before). Table/column names
match SCOM's documented schema but haven't been run against a live instance
in this environment — verify once real SQL access is available, and adjust
the query in `fetchOpenAlerts()` if this installation's schema differs.
Configuration page has Test Connection + Run Sync Now with live progress.

## AI integration

`src/lib/aiClient.js` (generic chat-completions HTTP client, tolerant of
minor response-shape differences between gateways) + `src/lib/aiDigest.js`
(compact real-data digest + grounding system prompt) + `src/routes/ai.js`
power a Dashboard insights card and a floating "Ask AI" chat widget —
both hidden until an admin configures and enables it on the Configuration
page. Nothing is sent to any endpoint until Enabled is checked.

## Known gaps (next steps)

1. **Server inventory** — currently seeded/derived from alert data only; import a real export via Import Data once available.
2. **Classification axis** (OS / Prod-Non-Prod / business unit) and Critical Servers grouping are placeholders — currently grouped by a guessed data-center prefix from hostnames.
3. **Word/Excel reports** — only the PDF summary report is implemented so far; `docx`/`xlsx` report generation can be added to `src/lib/reportGenerators.js` the same way.
