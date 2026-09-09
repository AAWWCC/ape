// Persisted identities require the exact canonical ISO representation.
export function isCanonicalTimestamp(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 32) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

// Wall clocks may move backwards between durable transitions. Preserve the
// predecessor ordering required by persisted state without changing deadlines.
export function timestampAtLeast(at, ...predecessors) {
  return predecessors.reduce((latest, value) => {
    const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
    return Number.isFinite(parsed) ? Math.max(latest, parsed) : latest;
  }, at);
}
