// Fleet-relative health score: normalized 0-100, driven by open-alert volume,
// severity, and recency. Same shape as the NNMi app's algorithm per the brief.
const SEVERITY_WEIGHT = { Critical: 10, Warning: 3, Information: 1 };

function recencyWeight(createdAt) {
  const ageHours = (Date.now() - new Date(createdAt).getTime()) / (1000 * 60 * 60);
  if (ageHours < 24) return 1;
  if (ageHours < 72) return 0.6;
  return 0.3;
}

export function computeServerHealthScore(openAlerts) {
  let penalty = 0;
  for (const alert of openAlerts) {
    penalty += (SEVERITY_WEIGHT[alert.severity] || 1) * recencyWeight(alert.created_at);
  }
  return Math.max(0, Math.min(100, Math.round(100 - penalty)));
}

export function computeFleetHealthScore(alertsByServer) {
  const scores = Object.values(alertsByServer).map(computeServerHealthScore);
  if (scores.length === 0) return 100;
  const sum = scores.reduce((acc, s) => acc + s, 0);
  return Math.round(sum / scores.length);
}
