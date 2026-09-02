import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { recordReceipt, startRun, statusRun } from '../lib/runtime/service.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { atomicWriteJson, readJson } from '../lib/runtime/storage.js';
import { classifyLane } from '../lib/runtime/lane-policy.js';
import { START_MODES } from '../lib/runtime/schemas.js';
import { RUN_MODES } from '../lib/runtime/constants.js';

// Friction #32: a finished, already-green working-tree diff had no lane —
// mechanical rejected non-mechanical scope and the behavioral lanes are
// strictly drive-from-red. Mode `land` gates and lands the existing diff:
// start is the scope-truth moment, the pipeline is review machinery plus the
// full deterministic merge gates, and no writing stage ever exists.

const cleanups = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function project(config = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-core-land-'));
  cleanups.push(dir);
  await mkdir(path.join(dir, 'src'));
  await mkdir(path.join(dir, 'tests'));
  await mkdir(path.join(dir, 'docs'));
  await writeFile(path.join(dir, 'src', 'value.js'), 'export const value = 1;\n');
  await writeFile(path.join(dir, 'tests', 'value.test.js'), 'process.exit(0);\n');
  await writeFile(path.join(dir, 'docs', 'notes.md'), '# Notes\n');
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'ape@example.test');
  git(dir, 'config', 'user.name', 'APE Test');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'baseline');
  await atomicWriteJson(runtimePaths(dir).config, {
    shipping: { auto_merge: false, provider: 'github', required_remote_checks: false },
    test_commands: {
      full: 'node -e "process.exit(0)"',
      targeted: 'node -e "process.exit(0)"',
    },
    ...config,
  });
  return dir;
}

function startInput(overrides = {}) {
  return {
    objective: 'Gate and land the finished working-tree diff',
    mode: 'land',
    lane: 'auto',
    host: 'codex',
    claimed_paths: ['src/value.js'],
    test_paths: [],
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
    evidence: { verdict: 'agree' },
    timing: {
      started_at: ticket.issued_at,
      completed_at: new Date(Date.parse(ticket.issued_at) + 10).toISOString(),
      duration_ms: 10,
    },
    ...overrides,
  };
}

async function dirtyDiff(dir) {
  await writeFile(path.join(dir, 'src', 'value.js'), 'export const value = 2;\n');
}

describe('land start is the scope-truth moment', () => {
  it('rejects an empty working-tree diff before any branch or state exists', async () => {
    const dir = await project();
    const branchBefore = git(dir, 'rev-parse', '--abbrev-ref', 'HEAD');

    await expect(startRun(dir, startInput())).rejects.toThrow(/non-empty finished diff/);

    expect((await statusRun(dir)).active).toBe(false);
    expect(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(branchBefore);
    expect(git(dir, 'branch', '--list', 'ape/*')).toBe('');
  });

  it('rejects a diff touching files outside claimed_paths and names them', async () => {
    const dir = await project();
    await dirtyDiff(dir);
    await writeFile(path.join(dir, 'docs', 'notes.md'), '# Notes\n\nOut of claim.\n');

    const error = await startRun(dir, startInput()).then(() => null, (thrown) => thrown);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/inside claimed_paths/);
    expect(error.message).toMatch(/docs\/notes\.md/);
    expect(error.message).toMatch(/claimed_paths or revert/);
    expect((await statusRun(dir)).active).toBe(false);
  });
});

describe('a valid land start issues review stages and no writing stage', () => {
  it('issues a read-only code-review group and seals the admitted diff as the first receipt', async () => {
    const dir = await project();
    await dirtyDiff(dir);

    const started = await startRun(dir, startInput());
    expect(started.ok).toBe(true);
    expect(started.run.mode).toBe('land');
    expect(started.run.tickets.map((ticket) => ticket.stage_id)).toEqual(['review']);
    const review = started.run.tickets[0];
    expect(review.role).toBe('reviewer');
    expect(review.writable).toBe(false);
    expect(review.parallel_group).toBe('code-review');
    expect(started.run.tickets.some((ticket) => ['test_writer', 'implementer'].includes(ticket.role))).toBe(false);

    const admission = started.run.receipts[0];
    expect(admission.agent.identity).toBe('ape-runtime');
    expect(admission.changed_files).toEqual(['src/value.js']);
    expect(admission.previous_receipt_hash).toBeNull();
    // The review ticket chains onto the runtime-attested admission evidence.
    expect(review.parent_hash).toBe(admission.receipt_hash);
  });

  it('arms the parallel security review when risk triggers demand it', async () => {
    const dir = await project();
    await dirtyDiff(dir);

    const started = await startRun(dir, startInput({ risk_triggers: ['security'] }));
    expect(started.ok).toBe(true);
    expect(started.run.high_risk).toBe(true);
    expect(started.run.tickets.map((ticket) => ticket.stage_id).sort()).toEqual(['review', 'security-review']);
    expect(started.run.tickets.every((ticket) => ticket.writable === false)).toBe(true);
  });
});

describe('land review outcomes', () => {
  it('agreement runs every deterministic merge gate and the gated auto-merge', async () => {
    const dir = await project();
    await dirtyDiff(dir);
    const started = await startRun(dir, startInput());
    const review = started.run.tickets[0];

    const result = await recordReceipt(dir, receipt(review));
    expect(result.ok).toBe(true);
    const gates = result.actions.find((action) => action.type === 'gates');
    expect(gates).toBeTruthy();
    expect(gates.result.passed).toBe(true);
    // The dirty land diff is covered by the sealed admission receipt, not
    // waived: clean_tree and the runtime-executed test gates all ran.
    expect(result.run.gates.checks.clean_tree.passed).toBe(true);
    expect(result.run.gates.checks.targeted_tests.passed).toBe(true);
    expect(result.run.gates.checks.full_suite.passed).toBe(true);
    expect(result.run.gates.checks.tree_binding.passed).toBe(true);
    // Invariant 9: gates passing hands off to the gated auto-merge, which is
    // disabled by this project's configuration — the run blocks there instead
    // of completing around the gate.
    expect(result.run.status).toBe('blocked');
    expect(result.run.block_reason).toBe('auto-merge is disabled by configuration');
  });

  it('disagreement blocks honestly instead of issuing a writer', async () => {
    const dir = await project();
    await dirtyDiff(dir);
    const started = await startRun(dir, startInput());
    const review = started.run.tickets[0];

    const result = await recordReceipt(dir, receipt(review, {
      findings: [{
        file: 'src/value.js',
        line: 1,
        title: 'landed diff still needs correction',
        detail: 'PRIVATE_LAND_REVIEW_DETAIL must stay out of terminal telemetry',
        blocking: true,
        remediation: { owner: 'production' },
      }],
      evidence: { verdict: 'disagree' },
    }));
    expect(result.ok).toBe(true);
    expect(result.run.status).toBe('blocked');
    expect(result.run.block_reason).toMatch(/no writing stage/);
    // "Outside APE" is load-bearing: no APE surface can perform the revision,
    // so the operator is told the fix happens outside, then a new land run.
    expect(result.run.block_reason).toMatch(/revise the diff outside APE/);
    expect(result.run.block_reason).toMatch(/start a new land run/);
    // The remediation budget is truthfully unspent and no implementer ticket
    // ever existed.
    expect(result.run.remediation_cycles).toBe(0);
    expect(result.run.tickets).toHaveLength(1);
    expect(result.actions.some((action) => action.type === 'dispatch_agent')).toBe(false);
    expect(await readJson(path.join(
      runtimePaths(dir).history,
      `${result.run.run_id}.json`,
    ))).toMatchObject({
      terminal_reason_taxonomy_version: 2,
      terminal_reason_code: 'land_review_disagreement',
    });
    expect(result.successor_guidance).toMatchObject({
      version: 2,
      eligible: true,
      predecessor_run_id: result.run.run_id,
      retained_tree_sha: result.run.tree_sha,
      eligibility_reason: 'land_review_disagreement',
      structured_successor_supported: false,
      unavailable_reason: 'authenticated-host-approval-unavailable',
      recovery_action: 'override-reset',
      required_authorization: 'explicit-operator-override',
      automatic_start: false,
      automatic_ship: false,
    });
    expect(JSON.stringify(result.successor_guidance)).not.toContain('PRIVATE_LAND_REVIEW_DETAIL');
  });

  it('a failed review receipt is a disagree vote and blocks the same way', async () => {
    const dir = await project();
    await dirtyDiff(dir);
    const started = await startRun(dir, startInput());
    const review = started.run.tickets[0];

    const result = await recordReceipt(dir, receipt(review, { status: 'failed', evidence: {} }));
    expect(result.ok).toBe(true);
    expect(result.run.status).toBe('blocked');
    expect(result.run.block_reason).toMatch(/no writing stage/);
    expect(result.run.remediation_cycles).toBe(0);
    expect(result.run.tickets).toHaveLength(1);
    expect(await readJson(path.join(
      runtimePaths(dir).history,
      `${result.run.run_id}.json`,
    ))).toMatchObject({
      terminal_reason_taxonomy_version: 2,
      terminal_reason_code: 'land_review_disagreement',
    });
    expect(result.successor_guidance).toMatchObject({
      eligibility_reason: 'land_review_disagreement',
      recovery_action: 'override-reset',
      required_authorization: 'explicit-operator-override',
      automatic_start: false,
      automatic_ship: false,
    });
  });
});

describe('land is explicit-request only', () => {
  it('auto lane classification can never produce land', () => {
    const inputs = [
      { requested_lane: 'auto', claimed_paths: ['src/value.js'], behavioral: true },
      { requested_lane: 'auto', claimed_paths: ['docs/notes.md'], behavioral: false },
      { requested_lane: 'auto', claimed_paths: [], behavioral: true },
      { requested_lane: 'auto', claimed_paths: ['src/value.js'], behavioral: true, risk_triggers: ['security'] },
      { requested_lane: 'mechanical', claimed_paths: ['src/value.js'], behavioral: true },
      { requested_lane: 'fast', claimed_paths: ['src/value.js'], behavioral: true },
      { requested_lane: 'full', claimed_paths: ['src/value.js'], behavioral: true },
    ];
    for (const input of inputs) {
      expect(classifyLane(input).lane).not.toBe('land');
    }
    // The mode is requestable at start but deliberately absent from the
    // classifier vocabulary.
    expect(START_MODES).toContain('land');
    expect(RUN_MODES).not.toContain('land');
  });

  it('an implicit start over a landable diff never becomes land: the hygiene guard rejects and names the opt-in', async () => {
    const dir = await project();
    await dirtyDiff(dir);

    // A building mode never silently absorbs a finished diff as baseline; the
    // rejection steers to the explicit land request instead of adopting it.
    const error = await startRun(dir, startInput({
      mode: 'phase',
      test_paths: ['tests/value.test.js'],
    })).then(() => null, (thrown) => thrown);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/requires a clean working tree/);
    expect(error.message).toMatch(/use mode land/);
    expect((await statusRun(dir)).active).toBe(false);
    expect(git(dir, 'branch', '--list', 'ape/*')).toBe('');
  });
});
