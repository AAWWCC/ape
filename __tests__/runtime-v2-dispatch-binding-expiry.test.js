import { execFileSync, spawn } from 'node:child_process';
import { readFile, mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { runtimePaths } from '../lib/runtime/paths.js';
import { startRun } from '../lib/runtime/service.js';
import { atomicWriteJson } from '../lib/runtime/storage.js';

// dispatch-binding-resume-gap (chosen disposition: outcome (a)).
//
// THE GAP, RE-VERIFIED AGAINST THIS TREE rather than trusted from the ticket's
// 2026-07-26 narrative: launchClaudeIntent/bindClaudeSubagent mint a SHORT
// launch_expires_at (~60s after launched_at) that governs only the window in
// which a fresh Agent-tool nonce may be claimed and a fresh SubagentStart may
// consume it. That window closing is NOT the ticket's authorization horizon —
// deadline_at is — and resolveClaudeBinding (the read path every ordinary
// bound tool call resolves through) already agrees: it filters only on the
// intent's own `expires_at` (mirrors the TICKET deadline), never on
// launch_expires_at. bindClaudeSubagent's SubagentStart handler disagrees with
// its own sibling read path: a host that re-fires SubagentStart for an
// identity that is ALREADY 'bound' — exactly what resuming a subagent that
// died mid-flight from its own transcript does — finds no matching 'launched'
// record (the one it consumed already moved to 'bound') and denies with a
// stale-sounding "no unique active launched intent", even though the SAME
// identity's ordinary tool calls keep resolving fine through
// resolveClaudeBinding the whole time. That is the untruthful half (invariant
// 8): the intent reads 'bound' and IS live by the read path's own account, yet
// probing it via the one channel a resuming host actually has — SubagentStart
// — gets denied.
//
// DISPOSITION: outcome (a). A resumed subagent can re-acquire its binding for
// the remainder of the TICKET deadline, not the ~60-second launch window: a
// SubagentStart carrying the EXACT identity (run, session, agent id, agent
// type) already bound to a still-pending ticket must be admitted, whatever
// launch_expires_at reads, as long as the TICKET deadline has not elapsed.
// Nothing about WHAT a binding authorizes widens — claimed_paths, required
// checks and the ticket deadline are untouched — and every other shape stays
// denied exactly as it is today: a wrong agent id, no prior binding at all,
// and a binding whose ticket deadline has genuinely elapsed.
//
// Each `it` below carries one arm of the acceptance boundary: bound before
// launch_expires_at (established by the shared launchAndBind helper, exactly
// the existing 'binds SubagentStart' contract), then observed AGAIN after
// launch_expires_at has closed, asserting the outcome chosen above.
//
// TEST-REMEDIATION (blocking review, run-fixture-d240e006d022): the
// Claude's SubagentStart deny shape is `{decision:'block', reason}` (allow is either a
// fresh-capability `additionalContext` payload or, on an idempotent resume
// that mints nothing new, a bare `{}` — never a top-level `reason`). Every
// arm below now asserts the ACTUAL wire shape, not just the coarse
// allow/deny outcome, so a cause-specific denial reason ships proven rather
// than collapsing invisibly behind `subagentStartOutcome`.

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const hookBinary = path.join(root, 'bin', 'ape-hook.mjs');
const cleanups = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function project() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-dispatch-expiry-'));
  cleanups.push(dir);
  await mkdir(path.join(dir, 'src'));
  await mkdir(path.join(dir, 'tests'));
  await writeFile(path.join(dir, 'src', 'value.js'), 'export const value = 1;\n');
  await writeFile(path.join(dir, 'tests', 'value.test.js'), 'throw new Error("red");\n');
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'ape@example.test');
  git(dir, 'config', 'user.name', 'APE Test');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'test: baseline');
  await atomicWriteJson(runtimePaths(dir).config, {
    shipping: { auto_merge: false, provider: 'github', required_remote_checks: false },
    test_commands: { full: 'node --test' },
  });
  return dir;
}

async function startClaude(dir) {
  const result = await startRun(dir, {
    objective: 'Change behavior through a standard Claude Agent',
    mode: 'phase',
    lane: 'fast',
    host: 'claude',
    claimed_paths: ['src/value.js'],
    test_paths: ['tests/value.test.js'],
    requirements: ['R-CLAUDE-BINDING'],
    risk_triggers: [],
    behavioral: true,
    hooks_trusted: true,
    subagents_available: true,
    explicit_invocation: true,
  });
  expect(result.ok).toBe(true);
  const action = result.actions.find((entry) => entry.type === 'dispatch_agent');
  expect(action).toBeDefined();
  return { result, action, ticket: action.ticket };
}

async function readOnlyIntent(dir) {
  const paths = runtimePaths(dir);
  const names = (await readdir(paths.dispatchIntents)).filter((name) => name.endsWith('.json'));
  expect(names).toHaveLength(1);
  const file = path.join(paths.dispatchIntents, names[0]);
  return { file, intent: JSON.parse(await readFile(file, 'utf8')) };
}

function launchNonce(dispatch) {
  return (
    dispatch?.dispatch_intent?.nonce ??
    dispatch?.intent?.nonce ??
    dispatch?.launch?.nonce ??
    dispatch?.nonce ??
    null
  );
}

function launchPrompt(dispatch, nonce, ticket) {
  return (
    dispatch?.dispatch_intent?.prompt ??
    dispatch?.intent?.prompt ??
    dispatch?.launch?.prompt ??
    dispatch?.prompt ??
    `Execute the immutable ticket ${ticket.ticket_id}.\nAPE_DISPATCH_NONCE=${nonce}`
  );
}

function launchModel(dispatch) {
  return dispatch?.model?.model;
}

function invokeClaudeHook(input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hookBinary], {
      cwd: root,
      env: { ...process.env, CLAUDECODE: '1' },
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

function preToolDecision(response) {
  return response?.hookSpecificOutput?.permissionDecision;
}

// SubagentStart has no `permissionDecision` shape at all (formatHookResponse):
// an allow is EITHER `{hookSpecificOutput: {additionalContext}}` (a fresh
// capability minted) OR a bare `{}` (allowed, nothing to inject); a deny is
// the lifecycle-block shape `{decision: 'block', reason}`. Callers must not
// key admission off additionalContext being present — an idempotent
// re-admission may legitimately mint nothing new — so the only reliable
// allow/deny signal is the presence of the block shape.
function subagentStartOutcome(response) {
  return response?.decision === 'block' ? 'deny' : 'allow';
}

// Drives one ticket through launch + SubagentStart bind exactly as the
// existing, passing 'binds SubagentStart before first prompt' contract does,
// and returns the ticket/action plus the identity used so a later step can
// probe the SAME identity again after time has notionally passed.
async function launchAndBind(dir, { sessionId, agentId }) {
  const { action, ticket } = await startClaude(dir);
  const nonce = launchNonce(action.dispatch);
  const prompt = launchPrompt(action.dispatch, nonce, ticket);

  const launch = await invokeClaudeHook({
    hook_event_name: 'PreToolUse',
    project_dir: dir,
    session_id: sessionId,
    tool_use_id: `${sessionId}-launch`,
    tool_name: 'Agent',
    tool_input: { subagent_type: action.dispatch.agent_type, prompt, model: launchModel(action.dispatch) },
  });
  expect(preToolDecision(launch)).toBe('allow');

  const started = await invokeClaudeHook({
    hook_event_name: 'SubagentStart',
    project_dir: dir,
    session_id: sessionId,
    agent_id: agentId,
    agent_type: action.dispatch.agent_type,
  });
  expect(subagentStartOutcome(started)).toBe('allow');
  expect(started?.hookSpecificOutput?.additionalContext).toEqual(expect.stringContaining('APE_RECEIPT_CAPABILITY='));

  return { action, ticket };
}

// Simulates "the launch window has long closed" without touching the
// ticket's own deadline: exactly the shape __tests__/runtime-v2-claude-
// dispatch.test.js's deadline test uses for the TICKET side, mirrored here for
// the LAUNCH side alone. The record's own `expires_at` (which mirrors the
// ticket deadline, per prepareClaudeIntent) is deliberately left untouched.
async function closeLaunchWindow(dir) {
  const { file, intent } = await readOnlyIntent(dir);
  expect(intent.status).toBe('bound');
  await atomicWriteJson(file, {
    ...intent,
    launch_expires_at: new Date(Date.now() - 60_000).toISOString(),
  });
}

// The genuine TICKET-deadline arm: both the live ticket in active.json and the
// intent's own mirrored `expires_at` move into the past, exactly as
// __tests__/runtime-v2-claude-dispatch.test.js's "denies a prepared intent
// once its ticket deadline has elapsed" case does it.
async function expireTicketDeadline(dir, ticketId) {
  const deadline = new Date(Date.now() - 60_000).toISOString();
  const paths = runtimePaths(dir);
  const state = JSON.parse(await readFile(paths.active, 'utf8'));
  state.tickets = state.tickets.map((entry) => (
    entry.ticket_id === ticketId ? { ...entry, deadline_at: deadline } : entry
  ));
  await atomicWriteJson(paths.active, state);
  const { file, intent } = await readOnlyIntent(dir);
  await atomicWriteJson(file, { ...intent, expires_at: deadline });
}

// The OTHER pendingTicket-false path (lib/runtime/claude-dispatch.js
// `pendingTicket`): the ticket was superseded by its own retry (the
// deadline-timeout transition lists it in `state.expired_tickets`), NOT a
// genuine deadline overrun. Mirrors expireTicketDeadline's own technique —
// hand-crafting active.json directly rather than driving the real
// deadline-timeout transition — but deliberately leaves BOTH the ticket's
// deadline_at and the intent's mirrored expires_at in the future, so any
// denial naming a deadline overrun here is provably false.
async function supersedeTicketByRetry(dir, ticketId) {
  const paths = runtimePaths(dir);
  const state = JSON.parse(await readFile(paths.active, 'utf8'));
  state.expired_tickets = [...(state.expired_tickets ?? []), ticketId];
  await atomicWriteJson(paths.active, state);
}

describe('APE v2 dispatch binding resume across the launch_expires_at boundary', () => {
  it('re-admits the correctly bound agent identity after the launch window closes but before the ticket deadline', async () => {
    const dir = await project();
    const { action, ticket } = await launchAndBind(dir, {
      sessionId: 'resume-parent',
      agentId: 'resume-agent',
    });
    await closeLaunchWindow(dir);

    // The SAME identity resumes: same run (implicit — one active run), same
    // parent session, same native agent id, same agent type.
    const resumed = await invokeClaudeHook({
      hook_event_name: 'SubagentStart',
      project_dir: dir,
      session_id: 'resume-parent',
      agent_id: 'resume-agent',
      agent_type: action.dispatch.agent_type,
    });
    expect(subagentStartOutcome(resumed)).toBe('allow');
    // Re-admission mints no fresh capability (the one already injected at the
    // original bind still stands), but it repeats the hook-enforced receipt
    // scaffold so a resumed worker cannot lose its artifact contract. Claude
    // has no cleartext capability recovery seam, so the context must not
    // synthesize a null or replacement bearer.
    const context = resumed?.hookSpecificOutput?.additionalContext;
    expect(context).toContain('APE hook-enforced receipt construction (authoritative)');
    expect(context).toContain('Receipt envelope scaffold');
    expect(context).toContain(`"ticket_id":"${ticket.ticket_id}"`);
    expect(context).toContain('"receipt_capability":"$APE_RECEIPT_CAPABILITY"');
    expect(context).not.toContain('APE_RECEIPT_CAPABILITY=null');
    expect(resumed).not.toHaveProperty('reason');

    // The ticket's own authority is unchanged: the same identity can still act
    // on its claims after being re-admitted post-launch-window.
    const write = await invokeClaudeHook({
      hook_event_name: 'PreToolUse',
      project_dir: dir,
      session_id: 'resume-parent',
      agent_id: 'resume-agent',
      agent_type: action.dispatch.agent_type,
      tool_name: 'Write',
      tool_input: { file_path: path.join(dir, 'tests', 'new.test.js'), content: 'test' },
    });
    expect(preToolDecision(write)).toBe('allow');
    void ticket;
  });

  it('still denies a different agent id claiming the same resumed session after the launch window closes', async () => {
    const dir = await project();
    const { action } = await launchAndBind(dir, {
      sessionId: 'impersonation-parent',
      agentId: 'legitimate-agent',
    });
    await closeLaunchWindow(dir);

    const impersonator = await invokeClaudeHook({
      hook_event_name: 'SubagentStart',
      project_dir: dir,
      session_id: 'impersonation-parent',
      agent_id: 'attacker-agent',
      agent_type: action.dispatch.agent_type,
    });
    expect(subagentStartOutcome(impersonator)).toBe('deny');
    // bound_agent_id mismatch takes the resumable branch out of play entirely
    // (record.bound_agent_id !== agentId), so this falls through to the
    // pre-existing launched-intent lookup — a cause distinct from, and
    // asserted distinctly from, a deadline overrun.
    expect(impersonator.reason).toBe('APE Claude binding denied: no unique active launched intent');

    // No stray binding was created for the wrong identity: its tool calls
    // still resolve to no active ticket.
    const write = await invokeClaudeHook({
      hook_event_name: 'PreToolUse',
      project_dir: dir,
      session_id: 'impersonation-parent',
      agent_id: 'attacker-agent',
      agent_type: action.dispatch.agent_type,
      tool_name: 'Write',
      tool_input: { file_path: path.join(dir, 'tests', 'new.test.js'), content: 'test' },
    });
    expect(preToolDecision(write)).toBe('deny');
  });

  it('still denies a SubagentStart with no matching prior binding at all', async () => {
    const dir = await project();
    await startClaude(dir);
    // Deliberately never launched or bound: a totally unrelated session/agent
    // identity has nothing recorded for it to resume.
    const orphan = await invokeClaudeHook({
      hook_event_name: 'SubagentStart',
      project_dir: dir,
      session_id: 'never-dispatched-parent',
      agent_id: 'never-dispatched-agent',
      agent_type: 'ape:test_writer',
    });
    expect(subagentStartOutcome(orphan)).toBe('deny');
    expect(orphan.reason).toBe('APE Claude binding denied: no unique active launched intent');
  });

  it('still denies re-admission once the ticket deadline itself has elapsed, even for the correct agent id', async () => {
    const dir = await project();
    const { action, ticket } = await launchAndBind(dir, {
      sessionId: 'overrun-parent',
      agentId: 'overrun-agent',
    });
    await closeLaunchWindow(dir);
    await expireTicketDeadline(dir, ticket.ticket_id);

    const resumed = await invokeClaudeHook({
      hook_event_name: 'SubagentStart',
      project_dir: dir,
      session_id: 'overrun-parent',
      agent_id: 'overrun-agent',
      agent_type: action.dispatch.agent_type,
    });
    expect(subagentStartOutcome(resumed)).toBe('deny');
    // The one arm where this literal is actually true: both the ticket's own
    // deadline_at and the intent's mirrored expires_at have genuinely
    // elapsed.
    expect(resumed.reason).toBe('APE Claude binding denied: ticket deadline elapsed');
  });

  // CLOSED FINDING, kept as the rationale for this arm. The resume branch
  // ONCE collapsed THREE distinct "not active and pending" causes (run status
  // not 'running'; ticket superseded by a retry, i.e. listed in
  // state.expired_tickets; ticket already receipted) together with the two
  // genuine deadline checks into the single reason 'APE Claude binding
  // denied: ticket deadline elapsed'. On this arm that was untrue: the
  // ticket's own deadline_at and the intent's mirrored expires_at are BOTH
  // still in the future — the ticket is merely superseded by its retry — so
  // an operator copying the literal into evidence.summary per
  // prompts/common.md would have hunted a deadline that never elapsed. The
  // remediation split it, and lib/runtime/claude-dispatch.js:366-371 now
  // checks the two causes in order: the !pendingTicket guard returns 'ticket
  // is not active and pending' at 366-368, and only then does the
  // expired(ticket?.deadline_at) || expired(record.expires_at) guard return
  // 'ticket deadline elapsed' at 369-371. That matches every sibling seam —
  // launchClaudeIntent's 'ticket is not active and pending' (line 233) versus
  // its own 'ticket deadline elapsed' (line 238); this same function's
  // non-resume branch (line 416); evaluateStartBinding (hooks.js:2393 versus
  // 2397). This arm PINS the cause-specific literal so the collapse cannot
  // return.
  it('reports a ticket superseded by its own retry distinctly from a genuine deadline overrun on resume', async () => {
    const dir = await project();
    const { action, ticket } = await launchAndBind(dir, {
      sessionId: 'superseded-parent',
      agentId: 'superseded-agent',
    });
    await closeLaunchWindow(dir);
    await supersedeTicketByRetry(dir, ticket.ticket_id);

    const resumed = await invokeClaudeHook({
      hook_event_name: 'SubagentStart',
      project_dir: dir,
      session_id: 'superseded-parent',
      agent_id: 'superseded-agent',
      agent_type: action.dispatch.agent_type,
    });
    expect(subagentStartOutcome(resumed)).toBe('deny');
    expect(resumed.reason).toBe('APE Claude binding denied: ticket is not active and pending');
  });
});
