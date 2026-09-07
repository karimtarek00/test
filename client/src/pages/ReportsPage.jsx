import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import TopBar from '../components/TopBar.jsx';

const REPORT_TYPES = [
  { value: 'inventory', label: 'Server Inventory', description: 'KPI cards, environment/OS-type donut charts, and a data-center breakdown, followed by the full server listing. Point-in-time -- no date range needed.', ranged: false },
  { value: 'alerts', label: 'Alerts', description: 'KPI cards, severity/resolution donut charts, and a monthly trend chart, followed by the full row-by-row listing for the selected range -- filterable by server/type/severity. Includes alerts since resolved or closed -- a ranged report always reflects what genuinely happened in the window, not just what is still open today.', ranged: true },
  { value: 'summary', label: 'Summary', description: 'A dashboard-style report: KPI cards, severity/resolution-state donut charts, a monthly trend chart, ranked alarm-type/device bars, and a least-healthy-devices table. Filter to one device for a per-server summary. PDF shows the full visual layout; Word/Excel export the same data as tables.', ranged: true },
];
const FORMATS = [
  { value: 'pdf', label: 'PDF' },
  { value: 'docx', label: 'Word (.docx)' },
  { value: 'xlsx', label: 'Excel (.xlsx)' },
];

const EMPTY_FILTERS = { from: '', to: '', severity: '', server: '', alertName: '' };

function buildQuery(filters) {
  const params = new URLSearchParams();
  Object.entries(filters).forEach(([k, v]) => { if (v) params.set(k, v); });
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

export default function ReportsPage() {
  const [reportType, setReportType] = useState('inventory');
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [alertTypes, setAlertTypes] = useState([]);
  const [history, setHistory] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(true);

  const activeType = REPORT_TYPES.find((t) => t.value === reportType);

  const loadHistory = () => {
    api.get('/reports/history?limit=25').then((d) => setHistory(d.jobs)).catch(() => {}).finally(() => setHistoryLoading(false));
  };

  useEffect(() => {
    loadHistory();
    api.get('/analysis/alert-types').then((d) => setAlertTypes(d.alertTypes)).catch(() => {});
  }, []);

  const set = (key) => (e) => setFilters((f) => ({ ...f, [key]: e.target.value }));

  const downloadUrl = (format) => {
    const query = activeType.ranged ? buildQuery(filters) : '';
    return `/api/reports/generate/${reportType}/${format}${query}`;
  };

  // The download itself is a plain browser navigation (so the file save
  // dialog / new-tab behavior works exactly like any other link), not a
  // fetch -- refresh the history table a moment after the click so the new
  // job shows up without the user having to reload the page.
  const onDownloadClick = () => setTimeout(loadHistory, 1500);

  return (
    <>
      <TopBar title="Reports" />
      <div className="content">
        <div className="panel">
          <div className="panel-header">
            <span className="panel-title">Generate a Report</span>
          </div>

          <div className="toolbar" style={{ flexWrap: 'wrap', marginBottom: 12 }}>
            {REPORT_TYPES.map((t) => (
              <button
                key={t.value}
                type="button"
                className={reportType === t.value ? 'btn' : 'btn-secondary btn'}
                onClick={() => setReportType(t.value)}
              >
                {t.label}
              </button>
            ))}
          </div>
          <p className="text-dim" style={{ marginTop: 0, marginBottom: 16, fontSize: 13 }}>{activeType.description}</p>

          {activeType.ranged && (
            <div className="toolbar" style={{ flexWrap: 'wrap', marginBottom: 16 }}>
              <input className="input" type="date" style={{ width: 150 }} value={filters.from} onChange={set('from')} title="From (local date)" />
              <input className="input" type="date" style={{ width: 150 }} value={filters.to} onChange={set('to')} title="To (local date)" />
              {(reportType === 'alerts' || reportType === 'summary') && (
                <input className="input" style={{ width: 200 }} placeholder="Filter to one device…" value={filters.server} onChange={set('server')} />
              )}
              {reportType === 'alerts' && (
                <select className="input" style={{ width: 240 }} value={filters.alertName} onChange={set('alertName')}>
                  <option value="">All alarm types</option>
                  {alertTypes.map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              )}
              <select className="input" style={{ width: 160 }} value={filters.severity} onChange={set('severity')}>
                <option value="">All severities</option>
                <option value="Critical">Critical</option>
                <option value="Warning">Warning</option>
                <option value="Information">Information</option>
              </select>
              {(filters.from || filters.to) && (
                <span className="text-dim" style={{ fontSize: 12, alignSelf: 'center' }}>
                  Dates are interpreted in the organization's local time (UTC+3).
                </span>
              )}
            </div>
          )}

          <div className="toolbar" style={{ flexWrap: 'wrap' }}>
            {FORMATS.map((f) => (
              <a
                key={f.value}
                className="btn"
                href={downloadUrl(f.value)}
                onClick={onDownloadClick}
                style={{ display: 'inline-block', textDecoration: 'none' }}
              >
                Download {f.label}
              </a>
            ))}
          </div>
        </div>

        <div className="panel">
          <div className="panel-header">
            <span className="panel-title">Generation History</span>
          </div>
          {historyLoading ? (
            <span className="text-dim">Loading…</span>
          ) : history.length === 0 ? (
            <span className="text-dim">No reports generated yet.</span>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Type</th>
                    <th>Format</th>
                    <th>Range</th>
                    <th>Requested By</th>
                    <th>When</th>
                    <th>Status</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((job) => (
                    <tr key={job.id}>
                      <td style={{ textTransform: 'capitalize' }}>{job.report_type}</td>
                      <td>{job.format.toUpperCase()}</td>
                      <td>{job.params.from || job.params.to ? `${job.params.from || '…'} to ${job.params.to || '…'}` : 'All time'}</td>
                      <td>{job.requested_by || '—'}</td>
                      <td>{new Date(job.created_at).toLocaleString()}</td>
                      <td>
                        <span className={job.status === 'completed' ? 'badge healthy' : 'badge critical'}>
                          <span className="dot" />{job.status}
                        </span>
                      </td>
                      <td>
                        {job.status === 'completed' && (
                          <a href={`/api/reports/history/${job.id}/redownload`} className="btn-secondary btn" style={{ textDecoration: 'none', padding: '4px 10px', fontSize: 12 }}>
                            Re-download
                          </a>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
