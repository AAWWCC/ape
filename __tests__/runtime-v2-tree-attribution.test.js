import { execFileSync } from 'node:child_process';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sha256 } from '../lib/runtime/canonical.js';
import { currentTreeSha } from '../lib/runtime/git.js';
import * as gitRuntime from '../lib/runtime/git.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { checkTreeAttribution, completeParentToolResult, readParentToolResult, recordRejectedParentChange, rememberParentToolStart, takeParentToolStart, treeAttributionRefusal } from '../lib/runtime/tree-attribution.js';

const roots = [];
const run = 'run-synthetic-attribution';
const call = sha256('synthetic-call');
const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8',
  env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } }).trim();
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'ape-tree-attribution-'));
  roots.push(root);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Synthetic attribution');
  git(root, 'config', 'user.email', 'attribution@example.test');
  git(root, 'config', 'commit.gpgsign', 'false');
  git(root, 'config', 'core.filemode', 'true');
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'src/a.js'), 'original a\n');
  await writeFile(path.join(root, 'src/b.js'), 'original b\n');
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'baseline');
  return { root, paths: runtimePaths(root), base: await currentTreeSha(root) };
}
const storeFile = (paths, runId = run) => path.join(paths.runtime, 'tree-attribution', `${sha256(runId)}.json`);
async function change(f, file = 'src/a.js', content = 'rejected parent bytes\n') {
  await writeFile(path.join(f.root, file), content);
  return currentTreeSha(f.root);
}

describe('durable tree attribution observations', () => {
  it('leaves a missing store and absent host call identity read-only', async () => {
    const f = await fixture();
    const before = await readdir(f.root);
    expect(await checkTreeAttribution(f.paths, run, f.base)).toMatchObject({ blocked: false, affected_paths: [] });
    await rememberParentToolStart(f.paths, run, null, f.base);
    expect(await takeParentToolStart(f.paths, run, null)).toBeNull();
    expect(await takeParentToolStart(f.paths, run, call)).toBeNull();
    expect(await readdir(f.root)).toEqual(before);
  });

  it('only evaluates a fresh tree thunk when unresolved rejection evidence exists', async () => {
    const f = await fixture();
    const current = vi.fn(async () => f.base);
    await checkTreeAttribution(f.paths, run, current);
    expect(current).not.toHaveBeenCalled();
    await rememberParentToolStart(f.paths, run, call, f.base);
    await checkTreeAttribution(f.paths, run, current);
    expect(current).not.toHaveBeenCalled();
    const after = await change(f);
    await recordRejectedParentChange(f.paths, run, f.base, after, ['src/a.js']);
    current.mockResolvedValue(after);
    expect(await checkTreeAttribution(f.paths, run, current)).toEqual({ blocked: true, affected_paths: ['src/a.js'],
      restoration: [{ path: 'src/a.js', reference_tree_sha: f.base }] });
    expect(current).toHaveBeenCalledOnce();
  });

  it('renders bounded actionable restoration guidance with escaped path labels', () => {
    const entries = Array.from({ length: 20 }, (_, index) => ({ path: `${index}\n${String.fromCodePoint(0x202e)}${'x'.repeat(500)}`,
      reference_tree_sha: '1'.repeat(40) }));
    const message = treeAttributionRefusal({ affected_paths: entries.map((entry) => entry.path), restoration: entries });
    expect(message).toContain('Affected paths: 20');
    expect(message).toContain('\\n\\u202e');
    expect(message).toContain('authorized repair');
    expect(message).not.toContain('\n');
    expect(message).not.toContain(String.fromCodePoint(0x202e));
    expect(message.match(/ at /g)).toHaveLength(4);
    expect(message.length).toBeLessThan(1400);
  });

  it('matches hashed calls idempotently, preserving the original pre-tree on replay', async () => {
    const f = await fixture();
    await rememberParentToolStart(f.paths, run, call, f.base);
    const changed = await change(f);
    await rememberParentToolStart(f.paths, run, call, changed);
    expect(await takeParentToolStart(f.paths, run, sha256('other'))).toBeNull();
    expect(await takeParentToolStart(f.paths, run, call)).toBe(f.base);
    expect(await takeParentToolStart(f.paths, run, call)).toBe(f.base);
    await expect(rememberParentToolStart(f.paths, run, 'raw-session-id', f.base)).rejects.toThrow('hashed tool identity');
    expect(await readFile(storeFile(f.paths), 'utf8')).not.toContain('raw-session-id');
  });

  it.each([false, true])('preserves a completed changed=%s observation across duplicate posts and new worker changes', async (changed) => {
    const f = await fixture();
    expect(await readParentToolResult(f.paths, run, call)).toBeNull();
    await rememberParentToolStart(f.paths, run, call, f.base);
    await completeParentToolResult(f.paths, run, call, changed);
    await change(f, 'src/b.js', 'later worker change\n');
    await completeParentToolResult(f.paths, run, call, !changed);
    expect(await readParentToolResult(f.paths, run, call)).toEqual({ changed });
    expect(await takeParentToolStart(f.paths, run, call)).toBe(f.base);
  });

  it('remembers completion even when the matching pre-event is missing', async () => {
    const f = await fixture();
    await completeParentToolResult(f.paths, run, call, false);
    await rememberParentToolStart(f.paths, run, call, f.base);
    expect(await readParentToolResult(f.paths, run, call)).toEqual({ changed: false });
    expect(await takeParentToolStart(f.paths, run, call)).toBeNull();
  });

  it('atomically seals rejection with the first completed outcome and never relatches duplicate output', async () => {
    const f = await fixture();
    const after = await change(f);
    expect(await recordRejectedParentChange(f.paths, run, f.base, after, ['src/a.js'], call)).toEqual({ changed: true });
    expect(await readParentToolResult(f.paths, run, call)).toEqual({ changed: true });
    expect(await completeParentToolResult(f.paths, run, call, false)).toEqual({ changed: true });
    await checkTreeAttribution(f.paths, run, f.base);
    expect(await recordRejectedParentChange(f.paths, run, f.base, after, ['src/b.js'], call)).toEqual({ changed: true });
    expect(await checkTreeAttribution(f.paths, run, after)).toMatchObject({ blocked: false });
    const noChangeCall = sha256('no-change-call');
    await completeParentToolResult(f.paths, run, noChangeCall, false);
    expect(await recordRejectedParentChange(f.paths, run, f.base, after, ['src/a.js'], noChangeCall)).toEqual({ changed: false });
    expect(await checkTreeAttribution(f.paths, run, after)).toMatchObject({ blocked: false });
  });

  it('returns one authoritative outcome to concurrent duplicate completions', async () => {
    const f = await fixture();
    const after = await change(f);
    const outcomes = await Promise.all([
      recordRejectedParentChange(f.paths, run, f.base, after, ['src/a.js'], call),
      completeParentToolResult(f.paths, run, call, false),
      recordRejectedParentChange(f.paths, run, f.base, after, ['src/b.js'], call),
    ]);
    expect(outcomes.every((outcome) => outcome.changed === outcomes[0].changed)).toBe(true);
    const record = JSON.parse(await readFile(storeFile(f.paths), 'utf8'));
    expect(record.paths.length).toBe(outcomes[0].changed ? 1 : 0);
  });

  it('does not publish restoration after its directory lock lease is replaced', async () => {
    const f = await fixture();
    const after = await change(f);
    await recordRejectedParentChange(f.paths, run, f.base, after, ['src/a.js']);
    await change(f, 'src/a.js', 'original a\n');
    const current = await change(f, 'src/b.js', 'worker b\n');
    const before = await readFile(storeFile(f.paths));
    const originalDiff = gitRuntime.diffFiles;
    vi.spyOn(gitRuntime, 'diffFiles').mockImplementation(async (...args) => {
      const result = await originalDiff(...args);
      const lock = storeFile(f.paths).replace(/\.json$/, '.lock');
      await rename(lock, `${lock}.retired`);
      await mkdir(lock);
      return result;
    });
    await expect(checkTreeAttribution(f.paths, run, current)).rejects.toThrow(/lease/);
    expect(await readFile(storeFile(f.paths))).toEqual(before);
  });

  it('retains rejected paths across unrelated worker changes and clears only exact restoration', async () => {
    const f = await fixture();
    const rejected = await change(f);
    await recordRejectedParentChange(f.paths, run, f.base, rejected, ['src/a.js']);
    expect(await checkTreeAttribution(f.paths, run, await change(f, 'src/b.js', 'worker change\n')))
      .toMatchObject({ blocked: true, affected_paths: ['src/a.js'] });
    expect(await checkTreeAttribution(f.paths, run, await change(f, 'src/a.js', 'different repair\n')))
      .toMatchObject({ blocked: true, affected_paths: ['src/a.js'] });
    expect(await checkTreeAttribution(f.paths, run, await change(f, 'src/a.js', 'original a\n')))
      .toMatchObject({ blocked: false, affected_paths: [] });
    expect(await readFile(path.join(f.root, 'src/b.js'), 'utf8')).toBe('worker change\n');
    expect(await checkTreeAttribution(f.paths, run, await change(f, 'src/a.js', 'fresh worker output\n')))
      .toMatchObject({ blocked: false, affected_paths: [] });
  });

  it('keeps the earliest unresolved reference across repeated mutations to the same path', async () => {
    const f = await fixture();
    const first = await change(f);
    await recordRejectedParentChange(f.paths, run, f.base, first, ['src/a.js']);
    const second = await change(f, 'src/a.js', 'second rejected value\n');
    await recordRejectedParentChange(f.paths, run, first, second, ['src/a.js', 'src/a.js']);
    expect(await checkTreeAttribution(f.paths, run, first)).toMatchObject({ blocked: true, affected_paths: ['src/a.js'] });
    expect(await checkTreeAttribution(f.paths, run, f.base)).toMatchObject({ blocked: false, affected_paths: [] });
  });

  it('clears restored paths independently when observations have different references', async () => {
    const f = await fixture();
    const first = await change(f);
    await recordRejectedParentChange(f.paths, run, f.base, first, ['src/a.js']);
    const second = await change(f, 'src/b.js', 'rejected b\n');
    await recordRejectedParentChange(f.paths, run, first, second, ['src/b.js']);
    expect(await checkTreeAttribution(f.paths, run, await change(f, 'src/a.js', 'original a\n')))
      .toMatchObject({ blocked: true, affected_paths: ['src/b.js'] });
    expect(await checkTreeAttribution(f.paths, run, await change(f, 'src/b.js', 'original b\n')))
      .toMatchObject({ blocked: false, affected_paths: [] });
  });

  it('handles removed and newly added files through their complete tree entries', async () => {
    const f = await fixture();
    await rm(path.join(f.root, 'src/a.js'));
    const after = await change(f, 'src/new.js', 'new parent file\n');
    await recordRejectedParentChange(f.paths, run, f.base, after, ['src/a.js', 'src/new.js']);
    expect(await checkTreeAttribution(f.paths, run, after)).toMatchObject({ blocked: true, affected_paths: ['src/a.js', 'src/new.js'] });
    await rm(path.join(f.root, 'src/new.js'));
    expect(await checkTreeAttribution(f.paths, run, await change(f, 'src/a.js', 'original a\n')))
      .toMatchObject({ blocked: false, affected_paths: [] });
  });

  it.skipIf(process.platform === 'win32')('requires mode and symlink restoration as well as file bytes', async () => {
    const f = await fixture();
    await chmod(path.join(f.root, 'src/a.js'), 0o755);
    await rm(path.join(f.root, 'src/b.js'));
    await symlink('a.js', path.join(f.root, 'src/b.js'));
    const after = await currentTreeSha(f.root);
    await recordRejectedParentChange(f.paths, run, f.base, after, ['src/a.js', 'src/b.js']);
    expect(await checkTreeAttribution(f.paths, run, after)).toMatchObject({ blocked: true, affected_paths: ['src/a.js', 'src/b.js'] });
    await chmod(path.join(f.root, 'src/a.js'), 0o644);
    await rm(path.join(f.root, 'src/b.js'));
    expect(await checkTreeAttribution(f.paths, run, await change(f, 'src/b.js', 'original b\n')))
      .toMatchObject({ blocked: false, affected_paths: [] });
  });

  it('keeps observations isolated by run and preserves pending starts when clearing paths', async () => {
    const f = await fixture();
    const after = await change(f);
    await rememberParentToolStart(f.paths, run, call, f.base);
    await recordRejectedParentChange(f.paths, run, f.base, after, ['src/a.js']);
    expect(await checkTreeAttribution(f.paths, 'different-run', after)).toMatchObject({ blocked: false, affected_paths: [] });
    expect(await lstat(storeFile(f.paths, 'different-run')).then(() => true, () => false)).toBe(false);
    await checkTreeAttribution(f.paths, run, f.base);
    expect(await takeParentToolStart(f.paths, run, call)).toBe(f.base);
  });

  it('serializes independent observations without losing paths or tool starts', async () => {
    const f = await fixture();
    const after = await change(f);
    await Promise.all([
      recordRejectedParentChange(f.paths, run, f.base, after, ['src/a.js']),
      recordRejectedParentChange(f.paths, run, f.base, after, ['src/b.js']),
      ...Array.from({ length: 8 }, (_, index) => rememberParentToolStart(f.paths, run, sha256(`call${index}`), f.base)),
    ]);
    const record = JSON.parse(await readFile(storeFile(f.paths), 'utf8'));
    expect(record.paths.map((entry) => entry.path)).toEqual(['src/a.js', 'src/b.js']);
    expect(record.starts).toHaveLength(8);
  });

  it.each(['invalid-json', 'wrong-run', 'oversized', 'duplicate-path'])('refuses %s evidence without replacing it', async (kind) => {
    const f = await fixture();
    await rememberParentToolStart(f.paths, run, call, f.base);
    const value = kind === 'invalid-json' ? '{ synthetic-private-marker' : kind === 'oversized' ? 'x'.repeat(1024 * 1024 + 1) : JSON.stringify({
      version: 1, run_id: kind === 'wrong-run' ? 'foreign-run' : run, starts: [], paths: kind === 'duplicate-path' ? [
        { path: 'src/a.js', reference_tree_sha: f.base }, { path: 'src/a.js', reference_tree_sha: f.base },
      ] : [],
    });
    await writeFile(storeFile(f.paths), value);
    await expect(checkTreeAttribution(f.paths, run, f.base)).rejects.toThrow('tree attribution evidence');
    await expect(recordRejectedParentChange(f.paths, run, f.base, '1'.repeat(40), ['src/a.js'])).rejects.toThrow('tree attribution evidence');
    expect(await readFile(storeFile(f.paths), 'utf8')).toBe(value);
  });

  it.skipIf(process.platform === 'win32').each(['symlink', 'hardlink', 'fifo'])('refuses a %s evidence file without following or opening it', async (kind) => {
    const f = await fixture();
    await rememberParentToolStart(f.paths, run, call, f.base);
    const file = storeFile(f.paths);
    const outside = path.join(f.root, 'outside.json');
    await writeFile(outside, 'synthetic protected bytes');
    await rm(file);
    if (kind === 'symlink') await symlink(outside, file);
    if (kind === 'hardlink') await link(outside, file);
    if (kind === 'fifo') execFileSync('mkfifo', [file]);
    await expect(checkTreeAttribution(f.paths, run, f.base)).rejects.toThrow('unsafe');
    expect(await readFile(outside, 'utf8')).toBe('synthetic protected bytes');
  });

  it.skipIf(process.platform === 'win32')('refuses redirected runtime ancestry without creating an outside store', async () => {
    const f = await fixture();
    const outside = await mkdtemp(path.join(tmpdir(), 'ape-attribution-outside-'));
    roots.push(outside);
    await symlink(outside, path.join(f.root, '.ape'));
    await expect(rememberParentToolStart(f.paths, run, call, f.base)).rejects.toThrow('unsafe directory');
    expect(await readdir(outside)).toEqual([]);
  });

  it.each(['path-count', 'record-bytes', 'accumulated-paths', 'invalid-path'])('persists a whole-tree refusal when %s cannot be represented', async (kind) => {
    const f = await fixture();
    const after = await change(f);
    await recordRejectedParentChange(f.paths, run, f.base, after, ['src/a.js']);
    const files = kind === 'invalid-path' ? ['../outside'] : Array.from({ length: kind === 'path-count' ? 2049 :
      kind === 'accumulated-paths' ? 2048 : 300 }, (_, index) => `src/${index}${kind === 'record-bytes' ? 'x'.repeat(3900) : ''}.js`);
    await recordRejectedParentChange(f.paths, run, after, '1'.repeat(40), files);
    const refusal = await checkTreeAttribution(f.paths, run, after);
    expect(refusal).toEqual({ blocked: true, affected_paths: ['.'], restoration_scope: 'tree',
      restoration: [{ path: '.', reference_tree_sha: f.base }] });
    expect(treeAttributionRefusal(refusal)).toContain('restore the complete tree');
    expect((await lstat(storeFile(f.paths))).size).toBeLessThan(1024 * 1024);
    expect(await checkTreeAttribution(f.paths, run, f.base)).toMatchObject({ blocked: false });
  });
});
