import { execFileSync } from 'node:child_process';
import { access, chmod, mkdtemp, mkdir, readFile, readdir, realpath as realpathForTest, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { previewRun, startRun } from '../lib/runtime/lifecycle-service.js';
import { resolveAdmissionExecutable } from '../lib/runtime/admission.js';

const roots = [];
const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'ape-admission-'));
  roots.push(root);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Synthetic admission');
  git(root, 'config', 'user.email', 'admission@example.test');
  await writeFile(path.join(root, 'README.md'), 'Synthetic baseline\n');
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'baseline');
  return root;
}
async function configuration(root, config) {
  await mkdir(path.join(root, '.ape/runtime'), { recursive: true });
  await writeFile(path.join(root, '.ape/runtime/config.json'), JSON.stringify(config));
}
const request = (extra = {}) => ({
  objective: 'Clarify the synthetic readme', mode: 'phase', lane: 'mechanical', host: 'codex',
  behavioral: false, claimed_paths: ['README.md'], test_paths: [], hooks_trusted: true,
  subagents_available: true, explicit_invocation: true, admission_contract_version: 1, ...extra,
});

describe('reviewed admission manifest through real lifecycle boundary', () => {
  it('preview is read-only and returns stable reviewed inputs, not an authorization assertion', async () => {
    const root = await fixture();
    const index = await readFile(path.join(root, '.git/index'));
    const before = await readdir(root);
    const first = await previewRun(root, request());
    const second = await previewRun(root, request());
    expect(first.admission.version).toBe(1);
    expect(first.admission.authorization).toBe('reviewed-inputs-only');
    expect(first.admission_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(second.admission_digest).toBe(first.admission_digest);
    expect(await readdir(root)).toEqual(before);
    expect(await readFile(path.join(root, '.git/index'))).toEqual(index);
  });
  it('requires a digest before even creating runtime storage', async () => {
    const root = await fixture();
    const result = await startRun(root, request());
    expect(result).toMatchObject({ ok: false, attempts_consumed: 0, code: 'admission-preview-required' });
    expect(await readdir(root)).not.toContain('.ape');
    expect(git(root, 'branch', '--show-current')).toBe('main');
  });
  it('discloses staged runtime metadata even though unstaged runtime bookkeeping is excluded', async () => {
    const root = await fixture();
    await mkdir(path.join(root, '.ape'));
    await writeFile(path.join(root, '.ape/info.txt'), 'synthetic staged metadata');
    git(root, 'add', '.ape/info.txt');
    const before = await readFile(path.join(root, '.git/index'));
    const preview = await previewRun(root, request());
    expect(preview.admission.blocking).toContainEqual(expect.objectContaining({ code: 'runtime-metadata-staged', paths: ['.ape/info.txt'] }));
    expect(await readFile(path.join(root, '.git/index'))).toEqual(before);
  });
  it('rejects reviewed input, index, and file drift before branch or worker mutation', async () => {
    for (const drift of ['input', 'index', 'file', 'config']) {
      const root = await fixture();
      const preview = await previewRun(root, request());
      let input = request({ expected_admission_digest: preview.admission_digest });
      if (drift === 'input') input = { ...input, objective: 'Different work' };
      if (drift === 'file' || drift === 'index') await writeFile(path.join(root, 'README.md'), 'changed\n');
      if (drift === 'index') git(root, 'add', 'README.md');
      if (drift === 'config') {
        await mkdir(path.join(root, '.ape/runtime'), { recursive: true });
        await writeFile(path.join(root, '.ape/runtime/config.json'), JSON.stringify({ policy: { fast_max_files: 5 } }));
      }
      const result = await startRun(root, input);
      expect(result, drift).toMatchObject({ ok: false, attempts_consumed: 0, code: 'admission-drift' });
      expect(git(root, 'branch', '--show-current')).toBe('main');
      expect(git(root, 'for-each-ref', '--format=%(refname)', 'refs/heads')).toBe('refs/heads/main');
      expect(await access(path.join(root, '.ape/runtime/active.json')).then(() => true, () => false)).toBe(false);
    }
  });
  it('discloses staged, unstaged and unclaimed land paths without widening approved scope', async () => {
    const root = await fixture();
    await writeFile(path.join(root, 'README.md'), 'staged\n'); git(root, 'add', 'README.md');
    await writeFile(path.join(root, 'unexpected.txt'), 'not approved\n');
    const result = await previewRun(root, request({ mode: 'land' }));
    expect(result.admission.ready).toBe(false);
    expect(result.admission.repository.staged_paths).toContain('README.md');
    expect(result.admission.scope.missing_approval).toContain('unexpected.txt');
    expect(result.admission.scope.claimed_paths).toEqual(['README.md']);
  });
  it('admits unchanged reviewed inputs and seals the original manifest', async () => {
    const root = await fixture();
    const preview = await previewRun(root, request());
    expect(preview.admission.ready).toBe(true);
    const started = await startRun(root, request({ expected_admission_digest: preview.admission_digest }));
    expect(started.ok).toBe(true);
    const state = JSON.parse(await readFile(path.join(root, '.ape/runtime/active.json'), 'utf8'));
    expect(state.admission.digest).toBe(preview.admission_digest);
    expect(state.admission.manifest).toEqual(preview.admission);
  });
  it('requires approved generated outputs before issuing a writer ticket', async () => {
    const root = await fixture();
    const profile = { id: 'generate-docs', command: 'node --version', roles: ['implementer'], effect: 'write', output_paths: ['docs/generated.md'] };
    await configuration(root, { policy: { command_profiles: [profile] } });
    const missing = await previewRun(root, request());
    expect(missing.admission.ready).toBe(false);
    expect(missing.admission.scope.missing_approval).toEqual(['docs/generated.md']);
    const approved = await previewRun(root, request({ claimed_paths: ['README.md', 'docs/generated.md'] }));
    expect(approved.admission.ready).toBe(true);
    const started = await startRun(root, request({ claimed_paths: ['README.md', 'docs/generated.md'], expected_admission_digest: approved.admission_digest }));
    expect(started.ok).toBe(true);
    expect(started.run.tickets[0].claimed_paths).toContain('docs/generated.md');
  });
  it('does not disguise a generator as verification or grant tracked writes to read-only workers', async () => {
    for (const invalid of ['readonly', 'verification', 'runner', 'undeclared']) {
      const root = await fixture();
      const profile = { id: 'generate-docs', command: 'node --version', roles: invalid === 'readonly' ? ['reviewer'] : ['implementer'], effect: 'write', ...(invalid === 'undeclared' ? {} : { output_paths: ['docs/generated.md'] }) };
      await configuration(root, { policy: { command_profiles: [profile] }, ...(invalid === 'verification' ? { test_commands: { full: profile.command } } : {}),
        ...(invalid === 'runner' ? { runners: [{ id: 'docs', root: '.', owns: ['docs/**'], profile: { full: profile.command } }] } : {}) });
      const preview = await previewRun(root, request({ claimed_paths: ['README.md', 'docs/generated.md'] }));
      expect(preview.admission.blocking.some((item) => item.code === 'invalid-command-effect-contract')).toBe(true);
      expect(git(root, 'branch', '--show-current')).toBe('main');
    }
  });
  it('distinguishes an unavailable executable from baseline test failure without running it', async () => {
    const root = await fixture();
    await configuration(root, { test_commands: { full: 'ape-synthetic-missing-runner --test' } });
    const missing = await previewRun(root, request());
    expect(missing.admission.blocking.some((item) => item.code === 'command-executable-unavailable')).toBe(true);
    await configuration(root, { test_commands: { full: 'node -e "process.exit(1)"' } });
    const available = await previewRun(root, request());
    expect(available.admission.ready).toBe(true);
    expect(available.admission.baseline.execution).toBe('not-run-by-read-only-preview');
  });
  it('rejects special changed files without opening a FIFO or mutating the index', async () => {
    const root = await fixture();
    await rm(path.join(root, 'README.md'));
    execFileSync('mkfifo', [path.join(root, 'README.md')]);
    const before = await readFile(path.join(root, '.git/index'));
    const preview = await previewRun(root, request({ mode: 'land' }));
    expect(preview.admission.ready).toBe(false);
    expect(preview.admission.blocking.some((entry) => /not a regular file/.test(entry.message ?? ''))).toBe(true);
    expect(await readFile(path.join(root, '.git/index'))).toEqual(before);
  });
  it('hashes a Git symlink itself without following its target', async () => {
    const root = await fixture();
    await symlink('/outside-project/does-not-exist', path.join(root, 'link'));
    const preview = await previewRun(root, request({ mode: 'land', claimed_paths: ['README.md', 'link'] }));
    expect(preview.admission.repository.changed_content.find((entry) => entry.path === 'link')).toMatchObject({ kind: 'symlink' });
    expect(preview.admission.repository.changed_content.find((entry) => entry.path === 'link')).not.toHaveProperty('sha256');
  });
  it('checks run-local command executables even with an otherwise available capability catalog', async () => {
    const root = await fixture();
    const preview = await previewRun(root, request({ mode: 'debug', lane: 'auto', binding_protocol: 'native-v1',
      run_command_profiles: [{ id: 'measurement', command: 'ape-missing-measurement-binary', roles: ['debugger'], effect: 'execute', operator_authorized: true, reason: 'Synthetic approved exact measurement' }] }));
    expect(preview.admission.blocking).toContainEqual(expect.objectContaining({ code: 'command-executable-unavailable', profile: 'command:measurement' }));
  });
  it('resolves Windows executable extensions and never treats a directory as an executable', async () => {
    const root = await fixture();
    await mkdir(path.join(root, 'not-a-tool'));
    await writeFile(path.join(root, 'node.EXE'), 'synthetic executable bytes; never launched');
    await writeFile(path.join(root, 'npm.CMD'), 'synthetic shim bytes; never launched');
    await chmod(path.join(root, 'node.EXE'), 0o755); await chmod(path.join(root, 'npm.CMD'), 0o755);
    const options = { platform: 'win32', env: { PATH: root, PATHEXT: '.EXE;.CMD' } };
    expect(await resolveAdmissionExecutable(root, 'node', options)).toBe(await realpathForTest(path.join(root, 'node.EXE')));
    expect(await resolveAdmissionExecutable(root, 'npm', options)).toBe(await realpathForTest(path.join(root, 'npm.CMD')));
    expect(await resolveAdmissionExecutable(root, 'not-a-tool', options)).toBeNull();
  });
});
