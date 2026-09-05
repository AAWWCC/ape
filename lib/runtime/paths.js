import path from 'node:path';
import { lstatSync } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';

// Single source of truth for locating the APE project root. Hosts report the
// session's *current* directory (which drifts when the session cd's into a
// subdirectory), so relying on it directly makes every consumer compute a wrong
// `.ape/runtime` root, find no active run, and fail open. A host-provided
// explicit dir is no safer taken verbatim: it names the *launch* directory,
// which may itself be a subdirectory of the governed root (a session opened in
// repo/src must still be governed by repo/). So an explicit dir outranks the
// drifting start but never bypasses the marker walk — it SEEDS the walk up to
// the nearest ancestor containing a `.ape/` directory, and a markerless seed
// resolves to itself (fresh project, no APE state yet). Symlinks are not
// markers: root discovery must not follow repository-planted state redirects.
// Accepted trade-off: a markerless subdirectory below a `.ape`-bearing
// ancestor resolves to that ancestor, so a nested project must plant its own
// `.ape` to self-govern.
export function resolveProjectRoot(startDir, explicitDir = null) {
  const seed =
    typeof explicitDir === 'string' && explicitDir.length > 0
      ? explicitDir
      : typeof startDir === 'string' && startDir.length > 0
        ? startDir
        : process.cwd();
  const start = path.resolve(seed);
  let candidate = start;
  for (;;) {
    try {
      const marker = lstatSync(path.join(candidate, '.ape'));
      if (!marker.isSymbolicLink() && marker.isDirectory()) return candidate;
    } catch {
      // no marker here; keep walking up
    }
    const parent = path.dirname(candidate);
    if (parent === candidate) return start;
    candidate = parent;
  }
}

// Read-only counterpart to receipt-service's prepareGovernedRuntimeAncestor.
// Hook lookups must never create state merely because an arbitrary child or
// external integration fired, but they also must not follow a repository-
// planted `.ape` or `runtime` symlink to trust/write evidence elsewhere.
export async function validateGovernedRuntimeAncestor(paths) {
  const canonicalRoot = await realpath(paths.root);
  const apeDirectory = path.join(paths.root, '.ape');
  const expectedApe = path.join(canonicalRoot, '.ape');
  let apeMetadata;
  try {
    apeMetadata = await lstat(apeDirectory);
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  if (
    apeMetadata.isSymbolicLink() ||
    !apeMetadata.isDirectory() ||
    await realpath(apeDirectory) !== expectedApe
  ) {
    throw new Error('APE state path resolves outside the governed private path');
  }

  let runtimeMetadata;
  try {
    runtimeMetadata = await lstat(paths.runtime);
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  if (
    runtimeMetadata.isSymbolicLink() ||
    !runtimeMetadata.isDirectory() ||
    await realpath(paths.runtime) !== path.join(expectedApe, 'runtime')
  ) {
    throw new Error('APE runtime path resolves outside the governed private path');
  }
  return true;
}

function nonEmpty(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

// Host identity is determined from an exact marker, not the mere presence of
// a Claude-shaped variable. Shells, IDEs, and nested host launches can retain
// stale project variables; treating those as cross-host authority can point a
// Codex hook at an unrelated markerless directory, make it find no active run,
// and fail open. The hook launcher deliberately removes the Claude markers
// before entering the Codex bundle, while native Claude supplies one of them.
export function runtimeHost(env = process.env) {
  if (env.APE_HOST === 'claude' || env.CLAUDECODE === '1' || env.CLAUDE_CODE === '1') {
    return 'claude';
  }
  return 'codex';
}

// The one host-aware hint-precedence chain, shared by the hook, MCP server,
// LARP helper, and statusline. An explicit per-call project dir always wins.
// Otherwise Claude uses only its stable CLAUDE_PROJECT_DIR launch pin, while
// Codex uses only its stable CODEX_CWD pin.
// The other host's ambient variables are ignored. Every selected hint still
// SEEDS resolveProjectRoot's marker walk, preserving governance when a session
// launches in a subdirectory.
export function resolveGovernedRoot({
  explicitDir = null,
  cwd = null,
  env = process.env,
  host = null,
} = {}) {
  const selectedHost = host === 'claude' || host === 'codex' ? host : runtimeHost(env);
  const stablePin = selectedHost === 'claude'
    ? nonEmpty(env.CLAUDE_PROJECT_DIR)
    : nonEmpty(env.CODEX_CWD);
  const pin = nonEmpty(explicitDir) ?? stablePin;
  const start = nonEmpty(cwd);
  return resolveProjectRoot(start, pin);
}

export function runtimePaths(projectDir) {
  const root = path.resolve(projectDir);
  const ape = path.join(root, '.ape');
  const runtime = path.join(ape, 'runtime');
  return Object.freeze({
    root,
    ape,
    runtime,
    runs: path.join(runtime, 'runs'),
    history: path.join(runtime, 'history'),
    tickets: path.join(runtime, 'tickets'),
    // Immutable, content-addressed run-contract manifests. Active state and
    // tickets retain only a compact ref/hash pointer into this directory.
    contracts: path.join(runtime, 'contracts'),
    receipts: path.join(runtime, 'receipts'),
    receiptTransactions: path.join(runtime, 'receipt-transactions'),
    // Immutable, hash-bound capability-recovery generations. A complete
    // candidate is staged beside this directory and published by one rename;
    // active.json adopts it only after its manifest and every member verify.
    recoveryGenerations: path.join(runtime, 'recovery-generations'),
    recoverySelectors: path.join(runtime, 'recovery-selectors'),
    recoveryQuarantine: path.join(runtime, 'recovery-quarantine'),
    recoverySelectorQuarantine: path.join(runtime, 'recovery-selector-quarantine'),
    receiptLock: path.join(runtime, 'receipt-effects.lock'),
    dispatchIntents: path.join(runtime, 'dispatch-intents'),
    dispatchLock: path.join(runtime, 'dispatch-intents.lock'),
    // Project-local secret used only to re-derive a prepared native launch
    // capability after response/process loss. Intent records persist a random
    // public seed and one-way capability hash, never the bearer itself.
    dispatchLaunchKey: path.join(runtime, 'dispatch-launch.key'),
    // Pre-run native-binding canary. This deliberately does not live under
    // dispatch-intents: it is infrastructure evidence, never a StageTicket,
    // run attempt, or receipt authority.
    bindingProbe: path.join(runtime, 'binding-probe.json'),
    bindingProbeLock: path.join(runtime, 'binding-probe.lock'),
    // Append-only one-way identity tombstones for resumable probe canaries.
    // One content-addressed file per exact native identity avoids an unsafe
    // eviction ceiling while keeping lookups O(1) and raw identities private.
    bindingProbeQuarantine: path.join(runtime, 'binding-probe-quarantine'),
    // Independent append-only copy of the same exact identity tombstones. A
    // wrong-type or unreadable primary quarantine directory must not make an
    // already-observed canary resumable, and recovery never replaces evidence.
    bindingProbeQuarantineFallback: path.join(runtime, 'binding-probe-quarantine-fallback'),
    // One-way hashes of retired launched-probe turns. This keeps a late native
    // SubagentStart correlated after the mutable probe record is replaced.
    bindingProbeRetiredTurns: path.join(runtime, 'binding-probe-retired-turns'),
    active: path.join(runtime, 'active.json'),
    lock: path.join(runtime, 'active.lock'),
    // Persistent scratch index for currentTreeSha's stat cache (pure cache:
    // safe to delete at any time, rebuilt on the next call).
    treeIndex: path.join(runtime, 'tree-index'),
    config: path.join(runtime, 'config.json'),
    requirementIndex: path.join(runtime, 'requirement-index.json'),
    roadmapMutation: path.join(runtime, 'roadmap-mutation.json'),
    roadmapAttestations: path.join(runtime, 'roadmap-attestations.json'),
    overrideLog: path.join(runtime, 'overrides.ndjson'),
    migration: path.join(runtime, 'migration.json'),
    // Advisory, bounded latest-result projection for automatic/manual
    // artifact retention. It is overwritten atomically rather than appended.
    artifactRetentionStatus: path.join(runtime, 'artifact-retention-status.json'),
  });
}
