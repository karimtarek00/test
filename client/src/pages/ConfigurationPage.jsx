import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import TopBar from '../components/TopBar.jsx';

export default function ConfigurationPage() {
  const [settings, setSettings] = useState(null);
  const [syncConfigured, setSyncConfigured] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get('/config').then((data) => {
      setSettings(data.settings);
      setSyncConfigured(data.syncConfigured);
    });
  }, []);

  if (!settings) return <div className="content"><span className="text-dim">Loading…</span></div>;

  const set = (key) => (e) => setSettings((s) => ({ ...s, [key]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setSaved(false);
    const payload = { ...settings };
    if (payload.scom_sql_password === '••••••••') delete payload.scom_sql_password; // unchanged - don't overwrite
    try {
      await api.put('/config', payload);
      setSaved(true);
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
            <span className={`badge ${syncConfigured ? 'closed' : 'warning'}`}>{syncConfigured ? 'Configured' : 'Not connected'}</span>
          </div>
          <p className="text-dim" style={{ marginTop: 0, fontSize: 13 }}>
            Read-only login to the <code>OperationsManager</code> database. The sync engine (
            <code>scomSync.js</code>) is scaffolded but stays disabled until these are set and verified.
          </p>
          <form onSubmit={submit}>
            <div className="field">
              <label>SQL Host</label>
              <input className="input" value={settings.scom_sql_host || ''} onChange={set('scom_sql_host')} placeholder="scom-sql01.corp.local" />
            </div>
            <div className="field">
              <label>Port</label>
              <input className="input" value={settings.scom_sql_port || ''} onChange={set('scom_sql_port')} placeholder="1433" />
            </div>
            <div className="field">
              <label>Database</label>
              <input className="input" value={settings.scom_sql_database || ''} onChange={set('scom_sql_database')} placeholder="OperationsManager" />
            </div>
            <div className="field">
              <label>Username</label>
              <input className="input" value={settings.scom_sql_username || ''} onChange={set('scom_sql_username')} />
            </div>
            <div className="field">
              <label>Password</label>
              <input type="password" className="input" value={settings.scom_sql_password || ''} onChange={set('scom_sql_password')} />
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
