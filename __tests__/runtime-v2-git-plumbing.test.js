import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { currentTreeSha, diffFiles, workingTreeStatus } from '../lib/runtime/git.js';
import { runMergeGates } from '../lib/runtime/gates.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { validateStageReceipt } from '../lib/runtime/receipt-validator.js';
import { finalizeReceipt, finalizeTicket } from '../lib/runtime/schemas.js';
import { SCHEMA_VERSION } from '../lib/runtime/constants.js';
import { startRun, statusRun } from '../lib/runtime/service.js';
import { atomicWriteJson } from '../lib/runtime/storage.js';

// Regression suite for byte-exact git plumbing: default git C-quotes paths
// containing spaces or non-ASCII ("caf\303\251.js") in its newline-delimited
// formats, so every consumer comparing those strings against claimed paths
// (clean_tree gate, receipt claims validation, hook drift attribution)
// deterministically rejected legitimate work. NUL-delimited output is the
// byte-exact contract.

const PASS_CMD = 'node -e "process.exit(0)"';

const cleanups = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV }).trim();
}

// A baseline repo containing the two filename shapes the audit reproduced as
// run-bricking: non-ASCII (café.js) and an embedded space (docs/My Doc.md).
async function project(prefix = 'ape-git-plumbing-') {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  cleanups.push(dir);
  await mkdir(path.join(dir, 'docs'));
  await writeFile(path.join(dir, 'café.js'), 'export const roast = 1;\n');
  await writeFile(path.join(dir, 'docs', 'My Doc.md'), '# Doc\n');
  await writeFile(path.join(dir, 'plain.js'), 'export const plain = 1;\n');
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'ape@example.test');
  git(dir, 'config', 'user.name', 'APE Test');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'baseline');
  return dir;
}

// Independent oracle: the pre-cache currentTreeSha algorithm, verbatim
// (throwaway index, plain read-tree, unrestricted add -A). The warm path must
// be output-identical to this for every worktree shape.
function referenceTreeSha(dir) {
  const temp = mkdtempSync(path.join(tmpdir(), 'ape-ref-index-'));
  try {
    const env = { ...GIT_ENV, GIT_INDEX_FILE: path.join(temp, 'index') };
    const ref = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', env });
    ref('read-tree', 'HEAD');
    ref('add', '-A');
    ref('rm', '-r', '--cached', '--ignore-unmatch', '-q', '--', '.ape');
    return ref('write-tree').trim();
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

describe('diffFiles byte-exact paths', () => {
  it('returns unquoted non-ASCII and space paths', async () => {
    const dir = await project();
    await writeFile(path.join(dir, 'café.js'), 'export const roast = 2;\n');
    await writeFile(path.join(dir, 'docs', 'My Doc.md'), '# Doc v2\n');
    const base = git(dir, 'rev-parse', 'HEAD^{tree}');
    const head = await currentTreeSha(dir);
    // Default git would emit "caf\303\251.js" (literal quotes and octal) and
    // "docs/My Doc.md" (quoted); both can never match a claimed path.
    expect(await diffFiles(dir, base, head)).toEqual(['café.js', 'docs/My Doc.md']);
  });
});

describe('workingTreeStatus byte-exact paths', () => {
  it('emits unquoted space/UTF-8 paths parseable by slice(3)', async () => {
    const dir = await project();
    await writeFile(path.join(dir, 'café.js'), 'export const roast = 2;\n');
    await writeFile(path.join(dir, 'stray file.md'), 'unclaimed\n');
    const status = await workingTreeStatus(dir);
    expect(status).toContain(' M café.js');
    expect(status).toContain('?? stray file.md');
    const parsed = status.map((line) => line.slice(3));
    expect(parsed).toContain('café.js');
    expect(parsed).toContain('stray file.md');
  });

  it('surfaces a staged rename as separate D/A entries matching diff --no-renames', async () => {
    const dir = await project();
    git(dir, 'mv', 'plain.js', 'renamed.js');
    const status = await workingTreeStatus(dir);
    // A rename record (`R  old -> new`, or two NUL fields under -z) would be
    // garbled by consumers' slice(3); --no-renames splits it into the same
    // D/A pair the allowed-dirty set is built from via diffFiles.
    expect(status).toContain('D  plain.js');
    expect(status).toContain('A  renamed.js');
    const base = git(dir, 'rev-parse', 'HEAD^{tree}');
    const head = await currentTreeSha(dir);
    expect(await diffFiles(dir, base, head)).toEqual(['plain.js', 'renamed.js']);
  });
});

describe('clean_tree merge gate with space/UTF-8 filenames', () => {
  function gateState(treeSha, changedFiles) {
    return {
      lane: 'mechanical',
      high_risk: false,
      receipts: [{
        receipt_hash: 'a',
        previous_receipt_hash: null,
        status: 'passed',
        agent: { role: 'implementer' },
        tests: [],
        changed_files: changedFiles,
        head_tree_sha: treeSha,
      }],
    };
  }
  const config = {
    policy: { full_suite_cache: true },
    test_commands: { targeted: null, full: PASS_CMD },
    deadlines_ms: {},
  };

  it('passes when the claimed dirty files contain spaces and UTF-8', async () => {
    const dir = await project();
    const paths = { runtime: path.join(dir, '.ape', 'runtime') };
    await mkdir(paths.runtime, { recursive: true });
    await writeFile(path.join(dir, 'café.js'), 'export const roast = 2;\n');
    await writeFile(path.join(dir, 'docs', 'My Doc.md'), '# Doc v2\n');
    const treeSha = await currentTreeSha(dir);
    const result = await runMergeGates(
      dir, paths, gateState(treeSha, ['café.js', 'docs/My Doc.md']), config,
    );
    expect(result.checks.clean_tree).toEqual({ passed: true, unexpected: [] });
    expect(result.passed).toBe(true);
  });

  it('reports an unclaimed space-named file byte-exact in unexpected_dirty', async () => {
    const dir = await project();
    const paths = { runtime: path.join(dir, '.ape', 'runtime') };
    await mkdir(paths.runtime, { recursive: true });
    await writeFile(path.join(dir, 'café.js'), 'export const roast = 2;\n');
    await writeFile(path.join(dir, 'stray file.md'), 'unclaimed\n');
    const treeSha = await currentTreeSha(dir);
    const result = await runMergeGates(dir, paths, gateState(treeSha, ['café.js']), config);
    expect(result.checks.clean_tree.passed).toBe(false);
    // Byte-exact, so the operator can act on the reported path directly.
    expect(result.checks.clean_tree.unexpected).toEqual(['stray file.md']);
    expect(result.passed).toBe(false);
  });
});

describe('receipt claims comparison end-to-end', () => {
  function ticketFor(baseTreeSha, claimedPaths) {
    const issuedAt = new Date(Date.now() - 60_000).toISOString();
    return finalizeTicket({
      schema_version: SCHEMA_VERSION,
      ticket_id: 'run-1:build:ticket-1',
      run_id: 'run-1',
      stage_id: 'build',
      parallel_group: null,
      role: 'implementer',
      objective: 'Change the flagged filenames',
      claimed_paths: claimedPaths,
      test_paths: [],
      model_tier: 'balanced',
      model: { model: 'opus' },
      deadline_at: new Date(Date.now() + 60_000).toISOString(),
      output_schema: {},
      required_checks: [],
      parent_hash: null,
      base_tree_sha: baseTreeSha,
      attempt: 1,
      writable: true,
      issued_at: issuedAt,
    });
  }

  function receiptFor(ticket, headTreeSha, changedFiles) {
    return finalizeReceipt({
      schema_version: SCHEMA_VERSION,
      receipt_id: 'receipt-1',
      run_id: ticket.run_id,
      ticket_id: ticket.ticket_id,
      ticket_hash: ticket.ticket_hash,
      agent: { host: 'claude', role: 'implementer', identity: 'agent-implementer', model: 'opus' },
      status: 'passed',
      base_tree_sha: ticket.base_tree_sha,
      head_tree_sha: headTreeSha,
      changed_files: changedFiles,
      tests: [],
      findings: [],
      evidence: { verdict: 'pass' },
      timing: {
        started_at: ticket.issued_at,
        completed_at: new Date().toISOString(),
        duration_ms: 1000,
      },
      previous_receipt_hash: null,
    });
  }

  it('admits a claimed non-ASCII/space write: diffFiles output satisfies withinClaims', async () => {
    const dir = await project();
    const base = await currentTreeSha(dir);
    const ticket = ticketFor(base, ['café.js', 'docs/My Doc.md']);
    await writeFile(path.join(dir, 'café.js'), 'export const roast = 2;\n');
    await writeFile(path.join(dir, 'docs', 'My Doc.md'), '# Doc v2\n');
    const head = await currentTreeSha(dir);
    const changed = await diffFiles(dir, base, head);
    expect(changed).toEqual(['café.js', 'docs/My Doc.md']);
    const result = await validateStageReceipt({
      project_dir: dir,
      state: { run_id: 'run-1', receipts: [] },
      ticket,
      receipt: receiptFor(ticket, head, changed),
    });
    // Under the C-quoted diff this rejected as `unclaimed write: "caf/303/251.js"`.
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('names an out-of-claims non-ASCII write byte-exact in the rejection', async () => {
    const dir = await project();
    const base = await currentTreeSha(dir);
    const ticket = ticketFor(base, ['plain.js']);
    await writeFile(path.join(dir, 'café.js'), 'export const roast = 2;\n');
    const head = await currentTreeSha(dir);
    const changed = await diffFiles(dir, base, head);
    const result = await validateStageReceipt({
      project_dir: dir,
      state: { run_id: 'run-1', receipts: [] },
      ticket,
      receipt: receiptFor(ticket, head, changed),
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('unclaimed write: café.js');
  });
});

describe('currentTreeSha persistent-index warm path', () => {
  it('matches the throwaway-index reference across staged/unstaged/untracked/deleted/UTF-8/space mixes', async () => {
    const dir = await project();
    await mkdir(path.join(dir, '.ape', 'runtime'), { recursive: true });
    const treeIndex = runtimePaths(dir).treeIndex;

    // Clean tree: first call seeds the cache.
    expect(await currentTreeSha(dir)).toBe(referenceTreeSha(dir));
    expect(existsSync(treeIndex)).toBe(true);

    // Unstaged UTF-8 modification.
    await writeFile(path.join(dir, 'café.js'), 'export const roast = 2;\n');
    expect(await currentTreeSha(dir)).toBe(referenceTreeSha(dir));

    // Staged space-path modification plus an untracked space-named file.
    await writeFile(path.join(dir, 'docs', 'My Doc.md'), '# Doc v2\n');
    git(dir, 'add', 'docs/My Doc.md');
    await writeFile(path.join(dir, 'new file.txt'), 'fresh\n');
    expect(await currentTreeSha(dir)).toBe(referenceTreeSha(dir));

    // Deleted tracked file on top of everything else.
    await rm(path.join(dir, 'plain.js'));
    const mixed = await currentTreeSha(dir);
    expect(mixed).toBe(referenceTreeSha(dir));

    // Warm repeat with no tree change is stable.
    expect(await currentTreeSha(dir)).toBe(mixed);
  });

  it('never lets .ape contents affect the sha', async () => {
    const dir = await project();
    await mkdir(path.join(dir, '.ape', 'runtime'), { recursive: true });
    const before = await currentTreeSha(dir);
    await writeFile(path.join(dir, '.ape', 'runtime', 'active.json'), '{"mutates":"every-transition"}\n');
    await writeFile(path.join(dir, '.ape', 'notes.md'), 'state\n');
    expect(await currentTreeSha(dir)).toBe(before);
  });

  it('tracks a HEAD change after a commit', async () => {
    const dir = await project();
    await mkdir(path.join(dir, '.ape', 'runtime'), { recursive: true });
    const before = await currentTreeSha(dir);
    await writeFile(path.join(dir, 'café.js'), 'export const roast = 3;\n');
    git(dir, 'add', 'café.js');
    git(dir, 'commit', '-qm', 'roast harder');
    const after = await currentTreeSha(dir);
    expect(after).not.toBe(before);
    expect(after).toBe(referenceTreeSha(dir));
    // A clean tree's sha IS the committed tree.
    expect(after).toBe(git(dir, 'rev-parse', 'HEAD^{tree}'));
  });

  it('drops a file from the tree once it becomes gitignored (warm matches cold)', async () => {
    const dir = await project();
    await mkdir(path.join(dir, '.ape', 'runtime'), { recursive: true });
    await writeFile(path.join(dir, 'scratch.log'), 'temp\n');
    const withScratch = await currentTreeSha(dir);
    expect(withScratch).toBe(referenceTreeSha(dir));
    await writeFile(path.join(dir, '.gitignore'), 'scratch.log\n');
    const ignored = await currentTreeSha(dir);
    expect(ignored).not.toBe(withScratch);
    // The warm index must not resurrect the previously-hashed entry.
    expect(ignored).toBe(referenceTreeSha(dir));
  });

  it('answers correctly from the fallback when the cached index is corrupt, then re-seeds', async () => {
    const dir = await project();
    await mkdir(path.join(dir, '.ape', 'runtime'), { recursive: true });
    const treeIndex = runtimePaths(dir).treeIndex;
    await currentTreeSha(dir);
    await writeFile(treeIndex, 'not a git index\n');
    await writeFile(path.join(dir, 'café.js'), 'export const roast = 2;\n');
    // Correctness beats speed: the corrupt cache must not surface to the caller.
    expect(await currentTreeSha(dir)).toBe(referenceTreeSha(dir));
    // The poisoned cache was dropped; the next call rebuilds it.
    const again = await currentTreeSha(dir);
    expect(again).toBe(referenceTreeSha(dir));
    expect(existsSync(treeIndex)).toBe(true);
  });

  it('is unaffected by a stray tree-index.lock left by a crashed process', async () => {
    const dir = await project();
    await mkdir(path.join(dir, '.ape', 'runtime'), { recursive: true });
    await writeFile(`${runtimePaths(dir).treeIndex}.lock`, '');
    await writeFile(path.join(dir, 'café.js'), 'export const roast = 2;\n');
    expect(await currentTreeSha(dir)).toBe(referenceTreeSha(dir));
  });

  it('returns the same correct sha to concurrent callers', async () => {
    const dir = await project();
    await mkdir(path.join(dir, '.ape', 'runtime'), { recursive: true });
    await currentTreeSha(dir);
    await writeFile(path.join(dir, 'café.js'), 'export const roast = 2;\n');
    const expected = referenceTreeSha(dir);
    // Parallel hook processes compute this concurrently; a shared index would
    // let one caller's read-tree reset another's staged scan mid-sequence.
    const shas = await Promise.all([
      currentTreeSha(dir),
      currentTreeSha(dir),
      currentTreeSha(dir),
    ]);
    expect(shas).toEqual([expected, expected, expected]);
  });

  it('never creates .ape in a project that has none', async () => {
    const dir = await project();
    expect(await currentTreeSha(dir)).toBe(referenceTreeSha(dir));
    // .ape is the project-root marker resolveProjectRoot walks up to; the
    // cache must not plant it.
    expect(existsSync(path.join(dir, '.ape'))).toBe(false);
  });
});

describe('currentTreeSha tree-sha stat-cache staleness window', () => {
  it('re-hashes a same-second, same-byte-length in-place edit instead of trusting a fresh-mtime scratch copy', async () => {
    const dir = await project();
    // git compares stat at WHOLE-SECOND mtime granularity by default (USE_NSEC
    // off), catching same-second edits only through the racy-index guard. utimes
    // bumps ctime, so trustctime=false isolates the mtime mechanism under test —
    // otherwise git's stat compare would notice the ctime change and mask the
    // staleness window this test targets.
    git(dir, 'config', 'core.trustctime', 'false');
    const cafe = path.join(dir, 'café.js');
    const treeIndex = runtimePaths(dir).treeIndex;

    // A fixed whole-second timestamp 60s in the past: whole-second matches git's
    // default mtime granularity; past guarantees the seeded index records this
    // exact (real, unsmudged) stat for café.js — no wall-clock boundary, no
    // sleep; the controlled utimes values carry the entire mechanism.
    const past = Math.floor(Date.now() / 1000) - 60;
    await utimes(cafe, past, past);

    // Seed the warm cache: the persistent index now records café.js at mtime
    // `past`, size 24 (`export const roast = 1;\n`). A clean seed is honest, so
    // warm and cold agree here regardless of the bug.
    await mkdir(runtimePaths(dir).runtime, { recursive: true });
    const seeded = await currentTreeSha(dir);
    expect(seeded).toBe(referenceTreeSha(dir));

    // Stamp the cache file itself to `past` too — the racy condition git's guard
    // exists for: the index written in the SAME second as the worktree file.
    await utimes(treeIndex, past, past);

    // In-place, same-byte-length content change then mtime restored to `past`:
    // same inode (writeFile truncates in place), same size (24 -> 24), same
    // mtime second, changed content. Only the racy-index guard can tell it is
    // dirty; every plain stat field still matches the cache.
    await writeFile(cafe, 'export const roast = 2;\n');
    await utimes(cafe, past, past);

    // The stat-less oracle re-hashes everything and sees roast=2. The warm path
    // must agree. TODAY the warm scratch copy gets a FRESH mtime (>> past) from
    // fs.copyFile, making café.js's entry non-racy; git trusts the stale
    // roast=1 blob and write-tree answers the wrong sha (equal to `seeded`, the
    // pre-edit tree). The contracted fix restores the source index's mtime
    // `past` onto the scratch, so the entry is racy (past >= past), git
    // re-hashes it, and the warm sha equals this oracle.
    expect(await currentTreeSha(dir)).toBe(referenceTreeSha(dir));
  });
});

describe('startRun rejects detached HEAD', () => {
  function startInput(overrides = {}) {
    return {
      objective: 'Exercise detached-HEAD start rejection',
      mode: 'phase',
      lane: 'fast',
      host: 'codex',
      claimed_paths: ['café.js'],
      test_paths: ['tests/value.test.js'],
      requirements: [],
      risk_triggers: [],
      behavioral: true,
      hooks_trusted: true,
      subagents_available: true,
      explicit_invocation: true,
      ...overrides,
    };
  }

  async function detachedProject() {
    const dir = await project('ape-detached-');
    await mkdir(path.join(dir, 'tests'));
    await writeFile(path.join(dir, 'tests', 'value.test.js'), 'throw new Error("red");\n');
    git(dir, 'add', 'tests');
    git(dir, 'commit', '-qm', 'tests');
    await atomicWriteJson(runtimePaths(dir).config, {
      shipping: { auto_merge: false, provider: 'github', required_remote_checks: false },
      test_commands: { full: PASS_CMD, targeted: PASS_CMD },
    });
    git(dir, 'switch', '-q', '--detach');
    return dir;
  }

  it('rejects with an actionable message before any lock, branch, or state exists', async () => {
    const dir = await detachedProject();
    const headBefore = git(dir, 'rev-parse', 'HEAD');

    const error = await startRun(dir, startInput()).then(() => null, (thrown) => thrown);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/HEAD is detached/);
    expect(error.message).toMatch(/git switch -c <branch>/);

    // Rejected at start: no run state, no run lock, no ape/* branch, and HEAD
    // is still exactly where the operator pinned it.
    expect((await statusRun(dir)).active).toBe(false);
    expect(existsSync(runtimePaths(dir).lock)).toBe(false);
    expect(git(dir, 'branch', '--list', 'ape/*')).toBe('');
    expect(git(dir, 'branch', '--show-current')).toBe('');
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(headBefore);
  });

  it('rejects mode land from detached HEAD too', async () => {
    const dir = await detachedProject();
    // A landable diff exists, but the start still needs a branch to gate on.
    await writeFile(path.join(dir, 'café.js'), 'export const roast = 2;\n');
    const error = await startRun(
      dir,
      startInput({ mode: 'land', lane: 'auto', test_paths: [] }),
    ).then(() => null, (thrown) => thrown);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/HEAD is detached/);
    expect((await statusRun(dir)).active).toBe(false);
  });
});
