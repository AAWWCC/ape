// Compatibility parser for persisted pre-removal tickets and capability
// manifests. New runs no longer accept, issue, or enforce external tool claims;
// this exists only so immutable historical artifacts keep validating.
const ACCESS = new Set(['read', 'write', 'execute']);

export function parseLegacyToolClaim(claim) {
  if (typeof claim !== 'string' || claim.length === 0 || claim.length > 4096) return null;
  const first = claim.indexOf(':');
  const last = claim.lastIndexOf(':');
  if (first <= 0 || last <= first) return null;
  const provider = claim.slice(0, first).toLowerCase();
  const resource = claim.slice(first + 1, last);
  const access = claim.slice(last + 1).toLowerCase();
  if (
    !/^[a-z0-9][a-z0-9._-]*$/.test(provider) ||
    !resource ||
    resource.trim() !== resource ||
    /[\0-\x1f\x7f]/.test(resource) ||
    (resource.includes('*') && !/^(?:\*|[^*]+\*)$/.test(resource)) ||
    !ACCESS.has(access)
  ) return null;
  return { provider, resource, access };
}
