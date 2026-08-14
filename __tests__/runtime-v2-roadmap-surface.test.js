import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runtimePaths } from '../lib/runtime/paths.js';
import { historyAction, startRun, statusRun } from '../lib/runtime/service.js';
import { renderStatusDoc } from '../lib/runtime/status-doc.js';
import { archiveRun } from '../lib/runtime/history.js';
import { atomicWriteJson, readJson } from '../lib/runtime/storage.js';
import { finalizeReceipt, validateReceipt } from '../lib/runtime/schemas.js';

// Behavioral tests for the runtime service surfaces of the roadmap: the audited
// historyAction verbs (roadmap-register/supersede/status), statusRun's roadmap
// attachment, renderStatusDoc's roadmap section, the advances-vs-completes run
// wiring, cold-boot provenance, and RM7 byte-identical absence. Expectations are
// derived from the public contract, not any implementation.
const cleanups = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function plainDir() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-roadmap-surface-'));
  cleanups.push(dir);
  return dir;
}

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

async function gitProject() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-roadmap-surface-git-'));
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

// A mechanical run needs no test-writer stage, so it starts without test paths.
function mechanicalStart(overrides = {}) {
  return {
    objective: 'Advance a roadmap requirement',
    mode: 'phase',
    lane: 'mechanical',
    host: 'codex',
    claimed_paths: ['docs/note.md'],
    test_paths: [],
    requirements: ['R1'],
    risk_triggers: [],
    behavioral: false,
    hooks_trusted: true,
    subagents_available: true,
    explicit_invocation: true,
    ...overrides,
  };
}

function inputEntry(id, overrides = {}) {
  return {
    id,
    title: `Title ${id}`,
    description: `Description ${id}`,
    acceptance: `Acceptance ${id}`,
    depends_on: [],
    ...overrides,
  };
}

function storedEntry(id, overrides = {}) {
  return {
    id,
    title: `Title ${id}`,
    description: `Description ${id}`,
    acceptance: `Acceptance ${id}`,
    depends_on: [],
    discovered_by: 'operator',
    audit: [{ op: 'register', at: '2026-07-01T00:00:00.000Z', reason: 'seed' }],
    ...overrides,
  };
}

async function seedRoadmap(paths, entries) {
  await atomicWriteJson(path.join(paths.runtime, 'roadmap.json'), {
    schema_version: '2.0.0',
    entries,
  });
}

function runningRun(runId, requirements) {
  return {
    version: 2,
    schema_version: '2.0.0',
    run_id: runId,
    status: 'running',
    stage: 'build',
    objective: 'in flight',
    mode: 'phase',
    lane: 'fast',
    requirements,
    claimed_paths: [],
    test_paths: [],
    tickets: [],
    receipts: [],
    attempts: {},
    created_at: '2026-07-10T00:00:00.000Z',
    updated_at: '2026-07-10T00:00:00.000Z',
  };
}

function archivedRun(runId, { requirements, completes, status = 'completed', ...rest }) {
  return {
    run_id: runId,
    objective: `serve ${requirements.join(',')}`,
    mode: 'phase',
    lane: 'fast',
    requirements,
    ...(completes !== undefined ? { completes } : {}),
    status,
    block_reason: null,
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:01:00.000Z',
    terminal_at: '2026-07-01T00:01:00.000Z',
    base_commit_sha: 'a'.repeat(40),
    tree_sha: 'b'.repeat(40),
    tickets: [],
    receipts: [],
    ...rest,
  };
}

function receiptWithFollowups(roadmap_followups) {
  return {
    schema_version: '2.0.0',
    receipt_id: 'receipt-roadmap-followups',
    run_id: 'run-roadmap-followups',
    ticket_id: 'ticket-roadmap-followups',
    ticket_hash: 'a'.repeat(64),
    agent: { host: 'codex', role: 'implementer', identity: 'agent', model: null },
    status: 'passed',
    base_tree_sha: 'a'.repeat(40),
    head_tree_sha: 'b'.repeat(40),
    changed_files: [],
    tests: [],
    findings: [],
    evidence: { roadmap_followups },
    timing: {
      started_at: '2026-07-01T00:00:00.000Z',
      completed_at: '2026-07-01T00:00:01.000Z',
      duration_ms: 1000,
    },
    previous_receipt_hash: null,
  };
}

async function readNdjson(file) {
  const text = await readFile(file, 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

describe('APE v2 roadmap service verbs (historyAction)', () => {
  it('roadmap-status returns roadmap null when absent and creates no file (RM5/RM7)', async () => {
    const dir = await plainDir();
    const paths = runtimePaths(dir);
    const result = await historyAction(dir, 'roadmap-status', {});
    expect(result).toEqual({ ok: true, roadmap: null });
    // Read-only: querying an absent roadmap never spontaneously creates one.
    await expect(readJson(path.join(paths.runtime, 'roadmap.json'), null)).resolves.toBeNull();
  });

  it('roadmap-status returns the full derived roadmap from state alone (cold-boot, RM5)', async () => {
    const dir = await plainDir();
    const paths = runtimePaths(dir);
    await seedRoadmap(paths, [storedEntry('RM1', { discovered_by: 'run-fixture-e6a93fe596c1' })]);

    const result = await historyAction(dir, 'roadmap-status', {});
    expect(result.ok).toBe(true);
    expect(result.roadmap).toBeTruthy();
    expect(result.roadmap.schema_version).toBe('2.0.0');
    expect(result.roadmap.counts).toBeTruthy();
    const entry = result.roadmap.entries.find((candidate) => candidate.id === 'RM1');
    expect(entry).toBeTruthy();
    // Provenance survives to the cold-boot surface with no session context.
    expect(entry.discovered_by).toBe('run-fixture-e6a93fe596c1');
  });

  it('roadmap-register persists the store and appends an audit line', async () => {
    const dir = await plainDir();
    const paths = runtimePaths(dir);
    const result = await historyAction(dir, 'roadmap-register', {
      entries: [inputEntry('RM1'), inputEntry('RM2')],
      reason: 'seed via service',
    });
    expect(result.ok).toBe(true);

    const stored = await readJson(path.join(paths.runtime, 'roadmap.json'));
    expect(stored.entries.map((entry) => entry.id).sort()).toEqual(['RM1', 'RM2']);

    const lines = await readNdjson(paths.overrideLog);
    expect(lines.some((line) => line.operation === 'roadmap-register' && line.reason === 'seed via service')).toBe(true);
  });

  it('roadmap-supersede marks an entry stale and audits it', async () => {
    const dir = await plainDir();
    const paths = runtimePaths(dir);
    await historyAction(dir, 'roadmap-register', {
      entries: [inputEntry('RM1'), inputEntry('RM2')],
      reason: 'seed',
    });

    const result = await historyAction(dir, 'roadmap-supersede', {
      ids: ['RM1'],
      reason: 'redesigned',
      replaced_by: ['RM2'],
    });
    expect(result.ok).toBe(true);

    const stored = await readJson(path.join(paths.runtime, 'roadmap.json'));
    const rm1 = stored.entries.find((entry) => entry.id === 'RM1');
    expect(rm1.superseded).toBeTruthy();
    expect(rm1.superseded.reason).toBe('redesigned');

    const lines = await readNdjson(paths.overrideLog);
    expect(lines.some((line) => line.operation === 'roadmap-supersede' && line.reason === 'redesigned')).toBe(true);
  });
});

describe('APE v2 roadmap status surfaces (statusRun / renderStatusDoc)', () => {
  it('statusRun attaches a roadmap key only when roadmap.json exists (RM5/RM7)', async () => {
    const dir = await plainDir();
    const paths = runtimePaths(dir);
    await atomicWriteJson(paths.active, runningRun('run-live', ['RM1']));

    // RM7: absent roadmap -> response shape is byte-identical to today.
    const before = await statusRun(dir);
    expect(before).not.toHaveProperty('roadmap');

    await seedRoadmap(paths, [storedEntry('RM1')]);
    const after = await statusRun(dir);
    expect(after.roadmap).toBeTruthy();
    expect(after.roadmap.entries.some((entry) => entry.id === 'RM1')).toBe(true);
  });

  it('renderStatusDoc appends a Roadmap section only for a non-null roadmap (RM5/RM7)', () => {
    const state = {
      mode: 'phase',
      lane: 'fast',
      status: 'running',
      stage: 'build',
      objective: 'Do the thing',
      branch: 'ape/phase-x',
      tickets: [],
      receipts: [],
    };
    const roadmap = {
      schema_version: '2.0.0',
      counts: { satisfied: 1, in_progress: 0, ready: 0, pending: 0, stale: 0 },
      entries: [{ id: 'RM1', title: 'First', status: 'satisfied', discovered_by: 'operator', depends_on: [] }],
    };

    const withRoadmap = renderStatusDoc(state, { roadmap });
    expect(withRoadmap).toContain('## Roadmap');
    expect(withRoadmap).toContain('RM1');

    // RM7 byte-identity: no roadmap -> no section, and identical output.
    const plain = renderStatusDoc(state);
    expect(plain).not.toContain('## Roadmap');
    expect(renderStatusDoc(state, { roadmap: null })).toBe(plain);
  });
});

describe('APE v2 roadmap advances-vs-completes wiring (RM2)', () => {
  it('startRun accepts a completes subset of requirements and threads it onto the run', async () => {
    const dir = await gitProject();
    const started = await startRun(dir, mechanicalStart({ requirements: ['R1'], completes: ['R1'] }));
    expect(started.ok).toBe(true);
    expect(started.run.completes).toEqual(['R1']);
  });

  it('startRun rejects a completes that is not a subset of requirements', async () => {
    const dir = await gitProject();
    await expect(
      startRun(dir, mechanicalStart({ requirements: ['R1'], completes: ['R2'] })),
    ).rejects.toThrow(/subset/i);
  });

  it('threads a non-empty completes into the archived immutable record', async () => {
    const dir = await plainDir();
    const paths = runtimePaths(dir);
    const record = await archiveRun(paths, archivedRun('run-c', { requirements: ['R1'], completes: ['R1'] }));
    expect(record.completes).toEqual(['R1']);
  });

  it('omits completes from the record when empty, keeping record_hash unchanged (omitted-key)', async () => {
    const none = await archiveRun(runtimePaths(await plainDir()), archivedRun('run-x', { requirements: ['R1'] }));
    const empty = await archiveRun(runtimePaths(await plainDir()), archivedRun('run-x', { requirements: ['R1'], completes: [] }));
    expect(none).not.toHaveProperty('completes');
    expect(empty).not.toHaveProperty('completes');
    expect(empty.record_hash).toBe(none.record_hash);
  });

  it('a non-empty completes participates in record_hash (it is run content)', async () => {
    const none = await archiveRun(runtimePaths(await plainDir()), archivedRun('run-y', { requirements: ['R1'] }));
    const withCompletes = await archiveRun(runtimePaths(await plainDir()), archivedRun('run-y', { requirements: ['R1'], completes: ['R1'] }));
    expect(withCompletes.record_hash).not.toBe(none.record_hash);
  });
});

describe('APE v2 roadmap prerequisite admission', () => {
  it('rejects a roadmap target whose dependency is pending before branch or lock mutation', async () => {
    const dir = await gitProject();
    const paths = runtimePaths(dir);
    await seedRoadmap(paths, [storedEntry('parent'), storedEntry('child', { depends_on: ['parent'] })]);
    const branch = git(dir, 'branch', '--show-current');
    await expect(startRun(dir, mechanicalStart({ requirements: ['child'], completes: ['child'] })))
      .rejects.toThrow(/child.*parent.*ready.*satisfied/);
    expect(git(dir, 'branch', '--show-current')).toBe(branch);
    await expect(readJson(paths.active, null)).resolves.toBeNull();
  });

  it('rejects stale roadmap targets with the exact target id', async () => {
    const dir = await gitProject();
    const paths = runtimePaths(dir);
    await seedRoadmap(paths, [storedEntry('old', {
      superseded: { at: '2026-07-01T00:00:00.000Z', reason: 'obsolete', replaced_by: [] },
    })]);
    await expect(startRun(dir, mechanicalStart({ requirements: ['old'] })))
      .rejects.toThrow(/stale target old/);
  });

  it('allows a target only after its dependency has an effective completed run that declared completes', async () => {
    const dir = await gitProject();
    const paths = runtimePaths(dir);
    await seedRoadmap(paths, [storedEntry('parent'), storedEntry('child', { depends_on: ['parent'] })]);
    await archiveRun(paths, archivedRun('run-parent', {
      requirements: ['parent'], completes: ['parent'], status: 'completed',
    }));
    const started = await startRun(dir, mechanicalStart({ requirements: ['child'], completes: ['child'] }));
    expect(started.ok).toBe(true);
    expect(started.run.requirements).toEqual(['child']);
  });

  it('continues allowing ordinary requirement ids when a roadmap exists', async () => {
    const dir = await gitProject();
    const paths = runtimePaths(dir);
    await seedRoadmap(paths, [storedEntry('roadmap-only')]);
    const started = await startRun(dir, mechanicalStart({ requirements: ['ordinary-ticket'] }));
    expect(started.ok).toBe(true);
  });
});

describe('APE v2 receipt roadmap follow-up declarations', () => {
  it('normalizes omitted depends_on into the hash-chained receipt', () => {
    const receipt = finalizeReceipt(receiptWithFollowups([{
      id: 'follow-up',
      title: 'Follow up',
      description: 'Do the follow-up',
      acceptance: 'It is complete',
    }]));
    expect(receipt.evidence.roadmap_followups[0].depends_on).toEqual([]);
    expect(validateReceipt(receipt).valid).toBe(true);
  });

  it.each([
    [{ ...inputEntry('bad'), status: 'ready' }, /unrecognized key|status/i],
    [{ ...inputEntry('bad'), discovered_by: 'run-forged' }, /unrecognized key|discovered_by/i],
  ])('rejects forbidden proposal fields before receipt acceptance', (proposal, message) => {
    expect(() => finalizeReceipt(receiptWithFollowups([proposal]))).toThrow(message);
  });

  it('bounds the proposal array', () => {
    expect(() => finalizeReceipt(receiptWithFollowups(
      Array.from({ length: 65 }, (_, index) => inputEntry(`follow-${index}`)),
    ))).toThrow(/too_big|64|array/i);
  });
});

describe('APE v2 roadmap zero-friction absence (RM7)', () => {
  it('a roadmap-less run creates no roadmap.json and surfaces no roadmap anywhere', async () => {
    const dir = await gitProject();
    const paths = runtimePaths(dir);
    const started = await startRun(dir, mechanicalStart({ requirements: ['R1'] }));
    expect(started.ok).toBe(true);

    const status = await statusRun(dir);
    expect(status).not.toHaveProperty('roadmap');

    await expect(readJson(path.join(paths.runtime, 'roadmap.json'), null)).resolves.toBeNull();

    const statusDoc = await readFile(path.join(paths.runtime, 'status.md'), 'utf8').catch(() => '');
    expect(statusDoc).not.toContain('## Roadmap');
  });
});
