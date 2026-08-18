// Consistent line-icon set (stroke-based, 24x24 viewBox) used across the nav,
// topbar, and buttons — matches the "consistent line icon style" principle
// from the design spec, no icon library dependency.
const base = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  viewBox: '0 0 24 24',
};

export const IconDashboard = (p) => (
  <svg {...base} {...p}><rect x="3" y="3" width="7" height="9" rx="1.5" /><rect x="14" y="3" width="7" height="5" rx="1.5" /><rect x="14" y="12" width="7" height="9" rx="1.5" /><rect x="3" y="16" width="7" height="5" rx="1.5" /></svg>
);
export const IconBell = (p) => (
  <svg {...base} {...p}><path d="M6 8a6 6 0 0 1 12 0c0 4 1.5 5.5 2 6.5H4c.5-1 2-2.5 2-6.5Z" /><path d="M10 19a2 2 0 0 0 4 0" /></svg>
);
export const IconStar = (p) => (
  <svg {...base} {...p}><path d="M12 2.5l2.9 6 6.6.9-4.8 4.6 1.1 6.5-5.8-3-5.8 3 1.1-6.5-4.8-4.6 6.6-.9L12 2.5Z" /></svg>
);
export const IconServer = (p) => (
  <svg {...base} {...p}><rect x="3" y="4" width="18" height="7" rx="1.5" /><rect x="3" y="13" width="18" height="7" rx="1.5" /><circle cx="7" cy="7.5" r="0.8" fill="currentColor" /><circle cx="7" cy="16.5" r="0.8" fill="currentColor" /></svg>
);
export const IconUpload = (p) => (
  <svg {...base} {...p}><path d="M12 16V4M12 4l-4 4M12 4l4 4" /><path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" /></svg>
);
export const IconSettings = (p) => (
  <svg {...base} {...p}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" /></svg>
);
export const IconUsers = (p) => (
  <svg {...base} {...p}><circle cx="9" cy="8" r="3.2" /><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6" /><circle cx="17.5" cy="9" r="2.5" /><path d="M15.5 14.3c2.7.4 4.5 2.7 4.5 5.7" /></svg>
);
export const IconChevronLeft = (p) => (<svg {...base} {...p}><path d="M15 5l-7 7 7 7" /></svg>);
export const IconChevronRight = (p) => (<svg {...base} {...p}><path d="M9 5l7 7-7 7" /></svg>);
export const IconSearch = (p) => (<svg {...base} {...p}><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></svg>);
export const IconUser = (p) => (<svg {...base} {...p}><circle cx="12" cy="8" r="4" /><path d="M4 20c0-4.4 3.6-8 8-8s8 3.6 8 8" /></svg>);
export const IconClose = (p) => (<svg {...base} {...p}><path d="M18 6 6 18M6 6l12 12" /></svg>);
export const IconPulse = (p) => (<svg {...base} {...p}><path d="M3 12h4l2-7 4 14 2-7h6" /></svg>);
// Shield outline with a heartbeat/EKG pulse line through the middle --
// matches the brand mark from the design spec.
export const IconShield = (p) => (
  <svg {...base} {...p}>
    <path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3Z" />
    <path d="M6.7 12.5h2l1.1-3 2 6.5 1.4-3.5h3.1" strokeWidth="1.8" />
  </svg>
);
