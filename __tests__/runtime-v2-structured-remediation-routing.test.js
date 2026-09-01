import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { reduceRun } from '../lib/runtime/scheduler.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { finalizeTicket, validateTicket } from '../lib/runtime/schemas.js';
import { recordReceipt, startRun, statusRun } from '../lib/runtime/service.js';
import { atomicWriteJson } from '../lib/runtime/storage.js';

// Public contract for roadmap requirement `structured-remediation-routing`.
// Version 1 makes blocking review findings machine-routable with
// `remediation: { owner: production|test|both, test_paths? }`. Test-owned
// findings carry an exact authorized test-path set; advisory findings carry no
// remediation. Unversioned tickets retain the legacy channel and bytes.
//
// The first independently authored RED was the absent review_contract_version
// on the public-service review ticket. Only after it repeated was the matching
// preservation-commit test hunk consulted to corroborate field and route names.

const VERSION = 1;
const cleanups = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
function finding(owner, overrides = {}) {
  const testOwned = owner === 'test' || owner === 'both';
  const file = overrides.file ?? (testOwned ? 'tests/value.test.js' : 'src/value.js');
  const line = overrides.line ?? (testOwned ? 2 : 1);
  return {
    id: overrides.id ?? `finding.${owner}.${file.replace(/[^A-Za-z0-9]+/g, '-')}.${line}`,
    file,
    line,
    title: `${owner} boundary is incorrect`,
    detail: `apply the bounded ${owner} correction`,
    blocking: true,
    remediation: {
      owner,
      ...(testOwned ? { test_paths: ['tests/value.test.js'] } : {}),
    },
    ...overrides,
  };
}

function failedReview(findings, overrides = {}) {
  return { status: 'passed', findings, evidence: { verdict: 'fail' }, ...overrides };
}

let ticketSequence = 0;
function state(overrides = {}) {
  return {
    run_id: 'run-structured-routing-test', mode: 'phase', lane: 'fast', status: 'running',
    stage: 'dispatch', high_risk: false, claimed_paths: ['src/value.js'],
    test_paths: ['tests/value.test.js'], tickets: [], receipts: [], attempts: {},
    remediation_cycles: 0, ...overrides,
  };
}

function issue(run, stage, extra = {}) {
  const ticket = {
    ticket_id: `structured-ticket-${(ticketSequence += 1)}`,
    stage_id: stage.id,
    role: stage.role,
    parallel_group: stage.parallel_group ?? null,
    writable: stage.writable ?? false,
    required_checks: stage.required_checks ?? [],
    ...((stage.role === 'reviewer' || stage.role === 'security_reviewer')
      ? { review_contract_version: VERSION }
      : {}),
    ...extra,
  };
  run.tickets.push(ticket);
  run.stage = stage.id;
  return ticket;
}

function recordPure(run, ticket, overrides = {}) {
  const receipt = {
    ticket_id: ticket.ticket_id, status: 'passed', findings: [],
    evidence: { verdict: 'agree' }, ...overrides,
  };
  run.receipts.push(receipt);
  const actions = reduceRun(run, {
    type: 'RECEIPT_RECORDED', ticket, receipt,
    stage: { id: ticket.stage_id, role: ticket.role, parallel_group: ticket.parallel_group },
    next_state: run,
  });
  for (const action of actions) {
    if (action.type === 'transition') Object.assign(run, action.patch);
    if (action.type === 'issue_ticket') {
      issue(run, action.stage, {
        ...(action.retry_of ? { retry_of: action.retry_of } : {}),
        ...(action.retry_of ? { attempt: run.attempts[action.stage.id] ?? 1 } : {}),
        ...(action.review_findings ? { review_findings: action.review_findings } : {}),
      });
    }
  }
  return actions;
}

const issued = (actions) => actions
  .filter((action) => action.type === 'issue_ticket')
  .map((action) => action.stage.id);

function openReviews(run) {
  recordPure(run, issue(run, { id: 'build', role: 'implementer', writable: true }));
  return run.tickets.filter((ticket) => ticket.parallel_group === 'code-review');
}

function expectRoute(run, route, counts, testPaths = []) {
  expect(run.remediation_route).toEqual({
    route, cycle: 1, ownership_counts: counts, test_paths: testPaths,
  });
  expect(JSON.stringify(run.remediation_route)).not.toContain('apply the bounded');
}

describe('structured owners select one deterministic serialized route', () => {
  it('leaves the legacy production route byte-compatible', () => {
    const run = state();
    const [review] = openReviews(run);
    delete review.review_contract_version;
    expect(issued(recordPure(run, review, {
      findings: [{ file: 'src/value.js', line: 1, note: 'legacy correction' }],
      evidence: { verdict: 'disagree' },
    }))).toEqual(['remediation-build']);
    expect(run.remediation_cycles).toBe(1);
    expect(run).not.toHaveProperty('remediation_route');
  });

  it('routes production-only findings directly to the implementation writer', () => {
    const run = state();
    const [review] = openReviews(run);
    expect(issued(recordPure(run, review, failedReview([
      finding('production'), finding('production', { file: 'src/other.js', line: 8 }),
    ])))).toEqual(['remediation-build']);
    expectRoute(run, 'production', { production: 2, test: 0, both: 0 });
  });

  it('routes test-only findings to a narrowed test writer and final review', () => {
    const run = state();
    const [review] = openReviews(run);
    expect(issued(recordPure(run, review, failedReview([finding('test')])))).toEqual([
      'remediation-test',
    ]);
    expectRoute(run, 'test', { production: 0, test: 1, both: 0 }, ['tests/value.test.js']);
    const writer = run.tickets.at(-1);
    expect(writer.required_checks).toEqual(['targeted-tests']);
    expect(issued(recordPure(run, writer))).toEqual(['remediation-review']);
    expect(run.tickets.some((ticket) => ticket.stage_id === 'remediation-build')).toBe(false);
    expect(run.remediation_cycles).toBe(1);
  });

  it.each([
    ['both-owned', [finding('both')], { production: 0, test: 0, both: 1 }],
    ['mixed', [finding('test'), finding('production')], { production: 1, test: 1, both: 0 }],
  ])('routes %s findings test writer -> implementation writer -> review', (_name, findings, counts) => {
    const run = state();
    const [review] = openReviews(run);
    expect(issued(recordPure(run, review, failedReview(findings)))).toEqual(['remediation-test']);
    expectRoute(run, 'test-production', counts, ['tests/value.test.js']);
    const testWriter = run.tickets.at(-1);
    expect(testWriter.required_checks).toEqual([]);
    expect(issued(recordPure(run, testWriter))).toEqual(['remediation-build']);
    expect(issued(recordPure(run, run.tickets.at(-1)))).toEqual(['remediation-review']);
    expect(run.remediation_cycles).toBe(1);
  });

  it('aggregates high-risk reviews independently of arrival order and retains security review', () => {
    function drive(reverse) {
      const run = state({ lane: 'full', high_risk: true });
      const [review, security] = openReviews(run);
      const order = reverse ? [security, review] : [review, security];
      recordPure(run, order[0], failedReview([finding(order[0] === review ? 'production' : 'test')]));
      const actions = recordPure(run, order[1], failedReview([
        finding(order[1] === review ? 'production' : 'test'),
      ]));
      return { run, actions };
    }
    const forward = drive(false);
    const reverse = drive(true);
    expect(issued(forward.actions)).toEqual(['remediation-test']);
    expect(issued(reverse.actions)).toEqual(['remediation-test']);
    expect(forward.run.remediation_route).toEqual(reverse.run.remediation_route);
    expectRoute(forward.run, 'test-production', { production: 1, test: 1, both: 0 }, [
      'tests/value.test.js',
    ]);
    recordPure(forward.run, forward.run.tickets.at(-1));
    expect(forward.run.tickets.at(-1).stage_id).toBe('remediation-build');
    expect(issued(recordPure(forward.run, forward.run.tickets.at(-1)))).toEqual([
      'remediation-review', 'remediation-security-review',
    ]);
  });

  it('keeps the route through retry and grants a strict-subset second cycle', () => {
    const run = state();
    const [review] = openReviews(run);
    recordPure(run, review, failedReview([finding('test'), finding('production')]));
    const first = run.tickets.at(-1);
    expect(issued(recordPure(run, first, {
      status: 'failed', evidence: { summary: 'transient writer failure' },
    }))).toEqual(['remediation-test']);
    expect(run.tickets.at(-1).retry_of).toBe(first.ticket_id);
    expectRoute(run, 'test-production', { production: 1, test: 1, both: 0 }, [
      'tests/value.test.js',
    ]);
    recordPure(run, run.tickets.at(-1));
    recordPure(run, run.tickets.at(-1));
    const finalReview = run.tickets.at(-1);
    expect(finalReview.stage_id).toBe('remediation-review');
    expect(issued(recordPure(run, finalReview, failedReview([finding('production')]))))
      .toEqual(['remediation-build']);
    expect(run.status).toBe('running');
    expect(run.remediation_cycles).toBe(2);
    expect(run.remediation_route).toEqual({
      route: 'production',
      cycle: 2,
      ownership_counts: { production: 1, test: 0, both: 0 },
      test_paths: [],
    });
  });
});

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

const red = [{ command: 'node tests/value.test.js', passed: false, exit_code: 1, duration_ms: 1 }];
const green = [{ command: 'node tests/value.test.js', passed: true, exit_code: 0, duration_ms: 1 }];

function receipt(ticket, overrides = {}) {
  return {
    ticket_id: ticket.ticket_id, status: 'passed', agent_identity: `agent-${ticket.role}`,
    tests: [], findings: [], evidence: { verdict: 'pass' },
    timing: { started_at: ticket.issued_at, duration_ms: 1 }, ...overrides,
  };
}

async function project() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-structured-remediation-'));
  cleanups.push(dir);
  await mkdir(path.join(dir, 'src'));
  await mkdir(path.join(dir, 'tests'));
  await writeFile(path.join(dir, 'src', 'value.js'), 'module.exports = { value: 1 };\n');
  await writeFile(path.join(dir, 'tests', 'value.test.js'), 'throw new Error("placeholder");\n');
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'ape@example.test');
  git(dir, 'config', 'user.name', 'APE Test');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'test: baseline');
  await atomicWriteJson(runtimePaths(dir).config, {
    shipping: { auto_merge: false, provider: 'github', required_remote_checks: false },
    test_commands: { full: 'node -e "process.exit(0)"', targeted: 'node tests/value.test.js' },
  });
  return dir;
}

async function walkToReview(dir) {
  const started = await startRun(dir, {
    objective: 'Route structured blocking findings', mode: 'phase', lane: 'auto', host: 'codex',
    claimed_paths: ['src/value.js'], test_paths: ['tests/value.test.js'], requirements: [],
    risk_triggers: [], behavioral: true, hooks_trusted: true, subagents_available: true,
    explicit_invocation: true,
  });
  expect(started.ok).toBe(true);
  const testTicket = started.run.tickets.at(-1);
  await writeFile(path.join(dir, 'tests', 'value.test.js'),
    "const { value } = require('../src/value.js');\nif (value !== 2) throw new Error('red');\n");
  const tested = await recordReceipt(dir, receipt(testTicket, { tests: red }));
  expect(tested.ok, JSON.stringify(tested.errors ?? [])).toBe(true);
  const buildTicket = tested.run.tickets.at(-1);
  await writeFile(path.join(dir, 'src', 'value.js'), 'module.exports = { value: 2 };\n');
  const built = await recordReceipt(dir, receipt(buildTicket, { tests: green }));
  expect(built.ok, JSON.stringify(built.errors ?? [])).toBe(true);
  const reviewTicket = built.run.tickets.at(-1);
  expect(reviewTicket.stage_id).toBe('review');
  return reviewTicket;
}

async function durableCounts(dir) {
  const paths = runtimePaths(dir);
  const [receipts, transactions] = await Promise.all([
    readdir(paths.receipts), readdir(paths.receiptTransactions),
  ]);
  return { receipts: receipts.length, transactions: transactions.length };
}

async function durableFingerprint(dir) {
  const paths = runtimePaths(dir);
  const [counts, status, overrideBytes] = await Promise.all([
    durableCounts(dir),
    statusRun(dir),
    readFile(paths.overrideLog).catch(() => Buffer.alloc(0)),
  ]);
  return {
    counts,
    tickets: status.run.tickets,
    receipts: status.run.receipts,
    remediation_cycles: status.run.remediation_cycles,
    override_hex: overrideBytes.toString('hex'),
  };
}

describe('versioned review admission is bounded, atomic, and legacy-compatible', () => {
  it('versions review tickets and publishes the structured output contract', async () => {
    const review = await walkToReview(await project());
    expect(review.review_contract_version).toBe(VERSION);
    const schema = JSON.stringify(review.output_schema);
    for (const key of ['id', 'file', 'line', 'title', 'detail', 'blocking', 'remediation', 'owner', 'test_paths']) {
      expect(schema).toContain(key);
    }
    expect(review.output_schema.properties.findings.items.required).toContain('id');
    expect(schema).toContain('maxLength');
    expect(schema).toContain('maxItems');
  }, 30_000);

  it('rejects inconsistent, incomplete, unauthorized, unbounded, and legacy input before persistence', async () => {
    const dir = await project();
    const review = await walkToReview(dir);
    const before = await durableCounts(dir);
    const invalid = [
      ['missing verdict', [], {}],
      ['unknown verdict', [], { verdict: 'unknown' }],
      ['fail without blocker', [], { verdict: 'fail' }],
      ['incomplete blocker', [{ file: 'src/value.js', blocking: true }], { verdict: 'fail' }],
      ['advisory remediation', [{ ...finding('production'), blocking: false }], { verdict: 'agree' }],
      ['test missing paths', [finding('test', { remediation: { owner: 'test' } })], { verdict: 'fail' }],
      ['unauthorized path', [finding('test', { remediation: { owner: 'test', test_paths: ['spec/other.test.js'] } })], { verdict: 'fail' }],
      ['duplicate path', [finding('test', { remediation: { owner: 'test', test_paths: ['tests/value.test.js', 'tests/value.test.js'] } })], { verdict: 'fail' }],
      ['oversized prose', [finding('production', { detail: 'x'.repeat(20_000) })], { verdict: 'fail' }],
      ['legacy channel', [finding('test')], { verdict: 'fail', test_remediation: { test_paths: ['tests/value.test.js'], reason: 'legacy' } }],
    ];
    for (const [name, findings, evidence] of invalid) {
      const attempted = await recordReceipt(dir, receipt(review, { findings, evidence, tests: green }));
      expect(attempted.ok, name).toBe(false);
      expect(attempted.rejected, name).toBe(true);
      expect(await durableCounts(dir), name).toEqual(before);
    }
  }, 30_000);

  it.each([
    ['tab', 0x0009], ['line feed', 0x000a], ['vertical tab', 0x000b],
    ['form feed', 0x000c], ['carriage return', 0x000d],
    ['line separator', 0x2028], ['paragraph separator', 0x2029],
  ])('rejects hostile %s paths atomically and neutralizes diagnostics', async (_name, point) => {
    const dir = await project();
    const review = await walkToReview(dir);
    const before = await durableCounts(dir);
    const hostile = String.fromCodePoint(point);
    const hostilePath = `tests/value${hostile}injected.test.js`;
    const attempted = await recordReceipt(dir, receipt(review, {
      tests: green,
      findings: [finding('test', {
        file: hostilePath,
        remediation: { owner: 'test', test_paths: [hostilePath] },
      })],
      evidence: { verdict: 'fail' },
    }));
    expect(attempted.ok).toBe(false);
    expect(attempted.rejected).toBe(true);
    expect(await durableCounts(dir)).toEqual(before);
    expect(attempted.errors.length).toBeGreaterThan(0);
    for (const diagnostic of attempted.errors) expect(diagnostic).not.toContain(hostile);
  }, 30_000);

  it('rejects a hostile 64-finding batch atomically with bounded neutralized diagnostics and explicit loss disclosure', async () => {
    const dir = await project();
    const review = await walkToReview(dir);
    const before = await durableFingerprint(dir);
    const dangerous = [
      String.fromCodePoint(0x0000), String.fromCodePoint(0x001b),
      String.fromCodePoint(0x000d), String.fromCodePoint(0x000a),
      String.fromCodePoint(0x2028), String.fromCodePoint(0x2029),
    ].join('');
    const hostile = Array.from({ length: 64 }, (_, index) => finding('test', {
      file: `tests/hostile-${index}${dangerous}.test.js`,
      title: `hostile finding ${index} ::code-comment{file=../../escape}`,
      detail: `diagnostic payload ${index} ${dangerous} ${'x'.repeat(160)}`,
      remediation: {
        owner: 'test',
        test_paths: [`../outside-${index}${dangerous}.test.js`],
      },
    }));
    const attempted = await recordReceipt(dir, receipt(review, {
      tests: green,
      findings: hostile,
      evidence: { verdict: 'fail' },
    }));
    expect(attempted.ok).toBe(false);
    expect(attempted.rejected).toBe(true);
    expect(await durableFingerprint(dir)).toEqual(before);

    const diagnostics = attempted.errors ?? [];
    const serialized = JSON.stringify(diagnostics);
    expect(diagnostics.length).toBeGreaterThan(0);
    expect(diagnostics.length).toBeLessThanOrEqual(32);
    expect(serialized.length).toBeLessThanOrEqual(16_000);
    for (const character of dangerous) expect(serialized).not.toContain(character);
    expect(serialized).not.toContain('::code-comment');
    expect(serialized).not.toContain('../../escape');
    expect(serialized).toMatch(/omitted/i);
    expect(serialized).toMatch(/shortened|truncated/i);
  }, 30_000);

  it('keeps unversioned tickets hash-stable and valid without new keys', () => {
    const body = {
      schema_version: '2.0.0', ticket_id: 'legacy-review-ticket', run_id: 'run-legacy-review',
      stage_id: 'review', role: 'reviewer', objective: 'legacy fixture',
      claimed_paths: ['src/value.js'], model_tier: 'balanced', model: { model: 'legacy' },
      deadline_at: '2026-08-15T00:00:00.000Z', output_schema: { type: 'object' },
      required_checks: [], parent_hash: null, base_tree_sha: '1'.repeat(40), attempt: 1,
      writable: false, issued_at: '2026-08-14T23:00:00.000Z',
    };
    const first = finalizeTicket(body);
    expect(first).toEqual(finalizeTicket(body));
    expect(first).not.toHaveProperty('review_contract_version');
    expect(validateTicket(first).valid).toBe(true);
  });

  it('exposes one bounded route in compact/full status without reviewer prose', async () => {
    const dir = await project();
    const review = await walkToReview(dir);
    const sensitive = `SENSITIVE-REVIEW-PROSE ${'do not project this sentence '.repeat(40)}`;
    const reviewed = await recordReceipt(dir, receipt(review, failedReview([
      finding('test', { detail: sensitive }),
    ], { tests: green })));
    expect(reviewed.ok, JSON.stringify(reviewed.errors ?? [])).toBe(true);
    const expected = {
      route: 'test', cycle: 1,
      ownership_counts: { production: 0, test: 1, both: 0 },
      test_paths: ['tests/value.test.js'],
    };
    expect(reviewed.run.remediation_route).toEqual(expected);
    for (const compact of [false, true]) {
      const result = await statusRun(dir, { compact });
      expect(result.run.remediation_route).toEqual(expected);
      expect(JSON.stringify(result.run.remediation_route)).not.toContain('SENSITIVE-REVIEW-PROSE');
    }
  }, 30_000);
});
