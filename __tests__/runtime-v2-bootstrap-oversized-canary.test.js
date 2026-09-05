import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareBindingProbe } from '../lib/runtime/binding-probe.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { invokeCodexHook } from './codex-native-test-helper.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cleanups = [];
const oversizedPayload = 'x'.repeat(8 * 1024 * 1024 + 1);
const denied = (response) => response.hookSpecificOutput?.permissionDecision === 'deny' || response.decision === 'deny';

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function boundCanary() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-bootstrap-oversized-canary-'));
  cleanups.push(dir);
  await mkdir(runtimePaths(dir).runtime, { recursive: true });
  const action = await prepareBindingProbe(runtimePaths(dir), {
    host: 'codex', model: { model: 'gpt-5.4-mini', reasoning_effort: 'low' },
  });
  expect(denied(await invokeCodexHook(root, {
    hook_event_name: 'PreToolUse', project_dir: dir,
    session_id: 'parent-session', turn_id: 'parent-turn', tool_use_id: 'spawn-call',
    tool_name: 'collaborationspawn_agent', tool_input: action.dispatch.spawn_args,
  }))).toBe(false);
  expect(denied(await invokeCodexHook(root, {
    hook_event_name: 'SubagentStart', project_dir: dir,
    session_id: 'parent-session', turn_id: 'child-turn', agent_id: 'canary-child',
    agent_type: 'default', model: 'gpt-5.4-mini',
  }))).toBe(false);
  const binding = await invokeCodexHook(root, {
    hook_event_name: 'PreToolUse', project_dir: dir,
    session_id: 'canary-child', turn_id: 'child-turn', tool_use_id: 'bootstrap-call',
    tool_name: 'ape_bind', tool_input: action.dispatch.bootstrap_args,
  });
  expect(binding.hookSpecificOutput?.additionalContext).toContain('APE_PROBE_CAPABILITY=');
  return dir;
}

function externalCall(dir, identity) {
  return {
    hook_event_name: 'PreToolUse', project_dir: dir,
    ...identity, tool_name: 'mcp__unrelated_provider__mutate',
    tool_input: { payload: oversizedPayload },
  };
}

describe('oversized wildcard canary fence retains bootstrap child aliases', () => {
  it.each([
    ['parent alias', { session_id: 'parent-session', turn_id: 'child-turn' }],
    ['child alias', { session_id: 'canary-child', turn_id: 'child-turn' }],
    ['camelCase child alias', { sessionId: 'canary-child', turnId: 'child-turn' }],
  ])('denies an oversized external call using %s without agent_id', async (_label, identity) => {
    const dir = await boundCanary();
    const response = await invokeCodexHook(root, externalCall(dir, identity), ['--ape-canary-only']);
    expect(denied(response)).toBe(true);
  });

  it('denies an observed child when the oversized call no longer carries its observed turn', async () => {
    const dir = await boundCanary();
    for (const identity of [
      { session_id: 'canary-child', turn_id: 'new-unobserved-turn' },
      { session_id: 'canary-child' },
    ]) {
      const response = await invokeCodexHook(root, externalCall(dir, identity), ['--ape-canary-only']);
      expect(denied(response)).toBe(true);
    }
  });

  it('leaves unrelated calls and nested child-looking fields neutral', async () => {
    const dir = await boundCanary();
    const unrelated = externalCall(dir, { session_id: 'other-session', turn_id: 'other-turn' });
    unrelated.tool_input.identity = {
      project_dir: dir, session_id: 'canary-child', turn_id: 'child-turn', agent_id: 'canary-child',
    };
    expect(await invokeCodexHook(root, unrelated, ['--ape-canary-only'])).toEqual({});
    expect(await invokeCodexHook(root,
      externalCall(dir, { session_id: 'parent-session', turn_id: 'parent-turn' }),
      ['--ape-canary-only'])).toEqual({});
  });

  it('keeps unrelated oversized calls neutral when candidate storage is damaged while denying the known child', async () => {
    const dir = await boundCanary();
    const candidates = path.join(runtimePaths(dir).runtime, 'codex-bootstrap-candidates');
    await rename(candidates, `${candidates}.saved`);
    await writeFile(candidates, 'damaged candidate container');
    expect(await invokeCodexHook(root,
      externalCall(dir, { session_id: 'unrelated-session', turn_id: 'unrelated-turn' }),
      ['--ape-canary-only'])).toEqual({});
    const response = await invokeCodexHook(root,
      externalCall(dir, { session_id: 'canary-child', turn_id: 'child-turn' }),
      ['--ape-canary-only']);
    expect(denied(response)).toBe(true);
  });

  it('preserves normal parent recovery and unrelated integrations when candidate storage is damaged', async () => {
    const dir = await boundCanary();
    const candidates = path.join(runtimePaths(dir).runtime, 'codex-bootstrap-candidates');
    await rename(candidates, `${candidates}.saved`);
    await writeFile(candidates, 'damaged candidate container');
    const parentRecovery = {
      hook_event_name: 'PreToolUse', project_dir: dir,
      session_id: 'parent-session', turn_id: 'parent-turn',
      tool_name: 'ape_run', tool_input: { project_dir: dir, action: 'status' },
    };
    expect(await invokeCodexHook(root, parentRecovery)).toEqual({});
    expect(await invokeCodexHook(root, {
      ...parentRecovery, session_id: 'unrelated-session', turn_id: 'unrelated-turn',
      tool_name: 'mcp__unrelated_provider__mutate', tool_input: {},
    })).toEqual({});
    for (const tool_name of ['ape_run', 'mcp__unrelated_provider__mutate']) {
      const response = await invokeCodexHook(root, {
        ...parentRecovery, session_id: 'canary-child', turn_id: 'child-turn', tool_name,
      });
      expect(denied(response)).toBe(true);
    }
  });
});
