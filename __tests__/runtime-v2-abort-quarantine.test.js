import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  bindClaudeSubagent,
  launchClaudeIntent,
  validateClaudeReceiptBinding,
} from '../lib/runtime/claude-dispatch.js';
import { evaluateLifecyclePolicy } from '../lib/runtime/hooks.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { abortRun, overrideRun, startRun } from '../lib/runtime/service.js';
import { atomicWriteJson, readJson } from '../lib/runtime/storage.js';

// Abort quarantine: sealing a run must disarm its in-flight subagents. The
// abort writers void every outstanding dispatch intent (launch nonce and
// receipt capability fail closed), and the hook's sealed-state branch denies
// write-capable tool calls from a subagent still bound to the sealed run —
// while genuinely unbound host activity after a run stays unchanged.

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const hookBinary = path.join(root, 'bin', 'ape-hook.mjs');
const cleanups = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function project() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-abort-quarantine-'));
  cleanups.push(dir);
  await mkdir(path.join(dir, 'src'));
  await mkdir(path.join(dir, 'tests'));
  await writeFile(path.join(dir, 'src', 'value.js'), 'export const value = 1;\n');
  await writeFile(path.join(dir, 'tests', 'value.test.js'), 'throw new Error("red");\n');
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'ape@example.test');
  git(dir, 'config', 'user.name', 'APE Test');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'test: baseline');
  await atomicWriteJson(runtimePaths(dir).config, {
    shipping: { auto_merge: false, provider: 'github', required_remote_checks: false },
    test_commands: { full: 'node --test', targeted_template: 'node --test {paths}' },
  });
  return dir;
}

function startInput(overrides = {}) {
  return {
    objective: 'Exercise the abort quarantine',
    mode: 'phase',
    lane: 'fast',
    host: 'claude',
    claimed_paths: ['src/value.js'],
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

async function intentForTicket(dir, ticketId) {
  const paths = runtimePaths(dir);
  const names = (await readdir(paths.dispatchIntents)).filter((name) => name.endsWith('.json'));
  for (const name of names) {
    const file = path.join(paths.dispatchIntents, name);
    const record = await readJson(file, null);
    if (record?.ticket_id === ticketId) return { file, record };
  }
  return null;
}

// Wedge the run exactly like the field incidents: launch and bind the intent
// through the runtime, then never record a receipt.
async function bindWedgedFlight(dir, dispatchAction) {
  const paths = runtimePaths(dir);
  const state = await readJson(paths.active, null);
  const launch = await launchClaudeIntent(paths, state, {
    session_id: 'wedged-parent',
    tool_use_id: 'wedged-agent-call',
    tool_input: {
      subagent_type: dispatchAction.dispatch.agent_type,
      prompt: dispatchAction.dispatch.dispatch_intent.prompt,
      model: dispatchAction.dispatch.model.model,
    },
  });
  expect(launch.valid).toBe(true);
  const bound = await bindClaudeSubagent(paths, state, {
    session_id: 'wedged-parent',
    agent_id: 'wedged-agent',
    agent_type: dispatchAction.dispatch.agent_type,
  });
  expect(bound.valid).toBe(true);
  return bound.additional_context.match(/APE_RECEIPT_CAPABILITY=([A-Za-z0-9_-]+)/)[1];
}

// Environment for the spawned binary: force the Claude host and strip any
// host-provided project hints so only the payload under test decides.
function claudeEnv() {
  const env = { ...process.env, CLAUDECODE: '1' };
  delete env.CLAUDE_PROJECT_DIR;
  delete env.CODEX_CWD;
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

describe('APE v2 sealed-state fence (lifecycle policy)', () => {
  const boundTicket = {
    ticket_id: 'run-1:build:b',
    role: 'implementer',
    writable: true,
    claimed_paths: ['src'],
    test_paths: ['__tests__'],
  };
  const boundWrite = (overrides = {}) => ({
    host: 'claude',
    event: 'PreToolUse',
    tool_name: 'Write',
    is_subagent: true,
    ape_managed: true,
    file: 'src/value.js',
    target_path: '/proj/src/value.js',
    ...overrides,
  });

  it('denies a bound subagent Write after abort', () => {
    const result = evaluateLifecyclePolicy(boundWrite(), {
      state: { status: 'aborted' },
      ticket: boundTicket,
    });
    expect(result.decision).toBe('deny');
    expect(result.reason).toMatch(/sealed aborted/);
    expect(result.reason).toMatch(/binding is void/);
  });

  it('denies a bound subagent writing shell command after abort', () => {
    const result = evaluateLifecyclePolicy(
      boundWrite({ tool_name: 'Bash', command: 'rm -rf src' }),
      { state: { status: 'aborted' }, ticket: boundTicket },
    );
    expect(result.decision).toBe('deny');
  });

  it('still allows a bound subagent non-writing shell command (fence is write-only)', () => {
    const result = evaluateLifecyclePolicy(
      boundWrite({ tool_name: 'Bash', command: 'git status' }),
      { state: { status: 'aborted' }, ticket: boundTicket },
    );
    expect(result.decision).toBe('allow');
  });

  it('fences a bound subagent Write behind a completed seal too', () => {
    const result = evaluateLifecyclePolicy(boundWrite(), {
      state: { status: 'completed' },
      ticket: boundTicket,
    });
    expect(result.decision).toBe('deny');
  });

  it('allows an unbound main-session Write after abort', () => {
    const result = evaluateLifecyclePolicy(boundWrite({ is_subagent: false, ape_managed: undefined }), {
      state: { status: 'aborted' },
      ticket: null,
    });
    expect(result.decision).toBe('allow');
    expect(result.reason).toMatch(/sealed aborted; host behavior is unchanged/);
  });

  it('allows a bound orphan out-of-project Write (APE governs only project writes)', () => {
    const result = evaluateLifecyclePolicy(
      boundWrite({ file: null, target_path: '/outside/x', out_of_project: true }),
      { state: { status: 'aborted' }, ticket: boundTicket },
    );
    expect(result.decision).toBe('allow');
    expect(result.reason).toMatch(/sealed/);
  });

  it('passes a bound orphan Stop event (not a tool channel; final message survives)', () => {
    const result = evaluateLifecyclePolicy(
      boundWrite({ event: 'Stop', tool_name: '' }),
      { state: { status: 'aborted' }, ticket: boundTicket },
    );
    expect(result.decision).toBe('allow');
  });
});

describe('APE v2 abort quarantine (end to end)', () => {
  it('abort voids the bound capability', async () => {
    const dir = await project();
    const started = await startRun(dir, startInput());
    expect(started.ok).toBe(true);
    const dispatchAction = started.actions.find((action) => action.type === 'dispatch_agent');
    const ticket = dispatchAction.ticket;
    const capability = await bindWedgedFlight(dir, dispatchAction);

    const aborted = await abortRun(dir, 'operator abort with a live flight');
    expect(aborted.ok).toBe(true);

    const voided = await intentForTicket(dir, ticket.ticket_id);
    expect(voided.record.status).toBe('expired');
    expect(voided.record.expired_at).toEqual(expect.any(String));

    // A late receipt presenting the voided capability fails closed.
    const paths = runtimePaths(dir);
    const state = await readJson(paths.active, null);
    const late = await validateClaudeReceiptBinding(
      paths,
      state,
      dispatchAction.ticket,
      capability,
      'a'.repeat(64),
    );
    expect(late).toEqual({ valid: false });
  });

  it('override abort voids the capability too', async () => {
    const dir = await project();
    const started = await startRun(dir, startInput());
    const dispatchAction = started.actions.find((action) => action.type === 'dispatch_agent');
    await bindWedgedFlight(dir, dispatchAction);

    const overridden = await overrideRun(dir, 'abort', 'audited override abort');
    expect(overridden.ok).toBe(true);

    const voided = await intentForTicket(dir, dispatchAction.ticket.ticket_id);
    expect(voided.record.status).toBe('expired');
    expect(voided.record.expired_at).toEqual(expect.any(String));
  });

  it("denies an aborted run's bound orphan Write through the hook binary", async () => {
    const dir = await project();
    const started = await startRun(dir, startInput());
    const dispatchAction = started.actions.find((action) => action.type === 'dispatch_agent');
    await bindWedgedFlight(dir, dispatchAction);
    const aborted = await abortRun(dir, 'operator abort with a live flight');
    expect(aborted.ok).toBe(true);

    const orphanEvent = (toolName, toolInput) => ({
      hook_event_name: 'PreToolUse',
      project_dir: dir,
      session_id: 'wedged-parent',
      agent_id: 'wedged-agent',
      agent_type: dispatchAction.dispatch.agent_type,
      tool_name: toolName,
      tool_input: toolInput,
    });

    const write = await invokeHook(
      orphanEvent('Write', {
        file_path: path.join(dir, 'src', 'value.js'),
        content: 'sabotage',
      }),
      dir,
    );
    expect(write.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(write.hookSpecificOutput.permissionDecisionReason).toMatch(/sealed aborted/);
    expect(write.hookSpecificOutput.permissionDecisionReason).toMatch(/void/);

    // An unrelated damaged artifact cannot hide the still-readable exact
    // orphan, and damage to the exact artifact itself remains a conservative
    // sealed fence rather than falling through the hook's no-live-run allow.
    const paths = runtimePaths(dir);
    await writeFile(path.join(paths.dispatchIntents, 'unrelated-corrupt.json'), '{');
    const withUnrelatedCorruption = await invokeHook(
      orphanEvent('Write', {
        file_path: path.join(dir, 'src', 'value.js'),
        content: 'sabotage through unrelated corruption',
      }),
      dir,
    );
    expect(withUnrelatedCorruption.hookSpecificOutput.permissionDecision).toBe('deny');
    const exact = await intentForTicket(dir, dispatchAction.ticket.ticket_id);
    await writeFile(exact.file, '{');
    const withExactCorruption = await invokeHook(
      orphanEvent('Write', {
        file_path: path.join(dir, 'src', 'value.js'),
        content: 'sabotage through exact corruption',
      }),
      dir,
    );
    expect(withExactCorruption.hookSpecificOutput.permissionDecision).toBe('deny');

    // The orphan can still read: the fence covers only write-capable tools.
    const read = await invokeHook(
      orphanEvent('Read', { file_path: path.join(dir, 'src', 'value.js') }),
      dir,
    );
    expect(read.hookSpecificOutput.permissionDecision).toBe('allow');
  });

  it('allows a plain host Write with no binding after abort', async () => {
    const dir = await project();
    const started = await startRun(dir, startInput());
    const dispatchAction = started.actions.find((action) => action.type === 'dispatch_agent');
    await bindWedgedFlight(dir, dispatchAction);
    await abortRun(dir, 'operator abort with a live flight');

    const response = await invokeHook({
      hook_event_name: 'PreToolUse',
      project_dir: dir,
      session_id: 's-main',
      tool_name: 'Write',
      tool_input: { file_path: path.join(dir, 'src', 'value.js'), content: 'host edit' },
    }, dir);
    expect(response.hookSpecificOutput.permissionDecision).toBe('allow');
    expect(response.hookSpecificOutput.permissionDecisionReason)
      .toMatch(/sealed aborted; host behavior is unchanged/);
  });
});
