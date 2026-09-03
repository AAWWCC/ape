import path from 'node:path';

// One claim/test-path matcher for every layer. The write-time hook policy
// (hooks.js), the receipt-time validator (receipt-validator.js), the service
// admission checks (mode-land scope, friction #33 production-change filter), and the
// derived targeted-tests gate (gates.js) all answer the same question — "is
// this file inside these claims / does it look like a test?" — and they used
// to answer it with five divergent copies. The divergence was a confirmed
// policy disagreement: a claim like `src//utils` or `src/../lib` was accepted
// at start and at receipt validation but denied by the hook's raw
// string-prefix check, so a bound subagent could never produce the claimed
// change and the run burned its attempts. Matching happens here, at
// MATCH time only — claims are never normalized where they are issued or
// persisted, or ticket_hash would change.

export const TEST_PATH_PATTERN = /(^|\/)(__tests__|tests?|spec)(\/|$)|\.(test|spec)\.[^.]+$/i;

// Receipt validation historically receives only the ticket's test_paths array,
// not the surrounding ticket. Keep the versioned exact-scope bit attached to
// that array in memory without serializing it into the ticket or changing any
// legacy hashes. The schema marks validated/finalized exact tickets; lifecycle
// authorization also passes the explicit boolean directly.
const EXACT_TEST_SCOPES = new WeakSet();

export function markExactTestScope(testPaths) {
  if (Array.isArray(testPaths)) EXACT_TEST_SCOPES.add(testPaths);
  return testPaths;
}

// Posix-normalizing canonical form (the receipt validator's semantics):
// backslashes to slashes, interior `//` and `/./` and `..` segments collapsed,
// leading `./` and trailing `/` stripped. A claim that still escapes the root
// after normalization (`../evil`) can never match a root-relative file, so it
// stays fail-closed by construction rather than by a raw-string mismatch.
// The drive-letter strip REQUIRES the separator (`<letter>:/`) so it fires only
// on a genuine Windows absolute prefix — after `replaceAll('\\','/')` a real
// `C:\...`/`d:/...` is already `X:/...` — and never rewrites a POSIX-legal
// relative path whose first segment merely contains a colon (`x:secret/evil.js`),
// which must stay outside a `['secret']` claim to keep write-scope confinement.
export function normalizeClaimPath(value) {
  const clean = String(value ?? '').replaceAll('\\', '/').replace(/^[a-zA-Z]:\//, '');
  const normalized = path.posix
    .normalize(clean)
    .replace(/^(\.\/)+/, '')
    .replace(/\/+$/, '');
  // Windows resolves a trailing run of dots/spaces off each path segment, so
  // 'src/foo.test.js.' physically opens 'src/foo.test.js'. Strip that alias per
  // segment AFTER posix.normalize (real '.'/'..' segments are resolved on raw
  // bytes first) in the fail-closed direction: a path that could alias to a
  // test must classify AS a test. The empty-segment guard is load-bearing —
  // a segment that is ALL dots/spaces ('..', '.', '...', '   ') would strip to
  // '' and, unguarded, collapse '../evil' into an in-claim 'evil' root escape,
  // so such a segment is kept verbatim.
  return normalized
    .split('/')
    .map((segment) => {
      const stripped = segment.replace(/[ .]+$/, '');
      return stripped === '' ? segment : stripped;
    })
    .join('/');
}

// A file is inside a claim when it equals the claim or lives under it as a
// directory. BOTH sides are normalized: git-derived files arrive clean, but
// receipt claimed_files and operator-supplied claims may carry `./`, `\\`, or
// interior dot segments, and the layers must agree on the same bytes.
export function withinClaim(file, claim) {
  const candidate = normalizeClaimPath(file);
  const normalized = normalizeClaimPath(claim);
  return candidate === normalized || candidate.startsWith(`${normalized}/`);
}

export function withinClaims(file, claims) {
  return claims.some((claim) => withinClaim(file, claim));
}

// "Test-shaped" is claims-first: anything inside a configured test claim is a
// test even when its name is not test-patterned (a `checks/` suite), and the
// conventional name pattern covers unconfigured layouts.
export function looksLikeTest(file, configuredPaths = []) {
  if (withinClaims(file, configuredPaths)) return true;
  return TEST_PATH_PATTERN.test(normalizeClaimPath(file));
}

// Test-writer confinement: the file must be test-shaped AND live inside a
// configured test claim — or inside a claim's parent directory, because a
// file-shaped claim (`tests/value.test.js`) authorizes authoring siblings in
// the same suite directory. Parent widening is gated on the same file-shaped
// pattern widenedTestClaims uses: a directory-shaped claim (`tests/unit`)
// authorizes only paths within that directory, never its parent's siblings
// (`tests/integration/x.test.js`), keeping receipt-time confinement exactly as
// declared and aligned with the realpath edit channel.
export function withinTestScope(file, configuredPaths = [], exact = EXACT_TEST_SCOPES.has(configuredPaths)) {
  if (!looksLikeTest(file, configuredPaths)) return false;
  return configuredPaths.some((claim) => {
    const normalized = normalizeClaimPath(claim);
    const candidate = normalizeClaimPath(file);
    const fileShaped = /\.(test|spec)\.[^.]+$/i.test(normalized);
    // Exact versioned remediation scope retains directory-claim semantics, but
    // a file-shaped claim names that file only. Treating a file as a directory
    // would admit descendants such as `value.test.js/payload.js`; comparing
    // the lexical names also rejects a different symlink alias that happens to
    // resolve onto the claimed file.
    if (exact && fileShaped) return candidate === normalized;
    if (withinClaim(candidate, normalized)) return true;
    if (exact) return false;
    if (!fileShaped) return false;
    const directory = path.posix.dirname(normalized);
    return directory !== '.' && (candidate === directory || candidate.startsWith(`${directory}/`));
  });
}

// The realpath deletion/edit channel resolves a test writer's targets against
// its test_paths, widening a file-shaped claim to its directory so a
// not-yet-existing sibling test file still resolves. This widening was a sixth
// partial-normalization variant living in bin/ape-hook.mjs; the output feeds
// path.resolve, so normalization here changes no resolution — it only keeps
// the claim bytes consistent with the string matchers above.
export function widenedTestClaims(testPaths) {
  return testPaths.map((claim) => {
    const normalized = normalizeClaimPath(claim);
    if (!/\.(test|spec)\.[^.]+$/i.test(normalized)) return normalized;
    // A root-level file-shaped claim has no '/' (lastIndexOf yields -1), and
    // slice(0, -1) would chop the last character into a truthy phantom claim
    // ('server.test.j') that matches nothing — not even the claimed file
    // itself. A root claim widens to ITSELF: authoring exactly that file,
    // never the whole repo root.
    const idx = normalized.lastIndexOf('/');
    return idx <= 0 ? normalized : normalized.slice(0, idx);
  });
}
