import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  archiveRun,
  calculateProjectMetrics,
} from '../lib/runtime/history.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { historyAction, startRun } from '../lib/runtime/service.js';
import { summarizeHistoryRecord } from '../lib/runtime/projection.js';
import { atomicWriteJson, readJson } from '../lib/runtime/storage.js';
import { hashRecord } from '../lib/runtime/canonical.js';
import {
  TERMINAL_REASON_TAXONOMY_VERSION,
  terminalFailureDomain,
  terminalReasonCode,
  validatedTerminalRecoveryFields,
} from '../lib/runtime/terminal-telemetry.js';
import {
  APE_VERSION,
  CODEX_DISPATCH_ENVELOPE_VERSION,
  CODEX_DISPATCH_PROTOCOL_VERSION,
  runVersionProvenance,
} from '../lib/runtime/versions.js';

const cleanups = [];
const [apeMajor, apeMinor] = APE_VERSION.split('.');
const NEXT_APE_VERSION = `${apeMajor}.${Number(apeMinor) + 1}.0`;

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function sandbox(prefix) {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  cleanups.push(dir);
  return dir;
}

function terminalState(runId, overrides = {}) {
  return {
    schema_version: '2.0.0',
    run_id: runId,
    objective: `Terminal diagnostics for ${runId}`,
    mode: 'phase',
    lane: 'fast',
    host: 'codex',
    requirements: [],
    status: 'blocked',
    stage: 'build',
    block_reason: 'stage build failed twice',
    created_at: '2026-08-26T00:00:00.000Z',
    updated_at: '2026-08-26T00:01:00.000Z',
    terminal_at: '2026-08-26T00:01:00.000Z',
    base_commit_sha: 'a'.repeat(40),
    tree_sha: 'b'.repeat(40),
    tickets: [],
    receipts: [],
    ...overrides,
  };
}

function git(cwd, ...args) {
  execFileSync('git', args, { cwd, encoding: 'utf8' });
}

async function gitProject() {
  const dir = await sandbox('ape-versioned-run-');
  await mkdir(path.join(dir, 'docs'));
  await writeFile(path.join(dir, 'docs', 'note.md'), '# note\n');
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'ape@example.test');
  git(dir, 'config', 'user.name', 'APE Test');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'baseline');
  return dir;
}

describe('versioned-terminal-diagnostics', () => {
  it('stamps new Codex runs once with release, runtime, plugin, protocol, and envelope provenance', async () => {
    const dir = await gitProject();
    const started = await startRun(dir, {
      objective: 'Exercise durable operational provenance',
      mode: 'phase',
      lane: 'mechanical',
      host: 'codex',
      claimed_paths: ['docs/note.md'],
      test_paths: [],
      requirements: [],
      risk_triggers: [],
      behavioral: false,
      hooks_trusted: true,
      subagents_available: true,
      explicit_invocation: true,
    });

    const expected = {
      ape_version: APE_VERSION,
      runtime_version: 2,
      host_plugin_version: APE_VERSION,
      protocol_version: CODEX_DISPATCH_PROTOCOL_VERSION,
      envelope_version: CODEX_DISPATCH_ENVELOPE_VERSION,
    };
    expect(started.run).toMatchObject(expected);
    expect(await readJson(runtimePaths(dir).active)).toMatchObject(expected);
  });

  it('hash-binds a stable terminal code and exposes it through privacy-safe explain', async () => {
    const dir = await sandbox('ape-versioned-terminal-');
    const paths = runtimePaths(dir);
    const privateDetail = 'PRIVATE_AGENT_FINDING_MUST_NOT_REACH_DIAGNOSTICS';
    const record = await archiveRun(paths, terminalState('run-versioned-plan', {
      ...runVersionProvenance('codex'),
      stage: 'plan-judge',
      block_reason: `plan judged unsound by the disagreement judge: ${privateDetail}`,
    }));

    expect(record).toMatchObject({
      ape_version: APE_VERSION,
      runtime_version: 2,
      host_plugin_version: APE_VERSION,
      protocol_version: CODEX_DISPATCH_PROTOCOL_VERSION,
      envelope_version: CODEX_DISPATCH_ENVELOPE_VERSION,
      terminal_reason_taxonomy_version: TERMINAL_REASON_TAXONOMY_VERSION,
      terminal_reason_code: 'planning_rejected',
    });
    const before = await readFile(path.join(paths.history, 'run-versioned-plan.json'), 'utf8');
    const explained = await historyAction(dir, 'explain', { run_id: record.run_id });
    expect(explained.diagnostic).toMatchObject({
      reason_code: 'blocked',
      terminal_reason_code: 'planning_rejected',
    });
    expect(explained.run).toMatchObject({
      ape_version: APE_VERSION,
      protocol_version: CODEX_DISPATCH_PROTOCOL_VERSION,
      terminal_reason_code: 'planning_rejected',
    });
    expect(explained.text).toContain('Terminal reason code: planning_rejected');
    expect(JSON.stringify(explained)).not.toContain(privateDetail);
    expect(await readFile(path.join(paths.history, 'run-versioned-plan.json'), 'utf8')).toBe(before);
  });

  it('classifies structured recovery outcomes without depending on future prose wording', () => {
    expect(TERMINAL_REASON_TAXONOMY_VERSION).toBe(2);
    expect(terminalReasonCode(terminalState('run-directed-replan', {
      terminal_reason_code: 'planning_rejected',
      stage: 'plan-judge',
      block_reason: 'wording may change',
    }))).toBe('planning_rejected');
    expect(terminalReasonCode(terminalState('run-test-reconciliation', {
      terminal_reason_code: 'test_contradiction',
      stage: 'test',
      block_reason: 'wording may change',
    }))).toBe('test_contradiction');
    expect(terminalReasonCode(terminalState('run-capability', {
      terminal_reason_code: 'capability_blocked',
      block_reason: 'wording may change',
    }))).toBe('capability_blocked');
    const landDisagreement = terminalState('run-land-review-disagreement', {
      mode: 'land',
      stage: 'review',
      remediation_cycles: 0,
      block_reason: 'land mode has no writing stage; revise the diff outside APE, then start a new land run',
    });
    expect(terminalReasonCode(landDisagreement)).toBe('land_review_disagreement');
    expect(terminalFailureDomain(landDisagreement)).toBe('product');
    expect(terminalReasonCode(terminalState('run-review-remediation-exhausted', {
      mode: 'phase',
      stage: 'remediation',
      remediation_cycles: 2,
      block_reason: 'review disagreement reached the configured remediation budget (2 cycles)',
    }))).toBe('review_remediation_exhausted');

    const directedReplan = {
      reason_code: 'plan_rejected_after_directed_replan',
      directed_replan_attempts: 1,
      missing_assurances: [{
        id: 'pa-0123456789abcdef',
        source_stage: 'plan-judge',
        summary: 'The replacement plan still omits a required assurance.',
        evidence_anchor: 'receipt:plan-judge#missing-assurances',
      }],
    };
    expect(validatedTerminalRecoveryFields({ blocked_recovery: directedReplan }))
      .toEqual({ blocked_recovery: directedReplan });
  });

  it('classifies aborted runs by runtime-owned terminal stage instead of one opaque bucket', () => {
    const abortedAt = (stage) => terminalReasonCode(terminalState(`run-aborted-${stage ?? 'dispatch'}`, {
      status: 'aborted',
      stage,
      block_reason: undefined,
    }));

    expect(abortedAt(undefined)).toBe('aborted_dispatch');
    expect(abortedAt('preflight')).toBe('aborted_preflight');
    expect(abortedAt('plan-judge')).toBe('aborted_planning');
    expect(abortedAt('test-reconcile')).toBe('aborted_test');
    expect(abortedAt('build')).toBe('aborted_implementation');
    expect(abortedAt('security-review')).toBe('aborted_review');
    expect(abortedAt('gates')).toBe('aborted_gating');
    expect(abortedAt('merge')).toBe('aborted_shipping');
    expect(abortedAt('debug')).toBe('aborted_investigation');

    expect(terminalReasonCode(terminalState('run-blocked-mismatched-abort-code', {
      status: 'blocked',
      stage: 'build',
      terminal_reason_code: 'aborted_planning',
    }))).toBe('implementation_failed');
    expect(terminalReasonCode(terminalState('run-aborted-mismatched-block-code', {
      status: 'aborted',
      stage: 'plan-judge',
      terminal_reason_code: 'planning_rejected',
    }))).toBe('aborted_planning');
  });

  it('preserves bounded terminal recovery evidence while projecting only privacy-safe counts', async () => {
    const dir = await sandbox('ape-versioned-recovery-');
    const privatePath = 'src/PRIVATE_ADDITIVE_CLAIM.js';
    const blockedRecovery = {
      reason_code: 'capability_denied',
      source_ticket_id: 'run-capability-recovery:build:ticket',
      source_stage_id: 'build',
      additive_claims: {
        claimed_paths: [privatePath],
        test_paths: [],
        tool_claims: ['unity:console:read'],
        required_role: 'implementer',
      },
      claims_reported: true,
      successor_required: true,
      supersession_required: true,
      supersedes_run: 'run-capability-recovery',
    };
    const resolution = { verdict: 'implementation-correction-required', receipt_id: 'receipt-safe-id' };
    const record = await archiveRun(runtimePaths(dir), terminalState('run-capability-recovery', {
      ...runVersionProvenance('codex'),
      terminal_reason_code: 'capability_blocked',
      blocked_recovery: blockedRecovery,
      test_contradiction_resolution: resolution,
    }));

    expect(record.blocked_recovery).toEqual(blockedRecovery);
    expect(record.test_contradiction_resolution).toEqual(resolution);
    const summary = summarizeHistoryRecord(record);
    expect(summary.blocked_recovery).toEqual({
      reason_code: 'capability_denied',
      additive_claim_counts: {
        claimed_paths: 1,
        test_paths: 0,
        tool_claims: 1,
        required_role: 1,
      },
      claims_reported: true,
      successor_required: true,
      supersession_required: true,
      supersedes_run: 'run-capability-recovery',
    });
    expect(JSON.stringify(summary)).not.toContain(privatePath);
    const explained = await historyAction(dir, 'explain', { run_id: record.run_id });
    expect(explained.run.blocked_recovery).toEqual(summary.blocked_recovery);
    expect(explained.text).toContain('Terminal recovery: capability_denied; 3 additive claims');
    expect(explained.text).toContain('Test contradiction resolution: implementation-correction-required');
    expect(JSON.stringify(explained)).not.toContain(privatePath);
  });

  it('aggregates version cohorts and derived legacy reasons without rewriting legacy records', async () => {
    const dir = await sandbox('ape-versioned-cohorts-');
    const paths = runtimePaths(dir);
    await archiveRun(paths, terminalState('run-cohort-plan', {
      ...runVersionProvenance('codex'),
      stage: 'plan-judge',
      block_reason: 'plan judged unsound by the disagreement judge',
    }));
    await archiveRun(paths, terminalState('run-cohort-test', {
      ...runVersionProvenance('codex'),
      stage: 'build',
      block_reason: 'stage build test-contradiction-blocked',
    }));
    const versionOne = await archiveRun(paths, terminalState('run-cohort-version-one-review', {
      ...runVersionProvenance('codex'),
      mode: 'land',
      stage: 'review',
      remediation_cycles: 0,
      block_reason: 'land mode has no writing stage; revise the diff outside APE, then start a new land run',
    }));
    versionOne.terminal_reason_taxonomy_version = 1;
    versionOne.terminal_reason_code = 'review_remediation_exhausted';
    versionOne.record_hash = hashRecord(versionOne, ['record_hash', 'completed_at', 'timing']);
    const versionOneFile = path.join(paths.history, 'run-cohort-version-one-review.json');
    await atomicWriteJson(versionOneFile, versionOne);
    expect(versionOne).toMatchObject({
      terminal_reason_taxonomy_version: 1,
      terminal_reason_code: 'review_remediation_exhausted',
    });
    const versionOneBefore = await readFile(versionOneFile, 'utf8');
    const replayedVersionOne = await archiveRun(paths, terminalState(
      'run-cohort-version-one-review',
      {
        ...runVersionProvenance('codex'),
        mode: 'land',
        stage: 'review',
        remediation_cycles: 0,
        block_reason: 'land mode has no writing stage; revise the diff outside APE, then start a new land run',
      },
    ), { ifAbsent: true });
    expect(replayedVersionOne).toMatchObject({
      terminal_reason_taxonomy_version: 1,
      terminal_reason_code: 'review_remediation_exhausted',
    });
    expect(await readFile(versionOneFile, 'utf8')).toBe(versionOneBefore);
    const versionTwo = await archiveRun(paths, terminalState('run-cohort-version-two-review', {
      ...runVersionProvenance('codex'),
      mode: 'land',
      stage: 'review',
      remediation_cycles: 0,
      block_reason: 'land mode has no writing stage; revise the diff outside APE, then start a new land run',
    }));
    versionTwo.terminal_reason_code = 'review_remediation_exhausted';
    versionTwo.record_hash = hashRecord(versionTwo, ['record_hash', 'completed_at', 'timing']);
    const versionTwoFile = path.join(paths.history, 'run-cohort-version-two-review.json');
    await atomicWriteJson(versionTwoFile, versionTwo);
    expect(versionTwo).toMatchObject({
      terminal_reason_taxonomy_version: 2,
      terminal_reason_code: 'review_remediation_exhausted',
    });
    const versionTwoBefore = await readFile(versionTwoFile, 'utf8');
    const replayedVersionTwo = await archiveRun(paths, terminalState(
      'run-cohort-version-two-review',
      {
        ...runVersionProvenance('codex'),
        mode: 'land',
        stage: 'review',
        remediation_cycles: 0,
        block_reason: 'land mode has no writing stage; revise the diff outside APE, then start a new land run',
      },
    ), { ifAbsent: true });
    expect(replayedVersionTwo).toMatchObject({
      terminal_reason_taxonomy_version: 2,
      terminal_reason_code: 'review_remediation_exhausted',
    });
    expect(terminalReasonCode(replayedVersionTwo)).toBe('review_remediation_exhausted');
    const explainedVersionTwo = await historyAction(dir, 'explain', {
      run_id: replayedVersionTwo.run_id,
    });
    expect(explainedVersionTwo.diagnostic.terminal_reason_code)
      .toBe('review_remediation_exhausted');
    expect(explainedVersionTwo.run.terminal_reason_code).toBe('review_remediation_exhausted');
    expect(await readFile(versionTwoFile, 'utf8')).toBe(versionTwoBefore);
    const legacy = await archiveRun(paths, terminalState('run-cohort-legacy', {
      block_reason: 'shipping failed: private provider output is retained only in immutable history',
    }));
    expect(legacy).not.toHaveProperty('ape_version');
    expect(legacy).not.toHaveProperty('terminal_reason_code');
    const legacyFile = path.join(paths.history, 'run-cohort-legacy.json');
    const legacyBefore = await readFile(legacyFile, 'utf8');

    const metrics = await calculateProjectMetrics(paths);
    expect(metrics.terminal_reason_counts).toMatchObject({
      planning_rejected: 1,
      test_contradiction: 1,
      review_remediation_exhausted: 2,
      shipping_failed: 1,
    });
    expect(metrics.terminal_reason_coverage).toEqual({
      taxonomy_version: TERMINAL_REASON_TAXONOMY_VERSION,
      persisted_runs: 4,
      derived_legacy_runs: 1,
    });
    expect(metrics.version_cohorts).toMatchObject({
      ape_version: { [APE_VERSION]: 4, unknown: 1 },
      runtime_version: { 2: 4, unknown: 1 },
      host_plugin_version: { [APE_VERSION]: 4, unknown: 1 },
      protocol_version: { [CODEX_DISPATCH_PROTOCOL_VERSION]: 4, unknown: 1 },
      envelope_version: { [CODEX_DISPATCH_ENVELOPE_VERSION]: 4, unknown: 1 },
      terminal_reason_taxonomy_version: {
        1: 1,
        2: 3,
        unknown: 1,
      },
    });
    expect(metrics.legacy_unknown).toMatchObject({
      ape_version: 1,
      runtime_version: 1,
      host_plugin_version: 1,
      protocol_version: 1,
      envelope_version: 1,
      terminal_reason_code: 1,
      terminal_reason_taxonomy_version: 2,
    });
    expect(await readFile(versionOneFile, 'utf8')).toBe(versionOneBefore);
    expect(await readFile(versionTwoFile, 'utf8')).toBe(versionTwoBefore);
    expect(await readFile(legacyFile, 'utf8')).toBe(legacyBefore);
  });

  it('filters terminal outcomes by exact release and protocol cohorts while treating Claude launch versions as not applicable', async () => {
    const dir = await sandbox('ape-versioned-filter-');
    const paths = runtimePaths(dir);
    await archiveRun(paths, terminalState('run-filter-current', {
      ...runVersionProvenance('codex'),
      stage: 'plan-judge',
      block_reason: 'plan judged unsound by the disagreement judge',
    }));
    await archiveRun(paths, terminalState('run-filter-next', {
      ...runVersionProvenance('codex'),
      ape_version: NEXT_APE_VERSION,
      host_plugin_version: NEXT_APE_VERSION,
      protocol_version: 'ape-codex-dispatch-v3',
      envelope_version: 3,
      stage: 'build',
      block_reason: 'stage build test-contradiction-blocked',
    }));
    await archiveRun(paths, terminalState('run-filter-claude', {
      ...runVersionProvenance('claude'),
      host: 'claude',
      status: 'completed',
      stage: 'completed',
      block_reason: undefined,
    }));

    const current = await calculateProjectMetrics(paths, { ape_version: APE_VERSION });
    expect(current.total_runs).toBe(2);
    expect(current.terminal_reason_counts).toMatchObject({ planning_rejected: 1, completed: 1 });

    const next = await historyAction(dir, 'metrics', {
      ape_version: NEXT_APE_VERSION,
      protocol_version: 'ape-codex-dispatch-v3',
      terminal_reason_code: 'test_contradiction',
    });
    expect(next.metrics.total_runs).toBe(1);
    expect(next.metrics.terminal_reason_counts).toMatchObject({ test_contradiction: 1 });

    const all = await calculateProjectMetrics(paths);
    expect(all.version_cohorts.protocol_version).toEqual({
      'ape-codex-dispatch-v2': 1,
      'ape-codex-dispatch-v3': 1,
      unknown: 0,
      not_applicable: 1,
      omitted_cohorts: 0,
      omitted_runs: 0,
    });
    expect(all.version_cohorts.envelope_version).toEqual({
      2: 1,
      3: 1,
      unknown: 0,
      not_applicable: 1,
      omitted_cohorts: 0,
      omitted_runs: 0,
    });
    expect(all.legacy_unknown.protocol_version).toBe(0);
    expect(all.legacy_unknown.envelope_version).toBe(0);
  });
});
