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
  const [devicesAffected, setDevicesAffected] = useState(0);
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null); // null = closed, {} = new, {...server} = edit
  const [viewing, setViewing] = useState(null); // hostname/id of the server whose alarm drawer is open

  useEffect(() => setPage(1), [q]);

  const load = () => {
    setLoading(true);
    const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
    if (q) params.set('search', q);
    // Every KPI/count here comes straight from the API's own total, never
    // derived from rows.length -- a page-capped list must never masquerade
    // as a full count (see the brief's "never silently cap a total" lesson).
    api.get(`/servers?${params.toString()}`).then((data) => { setRows(data.servers); setTotal(data.total); setDevicesAffected(data.devicesAffected); }).finally(() => setLoading(false));
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
          <span className={`badge ${devicesAffected > 0 ? 'warning' : 'healthy'}`} style={{ marginLeft: 4 }}>
            <span className="dot" />{devicesAffected} device{devicesAffected === 1 ? '' : 's'} affected
          </span>
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
                    <th></th>
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
                      <td style={{ display: 'flex', gap: 6 }}>
                        <button className="btn-secondary btn" style={{ padding: '5px 10px', fontSize: 12 }} onClick={() => setViewing(s)}>
                          Alarms
                        </button>
                        {isAdmin && (
                          <button className="btn-secondary btn" style={{ padding: '5px 10px', fontSize: 12 }} onClick={() => setEditing(s)}>
                            Edit
                          </button>
                        )}
                      </td>
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

      {viewing && <ServerAlarmsModal server={viewing} onClose={() => setViewing(null)} />}
    </>
  );
}

function ServerAlarmsModal({ server, onClose }) {
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    api.get(`/servers/${server.id}`).then(setDetail).finally(() => setLoading(false));
  }, [server.id]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 720 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <strong>{server.hostname} — Alarms</strong>
          <button className="modal-close" onClick={onClose}><IconClose /></button>
        </div>
        {loading ? (
          <div style={{ padding: '20px 0' }}><span className="text-dim">Loading…</span></div>
        ) : !detail ? (
          <div className="empty-state">Could not load this server's alarms.</div>
        ) : (
          <>
            <div className="drawer-row"><span className="k">Total alerts (all-time)</span><span className="v">{detail.totalAlertCount}</span></div>
            <div className="drawer-row"><span className="k">Critical &amp; open</span><span className="v">{detail.totalCriticalOpenCount}</span></div>
            {detail.health && <div className="drawer-row"><span className="k">Health score</span><span className="v">{detail.health.healthScore} / 100</span></div>}
            {detail.alerts.length === 0 ? (
              <div className="empty-state" style={{ marginTop: 12 }}>No alarms recorded for this server.</div>
            ) : (
              <div className="table-wrap" style={{ maxHeight: 420, overflowY: 'auto', marginTop: 12 }}>
                <table>
                  <thead>
                    <tr>
                      <th>Alert Name</th>
                      <th>Severity</th>
                      <th>State</th>
                      <th>Raised</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.alerts.map((a) => (
                      <tr key={a.id}>
                        <td style={{ maxWidth: 300, whiteSpace: 'normal' }}>{a.alert_name}</td>
                        <td>
                          <span className={`badge ${a.severity === 'Critical' ? 'critical' : a.severity === 'Warning' ? 'warning' : 'information'}`}>
                            <span className="dot" />{a.severity}
                          </span>
                        </td>
                        <td className="text-dim">{a.resolution_state_label}</td>
                        <td className="text-dim">{new Date(a.created_at).toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {detail.alerts.length >= 200 && (
                  <div className="text-faint" style={{ fontSize: 11, padding: '8px 0' }}>
                    Showing the 200 most recent -- use the Alarms page (filtered by this server) for the complete history.
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
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
