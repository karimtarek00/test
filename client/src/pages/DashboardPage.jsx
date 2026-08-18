import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client.js';
import TopBar from '../components/TopBar.jsx';
import SeverityBadge from '../components/SeverityBadge.jsx';

export default function DashboardPage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get('/dashboard/summary').then(setData).catch((e) => setError(e.message));
  }, []);

  if (error) return <div className="content"><div className="panel error-text">{error}</div></div>;
  if (!data) return <div className="content"><span className="text-dim">Loading…</span></div>;

  const { kpis, severityBreakdown, recentAlerts } = data;
  const maxSeverity = Math.max(1, ...severityBreakdown.map((s) => s.count));

  return (
    <>
      <TopBar title="Dashboard" />
      <div className="content">
        <div className="kpi-grid">
          <KpiCard label="Open Alerts" value={kpis.totalOpen} />
          <KpiCard label="Critical" value={kpis.critical} tone="critical" />
          <KpiCard label="Warning" value={kpis.warning} tone="warning" />
          <KpiCard label="Servers Monitored" value={kpis.serversMonitored} />
          <KpiCard label="Closed (7d)" value={kpis.closedLast7d} />
          <KpiCard label="Fleet Health Score" value={`${kpis.healthScore}`} tone="accent" />
        </div>

        <div className="panel">
          <div className="panel-header">
            <span className="panel-title">Open Alerts by Severity</span>
          </div>
          {severityBreakdown.length === 0 ? (
            <div className="empty-state">No open alerts.</div>
          ) : (
            severityBreakdown.map((row) => (
              <div key={row.severity} style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
                <div style={{ width: 90, fontSize: 13 }}>{row.severity}</div>
                <div style={{ flex: 1, background: 'var(--bg-elevated)', borderRadius: 6, height: 10, overflow: 'hidden' }}>
                  <div
                    style={{
                      width: `${(row.count / maxSeverity) * 100}%`,
                      height: '100%',
                      background: row.severity === 'Critical' ? 'var(--critical)' : row.severity === 'Warning' ? 'var(--warning)' : 'var(--info)',
                    }}
                  />
                </div>
                <div style={{ width: 40, textAlign: 'right', fontSize: 13, fontWeight: 600 }}>{row.count}</div>
              </div>
            ))
          )}
        </div>

        <div className="panel">
          <div className="panel-header">
            <span className="panel-title">Recent Alerts</span>
            <Link to="/alarms" className="text-dim" style={{ fontSize: 12.5 }}>View all →</Link>
          </div>
          {recentAlerts.length === 0 ? (
            <div className="empty-state">No alerts yet — import data to get started.</div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Severity</th>
                  <th>Alert</th>
                  <th>Server</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {recentAlerts.map((a) => (
                  <tr key={a.id}>
                    <td><SeverityBadge severity={a.severity} /></td>
                    <td>{a.alert_name}</td>
                    <td className="text-dim">{a.hostname || a.server_name_raw}</td>
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

function KpiCard({ label, value, tone }) {
  return (
    <div className="kpi-card">
      <div className="kpi-label">{label}</div>
      <div className={`kpi-value${tone ? ` ${tone}` : ''}`}>{value}</div>
    </div>
  );
}
