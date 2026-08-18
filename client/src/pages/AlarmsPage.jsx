import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import TopBar from '../components/TopBar.jsx';
import SeverityBadge, { ResolutionBadge } from '../components/SeverityBadge.jsx';

export default function AlarmsPage() {
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [severity, setSeverity] = useState('');
  const [resolution, setResolution] = useState('open');
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams();
    if (severity) params.set('severity', severity);
    if (resolution) params.set('resolution', resolution);
    if (q) params.set('q', q);
    api
      .get(`/alerts?${params.toString()}`)
      .then((data) => {
        setRows(data.rows);
        setTotal(data.total);
      })
      .finally(() => setLoading(false));
  }, [severity, resolution, q]);

  return (
    <>
      <TopBar title="Alarms" />
      <div className="content">
        <div className="toolbar">
          <input className="input" placeholder="Search alert or server…" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 260 }} />
          <select className="input" value={severity} onChange={(e) => setSeverity(e.target.value)}>
            <option value="">All severities</option>
            <option value="Critical">Critical</option>
            <option value="Warning">Warning</option>
            <option value="Information">Information</option>
          </select>
          <select className="input" value={resolution} onChange={(e) => setResolution(e.target.value)}>
            <option value="open">Open only</option>
            <option value="closed">Closed only</option>
            <option value="">All</option>
          </select>
          <span className="text-faint" style={{ fontSize: 12.5 }}>{total} results</span>
        </div>

        <div className="panel">
          {loading ? (
            <span className="text-dim">Loading…</span>
          ) : rows.length === 0 ? (
            <div className="empty-state">No alerts match these filters.</div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Severity</th>
                  <th>Alert</th>
                  <th>Server / Source</th>
                  <th>State</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((a) => (
                  <tr key={a.id}>
                    <td><SeverityBadge severity={a.severity} /></td>
                    <td>{a.alert_name}</td>
                    <td className="text-dim">{a.hostname || a.server_name_raw}</td>
                    <td><ResolutionBadge label={a.resolution_state_label} /></td>
                    <td className="text-dim">{new Date(a.created_at).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </>
  );
}
