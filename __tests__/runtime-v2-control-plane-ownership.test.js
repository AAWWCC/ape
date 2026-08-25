import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { evaluateLifecyclePolicy } from '../lib/runtime/hooks.js';

// Control-plane ownership (friction #13; phantom-dispatch incident). The
// orchestrator (main session) owns ape_run/ape_status/ape_config/ape_history; a bound
// Claude subagent that reached ape_run next would receive a live dispatch nonce
// — a launch capability — and could spawn its own subagent, exactly the phantom
// binding the operator had to expire-dispatch away. The one-owner deny closes
// that at nonce acquisition; the main-session exemption stays so recovery never
// deadlocks.
describe('APE v2 control-plane ownership policy', () => {
  const implementerTicket = {
    ticket_id: 'run-1:build:b',
    role: 'implementer',
    writable: true,
    test_paths: ['__tests__'],
    claimed_paths: ['src'],
  };
  const reviewerTicket = {
    ticket_id: 'run-1:review:r',
    role: 'reviewer',
    writable: false,
    test_paths: ['__tests__'],
    claimed_paths: [],
  };
  const subagentCall = (toolName, overrides = {}) => ({
    host: 'claude',
    event: 'PreToolUse',
    is_subagent: true,
    ape_managed: true,
    tool_name: toolName,
    ...overrides,
  });

  const CONTROL_TOOLS = [
    'mcp__plugin_ape_ape__ape_run',
    'mcp__ape__ape_run',
    'ape_run',
    'mcp__plugin_ape_ape__ape_status',
    'mcp__ape__ape_status',
    'ape_status',
    'mcp__plugin_ape_ape__ape_config',
    'mcp__plugin_ape_ape__ape_history',
  ];

  it('denies every control-plane tool from a bound Claude subagent in running state', () => {
    for (const tool of CONTROL_TOOLS) {
      const result = evaluateLifecyclePolicy(subagentCall(tool), {
        state: { status: 'running' },
        ticket: implementerTicket,
      });
      expect(result.decision, tool).toBe('deny');
      expect(result.reason, tool).toMatch(/orchestrator owns/);
    }
  });

  it('denies while the run is blocked and the binding is unresolvable (the incident shape)', () => {
    // The resumed implementer's binding no longer resolves (ticket not pending),
    // so ape_managed comes from the ape:* agent_type fallback and ticket is null.
    const result = evaluateLifecyclePolicy(subagentCall('mcp__plugin_ape_ape__ape_run'), {
      state: { status: 'blocked' },
      ticket: null,
    });
    expect(result.decision).toBe('deny');
    expect(result.reason).toMatch(/orchestrator owns/);
  });

  it('denies in a sealed state so an orphan cannot start or advance a new run', () => {
    const result = evaluateLifecyclePolicy(subagentCall('mcp__plugin_ape_ape__ape_run'), {
      state: { status: 'completed' },
      ticket: { ...implementerTicket },
    });
    expect(result.decision).toBe('deny');
    expect(result.reason).toMatch(/orchestrator owns/);
  });

  it('allows the main session (is_subagent false) in running AND blocked states', () => {
    // Pins the recovery-deadlock guarantee: the orchestrator must always reach
    // record/abort/override, including while the run is blocked. (In the binary
    // the pre-policy exemption short-circuits these; the policy path allows too.)
    for (const status of ['running', 'blocked']) {
      for (const tool of CONTROL_TOOLS) {
        const result = evaluateLifecyclePolicy(
          subagentCall(tool, { is_subagent: false, ape_managed: undefined }),
          { state: { status }, ticket: null },
        );
        expect(result.decision, `${tool} @ ${status}`).toBe('allow');
      }
    }
  });

  it('denies a subagent carrying no agent identity (ape_managed undefined)', () => {
    // Deliberately governs the identity-less is_subagent case, matching the
    // indirect-channel predicate (ape_managed !== false).
    const result = evaluateLifecyclePolicy(
      subagentCall('mcp__plugin_ape_ape__ape_run', { ape_managed: undefined }),
      { state: { status: 'running' }, ticket: implementerTicket },
    );
    expect(result.decision).toBe('deny');
    expect(result.reason).toMatch(/orchestrator owns/);
  });

  it('denies a managed codex subagent and leaves an unmanaged Claude subagent outside the deny', () => {
    const codex = evaluateLifecyclePolicy(
      subagentCall('mcp__plugin_ape_ape__ape_run', { host: 'codex' }),
      { state: { status: 'running' }, ticket: implementerTicket },
    );
    expect(codex.decision).toBe('deny');
    expect(codex.reason).toMatch(/orchestrator owns/);

    const unmanaged = evaluateLifecyclePolicy(
      subagentCall('mcp__plugin_ape_ape__ape_run', { ape_managed: false }),
      { state: { status: 'running' }, ticket: implementerTicket },
    );
    expect(unmanaged.decision).toBe('allow');
  });

  it('leaves the safe read-only tool surface unchanged and still denies Agent', () => {
    const read = evaluateLifecyclePolicy(subagentCall('Read'), {
      state: { status: 'running' },
      ticket: reviewerTicket,
    });
    expect(read.decision).toBe('allow');
    const grep = evaluateLifecyclePolicy(subagentCall('Grep'), {
      state: { status: 'running' },
      ticket: reviewerTicket,
    });
    expect(grep.decision).toBe('allow');
    const agent = evaluateLifecyclePolicy(subagentCall('Agent'), {
      state: { status: 'running' },
      ticket: reviewerTicket,
    });
    expect(agent.decision).toBe('deny');
    expect(agent.reason).toMatch(/indirect channel/);
  });

  it('never treats a boundary event (empty tool_name) as a control-plane call', () => {
    for (const boundary of ['Stop', 'SubagentStop']) {
      const result = evaluateLifecyclePolicy(
        subagentCall('', { event: boundary }),
        { state: { status: 'running' }, ticket: implementerTicket },
      );
      expect(result.decision, boundary).toBe('allow');
    }
  });
});

// End-to-end against the SOURCE hook binary (bin/ape-hook.mjs), not the stale
// dist bundle: the fix is not live in the installed hook until the deferred
// bundle pass, but the source enforcement must be exercised here.
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const hookBinary = path.join(root, 'bin', 'ape-hook.mjs');
const cleanups = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function project(status = 'running') {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-control-plane-'));
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
      ticket_id: 'run-1:build:ticket-1',
      role: 'implementer',
      writable: true,
      claimed_paths: ['src'],
      test_paths: ['__tests__'],
      base_tree_sha: baseTree,
    }],
    receipts: [],
  }));
  return dir;
}

function claudeEnv() {
  const env = { ...process.env, CLAUDECODE: '1' };
  delete env.CLAUDE_PROJECT_DIR;
  delete env.CODEX_CWD;
  delete env.APE_TICKET_ID;
  return env;
}

function invokeHook(input, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hookBinary], {
      cwd,
      env: claudeEnv(),
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

const decision = (response) => response.hookSpecificOutput.permissionDecision;

describe('APE v2 control-plane ownership (installed hook binary)', () => {
  it('denies a bound subagent ape_run in running state', async () => {
    const dir = await project('running');
    const response = await invokeHook({
      hook_event_name: 'PreToolUse',
      project_dir: dir,
      session_id: 's1',
      agent_id: 'native-agent-1',
      agent_type: 'ape:implementer',
      tool_name: 'mcp__plugin_ape_ape__ape_run',
      tool_input: { action: 'next' },
    }, dir);
    expect(decision(response)).toBe('deny');
    expect(response.hookSpecificOutput.permissionDecisionReason).toMatch(/orchestrator owns/);
  });

  it('denies a subagent ape_run while the run is blocked (the incident shape)', async () => {
    const dir = await project('blocked');
    const response = await invokeHook({
      hook_event_name: 'PreToolUse',
      project_dir: dir,
      session_id: 's1',
      agent_id: 'native-agent-1',
      agent_type: 'ape:implementer',
      tool_name: 'mcp__plugin_ape_ape__ape_run',
      tool_input: { action: 'next' },
    }, dir);
    expect(decision(response)).toBe('deny');
    expect(response.hookSpecificOutput.permissionDecisionReason).toMatch(/orchestrator owns/);
  });

  it('allows a main-session ape_run with an unattributed working-tree change', async () => {
    const dir = await project('running');
    // The exact state that deadlocked recovery: an unattributed tree change with
    // no receipt yet. The main-session control-plane call must still get through.
    await writeFile(path.join(dir, 'src', 'value.js'), 'export const value = 2;\n');
    const response = await invokeHook({
      hook_event_name: 'PreToolUse',
      project_dir: dir,
      tool_name: 'mcp__plugin_ape_ape__ape_run',
      tool_input: { action: 'record' },
    }, dir);
    expect(decision(response)).toBe('allow');
  });

  it('allows a main-session ape_run while the run is blocked', async () => {
    const dir = await project('blocked');
    const response = await invokeHook({
      hook_event_name: 'PreToolUse',
      project_dir: dir,
      tool_name: 'mcp__plugin_ape_ape__ape_run',
      tool_input: { action: 'regate' },
    }, dir);
    expect(decision(response)).toBe('allow');
  });
});

// Corrupt-state recovery hatch. `readJson` (lib/runtime/storage.js) rethrows a
// JSON.parse SyntaxError — only ENOENT yields the fallback — so an unparseable
// .ape/runtime/active.json makes the hook's active-state read (bin/ape-hook.mjs)
// throw, and the catch re-reads the same corrupt file and rethrows, leaving
// decision null and every tool call failed-closed. That bricks the very
// control-plane recovery call (ape_run override / ape_config) designed to clear
// it. The fix hoists the MAIN-session control-plane exemption ahead of the state
// read (it depends only on is_subagent + tool_name, never on state), so the
// operator's recovery call still resolves to allow. The exemption stays
// main-session-only and control-plane-only: a bound subagent's control-plane
// call and a non-exempt main-session write both keep failing closed on corrupt
// state.
function effectiveDecision(response) {
  // A PreToolUse decision rides in hookSpecificOutput; the fail-closed catch
  // path (event normalized to 'unknown') emits the top-level `{decision:
  // 'block'}` shape instead. Normalize both so a corrupt-state fail-closed deny
  // and the exemption allow are directly comparable.
  if (response.hookSpecificOutput) return response.hookSpecificOutput.permissionDecision;
  return response.decision === 'block' ? 'deny' : response.decision;
}

async function corruptProject() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-control-plane-corrupt-'));
  cleanups.push(dir);
  // Literal non-JSON: JSON.parse throws a SyntaxError (not ENOENT), so every
  // readJson of this file rethrows — the exact self-brick the fix defuses. No
  // git tree is needed: the state read throws before any tree work runs, and
  // the `.ape` directory alone anchors resolveGovernedRoot to this project.
  await mkdir(path.join(dir, '.ape', 'runtime'), { recursive: true });
  await writeFile(path.join(dir, '.ape', 'runtime', 'active.json'), '{ corrupt');
  return dir;
}

const CORRUPT_CONTROL_TOOLS = [
  'mcp__plugin_ape_ape__ape_run',
  'mcp__plugin_ape_ape__ape_status',
  'mcp__plugin_ape_ape__ape_config',
  'mcp__plugin_ape_ape__ape_history',
];

describe('APE v2 corrupt-state control-plane recovery (installed hook binary)', () => {
  it('allows a main-session control-plane call when active.json is unparseable', async () => {
    // RED on the base tree: the pre-exemption state read throws, the catch
    // re-reads the corrupt file and rethrows, decision stays null, and the hook
    // fails closed ('APE hook failed closed: ...'). Post-fix the hoisted
    // main-session exemption short-circuits to allow before the read.
    const dir = await corruptProject();
    for (const tool of CORRUPT_CONTROL_TOOLS) {
      const response = await invokeHook({
        hook_event_name: 'PreToolUse',
        project_dir: dir,
        session_id: 's1',
        tool_name: tool,
        tool_input: { action: 'record' },
      }, dir);
      expect(effectiveDecision(response), tool).toBe('allow');
    }
  });

  it('still denies a bound subagent control-plane call on corrupt active.json', async () => {
    // Preserved posture: the exemption is main-session-only, so a subagent's
    // ape_run never short-circuits — the state read still throws and the hook
    // fails closed. Assert the deny only; with unreadable state it comes from
    // the catch, not evaluateLifecyclePolicy's one-owner reason.
    const dir = await corruptProject();
    const response = await invokeHook({
      hook_event_name: 'PreToolUse',
      project_dir: dir,
      session_id: 's1',
      agent_id: 'native-agent-1',
      agent_type: 'ape:implementer',
      tool_name: 'mcp__plugin_ape_ape__ape_run',
      tool_input: { action: 'next' },
    }, dir);
    expect(effectiveDecision(response)).toBe('deny');
  });

  it('still denies a non-exempt main-session write on corrupt active.json', async () => {
    // The exemption is control-plane-only: a main-session Write on corrupt
    // state keeps failing closed, so the fix cannot widen the write gate.
    const dir = await corruptProject();
    const response = await invokeHook({
      hook_event_name: 'PreToolUse',
      project_dir: dir,
      session_id: 's1',
      tool_name: 'Write',
      tool_input: { file_path: 'src/value.js', content: 'export const value = 2;\n' },
    }, dir);
    expect(effectiveDecision(response)).toBe('deny');
  });
});
