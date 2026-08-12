import { execFileSync, spawn } from 'node:child_process';
import { readFile, mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { runtimePaths } from '../lib/runtime/paths.js';
import { startRun } from '../lib/runtime/service.js';
import { atomicWriteJson } from '../lib/runtime/storage.js';

// dispatch-deny-reason-is-non-discriminating (roadmap entry).
//
// THE DEFECT, verified against the tree at commit a6b51d6a. The ordinary
// tool-call policy site (lib/runtime/hooks.js:2100-2107) denies every
// Claude-managed subagent tool call with `!context.ticket` using ONE fixed
// sentence: 'APE tool denied: Claude subagent has no exact active binding'.
// bin/ape-hook.mjs:206-221 is the only thing that populates `context.ticket`
// for a live Claude tool call, from resolveClaudeBinding
// (lib/runtime/claude-dispatch.js:438-453), which returns a bare `null` on
// at least these four operator-distinguishable grounds:
//   (a) the payload carried no usable agent id;
//   (b) a bound record exists for this run, session and agent type but under
//       a DIFFERENT agent id;
//   (c) the ticket is no longer pending (superseded by its own retry);
//   (d) the ticket/launch deadline elapsed.
// Every one of these collapses onto the identical sentence today, so an
// operator (or a later run reading evidence.summary per
// prompts/common.md:36-38) cannot tell which fired.
//
// This suite drives all four grounds through the REAL hook binary
// (bin/ape-hook.mjs) — the hook/policy seam that actually produces the
// string, not the resolver in isolation — and requires the four surfaced
// reasons to be pairwise DISTINCT and each to name only its own cause,
// without leaking the identity of another bound agent. It also pins that
// admission itself is untouched: a genuinely bound identity's write stays
// allowed, and an unrelated identity's write stays denied.
//
// Fixture techniques for (c) and (d) mirror the already-established,
// independently reachable techniques in
// __tests__/runtime-v2-dispatch-binding-expiry.test.js
// (supersedeTicketByRetry / expireTicketDeadline), applied here to the
// ordinary tool-call resolveClaudeBinding path rather than the SubagentStart
// resume path that file covers.

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const hookBinary = path.join(root, 'bin', 'ape-hook.mjs');
const cleanups = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function project(label) {
  const dir = await mkdtemp(path.join(tmpdir(), `ape-deny-cause-${label}-`));
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

function decision(response) {
  return response?.hookSpecificOutput?.permissionDecision;
}

function denyReason(response) {
  return response?.hookSpecificOutput?.permissionDecisionReason;
}

// Drives one ticket through launch + SubagentStart bind, exactly the
// established 'binds SubagentStart before first prompt' contract, and
// returns the ticket/action so a later step can drive further tool calls
// under (or away from) the identity that is now genuinely bound.
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
  expect(decision(launch)).toBe('allow');

  const started = await invokeClaudeHook({
    hook_event_name: 'SubagentStart',
    project_dir: dir,
    session_id: sessionId,
    agent_id: agentId,
    agent_type: action.dispatch.agent_type,
  });
  expect(started?.hookSpecificOutput?.additionalContext).toEqual(
    expect.stringContaining('APE_RECEIPT_CAPABILITY='),
  );

  return { action, ticket };
}

function writeToolCall(dir, { sessionId, agentType, fileName, agentId, subagentId }) {
  const payload = {
    hook_event_name: 'PreToolUse',
    project_dir: dir,
    session_id: sessionId,
    agent_type: agentType,
    tool_name: 'Write',
    tool_input: { file_path: path.join(dir, 'tests', fileName), content: 'test' },
  };
  if (agentId !== undefined) payload.agent_id = agentId;
  if (subagentId !== undefined) payload.subagent_id = subagentId;
  return payload;
}

// Ground (c): the OTHER pendingTicket-false path (lib/runtime/claude-
// dispatch.js `pendingTicket`) — the ticket was superseded by its own retry,
// listed in state.expired_tickets — NOT a genuine deadline overrun. Both the
// ticket's deadline_at and the intent's mirrored expires_at are deliberately
// left in the future, so this ground is reached ONLY through the
// !pendingTicket branch, never through the expiry filter.
async function supersedeTicketByRetry(dir, ticketId) {
  const paths = runtimePaths(dir);
  const state = JSON.parse(await readFile(paths.active, 'utf8'));
  state.expired_tickets = [...(state.expired_tickets ?? []), ticketId];
  await atomicWriteJson(paths.active, state);
}

// Ground (d): the genuine TICKET-deadline arm. Both the live ticket in
// active.json and the intent's own mirrored expires_at move into the past —
// the same technique __tests__/runtime-v2-dispatch-binding-expiry.test.js
// and __tests__/runtime-v2-claude-dispatch.test.js already use for this
// exact ground.
async function expireTicketDeadline(dir, ticketId) {
  const deadline = new Date(Date.now() - 60_000).toISOString();
  const paths = runtimePaths(dir);
  const state = JSON.parse(await readFile(paths.active, 'utf8'));
  state.tickets = state.tickets.map((entry) => (
    entry.ticket_id === ticketId ? { ...entry, deadline_at: deadline } : entry
  ));
  await atomicWriteJson(paths.active, state);
  const { file, intent } = await readOnlyIntent(dir);
  expect(intent.status).toBe('bound');
  await atomicWriteJson(file, { ...intent, expires_at: deadline });
}

describe('APE v2 Claude subagent binding denial names its cause', () => {
  it('surfaces four pairwise-distinct, non-leaking reasons for four independently reachable resolveClaudeBinding denial grounds', async () => {
    // GROUND (a): no usable agent id. bin/ape-hook.mjs enters the binding
    // branch on `event.agent_identity`, which normalizeLifecycleEvent derives
    // from a five-way fallback INCLUDING subagent_id — so a payload naming
    // only `subagent_id` (never `agent_id`/`agentId`, the fields
    // resolveClaudeBinding actually reads) fools the branch guard into
    // running the resolver, which then fails identity matching outright.
    const trapDir = await project('trap');
    const { action: trapAction } = await startClaude(trapDir);
    const trapResponse = await invokeClaudeHook(
      writeToolCall(trapDir, {
        sessionId: 'trap-parent',
        agentType: trapAction.dispatch.agent_type,
        subagentId: 'trap-subagent',
        fileName: 'trap.test.js',
      }),
    );
    expect(decision(trapResponse)).toBe('deny');
    const reasonNoAgentId = denyReason(trapResponse);

    // GROUND (b): a bound record exists for this exact run, session and
    // agent type, but under a DIFFERENT agent id.
    const diffDir = await project('diff-agent');
    const { action: diffAction } = await launchAndBind(diffDir, {
      sessionId: 'diff-parent',
      agentId: 'diff-legit-agent',
    });
    const diffResponse = await invokeClaudeHook(
      writeToolCall(diffDir, {
        sessionId: 'diff-parent',
        agentType: diffAction.dispatch.agent_type,
        agentId: 'diff-wrong-agent',
        fileName: 'diff.test.js',
      }),
    );
    expect(decision(diffResponse)).toBe('deny');
    const reasonDifferentAgentId = denyReason(diffResponse);

    // GROUND (c): the ticket is no longer pending (superseded by its own
    // retry) — the exact bound identity resolves, but pendingTicket is false.
    const supersededDir = await project('superseded');
    const { action: supersededAction, ticket: supersededTicket } = await launchAndBind(supersededDir, {
      sessionId: 'superseded-parent',
      agentId: 'superseded-agent',
    });
    await supersedeTicketByRetry(supersededDir, supersededTicket.ticket_id);
    const supersededResponse = await invokeClaudeHook(
      writeToolCall(supersededDir, {
        sessionId: 'superseded-parent',
        agentType: supersededAction.dispatch.agent_type,
        agentId: 'superseded-agent',
        fileName: 'superseded.test.js',
      }),
    );
    expect(decision(supersededResponse)).toBe('deny');
    const reasonSuperseded = denyReason(supersededResponse);

    // GROUND (d): the ticket/launch deadline itself elapsed.
    const expiredDir = await project('expired');
    const { action: expiredAction, ticket: expiredTicket } = await launchAndBind(expiredDir, {
      sessionId: 'expired-parent',
      agentId: 'expired-agent',
    });
    await expireTicketDeadline(expiredDir, expiredTicket.ticket_id);
    const expiredResponse = await invokeClaudeHook(
      writeToolCall(expiredDir, {
        sessionId: 'expired-parent',
        agentType: expiredAction.dispatch.agent_type,
        agentId: 'expired-agent',
        fileName: 'expired.test.js',
      }),
    );
    expect(decision(expiredResponse)).toBe('deny');
    const reasonDeadlineElapsed = denyReason(expiredResponse);

    const reasons = [reasonNoAgentId, reasonDifferentAgentId, reasonSuperseded, reasonDeadlineElapsed];
    for (const reason of reasons) {
      expect(typeof reason).toBe('string');
      expect(reason.length).toBeGreaterThan(0);
    }

    // THE RED ANCHOR. On the pre-fix tree every one of these four grounds
    // surfaces the identical fixed sentence, so this collapses to a Set of
    // size 1 today; a fix that actually names the cause makes all four
    // distinct.
    expect(new Set(reasons).size).toBe(4);

    // Each reason must name ITS OWN cause and not read like a neighbour's,
    // so an operator (or a later run) copying evidence.summary verbatim per
    // prompts/common.md:36-38 can act on the field without guessing.
    expect(reasonNoAgentId).toMatch(/agent id/i);
    expect(reasonNoAgentId).not.toMatch(/different/i);
    expect(reasonNoAgentId).not.toMatch(/pending/i);
    expect(reasonNoAgentId).not.toMatch(/deadline/i);

    expect(reasonDifferentAgentId).toMatch(/different/i);
    expect(reasonDifferentAgentId).toMatch(/agent id/i);
    // NO IDENTITY LEAK (hard constraint): the caller being denied must never
    // learn the bound identity that IS active for this run/session/type.
    expect(reasonDifferentAgentId).not.toContain('diff-legit-agent');
    // F5 (plan critic): relaxing the (b) and (d) predicates together could
    // make an EXPIRED record under the SAME agent id read as "different
    // agent id" instead of "deadline elapsed" — guard the label directly.
    expect(reasonDifferentAgentId).not.toMatch(/deadline/i);

    expect(reasonSuperseded).toMatch(/pending/i);
    expect(reasonSuperseded).not.toMatch(/deadline/i);
    expect(reasonSuperseded).not.toMatch(/different/i);

    expect(reasonDeadlineElapsed).toMatch(/deadline/i);
    expect(reasonDeadlineElapsed).toMatch(/elapsed/i);
    expect(reasonDeadlineElapsed).not.toMatch(/pending/i);
    // Same F5 guard in the other direction.
    expect(reasonDeadlineElapsed).not.toMatch(/different/i);
  });

  it('leaves admission itself unchanged: a genuinely bound identity keeps writing and an unrelated identity stays denied', async () => {
    const dir = await project('admission');
    const { action } = await launchAndBind(dir, {
      sessionId: 'admission-parent',
      agentId: 'admission-agent',
    });

    // A payload admitted today (the bound identity's own claimed write) must
    // still be admitted — naming a cause is a label on a refusal, never a
    // new way in.
    const boundWrite = await invokeClaudeHook(
      writeToolCall(dir, {
        sessionId: 'admission-parent',
        agentType: action.dispatch.agent_type,
        agentId: 'admission-agent',
        fileName: 'admitted.test.js',
      }),
    );
    expect(decision(boundWrite)).toBe('allow');

    // A payload denied today (an identity with no prior binding at all) must
    // still be denied.
    const unrelated = await invokeClaudeHook(
      writeToolCall(dir, {
        sessionId: 'never-dispatched-parent',
        agentType: action.dispatch.agent_type,
        agentId: 'never-dispatched-agent',
        fileName: 'unrelated.test.js',
      }),
    );
    expect(decision(unrelated)).toBe('deny');
  });
});
