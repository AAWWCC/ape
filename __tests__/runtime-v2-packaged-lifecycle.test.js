import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const repository = fileURLToPath(new URL('../', import.meta.url));
const roots = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))));

// Run copied shipping artifacts with no dependency installation and a fresh
// process for every call. Host events are fixture inputs, not live host proof.
async function jsonProcess(binary, input, cwd, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binary], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    let errors = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
    child.stdout.on('data', (data) => { output += data; });
    child.stderr.on('data', (data) => { errors += data; });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) { reject(new Error(`packaged process exited ${code}: ${errors}`)); return; }
      try { resolve(output.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))); }
      catch (error) { reject(new Error(`invalid packaged JSON: ${error.message}; ${output}; ${errors}`)); }
    });
    child.stdin.end(`${JSON.stringify(input)}\n`);
  });
}

async function fixture(host, failGate) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'ape packaged lifecycle ')));
  roots.push(root);
  const project = path.join(root, 'project with spaces');
  const plugin = path.join(root, 'plugin with spaces');
  await mkdir(project);
  await cp(path.join(repository, 'plugins', host === 'codex' ? 'ape' : 'ape-claude'), plugin, { recursive: true });
  await expect(lstat(path.join(plugin, 'node_modules'))).rejects.toMatchObject({ code: 'ENOENT' });
  const control = path.join(root, 'gate-control.json');
  await writeFile(control, JSON.stringify({ fail: failGate }));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:APE_|CLAUDE|CODEX_CWD|GIT_)/.test(key)));
  const gitConfig = path.join(root, 'empty-git-config');
  await writeFile(gitConfig, '');
  Object.assign(env, { GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' });
  const git = (...args) => execFileSync('git', args, { cwd: project, env, encoding: 'utf8' }).trim();
  await writeFile(path.join(project, '.gitignore'), '.ape/\n');
  await writeFile(path.join(project, 'package.json'), JSON.stringify({ private: true, scripts: { test: 'node --test value.test.cjs' } }));
  await writeFile(path.join(project, 'value.cjs'), 'module.exports = 1;\n');
  await writeFile(path.join(project, 'value.test.cjs'), 'require("node:assert/strict").equal(require("./value.cjs"), 1);\n');
  await writeFile(path.join(project, 'gate.cjs'), [
    `const control = JSON.parse(require('node:fs').readFileSync(${JSON.stringify(control)}, 'utf8'));`,
    "if (control.fail) { console.error('controlled full-suite failure'); process.exit(1); }",
    "const result = require('node:child_process').spawnSync(process.execPath, ['--test', 'value.test.cjs'], { stdio: 'inherit' });",
    'process.exit(result.status ?? 1);',
  ].join('\n'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'APE Test');
  git('config', 'user.email', 'ape@example.test');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.autocrlf', 'false');
  git('add', '.');
  git('commit', '-qm', 'fixture baseline');
  const runtime = path.join(project, '.ape/runtime');
  await mkdir(runtime, { recursive: true });
  await writeFile(path.join(runtime, 'config.json'), JSON.stringify({
    shipping: { auto_merge: false, provider: 'github', required_remote_checks: false },
    test_commands: { full: 'node gate.cjs', targeted_template: 'node --test {paths}' },
    verification: { profiles: [{ id: 'unit.core', description: 'Check the value contract', command: 'node --test value.test.cjs', root: '.', timeout_ms: 10_000 }] },
  }));
  let callId = 0;
  const rpc = async (name, args) => {
    const id = ++callId;
    const replies = await jsonProcess(path.join(plugin, 'dist/ape-mcp.bundle.mjs'), {
      jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: { project_dir: project, ...args } },
    }, project, env);
    const reply = replies.find((item) => item.id === id);
    if (reply.error) throw new Error(JSON.stringify(reply.error));
    const text = reply.result.content.find((item) => item.type === 'text')?.text;
    try { return JSON.parse(text); }
    catch { throw new Error(`packaged tool error: ${text}`); }
  };
  const hook = async (input) => {
    const replies = await jsonProcess(path.join(plugin, 'dist/ape-hooks.bundle.mjs'), { project_dir: project, ...input }, project,
      { ...env, ...(host === 'claude' ? { CLAUDECODE: '1', CLAUDE_PLUGIN_ROOT: plugin } : {}) });
    return replies[0];
  };
  const state = async () => JSON.parse(await readFile(path.join(runtime, 'active.json'), 'utf8'));
  return { root, project, plugin, runtime, control, env, rpc, hook, state };
}

async function bind(value, host, action, ordinal) {
  const dispatch = action.dispatch;
  const session = `fixture-parent-${ordinal}`;
  const agent = `fixture-agent-${ordinal}`;
  if (host === 'claude') {
    const launch = await value.hook({ hook_event_name: 'PreToolUse', session_id: session, tool_use_id: `launch-${ordinal}`, tool_name: 'Agent',
      tool_input: { subagent_type: dispatch.agent_type, prompt: dispatch.dispatch_intent.prompt, model: dispatch.model.model } });
    expect(launch.hookSpecificOutput?.permissionDecision).toBe('allow');
    const started = await value.hook({ hook_event_name: 'SubagentStart', session_id: session, agent_id: agent, agent_type: dispatch.agent_type });
    return started.hookSpecificOutput?.additionalContext ?? '';
  }
  await value.hook({ hook_event_name: 'PreToolUse', session_id: session, turn_id: 'parent-turn', tool_use_id: `launch-${ordinal}`,
    tool_name: 'collaborationspawn_agent', tool_input: { task_name: dispatch.agent_name, fork_turns: 'none',
      message: 'gAAAAABsynthetic-host-encrypted-message', model: dispatch.model.model, reasoning_effort: dispatch.model.reasoning_effort } });
  await value.hook({ hook_event_name: 'SubagentStart', session_id: session, turn_id: 'child-turn', agent_id: agent, agent_type: 'default', model: dispatch.model.model });
  const started = await value.hook({ hook_event_name: 'PreToolUse', session_id: session, turn_id: 'child-turn',
    tool_use_id: `bootstrap-${ordinal}`, tool_name: 'mcp__ape__ape_bind', tool_input: dispatch.bootstrap_args, model: dispatch.model.model });
  return started.hookSpecificOutput?.additionalContext ?? '';
}

function observeTests(value) {
  const started = Date.now();
  const result = spawnSync(process.execPath, ['--test', 'value.test.cjs'], { cwd: value.project, env: value.env, encoding: 'utf8', timeout: 10_000 });
  if (result.error) throw result.error;
  return { command: 'node --test value.test.cjs', passed: result.status === 0, exit_code: result.status,
    duration_ms: Date.now() - started, output_hash: createHash('sha256').update(`${result.stdout}${result.stderr}`).digest('hex') };
}

async function record(value, host, action, ordinal, evidence, tests) {
  const context = await bind(value, host, action, ordinal);
  const capability = context.match(/APE_RECEIPT_CAPABILITY=([A-Za-z0-9_-]+)/)?.[1];
  expect(capability, context).toBeTruthy();
  if (typeof tests === 'function') tests = await tests();
  const draft = { ticket_id: action.ticket.ticket_id, receipt_capability: capability, status: 'passed', tests, findings: [], evidence };
  const validated = await value.rpc('ape_validate_receipt', { ticket_id: draft.ticket_id, draft });
  expect(validated.valid, JSON.stringify(validated)).toBe(true);
  const result = await value.rpc('ape_run', { action: 'record', receipt: draft });
  expect(result.ok, JSON.stringify(result)).toBe(true);
  return { result, draft };
}

async function untilGatesSettle(value, result) {
  for (let attempt = 0; attempt < 60 && (await value.state()).status === 'gating'; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    result = await value.rpc('ape_run', { action: 'next' });
  }
  expect((await value.state()).status).not.toBe('gating');
  return result;
}

describe('packaged runtime lifecycle across fresh processes', () => {
  it.each(['codex', 'claude'].flatMap((host) => [false, true].map((failGate) => ({ host, failGate }))))(
    '$host preflight, authenticated receipts, restart and gate recovery (initial gate failure=$failGate)', async ({ host, failGate }) => {
      const value = await fixture(host, failGate);
      const facts = { objective: 'Change the fixture value from one to two', mode: 'phase', lane: 'fast', host,
        claimed_paths: ['value.cjs'], test_paths: ['value.test.cjs'], requirements: ['R1'], risk_triggers: [], behavioral: true,
        hooks_trusted: true, subagents_available: true, explicit_invocation: true, plan_contract_version: 2 };
      if (host === 'codex') {
        const probe = await value.rpc('ape_run', { action: 'probe', host, hooks_trusted: true, subagents_available: true, explicit_invocation: true });
        const context = await bind(value, host, probe.actions[0], 'probe');
        const capability = context.match(/APE_PROBE_CAPABILITY=([A-Za-z0-9_-]+)/)?.[1];
        expect(capability, JSON.stringify(probe)).toBeTruthy();
        expect(await value.rpc('ape_run', { action: 'probe-ack', probe_id: probe.probe.probe_id, probe_capability: capability })).toMatchObject({ ok: true });
      }
      const preview = await value.rpc('ape_run', { action: 'preview', ...facts });
      expect(preview.admission_digest, JSON.stringify(preview)).toMatch(/^[a-f0-9]{64}$/);
      const started = await value.rpc('ape_run', { action: 'start', ...facts, expected_admission_digest: preview.admission_digest });
      expect(started.ok, JSON.stringify(started)).toBe(true);
      expect((await value.state()).audit).toEqual([]);
      const runId = started.run.run_id;
      const baseline = observeTests(value);
      const artifact = { version: 1, objective: facts.objective, acceptance: ['The exported value is two'], non_goals: ['Unrelated changes'],
        baseline: [{ command: baseline.command, observation: 'The existing assertion passes', output_hash: baseline.output_hash }],
        impacted_paths: { read: ['package.json', 'value.cjs', 'value.test.cjs'], write: ['value.cjs', 'value.test.cjs'] },
        compatibility: 'Keep the CommonJS export.', rollback: 'Revert the two fixture edits.',
        verification_profiles: [{ id: 'unit.core', disposition: 'required', reason: 'This is a behavioral change.' }],
        questions: [{ id: 'export', question: 'Which export stays compatible?', rationale: 'Confirm the public contract.' }] };
      const preflight = started.actions.find((action) => action.type === 'dispatch_agent');
      const held = await record(value, host, preflight, 1, { preflight_artifact: artifact }, [baseline]);
      expect(held.result.run).toMatchObject({ run_id: runId, status: 'input_required', stage: 'preflight' });
      expect(await value.rpc('ape_run', { action: 'status' })).toMatchObject({ run: { run_id: runId, status: 'input_required' } });
      const answer = { action: 'answer-preflight', run_id: runId, preflight_hash: (await value.state()).preflight.artifact_hash,
        reason: 'Preserve the existing CommonJS export.', answers: [{ id: 'export', answer: 'Keep module.exports.' }] };
      let current = await value.rpc('ape_run', answer);
      expect(current.ok, JSON.stringify(current)).toBe(true);
      expect((await value.state()).audit.filter((entry) => entry.type === 'preflight_answered')).toHaveLength(1);
      await expect(value.rpc('ape_run', answer)).rejects.toThrow('answer-preflight is valid only while preflight input is required');
      expect((await value.state()).stage).toBe('test');
      for (const [index, stage] of ['test', 'build', 'review'].entries()) {
        const action = current.actions.find((entry) => entry.type === 'dispatch_agent' && entry.ticket.stage_id === stage);
        expect(action, JSON.stringify(current)).toBeTruthy();
        const recorded = await record(value, host, action, index + 2, stage === 'review' ? { verdict: 'pass' } : {}, async () => {
          if (stage === 'test') await writeFile(path.join(value.project, 'value.test.cjs'), 'require("node:assert/strict").equal(require("./value.cjs"), 2);\n');
          if (stage === 'build') await writeFile(path.join(value.project, 'value.cjs'), 'module.exports = 2;\n');
          const observed = observeTests(value);
          expect(observed.passed).toBe(stage !== 'test');
          return [observed];
        });
        current = recorded.result;
        // Response loss/restart must replay the exact receipt without advancing
        // the stage or creating a duplicate chain entry.
        const before = await value.state();
        const replay = await value.rpc('ape_run', { action: 'record', receipt: recorded.draft });
        expect(replay.ok, JSON.stringify(replay)).toBe(true);
        expect(replay.idempotent, JSON.stringify(replay)).toBe(true);
        const after = await value.state();
        expect(after.receipts).toEqual(before.receipts);
        expect(after.tickets).toEqual(before.tickets);
      }
      await untilGatesSettle(value, current);
      let gated = await value.state();
      if (failGate) {
        expect(gated.gates.passed).toBe(false);
        expect(gated.status).toBe('blocked');
        await writeFile(value.control, JSON.stringify({ fail: false }));
        await untilGatesSettle(value, await value.rpc('ape_run', { action: 'regate' }));
        gated = await value.state();
      }
      expect(gated.gates.passed, JSON.stringify(gated.gates)).toBe(true);
      expect(gated.gates.checks.verification_profiles).toMatchObject({ passed: true,
        results: [{ id: 'unit.core', passed: true, command: 'node --test value.test.cjs', root: '.', result_hash: expect.stringMatching(/^[a-f0-9]{64}$/) }] });
      // Local qualification stops at the configured shipping boundary. It must
      // never invent a remote merge or weaken the disabled auto-merge check.
      expect(gated.status).toBe('blocked');
      expect(gated.block_reason).toBe('auto-merge is disabled by configuration');
      expect(await value.rpc('ape_run', { action: 'abort', run_id: runId, reason: 'Fixture finished after deterministic gate verification.' })).toMatchObject({ ok: true });
      expect(await value.rpc('ape_run', { action: 'status' })).toMatchObject({ run: { run_id: runId, status: 'aborted' } });
    }, 90_000,
  );
});
