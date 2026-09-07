import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import TopBar from '../components/TopBar.jsx';
import SeverityBadge, { ResolutionBadge } from '../components/SeverityBadge.jsx';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, Legend, LineChart, Line,
} from 'recharts';

const PAGE_SIZE = 15;
const SEVERITY_COLORS = { Critical: 'var(--critical)', Warning: 'var(--warning)', Information: 'var(--info)' };
const RESOLUTION_COLORS = { Closed: 'var(--healthy)', New: 'var(--warning)' };
const PIE_FALLBACK = ['var(--info)', 'var(--critical)', 'var(--warning)', 'var(--healthy)', 'var(--accent-dim)'];

const EMPTY_FILTERS = { server: '', alertName: '', severity: '', from: '', to: '' };

export default function AnalysisPage() {
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [alertTypes, setAlertTypes] = useState([]);
  const [summary, setSummary] = useState(null);
  const [incidents, setIncidents] = useState(null);
  const [incidentsPage, setIncidentsPage] = useState(1);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get('/analysis/alert-types').then((d) => setAlertTypes(d.alertTypes)).catch(() => {});
  }, []);

  useEffect(() => setIncidentsPage(1), [filters]);

  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams();
    Object.entries(filters).forEach(([k, v]) => { if (v) params.set(k, v); });
    const qs = params.toString();

    Promise.all([
      api.get(`/analysis/summary${qs ? `?${qs}` : ''}`),
      api.get(`/alerts?${qs ? `${qs}&` : ''}page=${incidentsPage}&pageSize=${PAGE_SIZE}`),
    ])
      .then(([s, i]) => { setSummary(s); setIncidents(i); })
      .finally(() => setLoading(false));
  }, [filters, incidentsPage]);

  const set = (key) => (e) => setFilters((f) => ({ ...f, [key]: e.target.value }));
  const resetFilters = () => setFilters(EMPTY_FILTERS);

  const maxTypeCount = Math.max(1, ...(summary?.topAlarmTypes || []).map((r) => r.count));
  const maxDeviceCount = Math.max(1, ...(summary?.topDevices || []).map((r) => r.count));
  const totalIncidentPages = Math.max(1, Math.ceil((incidents?.total || 0) / PAGE_SIZE));

  return (
    <>
      <TopBar title="Live Data & Analysis" />
      <div className="content">
        <p className="text-dim" style={{ marginTop: 0, marginBottom: 16, fontSize: 13 }}>
          Filter by server, alarm type, severity, or date range -- every chart, KPI, and the incidents table below all reflect the same filtered set.
        </p>

        <div className="toolbar" style={{ flexWrap: 'wrap' }}>
          <input className="input" style={{ width: 220 }} placeholder="Search server name…" value={filters.server} onChange={set('server')} />
          <select className="input" style={{ width: 260 }} value={filters.alertName} onChange={set('alertName')}>
            <option value="">All alarm types</option>
            {alertTypes.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <select className="input" style={{ width: 160 }} value={filters.severity} onChange={set('severity')}>
            <option value="">All severities</option>
            <option value="Critical">Critical</option>
            <option value="Warning">Warning</option>
            <option value="Information">Information</option>
          </select>
          <input className="input" type="date" style={{ width: 150 }} value={filters.from} onChange={set('from')} />
          <input className="input" type="date" style={{ width: 150 }} value={filters.to} onChange={set('to')} />
          <button className="btn-secondary btn" type="button" onClick={resetFilters}>Reset filters</button>
        </div>

        {!summary ? (
          <div className="panel"><span className="text-dim">Loading…</span></div>
        ) : (
          <>
            <div className="kpi-grid">
              <KpiCard label="Total Alarms" value={summary.kpis.totalAlarms} />
              <KpiCard label="Devices Affected" value={summary.kpis.devicesAffected} />
              <KpiCard label="Critical Alarms" value={summary.kpis.criticalAlarms} tone="critical" />
              <KpiCard label="Most Affected Device" value={summary.kpis.mostAffectedDevice?.name || '—'} sub={summary.kpis.mostAffectedDevice ? `${summary.kpis.mostAffectedDevice.count} alarms` : null} small />
              <KpiCard label="Peak Day" value={summary.kpis.peakDay ? new Date(summary.kpis.peakDay.day).toLocaleDateString() : '—'} sub={summary.kpis.peakDay ? `${summary.kpis.peakDay.count} alarms` : null} tone="warning" />
              <KpiCard label="Peak Hour" value={summary.kpis.peakHour ? `${String(summary.kpis.peakHour.hour).padStart(2, '0')}:00` : '—'} sub={summary.kpis.peakHour ? `${summary.kpis.peakHour.count} alarms` : null} tone="info" />
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
              <RankedListPanel title="Top Alarm Types" rows={summary.topAlarmTypes} max={maxTypeCount} wrapLabels />
              <RankedListPanel title="Top Devices by Volume" rows={summary.topDevices} max={maxDeviceCount} />
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
              <DonutPanel title="Severity Split" data={summary.severitySplit} nameKey="severity" colorMap={SEVERITY_COLORS} />
              <DonutPanel title="Resolution Split" data={summary.resolutionSplit} nameKey="label" colorMap={RESOLUTION_COLORS} />
            </div>

            <div className="panel">
              <div className="panel-header"><span className="panel-title">Hourly Distribution</span></div>
              <div style={{ width: '100%', height: 220 }}>
                <ResponsiveContainer>
                  <BarChart data={summary.hourlyDistribution} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border-soft)" vertical={false} />
                    <XAxis dataKey="hour" tickFormatter={(h) => `${h}:00`} tick={{ fill: 'var(--text-faint)', fontSize: 11 }} axisLine={{ stroke: 'var(--border-soft)' }} tickLine={false} />
                    <YAxis tick={{ fill: 'var(--text-faint)', fontSize: 11 }} axisLine={false} tickLine={false} width={40} />
                    <Tooltip contentStyle={{ background: 'var(--bg-card)', border: '1px solid var(--border-soft)', borderRadius: 8, fontSize: 12 }} labelFormatter={(h) => `${h}:00`} />
                    <Bar dataKey="count" fill="var(--info)" radius={[3, 3, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div className="panel">
              <div className="panel-header"><span className="panel-title">Monthly Trend</span></div>
              {summary.monthlyTrend.length === 0 ? (
                <div className="empty-state">Not enough data yet.</div>
              ) : (
                <div style={{ width: '100%', height: 220 }}>
                  <ResponsiveContainer>
                    <LineChart data={summary.monthlyTrend} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border-soft)" vertical={false} />
                      <XAxis dataKey="month" tick={{ fill: 'var(--text-faint)', fontSize: 11 }} axisLine={{ stroke: 'var(--border-soft)' }} tickLine={false} />
                      <YAxis tick={{ fill: 'var(--text-faint)', fontSize: 11 }} axisLine={false} tickLine={false} width={40} />
                      <Tooltip contentStyle={{ background: 'var(--bg-card)', border: '1px solid var(--border-soft)', borderRadius: 8, fontSize: 12 }} />
                      <Line type="monotone" dataKey="count" stroke="var(--info)" strokeWidth={2} dot={false} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              )}
            </div>
          </>
        )}

        <div className="panel">
          <div className="panel-header">
            <span className="panel-title">Filtered Incidents</span>
            <span className="text-faint" style={{ fontSize: 12 }}>{incidents?.total ?? 0} matching</span>
          </div>
          {loading ? (
            <span className="text-dim">Loading…</span>
          ) : !incidents || incidents.alerts.length === 0 ? (
            <div className="empty-state">No alerts match these filters.</div>
          ) : (
            <>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Server</th>
                      <th>Alarm Type</th>
                      <th>Severity</th>
                      <th>State</th>
                    </tr>
                  </thead>
                  <tbody>
                    {incidents.alerts.map((a) => (
                      <tr key={a.id} className="row-hover">
                        <td className="text-dim">{new Date(a.created_at).toLocaleString()}</td>
                        <td className="cell-mono">{a.hostname || a.server_name_raw}</td>
                        <td>{a.alert_name}</td>
                        <td><SeverityBadge severity={a.severity} /></td>
                        <td><ResolutionBadge label={a.resolution_state_label} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="table-footer">
                <span>Showing {(incidentsPage - 1) * PAGE_SIZE + 1}–{Math.min(incidentsPage * PAGE_SIZE, incidents.total)} of {incidents.total} entries</span>
                <div className="pager">
                  <button disabled={incidentsPage <= 1} onClick={() => setIncidentsPage((p) => p - 1)}>‹</button>
                  <button className="active">{incidentsPage}</button>
                  <span className="text-faint" style={{ padding: '0 4px' }}>of {totalIncidentPages}</span>
                  <button disabled={incidentsPage >= totalIncidentPages} onClick={() => setIncidentsPage((p) => p + 1)}>›</button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}

function KpiCard({ label, value, sub, tone, small }) {
  return (
    <div className="kpi-card">
      <div className="kpi-top"><span className="kpi-label">{label}</span></div>
      <div className={`kpi-value${tone ? ` ${tone}` : ''}`} style={small ? { fontSize: 18 } : undefined}>{value}</div>
      {sub && <div className="kpi-delta">{sub}</div>}
    </div>
  );
}

function RankedListPanel({ title, rows, max, wrapLabels = false }) {
  return (
    <div className="panel">
      <div className="panel-header"><span className="panel-title">{title}</span></div>
      {!rows || rows.length === 0 ? (
        <div className="empty-state">No data for these filters.</div>
      ) : (
        rows.map((row) => (
          <div
            key={row.name}
            style={wrapLabels
              ? { display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 12 }
              : { display: 'flex', alignItems: 'center', gap: 12, marginBottom: 9 }}
          >
            <div
              style={wrapLabels
                ? { fontSize: 12.5, whiteSpace: 'normal', wordBreak: 'break-word' }
                : { width: 220, fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
              title={wrapLabels ? undefined : row.name}
            >
              {row.name}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ flex: 1, background: 'var(--bg-elevated)', borderRadius: 6, height: 9, overflow: 'hidden' }}>
                <div style={{ width: `${(row.count / max) * 100}%`, height: '100%', background: 'var(--info)' }} />
              </div>
              <div style={{ width: 50, textAlign: 'right', fontSize: 12.5, fontWeight: 700 }}>{row.count}</div>
            </div>
          </div>
        ))
      )}
    </div>
  );
}

function DonutPanel({ title, data, nameKey, colorMap }) {
  const total = (data || []).reduce((sum, r) => sum + r.count, 0);
  return (
    <div className="panel">
      <div className="panel-header"><span className="panel-title">{title}</span></div>
      {!data || data.length === 0 ? (
        <div className="empty-state">No data for these filters.</div>
      ) : (
        <div style={{ width: '100%', height: 220, position: 'relative' }}>
          <ResponsiveContainer>
            <PieChart>
              <Pie data={data} dataKey="count" nameKey={nameKey} innerRadius={55} outerRadius={80} paddingAngle={2}>
                {data.map((entry, i) => (
                  <Cell key={entry[nameKey]} fill={colorMap[entry[nameKey]] || PIE_FALLBACK[i % PIE_FALLBACK.length]} />
                ))}
              </Pie>
              <Tooltip contentStyle={{ background: 'var(--bg-card)', border: '1px solid var(--border-soft)', borderRadius: 8, fontSize: 12 }} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
            </PieChart>
          </ResponsiveContainer>
          <div style={{ position: 'absolute', top: '42%', left: '50%', transform: 'translate(-50%, -50%)', textAlign: 'center', pointerEvents: 'none' }}>
            <div style={{ fontSize: 20, fontWeight: 800 }}>{total}</div>
            <div style={{ fontSize: 10, color: 'var(--text-faint)' }}>alarms</div>
          </div>
        </div>
      )}
    </div>
  );
}
