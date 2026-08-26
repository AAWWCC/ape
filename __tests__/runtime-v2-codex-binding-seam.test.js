import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { evaluateLifecyclePolicy } from '../lib/runtime/hooks.js';
import { recordReceipt, startRun, statusRun } from '../lib/runtime/service.js';

// Codex binding compatibility covers the visible task-name handshake and the older
// explicit lifecycle-ticket seam. Two observable contracts:
//
//  (1) Host-neutral one-owner control plane: a bound-or-identifiable subagent
//      of EITHER host is denied ape_run/ape_config/ape_history. The Codex arm
//      engages as soon as a host-delivered binding exists (an event ticket_id
//      or an APE_TICKET_ID-equivalent value), while the Claude behavior is
//      preserved byte-for-byte (pinned by runtime-v2-control-plane-ownership).
//
//  (2) SubagentStart handshake seam: a Codex SubagentStart carrying a binding
//      payload (explicit ticket_id field or APE_TICKET_ID-equivalent delivered
//      by the host event) is validated exactly as the Claude start handshake
//      is — bounded native identity, a running run, and a pending (unexpired,
//      unreceipted) ticket — and denied otherwise.
//
// Preserved postures asserted alongside: an unbound codex subagent write still
// fails closed, a codex SubagentStart with no binding payload at all stays
// allowed, public-ticket write binding to claimed paths is retained, and the
// main-session control-plane exemption survives. Codex hook responses are the
// top-level `{decision, reason}` shape.

const CONTROL_TOOLS = [
  'ape_run',
  'ape_config',
  'ape_history',
  'mcp__plugin_ape_ape__ape_run',
  'mcp__plugin_ape_ape__ape_config',
  'mcp__plugin_ape_ape__ape_history',
];

describe('APE v2 codex one-owner control plane (unit)', () => {
  const implementerTicket = {
    ticket_id: 'run-1:build:b',
    role: 'implementer',
    writable: true,
    test_paths: ['__tests__'],
    claimed_paths: ['src'],
  };
  // The realistic normalized codex shape: ape_managed is undefined (never set
  // on the codex path), and the binding is the host-delivered event ticket_id.
  const boundCodexCall = (toolName, overrides = {}) => ({
    host: 'codex',
    event: 'PreToolUse',
    is_subagent: true,
    tool_name: toolName,
    ticket_id: 'run-1:build:b',
    ...overrides,
  });

  // RED anchor R1: today the one-owner deny is Claude-only, so every one of
  // these falls through to the safe-non-writing-tool allow.
  it('denies every control-plane tool, bare and namespaced, from a bound codex subagent in running state (R1)', () => {
    for (const tool of CONTROL_TOOLS) {
      const result = evaluateLifecyclePolicy(boundCodexCall(tool), {
        state: { status: 'running' },
        ticket: implementerTicket,
      });
      expect(result.decision, tool).toBe('deny');
      expect(result.reason, tool).toMatch(/orchestrator owns/);
    }
    // ape_managed: true is still "not false" — equally denied.
    const managed = evaluateLifecyclePolicy(
      boundCodexCall('mcp__plugin_ape_ape__ape_run', { ape_managed: true }),
      { state: { status: 'running' }, ticket: implementerTicket },
    );
    expect(managed.decision).toBe('deny');
    expect(managed.reason).toMatch(/orchestrator owns/);
  });

  it('denies while the run is blocked and the context ticket is unresolvable (R1)', () => {
    const result = evaluateLifecyclePolicy(boundCodexCall('mcp__plugin_ape_ape__ape_run'), {
      state: { status: 'blocked' },
      ticket: null,
    });
    expect(result.decision).toBe('deny');
    expect(result.reason).toMatch(/orchestrator owns/);
  });

  it('denies in a sealed completed state so an orphan cannot start or advance a new run (R1)', () => {
    const result = evaluateLifecyclePolicy(boundCodexCall('mcp__plugin_ape_ape__ape_run'), {
      state: { status: 'completed' },
      ticket: { ...implementerTicket },
    });
    expect(result.decision).toBe('deny');
    expect(result.reason).toMatch(/orchestrator owns/);
  });

  // Host parity: a Codex identity is enough to establish that this is not the
  // orchestrator, even when the event carries no ticket binding.
  it('denies a codex subagent with no host-delivered event binding (G1)', () => {
    const result = evaluateLifecyclePolicy(
      {
        host: 'codex',
        event: 'PreToolUse',
        is_subagent: true,
        ape_managed: true,
        tool_name: 'mcp__plugin_ape_ape__ape_run',
      },
      { state: { status: 'running' }, ticket: implementerTicket },
    );
    expect(result.decision).toBe('deny');
    expect(result.reason).toMatch(/orchestrator owns/);
  });

  // GREEN guardrail G2: the main session owns the control plane on both hosts.
  it('allows the codex main-session control-plane call (G2)', () => {
    const result = evaluateLifecyclePolicy(
      {
        host: 'codex',
        event: 'PreToolUse',
        is_subagent: false,
        tool_name: 'mcp__plugin_ape_ape__ape_run',
      },
      { state: { status: 'running' }, ticket: null },
    );
    expect(result.decision).toBe('allow');
  });

  // GREEN guardrail G6: boundary events (empty tool_name Stop/SubagentStop)
  // carry the receipt-bearing final message and are never tool calls, even
  // when the event carries a ticket_id binding.
  it('never treats a boundary event carrying a ticket_id as a control-plane call (G6)', () => {
    for (const boundary of ['Stop', 'SubagentStop']) {
      const result = evaluateLifecyclePolicy(
        boundCodexCall('', { event: boundary }),
        { state: { status: 'running' }, ticket: implementerTicket },
      );
      expect(result.decision, boundary).toBe('allow');
    }
  });
});

// End-to-end against the SOURCE hook binary (bin/ape-hook.mjs), matching the
// other hook e2e suites: a targeted run after a lib/runtime edit must exercise
// the edited code, not a stale dist bundle.
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const hookBinary = path.join(root, 'bin', 'ape-hook.mjs');
const cleanups = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function codexProject(status = 'running') {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-codex-binding-seam-'));
  cleanups.push(dir);
  await mkdir(path.join(dir, 'src'), { recursive: true });
  await writeFile(path.join(dir, 'src', 'value.js'), 'export const value = 1;\n');
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'ape@example.test'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'APE Test'], { cwd: dir });
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'baseline'], { cwd: dir });
  const baseTree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], {
    cwd: dir,
    encoding: 'utf8',
  }).trim();
  const ticket = (ticketId) => ({
    ticket_id: ticketId,
    role: 'implementer',
    writable: true,
    claimed_paths: ['src'],
    test_paths: ['tests'],
    base_tree_sha: baseTree,
  });
  await mkdir(path.join(dir, '.ape', 'runtime'), { recursive: true });
  await writeFile(path.join(dir, '.ape', 'runtime', 'active.json'), JSON.stringify({
    run_id: 'run-1',
    status,
    tree_sha: baseTree,
    tickets: [
      ticket('run-1:build:ticket-1'),
      ticket('run-1:build:ticket-expired'),
      ticket('run-1:build:ticket-receipted'),
    ],
    expired_tickets: ['run-1:build:ticket-expired'],
    receipts: [{ ticket_id: 'run-1:build:ticket-receipted', status: 'passed' }],
  }));
  return dir;
}

// Codex host environment. APE_TICKET_ID is stripped alongside the host
// markers: an ambient export from whoever runs the suite would otherwise
// smuggle a binding into the unbound/no-payload cases and misfire them. Tests
// that exercise the env-delivered binding channel opt in via overrides.
function codexEnv(overrides = {}) {
  const env = { ...process.env };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE;
  delete env.CLAUDE_PROJECT_DIR;
  delete env.CODEX_CWD;
  delete env.APE_TICKET_ID;
  return { ...env, ...overrides };
}

function invokeHook(input, env = codexEnv()) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hookBinary], {
      cwd: root,
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
      else {
        const parsed = JSON.parse(stdout);
        const semanticDecision =
          parsed.hookSpecificOutput?.permissionDecision ??
          (parsed.systemMessage ? 'deny' : parsed.decision === 'block' ? 'deny' : parsed.decision ?? 'allow');
        resolve({ ...parsed, decision: semanticDecision });
      }
    });
    child.stdin.end(`${JSON.stringify(input)}\n`);
  });
}

async function startedCodexProject() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-codex-native-binding-'));
  cleanups.push(dir);
  await mkdir(path.join(dir, 'src'), { recursive: true });
  await mkdir(path.join(dir, 'tests'), { recursive: true });
  await mkdir(path.join(dir, 'docs'), { recursive: true });
  await writeFile(path.join(dir, 'src', 'value.js'), 'export const value = 1;\n');
  await writeFile(path.join(dir, 'tests', 'value.test.js'), 'throw new Error("red");\n');
  await writeFile(path.join(dir, 'docs', 'note.md'), '# Note\n');
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'ape@example.test'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'APE Test'], { cwd: dir });
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'baseline'], { cwd: dir });
  const result = await startRun(dir, {
    objective: 'Prove a native Codex writer can bind to its stage ticket',
    mode: 'phase',
    lane: 'mechanical',
    host: 'codex',
    binding_protocol: 'native-v1',
    claimed_paths: ['docs/note.md'],
    test_paths: [],
    requirements: ['R-CODEX-NATIVE-BINDING'],
    risk_triggers: [],
    behavioral: false,
    hooks_trusted: true,
    subagents_available: true,
    explicit_invocation: true,
  });
  expect(result.ok).toBe(true);
  const action = result.actions.find((entry) => entry.type === 'dispatch_agent');
  expect(action?.ticket?.writable).toBe(true);
  return { dir, action };
}

describe('APE v2 native Codex dispatch handshake', () => {
  it('rejects a forged task-name capability and keeps the dispatch prepared', async () => {
    const { dir, action } = await startedCodexProject();
    const launch = await invokeHook({
      hook_event_name: 'PreToolUse',
      project_dir: dir,
      session_id: 'codex-parent-session',
      turn_id: 'turn-1',
      tool_use_id: 'spawn-forged',
      tool_name: 'collaborationspawn_agent',
      tool_input: {
        task_name: `ape_${action.ticket.role}_00000000000000000000000000000000`,
        agent_type: action.dispatch.agent_type,
        message: 'gAAAAABencrypted-v2-message',
        model: action.dispatch.model.model,
        reasoning_effort: action.dispatch.model.reasoning_effort,
      },
    });
    expect(launch.decision).toBe('deny');
    expect((await statusRun(dir)).dispatches).toEqual([
      expect.objectContaining({
        ticket_id: action.ticket.ticket_id,
        status: 'prepared',
        launch_attempts: 0,
      }),
    ]);
  });

  it('rejects an explicit type mismatch even when the dispatch task-name capability is valid', async () => {
    const { dir, action } = await startedCodexProject();
    const launch = await invokeHook({
      hook_event_name: 'PreToolUse',
      project_dir: dir,
      session_id: 'codex-parent-session',
      turn_id: 'turn-1',
      tool_use_id: 'spawn-wrong-type',
      tool_name: 'collaborationspawn_agent',
      tool_input: {
        task_name: action.dispatch.agent_name,
        agent_type: 'explorer',
        message: 'gAAAAABencrypted-v2-message',
        model: action.dispatch.model.model,
        reasoning_effort: action.dispatch.model.reasoning_effort,
      },
    });
    expect(launch.decision).toBe('deny');
    expect((await statusRun(dir)).dispatches).toEqual([
      expect.objectContaining({ ticket_id: action.ticket.ticket_id, status: 'prepared', launch_attempts: 0 }),
    ]);
  });

  it('authorizes spawn_agent, binds SubagentStart, injects a receipt capability, and admits the claimed write', async () => {
    const { dir, action } = await startedCodexProject();
    expect(action.dispatch.spawn_args).toMatchObject({
      task_name: action.dispatch.agent_name,
      fork_turns: 'none',
      model: action.dispatch.model.model,
      reasoning_effort: action.dispatch.model.reasoning_effort,
    });
    expect(action.dispatch.spawn_args.message).toContain('APE common contract');
    expect(action.dispatch.spawn_args.message).toContain('Immutable StageTicket');
    expect((await statusRun(dir)).dispatches).toEqual([
      expect.objectContaining({
        ticket_id: action.ticket.ticket_id,
        status: 'prepared',
        launch_attempts: 0,
      }),
    ]);
    const sessionId = 'codex-parent-session';
    const agentId = 'codex-native-agent-1';
    const launch = await invokeHook({
      hook_event_name: 'PreToolUse',
      project_dir: dir,
      session_id: sessionId,
      turn_id: 'turn-1',
      tool_use_id: 'spawn-1',
      tool_name: 'collaborationspawn_agent',
      tool_input: {
        ...action.dispatch.spawn_args,
        message: 'gAAAAABencrypted-v2-message',
      },
    });
    expect(launch.decision).toBe('allow');

    const explicitMismatch = await invokeHook({
      hook_event_name: 'SubagentStart',
      project_dir: dir,
      session_id: 'codex-child-session',
      turn_id: 'turn-1',
      agent_id: agentId,
      agent_type: 'ape:wrong-role',
    });
    expect(explicitMismatch.decision).toBe('deny');

    // Multi-Agent V2 does not accept a requested agent_type on spawn_agent,
    // and reports its effective default role on the lifecycle event. APE keeps
    // the logical ticket role separate from that host-attested binding role.
    const start = await invokeHook({
      hook_event_name: 'SubagentStart',
      project_dir: dir,
      session_id: 'codex-child-session',
      turn_id: 'turn-1',
      agent_id: agentId,
      agent_type: 'default',
    });
    expect(start.decision).toBe('allow');
    expect(start.hookSpecificOutput?.additionalContext).toMatch(
      /APE_RECEIPT_CAPABILITY=[A-Za-z0-9_-]{32,256}/,
    );
    expect((await statusRun(dir)).dispatches).toEqual([
      expect.objectContaining({
        ticket_id: action.ticket.ticket_id,
        status: 'bound',
        launch_attempts: 1,
      }),
    ]);

    const target = 'docs/note.md';
    const write = await invokeHook({
      hook_event_name: 'PreToolUse',
      project_dir: dir,
      session_id: 'codex-child-session',
      turn_id: 'turn-1',
      agent_id: agentId,
      tool_name: 'Write',
      tool_input: { file_path: target, content: 'export const changed = true;\n' },
    });
    expect(write.decision).toBe('allow');
    await writeFile(path.join(dir, target), '# Note\n\nUpdated by Codex.\n');

    const capability = start.hookSpecificOutput.additionalContext
      .match(/APE_RECEIPT_CAPABILITY=([A-Za-z0-9_-]+)/)?.[1];
    const missingCapability = await recordReceipt(dir, {
      ticket_id: action.ticket.ticket_id,
      status: 'passed',
      tests: [],
      findings: [],
      evidence: { verdict: 'pass' },
      timing: { started_at: action.ticket.issued_at, completed_at: new Date().toISOString(), duration_ms: 1 },
    });
    expect(missingCapability.ok).toBe(false);

    const recorded = await recordReceipt(dir, {
      ticket_id: action.ticket.ticket_id,
      receipt_capability: capability,
      status: 'passed',
      tests: [],
      findings: [],
      evidence: { verdict: 'pass' },
      timing: {
        started_at: action.ticket.issued_at,
        completed_at: new Date().toISOString(),
        duration_ms: 1,
      },
    });
    expect(recorded.ok).toBe(true);

    const impostor = await invokeHook({
      hook_event_name: 'PreToolUse',
      project_dir: dir,
      session_id: sessionId,
      turn_id: 'turn-1',
      agent_id: 'different-agent',
      agent_type: action.dispatch.agent_type,
      tool_name: 'Write',
      tool_input: { file_path: target, content: 'export const changed = false;\n' },
    });
    expect(impostor.decision).toBe('deny');
  });
});

describe('APE v2 codex binding seam (installed hook binary)', () => {
  // RED anchor R2: a codex subagent bound by the active pending public ticket
  // id must be denied the control plane end-to-end (currently 'allow').
  it('denies a ticket-bound codex subagent control-plane call (R2)', async () => {
    const dir = await codexProject();
    const response = await invokeHook({
      hook_event_name: 'PreToolUse',
      project_dir: dir,
      agent_id: 'codex-agent-1',
      ticket_id: 'run-1:build:ticket-1',
      tool_name: 'mcp__plugin_ape_ape__ape_run',
      tool_input: { action: 'next' },
    });
    expect(response.decision).toBe('deny');
  });

  // RED anchor R5 (control-plane arm): the binding may equally arrive via the
  // APE_TICKET_ID environment channel instead of the payload field.
  it('denies the control-plane call when the binding arrives via env APE_TICKET_ID (R5)', async () => {
    const dir = await codexProject();
    const response = await invokeHook({
      hook_event_name: 'PreToolUse',
      project_dir: dir,
      agent_id: 'codex-agent-1',
      tool_name: 'mcp__plugin_ape_ape__ape_run',
      tool_input: { action: 'next' },
    }, codexEnv({ APE_TICKET_ID: 'run-1:build:ticket-1' }));
    expect(response.decision).toBe('deny');
  });

  // RED anchor R3 (a-c): a SubagentStart binding payload must be validated —
  // the named ticket must exist, be unexpired, and carry no receipt.
  it.each([
    ['an unknown ticket', 'run-1:build:ticket-unknown'],
    ['an expired ticket', 'run-1:build:ticket-expired'],
    ['a ticket that already has a receipt', 'run-1:build:ticket-receipted'],
  ])('denies a codex SubagentStart binding naming %s (R3)', async (_label, ticketId) => {
    const dir = await codexProject();
    const response = await invokeHook({
      hook_event_name: 'SubagentStart',
      project_dir: dir,
      agent_id: 'codex-agent-1',
      agent_type: 'worker',
      ticket_id: ticketId,
    });
    expect(response.decision).toBe('deny');
  });

  // RED anchor R3 (d): no binding may be accepted while the run is blocked.
  it('denies a codex SubagentStart binding while the run is blocked (R3)', async () => {
    const dir = await codexProject('blocked');
    const response = await invokeHook({
      hook_event_name: 'SubagentStart',
      project_dir: dir,
      agent_id: 'codex-agent-1',
      agent_type: 'worker',
      ticket_id: 'run-1:build:ticket-1',
    });
    expect(response.decision).toBe('deny');
  });

  // RED anchor R4: a binding payload without bounded native identity is not a
  // handshake — absent agent_id, or an agent_type past any sane bound.
  it('denies a codex SubagentStart binding missing the native agent_id (R4)', async () => {
    const dir = await codexProject();
    const response = await invokeHook({
      hook_event_name: 'SubagentStart',
      project_dir: dir,
      agent_type: 'worker',
      ticket_id: 'run-1:build:ticket-1',
    });
    expect(response.decision).toBe('deny');
  });

  it('denies a codex SubagentStart binding with an unbounded agent_type (R4)', async () => {
    const dir = await codexProject();
    const response = await invokeHook({
      hook_event_name: 'SubagentStart',
      project_dir: dir,
      agent_id: 'codex-agent-1',
      agent_type: 'x'.repeat(600),
      ticket_id: 'run-1:build:ticket-1',
    });
    expect(response.decision).toBe('deny');
  });

  // RED anchor R5 (handshake arm): the same validation applies when the
  // binding arrives via env APE_TICKET_ID instead of the payload field.
  it('denies a codex SubagentStart whose unknown binding arrives via env APE_TICKET_ID (R5)', async () => {
    const dir = await codexProject();
    const response = await invokeHook({
      hook_event_name: 'SubagentStart',
      project_dir: dir,
      agent_id: 'codex-agent-1',
      agent_type: 'worker',
    }, codexEnv({ APE_TICKET_ID: 'run-1:build:ticket-unknown' }));
    expect(response.decision).toBe('deny');
  });

  // GREEN guardrail G3: a valid, active, pending binding is accepted. Decision
  // only — no additionalContext or capability is expected on the codex path.
  it('allows a codex SubagentStart with a valid, active, pending ticket (G3)', async () => {
    const dir = await codexProject();
    const response = await invokeHook({
      hook_event_name: 'SubagentStart',
      project_dir: dir,
      agent_id: 'codex-agent-1',
      agent_type: 'worker',
      ticket_id: 'run-1:build:ticket-1',
    });
    expect(response.decision).toBe('allow');
  });

  // GREEN guardrail G4: never fabricate a binding out-of-band — a SubagentStart
  // with no binding payload at all stays allowed (nothing to validate), and the
  // An unbound Codex start receives a visible warning; its writes fail closed.
  it('warns on an unbound codex SubagentStart and keeps the unbound write fail-closed (G4)', async () => {
    const dir = await codexProject();
    const start = await invokeHook({
      hook_event_name: 'SubagentStart',
      project_dir: dir,
      agent_id: 'codex-agent-1',
      agent_type: 'worker',
    });
    expect(start.decision).toBe('deny');
    expect(start.systemMessage).toMatch(/APE Codex binding denied/i);

    const write = await invokeHook({
      hook_event_name: 'PreToolUse',
      project_dir: dir,
      tool_name: 'Write',
      tool_input: { file_path: path.join(dir, 'src', 'value.js') },
      agent_id: 'codex-agent-1',
    });
    expect(write.decision).toBe('deny');
  });

  // GREEN guardrail G5: public-ticket write binding is retained — a bound
  // codex write lands on claimed paths and only claimed paths.
  it('retains bound codex writes to claimed paths and denies unclaimed targets (G5)', async () => {
    const dir = await codexProject();
    const claimed = await invokeHook({
      hook_event_name: 'PreToolUse',
      project_dir: dir,
      tool_name: 'Write',
      tool_input: { file_path: path.join(dir, 'src', 'value.js') },
      agent_id: 'codex-agent-1',
      ticket_id: 'run-1:build:ticket-1',
    });
    expect(claimed.decision).toBe('allow');

    const unclaimed = await invokeHook({
      hook_event_name: 'PreToolUse',
      project_dir: dir,
      tool_name: 'Write',
      tool_input: { file_path: path.join(dir, 'docs', 'notes.md') },
      agent_id: 'codex-agent-1',
      ticket_id: 'run-1:build:ticket-1',
    });
    expect(unclaimed.decision).toBe('deny');
  });

  // GREEN guardrail G2 (e2e): the codex main session keeps its control-plane
  // exemption so recovery never deadlocks.
  it('allows the codex main-session control-plane call end-to-end (G2)', async () => {
    const dir = await codexProject();
    const response = await invokeHook({
      hook_event_name: 'PreToolUse',
      project_dir: dir,
      tool_name: 'mcp__plugin_ape_ape__ape_run',
      tool_input: { action: 'record' },
    });
    expect(response.decision).toBe('allow');
  });
});
