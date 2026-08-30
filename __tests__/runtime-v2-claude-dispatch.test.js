import { execFileSync, spawn } from 'node:child_process';
import { readFile, mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { bindClaudeSubagent, launchClaudeIntent, pruneClaudeIntents } from '../lib/runtime/claude-dispatch.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { finalizeTicket } from '../lib/runtime/schemas.js';
import { abortRun, recordReceipt, startRun } from '../lib/runtime/service.js';
import { atomicWriteJson } from '../lib/runtime/storage.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// End-to-end against the SOURCE hook binary (bin/ape-hook.mjs), not the stale
// dist bundle: a targeted run after a lib/runtime edit (hooks.js,
// claude-dispatch.js) must exercise the edited code, matching the other hook
// e2e suites. Spawning the committed bundle here gave false green on broken
// source (and false red on fixed source) until the next npm run bundle. Bundle
// byte-identity is attested by runtime-v2-bundle-freshness.test.js, and the
// smoke describe below still EXECUTES the shipped bundle hooks.json wires.
const hookBinary = path.join(root, 'bin', 'ape-hook.mjs');
const hookBundle = path.join(root, 'dist', 'ape-hooks.bundle.mjs');
const cleanups = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function project() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-claude-dispatch-'));
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
    test_commands: { full: 'node --test' },
  });
  return dir;
}

async function startClaude(dir) {
  const result = await startRun(dir, {
    objective: 'Change behavior through a standard Claude Agent',
    mode: 'phase',
    lane: 'fast',
    host: 'claude',
    claimed_paths: ['src/value.js'],
    test_paths: ['tests/value.test.js'],
    requirements: ['R-CLAUDE-BINDING'],
    risk_triggers: [],
    behavioral: true,
    hooks_trusted: true,
    subagents_available: true,
    explicit_invocation: true,
  });
  expect(result.ok).toBe(true);
  const action = result.actions.find((entry) => entry.type === 'dispatch_agent');
  expect(action).toBeDefined();
  return { result, action, ticket: action.ticket };
}

async function readOnlyIntent(dir) {
  const paths = runtimePaths(dir);
  const names = (await readdir(paths.dispatchIntents)).filter((name) => name.endsWith('.json'));
  expect(names).toHaveLength(1);
  const file = path.join(paths.dispatchIntents, names[0]);
  return { file, intent: JSON.parse(await readFile(file, 'utf8')) };
}

function launchNonce(dispatch) {
  return (
    dispatch?.dispatch_intent?.nonce ??
    dispatch?.intent?.nonce ??
    dispatch?.launch?.nonce ??
    dispatch?.nonce ??
    null
  );
}

function launchPrompt(dispatch, nonce, ticket) {
  return (
    dispatch?.dispatch_intent?.prompt ??
    dispatch?.intent?.prompt ??
    dispatch?.launch?.prompt ??
    dispatch?.prompt ??
    `Execute the immutable ticket ${ticket.ticket_id}.\nAPE_DISPATCH_NONCE=${nonce}`
  );
}

// The ticket's resolved model: the documented workflow forwards it verbatim as
// the Agent invocation's `model` parameter, and launchClaudeIntent enforces it
// (F11) — a launch without it (or with a different model) is denied.
function launchModel(dispatch) {
  return dispatch?.model?.model;
}

function invokeClaudeHook(input, binary = hookBinary) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binary], {
      cwd: root,
      env: { ...process.env, CLAUDECODE: '1' },
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

function decision(response) {
  return response?.hookSpecificOutput?.permissionDecision;
}

function receiptCapability(response) {
  const context = response?.hookSpecificOutput?.additionalContext ?? '';
  return context.match(/APE_RECEIPT_CAPABILITY=([A-Za-z0-9_-]+)/)?.[1] ?? null;
}

describe('APE v2 standard Claude Agent dispatch binding', () => {
  it.each([
    ['Read', { file_path: 'README.md' }],
    ['Write', { file_path: 'ordinary.txt', content: 'ordinary' }],
    ['Bash', { command: 'printf ordinary' }],
    ['Agent', { subagent_type: 'general-purpose', prompt: 'ordinary work' }],
    ['mcp__example__custom', { operation: 'ordinary' }],
  ])('passes ordinary non-APE Claude subagent %s through unchanged', async (toolName, toolInput) => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ape-ordinary-claude-'));
    cleanups.push(dir);
    const response = await invokeClaudeHook({
      hook_event_name: 'PreToolUse',
      project_dir: dir,
      session_id: 'ordinary-parent',
      agent_id: 'ordinary-claude-subagent',
      agent_type: 'general-purpose',
      tool_use_id: `ordinary-${toolName}`,
      tool_name: toolName,
      tool_input: toolInput,
    });

    if (toolName.startsWith('mcp__')) expect(response).toEqual({});
    else expect(decision(response)).toBe('allow');
  });

  it('prepares a bounded one-time nonce without persisting its plaintext', async () => {
    const dir = await project();
    const { action } = await startClaude(dir);
    const nonce = launchNonce(action.dispatch);

    expect(nonce, 'writable Claude dispatch must expose a one-time launch nonce').toMatch(
      /^[A-Za-z0-9_-]{32,256}$/,
    );
    const stored = await readFile(runtimePaths(dir).active, 'utf8');
    expect(stored).not.toContain(nonce);
    expect(Buffer.byteLength(stored)).toBeLessThan(256 * 1024);
  });

  it('recovers a legacy prepared intent after its five-minute nonce lease and still consumes it once', async () => {
    const dir = await project();
    const { action, ticket } = await startClaude(dir);
    const nonce = launchNonce(action.dispatch);
    const prompt = launchPrompt(action.dispatch, nonce, ticket);
    const { file, intent } = await readOnlyIntent(dir);
    await atomicWriteJson(file, {
      ...intent,
      prepared_at: new Date(Date.now() - 10 * 60_000).toISOString(),
      nonce_expires_at: new Date(Date.now() - 5 * 60_000).toISOString(),
    });
    const base = {
      hook_event_name: 'PreToolUse',
      project_dir: dir,
      session_id: 'slow-planning-parent',
      tool_name: 'Agent',
      tool_input: {
        subagent_type: action.dispatch.agent_type,
        prompt,
        model: launchModel(action.dispatch),
      },
    };

    const first = await invokeClaudeHook({ ...base, tool_use_id: 'slow-planning-launch' });
    expect(decision(first)).toBe('allow');

    const identicalRetry = await invokeClaudeHook({ ...base, tool_use_id: 'slow-planning-launch' });
    expect(decision(identicalRetry)).toBe('allow');

    const replay = await invokeClaudeHook({ ...base, tool_use_id: 'slow-planning-replay' });
    expect(decision(replay)).toBe('deny');
  });

  it('denies a prepared intent once its ticket deadline has elapsed', async () => {
    const dir = await project();
    const { action, ticket } = await startClaude(dir);
    const nonce = launchNonce(action.dispatch);
    const deadline = new Date(Date.now() - 1_000).toISOString();
    const { file, intent } = await readOnlyIntent(dir);
    await atomicWriteJson(file, {
      ...intent,
      expires_at: deadline,
      nonce_expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    const paths = runtimePaths(dir);
    const state = JSON.parse(await readFile(paths.active, 'utf8'));
    state.tickets = state.tickets.map((entry) => (
      entry.ticket_id === ticket.ticket_id ? { ...entry, deadline_at: deadline } : entry
    ));
    await atomicWriteJson(paths.active, state);

    const response = await invokeClaudeHook({
      hook_event_name: 'PreToolUse',
      project_dir: dir,
      session_id: 'late-parent',
      tool_use_id: 'late-launch',
      tool_name: 'Agent',
      tool_input: {
        subagent_type: action.dispatch.agent_type,
        prompt: launchPrompt(action.dispatch, nonce, ticket),
        model: launchModel(action.dispatch),
      },
    });
    expect(decision(response)).toBe('deny');
  });

  it('binds SubagentStart before first prompt and authorizes only the bound native agent', async () => {
    const dir = await project();
    const { action, ticket } = await startClaude(dir);
    const nonce = launchNonce(action.dispatch);
    expect(nonce, 'writable Claude dispatch must expose a one-time launch nonce').toBeTruthy();
    const prompt = launchPrompt(action.dispatch, nonce, ticket);

    const launch = await invokeClaudeHook({
      hook_event_name: 'PreToolUse',
      project_dir: dir,
      session_id: 'parent-session-1',
      tool_use_id: 'agent-tool-use-1',
      tool_name: 'Agent',
      tool_input: {
        subagent_type: action.dispatch.agent_type,
        prompt,
        model: launchModel(action.dispatch),
        description: 'APE test writer',
      },
    });
    expect(decision(launch)).toBe('allow');

    const started = await invokeClaudeHook({
      hook_event_name: 'SubagentStart',
      project_dir: dir,
      session_id: 'parent-session-1',
      agent_id: 'claude-native-agent-1',
      agent_type: action.dispatch.agent_type,
    });
    const context = started?.hookSpecificOutput?.additionalContext;
    expect(context).toEqual(expect.any(String));
    expect(context.length).toBeGreaterThan(16);
    expect(context).not.toContain(nonce);

    const boundWrite = await invokeClaudeHook({
      hook_event_name: 'PreToolUse',
      project_dir: dir,
      session_id: 'parent-session-1',
      agent_id: 'claude-native-agent-1',
      agent_type: action.dispatch.agent_type,
      tool_name: 'Write',
      tool_input: { file_path: path.join(dir, 'tests', 'new.test.js'), content: 'test' },
    });
    expect(decision(boundWrite)).toBe('allow');

    const forgedWrite = await invokeClaudeHook({
      hook_event_name: 'PreToolUse',
      project_dir: dir,
      session_id: 'parent-session-1',
      agent_id: 'claude-native-agent-forged',
      agent_type: action.dispatch.agent_type,
      tool_name: 'Write',
      tool_input: { file_path: path.join(dir, 'tests', 'new.test.js'), content: 'test' },
      ticket_id: ticket.ticket_id,
    });
    expect(decision(forgedWrite)).toBe('deny');
  });

  it('fails closed on wrong type, nonce replay, and same-session/type collisions', async () => {
    const dir = await project();
    const { action, ticket } = await startClaude(dir);
    const nonce = launchNonce(action.dispatch);
    expect(nonce, 'writable Claude dispatch must expose a one-time launch nonce').toBeTruthy();
    const prompt = launchPrompt(action.dispatch, nonce, ticket);
    const base = {
      hook_event_name: 'PreToolUse',
      project_dir: dir,
      session_id: 'parent-session-collision',
      tool_name: 'Agent',
    };

    const model = launchModel(action.dispatch);

    const wrongType = await invokeClaudeHook({
      ...base,
      tool_use_id: 'agent-tool-use-wrong-type',
      tool_input: { subagent_type: 'ape:implementer', prompt, model },
    });
    expect(decision(wrongType)).toBe('deny');

    const first = await invokeClaudeHook({
      ...base,
      tool_use_id: 'agent-tool-use-first',
      tool_input: { subagent_type: action.dispatch.agent_type, prompt, model },
    });
    expect(decision(first)).toBe('allow');

    const identicalLostResponseRetry = await invokeClaudeHook({
      ...base,
      tool_use_id: 'agent-tool-use-first',
      tool_input: { subagent_type: action.dispatch.agent_type, prompt, model },
    });
    expect(decision(identicalLostResponseRetry)).toBe('allow');

    const replay = await invokeClaudeHook({
      ...base,
      tool_use_id: 'agent-tool-use-replay',
      tool_input: { subagent_type: action.dispatch.agent_type, prompt, model },
    });
    expect(decision(replay)).toBe('deny');

    const collision = await invokeClaudeHook({
      ...base,
      tool_use_id: 'agent-tool-use-collision',
      tool_input: {
        subagent_type: action.dispatch.agent_type,
        prompt: `${prompt}\nAPE_DISPATCH_NONCE=${'x'.repeat(43)}`,
        model,
      },
    });
    expect(decision(collision)).toBe('deny');
  });

  it('requires a one-time receipt capability and makes an identical lost-response retry idempotent', async () => {
    const dir = await project();
    const { action, ticket } = await startClaude(dir);
    const nonce = launchNonce(action.dispatch);
    const prompt = launchPrompt(action.dispatch, nonce, ticket);
    await invokeClaudeHook({
      hook_event_name: 'PreToolUse',
      project_dir: dir,
      session_id: 'receipt-parent',
      tool_use_id: 'receipt-agent-call',
      tool_name: 'Agent',
      tool_input: {
        subagent_type: action.dispatch.agent_type,
        prompt,
        model: launchModel(action.dispatch),
      },
    });
    const started = await invokeClaudeHook({
      hook_event_name: 'SubagentStart',
      project_dir: dir,
      session_id: 'receipt-parent',
      agent_id: 'receipt-agent',
      agent_type: action.dispatch.agent_type,
    });
    const capability = receiptCapability(started);
    expect(capability).toMatch(/^[A-Za-z0-9_-]{32,256}$/);

    await writeFile(path.join(dir, 'tests', 'value.test.js'), 'throw new Error("new red");\n');
    const completedAt = new Date(Date.parse(ticket.issued_at) + 10).toISOString();
    const raw = {
      ticket_id: ticket.ticket_id,
      status: 'passed',
      agent_identity: 'receipt-agent',
      tests: [{
        command: 'node tests/value.test.js',
        passed: false,
        exit_code: 1,
        duration_ms: 1,
      }],
      findings: [],
      evidence: { verdict: 'pass' },
      timing: {
        started_at: ticket.issued_at,
        completed_at: completedAt,
        duration_ms: 10,
      },
    };

    await expect(recordReceipt(dir, raw)).resolves.toMatchObject({ ok: false, rejected: true });
    const first = await recordReceipt(dir, { ...raw, receipt_capability: capability });
    expect(first.ok).toBe(true);

    const retry = await recordReceipt(dir, { ...raw, receipt_capability: capability });
    expect(retry).toMatchObject({
      ok: true,
      receipt: {
        receipt_id: first.receipt.receipt_id,
        receipt_hash: first.receipt.receipt_hash,
      },
    });

    const conflict = await recordReceipt(dir, {
      ...raw,
      receipt_capability: capability,
      evidence: { verdict: 'pass', conflicting_replay: true },
    });
    expect(conflict).toMatchObject({ ok: false, rejected: true });
  });

  it('admits a late receipt from a bound intent through deadline-aware admission and records the overrun', async () => {
    const dir = await project();
    const { action, ticket } = await startClaude(dir);
    const nonce = launchNonce(action.dispatch);
    const prompt = launchPrompt(action.dispatch, nonce, ticket);
    await invokeClaudeHook({
      hook_event_name: 'PreToolUse',
      project_dir: dir,
      session_id: 'late-receipt-parent',
      tool_use_id: 'late-receipt-agent-call',
      tool_name: 'Agent',
      tool_input: {
        subagent_type: action.dispatch.agent_type,
        prompt,
        model: launchModel(action.dispatch),
      },
    });
    const started = await invokeClaudeHook({
      hook_event_name: 'SubagentStart',
      project_dir: dir,
      session_id: 'late-receipt-parent',
      agent_id: 'late-receipt-agent',
      agent_type: action.dispatch.agent_type,
    });
    const capability = receiptCapability(started);
    expect(capability).toMatch(/^[A-Za-z0-9_-]{32,256}$/);

    await writeFile(path.join(dir, 'tests', 'value.test.js'), 'throw new Error("late red");\n');

    // The stage overran its deadline: the BOUND intent and the ticket are both
    // expired before the receipt arrives. Tickets are hash-sealed, so the
    // shortened deadline is resealed and mirrored onto the intent binding.
    const deadline = new Date(Date.now() - 60_000).toISOString();
    const { file, intent } = await readOnlyIntent(dir);
    expect(intent.status).toBe('bound');
    const paths = runtimePaths(dir);
    const state = JSON.parse(await readFile(paths.active, 'utf8'));
    const lateTicket = finalizeTicket({
      ...state.tickets.find((entry) => entry.ticket_id === ticket.ticket_id),
      deadline_at: deadline,
    });
    state.tickets = state.tickets.map((entry) => (
      entry.ticket_id === ticket.ticket_id ? lateTicket : entry
    ));
    await atomicWriteJson(paths.active, state);
    await atomicWriteJson(file, {
      ...intent,
      expires_at: deadline,
      ticket_hash: lateTicket.ticket_hash,
    });

    const completedAt = new Date().toISOString();
    const raw = {
      ticket_id: ticket.ticket_id,
      status: 'passed',
      agent_identity: 'late-receipt-agent',
      tests: [{ command: 'node tests/value.test.js', passed: false, exit_code: 1, duration_ms: 1 }],
      findings: [],
      evidence: { verdict: 'pass' },
      timing: { started_at: ticket.issued_at, completed_at: completedAt, duration_ms: 10 },
    };

    // A late receipt with no binding at all must still fail closed.
    await expect(recordReceipt(dir, raw)).resolves.toMatchObject({ ok: false, rejected: true });

    // The bound capability is admitted: lateness is adjudicated by the
    // tree-consistency deadline admission, not by the binding filter, and the
    // overrun is recorded.
    const first = await recordReceipt(dir, { ...raw, receipt_capability: capability });
    expect(first.ok).toBe(true);
    expect(first.run.deadline_overruns).toEqual([
      expect.objectContaining({ ticket_id: ticket.ticket_id, overrun_ms: expect.any(Number) }),
    ]);
    expect(first.run.deadline_overruns[0].overrun_ms).toBeGreaterThan(0);

    // The completed-record idempotent-retry branch stays reachable after expiry.
    const retry = await recordReceipt(dir, { ...raw, receipt_capability: capability });
    expect(retry).toMatchObject({
      ok: true,
      receipt: {
        receipt_id: first.receipt.receipt_id,
        receipt_hash: first.receipt.receipt_hash,
      },
    });
  });

  it('binds on the capability alone and records the host-attested identity, not the caller guess', async () => {
    const dir = await project();
    const { action, ticket } = await startClaude(dir);
    const nonce = launchNonce(action.dispatch);
    const prompt = launchPrompt(action.dispatch, nonce, ticket);
    await invokeClaudeHook({
      hook_event_name: 'PreToolUse',
      project_dir: dir,
      session_id: 'stamp-parent',
      tool_use_id: 'stamp-agent-call',
      tool_name: 'Agent',
      tool_input: {
        subagent_type: action.dispatch.agent_type,
        prompt,
        model: launchModel(action.dispatch),
      },
    });
    const started = await invokeClaudeHook({
      hook_event_name: 'SubagentStart',
      project_dir: dir,
      session_id: 'stamp-parent',
      agent_id: 'host-attested-agent',
      agent_type: action.dispatch.agent_type,
    });
    const capability = receiptCapability(started);
    expect(capability).toMatch(/^[A-Za-z0-9_-]{32,256}$/);

    await writeFile(path.join(dir, 'tests', 'value.test.js'), 'throw new Error("new red");\n');
    const completedAt = new Date(Date.parse(ticket.issued_at) + 10).toISOString();
    const raw = {
      ticket_id: ticket.ticket_id,
      status: 'passed',
      // A real subagent is never told the host agent id, so it cannot echo a
      // matching identity. Binding must rest on the injected capability, and the
      // runtime must stamp the host-attested id over this deliberately wrong guess.
      agent_identity: 'a-guess-that-does-not-match',
      tests: [{ command: 'node tests/value.test.js', passed: false, exit_code: 1, duration_ms: 1 }],
      findings: [],
      evidence: { verdict: 'pass' },
      timing: { started_at: ticket.issued_at, completed_at: completedAt, duration_ms: 10 },
    };

    // A well-formed but wrong capability must still fail closed.
    const wrongCapability = await recordReceipt(dir, { ...raw, receipt_capability: 'z'.repeat(43) });
    expect(wrongCapability).toMatchObject({ ok: false, rejected: true });

    const bound = await recordReceipt(dir, { ...raw, receipt_capability: capability });
    expect(bound.ok).toBe(true);
    expect(bound.receipt.agent.identity).toBe('host-attested-agent');
  });

  it.each([
    ['Bash', { command: "node -e \"require('fs').writeFileSync('src/value.js', 'pwned')\"" }],
    ['custom_mutator', { path: 'src/value.js', content: 'pwned' }],
  ])('fails closed for an unproven active APE mutation channel: %s', async (toolName, toolInput) => {
    const dir = await project();
    const { action, ticket } = await startClaude(dir);
    const nonce = launchNonce(action.dispatch);
    await invokeClaudeHook({
      hook_event_name: 'PreToolUse',
      project_dir: dir,
      session_id: 'mutation-parent',
      tool_use_id: `launch-${toolName}`,
      tool_name: 'Agent',
      tool_input: {
        subagent_type: action.dispatch.agent_type,
        prompt: launchPrompt(action.dispatch, nonce, ticket),
        model: launchModel(action.dispatch),
      },
    });
    await invokeClaudeHook({
      hook_event_name: 'SubagentStart',
      project_dir: dir,
      session_id: 'mutation-parent',
      agent_id: `mutation-agent-${toolName}`,
      agent_type: action.dispatch.agent_type,
    });

    const response = await invokeClaudeHook({
      hook_event_name: 'PreToolUse',
      project_dir: dir,
      session_id: 'mutation-parent',
      agent_id: `mutation-agent-${toolName}`,
      agent_type: action.dispatch.agent_type,
      tool_name: toolName,
      tool_input: toolInput,
    });
    expect(decision(response)).toBe('deny');
  });

  it('returns neutral output for a bound worker external MCP call', async () => {
    const dir = await project();
    const response = await invokeClaudeHook({
      hook_event_name: 'PreToolUse',
      project_dir: dir,
      session_id: 'external-mcp-parent',
      agent_id: 'external-mcp-worker',
      agent_type: 'ape:implementer',
      tool_name: 'mcp__filesystem__write_file',
      tool_input: { path: 'src/value.js', content: 'host decides' },
    });
    expect(response).toEqual({});
  });

  it('rejects a forged receipt even when its public ticket id and evidence are valid', async () => {
    const dir = await project();
    const { ticket } = await startClaude(dir);
    const completedAt = new Date(Date.parse(ticket.issued_at) + 10).toISOString();

    const forged = await recordReceipt(dir, {
      ticket_id: ticket.ticket_id,
      status: 'passed',
      agent_identity: 'claude-native-agent-forged',
      tests: [{
        command: 'node tests/value.test.js',
        passed: false,
        exit_code: 1,
        duration_ms: 1,
      }],
      findings: [],
      evidence: { verdict: 'pass' },
      timing: {
        started_at: ticket.issued_at,
        completed_at: completedAt,
        duration_ms: 10,
      },
    });

    expect(forged).toMatchObject({ ok: false, rejected: true });
    expect(forged.errors.join(' ')).toMatch(/binding|capability|identity/i);
  });

  it('enforces the ticket model at launch and stamps the request into receipt provenance (F11)', async () => {
    const dir = await project();
    const { action, ticket } = await startClaude(dir);
    const nonce = launchNonce(action.dispatch);
    const prompt = launchPrompt(action.dispatch, nonce, ticket);
    const paths = runtimePaths(dir);
    // The balanced-tier ticket resolves 'sonnet' under the shipped defaults;
    // a fully qualified id of the same family satisfies the documented
    // equivalence, so policy enforcement and full-id forwarding both hold.
    expect(ticket.model.model).toBe('sonnet');

    // Drive launch and binding through the runtime directly: the PreToolUse
    // payload is where the host attests the Agent invocation's `model`
    // parameter, and the intent record must carry it forward as
    // requested_model.
    const state = JSON.parse(await readFile(paths.active, 'utf8'));
    const launch = await launchClaudeIntent(paths, state, {
      session_id: 'model-parent',
      tool_use_id: 'model-agent-call',
      tool_input: {
        subagent_type: action.dispatch.agent_type,
        prompt,
        model: 'claude-sonnet-4-5',
      },
    });
    expect(launch.valid).toBe(true);
    const { intent } = await readOnlyIntent(dir);
    expect(intent.requested_model).toBe('claude-sonnet-4-5');

    const bound = await bindClaudeSubagent(paths, state, {
      session_id: 'model-parent',
      agent_id: 'model-agent',
      agent_type: action.dispatch.agent_type,
    });
    expect(bound.valid).toBe(true);
    const capability = bound.additional_context.match(/APE_RECEIPT_CAPABILITY=([A-Za-z0-9_-]+)/)?.[1];
    expect(capability).toMatch(/^[A-Za-z0-9_-]{32,256}$/);

    await writeFile(path.join(dir, 'tests', 'value.test.js'), 'throw new Error("model red");\n');
    const completedAt = new Date(Date.parse(ticket.issued_at) + 10).toISOString();
    const recorded = await recordReceipt(dir, {
      ticket_id: ticket.ticket_id,
      status: 'passed',
      agent_identity: 'model-agent',
      receipt_capability: capability,
      tests: [{ command: 'node tests/value.test.js', passed: false, exit_code: 1, duration_ms: 1 }],
      findings: [],
      evidence: { verdict: 'pass' },
      timing: { started_at: ticket.issued_at, completed_at: completedAt, duration_ms: 10 },
    });
    expect(recorded.ok).toBe(true);
    // Receipt provenance names what was observed: the host-attested REQUEST.
    // No lifecycle result reports the executed model, so the effective model
    // stays null instead of overstating the PreToolUse observation.
    expect(recorded.receipt.agent).toMatchObject({
      requested_model: 'claude-sonnet-4-5',
      requested_model_attested: true,
      model: null,
      model_attested: false,
    });
  });

  it('denies a launch whose requested model differs from the ticket model (F11)', async () => {
    const dir = await project();
    const { action, ticket } = await startClaude(dir);
    const nonce = launchNonce(action.dispatch);
    const prompt = launchPrompt(action.dispatch, nonce, ticket);
    const paths = runtimePaths(dir);
    expect(ticket.model.model).toBe('sonnet');

    const state = JSON.parse(await readFile(paths.active, 'utf8'));
    const launch = await launchClaudeIntent(paths, state, {
      session_id: 'mismatch-parent',
      tool_use_id: 'mismatch-agent-call',
      tool_input: {
        subagent_type: action.dispatch.agent_type,
        prompt,
        model: 'claude-fable-5',
      },
    });
    expect(launch.valid).toBe(false);
    expect(launch.reason).toMatch(/requested model claude-fable-5 does not satisfy the ticket model sonnet/);
    expect(launch.reason).toMatch(/restate the ticket model on the Agent call — pass model: 'sonnet' or a fully qualified same-family id/);
    // The denied launch consumed nothing: the intent stays prepared and the
    // correct model can still launch with the same capability.
    const { intent } = await readOnlyIntent(dir);
    expect(intent.status).toBe('prepared');
    const retry = await launchClaudeIntent(paths, state, {
      session_id: 'mismatch-parent',
      tool_use_id: 'mismatch-agent-call-2',
      tool_input: { subagent_type: action.dispatch.agent_type, prompt, model: 'sonnet' },
    });
    expect(retry.valid).toBe(true);
  });

  it('denies a launch that omits the Agent model parameter entirely (F11)', async () => {
    const dir = await project();
    const { action, ticket } = await startClaude(dir);
    const nonce = launchNonce(action.dispatch);
    const prompt = launchPrompt(action.dispatch, nonce, ticket);
    const paths = runtimePaths(dir);

    const state = JSON.parse(await readFile(paths.active, 'utf8'));
    // Omitting `model` would let the subagent silently inherit the parent
    // session's model instead of the ticket's resolved tier model.
    const launch = await launchClaudeIntent(paths, state, {
      session_id: 'unattested-parent',
      tool_use_id: 'unattested-agent-call',
      tool_input: { subagent_type: action.dispatch.agent_type, prompt },
    });
    expect(launch.valid).toBe(false);
    expect(launch.reason).toMatch(/requested model \(absent\) does not satisfy the ticket model sonnet/);
    expect(launch.reason).toMatch(/pass model: 'sonnet' or a fully qualified same-family id/);
  });

  it('prunes dead-run and corrupt intent files at the next start, keeping the new run\'s', async () => {
    const dir = await project();
    const paths = runtimePaths(dir);
    const first = await startClaude(dir);
    // Sealing run A voids its intent but deliberately leaves the FILE (the
    // sealed fence and idempotent-retry branch need it while A stays active).
    const aborted = await abortRun(dir, 'converging on a fresh run');
    expect(aborted.ok).toBe(true);
    // A corrupt intent file (torn by a crashed legacy writer) previously
    // failed every readIntents call closed AND could never be cleaned up.
    await writeFile(path.join(paths.dispatchIntents, 'corrupt.json'), '{not json');
    const dead = (await readdir(paths.dispatchIntents)).filter((name) => name.endsWith('.json'));
    expect(dead).toHaveLength(2);

    const second = await startClaude(dir);
    expect(second.result.run.run_id).not.toBe(first.result.run.run_id);
    const names = (await readdir(paths.dispatchIntents)).filter((name) => name.endsWith('.json'));
    expect(names).toHaveLength(1);
    const survivor = JSON.parse(await readFile(path.join(paths.dispatchIntents, names[0]), 'utf8'));
    expect(survivor.run_id).toBe(second.result.run.run_id);
    expect(survivor.status).toBe('prepared');
  });

  it('pruneClaudeIntents keeps every keepRunId record regardless of status', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ape-prune-'));
    cleanups.push(dir);
    const paths = runtimePaths(dir);
    const record = (runId, status, name) => atomicWriteJson(
      path.join(paths.dispatchIntents, `${name}.json`),
      { version: 2, run_id: runId, ticket_id: `${runId}:test:t`, status },
    );
    // Every lifecycle status of the kept run must survive: prepared (not yet
    // launched), expired (voided capability the sealed fence still names),
    // completed (backs the idempotent receipt retry), bound (live flight).
    await record('run-keep', 'prepared', 'keep-prepared');
    await record('run-keep', 'expired', 'keep-expired');
    await record('run-keep', 'completed', 'keep-completed');
    await record('run-keep', 'bound', 'keep-bound');
    await record('run-dead', 'bound', 'dead-bound');
    await writeFile(path.join(paths.dispatchIntents, 'dead-corrupt.json'), 'garbage');
    await writeFile(path.join(paths.dispatchIntents, 'not-an-intent.txt'), 'ignored');

    const pruned = await pruneClaudeIntents(paths, 'run-keep');
    expect(pruned.sort()).toEqual(['dead-bound.json', 'dead-corrupt.json']);
    const names = (await readdir(paths.dispatchIntents)).sort();
    expect(names).toEqual([
      'keep-bound.json',
      'keep-completed.json',
      'keep-expired.json',
      'keep-prepared.json',
      'not-an-intent.txt',
    ]);
  });

  it('pruneClaudeIntents is a no-op when no intents directory exists yet', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ape-prune-empty-'));
    cleanups.push(dir);
    await expect(pruneClaudeIntents(runtimePaths(dir), 'run-any')).resolves.toEqual([]);
  });

  it('abort leaves the sealed run\'s intent files in place — the orphan fence stays armed', async () => {
    const dir = await project();
    const { result } = await startClaude(dir);
    const aborted = await abortRun(dir, 'operator abort');
    expect(aborted.ok).toBe(true);
    // The record is voided (expired) but never deleted while the sealed run
    // remains active.json: resolveSealedClaudeBinding must still name the
    // orphan so its late writes are denied rather than failing open.
    const { intent } = await readOnlyIntent(dir);
    expect(intent.run_id).toBe(result.run.run_id);
    expect(intent.status).toBe('expired');
  });

  it('registers a single Agent-covering PreToolUse policy entry plus synchronous SubagentStart hooks', async () => {
    const manifest = JSON.parse(await readFile(path.join(root, 'hooks', 'claude-hooks.json'), 'utf8'));
    const common = JSON.parse(await readFile(path.join(root, 'hooks', 'hooks.json'), 'utf8'));
    const preTool = common.hooks?.PreToolUse ?? [];
    const subagentStart = common.hooks?.SubagentStart ?? [];
    const isPolicyHook = (hook) =>
      [hook.command ?? '', ...(hook.args ?? [])].join(' ').includes('ape-hooks.bundle');
    const policyEntries = (entries) => entries.filter((entry) => entry.hooks?.some(isPolicyHook));

    // The single policy matcher itself covers Agent launches and its host alias
    // Task, so a separate identical Agent entry would be redundant (the host
    // deduplicates identical handlers) — exactly one POLICY registration must
    // remain [audit cosmetic note, orig 47]. The matcher VALUE (never '*'; it
    // covers the whole enforcement set) is owned by
    // runtime-v2-hook-matcher-coverage.test.js. Advisory LARP entries
    // (ape-larp.bundle) are additive: they must be async and must never
    // re-register the policy bundle.
    expect(policyEntries(preTool)).toHaveLength(1);
    const [prePolicy] = policyEntries(preTool);
    const coversDispatchTool = (matcher, tool) =>
      matcher == null || matcher === '*' || new RegExp(`^(?:${matcher})$`).test(tool);
    for (const tool of ['Agent', 'Task']) {
      expect(coversDispatchTool(prePolicy.matcher, tool), `PreToolUse policy matcher must cover ${tool}`).toBe(true);
    }
    expect(subagentStart).toHaveLength(1);
    expect(subagentStart[0].hooks?.[0]).toMatchObject({ type: 'command' });
    expect(policyEntries(manifest.hooks?.PreToolUse ?? [])).toHaveLength(0);
    expect(policyEntries(manifest.hooks?.SubagentStart ?? [])).toHaveLength(0);
    expect(policyEntries(manifest.hooks?.PostToolUseFailure ?? [])).toHaveLength(1);
    expect(policyEntries(common.hooks?.SubagentStop ?? [])).toHaveLength(1);
    expect(policyEntries(manifest.hooks?.SubagentStop ?? [])).toHaveLength(0);
    for (const entries of Object.values(manifest.hooks ?? {})) {
      for (const entry of entries) {
        for (const hook of entry.hooks ?? []) {
          if (isPolicyHook(hook)) continue;
          expect((hook.args ?? []).join(' ')).toContain('ape-larp.bundle');
          expect(hook.async).toBe(true);
        }
      }
    }
  });
});

describe('APE v2 standard Claude Agent dispatch through the shipped hook bundle', () => {
  // The freshness test only byte-compares dist/ against a rebuild; the suite
  // above now runs bin/ape-hook.mjs so lib/runtime edits show up under a
  // targeted run. This one case still EXECUTES the shipped ape-hooks.bundle.mjs
  // that hooks.json actually wires for the dispatch surface, so a packaging
  // defect the byte comparison cannot see (broken entry wiring, a mis-resolved
  // import) still fails a behavioral test.
  it('binds a launched native agent and authorizes its claimed write', async () => {
    const dir = await project();
    const { action, ticket } = await startClaude(dir);
    const nonce = launchNonce(action.dispatch);
    const prompt = launchPrompt(action.dispatch, nonce, ticket);

    const launch = await invokeClaudeHook({
      hook_event_name: 'PreToolUse',
      project_dir: dir,
      session_id: 'bundle-smoke-parent',
      tool_use_id: 'bundle-smoke-launch',
      tool_name: 'Agent',
      tool_input: {
        subagent_type: action.dispatch.agent_type,
        prompt,
        model: launchModel(action.dispatch),
      },
    }, hookBundle);
    expect(decision(launch)).toBe('allow');

    await invokeClaudeHook({
      hook_event_name: 'SubagentStart',
      project_dir: dir,
      session_id: 'bundle-smoke-parent',
      agent_id: 'bundle-smoke-agent',
      agent_type: action.dispatch.agent_type,
    }, hookBundle);

    const boundWrite = await invokeClaudeHook({
      hook_event_name: 'PreToolUse',
      project_dir: dir,
      session_id: 'bundle-smoke-parent',
      agent_id: 'bundle-smoke-agent',
      agent_type: action.dispatch.agent_type,
      tool_name: 'Write',
      tool_input: { file_path: path.join(dir, 'tests', 'new.test.js'), content: 'test' },
    }, hookBundle);
    expect(decision(boundWrite)).toBe('allow');

    const forgedWrite = await invokeClaudeHook({
      hook_event_name: 'PreToolUse',
      project_dir: dir,
      session_id: 'bundle-smoke-parent',
      agent_id: 'bundle-smoke-agent-forged',
      agent_type: action.dispatch.agent_type,
      tool_name: 'Write',
      tool_input: { file_path: path.join(dir, 'tests', 'new.test.js'), content: 'test' },
      ticket_id: ticket.ticket_id,
    }, hookBundle);
    expect(decision(forgedWrite)).toBe('deny');
  });
});
