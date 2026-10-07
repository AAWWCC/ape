import { gitFixtureEnv } from '../test-support/git-fixtures.js';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nativeDispatch } from '../lib/runtime/adapters.js';
import { prepareCodexIntent, observeCodexSubagentStop } from '../lib/runtime/claude-dispatch.js';
import { acknowledgeBindingProbe, consumeBindingProbe, observeBindingProbeStop, prepareBindingProbe } from '../lib/runtime/binding-probe.js';
import { currentTreeSha } from '../lib/runtime/git.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { finalizeTicket } from '../lib/runtime/schemas.js';
import { receiptOutputSchemaForTicket } from '../lib/runtime/receipt-validator.js';
import { nextRun, recordReceipt, statusRun, validateReceiptForDispatch } from '../lib/runtime/service.js';
import { emptyOrchestrationTelemetry } from '../lib/runtime/orchestration-telemetry.js';
import { DEFAULT_CONFIG } from '../lib/runtime/config.js';
import { executionPolicySnapshot } from '../lib/runtime/pipeline-limits.js';
import { sha256 } from '../lib/runtime/canonical.js';
import * as storage from '../lib/runtime/storage.js';
import { invokeCodexHook } from './codex-native-test-helper.js';

// This is an adapter simulation, NOT live-host slot certification. A disposable
// host owns a finite occupancy map and retains history. APE's real launch,
// bootstrap, receipt validator/recorder and stop observer establish ownership.
// The proposed internal adapter seam is not a public MCP operation and must
// never be selectable through parent-supplied run arguments or metadata.
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const roots = [];
const digest = (text) => createHash('sha256').update(text).digest('hex');
const git = (cwd, ...args) => execFileSync('git', args, { env: gitFixtureEnv(), cwd, encoding: 'utf8' }).trim();
const key = (identity) => JSON.stringify(identity);

// Defer loading so missing behavior produces collected assertion failures,
// rather than an import/zero-collection failure during the red-first stage.
async function lifecycle() {
  const location = new URL('../lib/runtime/native-worker-lifecycle.js', import.meta.url).href;
  const api = await import(/* @vite-ignore */ location).catch((error) => {
    if (error.code === 'ERR_MODULE_NOT_FOUND' || /Failed to load url|Cannot find module/.test(error.message)) return {};
    throw error;
  });
  expect(api.retireNativeWorker, 'the internal identity-conditional retirement boundary is required').toBeTypeOf('function');
  return api;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function simulatedHost(capacity = 2) {
  const occupants = new Map();
  const history = new Map();
  const results = new Map();
  const calls = [];
  let peak = 0;
  const adapter = {
    contract: {
      support: 'supported', operation: 'fixture.releaseStoppedGeneration',
      conditional_on_stopped: true, preserves_history: true,
      exact_identity: true, idempotent: true, query_supported: true,
      provenance: 'synthetic-test-adapter',
    },
    async release({ identity, operation_id }) {
      calls.push({ identity: structuredClone(identity), operation_id });
      await adapter.beforeRelease?.({ identity, operation_id });
      if (results.has(operation_id)) return structuredClone(results.get(operation_id));
      const worker = occupants.get(key(identity));
      if (!worker || worker.state !== 'stopped' || adapter.refuse) {
        return { status: 'refused', identity, operation_id, reason: 'exact worker is active, absent, or release was refused' };
      }
      occupants.delete(key(identity));
      const result = { status: 'released', identity: structuredClone(identity), operation_id,
        evidence: { source: 'synthetic-test-adapter', preserves_history: true } };
      results.set(operation_id, result);
      if (adapter.loseResponse) throw new Error('synthetic lost response after conditional release');
      return structuredClone(result);
    },
    async query({ identity, operation_id }) {
      const result = results.get(operation_id);
      return result && key(result.identity) === key(identity) ? structuredClone(result) : null;
    },
  };
  return {
    adapter, occupants, history, results, calls, get peak() { return peak; },
    add(identity) {
      if (occupants.size >= capacity) throw new Error('synthetic retained-worker capacity reached');
      const worker = { identity: structuredClone(identity), state: 'active' };
      occupants.set(key(identity), worker); history.set(key(identity), worker);
      peak = Math.max(peak, occupants.size);
    },
    stop(identity) { occupants.get(key(identity)).state = 'stopped'; },
    resume(identity) { occupants.get(key(identity)).state = 'active'; },
  };
}

async function fixture({ lane = 'fast' } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'ape-retirement-simulation-'));
  roots.push(root);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Synthetic retirement');
  git(root, 'config', 'user.email', 'retirement@example.test');
  await writeFile(path.join(root, 'value.js'), 'export const value = 1;\n');
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'synthetic baseline');
  git(root, 'switch', '-qc', 'codex/retirement-simulation');
  const paths = runtimePaths(root);
  await storage.atomicWriteJson(paths.config, { shipping: { auto_merge: false } });
  const tree = await currentTreeSha(root);
  const state = {
    schema_version: '2.0.0', run_id: 'run-retirement-simulation', status: 'running',
    stage: 'build', mode: 'phase', lane, host: 'codex', binding_protocol: 'native-v1',
    objective: 'Exercise synthetic native lifecycle boundaries',
    claimed_paths: ['value.js'], test_paths: [], requirements: [], risk_triggers: [],
    tickets: [], receipts: [], expired_tickets: [], attempts: {}, remediation_cycles: 0,
    tree_sha: tree, branch: 'codex/retirement-simulation', base_branch: 'main',
    base_commit_sha: git(root, 'rev-parse', 'HEAD'),
    execution_policy: executionPolicySnapshot(DEFAULT_CONFIG),
    orchestration: emptyOrchestrationTelemetry(),
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  };
  await storage.atomicWriteJson(paths.active, state);
  return { root, paths, state, tree, ordinal: 0 };
}

async function bindWorker(value, role = 'implementer', { launchOnly = false } = {}) {
  const ordinal = ++value.ordinal;
  const state = await storage.readJson(value.paths.active);
  expect(['completed', 'aborted', 'blocked']).not.toContain(state.status);
  const stage = { planner: 'plan', test_writer: 'test', implementer: 'build', reviewer: 'review' }[role];
  const base = {
    schema_version: '2.0.0', ticket_id: `${state.run_id}:${stage}:${ordinal}`,
    run_id: state.run_id, stage_id: stage, parallel_group: null, role,
    objective: state.objective, claimed_paths: ['value.js'], test_paths: [], risk_triggers: [],
    model_tier: 'balanced', model: { model: 'gpt-5.6-terra', reasoning_effort: 'medium' },
    deadline_at: null, execution_limits: state.execution_policy.limits,
    required_checks: [], writable: ['implementer', 'test_writer'].includes(role),
    base_tree_sha: value.tree, parent_hash: null, attempt: 1, issued_at: new Date().toISOString(),
    receipt_contract_version: 1,
    capability_manifest: { allowed_evidence_commands: ['git diff --check'], verification_profiles: [] },
  };
  const output = receiptOutputSchemaForTicket(base);
  const ticket = finalizeTicket({ ...base, output_schema: output, capability_manifest: {
    version: 1, config_hash: 'c'.repeat(64), required_capabilities: [], command_profiles: [],
    allowed_evidence_commands: ['git diff --check'], verification_profiles: [],
    objective_hash: sha256(base.objective), preflight_hash: null, risk_triggers: [], design_assurance_required: false,
    receipt_schema: { ref: 'ticket.output_schema', hash: sha256(output) },
    field_bounds: { corrections_per_validation: 20 },
    byte_budgets: { candidate_plan_utf8_bytes: 16_384, preflight_artifact_utf8_bytes: 65_536, mcp_projection_utf8_bytes: 48_000 },
  } });
  // The harness issues tickets, but never writes a bound identity or accepted
  // receipt. Those are produced only by the normal APE runtime boundaries.
  state.stage = stage; state.status = 'running'; state.tickets.push(ticket);
  await storage.atomicWriteJson(value.paths.active, state);
  await storage.atomicWriteJson(path.join(value.paths.runs, `${state.run_id}.json`), state);
  await storage.atomicWriteJson(path.join(value.paths.tickets, `${ticket.ticket_id.replaceAll(':', '_')}.json`), ticket);
  const intent = await prepareCodexIntent(value.paths, ticket, ticket.writable ? 'worker' : 'explorer', { bootstrap_protocol: 1 });
  const dispatch = nativeDispatch('codex', ticket, intent);
  const hostIdentity = { session_id: 'same-synthetic-host-session', turn_id: `child-${ordinal}`,
    agent_id: `worker-${ordinal}`, agent_type: 'default', model: ticket.model.model };
  const launch = await invokeCodexHook(ROOT, {
    hook_event_name: 'PreToolUse', project_dir: value.root,
    session_id: hostIdentity.session_id, turn_id: `parent-${ordinal}`, tool_use_id: `spawn-${ordinal}`,
    tool_name: 'collaborationspawn_agent', tool_input: dispatch.spawn_args,
  });
  expect(launch.hookSpecificOutput?.permissionDecision).not.toBe('deny');
  const file = path.join(value.paths.dispatchIntents, `${digest(ticket.ticket_id)}.json`);
  if (launchOnly) return { value, ticket, file, hostIdentity, dispatch };
  await invokeCodexHook(ROOT, { hook_event_name: 'SubagentStart', project_dir: value.root, ...hostIdentity });
  const bound = await invokeCodexHook(ROOT, {
    hook_event_name: 'PreToolUse', project_dir: value.root, ...hostIdentity,
    tool_use_id: `bind-${ordinal}`, tool_name: 'mcp__ape__ape_bind', tool_input: dispatch.bootstrap_args,
  });
  const capability = bound.hookSpecificOutput?.additionalContext?.match(/APE_RECEIPT_CAPABILITY=([A-Za-z0-9_-]+)/)?.[1];
  expect(capability).toBeTruthy();
  const record = await storage.readJson(file);
  expect(record.status).toBe('bound');
  const identity = { host: 'codex', run_id: ticket.run_id, ticket_id: ticket.ticket_id,
    ticket_hash: ticket.ticket_hash, session_id: record.bound_session_id,
    agent_id: record.bound_agent_id, launch_generation: record.launch_generation };
  return { value, ticket, file, capability, identity, hostIdentity, dispatch };
}

function receipt(worker) {
  const evidence = { summary: 'Synthetic lifecycle fixture receipt' };
  if (worker.ticket.role === 'reviewer') evidence.verdict = 'pass';
  if (worker.ticket.role === 'planner') evidence.candidate_plan = {
    version: 1, requirements: [{ id: 'R1', requirement: 'Synthetic lifecycle behavior', workstreams: ['W1'] }],
    workstreams: [{ id: 'W1', outcome: 'Exercise synthetic behavior', paths: [{ path: 'value.js', action: 'modify' }],
      steps: ['Keep fixture behavior unchanged'], acceptance: ['The fixture remains valid'], evidence_commands: ['git diff --check'] }],
    risks: [], non_goals: [],
  };
  return { ticket_id: worker.ticket.ticket_id, status: 'passed', tests: [], findings: [], evidence,
    receipt_capability: worker.capability };
}

async function accept(worker) {
  const draft = receipt(worker);
  const validation = await validateReceiptForDispatch(worker.value.root, draft);
  expect(validation.valid, JSON.stringify(validation)).toBe(true);
  const accepted = await recordReceipt(worker.value.root, draft);
  expect(accepted.ok, JSON.stringify(accepted.errors ?? accepted)).toBe(true);
  return accepted;
}

async function stop(worker, host) {
  const state = await storage.readJson(worker.value.paths.active);
  const observed = await observeCodexSubagentStop(worker.value.paths, state, worker.hostIdentity);
  expect(observed.observed).toBe(true);
  host.stop(worker.identity);
}

async function preserved(worker, before) {
  const after = await storage.readJson(worker.file);
  for (const field of ['ticket_hash', 'capability_hash', 'bootstrap_capability_hash', 'bound_agent_id',
    'bound_session_id', 'launch_generation', 'launch_generations', 'physical_worker_dispatches',
    'receipt_id', 'receipt_hash', 'receipt_input_hash', 'receipt_validation']) {
    expect(after[field], field).toEqual(before[field]);
  }
  expect(await storage.readJson(path.join(worker.value.paths.tickets, `${worker.ticket.ticket_id.replaceAll(':', '_')}.json`))).toEqual(worker.ticket);
}

async function proofFiles(directory) {
  const result = {};
  for (const entry of await readdir(directory, { withFileTypes: true }).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) Object.assign(result, await proofFiles(file));
    else result[file] = await readFile(file, 'utf8');
  }
  return result;
}

async function probeFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'ape-retirement-probe-'));
  roots.push(root);
  const paths = runtimePaths(root);
  await mkdir(paths.runtime, { recursive: true });
  const action = await prepareBindingProbe(paths, { host: 'codex', model: { model: 'gpt-5.6-terra', reasoning_effort: 'medium' } });
  const hostIdentity = { session_id: 'probe-synthetic-session', turn_id: 'probe-child-turn',
    agent_id: 'probe-synthetic-worker', agent_type: 'default', model: action.dispatch.model.model };
  await invokeCodexHook(ROOT, { hook_event_name: 'PreToolUse', project_dir: root,
    session_id: hostIdentity.session_id, turn_id: 'probe-parent-turn', tool_use_id: 'probe-spawn',
    tool_name: 'collaborationspawn_agent', tool_input: action.dispatch.spawn_args });
  await invokeCodexHook(ROOT, { hook_event_name: 'SubagentStart', project_dir: root, ...hostIdentity });
  const binding = await invokeCodexHook(ROOT, { hook_event_name: 'PreToolUse', project_dir: root,
    ...hostIdentity, tool_use_id: 'probe-bind', tool_name: 'mcp__ape__ape_bind', tool_input: action.dispatch.bootstrap_args });
  const capability = binding.hookSpecificOutput?.additionalContext?.match(/APE_PROBE_CAPABILITY=([A-Za-z0-9_-]+)/)?.[1];
  expect(capability).toBeTruthy();
  const probe = await storage.readJson(paths.bindingProbe);
  const file = path.join(paths.dispatchIntents, `${digest(probe.ticket_id)}.json`);
  const intent = await storage.readJson(file);
  const identity = { host: 'codex', run_id: probe.probe_id, probe_id: probe.probe_id,
    ticket_id: probe.ticket_id, ticket_hash: probe.ticket_hash, session_id: probe.bound_session_id,
    agent_id: probe.bound_agent_id, launch_generation: intent.launch_generation };
  return { root, paths, action, identity, hostIdentity, capability, file };
}

describe('native worker retirement adapter simulation (not live certification)', () => {
  it('preserves a launch rejected by host capacity and offers bounded status/wait/resume recovery', async () => {
    const value = await fixture();
    // The host can reject after PreToolUse observed the launch. There is no
    // host-failure hook proving the child absent, so keep the exact generation.
    const worker = await bindWorker(value, 'implementer', { launchOnly: true });
    const before = await storage.readJson(worker.file);
    expect(before.status).toBe('launched');
    const status = await statusRun(value.root);
    expect(status.native_worker_lifecycle).toMatchObject({
      release: { support: 'unsupported' },
      capacity: { effective_launch_limit: null, retained_thread_limit: null },
    });
    expect(status.native_worker_lifecycle.next_action).toBeTruthy();
    expect(JSON.stringify(status.native_worker_lifecycle.next_action)).toMatch(/status|wait|resume/i);
    expect(JSON.stringify(status.native_worker_lifecycle.next_action)).not.toMatch(/archive|reset|abort|fresh.chat/i);
    const next = await nextRun(value.root);
    expect((next.actions ?? []).filter((action) => action.type === 'dispatch_agent')).toHaveLength(0);
    const after = await storage.readJson(worker.file);
    for (const field of ['launch_generation', 'launch_generations', 'bootstrap_capability_hash', 'physical_worker_dispatches', 'ticket_hash']) {
      expect(after[field], field).toEqual(before[field]);
    }
    expect((await storage.readJson(value.paths.active)).tickets).toHaveLength(1);
  }, 30_000);

  it('sequentially binds planning, test, implementation and review workers beyond simultaneous capacity in one session', async () => {
    const api = await lifecycle();
    // Full-lane planning has a successor. A fast-lane planning receipt seals
    // the run, whose immutable history must never be reopened by this harness.
    const value = await fixture({ lane: 'full' });
    const host = simulatedHost(2);
    const workers = [];
    for (const role of ['planner', 'test_writer', 'implementer', 'reviewer']) {
      const worker = await bindWorker(value, role); workers.push(worker); host.add(worker.identity);
      await accept(worker); await stop(worker, host);
      const before = await storage.readJson(worker.file);
      const released = await api.retireNativeWorker(value.paths, worker.identity, { adapter: host.adapter });
      expect(released).toMatchObject({ status: 'released', identity: worker.identity });
      expect(released.operation_id).toBeTruthy();
      await preserved(worker, before);
      expect(host.occupants.size).toBe(0);
    }
    expect(host.peak).toBeLessThanOrEqual(2);
    expect(host.history.size).toBe(4);
    expect(host.calls).toHaveLength(4);
    const records = await Promise.all(workers.map((worker) => storage.readJson(worker.file)));
    expect(records.reduce((sum, record) => sum + record.physical_worker_dispatches, 0)).toBe(4);
    expect((await storage.readJson(value.paths.active)).receipts).toHaveLength(4);
  }, 60_000);

  it.each(['missing', 'unsupported', 'unconditional', 'destructive', 'unreconcilable'])('never calls a %s host release operation', async (kind) => {
    const api = await lifecycle(); const value = await fixture(); const worker = await bindWorker(value);
    const host = simulatedHost(); host.add(worker.identity); await accept(worker); await stop(worker, host);
    const before = await storage.readJson(worker.file);
    const adapter = kind === 'missing' ? undefined : host.adapter;
    if (kind === 'unsupported') adapter.contract.support = 'unsupported';
    if (kind === 'unconditional') adapter.contract.conditional_on_stopped = false;
    if (kind === 'destructive') adapter.contract.preserves_history = false;
    if (kind === 'unreconcilable') { adapter.contract.idempotent = false; adapter.contract.query_supported = false; delete adapter.query; }
    const result = await api.retireNativeWorker(value.paths, worker.identity, { adapter });
    expect(result.status).toBe('unsupported'); expect(host.calls).toHaveLength(0);
    expect(result.next_action).toBeTruthy();
    await preserved(worker, before);
  }, 30_000);

  it.each(['stop-only', 'validated-only', 'accepted-active', 'correction-pending'])('does not retire a worker with %s evidence', async (phase) => {
    const api = await lifecycle(); const value = await fixture(); const worker = await bindWorker(value);
    const host = simulatedHost(); host.add(worker.identity);
    if (phase === 'accepted-active') await accept(worker);
    else {
      if (phase === 'validated-only') expect((await validateReceiptForDispatch(value.root, receipt(worker))).valid).toBe(true);
      if (phase === 'correction-pending') expect((await validateReceiptForDispatch(value.root, { ...receipt(worker), status: 'invalid' })).valid).toBe(false);
      await stop(worker, host);
    }
    const result = await api.retireNativeWorker(value.paths, worker.identity, { adapter: host.adapter });
    expect(result.status).toBe('ineligible'); expect(host.calls).toHaveLength(0);
    expect(host.occupants.size).toBe(1);
  }, 30_000);

  it.each(['host', 'session_id', 'agent_id', 'ticket_id', 'ticket_hash', 'launch_generation'])('rejects a mismatched %s before the host sink', async (field) => {
    const api = await lifecycle(); const value = await fixture(); const worker = await bindWorker(value);
    const host = simulatedHost(); host.add(worker.identity); await accept(worker); await stop(worker, host);
    const identity = { ...worker.identity, [field]: field === 'launch_generation' ? worker.identity[field] + 1 : 'wrong-identity' };
    const result = await api.retireNativeWorker(value.paths, identity, { adapter: host.adapter });
    expect(result.status).toBe('ineligible'); expect(host.calls).toHaveLength(0);
  }, 30_000);

  it('requires durable exact receipt acceptance even when the completed intent retains receipt identifiers', async () => {
    const api = await lifecycle(); const value = await fixture(); const worker = await bindWorker(value);
    const host = simulatedHost(); host.add(worker.identity); await accept(worker); await stop(worker, host);
    const state = await storage.readJson(value.paths.active);
    // Synthetic corruption: an intent completion cannot substitute for the
    // durable receipt chain. Do not destroy or mutate a real checkout ledger.
    state.receipts[0].receipt_hash = '0'.repeat(64);
    await storage.atomicWriteJson(value.paths.active, state);
    expect((await api.retireNativeWorker(value.paths, worker.identity, { adapter: host.adapter })).status).toBe('ineligible');
    expect(host.calls).toHaveLength(0);
  }, 30_000);

  it('serializes concurrent cleanup and makes repeated cleanup after receipt handoff idempotent', async () => {
    const api = await lifecycle(); const value = await fixture(); const worker = await bindWorker(value);
    const host = simulatedHost(); host.add(worker.identity); await accept(worker); await stop(worker, host);
    const before = await storage.readJson(worker.file);
    host.adapter.beforeRelease = async ({ operation_id }) => {
      // Contending locks create and remove temporary files. Reading those
      // unrelated files races their cleanup and can make this adapter throw.
      const intent = await storage.readJson(path.join(value.paths.runtime, 'native-worker-retirement', `${operation_id}.json`));
      expect(intent, 'operation intent must be durable before the external sink').toMatchObject({
        status: 'unconfirmed', operation_id, identity: worker.identity,
      });
    };
    const results = await Promise.all(Array.from({ length: 3 }, () => api.retireNativeWorker(value.paths, worker.identity, { adapter: host.adapter })));
    expect(results.map((result) => result.status)).toEqual(['released', 'released', 'released']);
    expect(new Set(results.map((result) => result.operation_id)).size).toBe(1);
    expect(host.calls).toHaveLength(1);
    expect((await api.retireNativeWorker(value.paths, worker.identity, { adapter: host.adapter })).operation_id).toBe(results[0].operation_id);
    expect(host.calls).toHaveLength(1); await preserved(worker, before);
  }, 30_000);

  it('retains evidence when the host refuses cleanup', async () => {
    const api = await lifecycle(); const value = await fixture(); const worker = await bindWorker(value);
    const host = simulatedHost(); host.add(worker.identity); await accept(worker); await stop(worker, host);
    host.adapter.refuse = true;
    const before = await storage.readJson(worker.file);
    const result = await api.retireNativeWorker(value.paths, worker.identity, { adapter: host.adapter });
    expect(result.status).toBe('refused'); expect(host.occupants.size).toBe(1);
    expect(host.history.size).toBe(1); expect(result.next_action).toBeTruthy(); await preserved(worker, before);
  }, 30_000);

  it('refuses a host resume after the final local eligibility check, at the conditional sink', async () => {
    const api = await lifecycle(); const value = await fixture(); const worker = await bindWorker(value);
    const host = simulatedHost(); host.add(worker.identity); await accept(worker); await stop(worker, host);
    host.adapter.beforeRelease = async () => { host.resume(worker.identity); };
    const result = await api.retireNativeWorker(value.paths, worker.identity, { adapter: host.adapter });
    expect(result.status).toBe('refused'); expect(host.calls).toHaveLength(1);
    expect(host.occupants.get(key(worker.identity)).state).toBe('active');
  }, 30_000);

  it.each(['generic-success', 'wrong-identity', 'wrong-operation'])('rejects %s as host release confirmation', async (kind) => {
    const api = await lifecycle(); const value = await fixture(); const worker = await bindWorker(value);
    const host = simulatedHost(); host.add(worker.identity); await accept(worker); await stop(worker, host);
    host.adapter.release = async ({ identity, operation_id }) => kind === 'generic-success' ? { ok: true } : ({
      status: 'released', operation_id: kind === 'wrong-operation' ? 'another-operation' : operation_id,
      identity: kind === 'wrong-identity' ? { ...identity, agent_id: 'another-worker' } : identity,
      evidence: { source: 'synthetic-test-adapter', preserves_history: true },
    });
    const result = await api.retireNativeWorker(value.paths, worker.identity, { adapter: host.adapter });
    expect(result.status).not.toBe('released'); expect(host.occupants.size).toBe(1);
  }, 30_000);

  it('keeps legacy records with missing generation proof readable but ineligible for release', async () => {
    const api = await lifecycle(); const value = await fixture(); const worker = await bindWorker(value);
    const host = simulatedHost(); host.add(worker.identity); await accept(worker); await stop(worker, host);
    const legacy = await storage.readJson(worker.file);
    delete legacy.launch_generation; delete legacy.launch_generations;
    await storage.atomicWriteJson(worker.file, legacy);
    const result = await api.retireNativeWorker(value.paths, worker.identity, { adapter: host.adapter });
    expect(result.status).toBe('ineligible'); expect(host.calls).toHaveLength(0);
    expect(await storage.readJson(worker.file)).toEqual(legacy);
  }, 30_000);

  it.each(['ack-only', 'stop-only', 'ack-and-stop'])('requires independent probe acknowledgement and stop evidence: %s', async (phase) => {
    const api = await lifecycle(); const value = await probeFixture();
    const host = simulatedHost(); host.add(value.identity);
    if (phase !== 'stop-only') await acknowledgeBindingProbe(value.paths, {
      probe_id: value.action.probe.probe_id, probe_capability: value.capability,
    });
    if (phase !== 'ack-only') {
      expect((await observeBindingProbeStop(value.paths, value.hostIdentity)).matched).toBe(true);
      host.stop(value.identity);
    }
    const before = await storage.readJson(value.file);
    const probeBefore = await storage.readJson(value.paths.bindingProbe);
    const quarantineBefore = await proofFiles(value.paths.bindingProbeQuarantine);
    const fallbackBefore = await proofFiles(value.paths.bindingProbeQuarantineFallback);
    const result = await api.retireNativeWorker(value.paths, value.identity, { adapter: host.adapter });
    expect(result.status).toBe(phase === 'ack-and-stop' ? 'released' : 'ineligible');
    expect(host.calls).toHaveLength(phase === 'ack-and-stop' ? 1 : 0);
    const after = await storage.readJson(value.file);
    for (const field of ['ticket_hash', 'capability_hash', 'bootstrap_capability_hash', 'launch_generation', 'launch_generations', 'bound_agent_id']) {
      expect(after[field]).toEqual(before[field]);
    }
    const probeAfter = await storage.readJson(value.paths.bindingProbe);
    for (const field of ['probe_id', 'ticket_id', 'ticket_hash', 'status', 'completed_at', 'canary_stopped_at', 'capability_hash']) {
      expect(probeAfter[field]).toEqual(probeBefore[field]);
    }
    expect(await proofFiles(value.paths.bindingProbeQuarantine)).toEqual(quarantineBefore);
    expect(await proofFiles(value.paths.bindingProbeQuarantineFallback)).toEqual(fallbackBefore);
    if (phase === 'ack-and-stop') {
      expect(Object.keys(quarantineBefore).length).toBeGreaterThan(0);
      const replay = await api.retireNativeWorker(value.paths, value.identity, { adapter: host.adapter });
      expect(replay.operation_id).toBe(result.operation_id); expect(host.calls).toHaveLength(1);
      const denied = await invokeCodexHook(ROOT, { hook_event_name: 'PreToolUse', project_dir: value.root,
        ...value.hostIdentity, tool_name: 'Read', tool_input: { file_path: 'note.md' } });
      expect(denied.hookSpecificOutput?.permissionDecision ?? denied.decision).toMatch(/deny|block/);
    }
  }, 30_000);

  it.each(['completed', 'consumed'])('rejects redirected %s probe evidence before the host sink', async (status) => {
    const api = await lifecycle(); const value = await probeFixture();
    const host = simulatedHost(); host.add(value.identity);
    expect((await acknowledgeBindingProbe(value.paths, {
      probe_id: value.action.probe.probe_id, probe_capability: value.capability,
    })).status).toBe('completed');
    expect((await observeBindingProbeStop(value.paths, value.hostIdentity)).matched).toBe(true);
    host.stop(value.identity);
    if (status === 'consumed') expect((await consumeBindingProbe(value.paths, 'codex')).ok).toBe(true);
    const probe = await readFile(value.paths.bindingProbe, 'utf8');
    const intentBefore = await storage.readJson(value.file);
    const quarantineBefore = await proofFiles(value.paths.bindingProbeQuarantine);
    const outside = await mkdtemp(path.join(tmpdir(), 'ape-probe-evidence-outside-')); roots.push(outside);
    const external = path.join(outside, 'probe.json');
    await writeFile(external, probe);
    await rm(value.paths.bindingProbe);
    await symlink(external, value.paths.bindingProbe);
    // Even byte-identical acknowledged evidence must reside in the ordinary
    // canonical probe artifact; following a redirected file grants no authority.
    const result = await api.retireNativeWorker(value.paths, value.identity, { adapter: host.adapter })
      .catch((error) => ({ status: 'rejected', error: error.message }));
    expect(result.status).not.toBe('released');
    expect(host.calls).toHaveLength(0);
    expect(host.occupants.size).toBe(1);
    expect(await readFile(external, 'utf8')).toBe(probe);
    expect(await storage.readJson(value.file)).toEqual(intentBefore);
    expect(await proofFiles(value.paths.bindingProbeQuarantine)).toEqual(quarantineBefore);
  }, 30_000);

  it.each(['unacknowledged-completion', 'completed-transition-gap', 'consumed-transition-gap'])('rejects malformed probe authority: %s', async (fault) => {
    const api = await lifecycle(); const value = await probeFixture();
    const host = simulatedHost(); host.add(value.identity);
    if (fault !== 'unacknowledged-completion') expect((await acknowledgeBindingProbe(value.paths, {
      probe_id: value.action.probe.probe_id, probe_capability: value.capability,
    })).status).toBe('completed');
    expect((await observeBindingProbeStop(value.paths, value.hostIdentity)).matched).toBe(true);
    host.stop(value.identity);
    if (fault === 'consumed-transition-gap') expect((await consumeBindingProbe(value.paths, 'codex')).ok).toBe(true);
    const forged = await storage.readJson(value.paths.bindingProbe);
    if (fault === 'unacknowledged-completion') {
      expect(forged.status).toBe('bound');
      forged.status = 'completed';
      forged.completed_at = forged.canary_stopped_at;
    } else {
      forged.transitions = forged.transitions.filter((transition) => transition.status !== 'completed');
    }
    // Corrupt only a disposable probe record, leaving the real bind and stop
    // proofs intact. Completion fields cannot replace a valid acknowledgement chain.
    await storage.atomicWriteJson(value.paths.bindingProbe, forged);
    const intentBefore = await storage.readJson(value.file);
    const quarantineBefore = await proofFiles(value.paths.bindingProbeQuarantine);
    const result = await api.retireNativeWorker(value.paths, value.identity, { adapter: host.adapter })
      .catch((error) => ({ status: 'rejected', error: error.message }));
    expect(result.status).not.toBe('released');
    expect(host.calls).toHaveLength(0);
    expect(host.occupants.size).toBe(1);
    expect(await storage.readJson(value.paths.bindingProbe)).toEqual(forged);
    expect(await storage.readJson(value.file)).toEqual(intentBefore);
    expect(await proofFiles(value.paths.bindingProbeQuarantine)).toEqual(quarantineBefore);
  }, 30_000);

  it.each(['before-cleanup', 'after-lost-response'])('preserves acknowledged probe cleanup after consumption %s', async (phase) => {
    const api = await lifecycle(); const value = await probeFixture();
    const host = simulatedHost(); host.add(value.identity);
    expect((await acknowledgeBindingProbe(value.paths, {
      probe_id: value.action.probe.probe_id, probe_capability: value.capability,
    })).status).toBe('completed');
    expect((await observeBindingProbeStop(value.paths, value.hostIdentity)).matched).toBe(true);
    host.stop(value.identity);
    let first;
    if (phase === 'after-lost-response') {
      host.adapter.loseResponse = true;
      first = await api.retireNativeWorker(value.paths, value.identity, { adapter: host.adapter });
      expect(first.status).toBe('unconfirmed');
      expect(host.occupants.size).toBe(0);
      host.adapter.loseResponse = false;
    }
    expect((await consumeBindingProbe(value.paths, 'codex')).ok).toBe(true);
    const probeBefore = await storage.readJson(value.paths.bindingProbe);
    expect(probeBefore.status).toBe('consumed');
    const intentBefore = await storage.readJson(value.file);
    const quarantineBefore = await proofFiles(value.paths.bindingProbeQuarantine);
    const fallbackBefore = await proofFiles(value.paths.bindingProbeQuarantineFallback);
    const recovered = await api.retireNativeWorker(value.paths, value.identity, { adapter: host.adapter });
    expect(recovered).toMatchObject({ status: 'released', identity: value.identity });
    if (first) expect(recovered.operation_id).toBe(first.operation_id);
    expect(host.calls).toHaveLength(1);
    expect(host.occupants.size).toBe(0);
    expect(host.history.size).toBe(1);
    expect((await api.retireNativeWorker(value.paths, value.identity, { adapter: host.adapter })).operation_id).toBe(recovered.operation_id);
    expect(host.calls).toHaveLength(1);
    expect(await storage.readJson(value.paths.bindingProbe)).toEqual(probeBefore);
    expect(await storage.readJson(value.file)).toEqual(intentBefore);
    expect(await proofFiles(value.paths.bindingProbeQuarantine)).toEqual(quarantineBefore);
    expect(await proofFiles(value.paths.bindingProbeQuarantineFallback)).toEqual(fallbackBefore);
  }, 30_000);

  it.each(['directory', 'linked-confirmation'])('rejects a redirected retirement %s without trusting or writing outside evidence', async (kind) => {
    const api = await lifecycle(); const value = await fixture(); const worker = await bindWorker(value);
    const host = simulatedHost(); host.add(worker.identity); await accept(worker); await stop(worker, host);
    const before = await storage.readJson(worker.file);
    const directory = path.join(value.paths.runtime, 'native-worker-retirement');
    const operation_id = sha256({ version: 1, identity: worker.identity, operation: host.adapter.contract.operation });
    const outside = await mkdtemp(path.join(tmpdir(), 'ape-retirement-outside-')); roots.push(outside);
    const external = path.join(outside, `${operation_id}.json`);
    const forged = { status: 'released', identity: worker.identity, operation_id,
      evidence: { source: 'synthetic-test-adapter', preserves_history: true } };
    await writeFile(external, JSON.stringify(forged));
    if (kind === 'directory') await symlink(outside, directory, 'dir');
    else {
      await mkdir(directory);
      await symlink(external, path.join(directory, `${operation_id}.json`));
    }
    const externalBefore = await proofFiles(outside);
    // A rejection may be a typed result or an exception; neither may confirm
    // release, call a host sink, or modify the redirected target.
    const result = await api.retireNativeWorker(value.paths, worker.identity, { adapter: host.adapter })
      .catch((error) => ({ status: 'rejected', error: error.message }));
    expect(result.status).not.toBe('released');
    expect(host.calls).toHaveLength(0);
    expect(host.occupants.size).toBe(1);
    expect(await proofFiles(outside)).toEqual(externalBefore);
    await preserved(worker, before);
  }, 30_000);

  it.each(['missing', 'history-not-preserved', 'invalid-source'])('does not trust a persisted confirmation with %s evidence', async (kind) => {
    const api = await lifecycle(); const value = await fixture(); const worker = await bindWorker(value);
    const host = simulatedHost(); host.add(worker.identity); await accept(worker); await stop(worker, host);
    const operation_id = sha256({ version: 1, identity: worker.identity, operation: host.adapter.contract.operation });
    const evidence = kind === 'missing' ? undefined : {
      source: kind === 'invalid-source' ? 42 : 'synthetic-test-adapter',
      preserves_history: kind !== 'history-not-preserved',
    };
    await storage.atomicWriteJson(path.join(value.paths.runtime, 'native-worker-retirement', `${operation_id}.json`), {
      status: 'released', operation_id, identity: worker.identity, ...(evidence ? { evidence } : {}),
    });
    host.adapter.refuse = true;
    const result = await api.retireNativeWorker(value.paths, worker.identity, { adapter: host.adapter })
      .catch((error) => ({ status: 'rejected', error: error.message }));
    expect(result.status).not.toBe('released');
    expect(host.results.size).toBe(0);
    expect(host.occupants.size).toBe(1);
  }, 30_000);

  it('rejects ledger redirection after the host response before persisting confirmation', async () => {
    const api = await lifecycle(); const value = await fixture(); const worker = await bindWorker(value);
    const host = simulatedHost(); host.add(worker.identity); await accept(worker); await stop(worker, host);
    const directory = path.join(value.paths.runtime, 'native-worker-retirement');
    const retained = `${directory}-retained`;
    const outside = await mkdtemp(path.join(tmpdir(), 'ape-retirement-sink-')); roots.push(outside);
    const originalRelease = host.adapter.release;
    host.adapter.release = async (request) => {
      const response = await originalRelease(request);
      await rename(directory, retained);
      await symlink(outside, directory, 'dir');
      return response;
    };
    const first = await api.retireNativeWorker(value.paths, worker.identity, { adapter: host.adapter })
      .catch((error) => ({ status: 'rejected', error: error.message }));
    expect(first.status).not.toBe('released');
    expect(await readdir(outside)).toEqual([]);
    expect(host.calls).toHaveLength(1);
    expect(host.occupants.size).toBe(0);
    await rm(directory); await rename(retained, directory);
    const recovered = await api.retireNativeWorker(value.paths, worker.identity, { adapter: host.adapter });
    expect(recovered).toMatchObject({ status: 'released', operation_id: host.calls[0].operation_id });
    expect(host.calls).toHaveLength(1);
  }, 30_000);

  it('recovers a lost response using the same durable operation identity without inferring release', async () => {
    const api = await lifecycle(); const value = await fixture(); const worker = await bindWorker(value);
    const host = simulatedHost(); host.add(worker.identity); await accept(worker); await stop(worker, host);
    const before = await storage.readJson(worker.file);
    host.adapter.loseResponse = true;
    const first = await api.retireNativeWorker(value.paths, worker.identity, { adapter: host.adapter });
    expect(first.status).toBe('unconfirmed'); expect(first.operation_id).toBeTruthy();
    expect(host.occupants.size).toBe(0);
    host.adapter.loseResponse = false;
    const recovered = await api.retireNativeWorker(value.paths, worker.identity, { adapter: host.adapter });
    expect(recovered).toMatchObject({ status: 'released', operation_id: first.operation_id, identity: worker.identity });
    expect(new Set(host.calls.map((call) => call.operation_id))).toEqual(new Set([first.operation_id]));
    expect(host.results.size).toBe(1); await preserved(worker, before);
  }, 30_000);

  it.each(['before-host', 'after-host'])('survives %s persistence failure without authorizing a fresh destructive operation', async (boundary) => {
    const api = await lifecycle(); const value = await fixture(); const worker = await bindWorker(value);
    const host = simulatedHost(); host.add(worker.identity); await accept(worker); await stop(worker, host);
    const before = await storage.readJson(worker.file);
    const original = storage.atomicWriteJson;
    let faulted = false;
    const fault = vi.spyOn(storage, 'atomicWriteJson').mockImplementation(async (file, data, ...rest) => {
      // Fault the first retirement write, or its durable confirmation after
      // the host effect. No fixture authority/evidence write is intercepted.
      if (!faulted && (boundary === 'before-host' || host.results.size > 0)) {
        faulted = true; throw new Error('synthetic retirement persistence failure');
      }
      return original(file, data, ...rest);
    });
    let first;
    try { first = await api.retireNativeWorker(value.paths, worker.identity, { adapter: host.adapter }); }
    catch (error) { expect(error.message).toMatch(/synthetic retirement persistence failure/); }
    fault.mockRestore();
    expect(faulted).toBe(true); expect(first?.status).not.toBe('released');
    if (boundary === 'before-host') expect(host.calls).toHaveLength(0);
    const operation = host.calls[0]?.operation_id;
    const recovered = await api.retireNativeWorker(value.paths, worker.identity, { adapter: host.adapter });
    expect(recovered.status).toBe('released');
    if (operation) expect(recovered.operation_id).toBe(operation);
    expect(host.results.size).toBe(1); await preserved(worker, before);
  }, 30_000);
});
