import TopBar from '../components/TopBar.jsx';

export default function ReportsPage() {
  return (
    <>
      <TopBar title="Reports" />
      <div className="content">
        <div className="panel">
          <div className="panel-header">
            <span className="panel-title">Alert Summary (PDF)</span>
          </div>
          <p className="text-dim" style={{ marginTop: 0 }}>
            Open alerts by severity, plus the top servers by open alert count.
          </p>
          <a className="btn" href="/api/reports/summary.pdf" target="_blank" rel="noreferrer" style={{ display: 'inline-block', textDecoration: 'none' }}>
            Download PDF
          </a>
        </div>
      </div>
    </>
  );
}
