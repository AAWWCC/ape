import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// SCOPE_EXPANDED persist crash window (roadmap scope-expanded-receipt-atomicity;
// MEDIUM finding 1.3 in docs/research/2026-07-19-runtime-audit.md; invariant 1).
//
// Public contract under test, derived from the ticket objective:
//
//   Recording a receipt that reports lane escalation, new risk triggers, or a
//   review-proposed scope expansion is one runtime-owned transition. If the
//   process dies after the receipt has become durable in active.json but
//   before the pipeline consequences of RECEIPT_RECORDED (successor ticket,
//   group outcome, remediation, gates) are durable, the client's retry of the
//   IDENTICAL receipt — the runtime's own documented recovery lever — must
//   resume the pipeline: after the retry the run holds a dispatchable
//   successor (or has honestly transitioned), never an idle 'running' run
//   whose every ticket is receipted, where NEXT can only echo status and the
//   sole exit is abort.
//
// The acceptance contract permits two implementations and these tests accept
// both: (a) no durable active.json snapshot exists between 'receipt recorded'
// and 'actions applied' (the scope patch folds into the RECEIPT_RECORDED
// chain, so the one receipt-bearing persist already carries the successor), or
// (b) the idempotent-recovery arm re-derives and applies the RECEIPT_RECORDED
// actions when state shows the committed receipt but no successor progress.
// The crash is therefore anchored to the CONTRACT event, not a code line: the
// FIRST durable active.json snapshot that contains the receipt. Under (a) that
// snapshot already carries the consequences; under (b) the retry derives them;
// on the current tree the retry returns { idempotent, recovered, actions: [] }
// and the run idles — the red anchor.
//
// Crash simulation follows the merged-archive-idempotency suite's discipline:
// everything is the real runtime (real reducers, persistence, red-test
// observation, git evidence) in a temp git repo. The only seam is storage's
// atomicWriteJson, wrapped so that ONE armed write COMPLETES on disk and then
// throws — byte-equivalent to SIGKILL immediately after that write landed:
// every earlier write (receipt file, prepared transaction, audit lines) is
// durable, nothing later happens, in-memory state dies with the call, and the
// retry is a fresh entry that re-reads disk. Idempotency is convergence, not
// amnesia: 'committed receipt' must imply 'consequences applied or reachable'.
vi.mock('../lib/runtime/storage.js', async (importOriginal) => {
  const actual = await importOriginal();
  const control = { arm: null, fired: 0 };
  const maybeCrash = (file, value, kind) => {
    const arm = control.arm;
    const matched = arm && (typeof arm.match === 'function'
      ? arm.match({ file, value, kind })
      : kind === 'atomic' &&
        file === arm.file &&
        Array.isArray(value?.receipts) &&
        value.receipts.some((entry) => entry?.ticket_id === arm.ticket_id));
    if (!matched) return;
    control.arm = null;
    control.fired += 1;
    const crash = new Error(
      'simulated crash: the process died immediately after this durable write',
    );
    crash.code = 'APE_TEST_SIMULATED_CRASH';
    throw crash;
  };
  return {
    ...actual,
    __crashControl: control,
    atomicWriteJson: async (file, value) => {
      await actual.atomicWriteJson(file, value);
      maybeCrash(file, value, 'atomic');
    },
    appendJsonLine: async (file, value) => {
      await actual.appendJsonLine(file, value);
      maybeCrash(file, value, 'append');
    },
  };
});
import { __crashControl, atomicWriteJson, readJson } from '../lib/runtime/storage.js';
import { nextRun, recordReceipt, startRun } from '../lib/runtime/service.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { sha256 } from '../lib/runtime/canonical.js';

// Real filesystem + git + spawned red-test observation; keep the honest tests
// off the default timeout, and let teardown ride out win32 EBUSY.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const cleanups = [];
afterEach(async () => {
  __crashControl.arm = null;
  __crashControl.fired = 0;
  await Promise.all(
    cleanups
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })),
  );
});

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  }).trim();
}

// CJS on purpose: the scratch project has no package.json, so .js files run as
// CommonJS under the configured `node tests/value.test.js` targeted command
// (the runtime-owned red-test observation executes it).
const VALUE_V1 = 'module.exports = { value: 1 };\n';
const VALUE_V2 = 'module.exports = { value: 2 };\n';
const AUTHORED_TEST =
  "const { value } = require('../src/value.js');\n" +
  "if (value !== 2) { throw new Error('red: value is ' + value); }\n";

async function project() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-scope-atomicity-'));
  cleanups.push(dir);
  await mkdir(path.join(dir, 'src'));
  await mkdir(path.join(dir, 'tests'));
  await writeFile(path.join(dir, 'src', 'value.js'), VALUE_V1);
  await writeFile(path.join(dir, 'tests', 'value.test.js'), 'throw new Error("placeholder");\n');
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'ape@example.test');
  git(dir, 'config', 'user.name', 'APE Test');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'test: baseline');
  await atomicWriteJson(runtimePaths(dir).config, {
    shipping: { auto_merge: false, provider: 'github', required_remote_checks: false },
    test_commands: {
      full: 'node -e "process.exit(0)"',
      targeted: 'node tests/value.test.js',
    },
  });
  return dir;
}

function startInput(overrides = {}) {
  return {
    objective: 'Exercise SCOPE_EXPANDED receipt atomicity across a crash',
    mode: 'phase',
    lane: 'auto',
    host: 'codex',
    claimed_paths: ['src/value.js'],
    test_paths: ['tests/value.test.js'],
    requirements: [],
    risk_triggers: [],
    behavioral: true,
    hooks_trusted: true,
    subagents_available: true,
    explicit_invocation: true,
    ...overrides,
  };
}

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

const redTest = [{ command: 'node tests/value.test.js', passed: false, exit_code: 1, duration_ms: 1 }];
const greenTest = [{ command: 'node tests/value.test.js', passed: true, exit_code: 0, duration_ms: 1 }];

// Tickets awaiting a receipt: the run's forward path. An idle wedged run has
// none while still 'running'.
function pendingTickets(state) {
  const receipted = new Set(state.receipts.map((entry) => entry.ticket_id));
  const expired = new Set(state.expired_tickets ?? []);
  return state.tickets.filter(
    (ticket) => !receipted.has(ticket.ticket_id) && !expired.has(ticket.ticket_id),
  );
}

// Drive a clean fast-lane run to its review stage: authored red test (the
// runtime observes it), green build. Mirrors the scope-expansion suite.
async function walkToReview(dir) {
  const started = await startRun(dir, startInput());
  expect(started.ok).toBe(true);
  expect(started.run.lane).toBe('fast');
  const testTicket = started.run.tickets[0];
  expect(testTicket.role).toBe('test_writer');
  await writeFile(path.join(dir, 'tests', 'value.test.js'), AUTHORED_TEST);
  const tested = await recordReceipt(dir, receipt(testTicket, { tests: redTest }));
  expect(tested.ok).toBe(true);
  const buildTicket = tested.run.tickets.at(-1);
  expect(buildTicket.role).toBe('implementer');
  await writeFile(path.join(dir, 'src', 'value.js'), VALUE_V2);
  const built = await recordReceipt(dir, receipt(buildTicket, { tests: greenTest }));
  expect(built.ok).toBe(true);
  const reviewTicket = built.run.tickets.at(-1);
  expect(reviewTicket.stage_id).toBe('review');
  return { reviewTicket };
}

// Record the receipt with the crash armed on the first active.json snapshot
// that contains it. The armed write COMPLETES, then the call dies — the exact
// SIGKILL-after-persist window. Returns the crashed call's outcome.
async function recordWithCrash(dir, ticketId, payload) {
  const paths = runtimePaths(dir);
  __crashControl.arm = { file: paths.active, ticket_id: ticketId };
  const outcome = await recordReceipt(dir, payload).then(
    (value) => ({ resolved: true, value }),
    (error) => ({ resolved: false, error }),
  );
  // Harness sanity, true for any implementation of the contract: recording a
  // receipt must at some point make it durable in active.json, so the armed
  // crash fires exactly once and the client never saw a success.
  expect(__crashControl.fired).toBe(1);
  expect(__crashControl.arm).toBe(null);
  if (outcome.resolved) expect(outcome.value.ok).not.toBe(true);
  return outcome;
}

async function recordAtCrashPoint(dir, match, payload) {
  __crashControl.arm = { match };
  const outcome = await recordReceipt(dir, payload).then(
    (value) => ({ resolved: true, value }),
    (error) => ({ resolved: false, error }),
  );
  expect(__crashControl.fired).toBe(1);
  expect(__crashControl.arm).toBe(null);
  if (outcome.resolved) expect(outcome.value.ok).not.toBe(true);
  return outcome;
}

function additiveCapabilityReceipt(ticket) {
  return receipt(ticket, {
    status: 'failed',
    evidence: {
      failure_kind: 'capability',
      summary: 'the red suite needs one additional repository-local test',
      required_claims: { test_paths: ['tests/recovered.test.js'] },
    },
  });
}

function ticketWithReboundIdentity(ticket, ticketId) {
  const rebound = structuredClone(ticket);
  delete rebound.ticket_hash;
  rebound.ticket_id = ticketId;
  rebound.output_schema.properties.ticket_id.const = ticketId;
  rebound.capability_manifest.receipt_schema.hash = sha256(rebound.output_schema);
  rebound.ticket_hash = sha256(rebound);
  return rebound;
}

async function rejectedRecord(dir, payload) {
  return recordReceipt(dir, payload).catch((error) => ({
    ok: false,
    rejected: true,
    errors: [error?.message ?? String(error)],
  }));
}

describe('APE v2 SCOPE_EXPANDED receipt atomicity across a crash (audit 1.3, invariant 1)', () => {
  it('risk-trigger escalation on the test receipt: the identical retry after the crash resumes the pipeline instead of resting the run idle', async () => {
    const dir = await project();
    const paths = runtimePaths(dir);
    const started = await startRun(dir, startInput());
    expect(started.ok).toBe(true);
    expect(started.run.lane).toBe('fast');
    const testTicket = started.run.tickets[0];
    expect(testTicket.role).toBe('test_writer');
    await writeFile(path.join(dir, 'tests', 'value.test.js'), AUTHORED_TEST);

    // The test receipt reports a canonical risk trigger: new risk + lane
    // escalation, the SCOPE_EXPANDED route with no scheduling side channel.
    const payload = receipt(testTicket, {
      tests: redTest,
      evidence: { verdict: 'pass', risk_triggers: ['security'] },
    });
    await recordWithCrash(dir, testTicket.ticket_id, payload);

    // The crash left the receipt durable in active state — the client's ONLY
    // sanctioned recovery is retrying the identical record call.
    const crashedState = await readJson(paths.active);
    expect(crashedState.receipts.some((entry) => entry.ticket_id === testTicket.ticket_id)).toBe(true);

    const retry = await recordReceipt(dir, payload);
    expect(retry.ok).toBe(true);
    expect(retry.receipt.ticket_id).toBe(testTicket.ticket_id);

    // Scope consequences are durable: trigger recorded, high_risk armed, lane
    // escalated over the reported risk.
    const active = await readJson(paths.active);
    expect(active.risk_triggers).toContain('security');
    expect(active.high_risk).toBe(true);
    expect(active.lane).toBe('full');

    // The red anchor — pipeline consequences too: the run is 'running' WITH a
    // dispatchable successor (the implementer stage that follows the test
    // stage), never every-ticket-receipted idle. On the current tree the
    // retry returns recovered/actions:[] and no successor ever exists.
    expect(active.status).toBe('running');
    const pending = pendingTickets(active);
    expect(pending.length).toBeGreaterThan(0);
    expect(
      pending.some((ticket) => ticket.stage_id === 'build' && ticket.role === 'implementer'),
    ).toBe(true);

    // NEXT dispatches the successor rather than echoing an idle run.
    const next = await nextRun(dir);
    expect(next.ok).toBe(true);
    const kinds = next.actions.map((action) => action.type);
    expect(kinds.some((kind) => kind === 'dispatch_agent' || kind === 'dispatch_pending')).toBe(true);
    expect(kinds).not.toContain('status');

    // Convergence is at-most-once: a further identical retry must not issue a
    // duplicate successor or duplicate the receipt (invariants 5/7).
    const before = await readJson(paths.active);
    const retryAgain = await recordReceipt(dir, payload);
    expect(retryAgain.ok).toBe(true);
    const after = await readJson(paths.active);
    expect(after.tickets.length).toBe(before.tickets.length);
    expect(after.receipts.length).toBe(before.receipts.length);
  });

  it('review-proposed scope expansion: the identical retry after the crash opens the remediation cycle with the grown claim set', async () => {
    const dir = await project();
    const paths = runtimePaths(dir);
    const { reviewTicket } = await walkToReview(dir);

    // Blocking review naming an out-of-claims path: the D3 proposedClaims
    // route into SCOPE_EXPANDED, whose RECEIPT_RECORDED consequence is the
    // remediation-build ticket inheriting the expanded allowlist.
    const payload = receipt(reviewTicket, {
      tests: greenTest,
      findings: [{
        file: 'lib/helper.js',
        line: 1,
        title: 'expand production scope',
        detail: 'the fix must also touch lib/helper.js',
        blocking: true,
        remediation: { owner: 'production' },
      }],
      evidence: {
        verdict: 'fail',
        scope_expansion: { claimed_paths: ['lib/helper.js'], reason: 'the fix requires this module' },
      },
    });
    await recordWithCrash(dir, reviewTicket.ticket_id, payload);

    const retry = await recordReceipt(dir, payload);
    expect(retry.ok).toBe(true);

    // The run converges: grown claims durable AND the single remediation
    // cycle opened with its ticket inheriting the expansion — not a
    // recovered-empty response over an idle run with zero cycles consumed.
    const active = await readJson(paths.active);
    expect(active.status).toBe('running');
    expect(active.claimed_paths).toContain('lib/helper.js');
    expect(active.remediation_cycles).toBe(1);
    const remediation = pendingTickets(active).find(
      (ticket) => ticket.stage_id === 'remediation-build',
    );
    expect(remediation).toBeTruthy();
    expect(remediation.claimed_paths).toContain('lib/helper.js');

    // The override-class audit of the claim growth survived the crash.
    const audits = (await readFile(paths.overrideLog, 'utf8').catch(() => ''))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((line) => line.operation === 'scope-expansion');
    expect(audits.length).toBeGreaterThanOrEqual(1);
    expect(audits[0].added_paths).toEqual(['lib/helper.js']);

    // At-most-once: another identical retry must not double-consume the
    // single remediation cycle or issue a duplicate remediation ticket.
    const retryAgain = await recordReceipt(dir, payload);
    expect(retryAgain.ok).toBe(true);
    const after = await readJson(paths.active);
    expect(after.remediation_cycles).toBe(1);
    expect(after.tickets.length).toBe(active.tickets.length);
    expect(after.receipts.length).toBe(active.receipts.length);
  });
});

describe('APE v2 capability-recovery receipt effect is atomic and at-most-once', () => {
  it('replays a crash after preparation into one receipt, one audit, and one fresh successor', async () => {
    const dir = await project();
    const paths = runtimePaths(dir);
    const started = await startRun(dir, startInput());
    const source = started.run.tickets[0];
    const payload = additiveCapabilityReceipt(source);
    const baselineTickets = await readdir(paths.tickets);

    await recordAtCrashPoint(
      dir,
      ({ file, value }) =>
        file.startsWith(`${paths.receiptTransactions}${path.sep}`) &&
        value?.status === 'prepared' &&
        value?.ticket_id === source.ticket_id,
      payload,
    );

    const prepared = (await readdir(paths.receiptTransactions)).filter((name) => name.endsWith('.json'));
    expect(prepared).toHaveLength(1);
    expect((await readJson(path.join(paths.receiptTransactions, prepared[0]))).status)
      .toBe('prepared');

    const retry = await recordReceipt(dir, payload);
    expect(retry.ok, JSON.stringify(retry.errors ?? [])).toBe(true);
    const active = await readJson(paths.active);
    const successors = active.tickets.filter((ticket) => ticket.ticket_id !== source.ticket_id);
    expect(successors).toHaveLength(1);
    expect(successors[0]).toMatchObject({
      stage_id: source.stage_id,
      role: source.role,
      attempt: source.attempt,
      ticket_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(active.receipts.filter((entry) => entry.ticket_id === source.ticket_id)).toHaveLength(1);
    expect((await readdir(paths.tickets)).length).toBe(baselineTickets.length + 1);
    const auditLines = (await readFile(paths.overrideLog, 'utf8')).trim().split('\n');
    expect(auditLines.map((line) => JSON.parse(line)).filter(
      (entry) => /capability/.test(entry.operation ?? ''),
    )).toHaveLength(1);
  }, 30_000);

  it('adopts the one compatible durable successor after a crash instead of regenerating it', async () => {
    const dir = await project();
    const paths = runtimePaths(dir);
    const started = await startRun(dir, startInput());
    const source = started.run.tickets[0];
    const payload = additiveCapabilityReceipt(source);
    const baselineTicketFiles = new Set(await readdir(paths.tickets));

    await recordAtCrashPoint(
      dir,
      ({ file, value }) =>
        file.startsWith(`${paths.tickets}${path.sep}`) &&
        value?.run_id === source.run_id &&
        value?.ticket_id !== source.ticket_id &&
        value?.stage_id === source.stage_id,
      payload,
    );

    const orphanFiles = (await readdir(paths.tickets)).filter((name) => !baselineTicketFiles.has(name));
    expect(orphanFiles).toHaveLength(1);
    const orphanPath = path.join(paths.tickets, orphanFiles[0]);
    const orphanBytes = await readFile(orphanPath);
    const orphan = await readJson(orphanPath);

    const retry = await recordReceipt(dir, payload);
    expect(retry.ok, JSON.stringify(retry.errors ?? [])).toBe(true);
    const active = await readJson(paths.active);
    expect(active.tickets.filter((ticket) => ticket.ticket_id === orphan.ticket_id))
      .toEqual([expect.objectContaining({ ticket_hash: orphan.ticket_hash })]);
    expect(active.tickets.filter((ticket) => ticket.ticket_id !== source.ticket_id)).toHaveLength(1);
    expect(await readFile(orphanPath)).toEqual(orphanBytes);
    expect((await readdir(paths.tickets)).filter((name) => !baselineTicketFiles.has(name)))
      .toEqual(orphanFiles);
  }, 30_000);

  it('fails closed on forged competing successor evidence before mutating the prepared effect', async () => {
    const dir = await project();
    const paths = runtimePaths(dir);
    const started = await startRun(dir, startInput());
    const source = started.run.tickets[0];
    const payload = additiveCapabilityReceipt(source);
    const baselineTicketFiles = new Set(await readdir(paths.tickets));

    await recordAtCrashPoint(
      dir,
      ({ file, value }) =>
        file.startsWith(`${paths.tickets}${path.sep}`) &&
        value?.ticket_id !== source.ticket_id &&
        value?.stage_id === source.stage_id,
      payload,
    );
    const orphanFiles = (await readdir(paths.tickets)).filter((name) => !baselineTicketFiles.has(name));
    expect(orphanFiles).toHaveLength(1);
    const orphanPath = path.join(paths.tickets, orphanFiles[0]);
    const orphan = await readJson(orphanPath);
    const forgedPath = path.join(paths.tickets, 'forged-competing-successor.json');
    await atomicWriteJson(forgedPath, {
      ...orphan,
      ticket_id: `${source.run_id}:${source.stage_id}:forged-successor`,
      ticket_hash: 'f'.repeat(64),
      claimed_paths: ['src/path-rebound.js'],
    });

    const before = {
      active: await readFile(paths.active),
      transaction: await Promise.all((await readdir(paths.receiptTransactions)).map(
        (name) => readFile(path.join(paths.receiptTransactions, name)),
      )),
      tickets: await Promise.all((await readdir(paths.tickets)).sort().map(
        (name) => readFile(path.join(paths.tickets, name)),
      )),
      names: (await readdir(paths.tickets)).sort(),
    };
    const rejected = await recordReceipt(dir, payload);
    expect(rejected).toMatchObject({ ok: false });
    expect(JSON.stringify(rejected)).toMatch(/successor|forg|incompatible|ambiguous|hash/i);
    expect(await readFile(paths.active)).toEqual(before.active);
    expect(await Promise.all((await readdir(paths.receiptTransactions)).map(
      (name) => readFile(path.join(paths.receiptTransactions, name)),
    ))).toEqual(before.transaction);
    expect((await readdir(paths.tickets)).sort()).toEqual(before.names);
    expect(await Promise.all((await readdir(paths.tickets)).sort().map(
      (name) => readFile(path.join(paths.tickets, name)),
    ))).toEqual(before.tickets);
    await expect(readFile(paths.overrideLog, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  }, 30_000);

  it('rejects a self-consistent orphan whose ticket identity is rebound to an escaping path', async () => {
    const dir = await project();
    const paths = runtimePaths(dir);
    const started = await startRun(dir, startInput());
    const source = started.run.tickets[0];
    const payload = additiveCapabilityReceipt(source);
    const baselineTicketFiles = new Set(await readdir(paths.tickets));

    await recordAtCrashPoint(
      dir,
      ({ file, value, kind }) =>
        kind === 'atomic' &&
        file.startsWith(`${paths.tickets}${path.sep}`) &&
        value?.ticket_id !== source.ticket_id &&
        value?.stage_id === source.stage_id,
      payload,
    );

    const orphanFiles = (await readdir(paths.tickets)).filter(
      (name) => !baselineTicketFiles.has(name),
    );
    expect(orphanFiles).toHaveLength(1);
    const orphanPath = path.join(paths.tickets, orphanFiles[0]);
    const reboundId = '../../capability-recovery-escape';
    const rebound = ticketWithReboundIdentity(await readJson(orphanPath), reboundId);
    await atomicWriteJson(orphanPath, rebound);
    const escapePath = path.join(
      paths.tickets,
      `${reboundId.replaceAll(':', '_')}.json`,
    );
    await expect(readFile(escapePath)).rejects.toMatchObject({ code: 'ENOENT' });

    const before = {
      active: await readFile(paths.active),
      transaction: await Promise.all((await readdir(paths.receiptTransactions)).map(
        (name) => readFile(path.join(paths.receiptTransactions, name)),
      )),
      orphan: await readFile(orphanPath),
    };
    const rejected = await rejectedRecord(dir, payload);
    expect(rejected).toMatchObject({ ok: false });
    expect(JSON.stringify(rejected)).toMatch(/successor|ticket|identity|filename|path|schema/i);
    expect(await readFile(paths.active)).toEqual(before.active);
    expect(await Promise.all((await readdir(paths.receiptTransactions)).map(
      (name) => readFile(path.join(paths.receiptTransactions, name)),
    ))).toEqual(before.transaction);
    expect(await readFile(orphanPath)).toEqual(before.orphan);
    await expect(readFile(escapePath)).rejects.toMatchObject({ code: 'ENOENT' });
  }, 30_000);

  it('rejects a self-hashed prepared effect that widens authority or invents merge consent', async () => {
    const dir = await project();
    const paths = runtimePaths(dir);
    const started = await startRun(dir, startInput());
    const source = started.run.tickets[0];
    const payload = additiveCapabilityReceipt(source);
    const predecessor = await readJson(paths.active);

    const recorded = await recordReceipt(dir, payload);
    expect(recorded.ok, JSON.stringify(recorded.errors ?? [])).toBe(true);
    const transactionNames = (await readdir(paths.receiptTransactions)).filter(
      (name) => name.endsWith('.json'),
    );
    expect(transactionNames).toHaveLength(1);
    const transactionPath = path.join(paths.receiptTransactions, transactionNames[0]);
    const transaction = await readJson(transactionPath);
    expect(transaction).toMatchObject({ status: 'committed' });
    expect(transaction.prepared_effect).toBeTruthy();

    const forgedState = structuredClone(transaction.prepared_effect.active_state);
    forgedState.claimed_paths = [...forgedState.claimed_paths, 'src/forged-authority.js'];
    forgedState.auto_merge_authorized = true;
    forgedState.attempts = { ...forgedState.attempts, forged: 99 };
    const forgedTransaction = structuredClone(transaction);
    forgedTransaction.status = 'prepared';
    delete forgedTransaction.committed_at;
    forgedTransaction.pre_state_hash = sha256(predecessor);
    forgedTransaction.prepared_effect.active_state = forgedState;
    forgedTransaction.prepared_effect.active_state_hash = sha256(forgedState);

    const runFile = path.join(paths.runs, `${started.run.run_id}.json`);
    await atomicWriteJson(paths.active, predecessor);
    await atomicWriteJson(runFile, predecessor);
    await atomicWriteJson(transactionPath, forgedTransaction);
    const before = {
      active: await readFile(paths.active),
      run: await readFile(runFile),
      transaction: await readFile(transactionPath),
    };

    const rejected = await rejectedRecord(dir, payload);
    expect(rejected).toMatchObject({ ok: false });
    expect(JSON.stringify(rejected)).toMatch(/prepared|effect|binding|authority|state|hash|consent/i);
    expect(await readFile(paths.active)).toEqual(before.active);
    expect(await readFile(runFile)).toEqual(before.run);
    expect(await readFile(transactionPath)).toEqual(before.transaction);
  }, 30_000);

  it('does not duplicate the capability audit after a crash immediately after append', async () => {
    const dir = await project();
    const paths = runtimePaths(dir);
    const started = await startRun(dir, startInput());
    const source = started.run.tickets[0];
    const payload = additiveCapabilityReceipt(source);

    await recordAtCrashPoint(
      dir,
      ({ file, value, kind }) =>
        kind === 'append' &&
        file === paths.overrideLog &&
        /capability/.test(value?.operation ?? ''),
      payload,
    );

    const auditAfterCrash = (await readFile(paths.overrideLog, 'utf8'))
      .trim().split('\n').map((line) => JSON.parse(line))
      .filter((entry) => /capability/.test(entry.operation ?? ''));
    expect(auditAfterCrash).toHaveLength(1);

    const retry = await recordReceipt(dir, payload);
    expect(retry.ok, JSON.stringify(retry.errors ?? [])).toBe(true);
    const auditAfterRetry = (await readFile(paths.overrideLog, 'utf8'))
      .trim().split('\n').map((line) => JSON.parse(line))
      .filter((entry) => /capability/.test(entry.operation ?? ''));
    expect(auditAfterRetry).toEqual(auditAfterCrash);
    const active = await readJson(paths.active);
    expect(active.test_paths).toContain('tests/recovered.test.js');
    expect(active.receipts.filter((entry) => entry.ticket_id === source.ticket_id)).toHaveLength(1);
    expect(active.tickets.filter((ticket) => ticket.ticket_id !== source.ticket_id)).toHaveLength(1);
  }, 30_000);

  it('preserves the byte-identical active snapshot, including updated_at, after an active-persist crash', async () => {
    const dir = await project();
    const paths = runtimePaths(dir);
    const started = await startRun(dir, startInput());
    const source = started.run.tickets[0];
    const payload = additiveCapabilityReceipt(source);

    await recordAtCrashPoint(
      dir,
      ({ file, value }) =>
        file === paths.active &&
        value?.test_paths?.includes('tests/recovered.test.js') &&
        value?.receipts?.some((entry) => entry.ticket_id === source.ticket_id) &&
        value?.tickets?.some((ticket) =>
          ticket.ticket_id !== source.ticket_id && ticket.stage_id === source.stage_id),
      payload,
    );

    const activeBytes = await readFile(paths.active);
    const durable = await readJson(paths.active);
    const successor = durable.tickets.find((ticket) =>
      ticket.ticket_id !== source.ticket_id && ticket.stage_id === source.stage_id);
    expect(successor).toBeTruthy();
    const successorPath = path.join(
      paths.tickets,
      `${successor.ticket_id.replaceAll(':', '_')}.json`,
    );
    const successorBytes = await readFile(successorPath);

    const retry = await recordReceipt(dir, payload);
    expect(retry.ok, JSON.stringify(retry.errors ?? [])).toBe(true);
    expect(await readFile(paths.active)).toEqual(activeBytes);
    expect(await readFile(successorPath)).toEqual(successorBytes);
    const replayed = await readJson(paths.active);
    expect(replayed.updated_at).toBe(durable.updated_at);
    expect(replayed.tickets.filter((ticket) => ticket.ticket_id === successor.ticket_id))
      .toHaveLength(1);
    expect(replayed.receipts.filter((entry) => entry.ticket_id === source.ticket_id))
      .toHaveLength(1);
  }, 30_000);
});
