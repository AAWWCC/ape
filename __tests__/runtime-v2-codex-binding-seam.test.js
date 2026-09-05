import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { evaluateLifecyclePolicy } from '../lib/runtime/hooks.js';
import {
  completeClaudeReceiptBinding,
  corroboratesCodexProbeBinding,
  corroboratesCodexProbeLifecycle,
  expireClaudeIntent,
  prepareCodexIntent,
  readDispatchReceiptCapabilityHash,
  resolveCodexBindingOutcome,
} from '../lib/runtime/claude-dispatch.js';
import { nativeDispatch } from '../lib/runtime/adapters.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { recordReceipt, startRun, statusRun, validateReceiptForDispatch } from '../lib/runtime/service.js';

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
    stage_id: 'build',
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

function invokeHook(input, env = codexEnv(), { timeoutMs = null } = {}) {
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
    let timedOut = false;
    const timeout = timeoutMs === null ? null : setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.on('error', (error) => {
      if (timeout !== null) clearTimeout(timeout);
      reject(error);
    });
    child.on('close', (code) => {
      if (timeout !== null) clearTimeout(timeout);
      if (timedOut) {
        reject(new Error(`APE hook did not exit within ${timeoutMs}ms`));
        return;
      }
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

const serviceModuleUrl = new URL('../lib/runtime/service.js', import.meta.url).href;

// Keep special-file regressions from wedging the Vitest worker itself. The
// child is forcibly bounded, while its result still comes from the public
// status surface and the current unbundled source tree.
function statusRunInFreshProcess(dir, timeoutMs = 3_000) {
  const program = [
    `import { statusRun } from ${JSON.stringify(serviceModuleUrl)};`,
    'const result = await statusRun(process.argv[1]);',
    'process.stdout.write(JSON.stringify(result));',
  ].join('\n');
  return JSON.parse(execFileSync(
    process.execPath,
    ['--input-type=module', '--eval', program, dir],
    {
      cwd: root,
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
    },
  ));
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

async function onlyCodexIntentFile(dir) {
  const intentDirectory = path.join(dir, '.ape', 'runtime', 'dispatch-intents');
  const files = (await readdir(intentDirectory)).filter((name) => name.endsWith('.json'));
  expect(files).toHaveLength(1);
  return path.join(intentDirectory, files[0]);
}

async function bootstrapNativeChild(dir, action, {
  parent = 'codex-parent-session', agent = 'codex-native-agent-1',
  turn = 'distinct-child-turn', type = 'default', toolUseId = `bootstrap-${turn}`,
} = {}) {
  const provisional = await invokeHook({
    hook_event_name: 'SubagentStart', project_dir: dir, session_id: parent,
    turn_id: turn, agent_id: agent, agent_type: type, model: action.dispatch.model.model,
  });
  expect(provisional.decision, JSON.stringify(provisional)).toBe('allow');
  expect(provisional.hookSpecificOutput?.additionalContext ?? '').not.toContain('APE_RECEIPT_CAPABILITY=');
  return invokeHook({
    hook_event_name: 'PreToolUse', project_dir: dir, session_id: agent,
    turn_id: turn, tool_use_id: toolUseId, model: action.dispatch.model.model,
    tool_name: 'mcp__ape__ape_bind', tool_input: action.dispatch.dispatch_intent.bootstrap_args,
  });
}

async function boundCodexIntent({ legacy = false } = {}) {
  const { dir, action } = await startedCodexProject();
  if (legacy) {
    // Author a genuine old-protocol intent through its public writer. Never
    // strip bootstrap fields from an already-authorized modern generation.
    const paths = runtimePaths(dir);
    await expireClaudeIntent(paths, action.ticket.ticket_id);
    const prepared = await prepareCodexIntent(paths, action.ticket, action.dispatch.agent_type);
    action.dispatch = nativeDispatch('codex', action.ticket, prepared);
  }
  const sessionId = legacy ? 'strict-intent-child-session' : 'strict-intent-parent-session';
  const agentId = 'strict-intent-agent';
  const launch = await invokeHook({
    hook_event_name: 'PreToolUse',
    project_dir: dir,
    session_id: 'strict-intent-parent-session',
    turn_id: 'strict-intent-turn',
    tool_use_id: 'strict-intent-tool',
    tool_name: 'collaborationspawn_agent',
    tool_input: action.dispatch.spawn_args,
  });
  expect(launch.decision).toBe('allow');
  const binding = legacy ? await invokeHook({
    hook_event_name: 'SubagentStart',
    project_dir: dir,
    session_id: sessionId,
    turn_id: 'strict-intent-turn',
    agent_id: agentId,
    agent_type: 'default',
  }) : await bootstrapNativeChild(dir, action, {
    parent: sessionId, agent: agentId, turn: 'strict-child-turn',
  });
  expect(binding.decision).toBe('allow');
  const paths = runtimePaths(dir);
  return {
    dir,
    paths,
    file: await onlyCodexIntentFile(dir),
    state: JSON.parse(await readFile(paths.active, 'utf8')),
    ticket: action.ticket,
    sessionId,
    agentId,
  };
}

describe('APE v2 native Codex dispatch handshake', () => {
  it('rejects parseable bound intents whose lifecycle authority is partial or downgraded', async () => {
    const { paths, file, state, sessionId, agentId } = await boundCodexIntent();
    const original = JSON.parse(await readFile(file, 'utf8'));
    const mutations = [
      ['launch capability', (record) => { delete record.launch_name_hash; }],
      ['launch attempt', (record) => { record.launch_attempts = 0; }],
      ['parent session', (record) => { delete record.parent_session_id; }],
      ['tool call', (record) => { delete record.tool_use_id; }],
      ['requested model', (record) => { delete record.requested_model; }],
      ['launch timestamp', (record) => { delete record.launched_at; }],
      ['launch expiry', (record) => { delete record.launch_expires_at; }],
      ['authorization timestamp', (record) => { delete record.authorized_at; }],
      ['launch turn', (record) => { delete record.turn_id_hash; }],
      ['launch generation', (record) => { delete record.launch_generation; }],
      ['launch history', (record) => { delete record.launch_generations; }],
      ['authoritative context', (record) => { delete record.injected_context_hash; }],
      ['binding agent type', (record) => { delete record.binding_agent_type; }],
      ['bound session', (record) => { delete record.bound_session_id; }],
      ['bound agent', (record) => { delete record.bound_agent_id; }],
      ['receipt capability', (record) => { delete record.capability_hash; }],
      ['binding timestamp', (record) => { delete record.bound_at; }],
    ];
    for (const [label, mutate] of mutations) {
      const damaged = structuredClone(original);
      mutate(damaged);
      await writeFile(file, `${JSON.stringify(damaged)}\n`);
      await expect(resolveCodexBindingOutcome(paths, state, {
        session_id: sessionId,
        agent_id: agentId,
        agent_type: 'default',
      }), label).rejects.toThrow(/structurally invalid/iu);
    }

    for (const status of ['authorized', 'launched', 'bound', 'completed']) {
      const minimal = {
        version: 2,
        host: 'codex',
        run_id: original.run_id,
        ticket_id: original.ticket_id,
        ticket_hash: original.ticket_hash,
        agent_type: original.agent_type,
        launch_name_hash: original.launch_name_hash,
        status,
        prepared_at: original.prepared_at,
        expires_at: original.expires_at,
        launch_attempts: 0,
        ...(status === 'bound' || status === 'completed'
          ? {
              bound_session_id: sessionId,
              bound_agent_id: agentId,
              capability_hash: original.capability_hash,
              bound_at: original.bound_at,
            }
          : {}),
      };
      await writeFile(file, `${JSON.stringify(minimal)}\n`);
      await expect(resolveCodexBindingOutcome(paths, state, {
        session_id: sessionId,
        agent_id: agentId,
        agent_type: 'default',
      }), status).rejects.toThrow(/structurally invalid/iu);
    }
  });

  it('keeps the exact pre-generation Codex bound shape resolvable after upgrade', async () => {
    const { paths, file, state, sessionId, agentId } = await boundCodexIntent({ legacy: true });
    const current = JSON.parse(await readFile(file, 'utf8'));
    const {
      launch_seed: _launchSeed,
      launch_generation: _launchGeneration,
      launch_generations: _launchGenerations,
      authorized_at: _authorizedAt,
      turn_id_hash: _turnIdHash,
      injected_context_hash: _injectedContextHash,
      binding_agent_type: _bindingAgentType,
      bound_session_id: _boundSessionId,
      ...legacy
    } = current;
    await writeFile(file, `${JSON.stringify({
      ...legacy,
      parent_session_id: sessionId,
    })}\n`);

    await expect(resolveCodexBindingOutcome(paths, state, {
      session_id: sessionId,
      agent_id: agentId,
      agent_type: 'default',
    })).resolves.toMatchObject({
      record: { status: 'bound', bound_agent_id: agentId },
      cause: null,
    });
  });

  it('keeps an upgraded pre-generation Codex completion readable for idempotent receipt checks', async () => {
    const { paths, file, ticket, sessionId, agentId } = await boundCodexIntent({ legacy: true });
    const current = JSON.parse(await readFile(file, 'utf8'));
    const {
      launch_seed: _launchSeed,
      launch_generation: _launchGeneration,
      launch_generations: _launchGenerations,
      authorized_at: _authorizedAt,
      turn_id_hash: _turnIdHash,
      injected_context_hash: _injectedContextHash,
      binding_agent_type: _BindingAgentType,
      bound_session_id: _boundSessionId,
      ...legacy
    } = current;
    const legacyBound = { ...legacy, parent_session_id: sessionId };
    await writeFile(file, `${JSON.stringify(legacyBound)}\n`);
    const inputHash = 'd'.repeat(64);
    await completeClaudeReceiptBinding(
      paths,
      ticket,
      { file, record: legacyBound },
      inputHash,
      {
        receipt_id: 'legacy-upgraded-receipt',
        receipt_hash: 'e'.repeat(64),
      },
    );
    await expect(readDispatchReceiptCapabilityHash(paths, ticket.ticket_id))
      .resolves.toBe(current.capability_hash);
    const completed = JSON.parse(await readFile(file, 'utf8'));
    expect(completed).toMatchObject({
      status: 'completed',
      launch_generation: 1,
      bound_agent_id: agentId,
      receipt_input_hash: inputHash,
    });
    expect(completed).not.toHaveProperty('launch_seed');
  });

  it('does not let a minimal bound object corroborate native probe proof', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ape-probe-intent-validator-'));
    cleanups.push(dir);
    const paths = runtimePaths(dir);
    await mkdir(paths.dispatchIntents, { recursive: true });
    const preparedAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const expected = {
      probe_id: 'probe-strict-dispatch-intent',
      host: 'codex',
      agent_type: 'explorer',
      ticket_id: 'probe-strict-dispatch-intent:binding-probe:ticket',
      ticket_hash: 'a'.repeat(64),
      launch_name_hash: 'b'.repeat(64),
      status: 'bound',
      prepared_at: preparedAt,
      expires_at: expiresAt,
      parent_session_id: 'probe-parent',
      tool_use_id: 'probe-tool',
      binding_agent_type: 'default',
      bound_session_id: 'probe-child',
      bound_agent_id: 'probe-agent',
      capability_hash: 'c'.repeat(64),
    };
    const file = path.join(
      paths.dispatchIntents,
      `${createHash('sha256').update(expected.ticket_id).digest('hex')}.json`,
    );
    await writeFile(file, `${JSON.stringify({
      version: 2,
      codex_task_namespace: 'probe',
      run_id: expected.probe_id,
      ticket_id: expected.ticket_id,
      ticket_hash: expected.ticket_hash,
      launch_name_hash: expected.launch_name_hash,
      host: expected.host,
      agent_type: expected.agent_type,
      status: 'bound',
      prepared_at: preparedAt,
      expires_at: expiresAt,
      launch_attempts: 0,
      parent_session_id: expected.parent_session_id,
      tool_use_id: expected.tool_use_id,
      binding_agent_type: expected.binding_agent_type,
      bound_session_id: expected.bound_session_id,
      bound_agent_id: expected.bound_agent_id,
      capability_hash: expected.capability_hash,
      bound_at: preparedAt,
    })}\n`);

    await expect(corroboratesCodexProbeBinding(paths, expected)).resolves.toBe(false);
    await expect(corroboratesCodexProbeLifecycle(paths, expected)).resolves.toBe(false);
  });

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
        fork_turns: 'none',
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
        binding_observation: {
          state: 'not_observed',
          observed_at: null,
          code: null,
          attempt_count: 0,
        },
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
        fork_turns: 'none',
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

  it('rejects inherited conversation history and keeps the production intent prepared', async () => {
    const { dir, action } = await startedCodexProject();
    const launch = await invokeHook({
      hook_event_name: 'PreToolUse',
      project_dir: dir,
      session_id: 'codex-parent-session',
      turn_id: 'turn-fork-history',
      tool_use_id: 'spawn-fork-history',
      tool_name: 'collaborationspawn_agent',
      tool_input: {
        ...action.dispatch.spawn_args,
        fork_turns: '1',
        message: 'gAAAAABencrypted-v2-message',
      },
    });
    expect(launch.decision).toBe('deny');
    expect(
      launch.hookSpecificOutput?.permissionDecisionReason ??
        launch.reason ??
        launch.systemMessage,
    ).toMatch(/fork_turns must be exactly 'none'/i);
    expect((await statusRun(dir)).dispatches).toEqual([
      expect.objectContaining({
        ticket_id: action.ticket.ticket_id,
        status: 'prepared',
        launch_attempts: 0,
      }),
    ]);
  });

  it('authorizes spawn_agent, bootstraps a native child, injects a receipt capability, and admits the claimed write', async () => {
    const { dir, action } = await startedCodexProject();
    expect(action.dispatch.spawn_args).toMatchObject({
      task_name: action.dispatch.agent_name,
      fork_turns: 'none',
      model: action.dispatch.model.model,
      reasoning_effort: action.dispatch.model.reasoning_effort,
    });
    expect(action.dispatch.ticket_projection).toBe('bootstrap-hook-injected');
    expect(action.dispatch.spawn_args.message).toContain('ape_bind');
    expect(action.dispatch.spawn_args.message).not.toContain('APE common contract');
    expect(action.dispatch.spawn_args.message).not.toContain(action.ticket.ticket_id);
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
      toolCall: {
        args: {
          ...action.dispatch.spawn_args,
          message: 'gAAAAABencrypted-v2-message',
        },
      },
    });
    expect(launch.decision).toBe('allow');
    const changedModelRetry = await invokeHook({
      hook_event_name: 'PreToolUse',
      project_dir: dir,
      session_id: sessionId,
      turn_id: 'turn-1',
      tool_use_id: 'spawn-1',
      tool_name: 'collaborationspawn_agent',
      tool_input: {
        ...action.dispatch.spawn_args,
        message: 'gAAAAABencrypted-v2-message',
        model: `${action.dispatch.model.model}-changed`,
      },
    });
    expect(changedModelRetry.decision).toBe('deny');
    const {
      reasoning_effort: _omittedEffort,
      ...withoutReasoningEffort
    } = action.dispatch.spawn_args;
    expect(_omittedEffort).toEqual(expect.any(String));
    const omittedEffortRetry = await invokeHook({
      hook_event_name: 'PreToolUse',
      project_dir: dir,
      session_id: sessionId,
      turn_id: 'turn-1',
      tool_use_id: 'spawn-1',
      tool_name: 'collaborationspawn_agent',
      tool_input: {
        ...withoutReasoningEffort,
        message: 'gAAAAABencrypted-v2-message',
      },
    });
    expect(omittedEffortRetry.decision).toBe('deny');
    const exactLostResponseRetry = await invokeHook({
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
    expect(exactLostResponseRetry.decision).toBe('allow');
    expect((await statusRun(dir)).dispatches[0].binding_observation).toMatchObject({
      state: 'not_observed',
      observed_at: null,
      attempt_count: 0,
    });

    const explicitMismatch = await bootstrapNativeChild(dir, action, {
      parent: sessionId, agent: 'wrong-type-child', turn: 'wrong-type-child-turn', type: 'ape:wrong-role',
    });
    expect(explicitMismatch.decision).toBe('deny');
    expect((await statusRun(dir)).dispatches[0].binding_observation).toMatchObject({
      state: 'rejected',
      code: 'agent_type_mismatch',
      attempt_count: 1,
    });

    // Multi-Agent V2 does not accept a requested agent_type on spawn_agent,
    // and reports its effective default role on the lifecycle event. APE keeps
    // the logical ticket role separate from that host-attested binding role.
    const start = await bootstrapNativeChild(dir, action, {
      parent: sessionId, agent: agentId, turn: 'actual-child-turn',
    });
    expect(start.decision).toBe('allow');
    expect(start.hookSpecificOutput?.additionalContext).toMatch(
      /APE_RECEIPT_CAPABILITY=[A-Za-z0-9_-]{32,256}/,
    );
    expect(start.hookSpecificOutput?.additionalContext).toContain(
      'APE trusted native binding context (authoritative)',
    );
    expect(start.hookSpecificOutput?.additionalContext).toContain(
      'Never invoke rg, grep, sed, find, awk',
    );
    expect(start.hookSpecificOutput?.additionalContext).toContain('APE common contract');
    expect(start.hookSpecificOutput?.additionalContext).toContain('APE implementer contract');
    expect(start.hookSpecificOutput?.additionalContext).toContain('Immutable StageTicket reference');
    expect(start.hookSpecificOutput?.additionalContext).toContain(
      `.ape/runtime/tickets/${action.ticket.ticket_id.replaceAll(':', '_')}.json`,
    );
    expect(start.hookSpecificOutput?.additionalContext).toContain(action.ticket.ticket_hash);
    const persistedTicket = JSON.parse(await readFile(
      path.join(
        dir,
        '.ape',
        'runtime',
        'tickets',
        `${action.ticket.ticket_id.replaceAll(':', '_')}.json`,
      ),
      'utf8',
    ));
    expect(persistedTicket.output_schema.properties.tests.items.properties).toHaveProperty('exit_code');
    expect((await statusRun(dir)).dispatches).toEqual([
      expect.objectContaining({
        ticket_id: action.ticket.ticket_id,
        status: 'bound',
        launch_attempts: 1,
        binding_observation: expect.objectContaining({
          state: 'accepted',
          code: 'bound',
        }),
      }),
    ]);

    const target = 'docs/note.md';
    const write = await invokeHook({
      hook_event_name: 'PreToolUse',
      project_dir: dir,
      session_id: agentId,
      turn_id: 'actual-child-turn',
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

    const draft = {
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
    };
    const unvalidated = await recordReceipt(dir, draft);
    expect(unvalidated.ok).toBe(false);
    expect(unvalidated.errors).toContain(
      'receipt draft was not pre-validated and attested byte-for-byte for this physical dispatch',
    );
    expect(await validateReceiptForDispatch(dir, draft, action.ticket.ticket_id))
      .toMatchObject({ ok: true, valid: true, attested: true });
    const recorded = await recordReceipt(dir, draft);
    expect(recorded.ok, JSON.stringify({ reason: recorded.reason, errors: recorded.errors })).toBe(true);

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

  it('fails closed when the prepared authoritative context hash is altered', async () => {
    const { dir, action } = await startedCodexProject();
    const launch = await invokeHook({
      hook_event_name: 'PreToolUse',
      project_dir: dir,
      session_id: 'codex-parent-session',
      turn_id: 'turn-context-hash',
      tool_use_id: 'spawn-context-hash',
      tool_name: 'collaborationspawn_agent',
      tool_input: {
        ...action.dispatch.spawn_args,
        message: 'opaque-and-untrusted-launch-message',
      },
    });
    expect(launch.decision).toBe('allow');

    const intentFile = await onlyCodexIntentFile(dir);
    const intent = JSON.parse(await readFile(intentFile, 'utf8'));
    expect(intent.injected_context_hash).toMatch(/^[a-f0-9]{64}$/);
    await writeFile(intentFile, `${JSON.stringify({
      ...intent,
      injected_context_hash: '0'.repeat(64),
    })}\n`);

    const start = await bootstrapNativeChild(dir, action, {
      agent: 'codex-agent-context-hash', turn: 'child-context-hash-turn',
    });
    expect(start.decision).toBe('deny');
    expect(start.hookSpecificOutput?.permissionDecisionReason).toMatch(/authoritative context hash mismatch/i);
    expect((await statusRun(dir)).dispatches).toEqual([
      expect.objectContaining({
        status: 'launched',
        launch_attempts: 1,
        binding_observation: expect.objectContaining({
          state: 'rejected',
          code: 'context_hash_mismatch',
          attempt_count: 1,
        }),
      }),
    ]);
  });

  it('fails closed when the prepared intent no longer matches the active ticket hash', async () => {
    const { dir, action } = await startedCodexProject();
    const launch = await invokeHook({
      hook_event_name: 'PreToolUse',
      project_dir: dir,
      session_id: 'codex-parent-session',
      turn_id: 'turn-ticket-hash',
      tool_use_id: 'spawn-ticket-hash',
      tool_name: 'collaborationspawn_agent',
      tool_input: action.dispatch.spawn_args,
    });
    expect(launch.decision).toBe('allow');

    const intentFile = await onlyCodexIntentFile(dir);
    const intent = JSON.parse(await readFile(intentFile, 'utf8'));
    const mismatchedTicketHash = 'f'.repeat(64);
    await writeFile(intentFile, `${JSON.stringify({
      ...intent,
      ticket_hash: mismatchedTicketHash,
      launch_generations: intent.launch_generations.map((entry) => ({
        ...entry,
        ticket_hash: mismatchedTicketHash,
      })),
    })}\n`);

    const start = await bootstrapNativeChild(dir, action, {
      agent: 'codex-agent-ticket-hash', turn: 'child-ticket-hash-turn',
    });
    expect(start.decision).toBe('deny');
    expect(start.hookSpecificOutput?.permissionDecisionReason).toMatch(/dispatch ticket hash mismatch/i);
    expect((await statusRun(dir)).dispatches[0].binding_observation).toMatchObject({
      state: 'rejected',
      code: 'ticket_hash_mismatch',
      attempt_count: 1,
    });
  });

  it('persists bounded malformed-identity observations without native identities or reasons', async () => {
    const { dir, action } = await startedCodexProject();
    const launch = await invokeHook({
      hook_event_name: 'PreToolUse',
      project_dir: dir,
      session_id: 'diagnostic-parent-session',
      turn_id: 'turn-malformed-diagnostic',
      tool_use_id: 'spawn-malformed-diagnostic',
      tool_name: 'collaborationspawn_agent',
      tool_input: action.dispatch.spawn_args,
    });
    expect(launch.decision).toBe('allow');

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const start = await invokeHook({
        hook_event_name: 'SubagentStart',
        project_dir: dir,
        session_id: `private-child-session-${attempt}`,
        turn_id: `turn-malformed-${attempt}`,
        agent_type: 'default',
      });
      expect(start.decision).toBe('deny');
    }

    expect((await statusRun(dir)).dispatches[0].binding_observation).toMatchObject({
      state: 'rejected',
      code: 'malformed_agent_identity',
      attempt_count: 10,
    });
    const diagnosticText = await readFile(
      path.join(dir, '.ape', 'runtime', 'subagent-start-diagnostics.json'),
      'utf8',
    );
    const diagnostic = JSON.parse(diagnosticText);
    expect(diagnostic.observations).toHaveLength(8);
    expect(diagnosticText).not.toContain('private-child-session');
    expect(diagnosticText).not.toContain('malformed native identity');
  });

  it('reconstructs retained diagnostic observations without legacy extra fields', async () => {
    const { dir, action } = await startedCodexProject();
    const diagnosticPath = path.join(
      dir,
      '.ape',
      'runtime',
      'subagent-start-diagnostics.json',
    );
    await writeFile(diagnosticPath, `${JSON.stringify({
      version: 1,
      run_hash: createHash('sha256').update(action.ticket.run_id).digest('hex'),
      host: 'codex',
      total: 1,
      observations: [{
        observed_at: new Date().toISOString(),
        outcome: 'rejected',
        code: 'malformed_agent_identity',
        session_id: 'private-seeded-session',
        reason: 'private seeded reason',
        oversized: 'x'.repeat(20_000),
      }],
    })}\n`);

    const start = await invokeHook({
      hook_event_name: 'SubagentStart',
      project_dir: dir,
      session_id: 'private-next-session',
      turn_id: 'diagnostic-rewrite-turn',
      agent_type: 'default',
    });
    expect(start.decision).toBe('deny');
    const diagnosticText = await readFile(diagnosticPath, 'utf8');
    const diagnostic = JSON.parse(diagnosticText);
    expect(diagnostic.total).toBe(2);
    expect(diagnostic.observations).toHaveLength(2);
    expect(diagnostic.observations[0]).toEqual({
      observed_at: expect.any(String),
      outcome: 'rejected',
      code: 'malformed_agent_identity',
    });
    expect(diagnosticText).not.toContain('private-seeded');
    expect(diagnosticText).not.toContain('oversized');
  });

  it.skipIf(process.platform === 'win32')(
    'does not follow a symlinked diagnostic leaf while projecting or recording observations',
    async () => {
      const { dir, action } = await startedCodexProject();
      const diagnosticPath = path.join(
        dir,
        '.ape',
        'runtime',
        'subagent-start-diagnostics.json',
      );
      const outsidePath = path.join(dir, 'symlink-target-diagnostics.json');
      const outsideText = `${JSON.stringify({
        version: 1,
        run_hash: createHash('sha256').update(action.ticket.run_id).digest('hex'),
        host: 'codex',
        total: 41,
        observations: [{
          observed_at: new Date().toISOString(),
          outcome: 'rejected',
          code: 'unexpected_exception',
        }],
      })}\n`;
      await writeFile(outsidePath, outsideText);
      await symlink(outsidePath, diagnosticPath);

      expect(statusRunInFreshProcess(dir).dispatches[0].binding_observation).toEqual({
        state: 'not_observed',
        observed_at: null,
        code: null,
        attempt_count: 0,
      });

      const start = await invokeHook({
        hook_event_name: 'SubagentStart',
        project_dir: dir,
        session_id: 'symlink-diagnostic-session',
        turn_id: 'symlink-diagnostic-turn',
        agent_type: 'default',
      });
      expect(start.decision).toBe('deny');
      expect(await readFile(outsidePath, 'utf8')).toBe(outsideText);
      const replacementMetadata = await lstat(diagnosticPath);
      expect(replacementMetadata.isFile()).toBe(true);
      expect(replacementMetadata.isSymbolicLink()).toBe(false);
      expect(JSON.parse(await readFile(diagnosticPath, 'utf8'))).toMatchObject({
        version: 1,
        total: 1,
        observations: [{
          outcome: 'rejected',
          code: 'malformed_agent_identity',
        }],
      });
    },
  );

  it('ignores and replaces an oversized diagnostic leaf with a fresh bounded observation', async () => {
    const { dir, action } = await startedCodexProject();
    const diagnosticPath = path.join(
      dir,
      '.ape',
      'runtime',
      'subagent-start-diagnostics.json',
    );
    await writeFile(diagnosticPath, `${JSON.stringify({
      version: 1,
      run_hash: createHash('sha256').update(action.ticket.run_id).digest('hex'),
      host: 'codex',
      total: 17,
      observations: [{
        observed_at: new Date().toISOString(),
        outcome: 'error',
        code: 'unexpected_exception',
      }],
      padding: 'x'.repeat(2 * 1024 * 1024),
    })}\n`);

    expect(statusRunInFreshProcess(dir).dispatches[0].binding_observation).toEqual({
      state: 'not_observed',
      observed_at: null,
      code: null,
      attempt_count: 0,
    });

    const start = await invokeHook({
      hook_event_name: 'SubagentStart',
      project_dir: dir,
      session_id: 'oversized-diagnostic-session',
      turn_id: 'oversized-diagnostic-turn',
      agent_type: 'default',
    });
    expect(start.decision).toBe('deny');
    const replacementText = await readFile(diagnosticPath, 'utf8');
    expect(Buffer.byteLength(replacementText)).toBeLessThan(64 * 1024);
    expect(JSON.parse(replacementText)).toMatchObject({
      version: 1,
      total: 1,
      observations: [{
        outcome: 'rejected',
        code: 'malformed_agent_identity',
      }],
    });
  });

  it.skipIf(process.platform === 'win32')(
    'does not open a diagnostic FIFO while projecting or recording observations',
    async () => {
      const { dir } = await startedCodexProject();
      const diagnosticPath = path.join(
        dir,
        '.ape',
        'runtime',
        'subagent-start-diagnostics.json',
      );
      execFileSync('mkfifo', [diagnosticPath]);

      expect(statusRunInFreshProcess(dir).dispatches[0].binding_observation).toEqual({
        state: 'not_observed',
        observed_at: null,
        code: null,
        attempt_count: 0,
      });

      const start = await invokeHook({
        hook_event_name: 'SubagentStart',
        project_dir: dir,
        session_id: 'fifo-diagnostic-session',
        turn_id: 'fifo-diagnostic-turn',
        agent_type: 'default',
      }, codexEnv(), { timeoutMs: 3_000 });
      expect(start.decision).toBe('deny');
      const replacementMetadata = await lstat(diagnosticPath);
      expect(replacementMetadata.isFile()).toBe(true);
      expect(JSON.parse(await readFile(diagnosticPath, 'utf8'))).toMatchObject({
        version: 1,
        total: 1,
        observations: [{
          outcome: 'rejected',
          code: 'malformed_agent_identity',
        }],
      });
    },
  );

  it('does not project an oversized parseable diagnostic timestamp', async () => {
    const { dir, action } = await startedCodexProject();
    await writeFile(
      path.join(dir, '.ape', 'runtime', 'subagent-start-diagnostics.json'),
      `${JSON.stringify({
        version: 1,
        run_hash: createHash('sha256').update(action.ticket.run_id).digest('hex'),
        host: 'codex',
        total: 1,
        observations: [{
          observed_at: `2020-01-01${' '.repeat(20_000)}`,
          outcome: 'error',
          code: 'unexpected_exception',
        }],
      })}\n`,
    );

    expect((await statusRun(dir)).dispatches[0].binding_observation).toEqual({
      state: 'not_observed',
      observed_at: null,
      code: null,
      attempt_count: 0,
    });
  });

  it('does not project an oversized legacy bound timestamp', async () => {
    const { dir } = await startedCodexProject();
    const intentFile = await onlyCodexIntentFile(dir);
    const intent = JSON.parse(await readFile(intentFile, 'utf8'));
    await writeFile(intentFile, `${JSON.stringify({
      ...intent,
      status: 'bound',
      bound_at: `2020-01-01${' '.repeat(20_000)}`,
    })}\n`);

    expect((await statusRun(dir)).dispatches[0].binding_observation).toEqual({
      state: 'not_observed',
      observed_at: null,
      code: null,
      attempt_count: 0,
    });
  });

  it('records an unexpected production binding exception as a typed error', async () => {
    const { dir, action } = await startedCodexProject();
    const launch = await invokeHook({
      hook_event_name: 'PreToolUse',
      project_dir: dir,
      session_id: 'exception-parent-session',
      turn_id: 'turn-exception-diagnostic',
      tool_use_id: 'spawn-exception-diagnostic',
      tool_name: 'collaborationspawn_agent',
      tool_input: action.dispatch.spawn_args,
    });
    expect(launch.decision).toBe('allow');
    await writeFile(await onlyCodexIntentFile(dir), '{invalid-json');

    const start = await invokeHook({
      hook_event_name: 'SubagentStart',
      project_dir: dir,
      session_id: 'private-exception-child-session',
      turn_id: 'turn-exception-diagnostic',
      agent_id: 'private-exception-agent-id',
      agent_type: 'default',
    });
    expect(start.decision).toBe('deny');
    const diagnosticText = await readFile(
      path.join(dir, '.ape', 'runtime', 'subagent-start-diagnostics.json'),
      'utf8',
    );
    expect(JSON.parse(diagnosticText).observations.at(-1)).toMatchObject({
      outcome: 'error',
      code: 'unexpected_exception',
    });
    expect(diagnosticText).not.toContain('private-exception');
    expect(diagnosticText).not.toContain('invalid-json');
    const status = await statusRun(dir);
    expect(status.dispatch_state).toBe('error');
    expect(status.dispatches).toEqual([
      expect.objectContaining({
        ticket_id: action.ticket.ticket_id,
        status: 'corrupt',
        agent_state: 'evidence-unreadable',
        evidence_unreadable: true,
        binding_observation: expect.objectContaining({
          state: 'error',
          code: 'unexpected_exception',
          attempt_count: 1,
        }),
      }),
    ]);
  });

  it('re-injects the authoritative context idempotently after a fresh native child-turn bootstrap', async () => {
    const { dir, action } = await startedCodexProject();
    const sessionId = 'codex-parent-resume';
    const agentId = 'codex-agent-resume';
    const launch = await invokeHook({
      hook_event_name: 'PreToolUse',
      project_dir: dir,
      session_id: 'codex-parent-resume',
      turn_id: 'turn-resume',
      tool_use_id: 'spawn-resume',
      tool_name: 'collaborationspawn_agent',
      tool_input: action.dispatch.spawn_args,
    });
    expect(launch.decision).toBe('allow');
    const first = await bootstrapNativeChild(dir, action, {
      parent: sessionId, agent: agentId, turn: 'child-resume-turn-1',
    });
    expect(first.decision, JSON.stringify(first)).toBe('allow');
    const firstCapability = first.hookSpecificOutput.additionalContext
      .match(/APE_RECEIPT_CAPABILITY=([A-Za-z0-9_-]+)/)?.[1];

    const resumed = await bootstrapNativeChild(dir, action, {
      parent: sessionId, agent: agentId, turn: 'child-resume-turn-2',
    });
    expect(resumed.decision, JSON.stringify(resumed)).toBe('allow');
    expect(resumed.hookSpecificOutput.additionalContext).toContain(
      'APE trusted native binding context (authoritative)',
    );
    const resumedCapability = resumed.hookSpecificOutput.additionalContext
      .match(/APE_RECEIPT_CAPABILITY=([A-Za-z0-9_-]+)/)?.[1];
    expect(resumedCapability).toMatch(/^[A-Za-z0-9_-]{32,256}$/);
    expect(resumedCapability).toBe(firstCapability);
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

  it('keeps a valid compatibility binding allowed when diagnostic persistence fails', async () => {
    const dir = await codexProject();
    // A directory at the diagnostic file path makes the best-effort atomic
    // replacement fail without weakening the independently valid binding.
    await mkdir(
      path.join(dir, '.ape', 'runtime', 'subagent-start-diagnostics.json'),
      { recursive: true },
    );
    const response = await invokeHook({
      hook_event_name: 'SubagentStart',
      project_dir: dir,
      agent_id: 'codex-agent-diagnostic-fault',
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
