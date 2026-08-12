// Roadmap entry ape-run-response-size-cap: the ape_run wire response must stay
// under a stated size cap even when the operator's run objective is long.
//
// Today every ape_run next/record response embeds run.objective in full AND
// again inside each dispatch_agent action's ticket.objective (plus a ~1.6 KB
// record-input output_schema per action ticket). With N pending dispatches the
// response is (1+N) x objective + overhead, which measured 71,534 and 71,183
// chars live and was rejected outright by the host.
//
// The contract these arms pin, at the MCP wire projection only:
//   * When the projected response exceeds the size budget AND some action is
//     compactable, each dispatch_agent action ticket dedupes exactly like the
//     run.tickets[] summary already does (compactPendingTicket: the
//     `Run objective: <run objective>` suffix becomes a reference and a
//     canonical record-input output_schema becomes OUTPUT_SCHEMA_REFERENCE),
//     and a status action's state.objective that is STRING-IDENTICAL to a
//     non-empty run.objective becomes the same reference.
//   * Below the budget the response is byte-identical to today: the full ticket
//     still crosses on the dispatch action. The change is additive.
//   * action.dispatch is never touched, so a Claude dispatch_intent prompt and
//     its single-use APE_DISPATCH_NONCE line cross verbatim.
//   * Nothing is destroyed: the on-disk ticket file keeps the complete
//     objective and the complete output_schema, and the sanctioned agent path
//     is reading that file (prompts/common.md).
//
// DELIBERATELY NOT IMPORTED: the two new projection.js constants
// (RESPONSE_BUDGET_CHARS, RUN_OBJECTIVE_REFERENCE). They are mirrored as local
// literals below so that before the fix these arms fail BEHAVIOURALLY (a wire
// response over the cap, a ticket that still carries the full objective) rather
// than dying at ESM link time on a missing export, which would prove nothing
// about the wire. compactPendingTicket / OUTPUT_SCHEMA_REFERENCE already exist
// and are imported.
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { OUTPUT_SCHEMA_REFERENCE, projectRunResponse } from '../lib/runtime/projection.js';
import { RECEIPT_INPUT_SCHEMA } from '../lib/runtime/receipt-input.js';
import { classifyApeRunOutcome } from '../lib/runtime/larp.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { atomicWriteJson, readJson } from '../lib/runtime/storage.js';
import { bindCodexDispatch } from './codex-native-test-helper.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Local mirrors of the constants the fix adds to lib/runtime/projection.js.
// Keep them in sync by name: RESPONSE_BUDGET_CHARS and RUN_OBJECTIVE_REFERENCE.
const BUDGET_CHARS = 48_000;
const RUN_OBJECTIVE_MARKER = 'see run.objective';
// The two live host rejections this roadmap entry exists to stop. The smaller
// of the pair is the empirical rejection FLOOR the budget is stated against.
const EMPIRICAL_REJECTION_FLOOR = 71_183;

const ISSUED_AT = '2026-07-06T00:00:00.000Z';
// 10,000 payload chars: the same objective magnitude the (unclaimed)
// __tests__/runtime-v2-bounded-responses.test.js fixtures use, so the
// margin-fence arm below dominates that suite rather than guessing at it.
const SUITE_OBJECTIVE = `Bound the wire, keep the disk complete. ${'x'.repeat(10_000)}`;
// Comfortably over the budget by construction: run.objective alone plus ONE
// un-deduped copy inside a dispatch ticket is 2 x 30,000 = 60,000 > 48,000, so
// every "over budget" fixture below really is over budget no matter how the
// rest of the response is shaped.
const OVER_BUDGET_OBJECTIVE = `Cap the ape_run wire response. ${'o'.repeat(30_000)}`;
const SMALL_OBJECTIVE = 'Cap the ape_run wire response for a short objective.';

function suffix(objective) {
  return `Run objective: ${objective}`;
}

function makeTicket(stageId, role, id, objective, overrides = {}) {
  return {
    schema_version: '2.0.0',
    ticket_id: id,
    run_id: 'run-unit',
    stage_id: stageId,
    parallel_group: stageId,
    role,
    objective: `Complete stage ${stageId}. ${suffix(objective)}`,
    claimed_paths: ['src/value.js'],
    test_paths: ['tests/value.test.js'],
    model_tier: 'standard',
    model: 'model-standard',
    deadline_at: '2026-07-06T01:00:00.000Z',
    // Deep clone: on-disk tickets round-trip through JSON, so schema elision
    // must hold canonically and not by reference to the shared frozen object.
    output_schema: JSON.parse(JSON.stringify(RECEIPT_INPUT_SCHEMA)),
    required_checks: ['red-test'],
    parent_hash: null,
    base_tree_sha: 'tree-base',
    attempt: 1,
    writable: true,
    issued_at: ISSUED_AT,
    ticket_hash: `hash-${id}`,
    ...overrides,
  };
}

function makeReceipt(receiptId, ticketId, overrides = {}) {
  return {
    schema_version: '2.0.0',
    receipt_id: receiptId,
    run_id: 'run-unit',
    ticket_id: ticketId,
    ticket_hash: `hash-${ticketId}`,
    agent: { host: 'codex', role: 'planner', identity: `agent-${ticketId}` },
    status: 'passed',
    base_tree_sha: 'tree-base',
    head_tree_sha: `tree-${receiptId}`,
    changed_files: [],
    tests: [],
    findings: [],
    evidence: { verdict: 'pass' },
    timing: { started_at: ISSUED_AT, completed_at: ISSUED_AT, duration_ms: 10 },
    previous_receipt_hash: null,
    receipt_hash: `rhash-${receiptId}`,
    ...overrides,
  };
}

// One receipted, one runtime-expired, one pending ticket — the run-state shape
// the wire projection already summarizes today.
function runState(objective, overrides = {}) {
  return {
    schema_version: '2.0.0',
    run_id: 'run-unit',
    status: 'running',
    stage: 'build',
    ...(objective === undefined ? {} : { objective }),
    mode: 'phase',
    lane: 'full',
    host: 'codex',
    claimed_paths: ['src/value.js'],
    test_paths: ['tests/value.test.js'],
    branch: 'ape/phase-unit',
    base_commit_sha: 'commit-base',
    tree_sha: 'tree-live',
    tickets: [
      makeTicket('test', 'test_writer', 'tik-receipted', objective),
      makeTicket('build', 'implementer', 'tik-expired', objective),
      makeTicket('build', 'implementer', 'tik-pending', objective, { attempt: 2 }),
    ],
    receipts: [makeReceipt('rec-1', 'tik-receipted')],
    expired_tickets: ['tik-expired'],
    attempts: { build: 2 },
    remediation_cycles: 0,
    created_at: ISSUED_AT,
    updated_at: ISSUED_AT,
    ...overrides,
  };
}

// A Claude-host dispatch action: the complete ticket rides `ticket`, and the
// dispatch metadata carries the launch prompt whose second line is the
// single-use nonce (claude-dispatch.js prepareClaudeIntent).
const NONCE = 'qW_heRCL0xeOYnttE9EQvPjQuE9C_83WZYIOQijTC_U';
function dispatchAction(ticket, nonce = NONCE) {
  return {
    type: 'dispatch_agent',
    dispatch: {
      host: 'claude',
      native_tool: 'Agent',
      agent_type: `ape:${ticket.role.replaceAll('_', '-')}`,
      prompt_path: `prompts/${ticket.role}.md`,
      prompt_paths: ['prompts/common.md', `prompts/${ticket.role}.md`],
      model: ticket.model,
      dispatch_intent: {
        nonce,
        expires_at: ticket.deadline_at,
        prompt: `Execute the immutable APE StageTicket ${ticket.ticket_id}.\nAPE_DISPATCH_NONCE=${nonce}`,
      },
      ticket,
    },
    ticket,
  };
}

function countOccurrences(haystack, needle) {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

const wireSize = (response) => JSON.stringify(response).length;

// Compare a possibly-30,000-char field against a SHORT expected string without
// dumping the whole objective into the assertion diff. Exactly equivalent to
// full equality whenever the expectation is at most HEAD chars: a string longer
// than HEAD can never equal a HEAD-char prefix of itself, and a shorter one is
// sliced to itself.
const HEAD = 120;
const head = (value) => (typeof value === 'string' ? value.slice(0, HEAD) : value);

describe('APE v2 ape_run response size cap: unit projection behavior', () => {
  it('A2 below the budget: the complete ticket still crosses, byte-identical to today', () => {
    // The additive claim from the other side. A short objective keeps the whole
    // response far under the cap, so nothing new may happen: the dispatch action
    // ticket deep-equals its input, the status action state keeps its objective,
    // and only today's run.tickets[] dedupe applies.
    const state = runState(SMALL_OBJECTIVE);
    const pending = state.tickets[2];
    const response = {
      ok: true,
      run: state,
      actions: [dispatchAction(pending), { type: 'status', state }],
    };
    const projected = projectRunResponse(response);
    expect(wireSize(projected)).toBeLessThan(BUDGET_CHARS);

    // The canonical complete ticket is untouched: full objective, full schema.
    expect(projected.actions[0].ticket).toEqual(pending);
    expect(projected.actions[0].ticket.output_schema).toEqual(RECEIPT_INPUT_SCHEMA);
    expect(projected.actions[0].ticket.objective.endsWith(suffix(SMALL_OBJECTIVE))).toBe(true);
    // The status action's embedded state keeps the full objective.
    expect(projected.actions[1].state.objective).toBe(SMALL_OBJECTIVE);
    // Today's shape exactly: run level + the dispatch action ticket + the
    // status action's own run-state copy, and no more.
    expect(countOccurrences(JSON.stringify(projected), SMALL_OBJECTIVE)).toBe(3);
    // ...and today's run.tickets[] dedupe still applies below the budget.
    expect(projected.run.tickets[2].objective).toBe(
      `Complete stage build. ${suffix(RUN_OBJECTIVE_MARKER)}`,
    );
    expect(projected.run.tickets[2].output_schema).toEqual(OUTPUT_SCHEMA_REFERENCE);
  });

  it('A3 margin fence: a dominating superset of every bounded-responses shape stays under the budget', () => {
    // The fence that proves this change cannot turn the UNCLAIMED
    // __tests__/runtime-v2-bounded-responses.test.js red. Rather than copying
    // one of that suite's fixtures (which would drift the moment the unclaimed
    // suite moves), build a strict SUPERSET: one response carrying the run
    // state, a dispatch_agent action with the full ticket AND a status action
    // with the full state, at that suite's 10,000-char objective magnitude. Any
    // single response that suite can produce is a subset of this one, so if this
    // stays under the cap, so does every fixture there.
    // Measured 2026-07-27: this superset projects to ~36.7 KB; the two largest
    // projections that suite actually produces are ~24.8 KB and ~23.8 KB.
    const state = runState(SUITE_OBJECTIVE);
    const pending = state.tickets[2];
    const projected = projectRunResponse({
      ok: true,
      run: state,
      actions: [dispatchAction(pending), { type: 'status', state }],
    });
    expect(wireSize(projected)).toBeLessThan(BUDGET_CHARS);
    // Under the cap nothing is compacted beyond today's run.tickets[] dedupe.
    expect(projected.actions[0].ticket).toEqual(pending);
    expect(projected.actions[1].state.objective).toBe(SUITE_OBJECTIVE);
    expect(countOccurrences(JSON.stringify(projected), SUITE_OBJECTIVE)).toBe(3);
  });

  it('A8 threshold statement: the budget sits below the empirical rejection floor and above the fence', () => {
    // The cap is not a guess. Upper bound: the smaller of the two measured host
    // rejections (71,183 and 71,534 chars). 48,000 is >=30% below it.
    expect(BUDGET_CHARS).toBeLessThanOrEqual(Math.floor(EMPIRICAL_REJECTION_FLOOR * 0.7));
    // Lower bound: it must clear the A3 dominating superset with real headroom,
    // or the change would not be additive. NOTE, and this is a deliberate
    // refinement of the plan's "at least 2x the A3 fixture": 2x is arithmetically
    // unsatisfiable for ANY implementation. The A3 fixture is fixed by its own
    // specification at ~36.7 KB (48,000 / 36,720 = 1.31x), and even the largest
    // single projection the bounded-responses suite produces is ~24.8 KB
    // (1.93x, which the plan itself records as "~1.97x"). Asserting 2x would be
    // an authoring fault — a red no correct implementation could clear — so the
    // fence is stated as the honest measured headroom instead: at least 20%.
    const state = runState(SUITE_OBJECTIVE);
    const fence = wireSize(
      projectRunResponse({
        ok: true,
        run: state,
        actions: [dispatchAction(state.tickets[2]), { type: 'status', state }],
      }),
    );
    expect(Math.round(fence * 1.2)).toBeLessThanOrEqual(BUDGET_CHARS);
  });

  it('A4 over the budget: a status action state.objective identical to run.objective becomes the reference', () => {
    // Guaranteed over budget: run.objective alone is 2 x 30,000 across the run
    // level and the twin status state.
    expect(OVER_BUDGET_OBJECTIVE.length * 2).toBeGreaterThan(BUDGET_CHARS);
    const state = runState(OVER_BUDGET_OBJECTIVE);
    // The twin differs from run.objective by exactly one character, so the
    // string-identity guard must leave it whole — it is NOT recoverable from
    // run.objective and referencing it would destroy unique information.
    const drifted = `${OVER_BUDGET_OBJECTIVE.slice(0, -1)}X`;
    const twin = runState(drifted);
    const projected = projectRunResponse({
      ok: true,
      run: state,
      actions: [
        { type: 'status', state },
        { type: 'status', state: twin },
      ],
    });
    expect(head(projected.actions[0].state.objective)).toBe(RUN_OBJECTIVE_MARKER);
    // Length first so a wrongly-referenced twin fails as two numbers.
    expect(projected.actions[1].state.objective.length).toBe(drifted.length);
    expect(projected.actions[1].state.objective).toBe(drifted);
    // run.objective itself is the single complete wire copy and is never touched.
    expect(projected.run.objective.length).toBe(OVER_BUDGET_OBJECTIVE.length);
    expect(projected.run.objective).toBe(OVER_BUDGET_OBJECTIVE);
  });

  it('A4 over the budget: a state with no objective and a run with no objective mints nothing', () => {
    // Bulk lives in the ticket objectives, which fail open (no run objective to
    // match a suffix against), so this is over budget with no run.objective at
    // all: 3 tickets x 20,000 chars.
    const orphan = 'z'.repeat(20_000);
    const state = runState(undefined);
    state.tickets = state.tickets.map((ticket) => ({ ...ticket, objective: orphan }));
    expect(orphan.length * 3).toBeGreaterThan(BUDGET_CHARS);
    const projected = projectRunResponse({
      ok: true,
      run: state,
      actions: [{ type: 'status', state }],
    });
    expect(Object.hasOwn(projected.run, 'objective')).toBe(false);
    expect(Object.hasOwn(projected.actions[0].state, 'objective')).toBe(false);
    expect(projected.run.tickets[2].objective).toBe(orphan);

    // Empty string is not a non-empty run objective: an empty state.objective
    // stays empty rather than being replaced by a reference to nothing.
    const empty = runState('');
    empty.tickets = empty.tickets.map((ticket) => ({ ...ticket, objective: orphan }));
    const emptyProjected = projectRunResponse({
      ok: true,
      run: empty,
      actions: [{ type: 'status', state: empty }],
    });
    expect(emptyProjected.run.objective).toBe('');
    expect(emptyProjected.actions[0].state.objective).toBe('');
  });

  it('A5 nonce integrity: action.dispatch crosses the cap untouched, nonce line verbatim', () => {
    // The single-use launch capability exists ONLY in the response that
    // overflowed, so the compaction must never reach into action.dispatch. Its
    // projected form is exactly today's: everything passes through and only the
    // duplicated dispatch.ticket collapses to its ticket_id.
    const state = runState(OVER_BUDGET_OBJECTIVE);
    const pending = state.tickets[2];
    const action = dispatchAction(pending);
    const projected = projectRunResponse({ ok: true, run: state, actions: [action] });
    expect(projected.actions[0].dispatch).toEqual({
      ...action.dispatch,
      ticket: { ticket_id: pending.ticket_id },
    });
    const prompt = projected.actions[0].dispatch.dispatch_intent.prompt;
    expect(prompt).toBe(
      `Execute the immutable APE StageTicket ${pending.ticket_id}.\nAPE_DISPATCH_NONCE=${NONCE}`,
    );
    expect(prompt.split('\n')).toContain(`APE_DISPATCH_NONCE=${NONCE}`);
    expect(projected.actions[0].dispatch.dispatch_intent.nonce).toBe(NONCE);
  });

  it('A6 fail-open over the budget: drifted suffix, custom schema, and an absent run objective all cross whole', () => {
    const state = runState(OVER_BUDGET_OBJECTIVE);

    // (1) An objective that does not end with the exact `Run objective: <run
    // objective>` template is not recoverable from run.objective: it crosses
    // whole even though the response is over the cap.
    const driftedTicket = makeTicket('build', 'implementer', 'tik-drift', OVER_BUDGET_OBJECTIVE, {
      objective: `Complete stage build. ${suffix(OVER_BUDGET_OBJECTIVE)} (addendum)`,
    });
    const drifted = projectRunResponse({
      ok: true,
      run: state,
      actions: [dispatchAction(driftedTicket)],
    });
    expect(drifted.actions[0].ticket.objective).toBe(driftedTicket.objective);

    // (2) A stage-specific output_schema is unique information; only the shared
    // record-input contract is ever referenced.
    const customTicket = makeTicket('build', 'implementer', 'tik-custom', OVER_BUDGET_OBJECTIVE, {
      output_schema: { type: 'object', required: ['verdict'], properties: { verdict: { type: 'string' } } },
    });
    const custom = projectRunResponse({
      ok: true,
      run: state,
      actions: [dispatchAction(customTicket)],
    });
    expect(custom.actions[0].ticket.output_schema).toEqual(customTicket.output_schema);
    expect(custom.actions[0].ticket.output_schema).not.toEqual(OUTPUT_SCHEMA_REFERENCE);

    // (3) No run.objective to reference: the ticket objective crosses whole.
    const noObjective = runState(undefined);
    const orphanTicket = makeTicket('build', 'implementer', 'tik-orphan', 'unused', {
      objective: `Complete stage build. ${suffix(OVER_BUDGET_OBJECTIVE)}`,
    });
    noObjective.tickets = [orphanTicket];
    const orphan = projectRunResponse({
      ok: true,
      run: noObjective,
      actions: [dispatchAction(orphanTicket)],
    });
    expect(orphan.actions[0].ticket.objective).toBe(orphanTicket.objective);
    // Fail-open is per FIELD, not all-or-nothing: with no run objective to
    // reference the objective crosses whole, and the shared record-input
    // contract still dedupes because it is recoverable from the ticket file.
    // (Key check first so a mismatch prints a one-line diff, not the schema.)
    expect(Object.keys(orphan.actions[0].ticket.output_schema))
      .toEqual(Object.keys(OUTPUT_SCHEMA_REFERENCE));
    expect(orphan.actions[0].ticket.output_schema).toEqual(OUTPUT_SCHEMA_REFERENCE);
    // Empty-string run objective: same fail-open on the objective suffix.
    const emptyState = runState('');
    emptyState.tickets = [orphanTicket];
    const emptyProjected = projectRunResponse({
      ok: true,
      run: emptyState,
      actions: [dispatchAction(orphanTicket)],
    });
    expect(emptyProjected.actions[0].ticket.objective).toBe(orphanTicket.objective);
  });

  it('A7 consumer + idempotency: the action ticket role survives the cap and the projection is a fixed point', () => {
    // larp.js classifyApeRunOutcome reads actions[].ticket.role off the WIRE
    // response to fire the PLAN cue (a passed planning receipt handed off to a
    // writing role). A compaction that dropped or reshaped the action ticket
    // would silence it, so pin the real consumer over the budget.
    const state = runState(OVER_BUDGET_OBJECTIVE);
    const pending = state.tickets[2];
    const testWriterTicket = makeTicket(
      'test', 'test_writer', 'tik-test-writer', OVER_BUDGET_OBJECTIVE,
    );
    const response = {
      ok: true,
      receipt: makeReceipt('rec-plan', 'tik-receipted', {
        agent: { host: 'codex', role: 'plan_judge', identity: 'agent-plan-judge' },
      }),
      run: state,
      actions: [dispatchAction(testWriterTicket), dispatchAction(pending)],
    };
    const projected = projectRunResponse(response);
    expect(projected.actions[0].ticket.role).toBe('test_writer');
    expect(projected.actions[1].ticket.role).toBe('implementer');
    expect(
      classifyApeRunOutcome(
        { action: 'record' },
        { content: [{ type: 'text', text: JSON.stringify(projected) }] },
      ),
    ).toBe('PLAN');

    // Idempotency: the orchestrator may project a response it already holds
    // (bin/ape-larp.mjs re-projects the same payload), so a second pass must
    // change nothing.
    expect(projectRunResponse(projected)).toEqual(projected);
  });

  it('A9 no mutation: the live in-memory run state and its aliased tickets are never rewritten', () => {
    // service.js pushes the SAME ticket object into state.tickets and into the
    // dispatch_agent action (:326 and :400), and a zero-pending NEXT embeds the
    // SAME run object as the status action's state. An in-place assignment
    // inside the projection would therefore corrupt the runtime's live state and
    // the very next persist would write the corrupted copy to disk.
    const state = runState(OVER_BUDGET_OBJECTIVE);
    const pending = state.tickets[2];
    const response = {
      ok: true,
      run: state,
      actions: [dispatchAction(pending), { type: 'status', state }],
    };
    // The aliasing is the point: assert it holds before measuring.
    expect(response.actions[0].ticket).toBe(response.run.tickets[2]);
    expect(response.actions[1].state).toBe(response.run);
    const snapshot = structuredClone(response);
    projectRunResponse(response);
    // Named fields first: the likely in-place casualties fail as short values
    // instead of dumping the whole 90 KB fixture into the diff.
    expect(response.run.tickets[2].objective.length)
      .toBe(`Complete stage build. ${suffix(OVER_BUDGET_OBJECTIVE)}`.length);
    expect(Object.keys(response.run.tickets[2].output_schema))
      .toEqual(Object.keys(RECEIPT_INPUT_SCHEMA));
    expect(response.actions[1].state.objective.length).toBe(OVER_BUDGET_OBJECTIVE.length);
    // ...then the whole-input catch-all: NOTHING anywhere in the live state moved.
    expect(response).toEqual(snapshot);
  });

  it('A10 cliff pin: a ~63 KB objective still exceeds the budget after compaction', () => {
    // The recorded residual, made discoverable as a test instead of prose: ONE
    // full run.objective copy always remains on the wire (it is the operator's
    // own text and the sole complete copy), and input-guard.js admits 64 KB of
    // input. So an objective near that ceiling is past the cap no matter how
    // well the duplicates are deduped.
    const huge = 'H'.repeat(63_000);
    const state = runState(huge);
    const projected = projectRunResponse({
      ok: true,
      run: state,
      actions: [dispatchAction(state.tickets[2])],
    });
    expect(projected.run.objective.length).toBeGreaterThan(BUDGET_CHARS);
    expect(wireSize(projected)).toBeGreaterThan(BUDGET_CHARS);
  });
});

const cleanups = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function project() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-response-cap-'));
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
  const paths = runtimePaths(dir);
  await atomicWriteJson(paths.config, {
    shipping: { auto_merge: false, provider: 'github', required_remote_checks: false },
    test_commands: { full: 'node --test' },
  });
  return dir;
}

function session(messages) {
  return new Promise((resolve, reject) => {
    // Strip the ambient host project pins so root resolution is driven by the
    // call arguments alone, not the live session env of whoever runs the suite.
    const env = { ...process.env };
    delete env.CLAUDE_PROJECT_DIR;
    delete env.CODEX_CWD;
    const child = spawn(process.execPath, [path.join(root, 'bin', 'ape-mcp.mjs')], {
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
      else resolve(stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line)));
    });
    child.stdin.end(messages.map((message) => JSON.stringify(message)).join('\n') + '\n');
  });
}

// Returns the RAW wire text alongside the parsed value: the cap is a property of
// the bytes the host receives (bin/ape-mcp.mjs writes JSON.stringify(value) into
// the tool result), so the arms measure that text, not a re-serialization.
async function apeRun(args) {
  const responses = await session([
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ape_run', arguments: args } },
  ]);
  const payload = responses[0].result;
  if (payload.isError) throw new Error(payload.content[0].text);
  const text = payload.content[0].text;
  return { text, value: JSON.parse(text) };
}

// A 24,000-char operator objective: long, but well inside the 64 KB
// input-guard ceiling. This is the shape that overflowed live.
const LONG_OBJECTIVE = `Close the ape_run response size cap. ${'y'.repeat(24_000)}`;

async function startLongRun(dir) {
  const started = await apeRun({
    action: 'start',
    project_dir: dir,
    objective: LONG_OBJECTIVE,
    mode: 'phase',
    lane: 'full',
    host: 'codex',
    claimed_paths: ['src/value.js'],
    test_paths: ['tests/value.test.js'],
    requirements: ['R1'],
    behavioral: true,
    hooks_trusted: true,
    subagents_available: true,
    explicit_invocation: true,
  });
  expect(started.value.ok).toBe(true);
  expect(started.value.run.lane).toBe('full');
  const dispatch = started.value.actions.find((action) => action.type === 'dispatch_agent');
  started.receiptCapability = await bindCodexDispatch(root, dir, dispatch);
  return started;
}

function planReceipt(ticket, receiptCapability) {
  return {
    ticket_id: ticket.ticket_id,
    receipt_capability: receiptCapability,
    status: 'passed',
    agent_identity: 'agent-planner',
    tests: [],
    findings: [],
    evidence: {
      verdict: 'pass',
      candidate_plan: {
        version: 1,
        requirements: [{ id: 'R1', requirement: 'Bound the MCP response', workstreams: ['wire'] }],
        workstreams: [{
          id: 'wire',
          outcome: 'The response remains under its byte budget',
          paths: [
            { path: 'src/value.js', action: 'modify' },
            { path: 'tests/value.test.js', action: 'modify' },
          ],
          steps: ['Apply the bounded wire projection'],
          acceptance: ['The response remains within the configured cap'],
          evidence_commands: ['node --test'],
        }],
        risks: [],
        non_goals: [],
      },
    },
    timing: {
      started_at: ticket.issued_at,
      completed_at: new Date(Date.parse(ticket.issued_at) + 10).toISOString(),
      duration_ms: 10,
    },
  };
}

describe('APE v2 ape_run response size cap over the live MCP wire', () => {
  it('A1 acceptance: no ape_run response exceeds the cap, including the two-member plan-review dispatch', async () => {
    const dir = await project();
    // START issues the read-only planner ticket for a full-lane phase run.
    const started = await startLongRun(dir);
    const planTicket = started.value.actions.find(
      (action) => action.type === 'dispatch_agent',
    ).ticket;
    expect(planTicket.role).toBe('planner');

    // RECORDing the planner receipt completes the plan stage and issues the
    // PLAN-REVIEW PAIR (plan-check || plan-critic) in one response: the worst
    // case on this pipeline, (1 + 2) full objective copies. Measured 85,214
    // chars before the fix against a 48,000 cap, and 55,856 at start — the
    // record response is where the cap is proven, because its ~37 KB of
    // overshoot cannot be explained away by drift in the ticket-objective
    // preamble constants.
    const recorded = await apeRun({
      action: 'record',
      project_dir: dir,
      receipt: planReceipt(planTicket, started.receiptCapability),
    });
    expect(recorded.value.ok).toBe(true);
    const dispatches = recorded.value.actions.filter((action) => action.type === 'dispatch_agent');
    expect(dispatches.map((action) => action.ticket.stage_id).sort())
      .toEqual(['plan-check', 'plan-critic']);
    expect(recorded.text.length).toBeLessThanOrEqual(BUDGET_CHARS);

    // The start response crosses the same cap.
    expect(started.text.length).toBeLessThanOrEqual(BUDGET_CHARS);

    // A plain status read is bounded too.
    const status = await apeRun({ action: 'status', project_dir: dir });
    expect(status.value.active).toBe(true);
    expect(status.text.length).toBeLessThanOrEqual(BUDGET_CHARS);
  }, 30_000);

  it('A1b disk authoritative: the wire ticket references the objective while the ticket file stays complete', async () => {
    const dir = await project();
    const started = await startLongRun(dir);
    const planTicket = started.value.actions.find(
      (action) => action.type === 'dispatch_agent',
    ).ticket;
    const recorded = await apeRun({
      action: 'record',
      project_dir: dir,
      receipt: planReceipt(planTicket, started.receiptCapability),
    });
    expect(recorded.value.ok).toBe(true);
    const dispatched = recorded.value.actions.find((action) => action.type === 'dispatch_agent');

    // Over the cap the wire ticket references the run objective and the shared
    // record-input contract...
    expect(dispatched.ticket.objective).toBe(RUN_OBJECTIVE_MARKER);
    expect(dispatched.ticket.objective).not.toBe(LONG_OBJECTIVE);
    expect(dispatched.ticket.output_schema).toEqual(OUTPUT_SCHEMA_REFERENCE);
    // ...while the objective itself still crosses once, at run level, so it is
    // recoverable from this very response.
    expect(recorded.value.run.objective).toBe(LONG_OBJECTIVE);
    // ...and nothing a dispatch consumes is lost.
    for (const field of [
      'ticket_id', 'run_id', 'stage_id', 'role', 'model', 'model_tier', 'deadline_at',
      'claimed_paths', 'test_paths', 'required_checks', 'ticket_hash', 'base_tree_sha',
      'parent_hash', 'attempt', 'writable', 'issued_at',
    ]) {
      expect(dispatched.ticket).toHaveProperty(field);
    }

    // The on-disk ticket is the authoritative copy the agent reads
    // (prompts/common.md): complete objective, complete output_schema.
    const paths = runtimePaths(dir);
    const ticketFile = path.join(
      paths.tickets,
      `${dispatched.ticket.ticket_id.replaceAll(':', '_')}.json`,
    );
    const persisted = await readJson(ticketFile);
    expect(persisted.ticket_id).toBe(dispatched.ticket.ticket_id);
    expect(persisted.objective).toBe(LONG_OBJECTIVE);
    expect(persisted.objective).not.toBe(RUN_OBJECTIVE_MARKER);
    expect(persisted.output_schema.properties.receipt_capability).toBeTruthy();

    // Persisted run state is complete too — the bound is the wire only.
    const activeState = await readJson(paths.active);
    const persistedTicket = activeState.tickets.find(
      (entry) => entry.ticket_id === dispatched.ticket.ticket_id,
    );
    expect(persistedTicket.objective).toBe(LONG_OBJECTIVE);
    expect(persistedTicket.output_schema.properties.receipt_capability).toBeTruthy();
  }, 30_000);
});
