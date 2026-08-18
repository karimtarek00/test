import { useState } from 'react';
import { api } from '../api/client.js';
import TopBar from '../components/TopBar.jsx';

export default function ImportDataPage() {
  return (
    <>
      <TopBar title="Import Data" />
      <div className="content">
        <AlertsImportPanel type="active" title="Import Active Alerts" />
        <AlertsImportPanel type="closed" title="Import Closed Alerts" />
        <ServersImportPanel />
      </div>
    </>
  );
}

function AlertsImportPanel({ type, title }) {
  const [file, setFile] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (!file) return;
    setBusy(true);
    setError('');
    setResult(null);
    const formData = new FormData();
    formData.append('file', file);
    formData.append('alertsType', type);
    try {
      const data = await api.post('/import/alerts', formData);
      setResult(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel">
      <div className="panel-header"><span className="panel-title">{title}</span></div>
      <p className="text-dim" style={{ marginTop: 0, fontSize: 13 }}>
        Expects the SCOM Console export columns: Severity, Source, Name, Resolution State, Created.
      </p>
      <form onSubmit={submit} style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <input type="file" accept=".xlsx" onChange={(e) => setFile(e.target.files[0])} />
        <button className="btn" disabled={!file || busy}>{busy ? 'Importing…' : 'Import'}</button>
      </form>
      {error && <div className="error-text">{error}</div>}
      {result && (
        <div className="help-text">
          Parsed {result.total} rows → inserted {result.inserted}, skipped {result.skipped} (already present).
        </div>
      )}
    </div>
  );
}

function ServersImportPanel() {
  const [file, setFile] = useState(null);
  const [mode, setMode] = useState('additive');
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (!file) return;
    setBusy(true);
    setError('');
    setResult(null);
    const formData = new FormData();
    formData.append('file', file);
    formData.append('mode', mode);
    try {
      const data = await api.post('/import/servers', formData);
      setResult(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel">
      <div className="panel-header"><span className="panel-title">Import Server Inventory</span></div>
      <p className="text-dim" style={{ marginTop: 0, fontSize: 13 }}>
        Flexible column matching (Hostname/Server/Name, FQDN, OS, Environment, Business Unit, Data Center, Critical).
      </p>
      <form onSubmit={submit} style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <input type="file" accept=".xlsx" onChange={(e) => setFile(e.target.files[0])} />
        <select className="input" value={mode} onChange={(e) => setMode(e.target.value)}>
          <option value="additive">Additive (add/update only)</option>
          <option value="full_replace">Full replace (untags servers missing from file)</option>
        </select>
        <button className="btn" disabled={!file || busy}>{busy ? 'Importing…' : 'Import'}</button>
      </form>
      {error && <div className="error-text">{error}</div>}
      {result && (
        <div className="help-text">
          Parsed {result.total} rows → inserted {result.inserted}, updated {result.updated}
          {mode === 'full_replace' && `, untagged ${result.untagged}`}.
        </div>
      )}
    </div>
  );
}
