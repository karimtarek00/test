import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import { IconBell, IconUser } from './icons.jsx';

export default function TopBar({ title, children }) {
  const { user, isAdmin, logout } = useAuth();
  const [scomStatus, setScomStatus] = useState(null); // null = unknown/loading
  const [criticalCount, setCriticalCount] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);

  useEffect(() => {
    // /api/scom is admin-only, so only fetch it as an admin -- a viewer would
    // otherwise get a 403 on every page load.
    if (isAdmin) {
      api.get('/scom/settings').then((data) => setScomStatus(data.settings)).catch(() => setScomStatus(null));
    }
    api.get('/dashboard/summary').then((data) => setCriticalCount(data.kpis.critical)).catch(() => {});
  }, [isAdmin]);

  useEffect(() => {
    const onClickOutside = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  // sql_host was the field name from the earlier direct-SQL sync approach --
  // stale, no longer present since the switch to WinRM (management_server).
  // Left unnoticed until now because dev/test data never had a real
  // successful sync to reveal it: this always evaluated false, so the badge
  // was permanently stuck on "Disconnected" even right after a real
  // Run Sync Now succeeded.
  const connected = scomStatus?.last_sync_status === 'ok';

  return (
    <div className="topbar">
      <div className="topbar-title">{title}</div>
      <div className="topbar-right">
        {children}
        {isAdmin && (
          <div className="status-pill">
            <span className={`dot ${connected ? 'connected' : 'disconnected'}`} style={{ width: 8, height: 8, borderRadius: '50%', display: 'inline-block' }} />
            <span>
              SCOM <span className="label">{connected ? 'Connected' : 'Disconnected'}</span>
            </span>
          </div>
        )}
        {scomStatus?.last_sync_at && (
          <div className="status-pill">
            <span className="text-faint">Last Sync</span>
            <span className="label">{new Date(scomStatus.last_sync_at).toLocaleTimeString()}</span>
          </div>
        )}
        <div className="topbar-divider" />
        <button className="bell-btn" title={`${criticalCount} open critical alert${criticalCount === 1 ? '' : 's'}`}>
          <IconBell />
          {criticalCount > 0 && <span className="bell-badge">{criticalCount > 99 ? '99+' : criticalCount}</span>}
        </button>
        <div className="user-menu" ref={menuRef} style={{ position: 'relative' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }} onClick={() => setMenuOpen((o) => !o)}>
            <div className="user-avatar"><IconUser /></div>
            <div className="user-info">
              <div className="user-name">{user?.username}</div>
              <div className="user-role">{user?.role === 'admin' ? 'Admin' : 'Viewer'}</div>
            </div>
          </div>
          {menuOpen && (
            <div className="panel" style={{ position: 'absolute', top: '110%', right: 0, minWidth: 140, padding: 8, margin: 0, zIndex: 20 }}>
              <button className="btn-secondary btn" style={{ width: '100%' }} onClick={logout}>Sign out</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
