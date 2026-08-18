import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import TopBar from '../components/TopBar.jsx';

export default function CriticalDashboardPage() {
  const [groups, setGroups] = useState(null);

  useEffect(() => {
    api.get('/critical').then((data) => setGroups(data.groups));
  }, []);

  const groupNames = groups ? Object.keys(groups) : [];

  return (
    <>
      <TopBar title="Critical Servers" />
      <div className="content">
        <div className="panel" style={{ marginBottom: 20 }}>
          <span className="text-dim" style={{ fontSize: 13 }}>
            Grouping is by Data Center for now (placeholder, derived from hostname prefixes in the seeded demo data) —
            confirm the real grouping that fits your environment, then mark servers on the Inventory page to build out this watchlist.
          </span>
        </div>

        {groups && groupNames.length === 0 && (
          <div className="panel"><div className="empty-state">No servers on the watchlist yet — flip "Critical" on a server in Inventory.</div></div>
        )}

        {groupNames.map((name) => (
          <div key={name} className="group-block">
            <div className="group-title">{name}</div>
            <div className="critical-grid">
              {groups[name].map((s) => (
                <div key={s.id} className="critical-card">
                  <span className={`status-dot ${s.status}`} />
                  <div className="critical-card-body">
                    <div className="critical-card-name">{s.hostname}</div>
                    <div className="critical-card-meta">
                      {s.critical_open} critical · {s.warning_open} warning
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
