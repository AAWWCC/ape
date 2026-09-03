import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { recordReceipt, startRun, statusRun } from '../lib/runtime/service.js';
import { evaluateLifecyclePolicy, evaluateTreePolicy } from '../lib/runtime/hooks.js';
import { AUTO_MERGE_HOLD_REASON } from '../lib/runtime/constants.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { atomicWriteJson } from '../lib/runtime/storage.js';

// D3 — audited scope expansion and late-armed security review, driven through
// the public service surface:
// 1. A blocking review may name out-of-claims paths the fix needs
//    (evidence.scope_expansion); the runtime audits the expansion to
//    overrides.ndjson, re-classifies lane/risk over the grown scope, and the
//    remediation ticket inherits the expanded allowlist — so the write-time
//    hook and drift guard admit the fix and the run converges to gates
//    instead of remediation being unfixable by design (friction log #1/#2).
// 2. Malformed or out-of-contract proposals reject the receipt loudly, never
//    silently drop paths, and leave no durable side effect.
// 3. A risk trigger arriving after the last pipeline scheduling point (the
//    final agreeing review receipt, or a mechanical build receipt) issues the
//    armed security review instead of running gates whose conditional_audits
//    check could never be satisfied.

const cleanups = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

// CJS on purpose: the scratch project has no package.json, so .js files run
// as CommonJS under the configured `node tests/value.test.js` targeted
// command (red-test observation and the targeted merge gate execute it).
const VALUE_V1 = 'module.exports = { value: 1 };\n';
const VALUE_V2 = 'module.exports = { value: 2 };\n';
const AUTHORED_TEST =
  "const { value } = require('../src/value.js');\n" +
  "if (value !== 2) { throw new Error('red: value is ' + value); }\n";

async function project(config = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-scope-expansion-'));
  cleanups.push(dir);
  await mkdir(path.join(dir, 'src'));
  await mkdir(path.join(dir, 'tests'));
  await mkdir(path.join(dir, 'docs'));
  await writeFile(path.join(dir, 'src', 'value.js'), VALUE_V1);
  await writeFile(path.join(dir, 'tests', 'value.test.js'), 'throw new Error("placeholder");\n');
  await writeFile(path.join(dir, 'docs', 'notes.md'), '# Notes\n');
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
    ...config,
  });
  return dir;
}

// Mechanical projects must not configure test_commands.targeted: the merge
// gates execute a configured targeted command on every lane, and the docs-only
// scope leaves the behavioral fixture test red.
function mechanicalConfig() {
  return { test_commands: { full: 'node -e "process.exit(0)"' } };
}

function startInput(overrides = {}) {
  return {
    objective: 'Exercise audited scope expansion',
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

// Drive a fast-lane run to its review stage: authored red test, green build.
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
  return { buildTicket, reviewTicket };
}

async function scopeExpansionAuditLines(dir) {
  const raw = await readFile(runtimePaths(dir).overrideLog, 'utf8').catch(() => '');
  return raw
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((line) => line.operation === 'scope-expansion');
}

async function capabilityRecoveryAuditLines(dir) {
  const raw = await readFile(runtimePaths(dir).overrideLog, 'utf8').catch(() => '');
  return raw
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((line) => /capability/.test(line.operation ?? ''));
}

function blockingExpansion(paths, reason = 'the fix requires these modules') {
  return {
    verdict: 'fail',
    scope_expansion: { claimed_paths: paths, reason },
  };
}

function productionScopeFinding(file = 'lib/helper.js') {
  return {
    file,
    line: 1,
    title: 'expand production scope',
    detail: 'the fix requires this production module',
    blocking: true,
    remediation: { owner: 'production' },
  };
}

describe('out-of-claims review finding expands remediation (D3)', () => {
  it('audits the expansion, the remediation ticket inherits it, the drift guard admits it, and the run converges to green gates', async () => {
    const dir = await project();
    const { buildTicket, reviewTicket } = await walkToReview(dir);

    // Contrast pin: before the expansion, the write-time hook denies the
    // out-of-claims path under the build ticket.
    const denied = evaluateLifecyclePolicy(
      { host: 'claude', is_subagent: true, ape_managed: true, event: 'PreToolUse', tool_name: 'Edit', file: 'lib/helper.js' },
      { state: { status: 'running' }, ticket: buildTicket },
    );
    expect(denied.decision).toBe('deny');

    const reviewed = await recordReceipt(dir, receipt(reviewTicket, {
      tests: greenTest,
      findings: [productionScopeFinding()],
      evidence: blockingExpansion(['lib/helper.js']),
    }));
    expect(reviewed.ok).toBe(true);
    // The persisted run scope grew and the single remediation cycle opened.
    expect(reviewed.run.claimed_paths).toEqual(['src/value.js', 'lib/helper.js']);
    expect(reviewed.run.remediation_cycles).toBe(1);
    const remediation = reviewed.run.tickets.at(-1);
    expect(remediation.stage_id).toBe('remediation-build');
    expect(remediation.claimed_paths).toEqual(['src/value.js', 'lib/helper.js']);

    // The audit record carries the operation, the reviewer's reason, and the
    // exact added paths.
    const audits = await scopeExpansionAuditLines(dir);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      operation: 'scope-expansion',
      reason: 'the fix requires these modules',
      added_paths: ['lib/helper.js'],
      run_id: reviewed.run.run_id,
    });

    // Drift-guard acceptance: the write-time hook and the tree-drift policy
    // both admit the expanded path under the remediation ticket.
    const write = evaluateLifecyclePolicy(
      { host: 'claude', is_subagent: true, ape_managed: true, event: 'PreToolUse', tool_name: 'Edit', file: 'lib/helper.js' },
      { state: { status: 'running' }, ticket: remediation },
    );
    expect(write.decision).toBe('allow');
    const tree = evaluateTreePolicy(
      { is_subagent: true, event: 'SubagentStop' },
      { state: { status: 'running' }, ticket: remediation },
      ['lib/helper.js'],
    );
    expect(tree.decision).toBe('allow');

    // Remediation writes the expanded path and is admitted.
    await mkdir(path.join(dir, 'lib'), { recursive: true });
    await writeFile(path.join(dir, 'lib', 'helper.js'), 'module.exports = { helper: true };\n');
    const remediated = await recordReceipt(dir, receipt(remediation, { tests: greenTest }));
    expect(remediated.ok).toBe(true);
    expect(remediated.receipt.changed_files).toContain('lib/helper.js');
    const remediationReview = remediated.run.tickets.at(-1);
    expect(remediationReview.stage_id).toBe('remediation-review');

    // The agreeing remediation review reaches green gates: the expanded-path
    // write passes clean_tree and tree binding, so the run holds at the
    // disabled auto-merge instead of wedging anywhere earlier.
    const agreed = await recordReceipt(dir, receipt(remediationReview, { tests: greenTest }));
    expect(agreed.ok).toBe(true);
    expect(agreed.actions.some((action) => action.type === 'gates')).toBe(true);
    expect(agreed.run.gates.passed).toBe(true);
    expect(agreed.run.status).toBe('blocked');
    expect(agreed.run.block_reason).toBe(AUTO_MERGE_HOLD_REASON);
  }, 30_000);
});

describe('malformed or out-of-contract proposals reject loudly (D3)', () => {
  it('names the offending path or field, leaves no audit line, and keeps the ticket recordable', async () => {
    const dir = await project();
    const { reviewTicket } = await walkToReview(dir);

    const attempts = [
      [blockingExpansion(['../outside.js']), /may not contain '\.\.' segments: \.\.\/outside\.js/],
      [blockingExpansion(['/etc/passwd']), /relative to the project root: \/etc\/passwd/],
      [blockingExpansion(['C:\\evil.js']), /relative to the project root: C:\\evil\.js/],
      [blockingExpansion(['.ape/runtime/hack.json']), /may not claim APE runtime state/],
      [blockingExpansion(['tests/other.test.js']), /test-shaped path/],
      [blockingExpansion([]), /non-empty array of project-relative paths/],
      [{ verdict: 'fail', scope_expansion: { claimed_paths: 'lib/helper.js', reason: 'r' } }, /non-empty array/],
      [{ verdict: 'fail', scope_expansion: { claimed_paths: ['lib/helper.js'] } }, /scope_expansion\.reason/],
      [{ verdict: 'fail', scope_expansion: 'lib/helper.js' }, /must be an object/],
    ];
    for (const [evidence, expected] of attempts) {
      const rejected = await recordReceipt(dir, receipt(reviewTicket, {
        tests: greenTest,
        findings: [productionScopeFinding()],
        evidence,
      }));
      expect(rejected.ok, JSON.stringify(evidence)).toBe(false);
      expect(rejected.rejected).toBe(true);
      expect(rejected.errors.some((error) => expected.test(error)), rejected.errors.join('; ')).toBe(true);
    }
    // No durable side effect: claims unchanged, nothing audited.
    expect((await statusRun(dir)).run.claimed_paths).toEqual(['src/value.js']);
    expect(await scopeExpansionAuditLines(dir)).toHaveLength(0);

    // The same ticket still records a corrected proposal.
    const accepted = await recordReceipt(dir, receipt(reviewTicket, {
      tests: greenTest,
      findings: [productionScopeFinding()],
      evidence: blockingExpansion(['lib/helper.js'], 'corrected proposal'),
    }));
    expect(accepted.ok).toBe(true);
    expect(accepted.run.claimed_paths).toEqual(['src/value.js', 'lib/helper.js']);
    expect(await scopeExpansionAuditLines(dir)).toHaveLength(1);
  }, 30_000);

  it('rejects a scope expansion on an agreeing review, which then records cleanly without it', async () => {
    const dir = await project();
    const { reviewTicket } = await walkToReview(dir);

    const rejected = await recordReceipt(dir, receipt(reviewTicket, {
      tests: greenTest,
      evidence: { verdict: 'pass', scope_expansion: { claimed_paths: ['lib/helper.js'], reason: 'nice to have' } },
    }));
    expect(rejected.ok).toBe(false);
    expect(rejected.errors.some((error) => /blocking review verdict/.test(error))).toBe(true);
    expect(await scopeExpansionAuditLines(dir)).toHaveLength(0);

    // The rejection left no debris: the plain agreeing receipt records and
    // the run proceeds to gates.
    const agreed = await recordReceipt(dir, receipt(reviewTicket, { tests: greenTest }));
    expect(agreed.ok).toBe(true);
    expect(agreed.actions.some((action) => action.type === 'gates')).toBe(true);
  }, 30_000);

  it('rejects the channel from a non-review role', async () => {
    const dir = await project();
    const started = await startRun(dir, startInput());
    const testTicket = started.run.tickets[0];
    await writeFile(path.join(dir, 'tests', 'value.test.js'), AUTHORED_TEST);
    const tested = await recordReceipt(dir, receipt(testTicket, { tests: redTest }));
    const buildTicket = tested.run.tickets.at(-1);
    expect(buildTicket.role).toBe('implementer');

    await writeFile(path.join(dir, 'src', 'value.js'), VALUE_V2);
    const rejected = await recordReceipt(dir, receipt(buildTicket, {
      tests: greenTest,
      evidence: { scope_expansion: { claimed_paths: ['lib/helper.js'], reason: 'builder wants more' } },
    }));
    expect(rejected.ok).toBe(false);
    expect(rejected.errors.some((error) => /review-receipt channel/.test(error))).toBe(true);
    expect(await scopeExpansionAuditLines(dir)).toHaveLength(0);

    const clean = await recordReceipt(dir, receipt(buildTicket, { tests: greenTest }));
    expect(clean.ok).toBe(true);
    expect((await statusRun(dir)).run.claimed_paths).toEqual(['src/value.js']);
  }, 30_000);
});

describe('automatic additive capability recovery', () => {
  it('audits a separated test-path addition and issues one fresh ticket without spending the logical attempt', async () => {
    const dir = await project();
    const started = await startRun(dir, startInput());
    expect(started.ok).toBe(true);
    const source = started.run.tickets[0];
    expect(source).toMatchObject({ stage_id: 'test', role: 'test_writer', attempt: 1 });
    const attemptsBefore = structuredClone(started.run.attempts);
    const payload = receipt(source, {
      status: 'failed',
      evidence: {
        failure_kind: 'capability',
        summary: 'the red suite also needs one repository-local test file',
        required_claims: { test_paths: ['tests/recovered.test.js'] },
        risk_triggers: ['security'],
      },
    });

    const recovered = await recordReceipt(dir, payload);
    expect(recovered.ok, JSON.stringify(recovered.errors ?? [])).toBe(true);
    expect(recovered.run).toMatchObject({
      run_id: started.run.run_id,
      status: 'running',
      stage: 'test',
      lane: 'full',
      high_risk: true,
      risk_triggers: ['security'],
      attempts: attemptsBefore,
      remediation_cycles: 0,
    });
    expect(recovered.run.claimed_paths).toEqual(['src/value.js']);
    expect(recovered.run.test_paths).toEqual([
      'tests/value.test.js',
      'tests/recovered.test.js',
    ]);
    expect(recovered.run.receipts.filter((entry) => entry.ticket_id === source.ticket_id))
      .toEqual([expect.objectContaining({ evidence: payload.evidence })]);

    const successor = recovered.run.tickets.at(-1);
    expect(successor.ticket_id).not.toBe(source.ticket_id);
    expect(successor).toMatchObject({
      run_id: source.run_id,
      stage_id: source.stage_id,
      role: source.role,
      attempt: source.attempt,
      claimed_paths: ['src/value.js'],
      test_paths: ['tests/value.test.js', 'tests/recovered.test.js'],
      prior_attempts: [expect.stringMatching(/red suite.*repository-local test file/i)],
      ticket_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(successor.ticket_hash).not.toBe(source.ticket_hash);
    expect(successor.retry_of).toBeUndefined();
    expect(successor.capability_manifest.field_bounds)
      .toEqual(source.capability_manifest.field_bounds);
    expect(recovered.actions.find((entry) =>
      entry.type === 'dispatch_agent' && entry.ticket?.ticket_id === successor.ticket_id,
    )).toMatchObject({
      recovery_kind: expect.stringMatching(/capability/i),
      source_ticket_id: source.ticket_id,
    });

    const audits = await capabilityRecoveryAuditLines(dir);
    expect(audits).toEqual([expect.objectContaining({
      run_id: started.run.run_id,
      source_ticket_id: source.ticket_id,
      added_claimed_paths: [],
      added_test_paths: ['tests/recovered.test.js'],
    })]);
  }, 30_000);

  it.each([
    ['already authorized', { test_paths: ['tests/value.test.js'] }],
    ['production path in the test channel', { test_paths: ['src/helper.js'] }],
    ['test path in the production channel', { claimed_paths: ['tests/helper.test.js'] }],
    ['absolute path', { test_paths: ['/tmp/helper.test.js'] }],
    ['parent traversal', { test_paths: ['tests/../outside.test.js'] }],
    ['empty claims', {}],
    ['project root', { claimed_paths: ['.'] }],
    ['unsafe separator', { test_paths: ['tests//helper.test.js'] }],
    ['runtime state', { test_paths: ['.ape/runtime/private.test.js'] }],
    ['private file', { claimed_paths: ['.env'] }],
    ['package-manager execution config', { claimed_paths: ['.npmrc'] }],
    ['private SSH key', { claimed_paths: ['.ssh/id_rsa'] }],
    ['Codex execution config', { claimed_paths: ['.codex/config.toml'] }],
    ['Claude execution config', { claimed_paths: ['.claude/settings.json'] }],
    ['shell startup config', { claimed_paths: ['.zshrc'] }],
    ['protected git state', { claimed_paths: ['.git/config'] }],
    ['external resource', { claimed_paths: ['https://example.test/module.js'] }],
    ['wildcard scope', { test_paths: ['tests/**/*.test.js'] }],
    ['conflicting role', { required_role: 'implementer' }],
  ])('refuses %s atomically before receipt, audit, scope, consent, or ticket mutation', async (
    _label,
    requiredClaims,
  ) => {
    const dir = await project();
    const started = await startRun(dir, startInput({ auto_merge_authorized: true }));
    const source = started.run.tickets[0];
    const paths = runtimePaths(dir);
    const before = await readFile(paths.active);
    const rejected = await recordReceipt(dir, receipt(source, {
      status: 'failed',
      evidence: {
        failure_kind: 'capability',
        summary: `refuse ${_label}`,
        required_claims: requiredClaims,
      },
    }));

    expect(rejected).toMatchObject({ ok: false, rejected: true });
    expect(rejected.errors.join(' ')).toMatch(/claim|path|role|additive|authorized|safe|scope/i);
    expect(await readFile(paths.active)).toEqual(before);
    expect(await capabilityRecoveryAuditLines(dir)).toEqual([]);
    const after = await statusRun(dir);
    expect(after.run.tickets).toHaveLength(1);
    expect(after.run.receipts).toHaveLength(0);
    expect(after.run.auto_merge_authorized).toBe(started.run.auto_merge_authorized);
  }, 30_000);

  it('blocks a second additive request without ticket churn or budget reset', async () => {
    const dir = await project();
    const started = await startRun(dir, startInput());
    const source = started.run.tickets[0];
    const first = await recordReceipt(dir, receipt(source, {
      status: 'failed',
      evidence: {
        failure_kind: 'capability',
        summary: 'first bounded addition',
        required_claims: { test_paths: ['tests/first.test.js'] },
      },
    }));
    expect(first.ok, JSON.stringify(first.errors ?? [])).toBe(true);
    const successor = first.run.tickets.at(-1);
    const ticketCount = first.run.tickets.length;
    const attempts = structuredClone(first.run.attempts);

    const second = await recordReceipt(dir, receipt(successor, {
      status: 'failed',
      evidence: {
        failure_kind: 'capability',
        summary: 'second addition must not create an unbounded chain',
        required_claims: { test_paths: ['tests/second.test.js'] },
      },
    }));
    expect(second.ok).toBe(true);
    expect(second.run).toMatchObject({
      status: 'blocked',
      stage: 'test',
      attempts,
    });
    expect(second.run.tickets).toHaveLength(ticketCount);
    expect(second.run.test_paths).toEqual([
      'tests/value.test.js',
      'tests/first.test.js',
    ]);
    expect(await capabilityRecoveryAuditLines(dir)).toHaveLength(1);
  }, 30_000);

  it('rejects an aggregate test-scope overflow before writing any part of the expansion', async () => {
    const dir = await project();
    const started = await startRun(dir, startInput());
    const source = started.run.tickets[0];
    const paths = runtimePaths(dir);
    const before = await readFile(paths.active);
    const additions = Array.from(
      { length: 64 },
      (_, index) => `tests/generated-${String(index).padStart(2, '0')}.test.js`,
    );

    const rejected = await recordReceipt(dir, receipt(source, {
      status: 'failed',
      evidence: {
        failure_kind: 'capability',
        summary: 'the union would exceed the run-wide test-path ceiling',
        required_claims: { test_paths: additions },
      },
    }));
    expect(rejected).toMatchObject({ ok: false, rejected: true });
    expect(rejected.errors.join(' ')).toMatch(/64|limit|bound|aggregate|test_paths/i);
    expect(await readFile(paths.active)).toEqual(before);
    expect(await capabilityRecoveryAuditLines(dir)).toEqual([]);
  }, 30_000);
});

describe('declared trigger on a mechanical scope arms the security review (D3)', () => {
  it('keeps the mechanical lane, persists the trigger, and schedules security-review before gates', async () => {
    const dir = await project(mechanicalConfig());
    const started = await startRun(dir, startInput({
      behavioral: false,
      claimed_paths: ['docs/notes.md'],
      test_paths: [],
      risk_triggers: ['security'],
    }));
    expect(started.ok).toBe(true);
    expect(started.run.lane).toBe('mechanical');
    expect(started.run.high_risk).toBe(true);
    expect(started.run.risk_triggers).toEqual(['security']);
    expect(started.run.lane_reasons).toContain('risk:security');
    const build = started.run.tickets[0];
    expect(build.role).toBe('implementer');

    await writeFile(path.join(dir, 'docs', 'notes.md'), '# Notes\n\nUpdated.\n');
    const built = await recordReceipt(dir, receipt(build));
    expect(built.ok).toBe(true);
    // The armed conditional audit must get its schedulable path: the build
    // receipt issues the security review instead of entering the gates it
    // could only fail.
    expect(built.actions.some((action) => action.type === 'gates')).toBe(false);
    const security = built.run.tickets.at(-1);
    expect(security.stage_id).toBe('security-review');
    expect(security.role).toBe('security_reviewer');
    expect(security.writable).toBe(false);

    const passed = await recordReceipt(dir, receipt(security));
    expect(passed.ok).toBe(true);
    expect(passed.actions.some((action) => action.type === 'gates')).toBe(true);
    expect(passed.run.gates.checks.conditional_audits).toEqual({ passed: true, required: true });
    expect(passed.run.gates.passed).toBe(true);
    expect(passed.run.block_reason).toBe(AUTO_MERGE_HOLD_REASON);
  }, 30_000);
});

describe('late risk triggers converge instead of wedging (D3/F8)', () => {
  it('a trigger on the final agreeing review issues security-review, then gates pass with the audit satisfied', async () => {
    const dir = await project();
    const { reviewTicket } = await walkToReview(dir);

    const reviewed = await recordReceipt(dir, receipt(reviewTicket, {
      tests: greenTest,
      evidence: { verdict: 'pass', risk_triggers: ['Security'] },
    }));
    expect(reviewed.ok).toBe(true);
    expect(reviewed.run.high_risk).toBe(true);
    expect(reviewed.run.risk_triggers).toEqual(['security']);
    // No gates yet: the armed security review must produce its receipt first.
    expect(reviewed.actions.some((action) => action.type === 'gates')).toBe(false);
    const security = reviewed.run.tickets.at(-1);
    expect(security.stage_id).toBe('security-review');

    const passed = await recordReceipt(dir, receipt(security));
    expect(passed.ok).toBe(true);
    expect(passed.actions.some((action) => action.type === 'gates')).toBe(true);
    expect(passed.run.gates.checks.conditional_audits).toEqual({ passed: true, required: true });
    expect(passed.run.gates.passed).toBe(true);
    expect(passed.run.status).toBe('blocked');
    expect(passed.run.block_reason).toBe(AUTO_MERGE_HOLD_REASON);
  }, 30_000);

  it('a trigger on the agreeing land review issues the read-only security-review, not the no-writing-stage block', async () => {
    const dir = await project({
      test_commands: { full: 'node -e "process.exit(0)"', targeted: 'node -e "process.exit(0)"' },
    });
    // Mode land requires the finished diff to be dirty at start.
    await writeFile(path.join(dir, 'src', 'value.js'), VALUE_V2);
    const started = await startRun(dir, startInput({ mode: 'land', test_paths: [] }));
    expect(started.ok).toBe(true);
    expect(started.run.tickets.map((ticket) => ticket.stage_id)).toEqual(['review']);
    const review = started.run.tickets[0];

    const reviewed = await recordReceipt(dir, receipt(review, {
      evidence: { verdict: 'pass', risk_triggers: ['Security'] },
    }));
    expect(reviewed.ok).toBe(true);
    expect(reviewed.run.high_risk).toBe(true);
    // security_reviewer is read-only, so the land no-writing-stage guard must
    // stay silent: the run schedules the review instead of blocking or
    // running gates it could only fail.
    expect(reviewed.run.status).toBe('running');
    expect(reviewed.actions.some((action) => action.type === 'gates')).toBe(false);
    const security = reviewed.run.tickets.at(-1);
    expect(security.stage_id).toBe('security-review');
    expect(security.writable).toBe(false);

    const passed = await recordReceipt(dir, receipt(security));
    expect(passed.ok).toBe(true);
    expect(passed.actions.some((action) => action.type === 'gates')).toBe(true);
    expect(passed.run.gates.checks.conditional_audits).toEqual({ passed: true, required: true });
    expect(passed.run.gates.passed).toBe(true);
    expect(passed.run.block_reason).toBe(AUTO_MERGE_HOLD_REASON);
  }, 30_000);

  it('a trigger reported on a mechanical build receipt issues security-review instead of gates', async () => {
    const dir = await project(mechanicalConfig());
    const started = await startRun(dir, startInput({
      behavioral: false,
      claimed_paths: ['docs/notes.md'],
      test_paths: [],
    }));
    expect(started.ok).toBe(true);
    expect(started.run.lane).toBe('mechanical');
    expect(started.run.high_risk).toBe(false);
    const build = started.run.tickets[0];

    await writeFile(path.join(dir, 'docs', 'notes.md'), '# Notes\n\nRotated the deploy key doc.\n');
    const built = await recordReceipt(dir, receipt(build, {
      evidence: { risk_triggers: ['Security'] },
    }));
    expect(built.ok).toBe(true);
    expect(built.run.high_risk).toBe(true);
    expect(built.run.risk_triggers).toEqual(['security']);
    expect(built.run.lane).toBe('mechanical');
    expect(built.actions.some((action) => action.type === 'gates')).toBe(false);
    const security = built.run.tickets.at(-1);
    expect(security.stage_id).toBe('security-review');

    const passed = await recordReceipt(dir, receipt(security));
    expect(passed.ok).toBe(true);
    expect(passed.actions.some((action) => action.type === 'gates')).toBe(true);
    expect(passed.run.gates.checks.conditional_audits).toEqual({ passed: true, required: true });
    expect(passed.run.gates.passed).toBe(true);
  }, 30_000);
});
