import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { previewRun, startRun } from '../lib/runtime/lifecycle-service.js';
import { inspectAdmissionCommandPrerequisites, resolveAdmissionExecutable } from '../lib/runtime/admission-command-prerequisites.js';

const roots = [];
const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } }).trim();
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));
async function put(root, file, bytes) {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), bytes);
}
async function fixture(files = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'ape-current-prerequisites-'));
  roots.push(root);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Synthetic prerequisites');
  git(root, 'config', 'user.email', 'prerequisites@example.test');
  git(root, 'config', 'commit.gpgsign', 'false');
  for (const [file, content] of Object.entries({ 'README.md': 'baseline\n', ...files })) await put(root, file, content);
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'baseline');
  return root;
}
const input = { objective: 'Clarify the synthetic readme', mode: 'phase', lane: 'mechanical', host: 'claude', behavioral: false,
  claimed_paths: ['README.md'], test_paths: [], hooks_trusted: true, subagents_available: true, explicit_invocation: true, admission_contract_version: 1 };
async function configure(root, command) {
  await put(root, '.ape/runtime/config.json', JSON.stringify({ test_commands: { full: command } }));
}
async function inspect(root, command) {
  const executable = command.split(' ')[0];
  return inspectAdmissionCommandPrerequisites(root, [{ id: 'test:full', command, root: '.' }], [{ id: 'test:full', resolved: await resolveAdmissionExecutable(root, executable) }]);
}

describe('current command prerequisites before dispatch', () => {
  it.each([
    ['missing interpreter entry', 'node missing-entry.js', {}, 'entry-script-missing', 'missing-entry.js'],
    ['missing package script', 'npm run missing-script', { 'package.json': '{"scripts":{"other":"node --version"}}' }, 'package-script-missing', 'package.json'],
    ['missing package script entry', 'npm run check', { 'package.json': '{"scripts":{"check":"node missing-entry.js"}}' }, 'entry-script-missing', 'missing-entry.js'],
    ['missing shebang interpreter', './check', { check: '#!/ape-synthetic-missing-interpreter\nexit 0\n' }, 'shebang-interpreter-missing', 'check'],
    ['missing env shebang interpreter', './check', { check: '#!/usr/bin/env ape-synthetic-missing-interpreter\nexit 0\n' }, 'shebang-env-interpreter-missing', 'check'],
    ['missing env-wrapped interpreter entry', 'env NODE_ENV=test node missing-entry.js', {}, 'entry-script-missing', 'missing-entry.js'],
  ])('blocks %s on HEAD=base before creating a branch or worker', async (_label, command, files, cause, expectedPath) => {
    const root = await fixture(files);
    if (command === './check') { await chmod(path.join(root, 'check'), 0o755); git(root, 'add', 'check'); git(root, 'commit', '-qm', 'executable'); }
    await configure(root, command);
    const beforeIndex = await readFile(path.join(root, '.git/index'));
    const beforeNames = await readdir(root);
    const preview = await previewRun(root, input);
    expect(preview.admission.repository.head).toBe(preview.admission.repository.base_commit);
    expect(preview.admission.blocking).toContainEqual(expect.objectContaining({ code: 'command-prerequisite-unavailable', profile: 'test:full', cause, expected_path: expectedPath }));
    const started = await startRun(root, { ...input, expected_admission_digest: preview.admission_digest });
    expect(started).toMatchObject({ ok: false, code: 'admission-not-ready', attempts_consumed: 0 });
    expect(git(root, 'branch', '--show-current')).toBe('main');
    expect(await readFile(path.join(root, '.git/index'))).toEqual(beforeIndex);
    expect(await readdir(root)).toEqual(beforeNames);
  });

  it('admits a present script that would fail and mutate a marker, without executing it', async () => {
    const root = await fixture({ 'check.js': "require('node:fs').writeFileSync('SHOULD_NOT_EXIST', 'executed'); process.exit(1);\n" });
    await configure(root, 'node check.js');
    const before = await readFile(path.join(root, '.git/index'));
    const preview = await previewRun(root, input);
    expect(preview.admission.ready).toBe(true);
    expect(preview.admission.baseline.execution).toBe('not-run-by-read-only-preview');
    expect(await readdir(root)).not.toContain('SHOULD_NOT_EXIST');
    expect(await readFile(path.join(root, '.git/index'))).toEqual(before);
  });

  it('admits available package scripts and npm start default while inspecting no imports', async () => {
    const root = await fixture({ 'package.json': '{"scripts":{"check":"node check.js"}}', 'check.js': 'process.exit(1);\n', 'server.js': 'process.exit(1);\n' });
    expect(await inspect(root, 'npm run check')).toEqual([]);
    expect(await inspect(root, 'npm start')).toEqual([]);
  });

  it('accepts literal shell environment prefixes and failing builtins without executing them', async () => {
    const root = await fixture({ 'package.json': JSON.stringify({ scripts: {
      env: 'NODE_ENV=test node check.js', fail: 'exit 1', truth: 'false',
    } }), 'check.js': 'process.exit(1);\n' });
    for (const name of ['env', 'fail', 'truth']) expect(await inspect(root, `npm run ${name}`)).toEqual([]);
  });

  it('identifies the exact selected package script for missing executables and cycles', async () => {
    const root = await fixture({ 'package.json': JSON.stringify({ scripts: { check: 'ape-synthetic-missing-tool', cycle: 'npm run cycle' } }) });
    expect(await inspect(root, 'npm run check')).toContainEqual(expect.objectContaining({ cause: 'command-executable-missing', package_script: 'check', expected_path: 'package.json' }));
    expect(await inspect(root, 'npm run cycle')).toContainEqual(expect.objectContaining({ cause: 'package-script-cycle', package_script: 'cycle', expected_path: 'package.json' }));
  });

  it('admits a present env shebang interpreter without executing the failing script', async () => {
    const root = await fixture({ check: '#!/usr/bin/env node\nprocess.exit(1);\n' });
    await chmod(path.join(root, 'check'), 0o755);
    expect(await inspect(root, './check')).toEqual([]);
  });

  it('admits a present literal env-wrapped entry in real preview without executing it', async () => {
    const root = await fixture({ 'check.js': "require('node:fs').writeFileSync('SHOULD_NOT_EXIST', 'executed'); process.exit(1);\n" });
    await configure(root, 'env NODE_ENV=test node check.js');
    const preview = await previewRun(root, input);
    expect(preview.admission.ready).toBe(true);
    expect(await readdir(root)).not.toContain('SHOULD_NOT_EXIST');
  });

  it('honors literal env PATH and refuses ambiguous environment resets or flags', async () => {
    const root = await fixture({ 'check.js': 'process.exit(1);\n' });
    await put(root, 'tools/check', '#!/bin/sh\nexit 1\n');
    await chmod(path.join(root, 'tools/check'), 0o755);
    expect(await inspect(root, 'env PATH=./tools check')).toEqual([]);
    expect(await inspect(root, 'env PATH=/ape-synthetic-missing-path node check.js')).toContainEqual(expect.objectContaining({ cause: 'command-executable-missing' }));
    expect(await inspect(root, 'env PATH=/ape-synthetic-missing-path false')).toContainEqual(expect.objectContaining({ cause: 'command-executable-missing' }));
    for (const command of ['env -i node check.js', 'env --chdir=/ node check.js', 'env -u PATH node check.js']) {
      expect(await inspect(root, command)).toContainEqual(expect.objectContaining({ cause: expect.stringMatching(/^env-.*unrepresentable$/) }));
    }
  });

  it('keeps intentionally absent future node test paths separate from explicit preloads', async () => {
    const root = await fixture();
    expect(await inspect(root, 'node --test {paths}')).toEqual([]);
    expect(await inspect(root, 'node --test future-authored.test.js')).toEqual([]);
    expect(await inspect(root, 'node --require=./missing-setup.js --test {paths}')).toContainEqual(expect.objectContaining({ code: 'command-prerequisite-unavailable' }));
  });

  it('allows an internal script symlink but rejects an escaping script link', async () => {
    const root = await fixture({ 'check.js': 'process.exit(1);\n' });
    const outside = await fixture({ 'external.js': 'process.exit(1);\n' });
    await symlink('check.js', path.join(root, 'inside.js'));
    await symlink(path.join(outside, 'external.js'), path.join(root, 'outside.js'));
    expect(await inspect(root, 'node inside.js')).toEqual([]);
    expect(await inspect(root, 'node outside.js')).toContainEqual(expect.objectContaining({ code: 'command-prerequisite-unavailable' }));
  });

  it('bounds malformed, special, and oversized package manifests without leaking their bytes', async () => {
    for (const kind of ['malformed', 'fifo', 'oversized']) {
      const root = await fixture();
      if (kind === 'fifo') execFileSync('mkfifo', [path.join(root, 'package.json')]);
      else await put(root, 'package.json', kind === 'malformed' ? 'synthetic-private-marker {' : JSON.stringify({ private_marker: 'synthetic-private-marker'.repeat(20_000) }));
      const result = await inspect(root, 'npm run check');
      expect(result).toContainEqual(expect.objectContaining({ code: 'command-prerequisite-unavailable' }));
      expect(JSON.stringify(result)).not.toContain('synthetic-private-marker');
    }
  });
});
