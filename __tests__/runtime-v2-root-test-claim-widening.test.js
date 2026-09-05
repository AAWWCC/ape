import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { widenedTestClaims } from '../lib/runtime/path-scope.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { currentTreeSha } from '../lib/runtime/git.js';
import { atomicWriteJson } from '../lib/runtime/storage.js';

// Root-level file-shaped test claims (roadmap root-test-claim-widening-fix,
// audit finding 1.4). widenedTestClaims widens a file-shaped claim to its
// directory so a not-yet-existing sibling test still resolves — but a claim
// with no '/' (a repo-root test file, test_paths: ['server.test.js']) has
// lastIndexOf('/') === -1, and slice(0, -1) yields the TRUTHY phantom
// 'server.test.j', so the || fallback never fires. The hook then resolves
// every test-writer edit/deletion against a claim that matches nothing —
// including the exact claimed file — sets path_safe false, and denies every
// write the ticket authorizes. Contract under test: a root-level file-shaped
// claim widens to ITSELF (the test writer can write exactly that file, and
// only that file, at the root), while non-root claims keep their current
// sibling-directory widening.

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const hookBinary = path.join(root, 'bin', 'ape-hook.mjs');
const cleanups = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('widenedTestClaims (public contract)', () => {
  it('widens a root-level file-shaped claim to itself, never a phantom prefix', () => {
    expect(widenedTestClaims(['server.test.js'])).toEqual(['server.test.js']);
    expect(widenedTestClaims(['app.spec.ts'])).toEqual(['app.spec.ts']);
  });

  it('keeps sibling-directory widening for non-root file-shaped claims and passes directories through', () => {
    expect(widenedTestClaims(['tests/value.test.js'])).toEqual(['tests']);
    expect(widenedTestClaims(['__tests__'])).toEqual(['__tests__']);
  });
});

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

// Temp project with a root-level production file and a nested test suite. By
// default the claimed root test file server.test.js deliberately does NOT
// exist yet: the test stage's whole job is to author it, which is exactly the
// write the phantom claim wedges. The deletion case opts into committing it as
// part of the baseline so the tree is clean when the hook evaluates.
async function project({ withRootTest = false } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-root-claim-'));
  cleanups.push(dir);
  await mkdir(path.join(dir, 'tests'), { recursive: true });
  await writeFile(path.join(dir, 'server.js'), 'export const server = 1;\n');
  await writeFile(path.join(dir, 'tests', 'value.test.js'), 'process.exit(0);\n');
  if (withRootTest) {
    await writeFile(path.join(dir, 'server.test.js'), 'process.exit(0);\n');
  }
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'ape@example.test');
  git(dir, 'config', 'user.name', 'APE Test');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'baseline');
  const baseline = await currentTreeSha(dir);
  await atomicWriteJson(runtimePaths(dir).active, {
    run_id: 'run-root',
    status: 'running',
    tree_sha: baseline,
    tickets: [
      {
        ticket_id: 'run-root:test:root',
        stage_id: 'test',
        role: 'test_writer',
        writable: true,
        claimed_paths: ['server.test.js'],
        test_paths: ['server.test.js'],
        base_tree_sha: baseline,
      },
      {
        ticket_id: 'run-root:test:nested',
        stage_id: 'test',
        role: 'test_writer',
        writable: true,
        claimed_paths: ['tests/value.test.js'],
        test_paths: ['tests/value.test.js'],
        base_tree_sha: baseline,
      },
    ],
    receipts: [],
  });
  return dir;
}

// Environment for the spawned binary: force the Claude host and strip any
// host-provided project hints so only the payload under test decides.
function claudeEnv() {
  const env = { ...process.env, CLAUDECODE: '1' };
  delete env.CLAUDE_PROJECT_DIR;
  delete env.CODEX_CWD;
  delete env.APE_TICKET_ID;
  return env;
}

function invokeHook(input, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hookBinary], {
      cwd,
      env: claudeEnv(),
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

function boundWriteCall(dir, ticketId, file) {
  return {
    hook_event_name: 'PreToolUse',
    project_dir: dir,
    session_id: 's1',
    is_subagent: true,
    ticket_id: ticketId,
    tool_name: 'Write',
    tool_input: { file_path: file },
  };
}

describe('APE v2 hook binary: root-level test claim resolution', () => {
  it('allows the bound test writer to author exactly the claimed root test file', async () => {
    // RED on the base tree: the phantom claim 'server.test.j' matches nothing,
    // path_safe is false, and the write the ticket authorizes is denied as
    // "target resolves outside the ticket claims".
    const dir = await project();
    const response = await invokeHook(
      boundWriteCall(dir, 'run-root:test:root', 'server.test.js'),
      dir,
    );
    expect(response.hookSpecificOutput.permissionDecision).toBe('allow');
    expect(response.hookSpecificOutput.permissionDecisionReason)
      .toMatch(/write authorized by run-root:test:root/);
  });

  it('still denies an unrelated root production file under the root test claim', async () => {
    const dir = await project();
    const response = await invokeHook(
      boundWriteCall(dir, 'run-root:test:root', 'server.js'),
      dir,
    );
    expect(response.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(response.hookSpecificOutput.permissionDecisionReason).toMatch(/APE write denied/);
  });

  it('still denies an unrelated root test-shaped file: widening to itself is not widening to the repo root', async () => {
    const dir = await project();
    const response = await invokeHook(
      boundWriteCall(dir, 'run-root:test:root', 'other.test.js'),
      dir,
    );
    expect(response.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(response.hookSpecificOutput.permissionDecisionReason).toMatch(/APE write denied/);
  });

  it('keeps sibling-directory widening for a non-root file-shaped claim through the hook', async () => {
    // Regression guard on the unchanged half of the contract: a nested
    // file-shaped claim still authorizes a not-yet-existing sibling in the
    // same suite directory.
    const dir = await project();
    const response = await invokeHook(
      boundWriteCall(dir, 'run-root:test:nested', 'tests/extra.test.js'),
      dir,
    );
    expect(response.hookSpecificOutput.permissionDecision).toBe('allow');
    expect(response.hookSpecificOutput.permissionDecisionReason)
      .toMatch(/write authorized by run-root:test:nested/);
  });

  it('resolves the deletion channel against the root claim itself, not the phantom prefix', async () => {
    // Same claims selection feeds the rm/git-rm channel: the exact claimed
    // root test file must be deletable by its own test writer. The file is
    // part of the committed baseline so the tree is clean at hook time.
    const dir = await project({ withRootTest: true });
    const response = await invokeHook(
      {
        hook_event_name: 'PreToolUse',
        project_dir: dir,
        session_id: 's1',
        is_subagent: true,
        ticket_id: 'run-root:test:root',
        tool_name: 'Bash',
        tool_input: { command: 'rm server.test.js' },
      },
      dir,
    );
    expect(response.hookSpecificOutput.permissionDecision).toBe('allow');
    expect(response.hookSpecificOutput.permissionDecisionReason)
      .toBe('deletion authorized by run-root:test:root');
  });
});
