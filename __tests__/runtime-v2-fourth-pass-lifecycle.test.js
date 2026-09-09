import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const interleave = vi.hoisted(() => ({ afterLiveness: null }));
const configRead = vi.hoisted(() => ({ file: null, reached: null, wait: null }));
vi.mock('../lib/runtime/bounded-file.js', async (original) => {
  const actual = await original();
  return { ...actual, readBoundedJson: async (...args) => {
    const value = await actual.readBoundedJson(...args);
    if (args[0] === configRead.file) {
      configRead.file = null;
      configRead.reached();
      await configRead.wait;
    }
    return value;
  } };
});
vi.mock('../lib/runtime/status-service.js', async (original) => {
  const actual = await original();
  return {
    ...actual,
    dispatchLiveness: async (...args) => {
      const snapshot = await actual.dispatchLiveness(...args);
      const effect = interleave.afterLiveness;
      interleave.afterLiveness = null;
      if (effect) await effect();
      return snapshot;
    },
  };
});

import { abortRun, answerPreflight, configAction, resumeRun, startRun, withReceiptLock } from '../lib/runtime/service.js';
import { inspectRunLock, releaseRunLock } from '../lib/runtime/lock.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { atomicWriteJson, readJson } from '../lib/runtime/storage.js';
import { bindClaudeSubagent, bindCodexSubagent, bootstrapCodexSubagent, launchClaudeIntent, launchCodexIntent } from '../lib/runtime/claude-dispatch.js';

const directories = [];
afterEach(async () => {
  interleave.afterLiveness = null;
  configRead.file = null;
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function scratchDirectory() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-fourth-lifecycle-'));
  directories.push(dir);
  return dir;
}

async function startedProject(host = 'claude') {
  const dir = await scratchDirectory();
  await writeFile(path.join(dir, 'README.md'), '# Resume fixture\n');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'APE Test');
  git(dir, 'config', 'user.email', 'ape@example.test');
  git(dir, 'add', 'README.md');
  git(dir, 'commit', '-qm', 'baseline');
  const paths = runtimePaths(dir);
  await atomicWriteJson(paths.config, { shipping: { auto_merge: false } });
  const started = await startRun(dir, {
    objective: 'Inspect the fixture', mode: 'debug', host, lane: 'full',
    claimed_paths: [], test_paths: [], behavioral: false,
    hooks_trusted: true, subagents_available: true, explicit_invocation: true,
  });
  expect(started.ok).toBe(true);
  return { dir, paths, run: started.run, actions: started.actions };
}

describe('fourth-pass lifecycle serialization', () => {
  it.each([
    { host: 'claude', timing: 'after parent lock loss' },
    { host: 'codex', timing: 'after parent lock loss' },
    { host: 'claude', timing: 'while native binding races resume' },
    { host: 'codex', timing: 'while native binding races resume' },
  ])('retains a bound $host worker $timing', async ({ host, timing }) => {
    const { dir, paths, run, actions } = await startedProject(host);
    const action = actions.find((entry) => entry.type === 'dispatch_agent');
    const launch = { session_id: 'fourth-parent', turn_id: 'fourth-turn', tool_use_id: 'fourth-launch',
      tool_input: host === 'codex' ? action.dispatch.spawn_args : {
        subagent_type: action.dispatch.agent_type, prompt: action.dispatch.dispatch_intent.prompt,
        model: action.dispatch.model.model,
      },
    };
    const launched = await (host === 'codex' ? launchCodexIntent : launchClaudeIntent)(paths, run, launch);
    expect(launched.valid).toBe(true);
    const identity = { session_id: 'fourth-parent', turn_id: 'fourth-turn', agent_id: 'fourth-child',
      agent_type: host === 'codex' ? 'default' : action.dispatch.agent_type,
      ...(host === 'codex' ? { model: action.dispatch.model.model } : {}),
    };
    const intentFile = path.join(paths.dispatchIntents, (await readdir(paths.dispatchIntents)).find((name) => name.endsWith('.json')));
    let before;
    const bindWorker = async () => {
      expect((await (host === 'codex' ? bindCodexSubagent : bindClaudeSubagent)(paths, run, identity)).valid).toBe(true);
      if (host === 'codex') {
        expect((await bootstrapCodexSubagent(paths, run, { ...identity, session_id: 'fourth-child',
          tool_name: 'mcp__ape__ape_bind', tool_use_id: 'fourth-bootstrap', tool_input: action.dispatch.bootstrap_args,
        })).valid).toBe(true);
      }
      before = await readFile(intentFile, 'utf8');
      expect(JSON.parse(before).status).toBe('bound');
    };
    if (timing === 'after parent lock loss') {
      await bindWorker();
      await releaseRunLock(paths.lock, run.run_id);
    } else {
      interleave.afterLiveness = bindWorker;
    }

    const resumed = await resumeRun(dir);
    expect(resumed.ok).toBe(true);
    expect(resumed.actions.map(({ type, ticket_id }) => ({ type, ticket_id }))).toEqual([
      { type: 'dispatch_pending', ticket_id: run.tickets[0].ticket_id },
    ]);
    expect(resumed.resume_state).toBe(timing === 'after parent lock loss' ? 'recovered-orphan' : 'already-live');
    expect(await readFile(intentFile, 'utf8')).toBe(before);
    expect(await inspectRunLock(paths.lock)).toMatchObject({ present: true, run_id: run.run_id });
  });

  it('serializes orphan recovery with abort so resume cannot resurrect a sealed run lock', async () => {
    const { dir, paths, run } = await startedProject();
    await releaseRunLock(paths.lock, run.run_id);
    let releaseLiveness;
    let livenessReached;
    const liveness = new Promise((resolve) => { livenessReached = resolve; });
    const release = new Promise((resolve) => { releaseLiveness = resolve; });
    interleave.afterLiveness = async () => { livenessReached(); await release; };

    const resumed = resumeRun(dir);
    await liveness;
    let abortEntered = false;
    // Queue exactly the same receipt-effects transaction used by abortRun.
    // Before the fix it enters while resume is paused with an orphan snapshot;
    // after the fix it waits until resume has completed its recovery.
    const barrier = withReceiptLock(paths, async () => { abortEntered = true; });
    const aborted = abortRun(dir, 'Finish the concurrent abort', run.run_id);
    await Promise.race([aborted, sleep(1000)]);
    const interleaved = abortEntered;
    releaseLiveness();
    const [, , result] = await Promise.all([resumed, barrier, aborted]);

    expect(result.ok).toBe(true);
    expect((await readJson(paths.active)).status).toBe('aborted');
    expect(await inspectRunLock(paths.lock)).toMatchObject({ present: false });
    expect(interleaved, 'resume liveness and lock recovery must share the receipt-effects critical section').toBe(false);
  });

  it.each([
    ['reserved runtime claim', { claimed_paths: ['.ape/runtime/payload.js'] }],
    ['trailing-dot production alias', { claimed_paths: ['src/value.js.'] }],
    ['case-colliding production claim', { claimed_paths: ['readme.MD'] }],
    ['option-like test path', { test_paths: ['-tests/value.test.js'] }],
    ['case-colliding test path', { test_paths: ['TESTS/value.test.js'] }],
  ])('rejects %s before consuming a preflight answer or publishing successor authority', async (_label, additions) => {
    const { dir, paths, run } = await startedProject();
    const held = { ...run, mode: 'phase', lane: 'full', stage: 'preflight', status: 'input_required',
      behavioral: true, plan_contract_version: 2, tickets: [], receipts: [],
      claimed_paths: ['README.md'], test_paths: ['tests/value.test.js'],
      preflight: { artifact_hash: 'a'.repeat(64), questions: [{ id: 'scope', question: 'Which scope?' }] },
      input_required: { preflight_hash: 'a'.repeat(64) },
    };
    // Legacy preflight states remain answerable after a runtime upgrade too;
    // canonical scope validation must not depend on a newer capability budget.
    delete held.capability_snapshot;
    delete held.run_contract;
    await atomicWriteJson(paths.active, held);
    const before = await readFile(paths.active, 'utf8');
    const result = await answerPreflight(dir, { preflight_hash: 'a'.repeat(64),
      reason: 'Resolve the scope question', answers: [{ id: 'scope', answer: 'Use the supplied scope' }],
      ...additions,
    }).catch((error) => ({ ok: false, reason: error.message }));
    expect(result.ok).toBe(false);
    expect(await readFile(paths.active, 'utf8')).toBe(before);
  });
});

describe('fourth-pass config initialization transactions', () => {
  it('leaves existing config bytes unchanged when several valid init slots exceed the aggregate budget', async () => {
    const dir = await scratchDirectory();
    const file = runtimePaths(dir).config;
    await configAction(dir, 'set', { key: 'test_commands.full', value: 'base '.repeat(8000) });
    const before = await readFile(file, 'utf8');
    await expect(configAction(dir, 'init', { apply: true,
      values: { targeted: 'one '.repeat(5000), targeted_template: 'two '.repeat(5000) },
    })).rejects.toThrow(/input exceeds 65536/);
    expect((await readFile(file, 'utf8')) === before, 'rejected init must preserve exact stored bytes').toBe(true);
  });

  it('preserves both concurrent additive evidence-script approvals and their provenance', async () => {
    const dir = await scratchDirectory();
    const file = runtimePaths(dir).config;
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({
      scripts: { 'check:alpha': 'node --version', 'check:beta': 'node --version' },
    }));
    await configAction(dir, 'set', { key: 'custom.seed', value: 'preserve' });
    let reached;
    let release;
    const arrived = new Promise((resolve) => { reached = resolve; });
    Object.assign(configRead, { file, reached,
      wait: new Promise((resolve) => { release = resolve; }),
    });
    const first = configAction(dir, 'init', { apply: true, evidence_scripts: ['check:alpha'] });
    await arrived;
    const second = configAction(dir, 'init', { apply: true, evidence_scripts: ['check:beta'] });
    await Promise.race([second, sleep(1000)]);
    release();
    const results = await Promise.all([first, second]);
    expect(results.every((result) => result.ok)).toBe(true);
    const stored = await readJson(file);
    expect(stored.policy.evidence_scripts).toEqual(expect.arrayContaining(['check:alpha', 'check:beta']));
    expect(stored.custom.seed).toBe('preserve');
    expect(stored.explicit_keys).toEqual(expect.arrayContaining(['custom.seed', 'policy.evidence_scripts']));
    expect(results[1].init.applied_keys).toContain('policy.evidence_scripts');
  });
});
