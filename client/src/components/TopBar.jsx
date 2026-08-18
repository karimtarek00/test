export default function TopBar({ title, children }) {
  return (
    <div className="topbar">
      <div className="topbar-title">{title}</div>
      <div style={{ display: 'flex', gap: 10 }}>{children}</div>
    </div>
  );
}
