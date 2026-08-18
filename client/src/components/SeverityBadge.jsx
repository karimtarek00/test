export default function SeverityBadge({ severity }) {
  return <span className={`badge ${severity?.toLowerCase()}`}>{severity}</span>;
}

export function ResolutionBadge({ label }) {
  const cls = label === 'Closed' ? 'closed' : 'new';
  return <span className={`badge ${cls}`}>{label}</span>;
}
