import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  acknowledgeBindingProbe,
  bindBindingProbe,
  bindingProbeStatus,
  bootstrapBindingProbe,
  launchBindingProbe,
  prepareBindingProbe,
  projectBindingProbe,
  recordBindingProbeBootstrapRejection,
} from '../lib/runtime/binding-probe.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { atomicWriteJson, readJson } from '../lib/runtime/storage.js';

const cleanups = [];
const model = { model: 'gpt-5.6-terra', reasoning_effort: 'medium' };
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(cleanups.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'ape-probe-diagnostics-'));
  cleanups.push(directory);
  const paths = runtimePaths(directory);
  await mkdir(paths.runtime, { recursive: true });
  return paths;
}

const prepare = (paths) => prepareBindingProbe(paths, { host: 'codex', model });
async function launch(paths, action, call = 'spawn-call') {
  expect(await launchBindingProbe(paths, {
    session_id: 'parent-session', turn_id: 'parent-turn', tool_use_id: call,
    tool_name: 'collaborationspawn_agent', tool_input: action.dispatch.spawn_args,
  })).toMatchObject({ valid: true });
}

async function candidate(paths, { agent = 'diagnostic-child', effectiveModel = model.model } = {}) {
  const native = {
    session_id: 'parent-session', turn_id: `turn-${agent}`, agent_id: agent,
    agent_type: 'default', ...(effectiveModel === null ? {} : { model: effectiveModel }),
  };
  const result = await bindBindingProbe(paths, native);
  return { native, result };
}

function bootstrap(action, native) {
  return {
    session_id: native.agent_id, turn_id: native.turn_id, tool_use_id: `bootstrap-${native.agent_id}`,
    tool_name: 'mcp__ape__ape_bind', tool_input: action.dispatch.bootstrap_args,
  };
}

describe('offline native probe failure reporting', () => {
  it('reads legacy failure status without publishing quarantine during read-only session guidance', async () => {
    const paths = await fixture();
    const now = new Date().toISOString();
    await atomicWriteJson(paths.bindingProbe, {
      version: 1, host: 'codex', agent_type: 'explorer', probe_id: 'probe-legacy-diagnostic',
      status: 'bound', bound_session_id: 'legacy-parent', bound_agent_id: 'legacy-child',
      bound_at: now, expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
    });
    const before = await readFile(paths.bindingProbe, 'utf8');
    const readOnly = await bindingProbeStatus(paths, { readOnly: true });
    expect(readOnly.infrastructure_status).toBe('failed');
    expect(await readdir(paths.runtime)).toEqual([path.basename(paths.bindingProbe)]);
    expect(await readFile(paths.bindingProbe, 'utf8')).toBe(before);
    expect(await bindingProbeStatus(paths)).toEqual(readOnly);
    expect((await readdir(paths.runtime)).length).toBeGreaterThan(1);
  });

  it('records an early hook failure without claiming authority even if native evidence has recovered', async () => {
    const paths = await fixture();
    const action = await prepare(paths);
    await launch(paths, action);
    const { native } = await candidate(paths);
    const before = await readJson(paths.bindingProbe);
    const [intentName] = (await readdir(paths.dispatchIntents)).filter((name) => name.endsWith('.json'));
    const intentPath = path.join(paths.dispatchIntents, intentName);
    const intentBefore = await readFile(intentPath, 'utf8');
    const result = await recordBindingProbeBootstrapRejection(
      paths, bootstrap(action, native), 'bootstrap_candidate_invalid',
    );
    expect(result).toEqual({
      recorded: true,
      binding_observation: { observed_at: expect.any(String), outcome: 'rejected', code: 'bootstrap_candidate_invalid' },
    });
    const { last_binding_observation, ...authority } = await readJson(paths.bindingProbe);
    expect(authority).toEqual(before);
    expect(last_binding_observation).toEqual(result.binding_observation);
    expect(await readFile(intentPath, 'utf8')).toBe(intentBefore);
    expect(await readdir(paths.runtime)).not.toContain(path.basename(paths.bindingProbeQuarantine));
    expect((await bindingProbeStatus(paths)).status).toBe('launched');
  });

  it('ignores diagnostic writes without an exact launched probe token or fixed typed code', async () => {
    const paths = await fixture();
    const action = await prepare(paths);
    const input = bootstrap(action, { agent_id: 'unobserved-child', turn_id: 'unobserved-turn' });
    const prepared = await readFile(paths.bindingProbe, 'utf8');
    expect(await recordBindingProbeBootstrapRejection(paths, input, 'bootstrap_candidate_invalid')).toEqual({ recorded: false });
    expect(await readFile(paths.bindingProbe, 'utf8')).toBe(prepared);
    await launch(paths, action);
    const launched = await readFile(paths.bindingProbe, 'utf8');
    for (const [event, code] of [
      [{ ...input, tool_name: 'mcp__unrelated__ape_bind' }, 'bootstrap_candidate_invalid'],
      [{ ...input, tool_input: { ...input.tool_input, bootstrap_capability: 'Z'.repeat(48) } }, 'bootstrap_candidate_invalid'],
      [input, `raw-error-${action.dispatch.bootstrap_args.bootstrap_capability}`],
    ]) {
      expect(await recordBindingProbeBootstrapRejection(paths, event, code)).toEqual({ recorded: false });
      expect(await readFile(paths.bindingProbe, 'utf8')).toBe(launched);
    }
  });

  it('reports the elapsed launch deadline as failed without expiring or replacing its live reservation', async () => {
    const paths = await fixture();
    const action = await prepare(paths);
    await launch(paths, action);
    const before = await readFile(paths.bindingProbe, 'utf8');
    const record = JSON.parse(before);
    const deadline = Date.parse(record.launch_expires_at);
    expect(projectBindingProbe(record, deadline - 1).infrastructure_status).toBe('awaiting_binding');
    expect(projectBindingProbe(record, deadline)).toMatchObject({
      status: 'launched', infrastructure_status: 'failed', launch_expires_at: record.launch_expires_at,
      reason: expect.stringMatching(/launch.*expired/i),
    });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(deadline);
    expect((await bindingProbeStatus(paths)).infrastructure_status).toBe('failed');
    await expect(prepare(paths)).rejects.toThrow(/already launched/);
    expect(await readFile(paths.bindingProbe, 'utf8')).toBe(before);
  });

  it('retains a bounded exact-token production rejection in probe status', async () => {
    const paths = await fixture();
    const action = await prepare(paths);
    await launch(paths, action);
    const { native } = await candidate(paths, { effectiveModel: 'gpt-5.4-mini' });
    const refused = await bootstrapBindingProbe(paths, bootstrap(action, native));
    expect(refused).toMatchObject({ valid: false, binding_observation: { code: 'native_model_mismatch' } });
    const status = await bindingProbeStatus(paths);
    expect(status).toMatchObject({
      status: 'launched', infrastructure_status: 'failed',
      binding_observation: { outcome: 'rejected', code: 'native_model_mismatch' },
    });
    const observation = (await readJson(paths.bindingProbe)).last_binding_observation;
    expect(Object.keys(observation).sort()).toEqual(['code', 'observed_at', 'outcome']);
    for (const secret of [action.dispatch.bootstrap_args.bootstrap_capability, native.agent_id, paths.root]) {
      expect(JSON.stringify(observation)).not.toContain(secret);
    }
  });

  it('distinguishes missing and conflicting native candidate evidence after the exact current token is presented', async () => {
    const paths = await fixture();
    const action = await prepare(paths);
    await launch(paths, action);
    const missing = { agent_id: 'unknown-child', turn_id: 'unknown-turn' };
    expect((await bootstrapBindingProbe(paths, bootstrap(action, missing))).valid).toBe(false);
    expect((await bindingProbeStatus(paths)).binding_observation).toMatchObject({
      outcome: 'rejected', code: 'bootstrap_candidate_unavailable',
    });
    const { native } = await candidate(paths);
    expect((await bootstrapBindingProbe(paths, {
      ...bootstrap(action, native), agent_id: 'forged-child',
    })).valid).toBe(false);
    expect((await bindingProbeStatus(paths)).binding_observation).toMatchObject({
      outcome: 'rejected', code: 'bootstrap_candidate_invalid',
    });
  });

  it('does not erase successful binding and acknowledgement proof when unrelated candidate evidence is malformed', async () => {
    const paths = await fixture();
    const action = await prepare(paths);
    await launch(paths, action);
    const { native } = await candidate(paths);
    const bound = await bootstrapBindingProbe(paths, bootstrap(action, native));
    expect(bound.valid).toBe(true);
    const before = await readFile(paths.bindingProbe, 'utf8');
    expect(await recordBindingProbeBootstrapRejection(
      paths, bootstrap(action, native), 'bootstrap_candidate_invalid',
    )).toEqual({ recorded: false });
    expect((await bootstrapBindingProbe(paths, bootstrap(action, {
      agent_id: 'unknown-child', turn_id: 'unknown-turn',
    }))).valid).toBe(false);
    expect(await readFile(paths.bindingProbe, 'utf8')).toBe(before);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse(JSON.parse(before).launch_expires_at) + 1);
    expect(await bindingProbeStatus(paths)).toMatchObject({
      status: 'bound', infrastructure_status: 'awaiting_acknowledgement',
      binding_observation: { outcome: 'accepted', code: 'bound' },
    });
    const capability = bound.additional_context.match(/^APE_PROBE_CAPABILITY=(.+)$/m)[1];
    expect((await acknowledgeBindingProbe(paths, {
      probe_id: action.probe.probe_id, probe_capability: capability,
    })).infrastructure_status).toBe('ready');
    const completed = await readFile(paths.bindingProbe, 'utf8');
    expect((await bootstrapBindingProbe(paths, bootstrap(action, {
      agent_id: 'unknown-child', turn_id: 'unknown-turn',
    }))).valid).toBe(false);
    expect(await readFile(paths.bindingProbe, 'utf8')).toBe(completed);
    expect((await bindingProbeStatus(paths)).infrastructure_status).toBe('ready');
  });

  it('does not assign an unbound malformed or zero-tool candidate to the newest probe without its token', async () => {
    const paths = await fixture();
    const action = await prepare(paths);
    await launch(paths, action);
    const { result } = await candidate(paths, { effectiveModel: null });
    expect(result.valid).toBe(false);
    const status = await bindingProbeStatus(paths);
    expect(status.infrastructure_status).toBe('awaiting_binding');
    expect(status).not.toHaveProperty('binding_observation');
  });

  it('does not write stale A diagnostic failure into replacement B', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const paths = await fixture();
    const first = await prepare(paths);
    await launch(paths, first);
    const { native } = await candidate(paths);
    vi.setSystemTime(Date.now() + 6 * 60_000);
    const second = await prepare(paths);
    await launch(paths, second, 'second-spawn');
    const before = await readFile(paths.bindingProbe, 'utf8');
    expect(await recordBindingProbeBootstrapRejection(
      paths, bootstrap(first, native), 'bootstrap_candidate_invalid',
    )).toEqual({ recorded: false });
    expect((await bootstrapBindingProbe(paths, bootstrap(first, native))).valid).toBe(false);
    expect(await readFile(paths.bindingProbe, 'utf8')).toBe(before);
    expect(await bindingProbeStatus(paths)).toMatchObject({
      probe_id: second.probe.probe_id, infrastructure_status: 'awaiting_binding',
    });
  });
});
