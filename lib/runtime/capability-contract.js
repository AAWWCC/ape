import {
  CAPABILITY_DYNAMIC_TEST_PATHS_MAX,
  CAPABILITY_DYNAMIC_TEST_PATHS_MAX_UTF8_BYTES,
  CAPABILITY_MANIFEST_MAX_UTF8_BYTES,
} from './constants.js';
import { canonicalProjectRelativePathError, normalizeClaimPath } from './path-scope.js';
import { INPUT_LIMITS } from './input-guard.js';

export const CAPABILITY_MANIFEST_GROWTH_CONTRACT_VERSION = 2;

const commandSetBytes = new WeakMap();

// These lower-bound checks run before cloning profiles or multiplying path
// templates. A single authoritative field cannot be larger than the complete
// manifest envelope, regardless of how compact the remaining fields are.
export function assertCapabilitySourceCollectionsFit(collections) {
  for (const [field, entries] of Object.entries(collections)) {
    if (!Array.isArray(entries)) continue;
    if (entries.length > INPUT_LIMITS.maxArrayLength) {
      throw new Error(`${field} exceeds the ${INPUT_LIMITS.maxArrayLength}-item JSON array resource envelope`);
    }
    let used = 2;
    for (const [index, entry] of entries.entries()) {
      used += Buffer.byteLength(JSON.stringify(entry), 'utf8') + (index > 0 ? 1 : 0);
      if (used > CAPABILITY_MANIFEST_MAX_UTF8_BYTES) {
        throw new Error(`${field} alone exceeds the ${CAPABILITY_MANIFEST_MAX_UTF8_BYTES}-byte capability manifest envelope`);
      }
    }
  }
}

export function addCapabilityEvidenceCommand(commands, command) {
  if (commands.has(command)) return;
  if (command.length > 8_192) throw new Error('rendered evidence command exceeds 8192 characters');
  const used = (commandSetBytes.get(commands) ?? 2) +
    Buffer.byteLength(JSON.stringify(command), 'utf8') + (commands.size > 0 ? 1 : 0);
  if (commands.size >= INPUT_LIMITS.maxArrayLength || used > CAPABILITY_MANIFEST_MAX_UTF8_BYTES) {
    throw new Error(`rendered evidence commands exceed the ${INPUT_LIMITS.maxArrayLength}-item or ${CAPABILITY_MANIFEST_MAX_UTF8_BYTES}-byte capability manifest envelope`);
  }
  commands.add(command);
  commandSetBytes.set(commands, used);
}

export function capabilityDynamicTestPathBounds({ version = CAPABILITY_MANIFEST_GROWTH_CONTRACT_VERSION } = {}) {
  if (version !== 1) {
    return {
      max_items: INPUT_LIMITS.maxArrayLength,
      command_max_chars: 8_192,
      manifest_max_serialized_utf8_bytes: CAPABILITY_MANIFEST_MAX_UTF8_BYTES,
    };
  }
  return {
    max_items: CAPABILITY_DYNAMIC_TEST_PATHS_MAX,
    max_serialized_utf8_bytes: CAPABILITY_DYNAMIC_TEST_PATHS_MAX_UTF8_BYTES,
  };
}

export function capabilityTestPathUsage(testPaths = [], options = {}) {
  // Count and hash the exact persisted representation. Callers that are
  // forming an additive union must do that before reaching this boundary;
  // silently de-duplicating here would let a non-canonical or duplicate input
  // pass admission under different bytes than the ticket later publishes.
  const paths = (Array.isArray(testPaths) ? testPaths : []).map(String);
  const bounds = capabilityDynamicTestPathBounds(options);
  return {
    paths,
    used_items: paths.length,
    max_items: bounds.max_items,
    used_bytes: Buffer.byteLength(JSON.stringify(paths), 'utf8'),
    // Version two validates the concrete rendered commands/manifests rather
    // than assigning a second, smaller byte budget to their source paths.
    max_bytes: bounds.max_serialized_utf8_bytes ?? null,
  };
}

export function capabilityTestPathBoundErrors(testPaths = [], options = {}) {
  const usage = capabilityTestPathUsage(testPaths, options);
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
  if (usage.max_bytes !== null && usage.used_bytes > usage.max_bytes) {
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
