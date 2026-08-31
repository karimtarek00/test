import { useEffect, useState } from 'react';
import { api } from '../api/client.js';

const EMPTY = { baseUrl: '', apiKey: '', authHeader: 'Authorization', authScheme: 'Bearer', model: '', allowInsecureTls: false, enabled: false };

export default function AiSettingsPanel() {
  const [form, setForm] = useState(null);
  const [raw, setRaw] = useState(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);

  const load = () => {
    api.get('/ai/settings').then((data) => {
      const s = data.settings || {};
      setRaw(s);
      setForm({
        baseUrl: s.base_url || '',
        apiKey: s.hasApiKey ? '••••••••' : '',
        authHeader: s.auth_header || 'Authorization',
        authScheme: s.auth_scheme ?? 'Bearer',
        model: s.model || '',
        allowInsecureTls: !!s.allow_insecure_tls,
        enabled: !!s.enabled,
      });
    });
  };

  useEffect(load, []);
  if (!form) return null;

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setSaved(false);
    const payload = { ...form };
    if (payload.apiKey === '••••••••') delete payload.apiKey;
    try {
      await api.put('/ai/settings', payload);
      setSaved(true);
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const test = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const payload = { ...form };
      if (payload.apiKey === '••••••••') delete payload.apiKey;
      const data = await api.post('/ai/test', payload);
      setTestResult(data);
    } catch (err) {
      setTestResult({ ok: false, error: err.message });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="panel">
      <div className="panel-header">
        <span className="panel-title">AI Integration</span>
        <span className={`badge ${form.enabled && raw?.last_test_status === 'ok' ? 'healthy' : 'warning'}`}>
          <span className="dot" />{form.enabled ? (raw?.last_test_status === 'ok' ? 'Connected' : 'Enabled') : 'Disabled'}
        </span>
      </div>
      <p className="text-dim" style={{ marginTop: 0, fontSize: 13 }}>
        Points at your internal AI gateway's chat-completions endpoint. Powers the Dashboard insights card and the Ask AI chat widget, grounded in this app's real, current data — nothing here is sent anywhere until Enabled is checked.
      </p>
      <form onSubmit={submit}>
        <div className="modal-grid">
          <div className="field">
            <label>Endpoint URL</label>
            <input className="input" value={form.baseUrl} onChange={set('baseUrl')} placeholder="https://ai-gateway.corp.local/v1/chat/completions" />
          </div>
          <div className="field">
            <label>Model (optional)</label>
            <input className="input" value={form.model} onChange={set('model')} placeholder="gpt-4o, claude-... (if required)" />
          </div>
          <div className="field">
            <label>API Key</label>
            <input type="password" className="input" value={form.apiKey} onChange={set('apiKey')} />
          </div>
          <div className="field">
            <label>Auth Header</label>
            <input className="input" value={form.authHeader} onChange={set('authHeader')} placeholder="Authorization" />
          </div>
          <div className="field">
            <label>Auth Scheme</label>
            <input className="input" value={form.authScheme} onChange={set('authScheme')} placeholder="Bearer (blank = no prefix)" />
          </div>
        </div>

        <div className="toggle-field">
          <label>Allow insecure TLS (self-signed internal certificate)</label>
          <label className="toggle">
            <input type="checkbox" checked={form.allowInsecureTls} onChange={set('allowInsecureTls')} />
            <span className="track" />
          </label>
        </div>
        <div className="toggle-field">
          <label>Enabled</label>
          <label className="toggle">
            <input type="checkbox" checked={form.enabled} onChange={set('enabled')} />
            <span className="track" />
          </label>
        </div>

        {error && <div className="error-text">{error}</div>}
        {saved && <div className="help-text">Saved.</div>}
        <div style={{ display: 'flex', gap: 10 }}>
          <button className="btn" type="submit">Save</button>
          <button className="btn-secondary btn" type="button" onClick={test} disabled={testing}>
            {testing ? 'Testing…' : 'Test Connection'}
          </button>
        </div>
        {testResult && (
          <div className={testResult.ok ? 'help-text' : 'error-text'} style={{ marginTop: 10 }}>
            {testResult.ok ? `✓ Connected — replied: "${testResult.reply}"` : `✗ ${testResult.error}`}
          </div>
        )}
      </form>
    </div>
  );
}
