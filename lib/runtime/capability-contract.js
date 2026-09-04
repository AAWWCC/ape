import {
  CAPABILITY_DYNAMIC_TEST_PATHS_MAX,
  CAPABILITY_DYNAMIC_TEST_PATHS_MAX_UTF8_BYTES,
} from './constants.js';
import { canonicalProjectRelativePathError, normalizeClaimPath } from './path-scope.js';

export const CAPABILITY_MANIFEST_GROWTH_CONTRACT_VERSION = 1;

export function capabilityDynamicTestPathBounds() {
  return {
    max_items: CAPABILITY_DYNAMIC_TEST_PATHS_MAX,
    max_serialized_utf8_bytes: CAPABILITY_DYNAMIC_TEST_PATHS_MAX_UTF8_BYTES,
  };
}

export function capabilityTestPathUsage(testPaths = []) {
  // Count and hash the exact persisted representation. Callers that are
  // forming an additive union must do that before reaching this boundary;
  // silently de-duplicating here would let a non-canonical or duplicate input
  // pass admission under different bytes than the ticket later publishes.
  const paths = (Array.isArray(testPaths) ? testPaths : []).map(String);
  return {
    paths,
    used_items: paths.length,
    max_items: CAPABILITY_DYNAMIC_TEST_PATHS_MAX,
    used_bytes: Buffer.byteLength(JSON.stringify(paths), 'utf8'),
    max_bytes: CAPABILITY_DYNAMIC_TEST_PATHS_MAX_UTF8_BYTES,
  };
}

export function capabilityTestPathBoundErrors(testPaths = []) {
  const usage = capabilityTestPathUsage(testPaths);
  const errors = [];
  const canonical = new Set();
  for (const [index, testPath] of usage.paths.entries()) {
    const identity = normalizeClaimPath(testPath);
    const pathError = canonicalProjectRelativePathError(testPath);
    if (pathError) {
      errors.push(
        `runtime-derived test_paths item ${index} ${pathError}: ${JSON.stringify(testPath)}`,
      );
    }
    if (canonical.has(identity)) {
      errors.push(
        `runtime-derived test_paths must be unique after canonicalization; duplicate item ${index}: ${JSON.stringify(testPath)}`,
      );
    } else {
      canonical.add(identity);
    }
  }
  if (usage.used_items > usage.max_items) {
    errors.push(
      `runtime-derived test_paths contains ${usage.used_items} items; the new receipt contract permits at most ${usage.max_items}`,
    );
  }
  if (usage.used_bytes > usage.max_bytes) {
    errors.push(
      `runtime-derived test_paths uses ${usage.used_bytes} serialized UTF-8 bytes; the new receipt contract permits at most ${usage.max_bytes}`,
    );
  }
  return { valid: errors.length === 0, errors, usage };
}

// Produce the largest single-path representation admitted by the aggregate
// byte budget. One path maximizes rendered command bytes because a JSON array's
// per-item quotes/commas cost more than the single spaces used by command
// rendering. Readiness evaluates this allocation once at the project root and
// once beneath every configured runner root; that covers the runner receiving
// the entire bounded path budget, which is the worst case for both an
// individual rendered command and total manifest bytes.
export function worstCaseCapabilityTestPathSets(runners = []) {
  const roots = [
    '.',
    ...(Array.isArray(runners) ? runners : []).map((runner) => normalizeClaimPath(runner?.root ?? '.')),
  ];
  const uniqueRoots = [...new Set(roots)];
  return uniqueRoots.map((root) => {
    const prefix = root === '.' ? 'tests/' : `${root}/`;
    const suffix = '.test.js';
    const base = `${prefix}x${suffix}`;
    const baseBytes = Buffer.byteLength(JSON.stringify([base]), 'utf8');
    if (baseBytes > CAPABILITY_DYNAMIC_TEST_PATHS_MAX_UTF8_BYTES) {
      return {
        root,
        paths: [base],
        error:
          `runner root cannot represent one test path inside the ${CAPABILITY_DYNAMIC_TEST_PATHS_MAX_UTF8_BYTES}-byte dynamic test_paths budget`,
      };
    }
    const fillerBytes = CAPABILITY_DYNAMIC_TEST_PATHS_MAX_UTF8_BYTES - baseBytes;
    const testPath = `${prefix}${'x'.repeat(fillerBytes + 1)}${suffix}`;
    const paths = [testPath];
    return { root, paths, error: null };
  });
}
