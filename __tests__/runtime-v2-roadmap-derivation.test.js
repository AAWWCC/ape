import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runtimePaths } from '../lib/runtime/paths.js';
import { archiveRun } from '../lib/runtime/history.js';
import { atomicWriteJson } from '../lib/runtime/storage.js';

// Behavioral tests for RM2 derived status. Status is computed at read time from
// the roadmap store, the requirement index + history, and any active run — never
// stored. Expectations are derived from the public contract; the missing
// `deriveRoadmap` export is the red. The roadmap store is written directly in
// its documented shape so these tests isolate the DERIVATION, while history is
// built through the real archiveRun so the effective-record semantics
// (completed-over-blocked, supersession star) are exercised end to end.
const importRoadmap = () => import('../lib/runtime/roadmap.js');

const cleanups = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempPaths() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-roadmap-derive-'));
  cleanups.push(dir);
  return runtimePaths(dir);
}

// A stored roadmap entry in the documented on-disk shape.
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

// A terminal run record shape archiveRun accepts. `completes` is omitted unless
// explicitly provided so a "legacy" record carries no completes key at all.
function archivedRun(runId, { requirements, completes, status = 'completed', ...rest }) {
  return {
    run_id: runId,
    objective: `serve ${requirements.join(',')}`,
    mode: 'phase',
    lane: 'fast',
    requirements,
    ...(completes !== undefined ? { completes } : {}),
    status,
    block_reason: status === 'blocked' ? 'one or more deterministic merge gates failed' : null,
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

async function derive(paths, options) {
  const { deriveRoadmap } = await importRoadmap();
  return deriveRoadmap(paths, options);
}

function statusOf(roadmap, id) {
  const entry = roadmap.entries.find((candidate) => candidate.id === id);
  return entry ? entry.status : undefined;
}

describe('APE v2 roadmap derivation — satisfaction (RM2)', () => {
  it('is satisfied when a completed run declares the id complete', async () => {
    const paths = await tempPaths();
    await seedRoadmap(paths, [storedEntry('RM1')]);
    await archiveRun(paths, archivedRun('run-rm1', { requirements: ['RM1'], completes: ['RM1'] }));

    const roadmap = await derive(paths);
    expect(statusOf(roadmap, 'RM1')).toBe('satisfied');
  });

  it('does NOT satisfy when a completed run advances the id but does not complete it', async () => {
    const paths = await tempPaths();
    await seedRoadmap(paths, [storedEntry('RM2')]);
    await archiveRun(paths, archivedRun('run-rm2', { requirements: ['RM2'], completes: [] }));

    const roadmap = await derive(paths);
    expect(statusOf(roadmap, 'RM2')).not.toBe('satisfied');
    // Not satisfied, no dependencies -> ready.
    expect(statusOf(roadmap, 'RM2')).toBe('ready');
  });

  it('never satisfies from a legacy completed record that has no completes array', async () => {
    const paths = await tempPaths();
    await seedRoadmap(paths, [storedEntry('RM-legacy')]);
    await archiveRun(paths, archivedRun('run-legacy', { requirements: ['RM-legacy'] }));

    const roadmap = await derive(paths);
    expect(statusOf(roadmap, 'RM-legacy')).not.toBe('satisfied');
  });

  it('satisfies from whichever serving run completes the id (no early flip across runs)', async () => {
    const paths = await tempPaths();
    await seedRoadmap(paths, [storedEntry('RM-m')]);
    await archiveRun(paths, archivedRun('run-a', { requirements: ['RM-m'], completes: [] }));
    await archiveRun(paths, archivedRun('run-b', { requirements: ['RM-m'], completes: ['RM-m'] }));

    const roadmap = await derive(paths);
    expect(statusOf(roadmap, 'RM-m')).toBe('satisfied');
  });

  it('uses the effective record (completed over blocked, supersession star) to satisfy', async () => {
    const paths = await tempPaths();
    await seedRoadmap(paths, [storedEntry('RM-eff')]);
    await archiveRun(paths, archivedRun('run-eff', { requirements: ['RM-eff'], status: 'blocked' }));
    await archiveRun(
      paths,
      archivedRun('run-eff', {
        requirements: ['RM-eff'],
        completes: ['RM-eff'],
        status: 'completed',
        terminal_at: '2026-07-01T02:00:00.000Z',
        tree_sha: 'c'.repeat(40),
      }),
      { superseding: true },
    );

    const roadmap = await derive(paths);
    expect(statusOf(roadmap, 'RM-eff')).toBe('satisfied');
  });

  it('inventories history once for every serving run (bounded listing regression)', async () => {
    const paths = await tempPaths();
    const entries = [];
    for (let index = 0; index < 40; index += 1) {
      const id = `RM-bulk-${index}`;
      entries.push(storedEntry(id));
      await archiveRun(
        paths,
        archivedRun(`run-bulk-${index}`, { requirements: [id], completes: [id] }),
      );
    }
    await seedRoadmap(paths, entries);
    const historyMetrics = {};

    const roadmap = await derive(paths, { historyMetrics });

    expect(roadmap.counts.satisfied).toBe(40);
    expect(historyMetrics.directory_listings).toBe(1);
    expect(historyMetrics.records_read).toBe(40);
  });
});

describe('APE v2 roadmap derivation — in_progress and precedence (RM2)', () => {
  it('is in_progress when the active run references the id', async () => {
    const paths = await tempPaths();
    await seedRoadmap(paths, [storedEntry('RM3')]);
    await atomicWriteJson(paths.active, runningRun('run-active', ['RM3']));

    const roadmap = await derive(paths);
    expect(statusOf(roadmap, 'RM3')).toBe('in_progress');
  });

  it('prefers satisfied over in_progress', async () => {
    const paths = await tempPaths();
    await seedRoadmap(paths, [storedEntry('RM4')]);
    await archiveRun(paths, archivedRun('run-done', { requirements: ['RM4'], completes: ['RM4'] }));
    await atomicWriteJson(paths.active, runningRun('run-live', ['RM4']));

    const roadmap = await derive(paths);
    expect(statusOf(roadmap, 'RM4')).toBe('satisfied');
  });
});

describe('APE v2 roadmap derivation — readiness and dependencies (RM2)', () => {
  it('is ready when every dependency is satisfied', async () => {
    const paths = await tempPaths();
    await seedRoadmap(paths, [storedEntry('RM-dep'), storedEntry('RM-ready', { depends_on: ['RM-dep'] })]);
    await archiveRun(paths, archivedRun('run-dep', { requirements: ['RM-dep'], completes: ['RM-dep'] }));

    const roadmap = await derive(paths);
    expect(statusOf(roadmap, 'RM-dep')).toBe('satisfied');
    expect(statusOf(roadmap, 'RM-ready')).toBe('ready');
  });

  it('is pending when a dependency is unsatisfied', async () => {
    const paths = await tempPaths();
    await seedRoadmap(paths, [storedEntry('RM-dep2'), storedEntry('RM-pend', { depends_on: ['RM-dep2'] })]);

    const roadmap = await derive(paths);
    expect(statusOf(roadmap, 'RM-dep2')).toBe('ready');
    expect(statusOf(roadmap, 'RM-pend')).toBe('pending');
  });

  it('treats a dependency on an unknown entry as unmet (pending)', async () => {
    const paths = await tempPaths();
    await seedRoadmap(paths, [storedEntry('RM-x', { depends_on: ['RM-ghost'] })]);

    const roadmap = await derive(paths);
    expect(statusOf(roadmap, 'RM-x')).toBe('pending');
  });

  it('treats a dependency on a superseded entry as unmet (pending)', async () => {
    const paths = await tempPaths();
    await seedRoadmap(paths, [
      storedEntry('RM-dep3', {
        superseded: { at: '2026-07-01T00:00:00.000Z', reason: 'obsolete', replaced_by: [] },
      }),
      storedEntry('RM-usedep', { depends_on: ['RM-dep3'] }),
    ]);

    const roadmap = await derive(paths);
    expect(statusOf(roadmap, 'RM-dep3')).toBe('stale');
    expect(statusOf(roadmap, 'RM-usedep')).toBe('pending');
  });
});

describe('APE v2 roadmap derivation — staleness precedence and shape (RM2)', () => {
  it('marks a superseded entry stale even when a completed run would satisfy it', async () => {
    const paths = await tempPaths();
    await seedRoadmap(paths, [
      storedEntry('RM-super', {
        superseded: { at: '2026-07-01T00:00:00.000Z', reason: 'redesign', replaced_by: [] },
      }),
    ]);
    await archiveRun(paths, archivedRun('run-super', { requirements: ['RM-super'], completes: ['RM-super'] }));

    const roadmap = await derive(paths);
    expect(statusOf(roadmap, 'RM-super')).toBe('stale');
  });

  it('returns the full derived shape with counts across all five statuses', async () => {
    const paths = await tempPaths();
    await seedRoadmap(paths, [
      storedEntry('RM-sat'),
      storedEntry('RM-prog'),
      storedEntry('RM-rdy'),
      storedEntry('RM-pen', { depends_on: ['RM-ghost'] }),
      storedEntry('RM-old', {
        superseded: { at: '2026-07-01T00:00:00.000Z', reason: 'x', replaced_by: [] },
      }),
    ]);
    await archiveRun(paths, archivedRun('run-sat', { requirements: ['RM-sat'], completes: ['RM-sat'] }));
    await atomicWriteJson(paths.active, runningRun('run-live', ['RM-prog']));

    const roadmap = await derive(paths);
    expect(roadmap.schema_version).toBe('2.0.0');
    expect(roadmap.counts).toEqual({ satisfied: 1, in_progress: 1, ready: 1, pending: 1, stale: 1 });

    const byId = Object.fromEntries(roadmap.entries.map((entry) => [entry.id, entry]));
    expect(byId['RM-sat'].status).toBe('satisfied');
    expect(byId['RM-prog'].status).toBe('in_progress');
    expect(byId['RM-rdy'].status).toBe('ready');
    expect(byId['RM-pen'].status).toBe('pending');
    expect(byId['RM-old'].status).toBe('stale');

    for (const entry of roadmap.entries) {
      expect(typeof entry.id).toBe('string');
      expect(typeof entry.title).toBe('string');
      expect(typeof entry.status).toBe('string');
      expect(entry).toHaveProperty('discovered_by');
      expect(Array.isArray(entry.depends_on)).toBe(true);
    }
  });

  it('returns null when no roadmap.json exists (RM7)', async () => {
    const paths = await tempPaths();
    const roadmap = await derive(paths);
    expect(roadmap).toBeNull();
  });
});
