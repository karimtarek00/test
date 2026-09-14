import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import TopBar from '../components/TopBar.jsx';
import SeverityBadge, { ResolutionBadge } from '../components/SeverityBadge.jsx';
import { IconSearch } from '../components/icons.jsx';

const PAGE_SIZE = 25;

// Category dropdown options, not a stored/fabricated taxonomy -- picking
// one just sends that word as the alertName filter and relies on the
// existing partial (LIKE) match against real alert_name text, the same
// match alertFilters.js already does for the AI and the Analysis page. A
// server with "MSSQL on Windows: CPU Utilization (%) is too high" and one
// with "Total CPU Utilization Percentage is too high" both show up under
// "CPU" without either of them being reclassified into some new field.
const CATEGORY_SHORTCUTS = ['CPU', 'Memory', 'Disk', 'Backup', 'Cluster', 'Database', 'Network'];

export default function AlarmsPage() {
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [severity, setSeverity] = useState('');
  const [resolution, setResolution] = useState('open');
  const [alertName, setAlertName] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);

  useEffect(() => setPage(1), [severity, resolution, alertName, from, to, q]);

  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
    if (severity) params.set('severity', severity);
    if (resolution) params.set('resolution', resolution);
    if (alertName) params.set('alertName', alertName);
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    if (q) params.set('q', q);
    api
      .get(`/alerts?${params.toString()}`)
      .then((data) => {
        setRows(data.alerts);
        setTotal(data.total);
      })
      .finally(() => setLoading(false));
  }, [severity, resolution, alertName, from, to, q, page]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <>
      <TopBar title="Alerts" />
      <div className="content">
        <div className="toolbar" style={{ flexWrap: 'wrap' }}>
          <div className="input-icon-wrap" style={{ width: 260 }}>
            <IconSearch />
            <input className="input" placeholder="Search alert or server…" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <select className="input" style={{ width: 160 }} value={severity} onChange={(e) => setSeverity(e.target.value)}>
            <option value="">All severities</option>
            <option value="Critical">Critical</option>
            <option value="Warning">Warning</option>
            <option value="Information">Information</option>
          </select>
          <select className="input" style={{ width: 140 }} value={resolution} onChange={(e) => setResolution(e.target.value)}>
            <option value="open">Open only</option>
            <option value="closed">Closed only</option>
            <option value="">All</option>
          </select>
          <select className="input" style={{ width: 180 }} value={alertName} onChange={(e) => setAlertName(e.target.value)}>
            <option value="">All categories</option>
            {CATEGORY_SHORTCUTS.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
          <input className="input" type="date" style={{ width: 150 }} value={from} onChange={(e) => setFrom(e.target.value)} title="From date" />
          <input className="input" type="date" style={{ width: 150 }} value={to} onChange={(e) => setTo(e.target.value)} title="To date" />
          {(severity || resolution !== 'open' || alertName || from || to || q) && (
            <button
              className="btn-secondary btn"
              type="button"
              onClick={() => { setSeverity(''); setResolution('open'); setAlertName(''); setFrom(''); setTo(''); setQ(''); }}
            >
              Reset filters
            </button>
          )}
        </div>

        <div className="panel">
          {loading ? (
            <span className="text-dim">Loading…</span>
          ) : rows.length === 0 ? (
            <div className="empty-state">No alerts match these filters.</div>
          ) : (
            <>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Severity</th>
                      <th>Alert Name</th>
                      <th>Server / Source</th>
                      <th>State</th>
                      <th>Created</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((a) => (
                      <tr key={a.id} className="row-hover">
                        <td><SeverityBadge severity={a.severity} /></td>
                        <td>{a.alert_name}</td>
                        <td className="cell-mono">{a.hostname || a.server_name_raw}</td>
                        <td><ResolutionBadge label={a.resolution_state_label} /></td>
                        <td className="text-dim">{new Date(a.created_at).toLocaleString()}</td>
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
    </>
  );
}
