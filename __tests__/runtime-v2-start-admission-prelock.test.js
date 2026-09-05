import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { previewRun, startRun } from '../lib/runtime/lifecycle-service.js';

const directories = [];
const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
afterEach(async () => {
  await Promise.all(directories.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'ape-start-admission-prelock-'));
  directories.push(root);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Synthetic admission');
  git(root, 'config', 'user.email', 'admission@example.test');
  await writeFile(path.join(root, 'README.md'), 'Synthetic baseline\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'baseline');
  return root;
}
const request = (extra = {}) => ({
  objective: 'Clarify the synthetic readme', mode: 'phase', lane: 'mechanical', host: 'codex',
  behavioral: false, claimed_paths: ['README.md'], test_paths: [], hooks_trusted: true,
  subagents_available: true, explicit_invocation: true, admission_contract_version: 1,
  supersedes_run: 'run-prior-history', ...extra,
});
async function snapshot(root) {
  return {
    entries: (await readdir(root)).sort(),
    index: await readFile(path.join(root, '.git/index')),
    head: git(root, 'rev-parse', 'HEAD'),
    branches: git(root, 'for-each-ref', '--format=%(refname)', 'refs/heads'),
    readme: await readFile(path.join(root, 'README.md'), 'utf8'),
  };
}

describe('supersession admission precedes receipt-lock storage', () => {
  it('refuses a missing preview digest without creating runtime ancestors', async () => {
    const root = await fixture();
    const before = await snapshot(root);
    expect(await startRun(root, request())).toMatchObject({
      ok: false, code: 'admission-preview-required', attempts_consumed: 0,
    });
    expect(await snapshot(root)).toEqual(before);
  });

  it.each([
    { label: 'string', value: 'not a run id' },
    { label: 'number', value: 42 },
    { label: 'boolean', value: true },
    { label: 'object', value: {} },
    { label: 'array', value: [] },
  ])('rejects malformed supersedes_run $label before any lock write', async ({ value: supersedes_run }) => {
    const root = await fixture();
    const before = await snapshot(root);
    await expect(startRun(root, request({ supersedes_run }))).rejects.toThrow(/supersedes_run/);
    expect(await snapshot(root)).toEqual(before);
  });

  it('refuses stale reviewed inputs without creating runtime ancestors', async () => {
    const root = await fixture();
    const preview = await previewRun(root, request());
    const before = await snapshot(root);
    expect(await startRun(root, request({
      objective: 'Different work', expected_admission_digest: preview.admission_digest,
    }))).toMatchObject({ ok: false, code: 'admission-drift', attempts_consumed: 0 });
    expect(await snapshot(root)).toEqual(before);
  });

  it.each(['.ape', 'runtime'])('does not write through a redirected %s ancestor before refusal', async (redirect) => {
    const root = await fixture();
    const outside = await mkdtemp(path.join(tmpdir(), 'ape-start-admission-outside-'));
    directories.push(outside);
    await writeFile(path.join(outside, 'sentinel'), 'unchanged\n');
    if (redirect === 'runtime') await mkdir(path.join(root, '.ape'));
    await symlink(outside, path.join(root, '.ape', ...(redirect === 'runtime' ? ['runtime'] : [])),
      process.platform === 'win32' ? 'junction' : 'dir');
    const before = await snapshot(root);
    const outsideBefore = await stat(outside, { bigint: true });
    await expect(startRun(root, request())).rejects.toThrow(/APE (?:state|runtime) path/);
    expect(await readdir(outside)).toEqual(['sentinel']);
    expect(await readFile(path.join(outside, 'sentinel'), 'utf8')).toBe('unchanged\n');
    const outsideAfter = await stat(outside, { bigint: true });
    expect(outsideAfter.mtimeNs).toBe(outsideBefore.mtimeNs);
    expect(outsideAfter.ctimeNs).toBe(outsideBefore.ctimeNs);
    expect(await snapshot(root)).toEqual(before);
  });
});
