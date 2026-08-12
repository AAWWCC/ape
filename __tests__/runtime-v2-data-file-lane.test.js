import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { recordReceipt, startRun } from '../lib/runtime/service.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { atomicWriteJson } from '../lib/runtime/storage.js';
import { classifyLane } from '../lib/runtime/lane-policy.js';

// Roadmap requirement data-file-lane-gap: tracked non-docs DATA files
// (benchmark reference runs, fixture corpora, test data) currently have no
// green lane — auto-classification lands them in 'fast' (which demands
// authored tests a data refresh cannot truthfully supply) and a requested
// mechanical lane escalates on 'non-mechanical-scope'. The approved contract:
// a claim whose extension is one of {.json,.jsonl,.ndjson,.csv,.tsv} AND whose
// FIRST path segment is exactly one of {benchmarks,fixtures,testdata} counts
// as mechanical scope. The fix is classification-scoped (lane-policy only):
// gates and service behavior for genuinely behavioral scopes must not move.

const cleanups = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

// Field-reproduction fixture (mirrors runtime-v2-core-land-lane.test.js): a
// mkdtemp git repo whose baseline COMMITS the tracked data file, with
// auto-merge disabled and — deliberately — NO test_commands.targeted, so the
// targeted_tests merge gate is decided purely by lane classification (an
// unconditional mechanical pass vs. a behavioral-lane derivation that finds
// no runtime-verifiable test paths).
async function project() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-data-lane-'));
  cleanups.push(dir);
  await mkdir(path.join(dir, 'src'));
  await mkdir(path.join(dir, 'benchmarks'));
  await writeFile(path.join(dir, 'src', 'value.js'), 'export const value = 1;\n');
  await writeFile(path.join(dir, 'benchmarks', 'reference-runs.json'), '{"runs":[1]}\n');
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'ape@example.test');
  git(dir, 'config', 'user.name', 'APE Test');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'baseline');
  await atomicWriteJson(runtimePaths(dir).config, {
    shipping: { auto_merge: false, provider: 'github', required_remote_checks: false },
    test_commands: { full: 'node -e "process.exit(0)"' },
  });
  return dir;
}

function startInput(overrides = {}) {
  return {
    objective: 'Gate and land the refreshed benchmark reference data',
    mode: 'land',
    lane: 'auto',
    host: 'codex',
    claimed_paths: ['benchmarks/reference-runs.json'],
    test_paths: [],
    requirements: [],
    risk_triggers: [],
    behavioral: false,
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
    evidence: { verdict: 'agree' },
    timing: {
      started_at: ticket.issued_at,
      completed_at: new Date(Date.parse(ticket.issued_at) + 10).toISOString(),
      duration_ms: 10,
    },
    ...overrides,
  };
}

const dataClaim = (claimed_paths, overrides = {}) => ({
  requested_lane: 'auto',
  behavioral: false,
  claimed_paths,
  risk_triggers: [],
  ...overrides,
});

// ---------------------------------------------------------------------------
// RED at base: these pin the approved data-file mechanical scope and fail
// today only because the extension+first-segment predicate does not exist yet.
// ---------------------------------------------------------------------------

describe('tracked data files classify as mechanical scope (RED at base)', () => {
  it('auto-classifies a non-behavioral benchmarks data claim into the mechanical lane', () => {
    expect(classifyLane(dataClaim(['benchmarks/reference-runs.json']))).toEqual({
      lane: 'mechanical',
      reasons: ['non-behavioral-mechanical-scope'],
      risk_triggers: [],
    });
  });

  it('covers every approved data extension under each approved first segment', () => {
    for (const claim of [
      'benchmarks/reference-runs.json',
      'fixtures/seed-records.jsonl',
      'testdata/event-stream.ndjson',
      'benchmarks/latency-summary.csv',
      'fixtures/locale-matrix.tsv',
    ]) {
      expect(classifyLane(dataClaim([claim])).lane, claim).toBe('mechanical');
    }
  });

  it('honors a requested mechanical lane for a data-file scope instead of escalating', () => {
    expect(classifyLane(dataClaim(['benchmarks/reference-runs.json'], { requested_lane: 'mechanical' }))).toEqual({
      lane: 'mechanical',
      reasons: ['requested-mechanical'],
      risk_triggers: [],
    });
  });

  // D3 parity with the pinned docs-scope case: a declared trigger rides the
  // mechanical lane (arming high_risk and the conditional security review)
  // instead of being dropped or forcing an unsatisfiable full lane.
  it('keeps a security-triggered data claim mechanical and carries the trigger', () => {
    expect(classifyLane(dataClaim(['benchmarks/reference-runs.json'], { risk_triggers: ['security'] }))).toEqual({
      lane: 'mechanical',
      reasons: ['non-behavioral-mechanical-scope', 'risk:security'],
      risk_triggers: ['security'],
    });
  });
});

describe('field reproduction: landing a tracked benchmarks data refresh (RED at base)', () => {
  it('passes the deterministic merge gates and blocks only at the disabled auto-merge', async () => {
    const dir = await project();
    // Dirty ONLY the tracked data file: the finished diff mode land admits.
    await writeFile(path.join(dir, 'benchmarks', 'reference-runs.json'), '{"runs":[1,2]}\n');

    const started = await startRun(dir, startInput());
    expect(started.ok).toBe(true);
    const review = started.run.tickets.find((ticket) => ticket.stage_id === 'review');
    expect(review).toBeTruthy();

    const result = await recordReceipt(dir, receipt(review));
    expect(result.ok).toBe(true);
    // The data-only scope needs no behavioral test evidence: targeted_tests
    // passes by mechanical classification, the configured full suite runs and
    // passes, and the run stops exactly at the configuration hold — not at
    // 'one or more deterministic merge gates failed' with the
    // no-runtime-verifiable-test-paths targeted reason it blocks on today.
    expect(result.run.gates.checks.targeted_tests.passed).toBe(true);
    expect(result.run.gates.checks.full_suite.passed).toBe(true);
    expect(result.run.status).toBe('blocked');
    expect(result.run.block_reason).toBe('auto-merge is disabled by configuration');
  });
});

// ---------------------------------------------------------------------------
// GREEN guardrails: pass at base and must stay green after the fix — the
// mechanical widening is data-file-scoped, never a blanket behavioral:false
// pass and never a change to './'-prefixed claim handling.
// ---------------------------------------------------------------------------

describe('non-data scopes stay non-mechanical (GREEN guardrails)', () => {
  it('keeps behavioral:false production, config, and mixed scopes in the fast lane', () => {
    for (const claims of [
      ['src/value.js'],
      ['lib/runtime/service.js'],
      ['package.json'],
      ['benchmarks/harness.js'],
      ['benchmarks/reference-runs.json', 'src/value.js'],
    ]) {
      expect(classifyLane(dataClaim(claims)).lane, claims.join(', ')).toBe('fast');
    }
  });

  it('requires BOTH the data extension and the exact first segment', () => {
    // Extension in the set but first segment outside it; approved segment not
    // in FIRST position. Neither may classify mechanical.
    for (const claims of [['data/latency-summary.csv'], ['nested/benchmarks/reference-runs.json']]) {
      expect(classifyLane(dataClaim(claims)).lane, claims.join(', ')).toBe('fast');
    }
  });

  it('keeps behavioral data work on the behavioral lanes', () => {
    expect(classifyLane(dataClaim(['benchmarks/reference-runs.json'], { behavioral: true })).lane).toBe('fast');

    const escalated = classifyLane(dataClaim(['benchmarks/reference-runs.json'], {
      requested_lane: 'mechanical',
      behavioral: true,
    }));
    expect(escalated.lane).toBe('fast');
    expect(escalated.reasons).toContain('requested-mechanical-escalated');
    expect(escalated.reasons).toContain('behavioral-change');
  });

  // Critic's addition: './'-prefixed claims are matched on their raw first
  // segment ('.'), so today this shape classifies fast. Pin exactly today's
  // result so the implementation cannot silently change './'-handling in
  // either direction while fixing the bare-path case.
  it("pins today's classification for a './'-prefixed data claim", () => {
    expect(classifyLane(dataClaim(['./benchmarks/reference-runs.json']))).toEqual({
      lane: 'fast',
      reasons: ['bounded-behavioral-scope'],
      risk_triggers: [],
    });
  });
});

describe('behavioral-scope land runs still block at the gates (GREEN guardrail)', () => {
  it('a behavioral:false production diff with no targeted config fails targeted_tests', async () => {
    const dir = await project();
    await writeFile(path.join(dir, 'src', 'value.js'), 'export const value = 2;\n');

    const started = await startRun(dir, startInput({ claimed_paths: ['src/value.js'] }));
    expect(started.ok).toBe(true);
    const review = started.run.tickets.find((ticket) => ticket.stage_id === 'review');
    expect(review).toBeTruthy();

    const result = await recordReceipt(dir, receipt(review));
    expect(result.ok).toBe(true);
    // The fix must be classification-scoped: behavioral:false alone never
    // buys a targeted_tests pass for a production-code diff.
    expect(result.run.gates.checks.targeted_tests.passed).toBe(false);
    expect(result.run.status).toBe('blocked');
    expect(result.run.block_reason).toBe('one or more deterministic merge gates failed');
  });
});
