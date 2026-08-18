import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import TopBar from '../components/TopBar.jsx';

const EMPTY_FORM = { sqlHost: '', sqlPort: '', sqlDatabase: '', sqlUsername: '', sqlPassword: '', fullSyncIntervalMinutes: 30 };

export default function ConfigurationPage() {
  const [form, setForm] = useState(null);
  const [connected, setConnected] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  const load = () => {
    api.get('/scom/settings').then((data) => {
      const s = data.settings || {};
      setForm({
        sqlHost: s.sql_host || '',
        sqlPort: s.sql_port || '',
        sqlDatabase: s.sql_database || '',
        sqlUsername: s.sql_username || '',
        sqlPassword: s.hasPassword ? '••••••••' : '',
        fullSyncIntervalMinutes: s.full_sync_interval_minutes ?? 30,
      });
      setConnected(!!(s.sql_host && s.last_sync_status === 'ok'));
    });
  };

  useEffect(load, []);

  if (!form) return <div className="content"><span className="text-dim">Loading…</span></div>;

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setSaved(false);
    const payload = { ...form };
    if (payload.sqlPassword === '••••••••') delete payload.sqlPassword; // unchanged - keep existing credential
    try {
      await api.put('/scom/settings', payload);
      setSaved(true);
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <>
      <TopBar title="Configuration" />
      <div className="content">
        <div className="panel">
          <div className="panel-header">
            <span className="panel-title">SCOM SQL Connection</span>
            <span className={`badge ${connected ? 'healthy' : 'warning'}`}><span className="dot" />{connected ? 'Connected' : 'Not Connected'}</span>
          </div>
          <p className="text-dim" style={{ marginTop: 0, fontSize: 13 }}>
            Read-only login to the <code>OperationsManager</code> database. The sync engine (
            <code>src/lib/scomSync.js</code>) is scaffolded but stays disabled until these are set and the actual SQL query is wired in.
          </p>
          <form onSubmit={submit}>
            <div className="modal-grid">
              <div className="field">
                <label>SQL Host</label>
                <input className="input" value={form.sqlHost} onChange={set('sqlHost')} placeholder="scom-sql01.corp.local" />
              </div>
              <div className="field">
                <label>Port</label>
                <input className="input" value={form.sqlPort} onChange={set('sqlPort')} placeholder="1433" />
              </div>
              <div className="field">
                <label>Database</label>
                <input className="input" value={form.sqlDatabase} onChange={set('sqlDatabase')} placeholder="OperationsManager" />
              </div>
              <div className="field">
                <label>Full Sync Interval (minutes)</label>
                <input className="input" type="number" min="0" value={form.fullSyncIntervalMinutes} onChange={set('fullSyncIntervalMinutes')} />
              </div>
              <div className="field">
                <label>Username</label>
                <input className="input" value={form.sqlUsername} onChange={set('sqlUsername')} />
              </div>
              <div className="field">
                <label>Password</label>
                <input type="password" className="input" value={form.sqlPassword} onChange={set('sqlPassword')} />
              </div>
            </div>
            {error && <div className="error-text">{error}</div>}
            {saved && <div className="help-text">Saved.</div>}
            <button className="btn" type="submit">Save</button>
          </form>
        </div>
      </div>
    </>
  );
}
