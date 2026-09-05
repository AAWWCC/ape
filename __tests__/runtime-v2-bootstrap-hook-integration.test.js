import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bindingProbeStatus, prepareBindingProbe } from '../lib/runtime/binding-probe.js';
import { codexBootstrapStatus } from '../lib/runtime/claude-dispatch.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { invokeCodexHook } from './codex-native-test-helper.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cleanups = [];
const model = { model: 'gpt-5.6-terra', reasoning_effort: 'medium' };
const context = (result) => result.hookSpecificOutput?.additionalContext;
const denied = (result) => result.hookSpecificOutput?.permissionDecision === 'deny' || result.decision === 'deny';
const evidenceHash = (parts) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
const aliasEvidenceHash = (parts) => createHash('sha256').update(`ape-native-canary-alias-v1:${JSON.stringify(parts)}`).digest('hex');
const quarantinePath = (directory, hash) => path.join(directory, hash.slice(0, 2), `${hash}.json`);

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-bootstrap-hook-'));
  cleanups.push(dir);
  const paths = runtimePaths(dir);
  await mkdir(paths.runtime, { recursive: true });
  const action = await prepareBindingProbe(paths, { host: 'codex', model });
  const launch = await invokeCodexHook(root, {
    hook_event_name: 'PreToolUse', project_dir: dir,
    session_id: 'parent-session', turn_id: 'parent-turn', tool_use_id: 'spawn-call',
    tool_name: 'collaborationspawn_agent', tool_input: action.dispatch.spawn_args,
  });
  expect(denied(launch)).toBe(false);
  return { dir, paths, action };
}

function child(value, overrides = {}) {
  return {
    hook_event_name: 'SubagentStart', project_dir: value.dir,
    session_id: 'parent-session', turn_id: 'separate-child-turn',
    agent_id: 'child-agent', agent_type: 'default', model: model.model,
    ...overrides,
  };
}

function bind(value, overrides = {}) {
  return {
    hook_event_name: 'PreToolUse', project_dir: value.dir,
    session_id: 'parent-session', turn_id: 'separate-child-turn',
    tool_use_id: 'bootstrap-call', tool_name: 'mcp__ape__ape_bind',
    tool_input: value.action.dispatch.bootstrap_args,
    ...overrides,
  };
}

describe('native bootstrap source-hook integration', () => {
  it('delivers APE-bounded authority without host preview spilling', async () => {
    const manifest = JSON.parse(await readFile(path.join(root, 'hooks/hooks.json'), 'utf8'));
    const pre = manifest.hooks.PreToolUse.find((arm) => arm.matcher !== '*' && new RegExp(arm.matcher).test('ape_bind'));
    expect(pre.hooks[0].additionalContextLimit).toBe(0);
    expect(manifest.hooks.SubagentStart[0].hooks[0].additionalContextLimit).toBe(0);
  });
  it.each(['parent-session', 'child-agent'])('binds an observed child through the %s session alias without agent_id', async (session) => {
    const value = await fixture();
    const observed = await invokeCodexHook(root, child(value));
    expect(denied(observed)).toBe(false);
    expect(observed.hookSpecificOutput?.hookEventName).toBe('SubagentStart');
    expect(context(observed)).toContain('mcp__ape__ape_bind');
    expect(Buffer.byteLength(context(observed), 'utf8')).toBeLessThan(4096);
    expect(context(observed)).not.toContain(value.action.dispatch.bootstrap_args.bootstrap_capability);
    expect(context(observed)).not.toContain(value.action.probe.probe_id);
    expect(context(observed)).not.toMatch(/APE_(?:RECEIPT|PROBE)_CAPABILITY=/u);
    expect(await codexBootstrapStatus(value.paths, value.action.dispatch.bootstrap_args.bootstrap_capability))
      .toMatchObject({ ok: false, bound: false });
    const admitted = await invokeCodexHook(root, bind(value, { session_id: session }));
    expect(denied(admitted)).toBe(false);
    expect(context(admitted)).toMatch(/APE_PROBE_CAPABILITY=[A-Za-z0-9_-]{32,256}/);
    expect(context(admitted)).not.toContain(value.action.dispatch.bootstrap_args.bootstrap_capability);
    expect(await codexBootstrapStatus(value.paths, value.action.dispatch.bootstrap_args.bootstrap_capability))
      .toEqual({ ok: true, bound: true, bootstrap_protocol: 1 });
    expect((await bindingProbeStatus(value.paths)).status).toBe('bound');
  });

  it.each(['ape_bind', 'mcp__ape__ape_bind', 'mcp__plugin_ape_ape__ape_bind'])('injects bootstrap authority only at PreToolUse for the exact owned alias %s', async (tool_name) => {
    const value = await fixture();
    await invokeCodexHook(root, child(value));
    const input = bind(value, { session_id: 'child-agent', tool_name });
    const before = await invokeCodexHook(root, { ...input, hook_event_name: 'PostToolUse' });
    expect(context(before)).toBeUndefined();
    expect((await bindingProbeStatus(value.paths)).status).toBe('launched');
    expect(context(await invokeCodexHook(root, input))).toContain('APE_PROBE_CAPABILITY=');
    const after = await invokeCodexHook(root, { ...input, hook_event_name: 'PostToolUse' });
    expect(context(after)).toBeUndefined();
    expect((await bindingProbeStatus(value.paths)).status).toBe('bound');
  });

  it('does not assign authority to a similarly named external MCP tool', async () => {
    const value = await fixture();
    await invokeCodexHook(root, child(value));
    const other = bind(value, { session_id: 'child-agent', tool_name: 'mcp__other_provider__ape_bind' });
    expect(await invokeCodexHook(root, other)).toEqual({});
    expect(await invokeCodexHook(root, other, ['--ape-canary-only'])).toEqual({});
    expect((await bindingProbeStatus(value.paths)).status).toBe('launched');
    expect(context(await invokeCodexHook(root, bind(value)))).toContain('APE_PROBE_CAPABILITY=');
    expect(denied(await invokeCodexHook(root, other, ['--ape-canary-only']))).toBe(true);
  });

  it('keeps a stopped canary retired across session aliases and rejects a stale bootstrap replay', async () => {
    const value = await fixture();
    await invokeCodexHook(root, child(value));
    const input = bind(value, { session_id: 'child-agent' });
    expect(context(await invokeCodexHook(root, input))).toContain('APE_PROBE_CAPABILITY=');
    await invokeCodexHook(root, {
      hook_event_name: 'SubagentStop', project_dir: value.dir,
      session_id: 'child-agent', turn_id: 'separate-child-turn',
    });
    const stopped = JSON.parse(await readFile(value.paths.bindingProbe, 'utf8'));
    expect(stopped.canary_stopped_at).toBeTruthy();
    expect(denied(await invokeCodexHook(root, input))).toBe(true);
    expect(context(await invokeCodexHook(root, input))).toBeUndefined();
    for (const identity of [
      { session_id: 'parent-session', agent_id: 'child-agent' },
      { session_id: 'child-agent', turn_id: 'separate-child-turn' },
      { session_id: 'child-agent', turn_id: 'unobserved-resume-turn' },
    ]) {
      expect(denied(await invokeCodexHook(root, {
        hook_event_name: 'PreToolUse', project_dir: value.dir,
        ...identity, tool_name: 'mcp__other_provider__mutate', tool_input: {},
      }, ['--ape-canary-only']))).toBe(true);
    }
    expect(JSON.parse(await readFile(value.paths.bindingProbe, 'utf8')).canary_stopped_at).toBe(stopped.canary_stopped_at);
  });

  it.each(['wildcard-first', 'ordinary-first', 'concurrent'])('admits only the same bootstrap invocation with %s hooks', async (order) => {
    const value = await fixture();
    await invokeCodexHook(root, child(value));
    const input = bind(value);
    const ordinary = () => invokeCodexHook(root, input);
    const wildcard = () => invokeCodexHook(root, input, ['--ape-canary-only']);
    const results = order === 'concurrent'
      ? await Promise.all([ordinary(), wildcard()])
      : order === 'wildcard-first' ? [await wildcard(), await ordinary()] : [await ordinary(), await wildcard()];
    expect(results.every((result) => !denied(result))).toBe(true);
    expect(results.filter((result) => Boolean(context(result)))).toHaveLength(1);
    const replay = await invokeCodexHook(root, input);
    expect(context(replay)).toEqual(context(results.find((result) => context(result))));
    for (const toolName of ['mcp__outside__search', 'ape_run', 'exec_command']) {
      const attempted = { ...input, tool_name: toolName, tool_use_id: 'later-call', tool_input: {} };
      expect(denied(await invokeCodexHook(root, attempted, ['--ape-canary-only']))).toBe(true);
    }
    const newInvocation = bind(value, { tool_use_id: 'new-bootstrap-call' });
    expect(denied(await invokeCodexHook(root, newInvocation, ['--ape-canary-only']))).toBe(true);
    expect(denied(await invokeCodexHook(root, newInvocation))).toBe(true);
  });

  it('refuses parent, absent observation, extra identity arguments, and another project before context', async () => {
    const value = await fixture();
    const token = value.action.dispatch.bootstrap_args.bootstrap_capability;
    for (const overrides of [{}, { turn_id: 'parent-turn' }]) {
      const response = await invokeCodexHook(root, bind(value, overrides));
      expect(denied(response)).toBe(true);
      expect(context(response)).toBeUndefined();
      expect(JSON.stringify(response)).not.toContain(token);
    }
    await invokeCodexHook(root, child(value));
    for (const toolInput of [
      { ...value.action.dispatch.bootstrap_args, agent_id: 'invented-child' },
      { ...value.action.dispatch.bootstrap_args, project_dir: root },
    ]) {
      const response = await invokeCodexHook(root, bind(value, { tool_input: toolInput }));
      expect(denied(response)).toBe(true);
      expect(context(response)).toBeUndefined();
      expect(JSON.stringify(response)).not.toContain(token);
    }
    expect((await bindingProbeStatus(value.paths)).status).toBe('launched');
    const nativeCwdOnly = await invokeCodexHook(root, bind(value, {
      project_dir: undefined, cwd: value.dir,
      tool_input: { ...value.action.dispatch.bootstrap_args, project_dir: root },
    }));
    expect(denied(nativeCwdOnly)).toBe(true);
    expect(context(nativeCwdOnly)).toBeUndefined();
  });

  it('keeps missing actual model evidence from becoming an unbound-main control call', async () => {
    const value = await fixture();
    const observed = await invokeCodexHook(root, child(value, { model: undefined }));
    expect(observed.systemMessage).toMatch(/complete native child identity and model/);
    expect(context(observed)).toBeUndefined();
    const response = await invokeCodexHook(root, bind(value, { tool_name: 'ape_run', tool_input: { action: 'next' } }));
    expect(denied(response)).toBe(true);
    expect(context(response)).toBeUndefined();
  });

  it.each([{ model: 'gpt-5.5' }, { is_subagent: false }, { agent_type: 'conflicting-type' }])('does not erase known child identity on contradiction %j', async (conflict) => {
    const value = await fixture();
    await invokeCodexHook(root, child(value));
    const response = await invokeCodexHook(root, bind(value, {
      session_id: 'child-agent', tool_name: 'ape_run', tool_input: { action: 'next' }, ...conflict,
    }));
    expect(denied(response)).toBe(true);
    expect(context(response)).toBeUndefined();
  });

  it.each([
    { mode: 'ordinary', args: [] },
    { mode: 'wildcard', args: ['--ape-canary-only'] },
  ])('keeps an explicit bound canary fenced through candidate-container damage in $mode mode', async ({ args }) => {
    const value = await fixture();
    await invokeCodexHook(root, child(value));
    expect(context(await invokeCodexHook(root, bind(value)))).toContain('APE_PROBE_CAPABILITY=');
    const candidates = path.join(value.paths.runtime, 'codex-bootstrap-candidates');
    await rename(candidates, `${candidates}.saved`);
    await writeFile(candidates, 'damaged candidate container');
    const response = await invokeCodexHook(root, {
      hook_event_name: 'PreToolUse', project_dir: value.dir,
      session_id: 'parent-session', agent_id: 'child-agent',
      agent_type: 'default', turn_id: 'separate-child-turn',
      tool_name: 'mcp__unrelated_provider__mutate', tool_input: {},
    }, args);
    expect(denied(response)).toBe(true);
    expect(context(response)).toBeUndefined();
    expect(await invokeCodexHook(root, {
      hook_event_name: 'PreToolUse', project_dir: value.dir,
      session_id: 'unrelated-parent', agent_id: 'unrelated-child',
      turn_id: 'unrelated-turn', tool_name: 'mcp__unrelated_provider__mutate', tool_input: {},
    }, args)).toEqual({});
  });

  it.each([
    { mode: 'ordinary', args: [] },
    { mode: 'wildcard', args: ['--ape-canary-only'] },
  ])('does not mistake a never-APE child new turn for a canary in $mode mode', async ({ args }) => {
    const value = await fixture();
    const observed = await invokeCodexHook(root, child(value, {
      session_id: 'unrelated-parent', agent_id: 'unrelated-child', turn_id: 'unrelated-first-turn',
    }));
    expect(context(observed)).toContain('not ticket authority');
    const external = {
      hook_event_name: 'PreToolUse', project_dir: value.dir,
      session_id: 'unrelated-child', tool_name: 'mcp__unrelated_provider__search', tool_input: {},
    };
    for (const turn_id of ['unrelated-first-turn', 'unobserved-resume-turn', undefined]) {
      expect(await invokeCodexHook(root, { ...external, turn_id }, args)).toEqual({});
    }
    // Native-child evidence still prevents a session-only child from taking
    // the main orchestrator's APE control-plane exemption on a new turn.
    expect(denied(await invokeCodexHook(root, {
      ...external, turn_id: 'unobserved-resume-turn',
      tool_name: 'ape_run', tool_input: { action: 'next' },
    }))).toBe(true);
    expect((await bindingProbeStatus(value.paths)).status).toBe('launched');
  });

  it('uses domain-separated canary alias tombstones without quarantining a parent session alone', async () => {
    const value = await fixture();
    await invokeCodexHook(root, child(value));
    expect(context(await invokeCodexHook(root, bind(value)))).toContain('APE_PROBE_CAPABILITY=');
    const pairHash = evidenceHash(['parent-session', 'child-agent']);
    const childHash = aliasEvidenceHash(['canary-child-v1', 'child-agent']);
    const turnHash = aliasEvidenceHash(['canary-turn-v1', 'parent-session', 'separate-child-turn']);
    expect(new Set([pairHash, childHash, turnHash]).size).toBe(3);
    for (const directory of [value.paths.bindingProbeQuarantine, value.paths.bindingProbeQuarantineFallback]) {
      for (const hash of [pairHash, childHash, turnHash]) {
        const evidence = JSON.parse(await readFile(quarantinePath(directory, hash), 'utf8'));
        expect(evidence.identity_hash).toBe(hash);
        expect(Object.keys(evidence).sort()).toEqual(['identity_hash', 'retired_at', 'version']);
        expect(JSON.stringify(evidence)).not.toMatch(/parent-session|child-agent|separate-child-turn/u);
      }
    }
    const external = {
      hook_event_name: 'PreToolUse', project_dir: value.dir,
      tool_name: 'mcp__unrelated_provider__mutate', tool_input: {},
    };
    // A legacy pair's first identity may itself resemble the alias domain.
    // Its two-element JSON must never masquerade as a child-only tombstone.
    const legacyPairHash = evidenceHash(['canary-child-v1', 'unrelated-child']);
    expect(legacyPairHash).not.toBe(aliasEvidenceHash(['canary-child-v1', 'unrelated-child']));
    for (const directory of [value.paths.bindingProbeQuarantine, value.paths.bindingProbeQuarantineFallback]) {
      const file = quarantinePath(directory, legacyPairHash);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify({ version: 1, identity_hash: legacyPairHash, retired_at: new Date().toISOString() }));
    }
    for (const identity of [
      { session_id: 'unrelated-child' },
      { session_id: 'parent-session' },
      { session_id: 'parent-session', turn_id: 'parent-turn' },
      { session_id: 'unrelated-parent', turn_id: 'separate-child-turn' },
    ]) expect(await invokeCodexHook(root, { ...external, ...identity }, ['--ape-canary-only'])).toEqual({});
    const candidates = path.join(value.paths.runtime, 'codex-bootstrap-candidates');
    await rename(candidates, `${candidates}.saved`);
    await writeFile(candidates, 'damaged candidate container');
    await writeFile(value.paths.bindingProbe, '{torn');
    for (const identity of [
      { session_id: 'child-agent', turn_id: 'unobserved-resume-turn' },
      { session_id: 'child-agent', agent_id: 'contradictory-agent', model: 'wrong-model' },
      { session_id: 'parent-session', turn_id: 'separate-child-turn', model: 'wrong-model' },
    ]) expect(denied(await invokeCodexHook(root, { ...external, ...identity }, ['--ape-canary-only']))).toBe(true);
  });

  it('recovers exact canary aliases from a valid pre-alias bound projection', async () => {
    const value = await fixture();
    await invokeCodexHook(root, child(value));
    expect(context(await invokeCodexHook(root, bind(value)))).toContain('APE_PROBE_CAPABILITY=');
    for (const directory of [value.paths.bindingProbeQuarantine, value.paths.bindingProbeQuarantineFallback]) {
      for (const hash of [
        aliasEvidenceHash(['canary-child-v1', 'child-agent']),
        aliasEvidenceHash(['canary-turn-v1', 'parent-session', 'separate-child-turn']),
      ]) {
        const file = quarantinePath(directory, hash);
        await rename(file, `${file}.saved`);
      }
    }
    const candidates = path.join(value.paths.runtime, 'codex-bootstrap-candidates');
    await rename(candidates, `${candidates}.saved`);
    await writeFile(candidates, 'damaged candidate container');
    const response = await invokeCodexHook(root, {
      hook_event_name: 'PreToolUse', project_dir: value.dir,
      session_id: 'parent-session', turn_id: 'separate-child-turn', agent_id: 'contradictory-agent',
      tool_name: 'mcp__unrelated_provider__mutate', tool_input: {},
    }, ['--ape-canary-only']);
    expect(denied(response)).toBe(true);
    await writeFile(value.paths.bindingProbe, '{torn');
    expect(denied(await invokeCodexHook(root, {
      hook_event_name: 'PreToolUse', project_dir: value.dir,
      session_id: 'child-agent', tool_name: 'mcp__unrelated_provider__mutate', tool_input: {},
    }, ['--ape-canary-only']))).toBe(true);
  });

  it('migrates a pre-alias bound child before replacing its mutable probe projection', async () => {
    const value = await fixture();
    await invokeCodexHook(root, child(value));
    expect(context(await invokeCodexHook(root, bind(value)))).toContain('APE_PROBE_CAPABILITY=');
    for (const directory of [value.paths.bindingProbeQuarantine, value.paths.bindingProbeQuarantineFallback]) {
      for (const hash of [
        aliasEvidenceHash(['canary-child-v1', 'child-agent']),
        aliasEvidenceHash(['canary-turn-v1', 'parent-session', 'separate-child-turn']),
      ]) {
        const file = quarantinePath(directory, hash);
        await rename(file, `${file}.saved`);
      }
    }
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 6 * 60_000);
    const replacement = await prepareBindingProbe(value.paths, { host: 'codex', model });
    vi.useRealTimers();
    expect(replacement.probe.probe_id).not.toBe(value.action.probe.probe_id);
    const candidates = path.join(value.paths.runtime, 'codex-bootstrap-candidates');
    await rename(candidates, `${candidates}.saved`);
    await writeFile(candidates, 'damaged candidate container');
    expect(denied(await invokeCodexHook(root, {
      hook_event_name: 'PreToolUse', project_dir: value.dir,
      session_id: 'child-agent', turn_id: 'late-unobserved-turn',
      tool_name: 'mcp__unrelated_provider__mutate', tool_input: {},
    }, ['--ape-canary-only']))).toBe(true);
  });

  it('persists only an exact-token rejection when candidate normalization denies the real bootstrap hook', async () => {
    const value = await fixture();
    await invokeCodexHook(root, child(value));
    const input = bind(value, { session_id: 'child-agent', agent_id: 'contradictory-agent' });
    const before = await readFile(value.paths.bindingProbe, 'utf8');
    await invokeCodexHook(root, input, ['--ape-canary-only']);
    expect(await readFile(value.paths.bindingProbe, 'utf8')).toBe(before);
    const response = await invokeCodexHook(root, input);
    expect(denied(response)).toBe(true);
    expect(context(response)).toBeUndefined();
    const status = await bindingProbeStatus(value.paths);
    expect(status).toMatchObject({ status: 'launched', infrastructure_status: 'failed',
      binding_observation: { outcome: 'rejected', code: 'bootstrap_candidate_invalid' } });
    const persisted = JSON.parse(await readFile(value.paths.bindingProbe, 'utf8')).last_binding_observation;
    expect(Object.keys(persisted).sort()).toEqual(['code', 'observed_at', 'outcome']);
    expect(JSON.stringify(persisted)).not.toContain(value.action.dispatch.bootstrap_args.bootstrap_capability);
    expect(JSON.stringify(persisted)).not.toContain(value.dir);
    expect(JSON.stringify(persisted)).not.toContain('contradictory-agent');
  });
});
