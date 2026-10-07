import { gitFixtureEnv } from '../test-support/git-fixtures.js';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { mkdir, open, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
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

const GIT_ENV = gitFixtureEnv();

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

// Independent oracle: stage the whole worktree into a throwaway index, then
// restore only reserved paths from HEAD. The warm path must be output-identical
// while never staging live runtime state or deleting tracked baseline config.
function referenceTreeSha(dir) {
  const temp = mkdtempSync(path.join(tmpdir(), 'ape-ref-index-'));
  try {
    const env = { ...GIT_ENV, GIT_INDEX_FILE: path.join(temp, 'index') };
    const ref = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', env });
    ref('read-tree', 'HEAD');
    ref('add', '-A');
    ref('reset', '-q', 'HEAD', '--', '.ape');
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
  // Linux filesystems accept arbitrary filename bytes; macOS filesystems may
  // reject invalid UTF-8 with EILSEQ. Windows cannot represent this fixture.
  // U+FFFD is a distinct legal filename, not an alias for the raw 0xff byte.
  // Decode only Git's ASCII metadata, keeping tree-entry names as Buffers.
  function treeEntriesByFilenameBytes(dir, tree) {
    const output = execFileSync('git', ['ls-tree', '-r', '-z', tree], { cwd: dir, env: GIT_ENV });
    const entries = new Map();
    for (let start = 0; start < output.length;) {
      const end = output.indexOf(0, start);
      const tab = output.indexOf(9, start);
      expect(end).toBeGreaterThan(tab);
      const metadata = output.subarray(start, tab).toString('ascii').split(' ');
      entries.set(output.subarray(tab + 1, end).toString('hex'), metadata[2]);
      start = end + 1;
    }
    return entries;
  }

  const rawFilenameCases = ['cold', 'warm', 'corrupt-cache'].flatMap((mode) =>
    ['modified-with-alias', 'deleted-with-alias', 'untracked-with-alias', 'modified-without-alias']
      .map((change) => ({ mode, change })));

  it.skipIf(process.platform === 'win32').each(rawFilenameCases)(
    'preserves filesystem-supported filename bytes ($mode, $change)', async ({ mode, change }) => {
      const dir = await project();
      let rawName = Buffer.from([0x78, 0xff, 0x2e, 0x6a, 0x73]);
      const aliasName = Buffer.from('x\ufffd.js');
      const filenamePath = (name) => Buffer.concat([Buffer.from(`${dir}${path.sep}`), name]);
      let rawPath = filenamePath(rawName);
      // Probe only fixture creation, before Git or currentTreeSha runs. Keep
      // all behavioral assertions active on filesystems that reject 0xff by
      // using a distinct representable byte sequence there. Do not catch Git,
      // snapshot, permission, or other setup errors as filesystem limitations.
      try {
        await writeFile(rawPath, 'filename capability probe\n');
      } catch (error) {
        if (error.code !== 'EILSEQ') throw error;
        rawName = Buffer.from('x\u4e2d.js');
        rawPath = filenamePath(rawName);
        await writeFile(rawPath, 'filename capability probe\n');
      }
      await rm(rawPath);
      const hasAlias = change !== 'modified-without-alias';
      const isUntracked = change === 'untracked-with-alias';
      if (!isUntracked) await writeFile(rawPath, 'raw baseline\n');
      if (hasAlias) await writeFile(path.join(dir, aliasName.toString()), 'alias stays unchanged\n');
      git(dir, 'add', '-A');
      git(dir, 'commit', '-qm', 'distinct raw-byte and replacement-character paths');
      const baseline = git(dir, 'rev-parse', 'HEAD^{tree}');
      const baselineEntries = treeEntriesByFilenameBytes(dir, baseline);
      expect(baselineEntries.has(rawName.toString('hex'))).toBe(!isUntracked);
      expect(baselineEntries.has(aliasName.toString('hex'))).toBe(hasAlias);

      if (mode !== 'cold') {
        await mkdir(runtimePaths(dir).runtime, { recursive: true });
        // Seed a valid cache using real Git, independently of the function
        // under test so failure occurs at the changed-content assertion.
        execFileSync('git', ['read-tree', 'HEAD'], {
          cwd: dir, env: { ...GIT_ENV, GIT_INDEX_FILE: runtimePaths(dir).treeIndex },
        });
        if (mode === 'corrupt-cache') await writeFile(runtimePaths(dir).treeIndex, 'invalid index\n');
      }
      if (change === 'deleted-with-alias') await rm(rawPath);
      else await writeFile(rawPath, 'raw changed content\n');
      // A user index containing a different staged blob must remain intact.
      await writeFile(path.join(dir, 'plain.js'), 'staged user content\n');
      git(dir, 'add', 'plain.js');
      await writeFile(path.join(dir, 'plain.js'), 'worktree user content\n');
      const indexBefore = await readFile(path.join(dir, '.git', 'index'));
      const expected = referenceTreeSha(dir);
      const observed = await currentTreeSha(dir);
      expect(observed).toBe(expected);
      expect(observed).not.toBe(baseline);
      const entries = treeEntriesByFilenameBytes(dir, observed);
      if (change === 'deleted-with-alias') expect(entries.has(rawName.toString('hex'))).toBe(false);
      else {
        const blob = execFileSync('git', ['hash-object', '--stdin'], {
          cwd: dir, env: GIT_ENV, encoding: 'utf8', input: 'raw changed content\n',
        }).trim();
        expect(entries.get(rawName.toString('hex'))).toBe(blob);
      }
      expect(entries.get(aliasName.toString('hex'))).toBe(baselineEntries.get(aliasName.toString('hex')));
      expect(git(dir, 'show', `${observed}:plain.js`)).toBe('worktree user content');
      expect(await readFile(path.join(dir, '.git', 'index'))).toEqual(indexBefore);
    },
  );

  it.each([false, true])('observes projects that ignore the entire reserved directory (warm: %s)', async (warm) => {
    const dir = await project();
    await writeFile(path.join(dir, '.gitignore'), '.ape/\n');
    git(dir, 'add', '.gitignore');
    git(dir, 'commit', '-qm', 'ignore local runtime');
    await mkdir(path.join(dir, '.ape'));
    if (warm) await mkdir(path.join(dir, '.ape', 'runtime'));
    await writeFile(path.join(dir, '.ape', 'config.json'), '{"local":true}\n');
    const indexBefore = await readFile(path.join(dir, '.git', 'index'));
    expect(await currentTreeSha(dir)).toBe(git(dir, 'rev-parse', 'HEAD^{tree}'));
    await writeFile(path.join(dir, 'docs', 'approved.md'), '# Approved\n');
    const changedTree = await currentTreeSha(dir);
    expect(changedTree).toBe(referenceTreeSha(dir));
    expect(git(dir, 'ls-tree', '-r', '--name-only', changedTree, '--', '.ape')).toBe('');
    expect(git(dir, 'show', `${changedTree}:docs/approved.md`)).toBe('# Approved');
    await writeFile(path.join(dir, '.ape', 'config.json'), '{"local":"changed"}\n');
    expect(await currentTreeSha(dir)).toBe(changedTree);
    expect(await readFile(path.join(dir, '.git', 'index'))).toEqual(indexBefore);
  });

  it.each([false, true])('preserves tracked reserved baseline bytes while ignoring live .ape changes (warm: %s)', async (warm) => {
    const dir = await project();
    await mkdir(path.join(dir, '.ape'));
    await writeFile(path.join(dir, '.ape', 'config.json'), '{"baseline":true}\n');
    git(dir, 'add', '.ape/config.json');
    git(dir, 'commit', '-qm', 'tracked project configuration');
    if (warm) {
      await mkdir(path.join(dir, '.ape', 'runtime'));
      // A persisted cache from the prior implementation omitted tracked .ape
      // paths. The first read after upgrade must restore them from HEAD.
      const env = { ...GIT_ENV, GIT_INDEX_FILE: runtimePaths(dir).treeIndex };
      execFileSync('git', ['read-tree', 'HEAD'], { cwd: dir, env });
      execFileSync('git', ['rm', '-r', '--cached', '-q', '--', '.ape'], { cwd: dir, env });
      const oldTree = execFileSync('git', ['write-tree'], { cwd: dir, env, encoding: 'utf8' }).trim();
      expect(git(dir, 'ls-tree', '-r', '--name-only', oldTree, '--', '.ape')).toBe('');
    }
    const baselineTree = git(dir, 'rev-parse', 'HEAD^{tree}');
    expect(await currentTreeSha(dir)).toBe(baselineTree);
    await writeFile(path.join(dir, '.ape', 'config.json'), '{"live":true}\n');
    await writeFile(path.join(dir, '.ape', 'untracked.json'), '{"runtime":true}\n');
    git(dir, 'add', '.ape/config.json', '.ape/untracked.json');
    const indexBefore = await readFile(path.join(dir, '.git', 'index'));
    expect(await currentTreeSha(dir)).toBe(baselineTree);
    expect(await currentTreeSha(dir)).toBe(referenceTreeSha(dir));
    expect(await readFile(path.join(dir, '.git', 'index'))).toEqual(indexBefore);
    git(dir, 'rm', '-f', '.ape/config.json');
    expect(await currentTreeSha(dir)).toBe(baselineTree);
    await writeFile(path.join(dir, 'docs', 'new.md'), '# Approved change\n');
    const changedTree = await currentTreeSha(dir);
    expect(changedTree).toBe(referenceTreeSha(dir));
    expect(await diffFiles(dir, baselineTree, changedTree)).toEqual(['docs/new.md']);
    expect(git(dir, 'show', `${changedTree}:.ape/config.json`)).toBe('{"baseline":true}');
  });

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

  it.skipIf(process.platform === 'win32')('treats a FIFO cache as a miss without blocking tree observation', async () => {
    const dir = await project();
    await mkdir(runtimePaths(dir).runtime, { recursive: true });
    execFileSync('mkfifo', [runtimePaths(dir).treeIndex]);
    const entry = new URL('../lib/runtime/git.js', import.meta.url).href;
    // A finite child boundary makes the pre-fix blocked open a test failure,
    // without leaving a stuck libuv filesystem worker in the Vitest process.
    const result = spawnSync(process.execPath, ['--input-type=module', '-e',
      `import { currentTreeSha } from ${JSON.stringify(entry)}; console.log(await currentTreeSha(process.argv[1]));`, dir],
    { encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL' });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(referenceTreeSha(dir));
    expect(await currentTreeSha(dir)).toBe(referenceTreeSha(dir));
  });

  it.skipIf(process.platform === 'win32')('drops a symlink cache without changing its external target', async () => {
    const dir = await project();
    await mkdir(runtimePaths(dir).runtime, { recursive: true });
    const outside = mkdtempSync(path.join(tmpdir(), 'ape-index-target-'));
    cleanups.push(outside);
    const target = path.join(outside, 'index');
    await writeFile(target, 'external content\n');
    await symlink(target, runtimePaths(dir).treeIndex);
    expect(await currentTreeSha(dir)).toBe(referenceTreeSha(dir));
    expect(await readFile(target, 'utf8')).toBe('external content\n');
    expect(existsSync(runtimePaths(dir).treeIndex)).toBe(false);
  });

  it('treats an oversized cache as a miss and still computes the complete tree', async () => {
    const dir = await project();
    await mkdir(runtimePaths(dir).runtime, { recursive: true });
    const handle = await open(runtimePaths(dir).treeIndex, 'w');
    try { await handle.truncate(64 * 1024 * 1024 + 1); }
    finally { await handle.close(); }
    await writeFile(path.join(dir, 'café.js'), 'export const roast = 9;\n');
    expect(await currentTreeSha(dir)).toBe(referenceTreeSha(dir));
    expect(existsSync(runtimePaths(dir).treeIndex)).toBe(false);
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

describe('currentTreeSha excludes live files before Git observes them', () => {
  // A real clean filter runs after Git enumerates untracked paths but before
  // their blobs enter the private index. Deleting the later sorted path here
  // reproduces the vanished-file failure without scheduler timing or a mock
  // of currentTreeSha, its Git commands, or its error handling.
  async function disappearingFixture(mode, suffix) {
    const dir = await project();
    const outside = mkdtempSync(path.join(tmpdir(), 'ape-snapshot-boundary-'));
    cleanups.push(outside);
    await mkdir(path.join(dir, '.ape'));
    await writeFile(path.join(dir, '.ape', 'config.json'), 'reserved HEAD bytes\n');
    git(dir, 'add', '.ape/config.json');
    git(dir, 'commit', '-qm', 'reserved baseline');
    const folder = mode === 'cold' ? '.ape' : '.ape/runtime';
    await mkdir(path.join(dir, folder), { recursive: true });
    const trigger = `${folder}/00-trigger`;
    const victim = `${folder}/zz-generation.${suffix}.tmp`;
    const marker = path.join(outside, 'observed');
    const filter = path.join(outside, 'filter.cjs');
    await writeFile(filter, `const fs=require('node:fs');
fs.rmSync(${JSON.stringify(path.join(dir, victim))});
fs.writeFileSync(${JSON.stringify(marker)}, 'excluded file reached Git hashing');
process.stdout.write(fs.readFileSync(0));\n`);
    const quote = (value) => '"' + value.replaceAll('\\', '/').replaceAll('"', '\\"') + '"';
    git(dir, 'config', 'filter.snapshot-race.clean', `${quote(process.execPath)} ${quote(filter)}`);
    git(dir, 'config', 'filter.snapshot-race.required', 'true');
    await writeFile(path.join(dir, '.gitattributes'), `${trigger} filter=snapshot-race\n`);

    // Independent expected contents: no add/reset result is used as an oracle.
    // Check the complete path inventory and every expected blob.
    const expected = new Map([
      ['.ape/config.json', 'reserved HEAD bytes\n'],
      ['.gitattributes', `${trigger} filter=snapshot-race\n`],
      ['.gitignore', 'ignored.log\n'],
      ['café.js', 'unstaged café\n'],
      ['staged file.md', 'worktree overrides staged bytes\n'],
      ['-dash.txt', 'leading dash\n'],
      ['literal[1].txt', 'literal brackets\n'],
      [' trailing .txt', 'space boundary\n'],
      ['café new.txt', 'untracked UTF-8\n'],
    ]);
    await writeFile(path.join(dir, 'staged file.md'), 'staged bytes\n');
    git(dir, 'add', '--', 'staged file.md');
    git(dir, 'rm', '--', 'docs/My Doc.md');
    await rm(path.join(dir, 'plain.js'));
    for (const [file, content] of expected) {
      if (!file.startsWith('.ape/')) await writeFile(path.join(dir, file), content);
    }
    await writeFile(path.join(dir, 'ignored.log'), 'not user evidence\n');
    await writeFile(path.join(dir, '.ape', 'config.json'), 'live reserved edit\n');
    git(dir, 'add', '.ape/config.json');
    const arm = async () => {
      await writeFile(path.join(dir, trigger), 'trigger\n');
      await writeFile(path.join(dir, victim), 'live producer temporary bytes\n');
    };
    await arm();
    const indexBefore = await readFile(path.join(dir, '.git', 'index'));

    // Prove this is the actual Git failure independently of production. The
    // control has its own index and cannot modify the user's staged contents.
    const env = { ...GIT_ENV, GIT_INDEX_FILE: path.join(outside, 'control-index') };
    execFileSync('git', ['read-tree', 'HEAD'], { cwd: dir, env });
    const control = spawnSync('git', ['add', '-A'], { cwd: dir, env, encoding: 'utf8' });
    expect(control.error).toBeUndefined();
    expect(control.status).not.toBe(0);
    expect(control.stderr).toContain(victim);
    expect(await readFile(marker, 'utf8')).toBe('excluded file reached Git hashing');
    expect(existsSync(path.join(dir, victim))).toBe(false);
    expect(await readFile(path.join(dir, '.git', 'index'))).toEqual(indexBefore);
    await rm(marker);
    await arm();
    if (mode === 'corrupt-cache') await writeFile(runtimePaths(dir).treeIndex, 'invalid index forces cold fallback\n');
    return { dir, marker, expected, indexBefore };
  }

  async function assertContents(dir, tree, expected) {
    const names = execFileSync('git', ['ls-tree', '-r', '--name-only', '-z', tree],
      { cwd: dir, env: GIT_ENV, encoding: 'utf8' }).split('\0').filter(Boolean);
    expect(names.sort()).toEqual([...expected.keys()].sort());
    for (const [file, content] of expected) {
      expect(execFileSync('git', ['show', `${tree}:${file}`],
        { cwd: dir, env: GIT_ENV, encoding: 'utf8' }), file).toBe(content);
    }
  }

  it.each(['cold', 'corrupt-cache'].flatMap((mode) => ['proof.producers', 'heartbeat'].map((suffix) => ({ mode, suffix }))))(
    'does not observe a disappearing excluded $suffix file through $mode staging', async ({ mode, suffix }) => {
      const f = await disappearingFixture(mode, suffix);
      const tree = await currentTreeSha(f.dir);
      expect(existsSync(f.marker), 'excluded filter must never reach the staging sink').toBe(false);
      await assertContents(f.dir, tree, f.expected);
      expect(await readFile(path.join(f.dir, '.git', 'index'))).toEqual(f.indexBefore);

      // Repeated and concurrent warm writers must agree with the independently
      // checked cold tree, even while the excluded filter remains armed.
      await mkdir(runtimePaths(f.dir).runtime, { recursive: true });
      expect(await Promise.all([currentTreeSha(f.dir), currentTreeSha(f.dir)])).toEqual([tree, tree]);
      expect(existsSync(f.marker)).toBe(false);
      expect(await readFile(path.join(f.dir, '.git', 'index'))).toEqual(f.indexBefore);
    });

  it.each([false, true])('surfaces genuine eligible-file Git failures and preserves the index (warm: %s)', async (warm) => {
    const dir = await project();
    if (warm) await mkdir(runtimePaths(dir).runtime, { recursive: true });
    await writeFile(path.join(dir, '.gitattributes'), 'café.js filter=reject-user\n');
    git(dir, 'config', 'filter.reject-user.clean', 'exit 19');
    git(dir, 'config', 'filter.reject-user.required', 'true');
    await writeFile(path.join(dir, 'café.js'), 'must not silently omit this change\n');
    const before = await readFile(path.join(dir, '.git', 'index'));
    await expect(currentTreeSha(dir)).rejects.toThrow(/filter|failed/);
    expect(await readFile(path.join(dir, '.git', 'index'))).toEqual(before);
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
