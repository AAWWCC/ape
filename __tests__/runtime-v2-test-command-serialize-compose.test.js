import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runMergeGates } from '../lib/runtime/gates.js';
import { currentTreeSha } from '../lib/runtime/git.js';
import { sha256 } from '../lib/runtime/canonical.js';
import { atomicWriteJson } from '../lib/runtime/storage.js';

// Roadmap entry test-command-modifiers (serialize half). Public contract under
// test — the composable serialized re-gate modifier at gates.js
// resolveSuiteCommand, observed through the runMergeGates full_suite check:
//   * A new nullable string slot test_commands.serialize (null default). On a
//     re-gate evaluation (state.regate_attempts > 0) whose test_commands.full_serial
//     is UNSET, the resolved full-suite command is `full` with `serialize`
//     APPENDED, so the reported checks.full_suite.command is `${full} ${serialize}`.
//   * test_commands.full_serial retains precedence as the escape hatch: when it
//     is set the whole serialized command replaces `full` and `serialize` is not
//     also appended (byte-identical to today).
//   * Backward compatible: serialize composes ONLY on re-gate. The first
//     evaluation (regate_attempts 0) runs the plain `full` even when serialize
//     is set, so an unset/first-eval install is byte-identical to today.
//   * The suite cache key hashes the RESOLVED command, so a passing cache entry
//     for the parallel `full` command can never cross-answer the composed serial
//     re-gate (invariant 9: the composed serial suite still executes and decides).
//
// RED AT THE BASE TREE: today resolveSuiteCommand only consults full_serial, so
// with full_serial unset a re-gate resolves the plain parallel `full` — the
// composition and its distinct cache key do not exist yet (anchors below).
// GREEN GUARDS (green today and post-fix): full_serial precedence; the first
// evaluation never composes.

// A distinct-but-runnable pair of exit-0, quote-free suite commands so the
// resolved command string is asserted without any tokenize/rejoin ambiguity.
const FULL = 'node --version';
const SERIALIZE = '--no-warnings';
const COMPOSED = `${FULL} ${SERIALIZE}`;
const FULL_SERIAL = 'node --help';

const cleanups = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  }).trim();
}

// A committed scratch git project plus the runtime dir runMergeGates reads/writes
// its suite cache under.
async function gatesProject() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-serialize-gates-'));
  cleanups.push(dir);
  await mkdir(path.join(dir, 'src'));
  await writeFile(path.join(dir, 'src', 'value.js'), 'export const value = 1;\n');
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'ape@example.test');
  git(dir, 'config', 'user.name', 'APE Test');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'test: baseline');
  const paths = { runtime: path.join(dir, '.ape', 'runtime') };
  await mkdir(paths.runtime, { recursive: true });
  const treeSha = await currentTreeSha(dir);
  return { dir, paths, treeSha };
}

// Mechanical lane isolates the full_suite check (no behavioral targeted
// derivation competes). regate_attempts defaults to 1 — the re-gate signal
// resolveSuiteCommand keys on — and is overridable per test.
function regateState(treeSha, overrides = {}) {
  return {
    lane: 'mechanical',
    high_risk: false,
    regate_attempts: 1,
    receipts: [{
      receipt_hash: 'a',
      previous_receipt_hash: null,
      status: 'passed',
      agent: { role: 'implementer' },
      tests: [{ command: 'self-reported', passed: true, exit_code: 0 }],
      changed_files: ['src/value.js'],
      head_tree_sha: treeSha,
    }],
    ...overrides,
  };
}

function gatesConfig(testCommands) {
  return {
    policy: { fast_max_files: 6, full_suite_cache: true },
    test_commands: { targeted: null, ...testCommands },
    deadlines_ms: {},
  };
}

// A PASSING cache entry keyed exactly the way gateSuiteContext keys the FULL
// suite: `${treeSha}:${sha256({ command })}`. Only passing results are served.
async function seedPassingCacheEntry(paths, treeSha, command) {
  const cachePath = path.join(paths.runtime, 'suite-cache.json');
  const cacheKey = `${treeSha}:${sha256({ command })}`;
  await atomicWriteJson(cachePath, {
    schema_version: '2.0.0',
    results: {
      [cacheKey]: {
        passed: true,
        tree_sha: treeSha,
        command,
        result_hash: 'seeded-parallel-base-pass',
        recorded_at: '2026-07-21T10:00:00.000Z',
        verification: { passed: true, exit_code: 0, duration_ms: 5, output: '', tooling_failure: false },
      },
    },
  });
  return cacheKey;
}

describe('serialized re-gate modifier composition (test-command-modifiers)', () => {
  it('RED-AT-BASE: on re-gate an unset full_serial composes test_commands.serialize onto full', async () => {
    const { dir, paths, treeSha } = await gatesProject();
    const result = await runMergeGates(dir, paths, regateState(treeSha), gatesConfig({ full: FULL, serialize: SERIALIZE }));
    // TODAY re-gate resolves the plain parallel `full` (serialize is ignored),
    // so the reported command is FULL — this is the red anchor. Post-fix the
    // serialize modifier is appended to form the serialized re-gate command.
    expect(result.checks.full_suite.command).toBe(COMPOSED);
  }, 30_000);

  it('green guard: test_commands.full_serial retains precedence over serialize on re-gate', async () => {
    const { dir, paths, treeSha } = await gatesProject();
    const result = await runMergeGates(
      dir,
      paths,
      regateState(treeSha),
      gatesConfig({ full: FULL, full_serial: FULL_SERIAL, serialize: SERIALIZE }),
    );
    // The escape hatch wins unchanged: the whole serialized command replaces
    // `full` and the serialize modifier is NOT also appended.
    expect(result.checks.full_suite.command).toBe(FULL_SERIAL);
  }, 30_000);

  it('green guard: the first (non-re-gate) evaluation never composes serialize onto full', async () => {
    const { dir, paths, treeSha } = await gatesProject();
    const result = await runMergeGates(
      dir,
      paths,
      regateState(treeSha, { regate_attempts: 0 }),
      gatesConfig({ full: FULL, serialize: SERIALIZE }),
    );
    // regate_attempts 0: serialize composes ONLY on re-gate, so the first
    // evaluation runs the plain `full` byte-identically (backward compatible).
    expect(result.checks.full_suite.command).toBe(FULL);
  }, 30_000);

  it('RED-AT-BASE: a passing cache entry for the parallel full command never answers the composed serial re-gate', async () => {
    const { dir, paths, treeSha } = await gatesProject();
    await seedPassingCacheEntry(paths, treeSha, FULL);
    const result = await runMergeGates(dir, paths, regateState(treeSha), gatesConfig({ full: FULL, serialize: SERIALIZE }));
    // TODAY the re-gate resolves plain FULL, whose cache key matches the seeded
    // pass, so the parallel base cross-answers and the check reads cached FULL —
    // the red anchor. Post-fix the composed command hashes to a distinct key,
    // so the parallel base pass can never satisfy the serialized re-gate: the
    // composed suite executes fresh (uncached) and is reported honestly.
    expect(result.checks.full_suite.cached).toBe(false);
    expect(result.checks.full_suite.command).toBe(COMPOSED);
  }, 30_000);
});
