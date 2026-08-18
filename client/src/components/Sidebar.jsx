import { useState } from 'react';
import { NavLink } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import {
  IconDashboard, IconBell, IconStar, IconServer, IconUpload, IconSettings,
  IconUsers, IconChevronLeft, IconChevronRight, IconShield,
} from './icons.jsx';

const SECTIONS = [
  {
    label: 'Overview',
    items: [{ to: '/', label: 'Dashboard', icon: IconDashboard, end: true }],
  },
  {
    label: 'Monitoring',
    items: [
      { to: '/alarms', label: 'Alerts', icon: IconBell },
      { to: '/critical', label: 'Critical Servers', icon: IconStar },
    ],
  },
  {
    label: 'Infrastructure',
    items: [{ to: '/inventory', label: 'Inventory', icon: IconServer }],
  },
  {
    label: 'Data Management',
    items: [{ to: '/import', label: 'Import Data', icon: IconUpload, adminOnly: true }],
  },
  {
    label: 'Administration',
    items: [
      { to: '/configuration', label: 'Configuration', icon: IconSettings, adminOnly: true },
      { to: '/users', label: 'Users', icon: IconUsers, adminOnly: true },
    ],
  },
];

export default function Sidebar({ collapsed, onToggleCollapse }) {
  const { isAdmin } = useAuth();

  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark"><IconShield /></div>
        <div className="brand-text">
          <span className="brand-title">SERVER WATCH</span>
          <span className="brand-subtitle">Server Monitoring Dashboard</span>
        </div>
      </div>

      <nav className="nav-scroll">
        {SECTIONS.map((section) => {
          const items = section.items.filter((item) => !item.adminOnly || isAdmin);
          if (items.length === 0) return null;
          return (
            <div key={section.label}>
              <div className="nav-section-label">{section.label}</div>
              {items.map((item) => {
                const Icon = item.icon;
                return (
                  <NavLink key={item.to} to={item.to} end={item.end} className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
                    <Icon />
                    <span className="label">{item.label}</span>
                  </NavLink>
                );
              })}
            </div>
          );
        })}
      </nav>

      <div className="sidebar-footer">
        <button className="collapse-btn" onClick={onToggleCollapse}>
          {collapsed ? <IconChevronRight /> : <IconChevronLeft />}
          <span className="label">Collapse</span>
        </button>
      </div>
    </aside>
  );
}
