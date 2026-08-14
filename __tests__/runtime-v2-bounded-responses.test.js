import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  OUTPUT_SCHEMA_REFERENCE,
  RUN_OBJECTIVE_REFERENCE,
  compactPendingTicket,
  projectRunResponse,
  projectRunState,
} from '../lib/runtime/projection.js';
import { RECEIPT_INPUT_SCHEMA } from '../lib/runtime/receipt-input.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { atomicWriteJson, readJson } from '../lib/runtime/storage.js';
import { bindCodexDispatch, completeCodexBindingProbe } from './codex-native-test-helper.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const OBJECTIVE = `Bound the wire, keep the disk complete. ${'x'.repeat(10_000)}`;
const ISSUED_AT = '2026-07-06T00:00:00.000Z';

function makeTicket(stageId, role, id, overrides = {}) {
  return {
    schema_version: '2.0.0',
    ticket_id: id,
    run_id: 'run-unit',
    stage_id: stageId,
    parallel_group: stageId,
    role,
    objective: `Complete stage ${stageId}. Run objective: ${OBJECTIVE}`,
    claimed_paths: ['src/value.js'],
    test_paths: ['tests/value.test.js'],
    model_tier: 'standard',
    model: 'model-standard',
    deadline_at: '2026-07-06T01:00:00.000Z',
    // Deep clone so elision is proven CANONICAL, not reference-based: on-disk
    // tickets round-trip through JSON, so the shared frozen object is not the
    // one that reaches projectRunState in practice.
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

function makeReceipt(receiptId, ticketId) {
  return {
    schema_version: '2.0.0',
    receipt_id: receiptId,
    run_id: 'run-unit',
    ticket_id: ticketId,
    ticket_hash: `hash-${ticketId}`,
    agent: { host: 'codex', role: 'test_writer', identity: `agent-${ticketId}` },
    status: 'passed',
    base_tree_sha: 'tree-base',
    head_tree_sha: `tree-${receiptId}`,
    changed_files: ['tests/value.test.js'],
    tests: [],
    findings: [],
    evidence: { verdict: 'pass' },
    timing: { started_at: ISSUED_AT, completed_at: ISSUED_AT, duration_ms: 10 },
    previous_receipt_hash: null,
    receipt_hash: `rhash-${receiptId}`,
  };
}

// Three tickets: receipted, runtime-expired, pending; the second receipt has
// no matching ticket so stage_id resolution falls back to null.
function unitState() {
  return {
    schema_version: '2.0.0',
    run_id: 'run-unit',
    status: 'running',
    stage: 'build',
    objective: OBJECTIVE,
    mode: 'phase',
    lane: 'fast',
    host: 'codex',
    claimed_paths: ['src/value.js'],
    test_paths: ['tests/value.test.js'],
    branch: 'ape/phase-unit',
    base_commit_sha: 'commit-base',
    tree_sha: 'tree-live',
    tickets: [
      makeTicket('test', 'test_writer', 'tik-receipted'),
      makeTicket('build', 'implementer', 'tik-expired'),
      makeTicket('build', 'implementer', 'tik-pending', { attempt: 2 }),
    ],
    receipts: [makeReceipt('rec-1', 'tik-receipted'), makeReceipt('rec-2', 'tik-ghost')],
    expired_tickets: ['tik-expired'],
    attempts: { build: 2 },
    remediation_cycles: 0,
    created_at: ISSUED_AT,
    updated_at: ISSUED_AT,
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

describe('APE v2 bounded MCP responses: projection unit behavior', () => {
  it('dedupes only the objective suffix and output_schema on pending tickets', () => {
    const state = unitState();
    const original = state.tickets[2];
    const projected = projectRunResponse({ ok: true, run: state });
    const pending = projected.run.tickets[2];
    // Every dispatch-consumed field is still present.
    for (const field of [
      'objective', 'role', 'model', 'model_tier', 'deadline_at', 'claimed_paths',
      'test_paths', 'output_schema', 'required_checks', 'ticket_hash', 'base_tree_sha',
      'parent_hash', 'attempt', 'writable', 'issued_at', 'parallel_group', 'stage_id',
      'ticket_id',
    ]) {
      expect(pending).toHaveProperty(field);
    }
    // Only the two duplicated fields change; everything else deep-equals.
    for (const field of Object.keys(original)) {
      if (field === 'objective' || field === 'output_schema') continue;
      expect(pending[field]).toEqual(original[field]);
    }
    expect(pending.objective).toBe('Complete stage build. Run objective: see run.objective');
    expect(JSON.stringify(pending)).not.toContain(OBJECTIVE);
    expect(pending.output_schema).toEqual(OUTPUT_SCHEMA_REFERENCE);
  });

  it('compacts receipted and expired tickets to exactly the summary shape', () => {
    const projected = projectRunState(unitState());
    expect(projected.tickets[0]).toEqual({
      ticket_id: 'tik-receipted',
      stage_id: 'test',
      role: 'test_writer',
      attempt: 1,
      status: 'receipted',
      ticket_hash: 'hash-tik-receipted',
      issued_at: ISSUED_AT,
    });
    expect(projected.tickets[1]).toEqual({
      ticket_id: 'tik-expired',
      stage_id: 'build',
      role: 'implementer',
      attempt: 1,
      status: 'expired',
      ticket_hash: 'hash-tik-expired',
      issued_at: ISSUED_AT,
    });
    for (const summary of [projected.tickets[0], projected.tickets[1]]) {
      expect(Object.keys(summary).sort()).toEqual(
        ['attempt', 'issued_at', 'role', 'stage_id', 'status', 'ticket_hash', 'ticket_id'],
      );
      expect(summary).not.toHaveProperty('objective');
      expect(summary).not.toHaveProperty('claimed_paths');
    }
  });

  it('compacts receipts to the summary with stage_id resolved from the ticket', () => {
    const projected = projectRunState(unitState());
    expect(projected.receipts[0]).toEqual({
      receipt_id: 'rec-1',
      ticket_id: 'tik-receipted',
      stage_id: 'test',
      status: 'passed',
      receipt_hash: 'rhash-rec-1',
      head_tree_sha: 'tree-rec-1',
    });
    expect(projected.receipts[1].stage_id).toBeNull();
    expect(Object.keys(projected.receipts[1]).sort()).toEqual(
      ['head_tree_sha', 'receipt_id', 'receipt_hash', 'stage_id', 'status', 'ticket_id'].sort(),
    );
  });

  it('bounds the run objective to once at run level with no dispatch action', () => {
    const state = unitState();
    const unprojected = countOccurrences(JSON.stringify({ ok: true, run: state }), OBJECTIVE);
    // Run level + one embedded copy per ticket, receipted and expired included.
    expect(unprojected).toBe(1 + state.tickets.length);
    const projected = projectRunResponse({ ok: true, run: state });
    // Pending tickets now reference run.objective, so only the run level remains.
    expect(countOccurrences(JSON.stringify(projected), OBJECTIVE)).toBe(1);
  });

  it('keeps exactly one objective per dispatch action alongside the run level', () => {
    const state = unitState();
    const pending = state.tickets[2];
    const action = { type: 'dispatch_agent', ticket: pending };
    const projected = projectRunResponse({ ok: true, run: state, actions: [action] });
    // Run level + one full copy on the canonical dispatch_agent action ticket.
    expect(countOccurrences(JSON.stringify(projected), OBJECTIVE)).toBe(1 + 1);
  });

  it('keeps the canonical full ticket on dispatch_agent and dedupes dispatch.ticket', () => {
    const state = unitState();
    const pending = state.tickets[2];
    const action = {
      type: 'dispatch_agent',
      dispatch: {
        host: 'codex',
        native_tool: 'spawn_agent',
        agent_name: 'implementer',
        agent_type: 'worker',
        semantic_role: 'implementer',
        prompt_path: 'prompts/implementer.md',
        prompt_paths: ['prompts/common.md', 'prompts/implementer.md'],
        model: 'model-standard',
        dispatch_intent: { prompt: 'APE_DISPATCH_NONCE: nonce-1' },
        ticket_id: pending.ticket_id,
        ticket: pending,
      },
      ticket: pending,
    };
    const projected = projectRunResponse({ ok: true, run: state, actions: [action] });
    const dispatched = projected.actions[0];
    expect(dispatched.ticket).toEqual(pending);
    // The dispatch action ticket keeps the full contract and full objective;
    // the run.tickets[] entry carries the deduped marker forms.
    expect(dispatched.ticket.output_schema).toEqual(RECEIPT_INPUT_SCHEMA);
    expect(dispatched.ticket.objective).toContain(OBJECTIVE);
    expect(projected.run.tickets[2].output_schema).toEqual(OUTPUT_SCHEMA_REFERENCE);
    expect(projected.run.tickets[2].objective).toBe(
      'Complete stage build. Run objective: see run.objective',
    );
    expect(dispatched.dispatch.native_tool).toBe('spawn_agent');
    expect(dispatched.dispatch.agent_type).toBe('worker');
    expect(dispatched.dispatch.prompt_path).toBe('prompts/implementer.md');
    expect(dispatched.dispatch.prompt_paths).toEqual([
      'prompts/common.md',
      'prompts/implementer.md',
    ]);
    expect(dispatched.dispatch.model).toBe('model-standard');
    expect(dispatched.dispatch.dispatch_intent.prompt).toBe('APE_DISPATCH_NONCE: nonce-1');
    expect(dispatched.dispatch.ticket).toEqual({ ticket_id: pending.ticket_id });
  });

  it('dedupes the record-input schema to one copy per dispatch action', () => {
    const state = unitState();
    // A distinctive substring unique to RECEIPT_INPUT_SCHEMA.
    const SCHEMA_MARK = 'One-time receipt capability token';
    const unprojected = countOccurrences(JSON.stringify({ ok: true, run: state }), SCHEMA_MARK);
    expect(unprojected).toBe(state.tickets.length);
    // No actions: every pending ticket references the schema, zero inline copies.
    const projectedNoAction = projectRunResponse({ ok: true, run: state });
    expect(countOccurrences(JSON.stringify(projectedNoAction), SCHEMA_MARK)).toBe(0);
    // One dispatch action carries exactly one full inline schema copy.
    const projectedWithAction = projectRunResponse({
      ok: true,
      run: state,
      actions: [{ type: 'dispatch_agent', ticket: state.tickets[2] }],
    });
    expect(countOccurrences(JSON.stringify(projectedWithAction), SCHEMA_MARK)).toBe(1);
  });

  it('fails open on a custom schema, a non-matching objective, and an empty run objective', () => {
    // String schema + objective lacking the exact `Run objective: ${obj}` suffix.
    const custom = makeTicket('build', 'implementer', 'tik-custom', {
      output_schema: 'stage-receipt.v2',
      objective: 'Complete stage build. Run objective: a different objective entirely',
    });
    expect(compactPendingTicket(custom, OBJECTIVE)).toEqual(custom);
    // Empty-string run objective triggers no trimming even on a matching suffix.
    const pending = makeTicket('build', 'implementer', 'tik-empty', {
      output_schema: 'stage-receipt.v2',
    });
    expect(compactPendingTicket(pending, '')).toEqual(pending);
  });

  it('summarizes history_archived records while preserving provenance fields', () => {
    const state = unitState();
    const record = {
      schema_version: '2.0.0',
      run_id: 'run-unit',
      objective: OBJECTIVE,
      mode: 'phase',
      lane: 'fast',
      status: 'blocked',
      block_reason: 'one or more deterministic merge gates failed',
      completed_at: ISSUED_AT,
      base_commit_sha: 'commit-base',
      final_tree_sha: 'tree-live',
      tickets: state.tickets,
      receipts: state.receipts,
      gates: null,
      merge: null,
      supersedes: 'block-record-hash',
      record_hash: 'record-hash-1',
    };
    const projected = projectRunResponse({
      ok: true,
      run: state,
      actions: [{ type: 'history_archived', record }],
    });
    expect(projected.actions[0].record).toEqual({
      schema_version: '2.0.0',
      run_id: 'run-unit',
      status: 'blocked',
      mode: 'phase',
      lane: 'fast',
      block_reason: 'one or more deterministic merge gates failed',
      completed_at: ISSUED_AT,
      base_commit_sha: 'commit-base',
      final_tree_sha: 'tree-live',
      merge: null,
      record_hash: 'record-hash-1',
      ticket_count: 3,
      receipt_count: 2,
      supersedes: 'block-record-hash',
    });
  });

  it('projects the status action state instead of smuggling the full run past the bound', () => {
    // Zero-pending NEXT returns action('status', { state }); the embedded
    // state must cross the wire projected like response.run — never dropped
    // (callers may read it), never full (it re-embeds every output_schema and
    // receipt evidence blob).
    const state = unitState();
    const SCHEMA_MARK = 'One-time receipt capability token';
    const projected = projectRunResponse({
      ok: true,
      run: state,
      actions: [{ type: 'status', state }],
    });
    expect(countOccurrences(JSON.stringify(projected), SCHEMA_MARK)).toBe(0);
    expect(countOccurrences(JSON.stringify(projected), OBJECTIVE)).toBe(2); // run level + status state level
    const embedded = projected.actions[0].state;
    expect(embedded.tickets[0]).toEqual(projectRunState(state).tickets[0]);
    expect(embedded.receipts[0]).toEqual(projectRunState(state).receipts[0]);
  });

  it('compacts the top-level receipt and preserves idempotent/recovered flags', () => {
    const state = unitState();
    const projected = projectRunResponse({
      ok: true,
      receipt: makeReceipt('rec-1', 'tik-receipted'),
      run: state,
      actions: [],
      idempotent: true,
      recovered: true,
    });
    expect(projected.receipt).toEqual({
      receipt_id: 'rec-1',
      ticket_id: 'tik-receipted',
      stage_id: 'test',
      status: 'passed',
      role: 'test_writer',
      receipt_hash: 'rhash-rec-1',
      head_tree_sha: 'tree-rec-1',
    });
    expect(projected.idempotent).toBe(true);
    expect(projected.recovered).toBe(true);
  });

  it('passes ok:false shapes and unknown top-level keys through unchanged', () => {
    const blocked = {
      ok: false,
      blocked: true,
      reason: 'runtime doctor failed before write',
      doctor: { healthy: false, problems: ['hooks are not trusted'] },
    };
    expect(projectRunResponse(blocked)).toEqual(blocked);
    const rejected = {
      ok: false,
      rejected: true,
      errors: ['run is blocked'],
      normalized_fields: ['status: "completed" -> "passed"'],
    };
    expect(projectRunResponse(rejected)).toEqual(rejected);
    const state = unitState();
    const withUnknownKey = projectRunResponse({
      ok: true,
      run: state,
      normalized_fields: ['status: "completed" -> "passed"'],
    });
    expect(withUnknownKey.normalized_fields).toEqual(['status: "completed" -> "passed"']);
  });

  it('round-trips a minimal state without tickets/receipts arrays', () => {
    const minimal = { run_id: 'run-project-root', status: 'running' };
    const projected = projectRunResponse({ ok: true, active: true, run: minimal });
    expect(projected.run).toEqual(minimal);
    expect(projected.run.run_id).toBe('run-project-root');
  });

  it('compacts untrusted preflight evidence to bounded hashes, counts, and ids', () => {
    const state = unitState();
    state.status = 'input_required';
    state.stage = 'preflight';
    state.preflight = {
      version: 1,
      artifact_hash: 'a'.repeat(64),
      receipt_hash: 'b'.repeat(64),
      artifact: {
        version: 1,
        objective: 'Untrusted objective prose must not cross the compact wire.',
        acceptance: ['A1', 'A2'],
        non_goals: ['N1'],
        baseline: [],
        impacted_paths: { read: [], write: ['src/value.js'] },
        compatibility: 'Untrusted compatibility prose.',
        rollback: 'Untrusted rollback prose.',
        verification_profiles: [
          { id: 'unit', disposition: 'required', reason: 'Untrusted reason.' },
          { id: 'docs', disposition: 'not-applicable', reason: 'Untrusted reason.' },
        ],
        questions: [{ id: 'api', question: 'Untrusted question?', rationale: 'Untrusted rationale.' }],
      },
    };
    state.input_required = { preflight_hash: 'a'.repeat(64), question_ids: ['api'] };

    const projected = projectRunState(state);
    expect(projected.preflight).toEqual({
      version: 1,
      artifact_hash: 'a'.repeat(64),
      receipt_hash: 'b'.repeat(64),
      acceptance_count: 2,
      non_goal_count: 1,
      required_profile_ids: ['unit'],
      question_ids: ['api'],
    });
    expect(JSON.stringify(projected)).not.toContain('Untrusted objective prose');
    expect(JSON.stringify(projected)).not.toContain('Untrusted question');
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
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-bounded-'));
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
    // Strip the ambient host project pins so root resolution is driven by
    // the call arguments alone, not the live session env of whoever runs
    // the suite.
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

async function callApe(name, args) {
  const responses = await session([
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    },
  ]);
  const payload = responses[0].result;
  if (payload.isError) throw new Error(payload.content[0].text);
  return JSON.parse(payload.content[0].text);
}

const apeRun = (args) => callApe('ape_run', args);
const apeHistory = (args) => callApe('ape_history', args);

function receipt(ticket, overrides = {}) {
  return {
    ticket_id: ticket.ticket_id,
    status: 'passed',
    agent_identity: `agent-${ticket.role}`,
    tests: [],
    findings: [],
    evidence: { verdict: 'pass' },
    timing: {
      started_at: ticket.issued_at,
      completed_at: new Date(Date.parse(ticket.issued_at) + 10).toISOString(),
      duration_ms: 10,
    },
    ...overrides,
  };
}

const RECEIPT_SUMMARY_KEYS =
  ['head_tree_sha', 'receipt_hash', 'receipt_id', 'stage_id', 'status', 'ticket_id'];
// The TOP-LEVEL wire action receipt additionally carries the acting `role`
// (projection.js) so the LARP PostToolUse cue can tell a plan approval from
// other hand-offs; the compact state.receipts[] summaries stay role-less.
const TOP_LEVEL_RECEIPT_KEYS = [...RECEIPT_SUMMARY_KEYS, 'role'].sort();

describe('APE v2 bounded ape_history responses at the MCP wire', () => {
  it('summarizes query records, keeps the active stub, and leaves explain full', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ape-bounded-history-'));
    cleanups.push(dir);
    const paths = runtimePaths(dir);
    const runId = 'run-fixture-2889e88769ce';
    const record = {
      schema_version: '2.0.0',
      run_id: runId,
      objective: OBJECTIVE,
      mode: 'phase',
      lane: 'fast',
      requirements: ['R1'],
      status: 'completed',
      block_reason: null,
      created_at: ISSUED_AT,
      completed_at: ISSUED_AT,
      base_commit_sha: 'commit-base',
      final_tree_sha: 'tree-live',
      tickets: [makeTicket('test', 'test_writer', 'tik-1'), makeTicket('build', 'implementer', 'tik-2')],
      receipts: [makeReceipt('rec-1', 'tik-1')],
      gates: null,
      merge: null,
      record_hash: 'record-hash-history',
    };
    await atomicWriteJson(path.join(paths.history, `${runId}.json`), record);
    await atomicWriteJson(paths.active, { run_id: 'run-active', status: 'running' });

    const queried = await apeHistory({ action: 'query', project_dir: dir });
    expect(queried.ok).toBe(true);
    // The active stub crosses untouched; the archived record is summarized —
    // counts instead of full tickets[] (each embedding the record-input
    // schema) and receipts[] (full agent evidence).
    expect(queried.records[0]).toEqual({ run_id: 'run-active', status: 'running', active: true });
    const summary = queried.records[1];
    expect(summary.run_id).toBe(runId);
    expect(summary.ticket_count).toBe(2);
    expect(summary.receipt_count).toBe(1);
    expect(summary).not.toHaveProperty('tickets');
    expect(summary).not.toHaveProperty('receipts');
    expect(JSON.stringify(queried)).not.toContain('One-time receipt capability token');

    // Run-scoped explain stays the full-record channel.
    const explained = await apeHistory({ action: 'explain', project_dir: dir, run_id: runId });
    expect(explained.ok).toBe(true);
    expect(explained.record.tickets).toHaveLength(2);
    expect(explained.record.receipts).toHaveLength(1);
  });
});

describe('APE v2 bounded MCP responses over a live run', () => {
  it('defaults omitted mode and version for behavioral fast Codex starts before selecting v2 preflight', async () => {
    const dir = await project();
    await completeCodexBindingProbe(root, dir);
    const started = await apeRun({
      action: 'start',
      project_dir: dir,
      objective: 'Change behavior through structured preflight',
      lane: 'fast',
      host: 'codex',
      claimed_paths: ['src/value.js'],
      test_paths: ['tests/value.test.js'],
      requirements: ['R1'],
      behavioral: true,
      hooks_trusted: true,
      subagents_available: true,
      explicit_invocation: true,
    });

    expect(started.ok).toBe(true);
    expect(started.run.mode).toBe('phase');
    expect(started.run.plan_contract_version).toBe(2);
    expect(started.actions.find((action) => action.type === 'dispatch_agent')?.ticket)
      .toMatchObject({ stage_id: 'preflight', role: 'preflight_analyst', writable: false });
  }, 30_000);

  it('bounds the wire while the persisted state and ticket files stay complete', async () => {
    const dir = await project();
    await completeCodexBindingProbe(root, dir);
    const started = await apeRun({
      action: 'start',
      project_dir: dir,
      objective: 'Change behavior',
      mode: 'phase',
      lane: 'fast',
      host: 'codex',
      claimed_paths: ['src/value.js'],
      test_paths: ['tests/value.test.js'],
      requirements: ['R1'],
      behavioral: true,
      hooks_trusted: true,
      subagents_available: true,
      explicit_invocation: true,
      plan_contract_version: 1,
    });
    expect(started.ok).toBe(true);
    expect(started.run.objective).toBe('Change behavior');
    // The canonical complete ticket rides the dispatch_agent action; run.tickets[0]
    // is the deduped wire summary (friction #26 follow-up).
    const dispatched = started.actions.find((action) => action.type === 'dispatch_agent');
    const testTicket = dispatched.ticket;
    const receiptCapability = await bindCodexDispatch(root, dir, dispatched);
    expect(testTicket.role).toBe('test_writer');
    expect(testTicket.objective).toBe('Change behavior');
    expect(testTicket.required_checks).toEqual(['red-test']);
    expect(testTicket.model).toBeTruthy();
    expect(testTicket.deadline_at).toBeTruthy();
    expect(testTicket.output_schema.required).toContain('ticket_id');
    expect(dispatched.dispatch.ticket).toEqual({ ticket_id: testTicket.ticket_id });
    // The run.tickets[] summary references the run objective and the dispatch
    // ticket's schema instead of re-embedding either.
    const wireTest = started.run.tickets[0];
    expect(wireTest.objective).toBe(RUN_OBJECTIVE_REFERENCE);
    expect(wireTest.output_schema).toEqual(OUTPUT_SCHEMA_REFERENCE);

    await writeFile(path.join(dir, 'tests', 'value.test.js'), 'throw new Error("still red");\n');
    const recorded = await apeRun({
      action: 'record',
      project_dir: dir,
      receipt: receipt(testTicket, {
        receipt_capability: receiptCapability,
        tests: [{ command: 'node tests/value.test.js', passed: false, exit_code: 1, duration_ms: 1 }],
      }),
    });
    expect(recorded.ok).toBe(true);
    expect(Object.keys(recorded.receipt).sort()).toEqual(TOP_LEVEL_RECEIPT_KEYS);
    expect(recorded.receipt.stage_id).toBe(testTicket.stage_id);
    const receiptedSummary = recorded.run.tickets.find(
      (entry) => entry.ticket_id === testTicket.ticket_id,
    );
    expect(receiptedSummary.status).toBe('receipted');
    expect(receiptedSummary).not.toHaveProperty('objective');
    expect(Object.keys(recorded.run.receipts[0]).sort()).toEqual(RECEIPT_SUMMARY_KEYS);
    // The implementer's complete ticket rides the next dispatch_agent action; the
    // run.tickets[] pending entry is the deduped marker form.
    const implementerDispatch = recorded.actions.find(
      (action) => action.type === 'dispatch_agent',
    );
    const implementer = implementerDispatch.ticket;
    expect(implementer.role).toBe('implementer');
    expect(implementer.objective).toBe('Change behavior');
    expect(implementer.required_checks).toEqual(['targeted-tests']);
    expect(implementer.model).toBeTruthy();
    expect(implementer.deadline_at).toBeTruthy();
    const wireImplementer = recorded.run.tickets.at(-1);
    expect(wireImplementer.objective).toBe(RUN_OBJECTIVE_REFERENCE);
    expect(wireImplementer.output_schema).toEqual(OUTPUT_SCHEMA_REFERENCE);

    const status = await apeRun({ action: 'status', project_dir: dir });
    expect(status.active).toBe(true);
    expect(status.run.tickets.find((entry) => entry.ticket_id === testTicket.ticket_id).status)
      .toBe('receipted');
    expect(status.run.tickets.at(-1).objective).toBe(RUN_OBJECTIVE_REFERENCE);

    // Persistence unchanged: the projection lives at the MCP wire only, the
    // active state on disk keeps the full tickets and receipts (friction #26).
    const paths = runtimePaths(dir);
    const persisted = await readJson(paths.active);
    const persistedTest = persisted.tickets.find(
      (entry) => entry.ticket_id === testTicket.ticket_id,
    );
    expect(persistedTest.objective).toBe('Change behavior');
    expect(persistedTest.claimed_paths).toEqual(['tests/value.test.js']);
    expect(persisted.receipts[0].ticket_id).toBe(testTicket.ticket_id);
    expect(persisted.receipts[0].changed_files).toContain('tests/value.test.js');
    expect(persisted.receipts[0].evidence).toBeTruthy();

    const ticketFile = path.join(
      paths.tickets,
      `${testTicket.ticket_id.replaceAll(':', '_')}.json`,
    );
    const persistedTicket = await readJson(ticketFile);
    expect(persistedTicket.objective).toBe('Change behavior');
    // Disk keeps the full record-input contract, not the wire reference marker.
    expect(persistedTicket.output_schema.properties.receipt_capability).toBeTruthy();
  }, 120_000);
});
