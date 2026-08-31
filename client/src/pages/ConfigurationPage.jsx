import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client.js';
import TopBar from '../components/TopBar.jsx';
import AiSettingsPanel from '../components/AiSettingsPanel.jsx';

const EMPTY_FORM = { managementServer: '', winrmUsername: '', winrmPassword: '', fullSyncIntervalMinutes: 30, autoFetchIntervalMinutes: 5 };

export default function ConfigurationPage() {
  const [form, setForm] = useState(null);
  const [settingsRaw, setSettingsRaw] = useState(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [runStatus, setRunStatus] = useState(null);
  const [autoFetchBusy, setAutoFetchBusy] = useState(false);
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
          <div style={{ marginTop: 14 }}>
            <button className="btn" type="button" onClick={runSyncNow} disabled={runStatus?.running}>
              {runStatus?.running ? 'Syncing…' : 'Run Sync Now'}
            </button>
            {runStatus?.error && <div className="error-text" style={{ marginTop: 10 }}>{runStatus.error}</div>}
            {runStatus?.lastResult && !runStatus.running && (
              <div className="help-text" style={{ marginTop: 10 }}>
                {runStatus.lastResult.ok
                  ? `Done: ${runStatus.lastResult.open} open (${runStatus.lastResult.created} new, ${runStatus.lastResult.updated} updated, ${runStatus.lastResult.closed} closed).`
                  : `Failed: ${runStatus.lastResult.error}`}
              </div>
            )}
          </div>
        </div>

        <AiSettingsPanel />
      </div>
    </>
  );
}
