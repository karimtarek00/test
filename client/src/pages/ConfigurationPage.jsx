import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client.js';
import TopBar from '../components/TopBar.jsx';
import AiSettingsPanel from '../components/AiSettingsPanel.jsx';

const EMPTY_FORM = { managementServer: '', fullSyncIntervalMinutes: 30 };

export default function ConfigurationPage() {
  const [form, setForm] = useState(null);
  const [settingsRaw, setSettingsRaw] = useState(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [runStatus, setRunStatus] = useState(null);
  const pollRef = useRef(null);

  const load = () => {
    api.get('/scom/settings').then((data) => {
      const s = data.settings || {};
      setSettingsRaw(s);
      setForm({
        managementServer: s.management_server || '',
        fullSyncIntervalMinutes: s.full_sync_interval_minutes ?? 30,
      });
    });
  };

  useEffect(load, []);
  useEffect(() => () => clearInterval(pollRef.current), []);

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
            Pulls alerts via the SCOM PowerShell module (<code>Get-SCOMAlert</code>) — no credentials stored here; this app's own Windows identity authenticates. Leave Management Server blank if this app runs directly on (or is already connected to) a SCOM Management Server; otherwise enter the management server's hostname to connect remotely (requires the SCOM Operations Console installed on this app's host).
          </p>
          <form onSubmit={submit}>
            <div className="modal-grid">
              <div className="field">
                <label>Management Server (optional)</label>
                <input className="input" value={form.managementServer} onChange={set('managementServer')} placeholder="scom-mgmt01.corp.local" />
              </div>
              <div className="field">
                <label>Full Sync Interval (minutes)</label>
                <input className="input" type="number" min="0" value={form.fullSyncIntervalMinutes} onChange={set('fullSyncIntervalMinutes')} />
              </div>
            </div>
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
