import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { importLegacyPlanning } from '../lib/runtime/importer.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { archiveRun, explainRun, queryHistory } from '../lib/runtime/history.js';
import { projectHistoryResponse, summarizeHistoryRecord } from '../lib/runtime/projection.js';
import { abortRun, historyAction, startRun } from '../lib/runtime/service.js';
import { readJson } from '../lib/runtime/storage.js';

const cleanups = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('APE v2 machine history', () => {
  it('does not add structured-plan defaults or rewrite a legacy record hash', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ape-history-plan-compat-'));
    cleanups.push(dir);
    const record = await archiveRun(runtimePaths(dir), {
      run_id: 'run-legacy-plan-hash',
      objective: 'Legacy plan hash stays stable',
      mode: 'phase',
      lane: 'fast',
      requirements: ['R1'],
      status: 'completed',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:01:00.000Z',
      terminal_at: '2026-01-01T00:01:00.000Z',
      base_commit_sha: 'a'.repeat(40),
      tree_sha: 'b'.repeat(40),
      tickets: [],
      receipts: [],
    });
    expect(record).not.toHaveProperty('plan_contract_version');
    expect(record).not.toHaveProperty('approved_plan');
    expect(record.record_hash).toBe('1b93ec2108be7965eb2edc894df4d23107c9c95825f6a3045ef87753c8aa9885');
  });

  it('indexes requirements to immutable run records', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ape-history-'));
    cleanups.push(dir);
    const paths = runtimePaths(dir);
    const state = {
      run_id: 'run-1',
      objective: 'Ship it',
      mode: 'phase',
      lane: 'fast',
      requirements: ['R1'],
      status: 'completed',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:01:00.000Z',
      base_commit_sha: 'a'.repeat(40),
      tree_sha: 'b'.repeat(40),
      tickets: [],
      receipts: [],
    };
    const first = await archiveRun(paths, state);
    const second = await archiveRun(paths, state);
    expect(second.record_hash).toBe(first.record_hash);
    expect(await queryHistory(paths, { requirement: 'R1' })).toHaveLength(1);
  });

  it('imports and verifies machine-owned legacy files while retaining research', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ape-import-'));
    cleanups.push(dir);
    const planning = path.join(dir, '.planning', 'phases', '01-example');
    await mkdir(planning, { recursive: true });
    await writeFile(path.join(planning, '01-01-PLAN.md'), '# R1 plan\nEvidence: report.json\n');
    await writeFile(path.join(planning, 'RESEARCH.md'), '# R1 research\n');
    const paths = runtimePaths(dir);
    const imported = await importLegacyPlanning(dir, paths, { delete_legacy: true });
    expect(imported.source_count).toBe(2);
    await expect(readFile(path.join(planning, '01-01-PLAN.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(path.join(planning, 'RESEARCH.md'), 'utf8')).toMatch(/research/);
  });
});

function terminalState(overrides = {}) {
  return {
    schema_version: '2.0.0',
    run_id: 'run-effective',
    objective: 'Recover the gate block',
    mode: 'phase',
    lane: 'mechanical',
    host: 'codex',
    requirements: ['R-effective'],
    status: 'blocked',
    stage: 'review',
    dispatch_state: 'none',
    block_reason: 'one or more deterministic merge gates failed',
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:01:00.000Z',
    terminal_at: '2026-07-01T00:01:00.000Z',
    base_commit_sha: 'a'.repeat(40),
    tree_sha: 'b'.repeat(40),
    tickets: [],
    receipts: [],
    ...overrides,
  };
}

describe('APE v2 history effective records (superseding completions)', () => {
  it('collapses a superseded run to its completed record in the unfiltered listing', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ape-history-effective-'));
    cleanups.push(dir);
    const paths = runtimePaths(dir);
    const block = await archiveRun(paths, terminalState());
    await archiveRun(
      paths,
      terminalState({
        status: 'completed',
        stage: 'completed',
        terminal_at: '2026-07-01T01:00:00.000Z',
        tree_sha: 'c'.repeat(40),
        merge: {
          provider: 'github',
          url: 'https://github.com/acme/repo/pull/9',
          branch: 'ape/phase-effective',
          base: 'main',
          merged_at: '2026-07-01T01:00:00.000Z',
        },
      }),
      { superseding: true },
    );

    const records = await queryHistory(paths, {});
    expect(records).toHaveLength(1);
    expect(records[0].status).toBe('completed');
    expect(records[0].supersedes).toBe(block.record_hash);
    expect(records[0].merge?.url).toBe('https://github.com/acme/repo/pull/9');
  });

  it('selects the completed record when a failed-ship superseding record also exists', async () => {
    // Supersession is a STAR: after hold -> failed ship -> re-gate -> completion,
    // TWO superseding records reference the same block record, and their
    // readdir order is hash-alphabetical — the listing must still pick the
    // completed one.
    const dir = await mkdtemp(path.join(tmpdir(), 'ape-history-star-'));
    cleanups.push(dir);
    const paths = runtimePaths(dir);
    await archiveRun(paths, terminalState());
    await archiveRun(
      paths,
      terminalState({
        status: 'blocked',
        block_reason: 'shipping failed: remote rejected the push',
        terminal_at: '2026-07-01T00:30:00.000Z',
        tree_sha: 'd'.repeat(40),
      }),
      { superseding: true },
    );
    await archiveRun(
      paths,
      terminalState({
        status: 'completed',
        stage: 'completed',
        terminal_at: '2026-07-01T01:00:00.000Z',
        tree_sha: 'c'.repeat(40),
        merge: {
          provider: 'github',
          url: 'https://github.com/acme/repo/pull/9',
          branch: 'ape/phase-effective',
          base: 'main',
          merged_at: '2026-07-01T01:00:00.000Z',
        },
      }),
      { superseding: true },
    );

    const records = await queryHistory(paths, {});
    expect(records).toHaveLength(1);
    expect(records[0].status).toBe('completed');
    expect(records[0].merge?.url).toBe('https://github.com/acme/repo/pull/9');
  });

  it('explain renders the effective record and names the supersession', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ape-history-explain-'));
    cleanups.push(dir);
    const paths = runtimePaths(dir);
    await archiveRun(paths, terminalState());
    await archiveRun(
      paths,
      terminalState({
        status: 'completed',
        stage: 'completed',
        terminal_at: '2026-07-01T01:00:00.000Z',
        tree_sha: 'c'.repeat(40),
        merge: {
          provider: 'github',
          url: 'https://github.com/acme/repo/pull/9',
          branch: 'ape/phase-effective',
          base: 'main',
          merged_at: '2026-07-01T01:00:00.000Z',
        },
      }),
      { superseding: true },
    );

    const explained = await historyAction(dir, 'explain', { run_id: 'run-effective' });
    // Both the rendered text and bounded run summary identify the effective
    // record; the immutable full record stays in history rather than crossing
    // the default explain boundary.
    expect(explained).not.toHaveProperty('record');
    expect(explained.run).toMatchObject({ run_id: 'run-effective', status: 'completed' });
    expect(explained.diagnostic).toMatchObject({
      reason_code: 'completed',
      next_safe_action: 'check host prerequisites, then ape_run start',
    });
    expect(explained.text).toContain('Status: completed');
    expect(explained.text).toContain('Merged:');
    expect(explained.text).not.toContain('github.com/acme/repo');
    expect(explained.text).toMatch(/supersedes this run's block-time record/i);
    expect(explained.text).not.toContain('Merge: not recorded');
  });
});

describe('APE v2 cross-run supersession (friction #10)', () => {
  function git(cwd, ...args) {
    execFileSync('git', args, { cwd, encoding: 'utf8' });
  }

  async function gitProject() {
    const dir = await mkdtemp(path.join(tmpdir(), 'ape-history-supersedes-run-'));
    cleanups.push(dir);
    await mkdir(path.join(dir, 'docs'));
    await writeFile(path.join(dir, 'docs', 'note.md'), '# note\n');
    git(dir, 'init', '-q');
    git(dir, 'config', 'user.email', 'ape@example.test');
    git(dir, 'config', 'user.name', 'APE Test');
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'baseline');
    return dir;
  }

  function mechanicalStart(overrides = {}) {
    return {
      objective: 'Converge the abandoned run',
      mode: 'phase',
      lane: 'mechanical',
      host: 'codex',
      claimed_paths: ['docs/note.md'],
      test_paths: [],
      requirements: ['R-10'],
      risk_triggers: [],
      behavioral: false,
      hooks_trusted: true,
      subagents_available: true,
      explicit_invocation: true,
      ...overrides,
    };
  }

  it('a start-declared supersedes_run rides state, record, summary, and explain', async () => {
    const dir = await gitProject();
    const abandoned = 'run-fixture-90fa0cf809dd';
    const started = await startRun(dir, mechanicalStart({ supersedes_run: abandoned }));
    expect(started.ok).toBe(true);
    expect(started.run.supersedes_run).toBe(abandoned);

    // Abort archives the run; the immutable record carries the marker.
    const aborted = await abortRun(dir, 'exercise the supersession round-trip');
    expect(aborted.ok).toBe(true);
    const paths = runtimePaths(dir);
    const record = await readJson(path.join(paths.history, `${started.run.run_id}.json`));
    expect(record.supersedes_run).toBe(abandoned);

    // The wire summary keeps the collapse signal, and explain names it.
    expect(summarizeHistoryRecord(record).supersedes_run).toBe(abandoned);
    expect(explainRun(record)).toContain(`Supersedes abandoned run ${abandoned}`);
  });

  it('surfaces an aborted run reason through history query and explain after a later run becomes active', async () => {
    const dir = await gitProject();
    const abortReason = 'operator cancelled: history reason regression';
    const first = await startRun(dir, mechanicalStart({ objective: 'Abort me first' }));
    expect(first.ok).toBe(true);

    const aborted = await abortRun(dir, abortReason);
    expect(aborted.ok).toBe(true);
    const second = await startRun(dir, mechanicalStart({ objective: 'Replacement active run' }));
    expect(second.ok).toBe(true);

    const queried = projectHistoryResponse(await historyAction(dir, 'query', { run_id: first.run.run_id }));
    expect(queried.records).toHaveLength(1);
    expect(queried.records[0]).toMatchObject({
      run_id: first.run.run_id,
      status: 'aborted',
      abort_reason: abortReason,
    });
    expect(queried.records[0].run_id).not.toBe(second.run.run_id);

    const explained = await historyAction(dir, 'explain', { run_id: first.run.run_id });
    expect(explained).not.toHaveProperty('record');
    expect(explained.run).toMatchObject({ run_id: first.run.run_id, status: 'aborted' });
    expect(explained.diagnostic).toMatchObject({
      reason_code: 'aborted',
      next_safe_action: 'check host prerequisites, then ape_run start',
    });
    expect(JSON.stringify(explained)).not.toContain(abortReason);
  });

  it('rejects a malformed supersedes_run at the start schema', async () => {
    const dir = await gitProject();
    await expect(
      startRun(dir, mechanicalStart({ supersedes_run: 'not a run id' })),
    ).rejects.toThrow(/supersedes_run/);
  });
});

describe('APE v2 terminal record timing provenance (T14)', () => {
  it('archives a runtime-measured timing block (raw_ms/test_ms/remote_ci_ms) and host on a timed terminal state', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ape-history-timing-'));
    cleanups.push(dir);
    const paths = runtimePaths(dir);
    // A terminal state that carries the host it ran under and the runtime's OWN
    // accumulated wall-clock measurements (test_ms from gate/red-test runs,
    // remote_ci_ms from the shipping watch).
    const record = await archiveRun(paths, terminalState({
      host: 'claude',
      timing: { test_ms: 4_321, remote_ci_ms: 65_000 },
    }));
    expect(record.host).toBe('claude');
    expect(record.timing).toBeDefined();
    // raw_ms is derived from created_at -> completed_at (the stable terminal
    // stamp), here 2026-07-01T00:00:00 -> 00:01:00.
    expect(record.timing.raw_ms).toBe(60_000);
    expect(record.timing.test_ms).toBe(4_321);
    expect(record.timing.remote_ci_ms).toBe(65_000);
  });

  it('keeps record_hash invariant when re-archiving with a different terminal_at and timing (first-write-wins on the timing block)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ape-history-timing-idem-'));
    cleanups.push(dir);
    const paths = runtimePaths(dir);
    const first = await archiveRun(paths, terminalState({
      host: 'claude',
      timing: { test_ms: 1_000, remote_ci_ms: 2_000 },
    }));
    // A crash between archive_history and persist_state loses the terminal
    // stamp and the in-memory timing; the retried terminal transition re-stamps
    // a later terminal_at and re-measures. Because completed_at AND the timing
    // block are wall-clock provenance excluded from record_hash, the content
    // hash is unchanged and the first write wins on disk.
    const retried = await archiveRun(paths, terminalState({
      host: 'claude',
      terminal_at: '2026-07-01T09:09:09.000Z',
      updated_at: '2026-07-01T09:09:09.000Z',
      timing: { test_ms: 999_999, remote_ci_ms: 888_888 },
    }));
    expect(retried.record_hash).toBe(first.record_hash);
    const onDisk = await readJson(path.join(paths.history, 'run-effective.json'));
    expect(onDisk.completed_at).toBe('2026-07-01T00:01:00.000Z');
    expect(onDisk.timing.test_ms).toBe(1_000);
    expect(onDisk.timing.remote_ci_ms).toBe(2_000);
  });
});

describe('APE v2 unfiltered history degrades on a corrupt/schema-invalid active.json (follow-up 1)', () => {
  // The unfiltered listing prepends the live run as an active stub whose PINNED
  // shape is { run_id, status, active: true } (the valid-active case). A present
  // active.json that JSON.parse cannot read (corrupt bytes) today throws a raw
  // SyntaxError out of queryHistory, and one that parses but is NOT a run state
  // (a non-object like 42, or an object with no string run_id like {}) today
  // yields an undefined-field stub { run_id: undefined, status: undefined,
  // active: true }. Both are the same defect class: the listing must instead
  // RESOLVE and degrade truthfully to a corrupt-state stub that keeps the SAME
  // shape with run_id 'unknown' and status 'corrupt_state' (mirroring statusRun's
  // structured corrupt_state diagnosis), still reserving the active slot and
  // still listing every archived record after it.
  const CORRUPT_STATE_STUB = { run_id: 'unknown', status: 'corrupt_state', active: true };

  // Reuse the module's temp-project/paths fixtures and terminalState() record so
  // the assertion isolates the active-stub behavior: one archived blocked record
  // plus whatever bytes we plant into active.json.
  async function historyWithActive(activeBytes) {
    const dir = await mkdtemp(path.join(tmpdir(), 'ape-history-corrupt-active-'));
    cleanups.push(dir);
    const paths = runtimePaths(dir);
    const archived = await archiveRun(paths, terminalState());
    await mkdir(paths.runtime, { recursive: true });
    await writeFile(paths.active, activeBytes);
    return { paths, archived };
  }

  it('resolves with the corrupt-state stub (never a SyntaxError) when active.json is corrupt bytes', async () => {
    const { paths } = await historyWithActive('{not json');

    // Must not reject: the corrupt live slot cannot make the whole archive
    // unreadable.
    const records = await queryHistory(paths, {});
    expect(records).toHaveLength(2);
    expect(records[0]).toEqual(CORRUPT_STATE_STUB);
    // The archived record is still listed after the stub, unchanged.
    expect(records[1].run_id).toBe('run-effective');
    expect(records[1].status).toBe('blocked');
  });

  it('resolves with the corrupt-state stub when active.json is parseable but schema-invalid ({})', async () => {
    const { paths } = await historyWithActive('{}');

    const records = await queryHistory(paths, {});
    expect(records).toHaveLength(2);
    // Not the pre-fix undefined-field stub: the degraded slot names the defect.
    expect(records[0]).toEqual(CORRUPT_STATE_STUB);
    expect(records[0].run_id).toBe('unknown');
    expect(records[0].status).toBe('corrupt_state');
    expect(records[1].run_id).toBe('run-effective');
  });

  it('resolves with the corrupt-state stub when active.json parses to a non-object (42)', async () => {
    const { paths } = await historyWithActive('42');

    const records = await queryHistory(paths, {});
    expect(records).toHaveLength(2);
    expect(records[0]).toEqual(CORRUPT_STATE_STUB);
    expect(records[1].run_id).toBe('run-effective');
    expect(records[1].status).toBe('blocked');
  });
});
