import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SESSION_GUIDANCE_MAX_BYTES,
  SESSION_START_SOURCES,
  attachRuntimeGuidance,
  formatSessionGuidanceResponse,
  loadSessionGuidance,
  runtimeGuidanceForState,
} from '../lib/runtime/session-guidance.js';
import { recordCodexBootstrapCandidate } from '../lib/runtime/codex-bootstrap.js';
import { bindingProbeStatus, bootstrapBindingProbe, launchBindingProbe, prepareBindingProbe } from '../lib/runtime/binding-probe.js';
import { runtimePaths } from '../lib/runtime/paths.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function invokeCodexHook(projectDir, source = 'startup', payload = {}) {
  const {
    CLAUDECODE: _claudeCode,
    CLAUDE_CODE: _claudeCodeAlias,
    CLAUDE_PLUGIN_ROOT: _claudePluginRoot,
    CLAUDE_PROJECT_DIR: _claudeProjectDir,
    ...hostEnv
  } = process.env;
  return JSON.parse(execFileSync(
    process.execPath,
    [join(root, 'bin', 'ape-hook.mjs')],
    {
      cwd: root,
      encoding: 'utf8',
      env: { ...hostEnv, CODEX_CWD: projectDir },
      input: `${JSON.stringify({
        hook_event_name: 'SessionStart',
        project_dir: projectDir,
        source,
        ...payload,
      })}\n`,
    },
  ));
}

function invokeClaudeHook(projectDir, source = 'startup', payload = {}) {
  const {
    CODEX_CWD: _codexCwd,
    PLUGIN_ROOT: _pluginRoot,
    ...hostEnv
  } = process.env;
  return JSON.parse(execFileSync(
    process.execPath,
    [join(root, 'bin', 'ape-hook.mjs')],
    {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...hostEnv,
        CLAUDECODE: '1',
        CLAUDE_PROJECT_DIR: projectDir,
      },
      input: `${JSON.stringify({
        hook_event_name: 'SessionStart',
        project_dir: projectDir,
        source,
        ...payload,
      })}\n`,
    },
  ));
}
import { projectRunResponse, RESPONSE_BUDGET_BYTES } from '../lib/runtime/projection.js';

function activeState(overrides = {}) {
  return {
    schema_version: '2.0.0',
    version: 2,
    run_id: 'run-session-guidance',
    host: 'codex',
    mode: 'phase',
    lane: 'full',
    status: 'blocked',
    stage: 'preflight',
    dispatch_state: 'none',
    tickets: [],
    receipts: [],
    expired_tickets: [],
    ape_version: '2.24.10',
    runtime_version: 2,
    host_plugin_version: '2.24.10',
    protocol_version: 'ape-codex-dispatch-v2',
    envelope_version: 2,
    plan_contract_version: 2,
    run_contract: {
      ref: '.ape/runtime/contracts/example.json',
      hash: 'a'.repeat(64),
    },
    ...overrides,
  };
}

describe('runtime-owned session guidance', () => {
  const dirs = [];
  afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

  function project(prefix = 'ape-session-guidance-') {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    dirs.push(dir);
    return dir;
  }

  function runtimeSnapshot(paths) {
    return readdirSync(paths.runtime, { recursive: true }).sort().map((relative) => {
      const file = join(paths.runtime, relative);
      const metadata = lstatSync(file);
      const content = metadata.isFile() ? readFileSync(file)
        : metadata.isSymbolicLink() ? readlinkSync(file) : '';
      return [relative, metadata.mode, metadata.mtimeMs,
        createHash('sha256').update(content).digest('hex')];
    });
  }

  async function failedProbe(dir) {
    const paths = runtimePaths(dir);
    mkdirSync(paths.runtime, { recursive: true });
    const prepared = await prepareBindingProbe(paths, {
      host: 'codex', model: { model: 'gpt-5.4-mini', reasoning_effort: 'low' },
    });
    expect((await launchBindingProbe(paths, {
      session_id: 'probe-parent', turn_id: 'probe-parent-turn', tool_use_id: 'probe-spawn',
      tool_name: 'collaborationspawn_agent', tool_input: prepared.dispatch.spawn_args,
    })).valid).toBe(true);
    expect((await bootstrapBindingProbe(paths, {
      session_id: 'unobserved-child', turn_id: 'unobserved-child-turn', tool_use_id: 'probe-bind',
      tool_name: 'mcp__ape__ape_bind', tool_input: prepared.dispatch.bootstrap_args,
    })).valid).toBe(false);
    expect((await bindingProbeStatus(paths)).infrastructure_status).toBe('failed');
    return paths;
  }

  it('stays silent outside a configured APE runtime and never creates state', async () => {
    const dir = project();
    await expect(loadSessionGuidance(dir)).resolves.toBeNull();
  });

  it('orients startup, resume, clear, and compact sessions from current runtime state', async () => {
    const dir = project();
    mkdirSync(join(dir, '.ape', 'runtime'), { recursive: true });
    writeFileSync(join(dir, '.ape', 'runtime', 'active.json'), JSON.stringify(activeState()));

    expect(SESSION_START_SOURCES).toEqual(['startup', 'resume', 'clear', 'compact']);
    for (const source of SESSION_START_SOURCES) {
      const guidance = await loadSessionGuidance(dir, { source });
      expect(guidance).toContain('APE runtime guidance v1');
      expect(guidance).toContain(`Session refresh: ${source}.`);
      expect(guidance).toContain('run-session-guidance');
      expect(guidance).toContain(`immutable run contract ${'a'.repeat(64)}`);
      expect(guidance).toContain('planning contract v2');
      expect(guidance).toContain('Next safe action: ape_run abort or ape_run override reset');
      expect(guidance).toContain('Repository instruction files remain repository-owned');
      expect(Buffer.byteLength(guidance, 'utf8')).toBeLessThanOrEqual(SESSION_GUIDANCE_MAX_BYTES);
    }
  });

  it('reports an inactive or corrupt runtime without inventing an active run', async () => {
    const inactiveDir = project('ape-session-inactive-');
    mkdirSync(join(inactiveDir, '.ape', 'runtime'), { recursive: true });
    const inactive = await loadSessionGuidance(inactiveDir, { host: 'codex' });
    expect(inactive).toMatch(/no active APE run/);
    expect(inactive).toContain(
      'review a ready ape_run preview admission manifest; complete ape_run probe, launch dispatch.spawn_args unchanged, confirm ape_run probe-status, send ape_run probe-ack, then ape_run start with expected_admission_digest from preview',
    );

    const corruptDir = project('ape-session-corrupt-');
    mkdirSync(join(corruptDir, '.ape', 'runtime'), { recursive: true });
    writeFileSync(join(corruptDir, '.ape', 'runtime', 'active.json'), '{');
    const corrupt = await loadSessionGuidance(corruptDir);
    expect(corrupt).toContain('active state is unavailable or invalid');
    expect(corrupt).toContain('Next safe action: ape_run override reset');
    expect(corrupt).not.toContain('Active run:');

    for (const [label, scalar] of [['false', false], ['zero', 0], ['empty-string', '']]) {
      const scalarDir = project(`ape-session-corrupt-${label}-`);
      mkdirSync(join(scalarDir, '.ape', 'runtime'), { recursive: true });
      writeFileSync(join(scalarDir, '.ape', 'runtime', 'active.json'), JSON.stringify(scalar));
      const scalarGuidance = await loadSessionGuidance(scalarDir, { host: 'codex' });
      expect(scalarGuidance).toContain('active state is unavailable or invalid');
      expect(scalarGuidance).toContain('Next safe action: ape_run override reset');
      expect(scalarGuidance).not.toContain('no active APE run');
      expect(scalarGuidance).not.toContain('ape_run probe');
    }
  });

  it('labels retained completed and aborted records as sealed history, not active runs', () => {
    for (const status of ['completed', 'aborted']) {
      const guidance = runtimeGuidanceForState(activeState({
        status,
        stage: status,
      }));
      expect(guidance).toContain(`Last sealed run: run-session-guidance; status ${status}`);
      expect(guidance).not.toContain('Active run:');
      expect(guidance).toContain(
        'Next safe action: review a ready ape_run preview admission manifest; complete ape_run probe, launch dispatch.spawn_args unchanged, confirm ape_run probe-status, send ape_run probe-ack, then ape_run start with expected_admission_digest from preview',
      );
    }
  });

  it.each([null, 'completed', 'aborted'])('orients a failed probe toward diagnosis without relaunch for %s state', async (status) => {
    const dir = project();
    const paths = await failedProbe(dir);
    if (status) writeFileSync(paths.active, JSON.stringify(activeState({ status, stage: status })));
    const before = runtimeSnapshot(paths);
    const guidance = await loadSessionGuidance(dir, { host: 'codex' });
    expect(guidance).toContain('Next safe action: diagnose the native binding failure with ape_run probe-status');
    expect(guidance).toContain('do not automatically launch or replace a probe or start a run');
    expect(guidance).not.toContain('complete ape_run probe, launch');
    expect(guidance).not.toContain(paths.root);
    expect(invokeCodexHook(dir).hookSpecificOutput?.additionalContext).toContain(
      'do not automatically launch or replace a probe or start a run',
    );
    expect(runtimeSnapshot(paths)).toEqual(before);
  });

  it('keeps active-run and explicit returned next_action guidance ahead of probe prerequisites', async () => {
    const dir = project();
    const paths = await failedProbe(dir);
    writeFileSync(paths.active, JSON.stringify(activeState({ status: 'input_required',
      input_required: { preflight_hash: 'b'.repeat(64), question_ids: ['api-name'] },
    })));
    const before = runtimeSnapshot(paths);
    const guidance = await loadSessionGuidance(dir, { host: 'codex' });
    expect(guidance).toContain('Next safe action: ape_run answer-preflight');
    expect(guidance).not.toContain('diagnose the native binding failure');
    expect(runtimeSnapshot(paths)).toEqual(before);
    for (const status of ['completed', 'aborted']) {
      const response = attachRuntimeGuidance({
        ok: true, run: activeState({ status, stage: status }),
        next_action: { kind: 'blocked', failure_domain: 'orchestration' },
      });
      expect(response.runtime_guidance).toContain(
        'Next safe action: follow the returned next_action (kind blocked) exactly as provided',
      );
      expect(response.runtime_guidance).not.toContain('complete ape_run probe, launch');
    }
  });

  it.each(['malformed', 'oversized', 'directory', 'symlink'])('fails closed on %s probe evidence without reflecting or changing it', async (kind) => {
    const dir = project();
    const paths = runtimePaths(dir);
    mkdirSync(paths.runtime, { recursive: true });
    const secret = 'private-probe-artifact-content';
    if (kind === 'directory') mkdirSync(paths.bindingProbe);
    else if (kind === 'symlink') {
      const target = join(dir, 'private-probe-target');
      writeFileSync(target, secret);
      symlinkSync(target, paths.bindingProbe);
    } else writeFileSync(paths.bindingProbe, kind === 'oversized' ? secret.repeat(60_000) : `{${secret}`);
    const before = runtimeSnapshot(paths);
    const guidance = await loadSessionGuidance(dir, { host: 'codex' });
    expect(guidance).toContain('diagnose the native binding failure with ape_run probe-status');
    expect(guidance).toContain('do not automatically launch or replace a probe or start a run');
    expect(guidance).not.toContain(secret);
    expect(guidance).not.toContain(paths.root);
    expect(guidance).not.toContain('complete ape_run probe, launch');
    expect(Buffer.byteLength(guidance, 'utf8')).toBeLessThanOrEqual(SESSION_GUIDANCE_MAX_BYTES);
    expect(runtimeSnapshot(paths)).toEqual(before);
  });

  it('diagnoses a legacy bound probe without SessionStart creating quarantine or repairing it', async () => {
    const dir = project();
    const paths = runtimePaths(dir);
    mkdirSync(paths.runtime, { recursive: true });
    writeFileSync(paths.bindingProbe, JSON.stringify({
      version: 1, host: 'codex', probe_id: 'probe-legacy12', agent_type: 'explorer',
      status: 'bound', bound_session_id: 'legacy-parent', bound_agent_id: 'legacy-child',
      bound_at: new Date().toISOString(),
    }));
    const before = runtimeSnapshot(paths);
    const guidance = await loadSessionGuidance(dir, { host: 'codex' });
    expect(guidance).toContain('diagnose the native binding failure with ape_run probe-status');
    expect(invokeCodexHook(dir).hookSpecificOutput?.additionalContext).toContain(
      'do not automatically launch or replace a probe or start a run',
    );
    expect(runtimeSnapshot(paths)).toEqual(before);
    expect(existsSync(paths.bindingProbeQuarantine)).toBe(false);
    expect(existsSync(paths.bindingProbeQuarantineFallback)).toBe(false);
  });

  it('uses the current SessionStart host for sealed cross-host prerequisites', () => {
    const sealedClaudeRun = activeState({
      host: 'claude',
      status: 'completed',
      stage: 'completed',
    });
    expect(runtimeGuidanceForState(sealedClaudeRun, { host: 'codex' }))
      .toContain('complete ape_run probe');

    const sealedCodexRun = activeState({ status: 'completed', stage: 'completed' });
    const claudeGuidance = runtimeGuidanceForState(sealedCodexRun, { host: 'claude' });
    expect(claudeGuidance).toContain(
      'Next safe action: check host prerequisites, then ape_run start',
    );
    expect(claudeGuidance).not.toContain('complete ape_run probe');
  });

  it('derives dispatch liveness for a healthy v2 state that does not persist dispatch_state', async () => {
    const dir = project();
    mkdirSync(join(dir, '.ape', 'runtime'), { recursive: true });
    const state = activeState({ status: 'running', stage: 'plan' });
    delete state.dispatch_state;
    writeFileSync(join(dir, '.ape', 'runtime', 'active.json'), JSON.stringify(state));

    const guidance = await loadSessionGuidance(dir, { source: 'startup' });
    expect(guidance).toContain('Active run: run-session-guidance; status running; stage plan');
    expect(guidance).toContain('Next safe action: ape_run next');
    expect(guidance).not.toContain('active state is unavailable or invalid');
    expect(guidance).not.toContain('ape_run override reset');
  });

  it('directs a session to audited abort when durable dispatch evidence is unreadable', async () => {
    const dir = project();
    const runtime = join(dir, '.ape', 'runtime');
    mkdirSync(join(runtime, 'dispatch-intents'), { recursive: true });
    const state = activeState({
      status: 'running',
      stage: 'plan',
      dispatch_state: 'pending',
      tickets: [{
        ticket_id: 'run-session-guidance:plan:ticket',
        stage_id: 'plan',
        role: 'planner',
      }],
    });
    writeFileSync(join(runtime, 'active.json'), JSON.stringify(state));
    writeFileSync(join(runtime, 'dispatch-intents', 'damaged.json'), '{}');

    const guidance = await loadSessionGuidance(dir, { source: 'resume' });
    expect(guidance).toContain('Active run: run-session-guidance; status running; stage plan');
    expect(guidance).toContain('Next safe action: ape_run abort');
    expect(guidance).not.toContain('Next safe action: ape_run resume');
    expect(guidance).not.toContain('active state is unavailable or invalid');
  });

  it('orients valid input holds without diagnosing healthy state as corrupt', async () => {
    const dir = project();
    mkdirSync(join(dir, '.ape', 'runtime'), { recursive: true });
    const preflight = activeState({
      status: 'input_required',
      stage: 'preflight',
      input_required: {
        preflight_hash: 'b'.repeat(64),
        question_ids: ['api-name'],
      },
    });
    writeFileSync(join(dir, '.ape', 'runtime', 'active.json'), JSON.stringify(preflight));

    const sessionGuidance = await loadSessionGuidance(dir, { source: 'resume' });
    expect(sessionGuidance).toContain('status input_required; stage preflight');
    expect(sessionGuidance).toContain('Next safe action: ape_run answer-preflight');
    expect(sessionGuidance).not.toContain('active state is unavailable or invalid');
    const responseGuidance = attachRuntimeGuidance({ ok: true, run: preflight }).runtime_guidance;
    expect(responseGuidance).toContain('Next safe action: ape_run answer-preflight');

    expect(runtimeGuidanceForState(activeState({
      status: 'input_required',
      stage: 'test',
      input_required: { kind: 'receipt_retry', ticket_id: 'ticket-1' },
    }))).toContain('Next safe action: continue the same agent and record the exact attested receipt');
    expect(runtimeGuidanceForState(activeState({
      status: 'input_required',
      stage: 'execution-budget',
      input_required: { kind: 'execution_budget' },
    }))).toContain('Next safe action: wait for the retained continuation');
    const remediation = runtimeGuidanceForState(activeState({
      status: 'blocked',
      stage: 'remediation',
    }));
    expect(remediation).toContain('status blocked; stage remediation');
    expect(remediation).toContain('Next safe action: ape_run abort or ape_run override reset');
    expect(remediation).not.toContain('active state is unavailable or invalid');
  });

  it('never injects main-session orientation into a native subagent session', async () => {
    const dir = project();
    mkdirSync(join(dir, '.ape', 'runtime'), { recursive: true });
    writeFileSync(join(dir, '.ape', 'runtime', 'active.json'), JSON.stringify(activeState()));
    await expect(loadSessionGuidance(dir, { is_subagent: true })).resolves.toBeNull();
  });

  it('uses the host-compatible SessionStart additionalContext shape', () => {
    const guidance = runtimeGuidanceForState(activeState());
    expect(formatSessionGuidanceResponse(guidance)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: guidance,
      },
    });
    expect(formatSessionGuidanceResponse(null)).toEqual({});
  });

  it('emits runtime-owned SessionStart context through the installed hook entrypoint', () => {
    const dir = project();
    mkdirSync(join(dir, '.ape', 'runtime'), { recursive: true });
    writeFileSync(join(dir, '.ape', 'runtime', 'active.json'), JSON.stringify(activeState()));

    const response = invokeCodexHook(dir, 'compact');
    expect(response).toEqual({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: expect.stringContaining('run-session-guidance'),
      },
    });
    expect(invokeClaudeHook(dir, 'resume')).toEqual({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: expect.stringContaining('run-session-guidance'),
      },
    });
  });

  it('emits Codex binding prerequisites before start while keeping Claude guidance generic', () => {
    const dir = project();
    mkdirSync(join(dir, '.ape', 'runtime'), { recursive: true });

    const codex = invokeCodexHook(dir).hookSpecificOutput?.additionalContext;
    expect(codex).toContain('complete ape_run probe');
    expect(codex).toContain('launch dispatch.spawn_args unchanged');
    expect(codex).toContain('send ape_run probe-ack, then ape_run start');

    const claude = invokeClaudeHook(dir).hookSpecificOutput?.additionalContext;
    expect(claude).toContain('Next safe action: check host prerequisites, then ape_run start');
    expect(claude).not.toContain('complete ape_run probe');
  });

  it('keeps custom main --agent sessions oriented while suppressing APE and explicit native children', () => {
    const dir = project();
    mkdirSync(join(dir, '.ape', 'runtime'), { recursive: true });
    writeFileSync(join(dir, '.ape', 'runtime', 'active.json'), JSON.stringify(activeState()));

    const mainAgent = invokeCodexHook(dir, 'startup', { agent_type: 'custom-main-agent' });
    expect(mainAgent.hookSpecificOutput?.additionalContext).toContain('run-session-guidance');
    const nativeChild = invokeCodexHook(dir, 'startup', {
      agent_type: 'default',
      agent_id: 'native-child-id',
    });
    expect(nativeChild).toEqual({});
    expect(invokeCodexHook(dir, 'startup', { agent_type: 'ape:reviewer' })).toEqual({});
    expect(invokeCodexHook(dir, 'startup', {
      agent_type: 'default',
      ticket_id: 'run-session-guidance:review:ticket',
    })).toEqual({});
  });

  it('suppresses parent orientation for native session-only children without granting bootstrap authority', async () => {
    const dir = project();
    const paths = runtimePaths(dir);
    mkdirSync(paths.runtime, { recursive: true });
    await recordCodexBootstrapCandidate(paths, {
      session_id: 'native-parent', turn_id: 'native-child-turn',
      agent_id: 'native-child', agent_type: 'default', model: 'gpt-5.4-mini',
    });
    for (const nativeInput of [
      { session_id: 'native-parent', turn_id: 'native-child-turn' },
      { session_id: 'native-child', turn_id: 'native-child-turn' },
      { session_id: 'native-child', turn_id: 'unobserved-resume-turn' },
      { session_id: 'native-child' },
    ]) {
      await expect(loadSessionGuidance(dir, {
        host: 'codex', source: 'startup', native_input: nativeInput,
      })).resolves.toBeNull();
      expect(invokeCodexHook(dir, 'startup', nativeInput)).toEqual({});
    }
    const parent = await loadSessionGuidance(dir, {
      host: 'codex', source: 'startup',
      native_input: { session_id: 'native-parent', turn_id: 'native-parent-turn' },
    });
    expect(parent).toContain('Invoke APE only when the user explicitly requests it');
    expect(invokeCodexHook(dir, 'startup', {
      session_id: 'native-parent', turn_id: 'native-parent-turn',
    }).hookSpecificOutput?.additionalContext).toBe(parent);
    expect(existsSync(paths.dispatchIntents)).toBe(false);
    expect(existsSync(paths.active)).toBe(false);
  });

  it('adds refreshed guidance to ape_run results that carry state', () => {
    const state = activeState({ status: 'running', stage: 'plan', dispatch_state: 'pending' });
    const response = attachRuntimeGuidance({ ok: true, run: state, actions: [] });
    expect(response.runtime_guidance).toContain('status running; stage plan');
    expect(response.runtime_guidance).toContain('Next safe action: ape_run resume');
    expect(attachRuntimeGuidance({ ok: false, reason: 'no active run' }))
      .toEqual({ ok: false, reason: 'no active run' });
  });

  it('prioritizes a returned dispatch action over a derived resume diagnosis', () => {
    const state = activeState({ status: 'running', stage: 'plan' });
    delete state.dispatch_state;
    const response = attachRuntimeGuidance({
      ok: true,
      run: state,
      actions: [{ type: 'dispatch_agent', ticket: { ticket_id: 'ticket-1' } }],
    });
    expect(response.runtime_guidance).toContain(
      'Next safe action: launch the returned dispatch_agent action exactly as provided',
    );
    expect(response.runtime_guidance).not.toContain('Next safe action: ape_run resume');
    expect(response.runtime_guidance).not.toContain('active state is unavailable or invalid');
  });

  it('prioritizes an explicit returned next_action over the state diagnostic', () => {
    const state = activeState({ status: 'running', stage: 'plan', dispatch_state: 'pending' });
    const response = attachRuntimeGuidance({
      ok: true,
      run: state,
      actions: [],
      next_action: { kind: 'continue_same_agent', ticket_id: 'ticket-1' },
    });
    expect(response.runtime_guidance).toContain(
      'Next safe action: follow the returned next_action (kind continue_same_agent) exactly as provided',
    );
    expect(response.runtime_guidance).not.toContain('Next safe action: ape_run resume');
  });

  it('retains bounded runtime guidance when an ape_run response falls back to references', () => {
    const state = activeState({ objective: 'x'.repeat(RESPONSE_BUDGET_BYTES * 2) });
    const guidance = runtimeGuidanceForState(state);
    const projected = projectRunResponse({ ok: true, run: state, runtime_guidance: guidance });
    expect(projected.runtime_guidance).toBe(guidance);
    expect(projected.projection).toBeDefined();
    expect(Buffer.byteLength(JSON.stringify(projected), 'utf8')).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
  });
});
