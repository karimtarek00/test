import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import TopBar from '../components/TopBar.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { IconSearch, IconClose } from '../components/icons.jsx';

const EMPTY_FORM = { hostname: '', fqdn: '', os_type: '', environment: '', business_unit: '', data_center: '', is_critical: false };
const PAGE_SIZE = 50;

export default function InventoryPage() {
  const { isAdmin } = useAuth();
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null); // null = closed, {} = new, {...server} = edit

  useEffect(() => setPage(1), [q]);

  const load = () => {
    setLoading(true);
    const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
    if (q) params.set('search', q);
    // Every KPI/count here comes straight from the API's own total, never
    // derived from rows.length -- a page-capped list must never masquerade
    // as a full count (see the brief's "never silently cap a total" lesson).
    api.get(`/servers?${params.toString()}`).then((data) => { setRows(data.servers); setTotal(data.total); }).finally(() => setLoading(false));
  };

  useEffect(load, [q, page]);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <>
      <TopBar title="Inventory">
        {isAdmin && <button className="btn" onClick={() => setEditing(EMPTY_FORM)}>+ Add Server</button>}
      </TopBar>
      <div className="content">
        <div className="toolbar">
          <div className="input-icon-wrap" style={{ width: 280 }}>
            <IconSearch />
            <input className="input" placeholder="Search hostname or FQDN…" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <span className="text-faint" style={{ fontSize: 12.5 }}>{total} servers</span>
        </div>

        <div className="panel">
          {loading ? (
            <span className="text-dim">Loading…</span>
          ) : rows.length === 0 ? (
            <div className="empty-state">No servers yet — import an inventory file or add one manually.</div>
          ) : (
            <>
            <div className="table-wrap">
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
                    <tr key={s.id} className="row-hover">
                      <td>
                        <div className="cell-mono">{s.hostname}</div>
                        <div className="text-faint" style={{ fontSize: 11 }}>{s.fqdn}</div>
                      </td>
                      <td className="text-dim">{s.data_center || '—'}</td>
                      <td className="text-dim">{s.os_type || '—'}</td>
                      <td className="text-dim">{s.environment || '—'}</td>
                      <td>{s.open_alert_count}</td>
                      <td>{s.is_critical ? <span className="badge critical"><span className="dot" />Watchlist</span> : '—'}</td>
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
            </div>
            <div className="table-footer">
              <span>Showing {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, total)} of {total} entries</span>
              <div className="pager">
                <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>‹</button>
                <button className="active">{page}</button>
                <span className="text-faint" style={{ padding: '0 4px' }}>of {totalPages}</span>
                <button disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>›</button>
              </div>
            </div>
            </>
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
          <strong>{isNew ? 'Add Server' : `Edit ${initial.hostname}`}</strong>
          <button className="modal-close" onClick={onClose}><IconClose /></button>
        </div>
        <form onSubmit={submit}>
          <div className="modal-grid">
            <div className="field">
              <label>Hostname</label>
              <input className="input" value={form.hostname} onChange={set('hostname')} placeholder="Enter hostname" required />
            </div>
            <div className="field">
              <label>Environment</label>
              <input className="input" value={form.environment || ''} onChange={set('environment')} placeholder="Prod / Non-Prod" />
            </div>
            <div className="field">
              <label>FQDN</label>
              <input className="input" value={form.fqdn || ''} onChange={set('fqdn')} placeholder="Enter FQDN" />
            </div>
            <div className="field">
              <label>Data Center</label>
              <input className="input" value={form.data_center || ''} onChange={set('data_center')} placeholder="Select data center" />
            </div>
            <div className="field">
              <label>OS</label>
              <input className="input" value={form.os_type || ''} onChange={set('os_type')} placeholder="Windows Server 2019, RHEL 8…" />
            </div>
            <div className="field">
              <label>Business Unit</label>
              <input className="input" value={form.business_unit || ''} onChange={set('business_unit')} placeholder="Optional" />
            </div>
          </div>

          <div className="toggle-field">
            <label htmlFor="is_critical">Critical Server — on watchlist</label>
            <label className="toggle">
              <input type="checkbox" id="is_critical" checked={form.is_critical} onChange={set('is_critical')} />
              <span className="track" />
            </label>
          </div>

          {error && <div className="error-text">{error}</div>}
          <div className="modal-actions">
            <button type="button" className="btn-secondary btn" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn" disabled={saving}>{saving ? 'Saving…' : 'Add Server'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}
