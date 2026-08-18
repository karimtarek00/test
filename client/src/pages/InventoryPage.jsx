import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import TopBar from '../components/TopBar.jsx';
import { useAuth } from '../context/AuthContext.jsx';

const EMPTY_FORM = { hostname: '', fqdn: '', os_type: '', environment: '', business_unit: '', data_center: '', is_critical: false };

export default function InventoryPage() {
  const { isAdmin } = useAuth();
  const [rows, setRows] = useState([]);
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null); // null = closed, {} = new, {...server} = edit

  const load = () => {
    setLoading(true);
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    api.get(`/servers?${params.toString()}`).then((data) => setRows(data.rows)).finally(() => setLoading(false));
  };

  useEffect(load, [q]);

  return (
    <>
      <TopBar title="Inventory">
        {isAdmin && <button className="btn" onClick={() => setEditing(EMPTY_FORM)}>+ Add server</button>}
      </TopBar>
      <div className="content">
        <div className="toolbar">
          <input className="input" placeholder="Search hostname or FQDN…" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 280 }} />
          <span className="text-faint" style={{ fontSize: 12.5 }}>{rows.length} servers</span>
        </div>

        <div className="panel">
          {loading ? (
            <span className="text-dim">Loading…</span>
          ) : rows.length === 0 ? (
            <div className="empty-state">No servers yet — import an inventory file or add one manually.</div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Hostname</th>
                  <th>Data Center</th>
                  <th>OS</th>
                  <th>Environment</th>
                  <th>Open Alerts</th>
                  <th>Critical</th>
                  {isAdmin && <th></th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => (
                  <tr key={s.id}>
                    <td>{s.hostname}<div className="text-faint" style={{ fontSize: 11.5 }}>{s.fqdn}</div></td>
                    <td className="text-dim">{s.data_center || '—'}</td>
                    <td className="text-dim">{s.os_type || '—'}</td>
                    <td className="text-dim">{s.environment || '—'}</td>
                    <td>{s.open_alert_count}</td>
                    <td>{s.is_critical ? <span className="badge critical">Watchlist</span> : '—'}</td>
                    {isAdmin && (
                      <td>
                        <button className="btn-secondary btn" style={{ padding: '5px 10px', fontSize: 12 }} onClick={() => setEditing(s)}>
                          Edit
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {editing && (
        <ServerModal
          initial={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      )}
    </>
  );
}

function ServerModal({ initial, onClose, onSaved }) {
  const isNew = !initial.id;
  const [form, setForm] = useState({ ...EMPTY_FORM, ...initial, is_critical: Boolean(initial.is_critical) });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      if (isNew) {
        await api.post('/servers', form);
      } else {
        await api.put(`/servers/${initial.id}`, form);
      }
      onSaved();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <strong>{isNew ? 'Add server' : `Edit ${initial.hostname}`}</strong>
          <button className="btn-secondary btn" style={{ padding: '4px 10px' }} onClick={onClose}>✕</button>
        </div>
        <form onSubmit={submit}>
          <div className="field">
            <label>Hostname</label>
            <input className="input" value={form.hostname} onChange={set('hostname')} required />
          </div>
          <div className="field">
            <label>FQDN</label>
            <input className="input" value={form.fqdn || ''} onChange={set('fqdn')} />
          </div>
          <div className="field">
            <label>OS Type</label>
            <input className="input" value={form.os_type || ''} onChange={set('os_type')} placeholder="Windows Server 2019, RHEL 8…" />
          </div>
          <div className="field">
            <label>Environment</label>
            <input className="input" value={form.environment || ''} onChange={set('environment')} placeholder="Prod / Non-Prod" />
          </div>
          <div className="field">
            <label>Data Center</label>
            <input className="input" value={form.data_center || ''} onChange={set('data_center')} />
          </div>
          <div className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <input type="checkbox" checked={form.is_critical} onChange={set('is_critical')} id="is_critical" />
            <label htmlFor="is_critical" style={{ margin: 0 }}>On Critical Servers watchlist</label>
          </div>
          {error && <div className="error-text">{error}</div>}
          <div className="modal-actions">
            <button type="button" className="btn-secondary btn" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}
