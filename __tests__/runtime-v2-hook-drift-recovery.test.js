import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { runtimePaths } from '../lib/runtime/paths.js';
import { currentTreeSha } from '../lib/runtime/git.js';
import { atomicWriteJson } from '../lib/runtime/storage.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const hookBinary = path.join(root, 'bin', 'ape-hook.mjs');
const cleanups = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function project(status = 'running') {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-drift-recovery-'));
  cleanups.push(dir);
  await mkdir(path.join(dir, 'src'), { recursive: true });
  await writeFile(path.join(dir, 'src', 'value.js'), 'export const value = 1;\n');
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'ape@example.test');
  git(dir, 'config', 'user.name', 'APE Test');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'test: baseline');
  const baseline = await currentTreeSha(dir);
  await atomicWriteJson(runtimePaths(dir).active, {
    run_id: 'run-drift-recovery',
    status,
    tree_sha: baseline,
    tickets: [
      {
        ticket_id: 'run-drift-recovery:build:b',
        stage_id: 'build',
        role: 'implementer',
        writable: true,
        claimed_paths: ['src'],
        test_paths: ['__tests__'],
        base_tree_sha: baseline,
      },
    ],
    receipts: [],
  });
  return dir;
}

// An unattributed drift: a change outside every ticket claim, with no receipt.
async function drift(dir) {
  await writeFile(path.join(dir, 'unclaimed.txt'), 'unattributed change\n');
}

// Environment for the spawned binary: pick the host explicitly and strip any
// host-provided project hints so only the payload (or the child cwd) decides.
function hostEnv(host) {
  const env = { ...process.env };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE;
  delete env.CLAUDE_PROJECT_DIR;
  delete env.CODEX_CWD;
  if (host === 'claude') env.CLAUDECODE = '1';
  return env;
}

function invokeHook(input, cwd, host = 'claude') {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hookBinary], {
      cwd,
      env: hostEnv(host),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('hook did not finish within 10 seconds'));
    }, 10_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (code !== 0) reject(new Error(stderr));
      else resolve(JSON.parse(stdout));
    });
    child.stdin.end(typeof input === 'string' ? input : `${JSON.stringify(input)}\n`);
  });
}

function preToolUse(dir, toolName, toolInput = {}) {
  return {
    hook_event_name: 'PreToolUse',
    project_dir: dir,
    session_id: 's1',
    tool_name: toolName,
    tool_input: toolInput,
  };
}

// Regression guards for friction #28: while an unattributed tree change is
// latched, the lockdown used to deny every tool — including the read-only
// ones (Read, git status) the operator needs to diagnose and recover. The
// deny must bind only where the drift could be extended (write tools, writing
// shell) or laundered into an accepted result (SubagentStop, post events of
// Agent).
describe('APE v2 drift lockdown scope during a running run', () => {
  it('allows read-only tools during unattributed drift', async () => {
    const dir = await project();
    await drift(dir);

    const read = await invokeHook(
      preToolUse(dir, 'Read', { file_path: path.join(dir, 'src', 'value.js') }),
      dir,
    );
    expect(read.hookSpecificOutput.permissionDecision).toBe('allow');

    const status = await invokeHook(
      preToolUse(dir, 'Bash', { command: 'git status' }),
      dir,
    );
    expect(status.hookSpecificOutput.permissionDecision).toBe('allow');
  });

  it('still denies write tools during unattributed drift', async () => {
    const dir = await project();
    await drift(dir);

    for (const tool of ['Edit', 'Write']) {
      const response = await invokeHook(
        preToolUse(dir, tool, {
          file_path: path.join(dir, 'src', 'value.js'),
          content: 'export const value = 2;\n',
        }),
        dir,
      );
      expect(response.hookSpecificOutput.permissionDecision, tool).toBe('deny');
      expect(response.hookSpecificOutput.permissionDecisionReason, tool)
        .toMatch(/no exact active ticket attribution/);
    }
  });

  it('still denies a writing shell command during unattributed drift', async () => {
    const dir = await project();
    await drift(dir);

    const response = await invokeHook(
      preToolUse(dir, 'Bash', { command: 'echo x > out.txt' }),
      dir,
    );
    expect(response.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(response.hookSpecificOutput.permissionDecisionReason)
      .toMatch(/no exact active ticket attribution/);
  });

  it('still denies the result-bearing boundaries during unattributed drift', async () => {
    const dir = await project();
    await drift(dir);

    const agentResult = await invokeHook({
      hook_event_name: 'PostToolUse',
      project_dir: dir,
      session_id: 's1',
      tool_name: 'Agent',
      tool_input: {},
    }, dir);
    expect(agentResult).toEqual({
      decision: 'block',
      reason: expect.stringMatching(/no exact active ticket attribution/),
    });

    const stop = await invokeHook({
      hook_event_name: 'SubagentStop',
      project_dir: dir,
      session_id: 's1',
    }, dir);
    expect(stop).toEqual({
      decision: 'block',
      reason: expect.stringMatching(/no exact active ticket attribution/),
    });
  });

  it('leaves a non-write PostToolUse ungoverned by the drift guard', async () => {
    const dir = await project();
    await drift(dir);

    const response = await invokeHook({
      hook_event_name: 'PostToolUse',
      project_dir: dir,
      session_id: 's1',
      tool_name: 'Read',
      tool_input: { file_path: path.join(dir, 'src', 'value.js') },
    }, dir);
    expect(response).toEqual({});
  });
});

// Regression guards for friction #31a: an aborted run left in active.json used
// to keep the lockdown armed forever — every receiptless writable ticket of
// the dead run stayed a "candidate" and post-abort edits re-latched the deny.
// The reconciliation guard must engage only while status === 'running'.
describe('APE v2 drift lockdown disengages on a terminal run', () => {
  it('no longer denies read-only tools after an abort left drift behind', async () => {
    const dir = await project('aborted');
    await drift(dir);

    const read = await invokeHook(
      preToolUse(dir, 'Read', { file_path: path.join(dir, 'src', 'value.js') }),
      dir,
    );
    expect(read.hookSpecificOutput.permissionDecision).toBe('allow');

    const status = await invokeHook(
      preToolUse(dir, 'Bash', { command: 'git status' }),
      dir,
    );
    expect(status.hookSpecificOutput.permissionDecision).toBe('allow');
  });

  it('no longer blocks the result boundaries either', async () => {
    const dir = await project('aborted');
    await drift(dir);

    const stop = await invokeHook({
      hook_event_name: 'SubagentStop',
      project_dir: dir,
      session_id: 's1',
    }, dir);
    expect(stop).toEqual({});

    const agentResult = await invokeHook({
      hook_event_name: 'PostToolUse',
      project_dir: dir,
      session_id: 's1',
      tool_name: 'Agent',
      tool_input: {},
    }, dir);
    expect(agentResult).toEqual({});
  });

  it('allows a post-abort write as sealed-terminal, not drift attribution', async () => {
    const dir = await project('aborted');
    await drift(dir);

    // An aborted run is sealed history: the guard stands aside entirely
    // (host behavior unchanged), which proves the drift lockdown disengaged
    // even more strongly than an ordinary-policy deny would.
    const response = await invokeHook(
      preToolUse(dir, 'Edit', {
        file_path: path.join(dir, 'src', 'value.js'),
        new_string: 'export const value = 2;\n',
      }),
      dir,
    );
    expect(response.hookSpecificOutput.permissionDecision).toBe('allow');
    expect(response.hookSpecificOutput.permissionDecisionReason)
      .toMatch(/sealed aborted/);
  });
});

// Regression guards for friction #7 + #31b: the input cap used to trip before
// any state was read, and the catch denied unconditionally — so a repo that
// merely has the plugin installed refused large edits with no run at all. The
// failure paths must consult the active run and govern only a running one.
describe('APE v2 hook failure paths consult the active run', () => {
  const oversized = () => `${JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: 'Edit',
    tool_input: { file_path: 'package-lock.json', new_string: 'x'.repeat(9 * 1024 * 1024) },
  })}\n`;

  it('allows oversized input when no run exists', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ape-drift-norun-'));
    cleanups.push(dir);

    const response = await invokeHook(oversized(), dir);
    expect(response).toEqual({});
  });

  it('allows oversized input when the only run is finished', async () => {
    for (const status of ['aborted', 'completed']) {
      const dir = await project(status);

      const response = await invokeHook(oversized(), dir);
      expect(response, status).toEqual({});
    }
  });

  it('still fails closed on oversized input while a run is running', async () => {
    const dir = await project();

    const response = await invokeHook(oversized(), dir);
    expect(response).toEqual({
      decision: 'block',
      reason: expect.stringMatching(/failed closed.*exceeds/),
    });
  });

  it.each([
    ['projectDir', (dir) => ({ projectDir: dir })],
    ['cwd', (dir) => ({ cwd: dir })],
    ['workspacePaths', (dir) => ({ workspacePaths: [dir] })],
  ])('consults the streamed top-level %s root for oversized Codex input', async (_label, rootField) => {
    const dir = await project();
    const unrelated = await mkdtemp(path.join(tmpdir(), 'ape-drift-unrelated-cwd-'));
    cleanups.push(unrelated);
    const payload = `${JSON.stringify({
      hook_event_name: 'PreToolUse',
      ...rootField(dir),
      tool_name: 'Edit',
      tool_input: {
        file_path: 'package-lock.json',
        new_string: 'x'.repeat(9 * 1024 * 1024),
      },
    })}\n`;

    const response = await invokeHook(payload, unrelated, 'codex');
    expect(response.hookSpecificOutput?.permissionDecision ?? response.decision).toBe('block');
    expect(response.hookSpecificOutput?.permissionDecisionReason ?? response.reason)
      .toMatch(/failed closed.*exceeds/i);
  });

  it('does not trust nested root lookalikes in an oversized Codex tool payload', async () => {
    const dir = await project();
    const unrelated = await mkdtemp(path.join(tmpdir(), 'ape-drift-unrelated-nested-'));
    cleanups.push(unrelated);
    const payload = `${JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'mcp__future_provider__mutate',
      tool_input: {
        projectDir: dir,
        workspacePaths: [dir],
        content: 'x'.repeat(9 * 1024 * 1024),
      },
    })}\n`;

    expect(await invokeHook(payload, unrelated, 'codex')).toEqual({});
  });

  // `blocked` is resumable (re-gate/reset) and `shipping` is mid-merge: for
  // both, the parseable path denies a write, so the unparseable path must not
  // quietly allow one.
  it('still fails closed on oversized input while a run is blocked or shipping', async () => {
    for (const status of ['blocked', 'shipping']) {
      const dir = await project(status);

      const response = await invokeHook(oversized(), dir);
      expect(response, status).toEqual({
        decision: 'block',
        reason: expect.stringMatching(/failed closed.*exceeds/),
      });
    }
  });

  it('allows an unparseable body when no run exists, and fails closed while running', async () => {
    const bare = await mkdtemp(path.join(tmpdir(), 'ape-drift-junk-'));
    cleanups.push(bare);
    expect(await invokeHook('not json\n', bare)).toEqual({});

    const dir = await project();
    expect(await invokeHook('not json\n', dir)).toEqual({
      decision: 'block',
      reason: expect.stringMatching(/failed closed/),
    });
  });

  it.skipIf(process.platform === 'win32')('fails closed promptly when corrupt input recovery encounters an active-state FIFO', async () => {
    const dir = await project();
    await rm(runtimePaths(dir).active);
    execFileSync('mkfifo', [runtimePaths(dir).active]);

    expect(await invokeHook('not json\n', dir)).toEqual({
      decision: 'block',
      reason: expect.stringMatching(/failed closed/),
    });
    const ordinary = await invokeHook(preToolUse(dir, 'Write', {
      file_path: 'src/value.js', content: 'export const value = 2;\n',
    }), dir);
    expect(ordinary.hookSpecificOutput?.permissionDecision ?? ordinary.decision)
      .toMatch(/deny|block/);
  });

  it('applies normal policy, not a size denial, to a large in-cap Edit', async () => {
    const dir = await project();

    // Codex-style public ticket binding: the point under test is the input
    // path, not Claude's binding handshake — a ~200 KB Edit (over the old
    // 64 KB cap, under the new one) must reach the ordinary write policy.
    const response = await invokeHook({
      hook_event_name: 'PreToolUse',
      project_dir: dir,
      tool_name: 'Edit',
      tool_input: {
        file_path: path.join(dir, 'src', 'value.js'),
        new_string: `export const value = '${'x'.repeat(200 * 1024)}';\n`,
      },
      agent_id: 'native-agent-1',
      ticket_id: 'run-drift-recovery:build:b',
    }, dir, 'codex');

    expect(response).toEqual({});
  });
});
