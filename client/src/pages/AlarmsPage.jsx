import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import TopBar from '../components/TopBar.jsx';
import SeverityBadge, { ResolutionBadge } from '../components/SeverityBadge.jsx';
import { IconSearch } from '../components/icons.jsx';

const PAGE_SIZE = 25;

export default function AlarmsPage() {
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [severity, setSeverity] = useState('');
  const [resolution, setResolution] = useState('open');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);

  useEffect(() => setPage(1), [severity, resolution, q]);

  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
    if (severity) params.set('severity', severity);
    if (resolution) params.set('resolution', resolution);
    if (q) params.set('q', q);
    api
      .get(`/alerts?${params.toString()}`)
      .then((data) => {
        setRows(data.alerts);
        setTotal(data.total);
      })
      .finally(() => setLoading(false));
  }, [severity, resolution, q, page]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <>
      <TopBar title="Alerts" />
      <div className="content">
        <div className="toolbar">
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
