import { spawn } from 'node:child_process';
import { access, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, setRuntimeConfig } from '../lib/runtime/config.js';
import { doctor } from '../lib/runtime/doctor.js';
import {
  CONTROL_PLANE_TOOLS,
  SUBAGENT_PROTOCOL_TOOLS,
  driftGuardApplies,
  evaluateLifecyclePolicy,
  isExternalMcpTool,
  normalizeLifecycleEvent,
} from '../lib/runtime/hooks.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import {
  RunStartInputSchema,
  finalizeReceipt,
  finalizeTicket,
  validateTicket,
} from '../lib/runtime/schemas.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const hookBinary = path.join(root, 'bin', 'ape-hook.mjs');
const cleanups = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function project() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-external-mcp-pass-through-'));
  cleanups.push(dir);
  await mkdir(path.join(dir, '.ape', 'runtime'), { recursive: true });
  return dir;
}

function invokeHook(input, host = 'codex') {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE;
    delete env.CLAUDE_PROJECT_DIR;
    delete env.CODEX_CWD;
    if (host === 'claude') env.CLAUDECODE = '1';
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
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(stderr));
      else resolve(JSON.parse(stdout));
    });
    child.stdin.end(`${JSON.stringify(input)}\n`);
  });
}

const state = { run_id: 'run-1', status: 'running' };
const ticket = {
  ticket_id: 'run-1:build:ticket-1',
  role: 'implementer',
  writable: true,
  claimed_paths: ['src/**'],
  test_paths: ['tests/**'],
};

describe('external MCP ownership boundary', () => {
  it('owns only APE control-plane and receipt-validator aliases', () => {
    for (const name of [
      'ape_run',
      'mcp__ape__ape_run',
      'mcp__plugin_ape_ape__ape_history',
    ]) {
      expect(CONTROL_PLANE_TOOLS.test(name), name).toBe(true);
      expect(isExternalMcpTool(name), name).toBe(false);
    }
    for (const name of [
      'ape_validate_receipt',
      'mcp__ape__ape_validate_receipt',
      'mcp__plugin_ape_ape__ape_validate_receipt',
    ]) {
      expect(SUBAGENT_PROTOCOL_TOOLS.test(name), name).toBe(true);
      expect(isExternalMcpTool(name), name).toBe(false);
    }
    for (const name of [
      'mcp__future_provider__new_operation_added_tomorrow',
      'mcp__anyserver__ape_run',
      'mcp__anyserver__ape_validate_receipt',
      'mcp__ape__third_party_extension',
    ]) {
      expect(isExternalMcpTool(name), name).toBe(true);
    }
    expect(isExternalMcpTool('Read')).toBe(false);
  });

  it('passes every external MCP call independently of host, role, writability, and run state', () => {
    const statuses = ['running', 'blocked', 'gating', 'shipping', 'completed', 'aborted'];
    for (const host of ['claude', 'codex']) {
      for (const status of statuses) {
        for (const worker of [
          null,
          { ...ticket, role: 'reviewer', writable: false },
          { ...ticket, role: 'implementer', writable: true },
        ]) {
          const decision = evaluateLifecyclePolicy({
            event: 'PreToolUse',
            host,
            tool_name: 'mcp__unforecastable_server__mutate_everything_v99',
            is_subagent: Boolean(worker),
            ape_managed: Boolean(worker),
            ticket_id: worker?.ticket_id ?? null,
          }, { state: { run_id: 'run-1', status }, ticket: worker });
          expect(decision, `${host}/${status}/${worker?.role ?? 'main'}`).toMatchObject({
            decision: 'allow',
          });
        }
      }
    }
    expect(evaluateLifecyclePolicy({
      event: 'PreToolUse', host: 'codex', tool_name: 'mcp__future__anything', is_subagent: true,
    }, { state: null, ticket: null }).decision).toBe('allow');
  });

  it('keeps exact APE control-plane ownership for managed workers', () => {
    const result = evaluateLifecyclePolicy({
      event: 'PreToolUse',
      host: 'codex',
      tool_name: 'mcp__ape__ape_run',
      is_subagent: true,
      ape_managed: true,
      ticket_id: ticket.ticket_id,
    }, { state, ticket });
    expect(result.decision).toBe('deny');

    const collision = evaluateLifecyclePolicy({
      event: 'PreToolUse',
      host: 'codex',
      tool_name: 'mcp__anyserver__ape_run',
      is_subagent: true,
      ape_managed: true,
      ticket_id: ticket.ticket_id,
    }, { state, ticket });
    expect(collision.decision).toBe('allow');
  });

  it.each(['claude', 'codex'])('returns neutral output before reading corrupt APE state on %s', async (host) => {
    const dir = await project();
    const paths = runtimePaths(dir);
    await writeFile(paths.active, '{ definitely not valid JSON');

    for (const event of ['PreToolUse', 'PostToolUse', 'PostToolUseFailure']) {
      const response = await invokeHook({
        hook_event_name: event,
        project_dir: dir,
        session_id: 'external-session',
        agent_id: 'external-worker',
        agent_type: 'ape:implementer',
        tool_name: 'mcp__unknown_future_server__rename_everything',
        tool_input: { arbitrary: true },
        tool_response: { arbitrary: true },
      }, host);
      expect(response, `${host}/${event}`).toEqual({});
    }
    await expect(access(path.join(paths.runtime, 'external-tool-effects.ndjson'))).rejects.toThrow();
  });
});

describe('new-run and historical schema boundary', () => {
  const start = {
    objective: 'Use whatever MCP tools the host provides',
    mode: 'phase',
    lane: 'fast',
    host: 'codex',
    claimed_paths: [],
    test_paths: [],
    requirements: [],
    risk_triggers: [],
    behavioral: false,
    hooks_trusted: true,
    subagents_available: true,
    explicit_invocation: true,
  };

  it('rejects removed claim fields on new run inputs', () => {
    expect(RunStartInputSchema.safeParse({
      ...start,
      tool_claims: ['github:repo:read'],
    }).success).toBe(false);
    expect(RunStartInputSchema.safeParse({
      ...start,
      required_capabilities: [{ kind: 'tool_claim', id: 'github:repo:read' }],
    }).success).toBe(false);
  });

  it('still validates already-issued ticket hashes containing legacy claims', () => {
    const now = new Date().toISOString();
    const historical = finalizeTicket({
      schema_version: '2.0.0',
      ticket_id: 'ticket-legacy',
      run_id: 'run-legacy',
      stage_id: 'build',
      parallel_group: null,
      role: 'implementer',
      objective: 'Historical ticket',
      claimed_paths: ['src/**'],
      tool_claims: ['github:repo:read'],
      test_paths: [],
      model_tier: 'balanced',
      model: {},
      deadline_at: now,
      output_schema: {},
      required_checks: [],
      parent_hash: null,
      base_tree_sha: 'a'.repeat(40),
      attempt: 1,
      writable: true,
      issued_at: now,
    });
    expect(historical.tool_claims).toEqual(['github:repo:read']);
    expect(validateTicket(historical)).toMatchObject({ valid: true });
  });

  it('keeps historical receipt effects readable and hash-bound', () => {
    const now = new Date().toISOString();
    const receipt = finalizeReceipt({
      schema_version: '2.0.0',
      receipt_id: 'receipt-legacy',
      run_id: 'run-legacy',
      ticket_id: 'ticket-legacy',
      ticket_hash: 'b'.repeat(64),
      agent: { host: 'codex', role: 'implementer', identity: 'agent-1', model: null },
      status: 'passed',
      base_tree_sha: 'a'.repeat(40),
      head_tree_sha: 'c'.repeat(40),
      changed_files: [],
      tests: [],
      findings: [],
      evidence: {},
      tool_effects: [{
        provider: 'unity', operation: 'save_scene', effect: 'write',
        resources: ['scene:Assets/Scenes/Main.unity'], tool_use_id: 'tool-1',
        status: 'completed', response_hash: 'd'.repeat(64), occurred_at: now,
      }],
      timing: { started_at: now, completed_at: now, duration_ms: 1 },
      previous_receipt_hash: null,
    });
    expect(receipt.tool_effects).toHaveLength(1);
    expect(receipt.receipt_hash).toHaveLength(64);
  });
});

describe('exact command profiles remain APE-owned shell policy', () => {
  it.each(['claude', 'codex'])('admits an exact role-authorized command on %s', async (host) => {
    const dir = await project();
    const command = '/Applications/Unity/Unity -batchmode -quit -runTests';
    await writeFile(runtimePaths(dir).config, JSON.stringify({
      policy: {
        command_profiles: [{ id: 'unity-tests', command, roles: ['implementer'], effect: 'execute' }],
      },
    }));
    const event = normalizeLifecycleEvent({
      hook_event_name: 'PreToolUse', project_dir: dir, tool_name: 'Bash',
      tool_input: { command }, agent_id: 'native-agent',
    }, host === 'claude' ? { CLAUDECODE: '1' } : {});
    expect(evaluateLifecyclePolicy(event, { state, ticket }).decision).toBe('allow');
    expect(evaluateLifecyclePolicy({ ...event, command: `${command} -executeMethod Build.Player` }, {
      state, ticket,
    }).decision).toBe('deny');
  });

  it('validates command profiles at config-set time', async () => {
    const dir = await project();
    const paths = runtimePaths(dir);
    await expect(setRuntimeConfig(paths.config, 'policy.command_profiles', [{
      id: 'unity-tests', command: 'unity -batchmode -runTests', roles: ['test_writer'], effect: 'execute',
    }])).resolves.toBeDefined();
    await expect(setRuntimeConfig(paths.config, 'policy.command_profiles', [{
      id: 'unsafe', command: 'unity\nrm -rf x', roles: ['implementer'], effect: 'write',
    }])).rejects.toThrow(/single-line command/);
    expect(DEFAULT_CONFIG.policy.command_profiles).toEqual([]);
  });

  it('continues applying drift reconciliation to exact shell profiles', async () => {
    const dir = await project();
    const command = 'unity -batchmode -runTests';
    await writeFile(runtimePaths(dir).config, JSON.stringify({
      policy: { command_profiles: [{ id: 'unity-tests', command, roles: ['implementer'], effect: 'execute' }] },
    }));
    const event = normalizeLifecycleEvent({
      hook_event_name: 'PostToolUse', project_dir: dir, tool_name: 'Bash',
      tool_input: { command }, agent_id: 'native-agent',
    });
    expect(driftGuardApplies(event, { state, ticket })).toBe(true);
  });
});

describe('project doctor avoids MCP provider forecasting', () => {
  it('reports project types without inspecting or warning about MCP providers', async () => {
    const dir = await project();
    await mkdir(path.join(dir, 'Assets'));
    await mkdir(path.join(dir, 'Packages'));
    await mkdir(path.join(dir, 'ProjectSettings'));
    await writeFile(path.join(dir, 'Packages', 'manifest.json'), '{}');
    await writeFile(path.join(dir, 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 6000.0.1f1\n');
    await writeFile(path.join(dir, 'scene.blend'), 'BLENDER');
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({
      devDependencies: { '@playwright/test': '^1.0.0' },
    }));
    const report = await doctor(dir, {});
    expect(report.checks.find((check) => check.name === 'unity-project')).toMatchObject({ passed: true });
    expect(report.checks.find((check) => check.name === 'blender-project')).toMatchObject({ passed: true });
    expect(report.checks.find((check) => check.name === 'playwright-project')).toMatchObject({ passed: true });
    expect(report.checks.some((check) => check.name.includes('mcp-provider'))).toBe(false);
  });
});
