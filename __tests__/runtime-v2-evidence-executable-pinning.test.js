import { execFileSync, spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  resolveEvidenceExecutable,
  snapshotEvidenceExecutables,
  verifyEvidenceExecutableSnapshot,
} from '../lib/runtime/hooks.js';
import { currentTreeSha } from '../lib/runtime/git.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { atomicWriteJson } from '../lib/runtime/storage.js';
import { projectRunState } from '../lib/runtime/projection.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const hookBinary = path.join(root, 'bin', 'ape-hook.mjs');
const cleanups = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function temporaryDirectory(prefix) {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  cleanups.push(dir);
  return dir;
}

async function executable(directory, name) {
  const file = path.join(directory, name);
  await writeFile(file, '#!/bin/sh\nexit 0\n');
  await chmod(file, 0o755);
  return file;
}

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function invokeHook(input, cwd, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hookBinary], {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(stderr));
      else resolve(JSON.parse(stdout));
    });
    child.stdin.end(`${JSON.stringify(input)}\n`);
  });
}

describe('trusted-start evidence executable resolution', () => {
  it('denies a newly earlier PATH shadow at the real bound-Bash hook seam', async () => {
    const project = await temporaryDirectory('ape-evidence-pin-project-');
    await mkdir(path.join(project, 'src'));
    await writeFile(path.join(project, 'src', 'value.js'), 'export const value = 1;\n');
    git(project, 'init', '-q');
    git(project, 'config', 'user.email', 'ape@example.test');
    git(project, 'config', 'user.name', 'APE Test');
    git(project, 'add', '.');
    git(project, 'commit', '-qm', 'test: baseline');

    const trusted = await temporaryDirectory('ape-evidence-pin-trusted-');
    const shadow = await temporaryDirectory('ape-evidence-pin-shadow-');
    await executable(trusted, 'npm');
    await executable(shadow, 'npm');
    const snapshot = snapshotEvidenceExecutables({
      cwd: project,
      env: { PATH: trusted },
      platform: process.platform,
    });
    const paths = runtimePaths(project);
    await atomicWriteJson(paths.active, {
      run_id: 'run-evidence-pin',
      status: 'running',
      host: 'codex',
      policy: { evidence_executables: snapshot },
      tree_sha: await currentTreeSha(project),
      tickets: [{
        ticket_id: 'ticket-evidence-pin',
        role: 'test_writer',
        writable: false,
        claimed_paths: ['src/value.js'],
        test_paths: [],
      }],
      receipts: [],
    });
    const input = {
      hook_event_name: 'PreToolUse',
      project_dir: project,
      cwd: project,
      is_subagent: true,
      ticket_id: 'ticket-evidence-pin',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
    };
    const baseEnv = { ...process.env, CODEX_CWD: project };
    delete baseEnv.CLAUDECODE;
    delete baseEnv.CLAUDE_CODE;
    delete baseEnv.CLAUDE_PROJECT_DIR;

    await expect(invokeHook(input, project, { ...baseEnv, PATH: trusted })).resolves.toEqual({});
    const denied = await invokeHook(input, project, {
      ...baseEnv,
      PATH: `${shadow}${path.delimiter}${trusted}`,
    });
    expect(denied.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(denied.hookSpecificOutput.permissionDecisionReason).toContain(
      'resolves to a different realpath than at the trusted run start',
    );
  });

  it('pins a missing executable too, so a later appearance is not trusted', async () => {
    const empty = await temporaryDirectory('ape-evidence-pin-empty-');
    const snapshot = snapshotEvidenceExecutables({
      cwd: empty,
      env: { PATH: empty },
      platform: process.platform,
    });
    expect(snapshot.heads.npm).toEqual({ kind: 'missing' });
    expect(verifyEvidenceExecutableSnapshot(snapshot, 'npm', {
      cwd: empty,
      env: { PATH: empty },
      platform: process.platform,
    }).safe).toBe(true);

    await executable(empty, 'npm');
    const verification = verifyEvidenceExecutableSnapshot(snapshot, 'npm', {
      cwd: empty,
      env: { PATH: empty },
      platform: process.platform,
    });
    expect(verification.safe).toBe(false);
    expect(verification.reason).toContain('appeared on PATH after the trusted run start');
  });

  it('denies an in-place replacement even when the executable realpath is unchanged', async () => {
    const directory = await temporaryDirectory('ape-evidence-pin-replaced-');
    const npm = await executable(directory, 'npm');
    const snapshot = snapshotEvidenceExecutables({
      cwd: directory,
      env: { PATH: directory },
      platform: process.platform,
    });
    expect(snapshot.heads.npm).toMatchObject({
      kind: 'executable',
      fingerprint: { strategy: 'sha256-v1' },
    });
    expect(verifyEvidenceExecutableSnapshot(snapshot, 'npm', {
      cwd: directory,
      env: { PATH: directory },
      platform: process.platform,
    }).safe).toBe(true);

    await writeFile(npm, '#!/bin/sh\necho replaced\n');
    await chmod(npm, 0o755);
    const changed = verifyEvidenceExecutableSnapshot(snapshot, 'npm', {
      cwd: directory,
      env: { PATH: directory },
      platform: process.platform,
    });
    expect(changed.safe).toBe(false);
    expect(changed.reason).toContain('changed content or file identity');
  });

  it('treats only the explicit Bash builtin set as PATH-independent', async () => {
    const directory = await temporaryDirectory('ape-evidence-pin-builtins-');
    await Promise.all(['echo', 'pwd', 'true'].map((name) => executable(directory, name)));
    const snapshot = snapshotEvidenceExecutables({
      cwd: directory,
      env: { PATH: directory },
      platform: process.platform,
    });
    for (const head of ['echo', 'pwd', 'true']) {
      expect(snapshot.heads[head]).toEqual({ kind: 'shell-builtin' });
      expect(verifyEvidenceExecutableSnapshot(snapshot, head, {
        cwd: directory,
        env: { PATH: '' },
        platform: process.platform,
      }).safe).toBe(true);
    }
    expect(snapshot.heads.which.kind).not.toBe('shell-builtin');
    expect(snapshot.heads.env.kind).not.toBe('shell-builtin');
  });

  it('honors Windows PATHEXT order and case-insensitive executable identity', async () => {
    const trusted = await temporaryDirectory('ape-evidence-pin-win-trusted-');
    const shadow = await temporaryDirectory('ape-evidence-pin-win-shadow-');
    await writeFile(path.join(trusted, 'NPM.CmD'), '@exit /b 0\r\n');
    await writeFile(path.join(shadow, 'npm.EXE'), 'shadow\r\n');
    const snapshot = snapshotEvidenceExecutables({
      cwd: trusted,
      env: { Path: trusted, PATHEXT: '.EXE;.CMD' },
      platform: 'win32',
    });
    expect(snapshot.heads.npm.kind).toBe('executable');
    expect(snapshot.heads.npm.realpath).toMatch(/NPM\.CmD$/);

    expect(verifyEvidenceExecutableSnapshot(snapshot, 'npm', {
      cwd: trusted,
      env: { PATH: trusted, pathext: '.exe;.cmd' },
      platform: 'win32',
    }).safe).toBe(true);

    const changed = verifyEvidenceExecutableSnapshot(snapshot, 'npm', {
      cwd: trusted,
      env: { Path: `${shadow};${trusted}`, PATHEXT: '.EXE;.CMD' },
      platform: 'win32',
    });
    expect(changed.safe).toBe(false);
    expect(changed.reason).toContain('different realpath');
  });

  it('uses directory enumeration only when Windows lookup is simulated on a case-sensitive host', async () => {
    const trusted = await temporaryDirectory('ape-evidence-pin-win-native-');
    const options = {
      cwd: trusted,
      env: { Path: trusted, PATHEXT: '.EXE' },
      platform: 'win32',
    };

    let nativeDirectoryScans = 0;
    expect(resolveEvidenceExecutable('npm', {
      ...options,
      nativePlatform: 'win32',
      readDirectoryEntries: () => {
        nativeDirectoryScans += 1;
        return [];
      },
    })).toBeNull();
    expect(nativeDirectoryScans).toBe(0);

    let simulatedDirectoryScans = 0;
    expect(resolveEvidenceExecutable('npm', {
      ...options,
      nativePlatform: 'linux',
      readDirectoryEntries: () => {
        simulatedDirectoryScans += 1;
        return [];
      },
    })).toBeNull();
    expect(simulatedDirectoryScans).toBeGreaterThan(0);
  });

  it('inventories each PATH directory once for the complete trusted-start snapshot', async () => {
    const trusted = await temporaryDirectory('ape-evidence-pin-win-batch-');
    await writeFile(path.join(trusted, 'NPM.CmD'), '@exit /b 0\r\n');
    let directoryScans = 0;
    const snapshot = snapshotEvidenceExecutables({
      cwd: trusted,
      env: { Path: trusted, PATHEXT: '.EXE;.CMD' },
      platform: 'win32',
      nativePlatform: 'linux',
      readDirectoryEntries: (directory) => {
        directoryScans += 1;
        return readdirSync(directory);
      },
    });

    expect(snapshot.heads.npm.kind).toBe('executable');
    expect(directoryScans).toBe(1);
  });

  it('keeps the enforcement snapshot persisted but out of MCP wire projections', () => {
    const snapshot = {
      version: 'realpath-v1',
      platform: process.platform,
      heads: { npm: { kind: 'missing' } },
    };
    const stored = {
      run_id: 'run-projection',
      policy: { high_risk_security_review: true, evidence_executables: snapshot },
      tickets: [],
      receipts: [],
    };
    expect(stored.policy.evidence_executables).toBe(snapshot);
    expect(projectRunState(stored).policy).toEqual({ high_risk_security_review: true });
  });
});
