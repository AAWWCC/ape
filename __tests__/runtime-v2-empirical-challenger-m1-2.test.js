import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { previewRun, resumeRun, startRun } from '../lib/runtime/service.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import * as storage from '../lib/runtime/storage.js';
import { acquireRunLock, inspectRunLock } from '../lib/runtime/lock.js';
import {
  finalizeTicket,
  validateTicket,
  RunStartInputSchema,
} from '../lib/runtime/schemas.js';
import { SCHEMA_VERSION } from '../lib/runtime/constants.js';
import { hashRecord, sha256 } from '../lib/runtime/canonical.js';
import { codexInjectedDispatchContext } from '../lib/runtime/adapters.js';
import { gitFixtureEnv } from '../test-support/git-fixtures.js';

const dirs = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const git = (dir, ...args) => execFileSync('git', args, { env: gitFixtureEnv(), cwd: dir, encoding: 'utf8' }).trim();

async function project() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-challenger-m1-2-'));
  dirs.push(dir);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'APE Challenger');
  git(dir, 'config', 'user.email', 'challenger@example.test');
  git(dir, 'config', 'core.autocrlf', 'false');
  await writeFile(path.join(dir, '.gitignore'), '.ape/\n.env\n');
  await writeFile(path.join(dir, 'README.md'), '# Base Project\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'baseline');
  await storage.atomicWriteJson(runtimePaths(dir).config, {
    shipping: { auto_merge: false, required_remote_checks: false },
    test_commands: { full: 'node -e "process.exit(0)"', targeted_template: 'node -e "process.exit(0)"' },
  });
  return dir;
}

function baseStartInput(overrides = {}) {
  return {
    objective: 'Empirical challenge verification',
    mode: 'phase',
    lane: 'mechanical',
    host: 'claude',
    behavioral: false,
    claimed_paths: ['README.md'],
    test_paths: [],
    requirements: [],
    risk_triggers: [],
    hooks_trusted: true,
    subagents_available: true,
    explicit_invocation: true,
    ...overrides,
  };
}

function baseTicketInput(overrides = {}) {
  return {
    schema_version: SCHEMA_VERSION,
    ticket_id: 'run-challenger-m1:build:t1',
    run_id: 'run-challenger-m1',
    stage_id: 'build',
    role: 'implementer',
    objective: 'Empirical challenge stage ticket',
    claimed_paths: ['README.md'],
    test_paths: [],
    model_tier: 'balanced',
    model: { model: 'sonnet' },
    deadline_at: '2026-10-21T12:00:00.000Z',
    output_schema: {},
    required_checks: [],
    parent_hash: null,
    base_tree_sha: 'a'.repeat(40),
    attempt: 1,
    writable: true,
    issued_at: '2026-10-21T10:00:00.000Z',
    ...overrides,
  };
}

async function overrideLogLines(paths) {
  const content = await readFile(paths.overrideLog, 'utf8').catch(() => '');
  return content.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

describe('Empirical Challenge 1: blocker_feedback string & schema/hashing/prompt resilience', () => {
  it('RunStartInputSchema: accepts 0, 1024, 4096 char feedback; rejects 4097 chars', () => {
    const inputEmpty = baseStartInput({ blocker_feedback: '', recovery_feedback: '' });
    expect(RunStartInputSchema.safeParse(inputEmpty).success).toBe(true);

    const input1024 = baseStartInput({ blocker_feedback: 'x'.repeat(1024) });
    expect(RunStartInputSchema.safeParse(input1024).success).toBe(true);

    const input4096 = baseStartInput({ blocker_feedback: 'y'.repeat(4096), recovery_feedback: 'z'.repeat(4096) });
    expect(RunStartInputSchema.safeParse(input4096).success).toBe(true);

    const input4097Blocker = baseStartInput({ blocker_feedback: 'x'.repeat(4097) });
    const parsedBlocker = RunStartInputSchema.safeParse(input4097Blocker);
    expect(parsedBlocker.success).toBe(false);

    const input4097Recovery = baseStartInput({ recovery_feedback: 'x'.repeat(4097) });
    const parsedRecovery = RunStartInputSchema.safeParse(input4097Recovery);
    expect(parsedRecovery.success).toBe(false);
  });

  it('StageTicket: accepts up to 4096 char recovery_feedback; rejects 4097 chars during ticket finalization', () => {
    const ticket4096 = baseTicketInput({ recovery_feedback: 'k'.repeat(4096) });
    const finalized4096 = finalizeTicket(ticket4096);
    expect(finalized4096.recovery_feedback.length).toBe(4096);
    expect(validateTicket(finalized4096).valid).toBe(true);

    const ticket4097 = baseTicketInput({ recovery_feedback: 'k'.repeat(4097) });
    expect(() => finalizeTicket(ticket4097)).toThrow();
  });

  it('ticket hashing: multi-line error traces, special characters, and 4096 chars produce valid deterministic hash and pass validateTicket', () => {
    const complexFeedback = [
      'Error: Merge gate execution failed with unhandled exception at runtime',
      '    at executeMergeGates (/app/lib/runtime/gates.js:142:15)',
      '    at async runPipelineCycle (/app/lib/runtime/pipeline.js:889:22)',
      'Special chars: "double-quotes", \'single-quotes\', `backticks`, ${interpolated_var}',
      'JSON injection payload: {"injected_field": true, "run_id": "fake-run"}',
      'HTML/XML: <script>alert("xss")</script><![CDATA[test]]>',
      'Regex & Operators: /^[A-Z0-9_-]+$/i && (a || b) => { return c ?? d; }',
      'Unicode & Emojis: 💥 🚀 🔥 日本語 • åéîøü • \u202E RTL test',
      'Windows CRLF and tabs: \r\n\t--subtrace--\r\n\tlevel 2',
      'Padding tail: ' + 'A'.repeat(3000),
    ].join('\n').slice(0, 4096);

    const ticket = finalizeTicket(baseTicketInput({ recovery_feedback: complexFeedback }));
    expect(ticket.recovery_feedback).toBe(complexFeedback);
    expect(ticket.ticket_hash).toMatch(/^[0-9a-f]{64}$/);

    // Validate ticket passes
    const validated = validateTicket(ticket);
    expect(validated.valid).toBe(true);
    expect(validated.errors).toBeUndefined();

    // Verify hash matches hashRecord directly
    expect(ticket.ticket_hash).toBe(hashRecord(ticket, ['ticket_hash']));

    // Persistence JSON round-trip retains exact hash and validity
    const serialized = JSON.stringify(ticket);
    const deserialized = JSON.parse(serialized);
    const revalidated = validateTicket(deserialized);
    expect(revalidated.valid).toBe(true);
    expect(revalidated.value.ticket_hash).toBe(ticket.ticket_hash);

    // Tampering with 1 byte of recovery_feedback invalidates the ticket hash
    const tampered = { ...ticket, recovery_feedback: complexFeedback.slice(0, -1) + '!' };
    const invalidVerdict = validateTicket(tampered);
    expect(invalidVerdict.valid).toBe(false);
    expect(invalidVerdict.errors).toBeDefined();
  });

  it('Codex context rendering: formats multi-line, 4096-char recovery_feedback without breaking schema reference', () => {
    const complexFeedback = [
      'Stack trace:',
      '  TypeError: Cannot read properties of undefined (reading "digest")',
      '    at evaluateAdmission (lib/runtime/admission.js:132:15)',
      'Special: `code_block` ${env.SECRET} "quoted" \'single\'',
      'x'.repeat(3800),
    ].join('\n').slice(0, 4096);

    const ticket = finalizeTicket(baseTicketInput({ recovery_feedback: complexFeedback }));
    const context = codexInjectedDispatchContext(ticket);

    expect(typeof context).toBe('string');
    expect(context).toContain('APE trusted native binding context (authoritative)');
    expect(context).toContain('Prior execution blocker feedback\n\n' + complexFeedback);
    expect(context).toContain('Immutable StageTicket reference');

    // The trailing JSON block is valid JSON and preserves ticket_id and ticket_hash
    const lines = context.split('\n\n');
    const jsonBlock = lines[lines.length - 1];
    const parsedRef = JSON.parse(jsonBlock);
    expect(parsedRef.ticket_id).toBe(ticket.ticket_id);
    expect(parsedRef.ticket_hash).toBe(ticket.ticket_hash);
  });

  it('Claude dispatch prompt: formats multi-line feedback while preserving APE_DISPATCH_NONCE extraction', async () => {
    const dir = await project();
    const multilineBlocker = [
      'Error: AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:',
      '+ actual - expected',
      '+   { ready: false }',
      '-   { ready: true }',
      '    at /Users/aidan/Code/apps/ape/__tests__/gate.test.js:45:12',
    ].join('\n');

    const started = await startRun(dir, baseStartInput({
      blocker_feedback: multilineBlocker,
    }));
    expect(started.ok).toBe(true);
    expect(started.run.blocker_feedback).toBe(multilineBlocker);

    const dispatchAction = started.actions?.find((a) => a.type === 'dispatch_agent');
    expect(dispatchAction).toBeDefined();
    const prompt = dispatchAction?.dispatch?.dispatch_intent?.prompt ?? dispatchAction?.dispatch_intent?.prompt ?? dispatchAction?.prompt;

    expect(prompt).toContain('Prior execution blocker feedback:\n' + multilineBlocker);
    // Nonce line exists at prompt tail
    const nonceMatch = prompt.match(/(?:^|\r?\n)APE_DISPATCH_NONCE=([A-Za-z0-9_-]{1,300})(?=\r?\n|$)/);
    expect(nonceMatch).not.toBeNull();
    expect(nonceMatch[1].length).toBeGreaterThan(0);
  });
});

describe('Empirical Challenge 2: Gate retry delegation vs single-step resume on exhaustion', () => {
  it('delegates to regateRunLocked when regate_attempts < max_regate_attempts (attempts = 0, 1, 2)', async () => {
    const dir = await project();
    const started = await startRun(dir, baseStartInput());
    expect(started.ok).toBe(true);
    const paths = runtimePaths(dir);

    // Setup blocked state at stage 'gates' with 1 regate attempt used (out of 3)
    const state = await storage.readJson(paths.active);
    state.status = 'blocked';
    state.stage = 'gates';
    state.block_reason = 'Gate test run failed';
    state.regate_attempts = 1;
    await storage.atomicWriteJson(paths.active, state);
    await storage.atomicWriteJson(path.join(paths.runs, `${state.run_id}.json`), state);

    const result = await resumeRun(dir, { explicit_invocation: true });
    expect(result.ok).toBe(true);
    // Preserves identical run_id (delegated to regateRunLocked, NOT replaced)
    expect(result.run.run_id).toBe(state.run_id);
    expect(result.run.supersedes_run).toBeUndefined();

    // Check that no replacement checkpoint or auto-retire log was generated
    const audits = await overrideLogLines(paths);
    expect(audits.filter((a) => a.operation === 'auto-retire')).toHaveLength(0);
  });

  it('triggers single-step self-healing resume when regate_attempts are EXHAUSTED (attempts = 3)', async () => {
    const dir = await project();
    const started = await startRun(dir, baseStartInput());
    expect(started.ok).toBe(true);
    const paths = runtimePaths(dir);

    // Add uncommitted work
    await writeFile(path.join(dir, 'README.md'), '# Updated with uncommitted fix\n');

    // Setup blocked state at stage 'gates' with bounded execution policy and attempts = 3 (MAX_REGATE_ATTEMPTS reached)
    const state = await storage.readJson(paths.active);
    state.status = 'blocked';
    state.stage = 'gates';
    state.block_reason = 'Gate suite failed deterministically after 3 attempts';
    state.execution_policy = {
      version: 2,
      limits: {
        version: 2,
        max_regate_attempts: 3,
        max_stage_attempts: 2,
        max_worker_protocol_redispatches_per_stage: 1,
        max_physical_workers_per_ticket: 2,
        max_validation_submissions_per_worker: 3,
        max_reconciliation_stage_attempts: 1,
        max_reconciliation_protocol_redispatches: 0,
      },
      gates: {},
      shipping: {},
      deadlines_ms: {},
    };
    state.regate_attempts = 3;
    await storage.atomicWriteJson(paths.active, state);
    await storage.atomicWriteJson(path.join(paths.runs, `${state.run_id}.json`), state);

    // When regate_attempts is exhausted, resumeRun MUST NOT fail with "re-gate attempt limit reached".
    // Instead, it must collapse multi-step recovery into single-step replacement run!
    const result = await resumeRun(dir, { explicit_invocation: true });
    expect(result.ok).toBe(true);
    expect(result.run).toBeDefined();
    // Replacement run launched with new run_id
    expect(result.run.run_id).not.toBe(state.run_id);
    expect(result.run.status).toBe('running');
    expect(result.run.supersedes_run).toBe(state.run_id);
    expect(result.run.checkpoint_id).toMatch(/^checkpoint-[0-9a-f]{32}$/);

    // Checkpoint continuation marker was created
    const continued = await access(path.join(paths.checkpoints, `${result.run.checkpoint_id}.continued.json`)).then(() => true, () => false);
    expect(continued).toBe(true);

    // Blocker feedback was propagated into replacement ticket
    const ticket = result.run.tickets[0];
    expect(ticket.recovery_feedback).toContain('Gate suite failed deterministically after 3 attempts');

    // Old exhausted run archived in history
    const history = await storage.readJson(path.join(paths.history, `${state.run_id}.json`));
    expect(history.run_id).toBe(state.run_id);
    expect(history.status).toBe('blocked');

    // Override log recorded auto-retire
    const audits = await overrideLogLines(paths);
    expect(audits).toContainEqual(expect.objectContaining({
      run_id: state.run_id,
      operation: 'auto-retire',
      reason: expect.stringContaining('Single-step self-healing resume replacement'),
    }));
  });

  it('triggers single-step resume immediately when blocked stage is NOT gates (e.g. build)', async () => {
    const dir = await project();
    const started = await startRun(dir, baseStartInput());
    expect(started.ok).toBe(true);
    const paths = runtimePaths(dir);

    const state = await storage.readJson(paths.active);
    state.status = 'blocked';
    state.stage = 'build';
    state.block_reason = 'Build compilation error';
    state.regate_attempts = 0;
    await storage.atomicWriteJson(paths.active, state);
    await storage.atomicWriteJson(path.join(paths.runs, `${state.run_id}.json`), state);

    const result = await resumeRun(dir, { explicit_invocation: true });
    expect(result.ok).toBe(true);
    expect(result.run.run_id).not.toBe(state.run_id);
    expect(result.run.supersedes_run).toBe(state.run_id);
  });

  it('returns multi-step recovery_plan without modifying state when explicit_invocation & single_step are false', async () => {
    const dir = await project();
    const started = await startRun(dir, baseStartInput());
    expect(started.ok).toBe(true);
    const paths = runtimePaths(dir);

    const state = await storage.readJson(paths.active);
    state.status = 'blocked';
    state.stage = 'build';
    state.block_reason = 'Manual check needed';
    await storage.atomicWriteJson(paths.active, state);
    await storage.atomicWriteJson(path.join(paths.runs, `${state.run_id}.json`), state);

    // Call resume WITHOUT explicit_invocation / single_step
    const result = await resumeRun(dir, {});
    expect(result.ok).toBe(true);
    expect(result.recovery_plan).toBeDefined();

    // Active state remains unchanged!
    const active = await storage.readJson(paths.active);
    expect(active.run_id).toBe(state.run_id);
    expect(active.status).toBe('blocked');
  });
});

describe('Empirical Challenge 3: Running and gating runs are NEVER accidentally auto-superseded', () => {
  it('previewRun refuses admission with active-run-exists when current run is running (stage: dispatch)', async () => {
    const dir = await project();
    const paths = runtimePaths(dir);
    const runningRunId = 'run-live-running-dispatch';
    const runningState = {
      version: 2,
      schema_version: '2.0.0',
      run_id: runningRunId,
      status: 'running',
      stage: 'dispatch',
      objective: 'Live dispatch in progress',
      mode: 'phase',
      lane: 'fast',
      host: 'claude',
      claimed_paths: ['README.md'],
      test_paths: [],
      requirements: [],
      risk_triggers: [],
      base_branch: 'main',
      branch: 'ape/live-branch',
      tickets: [],
      receipts: [],
      attempts: {},
      created_at: '2026-10-21T00:00:00.000Z',
      updated_at: '2026-10-21T00:00:00.000Z',
    };
    await storage.atomicWriteJson(paths.active, runningState);

    const preview = await previewRun(dir, baseStartInput({ admission_contract_version: 1 }));
    expect(preview.admission.ready).toBe(false);
    expect(preview.admission.blocking).toContainEqual(expect.objectContaining({
      code: 'active-run-exists',
    }));
    // supersedes_run is NOT auto-linked to active running run
    expect(preview.admission.request?.supersedes_run).toBeUndefined();
  });

  it('previewRun refuses admission with active-run-exists when current run is running (stage: gates)', async () => {
    const dir = await project();
    const paths = runtimePaths(dir);
    const gatingRunId = 'run-live-running-gates';
    const gatingState = {
      version: 2,
      schema_version: '2.0.0',
      run_id: gatingRunId,
      status: 'running',
      stage: 'gates',
      objective: 'Merge gates currently running',
      mode: 'phase',
      lane: 'fast',
      host: 'claude',
      claimed_paths: ['README.md'],
      test_paths: [],
      requirements: [],
      risk_triggers: [],
      base_branch: 'main',
      branch: 'ape/gating-branch',
      tickets: [],
      receipts: [],
      attempts: {},
      created_at: '2026-10-21T00:00:00.000Z',
      updated_at: '2026-10-21T00:00:00.000Z',
    };
    await storage.atomicWriteJson(paths.active, gatingState);

    const preview = await previewRun(dir, baseStartInput({ admission_contract_version: 1 }));
    expect(preview.admission.ready).toBe(false);
    expect(preview.admission.blocking).toContainEqual(expect.objectContaining({
      code: 'active-run-exists',
    }));
    expect(preview.admission.request?.supersedes_run).toBeUndefined();
  });

  it('startRun refuses to supersede active running run, even with explicit supersedes_run request', async () => {
    const dir = await project();
    const paths = runtimePaths(dir);
    const runningRunId = 'run-live-cannot-supersede';
    const runningState = {
      version: 2,
      schema_version: '2.0.0',
      run_id: runningRunId,
      status: 'running',
      stage: 'dispatch',
      objective: 'Live dispatch',
      mode: 'phase',
      lane: 'fast',
      host: 'claude',
      claimed_paths: ['README.md'],
      test_paths: [],
      requirements: [],
      risk_triggers: [],
      base_branch: 'main',
      branch: 'ape/live-branch',
      tickets: [],
      receipts: [],
      attempts: {},
      created_at: '2026-10-21T00:00:00.000Z',
      updated_at: '2026-10-21T00:00:00.000Z',
    };
    await storage.atomicWriteJson(paths.active, runningState);
    await acquireRunLock(paths.lock, runningRunId);

    // Attempt startRun without supersedes_run -> throws error
    await expect(startRun(dir, baseStartInput())).rejects.toThrow(
      new RegExp(`run ${runningRunId} is already running`),
    );

    // Attempt startRun WITH explicit supersedes_run -> must still throw error
    await expect(startRun(dir, baseStartInput({ supersedes_run: runningRunId }))).rejects.toThrow(
      new RegExp(`run ${runningRunId} is already running`),
    );

    // Verify lock and active state are intact and untouched
    const lock = await inspectRunLock(paths.lock);
    expect(lock.present).toBe(true);
    expect(lock.run_id).toBe(runningRunId);

    const active = await storage.readJson(paths.active);
    expect(active.run_id).toBe(runningRunId);
    expect(active.status).toBe('running');

    // No auto-retire records in override log
    const audits = await overrideLogLines(paths);
    expect(audits).toEqual([]);
  });

  it('startRun refuses to supersede active gating run', async () => {
    const dir = await project();
    const paths = runtimePaths(dir);
    const gatingRunId = 'run-active-gating-protected';
    const gatingState = {
      version: 2,
      schema_version: '2.0.0',
      run_id: gatingRunId,
      status: 'running',
      stage: 'gates',
      objective: 'Gating in progress',
      mode: 'phase',
      lane: 'fast',
      host: 'claude',
      claimed_paths: ['README.md'],
      test_paths: [],
      requirements: [],
      risk_triggers: [],
      base_branch: 'main',
      branch: 'ape/gating-branch',
      tickets: [],
      receipts: [],
      attempts: {},
      created_at: '2026-10-21T00:00:00.000Z',
      updated_at: '2026-10-21T00:00:00.000Z',
    };
    await storage.atomicWriteJson(paths.active, gatingState);
    await acquireRunLock(paths.lock, gatingRunId);

    await expect(startRun(dir, baseStartInput())).rejects.toThrow(
      new RegExp(`run ${gatingRunId} is already running`),
    );

    const lock = await inspectRunLock(paths.lock);
    expect(lock.run_id).toBe(gatingRunId);

    const active = await storage.readJson(paths.active);
    expect(active.run_id).toBe(gatingRunId);
    expect(active.status).toBe('running');
  });

  it('resumeRun on a live running run never replaces the execution', async () => {
    const dir = await project();
    const started = await startRun(dir, baseStartInput());
    expect(started.ok).toBe(true);
    const liveRunId = started.run.run_id;

    // Call resumeRun on the running run
    const result = await resumeRun(dir, { explicit_invocation: true });
    expect(result.ok).toBe(true);
    expect(result.run.run_id).toBe(liveRunId);
    expect(['already-live', 'recovered-orphan']).toContain(result.resume_state);

    // Check that run was NOT superseded
    const paths = runtimePaths(dir);
    const active = await storage.readJson(paths.active);
    expect(active.run_id).toBe(liveRunId);
    expect(active.status).toBe('running');
    expect(active.supersedes_run).toBeUndefined();
  });
});
