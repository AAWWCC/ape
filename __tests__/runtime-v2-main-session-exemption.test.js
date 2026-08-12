import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { evaluateLifecyclePolicy } from '../lib/runtime/hooks.js';

// Main-session-exemption binding hardening. A control-plane tool event
// (ape_run / ape_config / ape_history, bare or mcp-namespaced) that carries a
// host-delivered ticket binding — a payload ticket_id field or the
// APE_TICKET_ID env channel — is a bound worker call even when the host
// attaches no agent identity, so it must no longer qualify for the pre-policy
// main-session exemption in bin/ape-hook.mjs and must end in a deny at the
// host-neutral one-owner branch. Genuine main-session calls (no binding at
// all) keep the exemption byte-for-byte — the recovery-deadlock guarantee —
// and the widening never leaks past CONTROL_PLANE_TOOLS, boundary events, or
// an empty-string binding.

const CONTROL_TOOLS = [
  'ape_run',
  'ape_config',
  'ape_history',
  'mcp__plugin_ape_ape__ape_run',
  'mcp__plugin_ape_ape__ape_config',
  'mcp__plugin_ape_ape__ape_history',
];

describe('APE v2 identity-less bound control-plane calls (unit)', () => {
  const implementerTicket = {
    ticket_id: 'run-1:build:b1',
    role: 'implementer',
    writable: true,
    test_paths: ['__tests__'],
    claimed_paths: ['src'],
  };
  // The identity-less bound shape: the host attached no agent identity
  // (is_subagent false), but the event carries a host-delivered ticket
  // binding on ticket_id.
  const boundCall = (host, toolName, overrides = {}) => ({
    host,
    event: 'PreToolUse',
    is_subagent: false,
    tool_name: toolName,
    ticket_id: 'run-1:build:b1',
    ...overrides,
  });

  // RED anchor R1: today the one-owner branch requires event.is_subagent, so
  // every identity-less bound codex call falls through to the
  // safe-non-writing-tool allow.
  it('denies every control-plane tool, bare and namespaced, from an identity-less bound codex call (R1)', () => {
    for (const tool of CONTROL_TOOLS) {
      const result = evaluateLifecyclePolicy(boundCall('codex', tool), {
        state: { status: 'running' },
        ticket: implementerTicket,
      });
      expect(result.decision, tool).toBe('deny');
      expect(result.reason, tool).toMatch(/orchestrator owns/);
    }
  });

  // RED anchor R2: the widening is host-neutral — the identical shape on the
  // claude host is equally denied.
  it('denies the same identity-less bound shape on the claude host (R2)', () => {
    for (const tool of CONTROL_TOOLS) {
      const result = evaluateLifecyclePolicy(boundCall('claude', tool), {
        state: { status: 'running' },
        ticket: implementerTicket,
      });
      expect(result.decision, tool).toBe('deny');
      expect(result.reason, tool).toMatch(/orchestrator owns/);
    }
  });

  // RED anchor R3: the one-owner deny is status-independent — a blocked run
  // with no resolvable ticket and a sealed completed run both deny.
  it('denies status-independently while blocked and while sealed completed (R3)', () => {
    const blocked = evaluateLifecyclePolicy(boundCall('codex', 'mcp__plugin_ape_ape__ape_run'), {
      state: { status: 'blocked' },
      ticket: null,
    });
    expect(blocked.decision).toBe('deny');
    expect(blocked.reason).toMatch(/orchestrator owns/);

    const completed = evaluateLifecyclePolicy(boundCall('codex', 'mcp__plugin_ape_ape__ape_run'), {
      state: { status: 'completed' },
      ticket: { ...implementerTicket },
    });
    expect(completed.decision).toBe('deny');
    expect(completed.reason).toMatch(/orchestrator owns/);
  });

  // GREEN guardrail G4: re-assert the two control-plane-ownership pins — the
  // Claude main session with no binding stays allowed in running AND blocked
  // states. A managed Codex subagent is still not the orchestrator even when
  // its event carries no ticket binding.
  it('keeps main-session recovery and denies an unbound managed codex subagent (G4)', () => {
    for (const status of ['running', 'blocked']) {
      for (const tool of CONTROL_TOOLS) {
        const result = evaluateLifecyclePolicy(
          {
            host: 'claude',
            event: 'PreToolUse',
            is_subagent: false,
            ape_managed: undefined,
            tool_name: tool,
          },
          { state: { status }, ticket: null },
        );
        expect(result.decision, `${tool} @ ${status}`).toBe('allow');
      }
    }
    const codexManaged = evaluateLifecyclePolicy(
      {
        host: 'codex',
        event: 'PreToolUse',
        is_subagent: true,
        ape_managed: true,
        tool_name: 'mcp__plugin_ape_ape__ape_run',
      },
      { state: { status: 'running' }, ticket: implementerTicket },
    );
    expect(codexManaged.decision).toBe('deny');
    expect(codexManaged.reason).toMatch(/orchestrator owns/);
  });

  // GREEN guardrail G5: an empty-string binding is not a binding.
  it('treats an empty-string binding as no binding on both hosts (G5)', () => {
    for (const host of ['claude', 'codex']) {
      const result = evaluateLifecyclePolicy(
        boundCall(host, 'mcp__plugin_ape_ape__ape_run', { ticket_id: '' }),
        { state: { status: 'running' }, ticket: implementerTicket },
      );
      expect(result.decision, host).toBe('allow');
    }
  });

  // GREEN guardrail G6: boundary events carry the receipt-bearing final
  // message and are never tool calls, even with a truthy ticket_id aboard.
  it('never treats a boundary event carrying a truthy binding as a control-plane call (G6)', () => {
    for (const host of ['claude', 'codex']) {
      for (const boundary of ['Stop', 'SubagentStop']) {
        const result = evaluateLifecyclePolicy(
          boundCall(host, '', { event: boundary }),
          { state: { status: 'running' }, ticket: implementerTicket },
        );
        expect(result.decision, `${host} ${boundary}`).toBe('allow');
      }
    }
  });

  // GREEN guardrail G7: the widening never leaks past CONTROL_PLANE_TOOLS — a
  // bound non-control-plane tool stays allowed on both hosts.
  it('keeps a bound non-control-plane tool outside the widening on both hosts (G7)', () => {
    for (const host of ['claude', 'codex']) {
      const result = evaluateLifecyclePolicy(boundCall(host, 'Read'), {
        state: { status: 'running' },
        ticket: implementerTicket,
      });
      expect(result.decision, host).toBe('allow');
    }
  });
});

// End-to-end against the SOURCE hook binary (bin/ape-hook.mjs), matching the
// other hook e2e suites: a targeted run after a lib/runtime or bin edit must
// exercise the edited code, not a stale dist bundle.
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const hookBinary = path.join(root, 'bin', 'ape-hook.mjs');
const cleanups = [];

const PENDING_TICKET_ID = 'run-1:build:ticket-1';
const EXEMPTION_REASON = 'APE control-plane MCP call is exempt from the stage guard';

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function project(status = 'running') {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-main-session-exemption-'));
  cleanups.push(dir);
  await mkdir(path.join(dir, 'src'), { recursive: true });
  await writeFile(path.join(dir, 'src', 'value.js'), 'export const value = 1;\n');
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'ape@example.test'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'APE Test'], { cwd: dir });
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'baseline'], { cwd: dir });
  const baseTree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], {
    cwd: dir,
    encoding: 'utf8',
  }).trim();
  await mkdir(path.join(dir, '.ape', 'runtime'), { recursive: true });
  await writeFile(path.join(dir, '.ape', 'runtime', 'active.json'), JSON.stringify({
    run_id: 'run-1',
    status,
    tree_sha: baseTree,
    tickets: [{
      ticket_id: PENDING_TICKET_ID,
      role: 'implementer',
      writable: true,
      claimed_paths: ['src'],
      test_paths: ['__tests__'],
      base_tree_sha: baseTree,
    }],
    expired_tickets: [],
    receipts: [],
  }));
  return dir;
}

// Literal non-JSON active.json: readJson rethrows the SyntaxError, so any
// path that consults the state before deciding fails closed here. The
// main-session exemption must precede that read. No git tree is needed — the
// `.ape` directory alone anchors resolveGovernedRoot to this project.
async function corruptProject() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-main-session-exemption-corrupt-'));
  cleanups.push(dir);
  await mkdir(path.join(dir, '.ape', 'runtime'), { recursive: true });
  await writeFile(path.join(dir, '.ape', 'runtime', 'active.json'), '{ corrupt');
  return dir;
}

// A governed project with NO active.json at all: the `.ape` marker anchors
// the root, and the state read resolves to null (no active run).
async function statelessProject() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-main-session-exemption-nostate-'));
  cleanups.push(dir);
  await mkdir(path.join(dir, '.ape', 'runtime'), { recursive: true });
  return dir;
}

// Host env helpers. The host markers and APE_TICKET_ID are stripped so an
// ambient export from whoever runs the suite cannot smuggle a host identity
// or a binding into the no-binding cases; tests that exercise the
// env-delivered binding channel opt back in via overrides.
function baseEnv(overrides = {}) {
  const env = { ...process.env };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE;
  delete env.CLAUDE_PROJECT_DIR;
  delete env.CODEX_CWD;
  delete env.APE_TICKET_ID;
  return { ...env, ...overrides };
}
const codexEnv = (overrides = {}) => baseEnv(overrides);
const claudeEnv = (overrides = {}) => baseEnv({ CLAUDECODE: '1', ...overrides });

function invokeHook(input, env = codexEnv()) {
  return new Promise((resolve, reject) => {
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

// Claude PreToolUse responses ride in hookSpecificOutput. Codex deny responses
// carry a decision; neutral JSON is the documented allow shape.
const claudeDecision = (response) => response.hookSpecificOutput.permissionDecision;
const claudeReason = (response) => response.hookSpecificOutput.permissionDecisionReason;
const codexDecision = (response) =>
  response.hookSpecificOutput?.permissionDecision === 'deny' || response.decision === 'block'
    ? 'deny'
    : 'allow';

describe('APE v2 main-session exemption binding hardening (source hook binary)', () => {
  // RED anchor R4: a payload-bound control-plane call with no agent identity
  // at all currently sails through the pre-policy exemption; it must deny.
  it('denies an identity-less codex control-plane call bound via the payload ticket_id (R4)', async () => {
    const dir = await project();
    const response = await invokeHook({
      hook_event_name: 'PreToolUse',
      project_dir: dir,
      ticket_id: PENDING_TICKET_ID,
      tool_name: 'mcp__plugin_ape_ape__ape_run',
      tool_input: { action: 'next' },
    });
    expect(codexDecision(response)).toBe('deny');
  });

  // RED anchor R5: the binding may equally arrive via the APE_TICKET_ID env
  // channel instead of the payload field.
  it('denies the identity-less control-plane call when the binding arrives via env APE_TICKET_ID (R5)', async () => {
    const dir = await project();
    const response = await invokeHook({
      hook_event_name: 'PreToolUse',
      project_dir: dir,
      tool_name: 'mcp__plugin_ape_ape__ape_run',
      tool_input: { action: 'next' },
    }, codexEnv({ APE_TICKET_ID: PENDING_TICKET_ID }));
    expect(codexDecision(response)).toBe('deny');
  });

  // GREEN guardrail G1: a genuine main-session control-plane call — no
  // binding — keeps the exemption byte-for-byte while the run is running.
  it('keeps the claude main-session exemption byte-for-byte while running (G1)', async () => {
    const dir = await project('running');
    for (const tool of CONTROL_TOOLS) {
      const response = await invokeHook({
        hook_event_name: 'PreToolUse',
        project_dir: dir,
        tool_name: tool,
        tool_input: { action: 'record' },
      }, claudeEnv());
      expect(claudeDecision(response), tool).toBe('allow');
      expect(claudeReason(response), tool).toBe(EXEMPTION_REASON);
    }
  });

  // GREEN guardrail G1 (blocked arm): recovery must never deadlock — the
  // exemption holds identically while the run is blocked.
  it('keeps the claude main-session exemption byte-for-byte while blocked (G1)', async () => {
    const dir = await project('blocked');
    for (const tool of CONTROL_TOOLS) {
      const response = await invokeHook({
        hook_event_name: 'PreToolUse',
        project_dir: dir,
        tool_name: tool,
        tool_input: { action: 'regate' },
      }, claudeEnv());
      expect(claudeDecision(response), tool).toBe('allow');
      expect(claudeReason(response), tool).toBe(EXEMPTION_REASON);
    }
  });

  // GREEN guardrail G2: the exemption precedes the state read, so a corrupt
  // active.json still lets the operator's recovery call through.
  it('allows the claude main-session control-plane call on corrupt active.json (G2)', async () => {
    const dir = await corruptProject();
    const response = await invokeHook({
      hook_event_name: 'PreToolUse',
      project_dir: dir,
      tool_name: 'mcp__plugin_ape_ape__ape_run',
      tool_input: { action: 'record' },
    }, claudeEnv());
    expect(claudeDecision(response)).toBe('allow');
  });

  // GREEN guardrail G3: the codex main session (no binding, no identity)
  // keeps its control-plane exemption.
  it('allows the codex main-session control-plane call with no binding (G3)', async () => {
    const dir = await project();
    const response = await invokeHook({
      hook_event_name: 'PreToolUse',
      project_dir: dir,
      tool_name: 'mcp__plugin_ape_ape__ape_run',
      tool_input: { action: 'record' },
    });
    expect(codexDecision(response)).toBe('allow');
  });

  // GREEN guardrail G8: with no active.json at all there is no run to guard —
  // an identity-less bound call resolves to allow (decision only; the reason
  // may come from the exemption or the no-active-run path).
  it('allows an identity-less bound control-plane call when no active.json exists (G8)', async () => {
    const dir = await statelessProject();
    const response = await invokeHook({
      hook_event_name: 'PreToolUse',
      project_dir: dir,
      ticket_id: PENDING_TICKET_ID,
      tool_name: 'mcp__plugin_ape_ape__ape_run',
      tool_input: { action: 'next' },
    });
    expect(codexDecision(response)).toBe('allow');
  });
});
