import { gitFixtureEnv } from '../test-support/git-fixtures.js';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { startRun } from '../lib/runtime/service.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { atomicWriteJson, readJson } from '../lib/runtime/storage.js';
import { validateReceiptDraft } from '../lib/runtime/receipt-validator.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const binaries = ['bin/ape-hook.mjs', 'plugins/ape-claude/dist/ape-hooks.bundle.mjs'];
const cleanups = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function project(active = false, bindingProtocol) {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-neutral-permissions-'));
  cleanups.push(dir);
  if (!active) return { dir };
  await mkdir(path.join(dir, 'src'));
  await mkdir(path.join(dir, 'tests'));
  await writeFile(path.join(dir, 'src/value.js'), 'export const value = 1;\n');
  await writeFile(path.join(dir, 'tests/value.test.js'), 'throw new Error("red");\n');
  const git = (...args) => execFileSync('git', args, { env: gitFixtureEnv(), cwd: dir, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 'ape@example.test');
  git('config', 'user.name', 'APE Test');
  git('config', 'commit.gpgsign', 'false');
  git('add', '.');
  git('commit', '-qm', 'fixture');
  await atomicWriteJson(runtimePaths(dir).config, {
    shipping: { auto_merge: false, provider: 'github', required_remote_checks: false },
    test_commands: { targeted_template: 'node --test {paths}', full: 'node --test' },
  });
  const started = await startRun(dir, {
    objective: 'Exercise neutral Claude permission responses', mode: 'phase', lane: 'fast',
    host: 'claude', claimed_paths: ['src/value.js'], test_paths: ['tests/value.test.js'],
    ...(bindingProtocol ? { binding_protocol: bindingProtocol } : {}),
    requirements: ['R-NEUTRAL'], risk_triggers: [], behavioral: true,
    hooks_trusted: true, subagents_available: true, explicit_invocation: true,
  });
  expect(started.ok, JSON.stringify(started.readiness?.blocking)).toBe(true);
  const action = started.actions.find((entry) => entry.type === 'dispatch_agent');
  expect(action).toBeDefined();
  return { dir, action, ticket: action.ticket };
}

function invoke(binary, dir, input) {
  const env = gitFixtureEnv();
  for (const key of Object.keys(env)) {
    if (/^(?:APE_|CLAUDE|CODEX_|PLUGIN_ROOT)/i.test(key)) delete env[key];
  }
  Object.assign(env, { CLAUDECODE: '1', APE_HOST: 'claude' });
  const result = spawnSync(process.execPath, [path.join(root, binary)], {
    cwd: dir, env, encoding: 'utf8', timeout: 15_000,
    input: JSON.stringify({ hook_event_name: 'PreToolUse', project_dir: dir,
      session_id: 'neutral-parent', ...input }) + '\n',
  });
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toBe('');
  const response = JSON.parse(result.stdout);
  expect(response).toBeTypeOf('object');
  return response;
}

function expectNeutral(response, context) {
  expect(response).toEqual(context === undefined ? {} : {
    hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: context },
  });
}

// DOCUMENTATION-DERIVED CONTRACT MODEL ONLY: these outcomes are not observations
// of an interactive Claude prompt. Ordinary Write in default permission mode is
// used here, excluding special user-interaction tools and auto-approval exceptions.
// https://code.claude.com/docs/en/hooks#pretooluse-decision-control (2026-10-01)
function documentedOrdinaryWriteOutcome(response, explicitRule = null) {
  const decision = response.hookSpecificOutput?.permissionDecision;
  if (decision === 'deny' || explicitRule === 'deny') return 'denied';
  if (explicitRule === 'ask' || decision === 'ask') return 'prompt';
  return decision === 'allow' ? 'approved' : 'prompt';
}

describe.each(binaries)('executable Claude hook neutrality: %s', (binary) => {
  it.each([
    ['Read', { file_path: 'notes.md' }],
    ['Write', { file_path: 'notes.md', content: 'ordinary' }],
    ['Bash', { command: 'git status' }],
  ])('continues neutrally with no run for %s', async (tool_name, tool_input) => {
    const { dir } = await project();
    expectNeutral(invoke(binary, dir, { tool_name, tool_input }));
  });

  it('continues an active allowed read and keeps the exact denied-write reason', async () => {
    const { dir } = await project(true);
    expectNeutral(invoke(binary, dir, {
      tool_name: 'Read', tool_input: { file_path: path.join(dir, 'src/value.js') },
    }));
    const denied = invoke(binary, dir, {
      tool_name: 'Write', tool_input: { file_path: path.join(dir, 'src/value.js'), content: 'change' },
    });
    expect(denied).toEqual({ hookSpecificOutput: {
      hookEventName: 'PreToolUse', permissionDecision: 'deny',
      permissionDecisionReason: 'APE write denied: main-session production writes are forbidden',
    } });
  }, 30_000);

  it('delivers bounded draft corrections only to the exact launched and bound worker', async () => {
    const { dir, action, ticket } = await project(true, 'native-v1');
    expect(ticket.receipt_contract_version).toBe(1);
    const dispatch = action.dispatch;
    const launch = invoke(binary, dir, {
      tool_use_id: 'neutral-launch', tool_name: 'Agent',
      tool_input: { subagent_type: dispatch.agent_type,
        prompt: dispatch.dispatch_intent.prompt, model: dispatch.model.model },
    });
    // Continue to binding before asserting launch neutrality so correction
    // coverage is independent of the first obsolete allow encountered.
    const identity = { agent_id: 'neutral-child', agent_type: dispatch.agent_type };
    const bound = invoke(binary, dir, { hook_event_name: 'SubagentStart', ...identity });
    const bindingContext = bound.hookSpecificOutput?.additionalContext;
    expect(bindingContext).toContain(ticket.ticket_id);
    const capability = /APE_RECEIPT_CAPABILITY=([A-Za-z0-9_-]+)/.exec(bindingContext)?.[1];
    expect(capability).toBeTruthy();
    const draft = { ticket_id: ticket.ticket_id, status: 'invalid-neutral-status',
      tests: [], findings: [], evidence: { summary: 'fixture' }, receipt_capability: capability };
    const validation = validateReceiptDraft(ticket, draft);
    expect(validation.valid).toBe(false);
    expect(validation.corrections.some((entry) => entry.field === 'status')).toBe(true);
    const call = { ...identity, tool_name: 'mcp__ape__ape_validate_receipt',
      tool_input: { project_dir: dir, ticket_id: ticket.ticket_id, draft } };
    const before = await readJson(runtimePaths(dir).active);
    const response = invoke(binary, dir, call);
    const context = response.hookSpecificOutput?.additionalContext;
    expect(context).toEqual(expect.any(String));
    for (const correction of validation.corrections) {
      expect(context).toContain(correction.field);
      expect(context).toContain(correction.issue);
    }
    expect(Buffer.byteLength(context)).toBeLessThan(40_000);
    expect(context).not.toContain(capability);
    expectNeutral(response, context);
    expectNeutral(launch);
    for (const badCall of [
      { ...call, agent_id: 'foreign-child' },
      { ...call, tool_input: { ...call.tool_input, ticket_id: 'foreign-ticket' } },
    ]) {
      const denied = invoke(binary, dir, badCall);
      expect(denied).toEqual({ hookSpecificOutput: {
        hookEventName: 'PreToolUse', permissionDecision: 'deny',
        permissionDecisionReason: 'APE receipt validation denied: no exact active bound receipt-contract ticket matches receipt.ticket_id',
      } });
      expect(JSON.stringify(denied)).not.toContain(capability);
    }
    expect((await readJson(runtimePaths(dir).active)).receipts).toEqual(before.receipts);
  }, 30_000);
});

describe.each(binaries)('documentation-derived Claude permission fixtures: %s (not live UI)', (binary) => {
  it.each([null, 'deny', 'ask'])('preserves the documented ordinary Write outcome with rule %s', async (rule) => {
    const { dir } = await project();
    const captured = invoke(binary, dir, {
      tool_name: 'Write', tool_input: { file_path: 'notes.md', content: 'fixture' },
    });
    expect(documentedOrdinaryWriteOutcome(captured, rule)).toBe(rule === 'deny' ? 'denied' : 'prompt');
    const obsoleteAllow = { hookSpecificOutput: { permissionDecision: 'allow' } };
    expect(documentedOrdinaryWriteOutcome(obsoleteAllow, rule))
      .toBe(rule === 'deny' ? 'denied' : rule === 'ask' ? 'prompt' : 'approved');
  });
});
