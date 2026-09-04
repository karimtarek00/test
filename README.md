# Server Watch — SCOM Server Dashboard

Server monitoring dashboard sourcing data from Microsoft SCOM. Same
reference architecture as the Network Dashboard app: Express + `node:sqlite`
backend (CommonJS, pino structured logging, session auth), React/Vite
frontend, PM2-managed (fork mode only), with the same `ops/` deploy/rollback/
service tooling.

## Status

Functional end-to-end against a real SCOM environment. The SCOM sync engine
(`src/lib/scomSync.js`) pulls alerts via PowerShell Remoting
(`Invoke-Command`) into the actual SCOM Management Server, which runs
`Get-SCOMAlert` there — verified against 18,750+ real active alerts. Auth,
inventory, alerts, import, reports (PDF/Word/Excel), analysis, AI chat, and
critical watchlist are all live. See "SCOM sync (WinRM)" below for setup,
including a one-time WinRM client prerequisite that bites on every new
server this app is moved to.

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

## SCOM sync (WinRM)

`src/lib/scomSync.js` pulls alerts via PowerShell Remoting
(`Invoke-Command -ComputerName <management-server> -Credential $cred`) into
the real SCOM Management Server, which runs `Get-SCOMAlert` there — nothing
is installed on this app's own host, and no direct database or local
PowerShell module access is needed. The account used must have BOTH Remote
Management Users membership on the management server AND a SCOM Read-Only
Operator role, on the same account (`Invoke-Command` authenticates as one
identity). Incremental + full sync modes, closure detection gated on a
complete fetch, first-seen `created_at`/TimeRaised vs last-seen
`last_modified`/LastModified kept as two separate fields (a re-sync never
overwrites when an alert first fired). Configuration page has Test
Connection, Run Sync Now, Auto-Sync scheduling, a Recalculate Timestamps
one-time correction tool, and a Raw Data Diagnostics export for tracing a
wrong server name or timestamp back to the actual SCOM data that produced
it.

### One-time WinRM client prerequisite (every new server this app runs on)

The FIRST time this app runs on a given Windows server — including after
moving it to a new production box — a sync attempt can fail with:

```
The WinRM client cannot process the request. Default authentication may
be used with an IP address under the following conditions: the transport
is HTTPS or the destination is in the TrustedHosts list...
```

This is a Windows WinRM *client* setting on the machine running Server
Watch, not an app bug — it has nothing to do with the app's own code or
configuration. Windows' default WinRM authentication (Negotiate/Kerberos)
refuses to connect to a bare IP address unless that IP is explicitly
trusted, since Kerberos can't be verified without a resolvable hostname/SPN.
A domain-joined server talking to another server by hostname often doesn't
hit this at all; a workgroup server, or one connecting by IP (as this app
does, to the management server's IP), does.

Fix once per server, from an elevated (Administrator) PowerShell prompt:

```powershell
winrm quickconfig -quiet
Set-Item WSMan:\localhost\Client\TrustedHosts -Value "<management-server-ip-or-hostname>" -Concatenate -Force
Get-Item WSMan:\localhost\Client\TrustedHosts   # verify it's listed
```

Then retry Test Connection on the Configuration page. `-Concatenate` adds
to the existing list rather than replacing it, safe to run even if
TrustedHosts already has other entries.

## AI integration

`src/lib/aiClient.js` (generic chat-completions HTTP client, tolerant of
minor response-shape differences between gateways, including a gateway that
emits tool-call requests as plain `<tool_call>` text instead of the OpenAI
`tool_calls` field) + `src/lib/aiDigest.js` (real-data digest covering
fleet/alerts, SCOM sync status, reports, imports, and users, plus a
grounding system prompt and a static "how this app works" reference) +
`src/lib/aiTools.js` (function-calling tools so the AI can look up one
specific server or alert by name, not just aggregates) + `src/routes/ai.js`
power a Dashboard insights card (auto-refreshes in the background) and a
floating "Ask AI" chat widget — both hidden until an admin configures and
enables it on the Configuration page. Nothing is sent to any endpoint until
Enabled is checked.

## Known gaps (next steps)

1. **Server inventory classification axis** (OS type / environment / business unit / data center) is mostly unpopulated for sync-created servers — SCOM's alert data doesn't carry these directly; would need either a separate inventory import or a richer SCOM query.
2. **Historical timestamp correction** only reaches currently-open alerts (Configuration page's Recalculate Timestamps) — an already-closed alert's timestamp, if it was synced before a timezone fix, can't be re-derived since SCOM's live query no longer returns it.
3. **AI tool-calling** depends on the configured gateway/model actually supporting function calling (either the OpenAI `tool_calls` field or the `<tool_call>` text convention this app also recognizes) — a gateway using neither will still chat normally, just without the ability to look up one specific server/alert by name.
