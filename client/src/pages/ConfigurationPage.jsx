import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client.js';
import TopBar from '../components/TopBar.jsx';
import AiSettingsPanel from '../components/AiSettingsPanel.jsx';

const EMPTY_FORM = { managementServer: '', winrmUsername: '', winrmPassword: '', fullSyncIntervalMinutes: 30, autoFetchIntervalMinutes: 5, timestampAdjustmentMinutes: 0 };

export default function ConfigurationPage() {
  const [form, setForm] = useState(null);
  const [settingsRaw, setSettingsRaw] = useState(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [runStatus, setRunStatus] = useState(null);
  const [autoFetchBusy, setAutoFetchBusy] = useState(false);
  const [purgeBusy, setPurgeBusy] = useState(false);
  const [purgeResult, setPurgeResult] = useState(null);
  const pollRef = useRef(null);

  const load = () => {
    api.get('/scom/settings').then((data) => {
      const s = data.settings || {};
      setSettingsRaw(s);
      setForm({
        managementServer: s.management_server || '',
        winrmUsername: s.winrm_username || '',
        winrmPassword: '',
        fullSyncIntervalMinutes: s.full_sync_interval_minutes ?? 30,
        autoFetchIntervalMinutes: s.auto_fetch_interval_minutes ?? 5,
        timestampAdjustmentMinutes: s.timestamp_adjustment_minutes ?? 0,
      });
    });
  };

  useEffect(load, []);
  useEffect(() => () => clearInterval(pollRef.current), []);

  useEffect(() => {
    // Status-only refresh (Sync Status + Auto-Sync numbers) -- deliberately
    // does NOT touch `form`, since load() would overwrite whatever the
    // admin is mid-typing (a new password, a server address) every tick.
    // This is what actually needs to update live: an auto-fetch tick or a
    // scheduled full sync happening in the background was otherwise
    // invisible until a manual page reload.
    const timer = setInterval(() => {
      api.get('/scom/settings').then((data) => setSettingsRaw(data.settings || {})).catch(() => {});
    }, 20000);
    return () => clearInterval(timer);
  }, []);

  if (!form) return <div className="content"><span className="text-dim">Loading…</span></div>;

  const connected = settingsRaw?.last_sync_status === 'ok';
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setSaved(false);
    try {
      await api.put('/scom/settings', form);
      setSaved(true);
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const testConnection = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const data = await api.post('/scom/test', form);
      setTestResult(data);
    } catch (err) {
      setTestResult({ ok: false, error: err.message });
    } finally {
      setTesting(false);
    }
  };

  const toggleAutoFetch = async () => {
    setAutoFetchBusy(true);
    try {
      await api.post(settingsRaw?.autoFetchEnabled ? '/scom/auto-fetch/stop' : '/scom/auto-fetch/start', {});
      load();
    } finally {
      setAutoFetchBusy(false);
    }
  };

  const runSyncNow = async () => {
    const data = await api.post('/scom/run', { mode: 'full' });
    if (data.skipped) { setRunStatus({ error: data.error }); return; }
    setRunStatus({ running: true });
    pollRef.current = setInterval(async () => {
      const status = await api.get('/scom/run/status');
      setRunStatus(status);
      if (!status.running) {
        clearInterval(pollRef.current);
        load();
      }
    }, 1200);
  };

  const runRecalculate = async () => {
    if (!confirm('Re-fetch every currently open alert from SCOM and overwrite its stored timestamp with the corrected value? This only needs to run once, after a timestamp fix, to correct alerts that were already synced before it. Already-closed alerts cannot be corrected this way.')) return;
    const data = await api.post('/scom/recalculate-timestamps', {});
    if (data.skipped) { setRunStatus({ error: data.error }); return; }
    setRunStatus({ running: true });
    pollRef.current = setInterval(async () => {
      const status = await api.get('/scom/run/status');
      setRunStatus(status);
      if (!status.running) {
        clearInterval(pollRef.current);
        load();
      }
    }, 1200);
  };

  const runRecalculateServerNames = async () => {
    if (!confirm('Re-fetch every already-CLOSED alert from SCOM by ID and overwrite its stored server name with the corrected value? This only needs to run once, after a server-name resolution fix, to correct alerts that closed before it shipped. Can take a while in a large environment, and any alert SCOM has already groomed away by now cannot be corrected.')) return;
    const data = await api.post('/scom/recalculate-server-names', {});
    if (data.skipped) { setRunStatus({ error: data.error }); return; }
    setRunStatus({ running: true });
    pollRef.current = setInterval(async () => {
      const status = await api.get('/scom/run/status');
      setRunStatus(status);
      if (!status.running) {
        clearInterval(pollRef.current);
        load();
      }
    }, 1200);
  };

  const runPurgeClosedAlerts = async () => {
    const warning = 'This permanently deletes EVERY closed alert in this app -- not just the ones with a wrong server name, all of them, including any that were already correct. Open alerts are not touched. This cannot be undone from within the app. Make sure you have a backup of data\\server_watch.db before doing this.\n\nType DELETE ALL CLOSED ALERTS (exactly, in capitals) to proceed:';
    const typed = prompt(warning);
    if (typed !== 'DELETE ALL CLOSED ALERTS') {
      if (typed !== null) alert('Confirmation text did not match -- nothing was deleted.');
      return;
    }
    setPurgeBusy(true);
    setPurgeResult(null);
    try {
      const result = await api.post('/scom/purge-closed-alerts', { confirm: 'DELETE ALL CLOSED ALERTS' });
      setPurgeResult(result);
      load();
    } catch (err) {
      setPurgeResult({ ok: false, error: err.message });
    } finally {
      setPurgeBusy(false);
    }
  };

  return (
    <>
      <TopBar title="Configuration" />
      <div className="content">
        <div className="panel">
          <div className="panel-header">
            <span className="panel-title">SCOM Connection</span>
            <span className={`badge ${connected ? 'healthy' : 'warning'}`}><span className="dot" />{connected ? 'Connected' : 'Not Connected'}</span>
          </div>
          <p className="text-dim" style={{ marginTop: 0, fontSize: 13 }}>
            Pulls alerts via PowerShell Remoting (<code>Invoke-Command</code>) into the SCOM Management Server, which runs <code>Get-SCOMAlert</code> there — nothing is installed on this app's own host. The account below must have both Remote Management Users membership on the management server and a Read-Only Operator role in SCOM.
          </p>
          <form onSubmit={submit}>
            <div className="modal-grid">
              <div className="field">
                <label>Management Server</label>
                <input className="input" value={form.managementServer} onChange={set('managementServer')} placeholder="10.142.70.128 or scom-mgmt01.corp.local" />
              </div>
              <div className="field">
                <label>Username</label>
                <input className="input" value={form.winrmUsername} onChange={set('winrmUsername')} placeholder="DOMAIN\svc-scom-sync" autoComplete="off" />
              </div>
              <div className="field">
                <label>Password{settingsRaw?.hasPassword ? ' (leave blank to keep current)' : ''}</label>
                <input className="input" type="password" value={form.winrmPassword} onChange={set('winrmPassword')} autoComplete="new-password" />
              </div>
              <div className="field">
                <label>Full Sync Interval (minutes)</label>
                <input className="input" type="number" min="0" value={form.fullSyncIntervalMinutes} onChange={set('fullSyncIntervalMinutes')} />
                <span className="text-faint" style={{ fontSize: 11 }}>How often a complete fetch runs -- the only kind of sync allowed to detect closed alerts.</span>
              </div>
              <div className="field">
                <label>Auto-Sync Interval (minutes)</label>
                <input className="input" type="number" min="1" value={form.autoFetchIntervalMinutes} onChange={set('autoFetchIntervalMinutes')} />
                <span className="text-faint" style={{ fontSize: 11 }}>How often the lightweight background check runs, once Auto-Sync is enabled below.</span>
              </div>
              <div className="field">
                <label>Timestamp Adjustment (minutes)</label>
                <input className="input" type="number" step="1" value={form.timestampAdjustmentMinutes} onChange={set('timestampAdjustmentMinutes')} />
                <span className="text-faint" style={{ fontSize: 11 }}>
                  Leave at 0 unless alert times are consistently off by a fixed amount. Use the Raw Data Diagnostics
                  download below to compare a real alert's raw SCOM time against its actual time, then enter the
                  difference here (negative if this app's times run late, positive if they run early).
                </span>
              </div>
            </div>

            <div className="toggle-field">
              <label>Auto-Sync {autoFetchBusy ? '(updating…)' : ''}</label>
              <label className="toggle">
                <input type="checkbox" checked={!!settingsRaw?.autoFetchEnabled} onChange={toggleAutoFetch} disabled={autoFetchBusy} />
                <span className="track" />
              </label>
            </div>
            <div className="drawer-row"><span className="k">Auto-Sync status</span><span className="v">{settingsRaw?.autoFetchEnabled ? (settingsRaw?.last_autofetch_status === 'error' ? 'Enabled — last tick failed' : 'Enabled — running') : 'Disabled'}</span></div>
            <div className="drawer-row"><span className="k">Ticks run</span><span className="v">{settingsRaw?.auto_fetch_run_count ?? 0}</span></div>
            <div className="drawer-row"><span className="k">Last tick</span><span className="v">{settingsRaw?.last_autofetch_at ? new Date(settingsRaw.last_autofetch_at).toLocaleString() : 'Never'}</span></div>
            {settingsRaw?.last_autofetch_error && <div className="drawer-row"><span className="k">Last tick error</span><span className="v text-dim">{settingsRaw.last_autofetch_error}</span></div>}

            {error && <div className="error-text">{error}</div>}
            {saved && <div className="help-text">Saved.</div>}
            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn" type="submit">Save</button>
              <button className="btn-secondary btn" type="button" onClick={testConnection} disabled={testing}>
                {testing ? 'Testing…' : 'Test Connection'}
              </button>
            </div>
            {testResult && (
              <div className={testResult.ok ? 'help-text' : 'error-text'} style={{ marginTop: 10 }}>
                {testResult.ok ? '✓ Connected successfully.' : `✗ ${testResult.error}`}
              </div>
            )}
          </form>
        </div>

        <div className="panel">
          <div className="panel-header">
            <span className="panel-title">Sync Status</span>
          </div>
          <div className="drawer-row"><span className="k">Last sync</span><span className="v">{settingsRaw?.last_sync_at ? new Date(settingsRaw.last_sync_at).toLocaleString() : 'Never'}</span></div>
          <div className="drawer-row"><span className="k">Status</span><span className="v">{settingsRaw?.last_sync_status || '—'}</span></div>
          <div className="drawer-row"><span className="k">Open / New / Closed</span><span className="v">{settingsRaw?.last_sync_open_count ?? '—'} / {settingsRaw?.last_sync_new_count ?? '—'} / {settingsRaw?.last_sync_closed_count ?? '—'}</span></div>
          {settingsRaw?.last_sync_error && <div className="drawer-row"><span className="k">Error</span><span className="v text-dim">{settingsRaw.last_sync_error}</span></div>}
          <div style={{ marginTop: 14, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <button className="btn" type="button" onClick={runSyncNow} disabled={runStatus?.running}>
              {runStatus?.running ? 'Syncing…' : 'Run Sync Now'}
            </button>
            <button className="btn-secondary btn" type="button" onClick={runRecalculate} disabled={runStatus?.running}>
              {runStatus?.running ? 'Working…' : 'Recalculate Timestamps'}
            </button>
            <button className="btn-secondary btn" type="button" onClick={runRecalculateServerNames} disabled={runStatus?.running}>
              {runStatus?.running ? 'Working…' : 'Recalculate Server Names (Closed Alerts)'}
            </button>
          </div>
          <span className="text-faint" style={{ fontSize: 11, display: 'block', marginTop: 6 }}>
            Recalculate Timestamps is a one-time fix for alerts synced before a timestamp correction shipped -- it
            re-fetches every currently open alert from SCOM and overwrites its stored time with the corrected value.
            Already-closed alerts can't be corrected this way.
          </span>
          <span className="text-faint" style={{ fontSize: 11, display: 'block', marginTop: 6 }}>
            Recalculate Server Names is the closed-alert counterpart -- a normal sync (even "Run Sync Now") only ever
            re-checks currently open alerts, so an alert that already closed before a server-name fix shipped stays
            wrong forever otherwise. This re-fetches those closed alerts from SCOM by ID directly. Alerts SCOM has
            already groomed away by now can't be recovered this way either.
          </span>
          {runStatus?.error && <div className="error-text" style={{ marginTop: 10 }}>{runStatus.error}</div>}
          {runStatus?.lastResult && !runStatus.running && (
            <div className="help-text" style={{ marginTop: 10 }}>
              {runStatus.lastResult.ok
                ? `Done: ${runStatus.lastResult.open} open (${runStatus.lastResult.created} new, ${runStatus.lastResult.updated} updated, ${runStatus.lastResult.closed} closed).`
                : `Failed: ${runStatus.lastResult.error}`}
            </div>
          )}
          {runStatus?.lastRecalculateResult && !runStatus.running && (
            <div className="help-text" style={{ marginTop: 10 }}>
              {runStatus.lastRecalculateResult.ok
                ? `Recalculation done: ${runStatus.lastRecalculateResult.checked} open alert(s) checked, ${runStatus.lastRecalculateResult.corrected} corrected.`
                : `Recalculation failed: ${runStatus.lastRecalculateResult.error}`}
            </div>
          )}
          {runStatus?.lastRecalculateServerNamesResult && !runStatus.running && (
            <div className="help-text" style={{ marginTop: 10 }}>
              {runStatus.lastRecalculateServerNamesResult.ok
                ? `Server name recalculation done: ${runStatus.lastRecalculateServerNamesResult.totalClosedAlerts} closed alert(s) found, ${runStatus.lastRecalculateServerNamesResult.checked} still present in SCOM, ${runStatus.lastRecalculateServerNamesResult.corrected} corrected, ${runStatus.lastRecalculateServerNamesResult.notFoundInScom} already groomed away by SCOM.`
                : `Server name recalculation failed: ${runStatus.lastRecalculateServerNamesResult.error}`}
            </div>
          )}
        </div>

        <div className="panel" style={{ border: '1px solid var(--critical)' }}>
          <div className="panel-header">
            <span className="panel-title" style={{ color: 'var(--critical)' }}>Danger Zone</span>
          </div>
          <p className="help-text" style={{ marginTop: 0 }}>
            Only use this after Recalculate Server Names above still leaves alerts with a wrong server name -- that
            means SCOM has already groomed those specific alerts away and there is no data left anywhere (here or in
            SCOM) to recover their real hostname from. This deletes <strong>every</strong> closed alert, not just the
            wrong ones -- including any that already had a correct server name. Open alerts are never touched.
            Historical trend charts and the Alerts report lose that closed-alert history permanently. Back up
            <code> data\server_watch.db</code> before doing this.
          </p>
          <button className="btn-danger btn" type="button" onClick={runPurgeClosedAlerts} disabled={purgeBusy}>
            {purgeBusy ? 'Deleting…' : 'Delete ALL Closed Alerts'}
          </button>
          {purgeResult && (
            <div className={purgeResult.ok ? 'help-text' : 'error-text'} style={{ marginTop: 10 }}>
              {purgeResult.ok ? `Deleted ${purgeResult.deletedCount} closed alert(s).` : `Failed: ${purgeResult.error}`}
            </div>
          )}
        </div>

        <div className="panel">
          <div className="panel-header">
            <span className="panel-title">Raw Data Diagnostics</span>
          </div>
          <p className="help-text" style={{ marginTop: 0 }}>
            If a server name looks wrong on the dashboard, download a live sample straight from SCOM -- it shows the
            raw NetbiosComputerName / PrincipalName / MonitoringObjectDisplayName fields for each alert side by side
            with the hostname this app resolved from them and which rule was used, so a wrong name can be traced
            back to the actual source data instead of guessed at. Reads directly from SCOM -- makes no changes to
            this app's own data.
          </p>
          <div className="toolbar" style={{ flexWrap: 'wrap' }}>
            <a
              className="btn"
              href="/api/scom/run/raw-sample?limit=300"
              style={{ display: 'inline-block', textDecoration: 'none' }}
            >
              Download Raw Sample (300 alerts, Excel)
            </a>
            <a
              className="btn-secondary btn"
              href="/api/scom/export/raw-all"
              style={{ display: 'inline-block', textDecoration: 'none' }}
            >
              Export ALL Raw Alerts (Excel)
            </a>
          </div>
          <p className="help-text" style={{ marginTop: 8, marginBottom: 0 }}>
            "Export ALL" pulls every currently open alert from SCOM (not a capped sample -- the same live query a
            full sync uses) plus every closed alert on record in this app's own database, since SCOM's live query
            can't see closed alerts at all. Matches the Alarms page's total count. Raw SCOM diagnostic columns are
            blank for closed rows (a "Data Source" column marks which is which) since those fields aren't kept once
            an alert is imported. This can take a while and produce a large file in a big environment.
          </p>
        </div>

        <AiSettingsPanel />
      </div>
    </>
  );
}
