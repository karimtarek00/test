export default function SeverityBadge({ severity }) {
  return (
    <span className={`badge ${severity?.toLowerCase()}`}>
      <span className="dot" />
      {severity}
    </span>
  );
}

export function ResolutionBadge({ label }) {
  const cls = label === 'Closed' ? 'healthy' : 'new';
  return (
    <span className={`badge ${cls}`}>
      <span className="dot" />
      {label}
    </span>
  );
}
