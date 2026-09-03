import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
  return {
    ...actual,
    __crashControl: control,
    atomicWriteJson: async (file, value) => {
      await actual.atomicWriteJson(file, value);
      const arm = control.arm;
      const normalizedFile = file.replaceAll('\\', '/');
      const normalizedDirectory = arm?.directory?.replaceAll('\\', '/');
      const directChild = normalizedDirectory &&
        normalizedFile.startsWith(`${normalizedDirectory}/`) &&
        !normalizedFile.slice(normalizedDirectory.length + 1).includes('/');
      const matched = arm?.kind === 'prepared-transaction'
        ? normalizedFile.includes('/receipt-transactions/') && value?.status === 'prepared'
        : arm?.kind === 'canonical-recovery-file'
          ? directChild
          : arm &&
            file === arm.file &&
            Array.isArray(value?.receipts) &&
            value.receipts.some((entry) => entry?.ticket_id === arm.ticket_id);
      if (
        matched
      ) {
        control.arm = null;
        control.fired += 1;
        const crash = new Error(
          'simulated crash: the process died immediately after this durable write',
        );
        crash.code = 'APE_TEST_SIMULATED_CRASH';
        throw crash;
      }
    },
  };
});

vi.mock('../lib/runtime/run-contract.js', async (importOriginal) => {
  const actual = await importOriginal();
  const control = { arm: null, calls: 0 };
  return {
    ...actual,
    __runContractFault: control,
    prepareTicketRunContract: async (...args) => {
      const prepared = await actual.prepareTicketRunContract(...args);
      if (control.arm !== 'rebind-first-pointer' || !prepared) return prepared;
      control.calls += 1;
      if (control.calls !== 1) return prepared;
      return {
        ...prepared,
        pointer: {
          ...prepared.pointer,
          hash: '0'.repeat(64),
        },
      };
    },
  };
});
import { __crashControl, atomicWriteJson, readJson } from '../lib/runtime/storage.js';
import {
  nextRun,
  recordReceipt,
  startRun,
  validateReceiptForDispatch,
} from '../lib/runtime/service.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { __runContractFault, readRunContractManifest } from '../lib/runtime/run-contract.js';
import { validateTicket } from '../lib/runtime/schemas.js';
import { bindCodexDispatch } from './codex-native-test-helper.js';
import { projectRunResponse } from '../lib/runtime/projection.js';

// Real filesystem + git + spawned red-test observation; keep the honest tests
// off the default timeout, and let teardown ride out win32 EBUSY.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const cleanups = [];
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
afterEach(async () => {
  __crashControl.arm = null;
  __crashControl.fired = 0;
  __runContractFault.arm = null;
  __runContractFault.calls = 0;
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

function capabilityReceipt(ticket, capability, requiredClaims) {
  return {
    ticket_id: ticket.ticket_id,
    status: 'failed',
    tests: [],
    findings: [],
    evidence: {
      failure_kind: 'capability',
      summary: 'The immutable worker contract lacks one exact required test path.',
      required_claims: requiredClaims,
    },
    receipt_capability: capability,
  };
}

async function nativeCapabilityTicket(dir, overrides = {}) {
  const started = await startRun(dir, startInput({
    binding_protocol: 'native-v1',
    capability_contract_required: true,
    ...overrides,
  }));
  expect(started.ok).toBe(true);
  const dispatch = started.actions.find((action) => action.type === 'dispatch_agent');
  expect(dispatch).toBeTruthy();
  const capability = await bindCodexDispatch(root, dir, dispatch);
  return { started, ticket: dispatch.ticket, capability };
}

async function runtimeSnapshot(directory, relative = '') {
  const absolute = path.join(directory, relative);
  let entries;
  try {
    entries = await readdir(absolute, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw error;
  }
  const snapshot = {};
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const child = relative ? path.join(relative, entry.name) : entry.name;
    if (entry.isDirectory()) {
      Object.assign(snapshot, await runtimeSnapshot(directory, child));
    } else {
      snapshot[child] = (await readFile(path.join(directory, child))).toString('base64');
    }
  }
  return snapshot;
}

function boundedTestPath(index, bytes) {
  const prefix = `tests/${index}/`;
  const suffix = '.test.js';
  const bodyBytes = bytes - Buffer.byteLength(prefix + suffix, 'utf8');
  return `${prefix}${bodyBytes % 2 === 0 ? '' : 'x'}${'é'.repeat(Math.floor(bodyBytes / 2))}${suffix}`;
}

function testPathsAt4096Bytes() {
  const paths = [
    ...Array.from({ length: 7 }, (_, index) => boundedTestPath(index, 511)),
    boundedTestPath(7, 494),
  ];
  expect(Buffer.byteLength(JSON.stringify(paths), 'utf8')).toBe(4_096);
  return paths;
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

describe('APE v2 bounded capability-recovery publication', () => {
  it.each([
    [
      'the 65th canonical test path',
      Array.from({ length: 64 }, (_, index) => `tests/generated-${String(index).padStart(2, '0')}.test.js`),
      'tests/generated-64.test.js',
      /64|test_paths.*bound/i,
    ],
    [
      'the 4097th serialized UTF-8 byte',
      testPathsAt4096Bytes(),
      'tests/one-byte-too-many.test.js',
      /4096|test_paths.*bound/i,
    ],
    [
      'an absolute out-of-project test path',
      ['tests/value.test.js'],
      '/tmp/ape-outside.test.js',
      /canonical|contained|project.relative|outside/i,
    ],
    [
      'a parent-relative out-of-project test path',
      ['tests/value.test.js'],
      '../outside.test.js',
      /canonical|contained|project.relative|outside/i,
    ],
    [
      'a reserved runtime test path',
      ['tests/value.test.js'],
      '.ape/runtime/forged.test.js',
      /canonical|reserved|\.ape|runtime/i,
    ],
    [
      'an option-like test-runner argument',
      ['tests/value.test.js'],
      '--runInBand',
      /canonical|option|project.relative|test.path/i,
    ],
  ])('rejects %s before every persistent sink', async (
    _label,
    initialTestPaths,
    addedPath,
    expectedError,
  ) => {
    const dir = await project();
    const { ticket, capability } = await nativeCapabilityTicket(dir, {
      test_paths: initialTestPaths,
    });
    const payload = capabilityReceipt(ticket, capability, {
      test_paths: [addedPath],
    });
    const validation = await validateReceiptForDispatch(dir, payload, ticket.ticket_id);
    expect(validation).toMatchObject({
      ok: true,
      valid: false,
      attested: false,
      dynamic_test_paths: expect.objectContaining({
        max_items: 64,
        max_bytes: 4_096,
      }),
    });
    expect(validation.corrections.map((entry) => entry.issue).join(' '))
      .toMatch(expectedError);
    const paths = runtimePaths(dir);
    const before = await runtimeSnapshot(paths.runtime);

    const attempted = await recordReceipt(dir, payload);

    expect(attempted).toMatchObject({ ok: false, rejected: true });
    expect(attempted.errors.join(' ')).toMatch(expectedError);
    expect(await runtimeSnapshot(paths.runtime)).toEqual(before);
  });

  it('rejects a runtime-derived run-contract rebind before persisting the prepared transaction', async () => {
    const dir = await project();
    const { ticket, capability } = await nativeCapabilityTicket(dir);
    const payload = capabilityReceipt(ticket, capability, {
      claimed_paths: ['src/generated.js'],
    });
    const validation = await validateReceiptForDispatch(dir, payload, ticket.ticket_id);
    expect(validation).toMatchObject({ ok: true, valid: true });
    const paths = runtimePaths(dir);
    const before = await runtimeSnapshot(paths.runtime);

    // The first canonical run-contract derivation is made self-consistent but
    // false. A second derivation from durable inputs exposes the mismatch. The
    // detector must run before the prepared-transaction sink, so rejection is
    // byte-for-byte inert even though every outer hash can be recomputed.
    __runContractFault.arm = 'rebind-first-pointer';
    const attempted = await recordReceipt(dir, payload);
    __runContractFault.arm = null;

    expect(__runContractFault.calls).toBeGreaterThanOrEqual(2);
    expect(attempted).toMatchObject({ ok: false, rejected: true });
    expect(attempted.errors.join(' ')).toMatch(/run contract|runtime-derived|binding/i);
    expect(await runtimeSnapshot(paths.runtime)).toEqual(before);
  });

  it.each(['contracts', 'receipts', 'tickets'])(
    'a crash on a separately published canonical %s file exposes only an old or new complete generation',
    async (directoryKey) => {
      const dir = await project();
      const { ticket, capability } = await nativeCapabilityTicket(dir);
      const payload = capabilityReceipt(ticket, capability, {
        claimed_paths: ['src/generated.js'],
      });
      const validation = await validateReceiptForDispatch(dir, payload, ticket.ticket_id);
      expect(validation).toMatchObject({ ok: true, valid: true });
      const paths = runtimePaths(dir);
      const before = {
        active: await readJson(paths.active),
        contracts: await runtimeSnapshot(paths.contracts),
        receipts: await runtimeSnapshot(paths.receipts),
        tickets: await runtimeSnapshot(paths.tickets),
      };

      __crashControl.arm = {
        kind: 'canonical-recovery-file',
        directory: paths[directoryKey],
      };
      const outcome = await recordReceipt(dir, payload).then(
        (value) => ({ value, error: null }),
        (error) => ({ value: null, error }),
      );
      const crashed = __crashControl.fired === 1;
      __crashControl.arm = null;
      if (crashed) expect(outcome.error).toBeInstanceOf(Error);
      else expect(outcome.value).toMatchObject({ ok: true });

      const observed = await readJson(paths.active);
      const adopted = observed.receipts.some((entry) => entry.ticket_id === ticket.ticket_id);
      if (!adopted) {
        expect(observed).toEqual(before.active);
        expect(await runtimeSnapshot(paths.contracts)).toEqual(before.contracts);
        expect(await runtimeSnapshot(paths.receipts)).toEqual(before.receipts);
        expect(await runtimeSnapshot(paths.tickets)).toEqual(before.tickets);
      } else {
        const sourceReceipt = observed.receipts.find(
          (entry) => entry.ticket_id === ticket.ticket_id,
        );
        const successor = observed.tickets.find(
          (entry) => entry.ticket_id !== ticket.ticket_id,
        );
        expect(sourceReceipt).toBeTruthy();
        expect(successor).toBeTruthy();
        expect(observed.recovery_generation).toMatchObject({
          source_ticket_hash: ticket.ticket_hash,
          successor_ticket_id: successor.ticket_id,
          successor_ticket_hash: successor.ticket_hash,
        });
        expect(await readJson(
          path.join(paths.receipts, `${sourceReceipt.receipt_id}.json`),
          null,
        )).toEqual(sourceReceipt);
        expect(await readJson(
          path.join(paths.tickets, `${successor.ticket_id.replaceAll(':', '_')}.json`),
          null,
        )).toEqual(successor);
        expect(validateTicket(successor)).toMatchObject({ valid: true });
        await expect(
          readRunContractManifest(paths, successor.capability_manifest.run_contract),
        ).resolves.toBeTruthy();
      }

      const replay = await recordReceipt(dir, payload);
      expect(replay.ok).toBe(true);
      const converged = await readJson(paths.active);
      expect(converged.receipts.filter((entry) => entry.ticket_id === ticket.ticket_id))
        .toHaveLength(1);
      expect(converged.tickets.filter((entry) => entry.ticket_id !== ticket.ticket_id))
        .toHaveLength(1);
    },
  );

  it('serializes two cooperating writers into one successor contract and one generation', async () => {
    const dir = await project();
    const { ticket, capability } = await nativeCapabilityTicket(dir);
    const payload = capabilityReceipt(ticket, capability, {
      test_paths: ['tests/generated.test.js'],
    });
    const firstInvalid = await validateReceiptForDispatch(
      dir,
      { ...payload, status: 'success' },
      ticket.ticket_id,
    );
    const secondInvalid = await validateReceiptForDispatch(
      dir,
      { ...payload, unsupported_worker_field: true },
      ticket.ticket_id,
    );
    expect(firstInvalid).toMatchObject({ ok: true, valid: false });
    expect(secondInvalid).toMatchObject({ ok: true, valid: false });
    const validation = await validateReceiptForDispatch(dir, payload, ticket.ticket_id);
    expect(validation).toMatchObject({ ok: true, valid: true });

    const results = await Promise.all([
      recordReceipt(dir, payload),
      recordReceipt(dir, payload),
    ]);
    expect(results.every((result) => result.ok === true)).toBe(true);

    const active = await readJson(runtimePaths(dir).active);
    const sourceReceipts = active.receipts.filter((entry) => entry.ticket_id === ticket.ticket_id);
    const successors = active.tickets.filter((entry) => entry.ticket_id !== ticket.ticket_id);
    expect(sourceReceipts).toHaveLength(1);
    expect(successors).toHaveLength(1);
    const successorDispatches = results.flatMap((result) =>
      result.actions.filter((action) => action.type === 'dispatch_agent'));
    expect(successorDispatches.length).toBeGreaterThan(0);
    expect([...new Set(successorDispatches.map((action) => action.ticket.ticket_id))])
      .toEqual([successors[0].ticket_id]);
    expect(successorDispatches[0]).toMatchObject({
      recovery_kind: 'capability_scope_expansion',
      source_ticket_id: ticket.ticket_id,
      ticket: successors[0],
    });
    expect(projectRunResponse(
      results.find((result) => result.actions.some((action) => action.type === 'dispatch_agent')),
    ).next_action).toMatchObject({
      kind: 'capability_recovery',
      recovery_kind: 'capability_scope_expansion',
      ticket_ids: [successors[0].ticket_id],
      consumes_product_attempt: false,
    });
    expect(active.status).toBe('running');
    expect(active.test_paths).toContain('tests/generated.test.js');
    expect(successors[0]).toMatchObject({
      schema_version: ticket.schema_version,
      run_id: active.run_id,
      stage_id: ticket.stage_id,
      role: ticket.role,
      objective: ticket.objective,
      claimed_paths: ticket.claimed_paths,
      attempt: ticket.attempt,
      base_tree_sha: ticket.base_tree_sha,
      parent_hash: sourceReceipts[0].receipt_hash,
      receipt_contract_version: ticket.receipt_contract_version,
      test_paths: expect.arrayContaining(['tests/generated.test.js']),
      required_checks: ticket.required_checks,
      risk_triggers: ticket.risk_triggers,
      model_tier: ticket.model_tier,
      model: ticket.model,
      issued_at: expect.any(String),
      deadline_at: expect.any(String),
      writable: ticket.writable,
      recovery_lineage: {
        source_ticket_id: ticket.ticket_id,
        validation_submissions: 3,
        physical_workers: 1,
        validation_submissions_per_worker: 3,
        max_physical_workers: 2,
      },
      recovery_provenance: {
        authority: 'runtime',
        source_ticket_id: ticket.ticket_id,
        source_ticket_hash: ticket.ticket_hash,
        source_receipt_id: sourceReceipts[0].receipt_id,
        source_receipt_hash: sourceReceipts[0].receipt_hash,
        receipt_input_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
        source_issued_at: ticket.issued_at,
        source_deadline_at: ticket.deadline_at,
        derived_at: expect.any(String),
      },
      capability_manifest: {
        field_bounds: {
          validation_attempts_per_worker: 3,
          max_physical_workers_per_ticket: 2,
          corrections_per_validation: 20,
          dynamic_test_paths: {
            max_items: 64,
            max_serialized_utf8_bytes: 4_096,
          },
        },
        byte_budgets: ticket.capability_manifest.byte_budgets,
        run_contract: expect.any(Object),
      },
    });
    expect(validateTicket(successors[0])).toMatchObject({ valid: true });
    expect(Date.parse(successors[0].deadline_at))
      .toBeGreaterThan(Date.parse(successors[0].issued_at));
    expect(successors[0].ticket_id).toMatch(
      new RegExp(`^${active.run_id}:${ticket.stage_id}:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`),
    );
    expect(active.recovery_generation).toMatchObject({
      version: 1,
      generation: 1,
      previous: null,
      source_ticket_hash: ticket.ticket_hash,
      successor_ticket_id: successors[0].ticket_id,
      successor_ticket_hash: successors[0].ticket_hash,
      hash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(active.run_contract).toEqual(successors[0].capability_manifest.run_contract);
    const runContract = await readRunContractManifest(runtimePaths(dir), active.run_contract);
    expect(
      runContract.receipt_contract.ticket_contracts
        .filter((entry) => entry.ticket_id === successors[0].ticket_id),
    ).toHaveLength(1);

    const ticketFiles = (await readdir(runtimePaths(dir).tickets))
      .filter((entry) => entry.endsWith('.json'));
    expect(ticketFiles).toContain(`${successors[0].ticket_id.replaceAll(':', '_')}.json`);
    expect(ticketFiles.filter((entry) => entry !== `${ticket.ticket_id.replaceAll(':', '_')}.json`))
      .toHaveLength(1);
  });

  it('replays a crash after the complete prepared envelope without regenerating its successor', async () => {
    const dir = await project();
    const { ticket, capability } = await nativeCapabilityTicket(dir);
    const payload = capabilityReceipt(ticket, capability, {
      claimed_paths: ['src/generated.js'],
    });
    const validation = await validateReceiptForDispatch(dir, payload, ticket.ticket_id);
    expect(validation).toMatchObject({ ok: true, valid: true });
    const paths = runtimePaths(dir);
    const before = await readJson(paths.active);

    __crashControl.arm = { kind: 'prepared-transaction' };
    const crashed = await recordReceipt(dir, payload).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    expect(__crashControl.fired).toBe(1);
    expect(crashed.error).toBeInstanceOf(Error);
    expect(crashed.error.message).toMatch(/simulated crash/);
    expect(await readJson(paths.active)).toEqual(before);

    const transactions = await readdir(paths.receiptTransactions);
    expect(transactions).toHaveLength(1);
    const prepared = await readJson(path.join(paths.receiptTransactions, transactions[0]));
    expect(prepared).toMatchObject({
      version: 2,
      run_id: before.run_id,
      ticket_id: ticket.ticket_id,
      input_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      status: 'prepared',
      prepared_at: expect.any(String),
      receipt: expect.objectContaining({
        ticket_id: ticket.ticket_id,
        ticket_hash: ticket.ticket_hash,
        receipt_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
      prepared_effect: {
        source: {
          run_id: before.run_id,
          ticket_id: ticket.ticket_id,
          ticket_hash: ticket.ticket_hash,
          stage_id: ticket.stage_id,
          role: ticket.role,
          attempt: ticket.attempt,
        },
        scope: {
          source: {
            claimed_paths: ticket.claimed_paths,
            test_paths: ticket.test_paths,
          },
          successor: {
            claimed_paths: [...ticket.claimed_paths, 'src/generated.js'],
            test_paths: ticket.test_paths,
          },
        },
        policy: {
          role: ticket.role,
          writable: ticket.writable,
          required_checks: ticket.required_checks,
          model_tier: ticket.model_tier,
          model: ticket.model,
        },
        lane: before.lane,
        risk_triggers: before.risk_triggers,
        orchestration: expect.any(Object),
        timing: {
          source_issued_at: ticket.issued_at,
          source_deadline_at: ticket.deadline_at,
          successor_issued_at: expect.any(String),
          successor_deadline_at: expect.any(String),
          prepared_at: expect.any(String),
        },
        byte_budgets: ticket.capability_manifest.byte_budgets,
        field_bounds: ticket.capability_manifest.field_bounds,
        capability_manifest: expect.any(Object),
        run_contract: expect.any(Object),
        recovery: {
          validation_submissions: 1,
          physical_workers: 1,
        },
        successor_contract: expect.objectContaining({
          run_id: before.run_id,
          stage_id: ticket.stage_id,
          role: ticket.role,
          parent_hash: prepared.receipt.receipt_hash,
          claimed_paths: [...ticket.claimed_paths, 'src/generated.js'],
          test_paths: ticket.test_paths,
          issued_at: expect.any(String),
          deadline_at: expect.any(String),
          recovery_lineage: {
            source_ticket_id: ticket.ticket_id,
            validation_submissions: 1,
            physical_workers: 1,
            validation_submissions_per_worker: 3,
            max_physical_workers: 2,
          },
          recovery_provenance: {
            authority: 'runtime',
            source_ticket_id: ticket.ticket_id,
            source_ticket_hash: ticket.ticket_hash,
            source_receipt_id: prepared.receipt.receipt_id,
            source_receipt_hash: prepared.receipt.receipt_hash,
            receipt_input_hash: prepared.input_hash,
            source_issued_at: ticket.issued_at,
            source_deadline_at: ticket.deadline_at,
            derived_at: expect.any(String),
          },
          capability_manifest: expect.objectContaining({
            run_contract: expect.any(Object),
          }),
          ticket_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
        }),
      },
      prepared_effect_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    const preparedSuccessor = prepared.prepared_effect.successor_contract;
    expect(prepared.prepared_effect.capability_manifest)
      .toEqual(preparedSuccessor.capability_manifest);
    expect(prepared.prepared_effect.run_contract)
      .toEqual(preparedSuccessor.capability_manifest.run_contract);
    expect(prepared.prepared_effect.timing.successor_issued_at)
      .toBe(preparedSuccessor.issued_at);
    expect(prepared.prepared_effect.timing.successor_deadline_at)
      .toBe(preparedSuccessor.deadline_at);
    expect(preparedSuccessor.ticket_id).toMatch(
      new RegExp(`^${before.run_id}:${ticket.stage_id}:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`),
    );
    expect(validateTicket(preparedSuccessor)).toMatchObject({ valid: true });

    const replay = await recordReceipt(dir, payload);
    expect(replay.ok).toBe(true);
    const active = await readJson(paths.active);
    expect(active.status).toBe('running');
    expect(active.receipts.filter((entry) => entry.ticket_id === ticket.ticket_id)).toHaveLength(1);
    const successors = active.tickets.filter((entry) => entry.ticket_id !== ticket.ticket_id);
    expect(successors).toHaveLength(1);
    expect(successors[0]).toEqual(preparedSuccessor);
    expect(await readJson(
      path.join(paths.tickets, `${preparedSuccessor.ticket_id.replaceAll(':', '_')}.json`),
    )).toEqual(preparedSuccessor);

    const replayAgain = await recordReceipt(dir, payload);
    expect(replayAgain.ok).toBe(true);
    const converged = await readJson(paths.active);
    expect(converged.tickets).toEqual(active.tickets);
    expect(converged.receipts).toEqual(active.receipts);
    expect(converged.recovery_generation).toEqual(active.recovery_generation);
  });

  it('adopts the one published capability generation after response-loss instead of minting again', async () => {
    const dir = await project();
    const { ticket, capability } = await nativeCapabilityTicket(dir);
    const payload = capabilityReceipt(ticket, capability, {
      claimed_paths: ['src/recovered.js'],
    });
    const validation = await validateReceiptForDispatch(dir, payload, ticket.ticket_id);
    expect(validation).toMatchObject({ ok: true, valid: true });

    await recordWithCrash(dir, ticket.ticket_id, payload);
    const paths = runtimePaths(dir);
    const published = await readJson(paths.active);
    expect(published.receipts.filter((entry) => entry.ticket_id === ticket.ticket_id)).toHaveLength(1);

    const replay = await recordReceipt(dir, payload);
    expect(replay.ok).toBe(true);
    const adopted = await readJson(paths.active);
    const successors = adopted.tickets.filter((entry) => entry.ticket_id !== ticket.ticket_id);
    expect(adopted.status).toBe('running');
    expect(successors).toHaveLength(1);
    expect(successors[0].claimed_paths).toContain('src/recovered.js');
    expect(adopted.recovery_generation).toEqual(published.recovery_generation);

    const replayAgain = await recordReceipt(dir, payload);
    expect(replayAgain.ok).toBe(true);
    const finalState = await readJson(paths.active);
    expect(finalState.tickets).toEqual(adopted.tickets);
    expect(finalState.receipts).toEqual(adopted.receipts);
    expect(finalState.recovery_generation).toEqual(adopted.recovery_generation);
  });
});
