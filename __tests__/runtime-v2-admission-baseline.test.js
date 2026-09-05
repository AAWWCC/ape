import { execFileSync } from 'node:child_process';
import { access, chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { entryScripts, inspectAdmissionBaseline } from '../lib/runtime/admission-baseline.js';
import { previewRun, startRun } from '../lib/runtime/lifecycle-service.js';

const roots = [];
const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));
async function put(root, file, content) {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), content);
}
async function fixture(baseFiles = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'ape-admission-baseline-'));
  roots.push(root);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Synthetic baseline');
  git(root, 'config', 'user.email', 'baseline@example.test');
  for (const [file, content] of Object.entries({ 'README.md': 'base\n', ...baseFiles })) await put(root, file, content);
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'base');
  const base = git(root, 'rev-parse', 'HEAD');
  git(root, 'switch', '-qc', 'feature');
  return { root, base };
}
function commit(root) { git(root, 'add', '.'); git(root, 'commit', '-qm', 'feature'); }
async function inspect(f, command, extra = {}) {
  return inspectAdmissionBaseline(f.root, { mode: 'phase', ...extra }, {
    head: git(f.root, 'rev-parse', 'HEAD'), base_commit: f.base, unborn: false,
  }, [{ id: 'test:full', command, root: extra.commandRoot ?? '.' }], [{
    id: 'test:full', resolved: command.startsWith('./') ? path.join(f.root, command) : process.execPath,
  }]);
}
const pkg = (script, extra = {}) => JSON.stringify({ scripts: { check: script }, ...extra });

describe('command availability on the actual scheduled baseline', () => {
  it('separates explicit preload prerequisites from future test operands', () => {
    expect(entryScripts(['node', '--require=./setup.js', '--test', '{paths}'])).toEqual(['./setup.js']);
    expect(entryScripts(['node', '--import', './setup.js', '--test', 'future.test.js'])).toEqual(['./setup.js']);
    expect(entryScripts(['node', '-e', 'process.exit(0)'])).toEqual([]);
  });

  it('rejects a clean feature-only local executable before branch or ticket mutation', async () => {
    const f = await fixture();
    await put(f.root, 'scripts/check', '#!/bin/sh\nexit 0\n');
    await chmod(path.join(f.root, 'scripts/check'), 0o755);
    commit(f.root);
    await put(f.root, '.ape/runtime/config.json', JSON.stringify({ test_commands: { full: './scripts/check' } }));
    const index = await readFile(path.join(f.root, '.git/index'));
    const input = {
      objective: 'Clarify the synthetic readme', mode: 'phase', lane: 'mechanical', host: 'claude',
      behavioral: false, claimed_paths: ['README.md'], test_paths: [], hooks_trusted: true,
      subagents_available: true, explicit_invocation: true, admission_contract_version: 1,
    };
    const preview = await previewRun(f.root, input);
    expect(preview.admission.ready).toBe(false);
    expect(preview.admission.blocking).toContainEqual(expect.objectContaining({ code: 'baseline-command-prerequisite-drift', paths: ['scripts/check'] }));
    const started = await startRun(f.root, { ...input, expected_admission_digest: preview.admission_digest });
    expect(started).toMatchObject({ ok: false, code: 'admission-not-ready', attempts_consumed: 0 });
    expect(git(f.root, 'branch', '--show-current')).toBe('feature');
    expect(git(f.root, 'for-each-ref', '--format=%(refname)', 'refs/heads')).toBe('refs/heads/feature\nrefs/heads/main');
    expect(await readFile(path.join(f.root, '.git/index'))).toEqual(index);
    expect(await access(path.join(f.root, '.ape/runtime/active.json')).then(() => true, () => false)).toBe(false);
  });

  it('detects changed exact interpreter entry scripts even when node is available', async () => {
    const f = await fixture({ 'scripts/check.js': 'process.exit(0);\n' });
    await put(f.root, 'scripts/check.js', 'process.exit(1);\n'); commit(f.root);
    expect(await inspect(f, 'node scripts/check.js')).toContainEqual(expect.objectContaining({
      code: 'baseline-command-prerequisite-drift', paths: ['scripts/check.js'],
    }));
  });

  it('rejects a feature-only env-wrapped entry in real preview without mutation', async () => {
    const f = await fixture();
    await put(f.root, 'scripts/check.js', 'process.exit(1);\n'); commit(f.root);
    await put(f.root, '.ape/runtime/config.json', JSON.stringify({ test_commands: { full: 'env NODE_ENV=test node scripts/check.js' } }));
    const index = await readFile(path.join(f.root, '.git/index'));
    const preview = await previewRun(f.root, {
      objective: 'Clarify the synthetic readme', mode: 'phase', lane: 'mechanical', host: 'claude',
      behavioral: false, claimed_paths: ['README.md'], test_paths: [], hooks_trusted: true,
      subagents_available: true, explicit_invocation: true, admission_contract_version: 1,
    });
    expect(preview.admission.ready).toBe(false);
    expect(preview.admission.blocking).toContainEqual(expect.objectContaining({
      code: 'baseline-command-prerequisite-drift', paths: ['scripts/check.js'],
    }));
    expect(git(f.root, 'branch', '--show-current')).toBe('feature');
    expect(await readFile(path.join(f.root, '.git/index'))).toEqual(index);
    expect(await access(path.join(f.root, '.ape/runtime/active.json')).then(() => true, () => false)).toBe(false);
  });

  it('retains env-wrapped package and script entries in the baseline comparison', async () => {
    const f = await fixture({ 'package.json': pkg('env NODE_ENV=test node scripts/check.js') });
    await put(f.root, 'scripts/check.js', 'process.exit(1);\n'); commit(f.root);
    expect(await inspect(f, 'env NODE_ENV=test npm run check')).toContainEqual(expect.objectContaining({
      code: 'baseline-command-prerequisite-drift', paths: ['scripts/check.js'],
    }));
  });

  it('tracks a project-local delegate selected by literal env PATH', async () => {
    const f = await fixture();
    await put(f.root, 'tools/check', '#!/bin/sh\nexit 1\n');
    await chmod(path.join(f.root, 'tools/check'), 0o755); commit(f.root);
    expect(await inspect(f, 'env PATH=./tools check')).toContainEqual(expect.objectContaining({
      code: 'baseline-command-prerequisite-drift', paths: ['tools/check'],
    }));
    const unchanged = await fixture({ 'tools/check': '#!/bin/sh\nexit 1\n' });
    await chmod(path.join(unchanged.root, 'tools/check'), 0o755);
    git(unchanged.root, 'add', 'tools/check'); git(unchanged.root, 'commit', '--amend', '--no-edit', '-q');
    unchanged.base = git(unchanged.root, 'rev-parse', 'HEAD');
    await put(unchanged.root, 'README.md', 'feature\n'); commit(unchanged.root);
    expect(await inspect(unchanged, 'env PATH=./tools check')).toEqual([]);
  });

  it('admits unchanged literal env-wrapped prerequisites without executing the script', async () => {
    const f = await fixture({
      'package.json': pkg('env NODE_ENV=test node scripts/check.js'),
      'scripts/check.js': "require('node:fs').writeFileSync('SHOULD_NOT_EXIST', 'executed'); process.exit(1);\n",
    });
    await put(f.root, 'README.md', 'feature\n'); commit(f.root);
    expect(await inspect(f, 'env NODE_ENV=test node scripts/check.js')).toEqual([]);
    expect(await inspect(f, 'env NODE_ENV=test npm run check')).toEqual([]);
    await put(f.root, '.ape/runtime/config.json', JSON.stringify({ test_commands: { full: 'env NODE_ENV=test node scripts/check.js' } }));
    const preview = await previewRun(f.root, {
      objective: 'Clarify the synthetic readme', mode: 'phase', lane: 'mechanical', host: 'claude',
      behavioral: false, claimed_paths: ['README.md'], test_paths: [], hooks_trusted: true,
      subagents_available: true, explicit_invocation: true, admission_contract_version: 1,
    });
    expect(preview.admission.ready).toBe(true);
    expect(await access(path.join(f.root, 'SHOULD_NOT_EXIST')).then(() => true, () => false)).toBe(false);
  });

  it('includes extensionless interpreter entries and exact package-script executables', async () => {
    const f = await fixture({ 'scripts/check': 'process.exit(0);\n', 'package.json': pkg('./scripts/check') });
    await put(f.root, 'scripts/check', 'process.exit(1);\n'); commit(f.root);
    expect(await inspect(f, 'node scripts/check')).toContainEqual(expect.objectContaining({ paths: ['scripts/check'] }));
    expect(await inspect(f, 'npm run check')).toContainEqual(expect.objectContaining({ paths: ['scripts/check'] }));
  });

  it('detects removed execute permissions as a tracked prerequisite change', async () => {
    const f = await fixture({ 'scripts/check': '#!/bin/sh\nexit 0\n' });
    await chmod(path.join(f.root, 'scripts/check'), 0o755); commit(f.root);
    expect(await inspect(f, './scripts/check')).toContainEqual(expect.objectContaining({ paths: ['scripts/check'] }));
  });

  it('checks only the selected package script and its execution-relevant manifest fields', async () => {
    const f = await fixture({ 'package.json': pkg('node --version') });
    await put(f.root, 'package.json', pkg('node --help')); commit(f.root);
    expect(await inspect(f, 'npm run check')).toContainEqual(expect.objectContaining({ paths: ['package.json'] }));
  });

  it('checks a package script exact node entry even when the manifest is unchanged', async () => {
    const f = await fixture({ 'package.json': pkg('node scripts/check.js'), 'scripts/check.js': 'process.exit(0);\n' });
    await put(f.root, 'scripts/check.js', 'process.exit(1);\n'); commit(f.root);
    expect(await inspect(f, 'npm run check')).toContainEqual(expect.objectContaining({ paths: ['scripts/check.js'] }));
  });

  it('resolves monorepo package scripts from their configured runner root', async () => {
    const f = await fixture({ 'package.json': pkg('node --version'), 'packages/ui/package.json': pkg('node --version') });
    await put(f.root, 'packages/ui/package.json', pkg('node --help')); commit(f.root);
    expect(await inspect(f, 'npm run check', { commandRoot: 'packages/ui' })).toContainEqual(expect.objectContaining({ paths: ['packages/ui/package.json'] }));
  });

  it('rejects a feature-only runner working directory without treating changed child files as directory drift', async () => {
    const f = await fixture({ 'packages/existing/README.md': 'base\n' });
    await put(f.root, 'packages/new/README.md', 'feature\n');
    await put(f.root, 'packages/existing/README.md', 'feature\n'); commit(f.root);
    expect(await inspect(f, 'node --version', { commandRoot: 'packages/new' })).toContainEqual(expect.objectContaining({ paths: ['packages/new'] }));
    expect(await inspect(f, 'node --version', { commandRoot: 'packages/existing' })).toEqual([]);
  });

  it('allows differing HEAD and base when exact prerequisites are unchanged', async () => {
    const f = await fixture({ 'package.json': pkg('node scripts/check.js'), 'scripts/check.js': 'process.exit(0);\n' });
    await put(f.root, 'README.md', 'feature\n');
    await put(f.root, 'package.json', pkg('node scripts/check.js', { description: 'metadata only', scripts: { check: 'node scripts/check.js', unrelated: 'node --help' } }));
    commit(f.root);
    expect(await inspect(f, 'npm run check')).toEqual([]);
    expect(await inspect(f, 'node scripts/check.js')).toEqual([]);
  });

  it('allows an admitted feature checkout with unchanged prerequisites to start from the base', async () => {
    const f = await fixture({ 'scripts/check.js': 'process.exit(0);\n' });
    await put(f.root, 'README.md', 'feature\n'); commit(f.root);
    await put(f.root, '.ape/runtime/config.json', JSON.stringify({ test_commands: { full: 'node scripts/check.js' } }));
    const input = {
      objective: 'Clarify the synthetic readme', mode: 'phase', lane: 'mechanical', host: 'claude',
      behavioral: false, claimed_paths: ['README.md'], test_paths: [], hooks_trusted: true,
      subagents_available: true, explicit_invocation: true, admission_contract_version: 1,
    };
    const preview = await previewRun(f.root, input);
    expect(preview.admission.ready).toBe(true);
    const started = await startRun(f.root, { ...input, expected_admission_digest: preview.admission_digest });
    expect(started.ok).toBe(true);
    expect(git(f.root, 'rev-parse', 'HEAD')).toBe(f.base);
    expect(started.run.tickets.length).toBe(1);
  });

  it('bounds tracked manifest reads without exposing their content', async () => {
    const f = await fixture({ 'package.json': pkg('node --version', { private_marker: 'synthetic-private-marker'.repeat(15_000) }) });
    await put(f.root, 'README.md', 'feature\n'); commit(f.root);
    const result = await inspect(f, 'npm run check');
    expect(result).toContainEqual(expect.objectContaining({ code: 'baseline-prerequisites-unavailable' }));
    expect(JSON.stringify(result)).not.toContain('synthetic-private-marker');
  });

  it('does not follow a tracked manifest symlink outside the repository', async () => {
    const f = await fixture();
    await symlink('/synthetic/outside/package.json', path.join(f.root, 'package.json')); commit(f.root);
    const result = await inspect(f, 'npm run check');
    expect(result).toContainEqual(expect.objectContaining({ code: 'baseline-command-prerequisite-drift' }));
    expect(JSON.stringify(result)).not.toContain('/synthetic/outside');
  });

  it('does not invent missing planned test paths as baseline command dependencies', async () => {
    const f = await fixture(); await put(f.root, 'README.md', 'feature\n'); commit(f.root);
    expect(await inspect(f, 'node --test {paths}')).toEqual([]);
    expect(await inspect(f, 'node --test tests/not-authored-yet.test.js')).toEqual([]);
  });

  it('does not compare land or unborn runs against a checkout they will not use', async () => {
    const f = await fixture(); await put(f.root, 'scripts/check.js', 'process.exit(0);\n'); commit(f.root);
    expect(await inspect(f, 'node scripts/check.js', { mode: 'land' })).toEqual([]);
    expect(await inspectAdmissionBaseline(f.root, { mode: 'phase' }, { unborn: true }, [], [])).toEqual([]);
  });
});
