import { NavLink } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';

const NAV_ITEMS = [
  { to: '/', label: 'Dashboard', icon: '◧', end: true },
  { to: '/alarms', label: 'Alarms', icon: '▲' },
  { to: '/inventory', label: 'Inventory', icon: '▤' },
  { to: '/critical', label: 'Critical Servers', icon: '◆' },
  { to: '/reports', label: 'Reports', icon: '▦' },
];

const ADMIN_NAV_ITEMS = [
  { to: '/import', label: 'Import Data', icon: '⇧' },
  { to: '/configuration', label: 'Configuration', icon: '⚙' },
  { to: '/users', label: 'Users', icon: '◎' },
];

export default function Sidebar() {
  const { user, isAdmin, logout } = useAuth();

  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark">SW</div>
        <div className="brand-text">
          <span className="brand-title">Server Watch</span>
          <span className="brand-subtitle">SCOM Dashboard</span>
        </div>
      </div>

      <div className="nav-section-label">Monitor</div>
      {NAV_ITEMS.map((item) => (
        <NavLink key={item.to} to={item.to} end={item.end} className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
          <span>{item.icon}</span>
          {item.label}
        </NavLink>
      ))}

      {isAdmin && (
        <>
          <div className="nav-section-label">Admin</div>
          {ADMIN_NAV_ITEMS.map((item) => (
            <NavLink key={item.to} to={item.to} className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
              <span>{item.icon}</span>
              {item.label}
            </NavLink>
          ))}
        </>
      )}

      <div className="sidebar-footer">
        <div style={{ fontSize: 12.5, color: 'var(--text-dim)', marginBottom: 8 }}>
          {user?.username} <span className="pill" style={{ marginLeft: 6 }}>{user?.role}</span>
        </div>
        <button className="btn-secondary btn" style={{ width: '100%' }} onClick={logout}>
          Sign out
        </button>
      </div>
    </aside>
  );
}
