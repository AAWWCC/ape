import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstat, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  bindCodexSubagent, bootstrapCodexSubagent, codexBootstrapStatus,
  expireClaudeIntent, isCodexBootstrapReplay, launchCodexIntent,
  prepareCodexIntent, readCodexBootstrapIntent,
  resolveCodexBindingOutcome, inspectDispatchSubagentStop,
  observeCodexSubagentStop,
} from '../lib/runtime/claude-dispatch.js';
import {
  codexBootstrapOrientation, recordCodexBootstrapCandidate, resolveCodexBootstrapCandidate,
} from '../lib/runtime/codex-bootstrap.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { finalizeTicket } from '../lib/runtime/schemas.js';

const cleanups = [];
const model = 'gpt-5.4-mini';
const hash = (value) => createHash('sha256').update(value).digest('hex');

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(cleanups.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture(options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'ape-codex-bootstrap-'));
  cleanups.push(directory);
  const paths = runtimePaths(directory);
  const ticket = finalizeTicket({
    schema_version: '2.0.0', run_id: 'run-bootstrap', ticket_id: 'run-bootstrap:build:ticket',
    stage_id: 'build', role: 'implementer', objective: 'Apply the exact authorized edit',
    claimed_paths: ['value.js'], test_paths: [], model_tier: 'balanced',
    model: { model, reasoning_effort: 'low' },
    issued_at: new Date().toISOString(), deadline_at: new Date(Date.now() + 300_000).toISOString(),
    output_schema: { type: 'object' }, required_checks: [], parent_hash: null,
    base_tree_sha: '0'.repeat(40), attempt: 1, writable: true,
  });
  const state = { run_id: ticket.run_id, status: 'running', host: 'codex', tickets: [ticket], receipts: [], expired_tickets: [] };
  const prepared = await prepareCodexIntent(paths, ticket, 'worker', { bootstrap_protocol: 1, ...options });
  return { directory, paths, ticket, state, prepared, options };
}

async function launch(value, prepared = value.prepared, overrides = {}) {
  const result = await launchCodexIntent(value.paths, value.state, {
    session_id: 'parent-session', turn_id: 'parent-turn', tool_use_id: `spawn-${prepared.agent_name}`,
    tool_name: 'collaboration.spawn_agent',
    tool_input: { task_name: prepared.agent_name, fork_turns: 'none', model,
      reasoning_effort: 'low', message: 'encrypted-native-message' }, ...overrides,
  });
  expect(result.valid).toBe(true);
}

function candidate(agent = 'child-one', overrides = {}) {
  return { hook_event_name: 'SubagentStart', session_id: 'parent-session',
    turn_id: `turn-${agent}`, agent_id: agent, agent_type: 'default', model, ...overrides };
}

function bootstrap(value, agent = 'child-one', overrides = {}) {
  return { hook_event_name: 'PreToolUse', session_id: agent, turn_id: `turn-${agent}`,
    tool_use_id: `bootstrap-${agent}`, tool_name: 'mcp__ape__ape_bind', model,
    tool_input: { project_dir: value.directory, bootstrap_capability: value.prepared.bootstrap_capability },
    ...overrides };
}

function candidatePath(paths, session, turn) {
  return path.join(paths.runtime, 'codex-bootstrap-candidates', `${hash(JSON.stringify([session, turn]))}.json`);
}

async function onlyIntent(value) {
  const files = (await readdir(value.paths.dispatchIntents)).filter((file) => file.endsWith('.json'));
  expect(files).toHaveLength(1);
  return JSON.parse(await readFile(path.join(value.paths.dispatchIntents, files[0]), 'utf8'));
}

describe('Codex exact-generation native bootstrap', () => {
  it('derives a separate recoverable bootstrap bearer and persists only its hash', async () => {
    const value = await fixture();
    const { prepared } = value;
    expect(prepared.bootstrap_capability).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(prepared.bootstrap_capability).not.toBe(prepared.agent_name);
    expect(prepared.bootstrap_args).toEqual({ project_dir: value.directory, bootstrap_capability: prepared.bootstrap_capability });
    expect(prepared.prompt).toContain(JSON.stringify(prepared.bootstrap_args));
    const discovery = prepared.prompt.split('\n').find((line) => line.includes('tool_search.tool_search_tool'));
    expect(discovery).toContain('at most one bounded host tool-catalog search');
    expect(discovery).toContain('using only the literal registered tool name ape_bind, not a host-qualified invocation alias');
    expect(discovery).not.toContain('mcp__');
    expect(discovery).not.toContain(prepared.bootstrap_capability);
    expect(discovery).not.toContain(value.directory);
    expect(prepared.prompt).toContain('Your first APE operation must be the installed ape_bind');
    expect(prepared.prompt).toContain('context is expected to be absent. Do not stop for that absence');
    expect(prepared.prompt).toContain('Tool discovery and ape_bind are permitted bootstrap operations, not stage work');
    expect(prepared.prompt.match(/^[123]\./gm)).toEqual(['1.', '2.', '3.']);
    expect(prepared.prompt.indexOf('1. Execute this assigned bootstrap now')).toBeLessThan(prepared.prompt.indexOf(discovery));
    expect(prepared.prompt.indexOf(discovery)).toBeLessThan(prepared.prompt.indexOf('2. Your first APE operation'));
    expect(prepared.prompt.indexOf(JSON.stringify(prepared.bootstrap_args))).toBeLessThan(prepared.prompt.indexOf('3. Only AFTER ape_bind returns'));
    expect(prepared.prompt.split('3. Only AFTER ape_bind returns')[1]).toContain('complete authoritative ticket and receipt context injected by its authenticated hook');
    expect(prepared.prompt).not.toContain('If injection is absent, stop');
    expect(prepared.prompt).toContain('mcp__ape.ape_bind; normalized alias mcp__ape__ape_bind');
    expect(prepared.prompt).toContain('never a similarly named tool from another plugin');
    expect(prepared.prompt).toContain('functions.exec');
    expect(prepared.prompt).toContain('only to inspect exact-matching ALL_TOOLS metadata for ape_bind or invoke that one installed tool');
    expect(prepared.prompt).toContain('does not permit functions.exec_command, shell commands');
    expect(prepared.prompt).toContain('do not inspect or modify the project, access files, do stage work, or call any other MCP tool');
    expect(prepared.prompt).not.toContain('Before any other tool');
    const record = await onlyIntent(value);
    expect(record).toMatchObject({ bootstrap_protocol: 1, bootstrap_capability_hash: hash(prepared.bootstrap_capability) });
    expect(record.launch_generations[0].bootstrap_capability_hash).toBe(record.bootstrap_capability_hash);
    expect(JSON.stringify(record)).not.toContain(prepared.bootstrap_capability);
    const replay = await prepareCodexIntent(value.paths, value.ticket, 'worker', {
      bootstrap_protocol: 1, allow_prepared_replay: true,
    });
    expect(replay).toEqual(prepared);
    expect(await codexBootstrapStatus(value.paths, prepared.bootstrap_capability)).toMatchObject({ ok: false, bound: false });
  });

  it('keeps SubagentStart provisional, then binds a session-only child with a distinct native turn', async () => {
    const value = await fixture();
    await launch(value);
    const provisional = await bindCodexSubagent(value.paths, value.state, candidate());
    expect(provisional).toMatchObject({ valid: true, bootstrap_required: true, additional_context: codexBootstrapOrientation() });
    expect(provisional).not.toHaveProperty('ticket_id');
    expect(provisional.additional_context).not.toContain(value.prepared.bootstrap_capability);
    expect(provisional.additional_context).not.toContain(value.prepared.agent_name);
    expect(provisional.additional_context).not.toContain(value.ticket.ticket_id);
    expect(provisional.additional_context).not.toContain(value.directory);
    expect(provisional.additional_context).not.toMatch(/APE_(?:BOUND|RECEIPT|PROBE)_CAPABILITY=|Immutable StageTicket reference/u);
    expect((await onlyIntent(value)).status).toBe('launched');
    const call = bootstrap(value);
    const result = await bootstrapCodexSubagent(value.paths, value.state, call);
    expect(result.valid).toBe(true);
    expect(result.additional_context).toContain('APE_RECEIPT_CAPABILITY=');
    expect(result.additional_context).toContain('Immutable StageTicket reference');
    expect(result.bootstrap_invocation).toMatchObject({ session_id: 'parent-session', agent_id: 'child-one',
      turn_id_hash: hash('turn-child-one'), tool_use_id: 'bootstrap-child-one', launch_generation: 1 });
    const stored = await onlyIntent(value);
    expect(stored).toMatchObject({ status: 'bound', bound_session_id: 'parent-session', bound_agent_id: 'child-one', bootstrap_model: model });
    const status = await codexBootstrapStatus(value.paths, value.prepared.bootstrap_capability);
    expect(status).toEqual({ ok: true, bound: true, bootstrap_protocol: 1 });
    expect(JSON.stringify(status)).not.toMatch(/capability|agent_id|context/u);
    expect(await isCodexBootstrapReplay(value.paths, call)).toBe(true);
    expect(await isCodexBootstrapReplay(value.paths, { ...call, tool_use_id: 'different-call' })).toBe(false);
    const before = JSON.stringify(await onlyIntent(value));
    const duplicate = await bootstrapCodexSubagent(value.paths, value.state, call);
    expect(duplicate.additional_context).toBe(result.additional_context);
    expect(JSON.stringify(await onlyIntent(value))).toBe(before);
  });

  it('keeps native-child orientation static, bounded, conditional and free of authority', () => {
    const orientation = codexBootstrapOrientation();
    expect(Buffer.byteLength(orientation)).toBeLessThan(2_048);
    expect(codexBootstrapOrientation()).toBe(orientation);
    expect(orientation).toContain('attests only your native child identity');
    expect(orientation).toContain('does not associate you with a ticket or grant stage, receipt, or probe-acknowledgement authority');
    expect(orientation).toContain('do not ask the human to restate');
    expect(orientation).toContain('If your assigned task includes APE bootstrap arguments');
    expect(orientation).toContain('follow these steps now');
    expect(orientation).toContain('context is expected to be absent. Do not stop for that absence');
    expect(orientation).toContain('Tool discovery and ape_bind are permitted bootstrap operations, not stage work');
    expect(orientation.match(/^[123]\./gm)).toEqual(['1.', '2.', '3.']);
    expect(orientation.indexOf('1. Before binding')).toBeLessThan(orientation.indexOf('2. Call installed APE ape_bind'));
    expect(orientation.indexOf('2. Call installed APE ape_bind')).toBeLessThan(orientation.indexOf('3. Only AFTER ape_bind returns'));
    expect(orientation).not.toContain('If that context is absent, stop');
    const discovery = orientation.split('\n').find((line) => line.includes('host tool-catalog search'));
    expect(discovery).toContain('at most one host tool-catalog search using only the literal registered tool name ape_bind, not a host-qualified invocation alias');
    expect(discovery).not.toContain('mcp__');
    expect(orientation).toContain('mcp__ape.ape_bind; normalized alias mcp__ape__ape_bind');
    expect(orientation).toContain('never a similarly named tool from another plugin');
    expect(orientation).toContain('Never include a capability, project path, or task data');
    expect(orientation).toContain('For that APE bootstrap only, if the tool is deferred');
    expect(orientation).toContain('For that APE bootstrap only, a functions.exec wrapper');
    expect(orientation).toContain('does not permit functions.exec_command, shell commands, file access, other MCP operations, or stage work');
    expect(orientation).toContain('If your assigned task has no APE bootstrap arguments, do not infer, obtain, or request them');
    expect(orientation).toContain('continue that non-APE assignment under the applicable rules');
  });

  it('injects no orientation when the native candidate observation is malformed', async () => {
    const value = await fixture();
    await launch(value);
    const malformed = candidate('missing-orientation-model');
    delete malformed.model;
    const result = await bindCodexSubagent(value.paths, value.state, malformed);
    expect(result.valid).toBe(false);
    expect(result).not.toHaveProperty('additional_context');
    expect(result).not.toHaveProperty('ticket_id');
    expect((await onlyIntent(value)).status).toBe('launched');
  });

  it('refuses a parent, caller-forged child fields, and a child with no native observation', async () => {
    const value = await fixture();
    await launch(value);
    await recordCodexBootstrapCandidate(value.paths, candidate());
    for (const call of [
      bootstrap(value, 'child-one', { session_id: 'parent-session', turn_id: 'parent-turn' }),
      bootstrap(value, 'unknown-child'),
      bootstrap(value, 'child-one', { is_subagent: false }),
      bootstrap(value, 'child-one', { agent_id: 'different-child' }),
      bootstrap(value, 'child-one', { tool_input: {
        ...value.prepared.bootstrap_args, agent_id: 'child-one',
      } }),
      bootstrap(value, 'child-one', { tool_input: {
        ...value.prepared.bootstrap_args, project_dir: path.dirname(value.directory),
      } }),
    ]) {
      const result = await bootstrapCodexSubagent(value.paths, value.state, call);
      expect(result.valid).toBe(false);
      expect(JSON.stringify(result)).not.toContain(value.prepared.bootstrap_capability);
    }
    expect((await onlyIntent(value)).status).toBe('launched');
  });

  it('requires the actual native child model and rejects mismatched parent or type', async () => {
    const value = await fixture();
    await launch(value);
    const missing = candidate('missing-model');
    delete missing.model;
    missing.tool_input = { model };
    expect(await recordCodexBootstrapCandidate(value.paths, missing)).toMatchObject({ recorded: false });
    await expect(resolveCodexBootstrapCandidate(value.paths, bootstrap(value, 'missing-model')))
      .rejects.toThrow(/unreadable/u);
    for (const [agent, patch] of [
      ['wrong-model', { model: 'gpt-5.5' }],
      ['wrong-parent', { session_id: 'other-parent' }],
      ['wrong-type', { agent_type: 'reviewer' }],
    ]) {
      await recordCodexBootstrapCandidate(value.paths, candidate(agent, patch));
      expect((await bootstrapCodexSubagent(value.paths, value.state,
        bootstrap(value, agent, patch.model ? { model: patch.model } : {}))).valid).toBe(false);
    }
    expect((await onlyIntent(value)).status).toBe('launched');
  });

  it('allows one winner under racing children and preserves the first binding against replay', async () => {
    const value = await fixture();
    await launch(value);
    await recordCodexBootstrapCandidate(value.paths, candidate('racer-a'));
    await recordCodexBootstrapCandidate(value.paths, candidate('racer-b'));
    const outcomes = await Promise.all(['racer-a', 'racer-b'].map((agent) =>
      bootstrapCodexSubagent(value.paths, value.state, bootstrap(value, agent))));
    expect(outcomes.filter((result) => result.valid)).toHaveLength(1);
    const before = JSON.stringify(await onlyIntent(value));
    const loser = outcomes[0].valid ? 'racer-b' : 'racer-a';
    expect((await bootstrapCodexSubagent(value.paths, value.state, bootstrap(value, loser))).valid).toBe(false);
    expect(JSON.stringify(await onlyIntent(value))).toBe(before);
  });

  it('rejects retired A while B launches within the same parent turn', async () => {
    const value = await fixture();
    await launch(value);
    await expireClaudeIntent(value.paths, value.ticket.ticket_id);
    const replacement = await prepareCodexIntent(value.paths, value.ticket, 'worker', { bootstrap_protocol: 1 });
    await launch(value, replacement);
    await recordCodexBootstrapCandidate(value.paths, candidate('late-a'));
    await recordCodexBootstrapCandidate(value.paths, candidate('new-b'));
    const oldEvidence = await readCodexBootstrapIntent(value.paths, value.prepared.bootstrap_capability);
    expect(oldEvidence).toMatchObject({ bootstrap_current: false, matched_generation: {
      generation: 1, status: 'expired', parent_session_id: 'parent-session', binding_agent_type: 'default',
    } });
    expect((await bootstrapCodexSubagent(value.paths, value.state, bootstrap(value, 'late-a'))).valid).toBe(false);
    expect((await bootstrapCodexSubagent(value.paths, value.state, bootstrap(value, 'new-b', {
      tool_input: replacement.bootstrap_args,
    }))).valid).toBe(true);
    expect((await onlyIntent(value)).bound_agent_id).toBe('new-b');
  });

  it('rejects a consumed or changed immutable ticket without binding', async () => {
    const value = await fixture();
    await launch(value);
    await recordCodexBootstrapCandidate(value.paths, candidate());
    for (const state of [
      { ...value.state, receipts: [{ ticket_id: value.ticket.ticket_id }] },
      { ...value.state, tickets: [{ ...value.ticket, ticket_hash: 'f'.repeat(64) }] },
      { ...value.state, status: 'aborted' },
    ]) expect((await bootstrapCodexSubagent(value.paths, state, bootstrap(value))).valid).toBe(false);
    expect((await onlyIntent(value)).status).toBe('launched');
  });

  it('poisons conflicting native aliases and never trusts an independently replaced counterpart', async () => {
    const value = await fixture();
    await recordCodexBootstrapCandidate(value.paths, candidate());
    await expect(recordCodexBootstrapCandidate(value.paths, candidate('other-child', { turn_id: 'turn-child-one' })))
      .rejects.toThrow(/conflicting/u);
    await expect(resolveCodexBootstrapCandidate(value.paths, bootstrap(value))).rejects.toThrow(/conflicting/u);
    await expect(resolveCodexBootstrapCandidate(value.paths,
      { session_id: 'parent-session', turn_id: 'turn-child-one' })).rejects.toThrow(/conflicting/u);
  });

  it('fails closed for contradictory fields on a known native child instead of falling back to the main session', async () => {
    const value = await fixture();
    await recordCodexBootstrapCandidate(value.paths, candidate());
    for (const patch of [
      { is_subagent: false }, { model: 'changed-native-model' },
      { agent_id: 'different-native-child' }, { agent_type: 'changed-native-type' },
    ]) {
      await expect(resolveCodexBootstrapCandidate(value.paths, {
        session_id: 'child-one', turn_id: 'turn-child-one',
        tool_name: 'mcp__ape__ape_run', ...patch,
      })).rejects.toThrow(/unreadable or conflicting/u);
    }
  });

  it('keeps known child sessions denied on missing fresh turn evidence while unrelated parent sessions stay neutral', async () => {
    const value = await fixture();
    await recordCodexBootstrapCandidate(value.paths, candidate());
    for (const turn of ['unobserved-child-turn', undefined]) {
      await expect(resolveCodexBootstrapCandidate(value.paths, {
        session_id: 'child-one', turn_id: turn,
      })).rejects.toMatchObject({ bootstrap_identity_known: true });
    }
    expect(await resolveCodexBootstrapCandidate(value.paths, {
      session_id: 'parent-session', turn_id: 'parent-turn',
    })).toBeNull();
    expect(await resolveCodexBootstrapCandidate(value.paths, {
      session_id: 'unrelated-session', turn_id: 'unrelated-turn',
    })).toBeNull();
    await recordCodexBootstrapCandidate(value.paths, candidate('child-one', { turn_id: 'fresh-turn' }));
    expect(await resolveCodexBootstrapCandidate(value.paths, {
      session_id: 'child-one', turn_id: 'fresh-turn',
    })).toMatchObject({ agent_id: 'child-one', turn_id: 'fresh-turn' });
  });

  it('requires a fresh bootstrap on resumed child turns before tool or stop-attestation authority', async () => {
    const value = await fixture();
    await launch(value);
    await recordCodexBootstrapCandidate(value.paths, candidate());
    expect((await bootstrapCodexSubagent(value.paths, value.state, bootstrap(value))).valid).toBe(true);
    const originalCall = { session_id: 'child-one', turn_id: 'turn-child-one' };
    expect((await resolveCodexBindingOutcome(value.paths, value.state, originalCall)).record).toBeTruthy();
    await recordCodexBootstrapCandidate(value.paths, candidate('child-one', { turn_id: 'resumed-child-turn' }));
    const resumedCall = { session_id: 'child-one', turn_id: 'resumed-child-turn' };
    expect((await resolveCodexBindingOutcome(value.paths, value.state, resumedCall)).record).toBeNull();
    expect((await inspectDispatchSubagentStop(value.paths, value.state, resumedCall, 'codex')).observed).toBe(false);
    expect((await bootstrapCodexSubagent(value.paths, value.state, bootstrap(value, 'child-one', {
      turn_id: 'resumed-child-turn', tool_use_id: 'resumed-bootstrap',
    }))).valid).toBe(true);
    expect((await resolveCodexBindingOutcome(value.paths, value.state, resumedCall)).record).toBeTruthy();
    expect((await inspectDispatchSubagentStop(value.paths, value.state, resumedCall, 'codex')).observed).toBe(true);
  });

  it('never revives a stopped worker from its old bootstrap replay without a newly observed child turn', async () => {
    const value = await fixture();
    await launch(value);
    await recordCodexBootstrapCandidate(value.paths, candidate());
    const call = bootstrap(value);
    expect((await bootstrapCodexSubagent(value.paths, value.state, call)).valid).toBe(true);
    expect((await observeCodexSubagentStop(value.paths, value.state, {
      session_id: 'child-one', turn_id: 'turn-child-one',
    })).observed).toBe(true);
    const stopped = JSON.stringify(await onlyIntent(value));
    expect((await bootstrapCodexSubagent(value.paths, value.state, call)).valid).toBe(false);
    const stoppedTool = { session_id: 'child-one', turn_id: 'turn-child-one', tool_name: 'Edit' };
    expect((await resolveCodexBindingOutcome(value.paths, value.state, stoppedTool)).record).toBeNull();
    expect((await inspectDispatchSubagentStop(value.paths, value.state, stoppedTool, 'codex')).observed).toBe(true);
    expect(JSON.stringify(await onlyIntent(value))).toBe(stopped);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 1_000);
    await recordCodexBootstrapCandidate(value.paths, candidate('child-one', { turn_id: 'fresh-after-stop' }));
    expect((await bootstrapCodexSubagent(value.paths, value.state, bootstrap(value, 'child-one', {
      turn_id: 'fresh-after-stop', tool_use_id: 'bootstrap-after-stop',
    }))).valid).toBe(true);
    expect(await onlyIntent(value)).not.toHaveProperty('agent_stopped_at');
    expect((await resolveCodexBindingOutcome(value.paths, value.state, {
      session_id: 'child-one', turn_id: 'fresh-after-stop', tool_name: 'Edit',
    })).record).toBeTruthy();
  });

  it.runIf(process.platform !== 'win32').each(['symlink', 'fifo'])(
    'rejects a %s candidate leaf without following or blocking it', async (kind) => {
      const value = await fixture();
      await recordCodexBootstrapCandidate(value.paths, candidate());
      const file = candidatePath(value.paths, 'child-one', 'turn-child-one');
      await rename(file, `${file}.original`);
      if (kind === 'symlink') await symlink(`${file}.original`, file);
      else execFileSync('mkfifo', [file]);
      await expect(resolveCodexBootstrapCandidate(value.paths, bootstrap(value))).rejects.toThrow(/unreadable/u);
      expect((await lstat(file))[kind === 'symlink' ? 'isSymbolicLink' : 'isFIFO']()).toBe(true);
    },
  );

  it('rejects oversized candidate evidence and remains neutral without any matching observation', async () => {
    const value = await fixture();
    expect(await resolveCodexBootstrapCandidate(value.paths, bootstrap(value))).toBeNull();
    await recordCodexBootstrapCandidate(value.paths, candidate());
    await writeFile(candidatePath(value.paths, 'child-one', 'turn-child-one'), ' '.repeat(8193));
    await expect(resolveCodexBootstrapCandidate(value.paths, bootstrap(value))).rejects.toThrow(/unreadable/u);
  });
});
