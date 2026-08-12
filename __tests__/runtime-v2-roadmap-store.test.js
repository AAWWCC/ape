import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runtimePaths } from '../lib/runtime/paths.js';
import { readJson } from '../lib/runtime/storage.js';

// Behavioral tests for the runtime-owned roadmap store (RM1 store + audit,
// RM3 supersession, RM6 seeding). Expectations are derived from the approved
// public contract, not any implementation: the missing `lib/runtime/roadmap.js`
// module is the red. The store verbs are imported through a dynamic import so
// every test collects and then fails at the (currently unresolvable) import,
// rather than the whole file failing to load — the runtime re-executes these
// paths and must observe them fail.
const importRoadmap = () => import('../lib/runtime/roadmap.js');

const cleanups = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempPaths() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-roadmap-store-'));
  cleanups.push(dir);
  return runtimePaths(dir);
}

const roadmapFile = (paths) => path.join(paths.runtime, 'roadmap.json');

// A well-formed register-input entry per the contract's entry shape.
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

async function readNdjson(file) {
  const text = await readFile(file, 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

describe('APE v2 roadmap store — register round-trip and audit (RM1)', () => {
  it('persists the documented store shape and never writes a status key', async () => {
    const { registerEntries } = await importRoadmap();
    const paths = await tempPaths();
    await registerEntries(paths, {
      entries: [inputEntry('RM1', { depends_on: ['RM0'] })],
      reason: 'seed the roadmap',
    });

    const stored = await readJson(roadmapFile(paths));
    expect(stored.schema_version).toBe('2.0.0');
    expect(stored.entries).toHaveLength(1);
    const [entry] = stored.entries;
    expect(entry.id).toBe('RM1');
    expect(entry.title).toBe('Title RM1');
    expect(entry.description).toBe('Description RM1');
    expect(entry.acceptance).toBe('Acceptance RM1');
    expect(entry.depends_on).toEqual(['RM0']);
    // Seeded entries default to operator provenance.
    expect(entry.discovered_by).toBe('operator');
    // Status is never asserted — it is derived, never stored.
    expect(entry).not.toHaveProperty('status');
    // Per-entry audit trail records the mutation reason.
    expect(Array.isArray(entry.audit)).toBe(true);
    const registerLine = entry.audit.find((line) => line.reason === 'seed the roadmap');
    expect(registerLine).toBeTruthy();
    expect(typeof registerLine.at).toBe('string');
    expect(registerLine).toHaveProperty('op');
  });

  it('appends a roadmap-register audit line to overrides.ndjson', async () => {
    const { registerEntries } = await importRoadmap();
    const paths = await tempPaths();
    await registerEntries(paths, { entries: [inputEntry('RM1')], reason: 'seed' });

    const lines = await readNdjson(paths.overrideLog);
    const register = lines.find((line) => line.operation === 'roadmap-register');
    expect(register).toBeTruthy();
    expect(register.reason).toBe('seed');
    expect(register.ids).toEqual(['RM1']);
  });

  it('records per-entry run-id provenance and defaults the rest to operator (RM4 runtime half)', async () => {
    const { registerEntries } = await importRoadmap();
    const paths = await tempPaths();
    await registerEntries(paths, {
      entries: [
        inputEntry('RM-seed'),
        inputEntry('RM-follow', { discovered_by: 'run-fixture-e6a93fe596c1' }),
      ],
      reason: 'mixed provenance',
    });

    const stored = await readJson(roadmapFile(paths));
    const byId = Object.fromEntries(stored.entries.map((entry) => [entry.id, entry]));
    expect(byId['RM-seed'].discovered_by).toBe('operator');
    expect(byId['RM-follow'].discovered_by).toBe('run-fixture-e6a93fe596c1');
  });
});

describe('APE v2 roadmap store — batch all-or-nothing and bounds (RM1)', () => {
  it('rejects the whole batch when any entry supplies a status key, writing nothing new', async () => {
    const { registerEntries } = await importRoadmap();
    const paths = await tempPaths();
    await registerEntries(paths, { entries: [inputEntry('RM1')], reason: 'seed' });

    await expect(
      registerEntries(paths, {
        entries: [inputEntry('RM2'), inputEntry('RM3', { status: 'satisfied' })],
        reason: 'bad batch',
      }),
    ).rejects.toThrow();

    // All-or-nothing: neither RM2 nor RM3 landed — only the original RM1 remains.
    const stored = await readJson(roadmapFile(paths));
    expect(stored.entries.map((entry) => entry.id)).toEqual(['RM1']);
  });

  it('rejects a batch larger than 64 entries and writes no store', async () => {
    const { registerEntries } = await importRoadmap();
    const paths = await tempPaths();
    const entries = Array.from({ length: 65 }, (_, index) => inputEntry(`RM-b${index}`));

    await expect(registerEntries(paths, { entries, reason: 'over the batch bound' })).rejects.toThrow();
    await expect(readJson(roadmapFile(paths), null)).resolves.toBeNull();
  });

  it('rejects an entry whose title exceeds 200 characters', async () => {
    const { registerEntries } = await importRoadmap();
    const paths = await tempPaths();
    await expect(
      registerEntries(paths, {
        entries: [inputEntry('RM1', { title: 'x'.repeat(201) })],
        reason: 'title too long',
      }),
    ).rejects.toThrow();
  });

  it('rejects an entry whose id exceeds 128 characters', async () => {
    const { registerEntries } = await importRoadmap();
    const paths = await tempPaths();
    await expect(
      registerEntries(paths, {
        entries: [inputEntry('R'.repeat(129))],
        reason: 'id too long',
      }),
    ).rejects.toThrow();
  });
});

describe('APE v2 roadmap store — seeding a project batch (RM6)', () => {
  it('registers a multi-entry operator batch in one audited operation', async () => {
    const { registerEntries } = await importRoadmap();
    const paths = await tempPaths();
    await registerEntries(paths, {
      entries: [inputEntry('RM1'), inputEntry('RM2'), inputEntry('RM3')],
      reason: 'seed a fresh project',
    });

    const stored = await readJson(roadmapFile(paths));
    expect(stored.entries.map((entry) => entry.id).sort()).toEqual(['RM1', 'RM2', 'RM3']);
    for (const entry of stored.entries) {
      expect(entry.discovered_by).toBe('operator');
      expect(entry).not.toHaveProperty('status');
    }
  });
});

describe('APE v2 roadmap store — supersession and staleness (RM3)', () => {
  it('marks an entry stale with a recorded reason and replacement, and never deletes it', async () => {
    const { registerEntries, supersedeEntries } = await importRoadmap();
    const paths = await tempPaths();
    await registerEntries(paths, { entries: [inputEntry('RM1'), inputEntry('RM2')], reason: 'seed' });

    await supersedeEntries(paths, {
      ids: ['RM1'],
      reason: 'redesigned into RM2',
      replaced_by: ['RM2'],
    });

    const stored = await readJson(roadmapFile(paths));
    const byId = Object.fromEntries(stored.entries.map((entry) => [entry.id, entry]));
    // Never deleted — still present and queryable.
    expect(byId['RM1']).toBeTruthy();
    expect(byId['RM1'].superseded).toBeTruthy();
    expect(byId['RM1'].superseded.reason).toBe('redesigned into RM2');
    expect(byId['RM1'].superseded.replaced_by).toEqual(['RM2']);
    expect(typeof byId['RM1'].superseded.at).toBe('string');
  });

  it('appends a roadmap-supersede audit line to overrides.ndjson', async () => {
    const { registerEntries, supersedeEntries } = await importRoadmap();
    const paths = await tempPaths();
    await registerEntries(paths, { entries: [inputEntry('RM1')], reason: 'seed' });
    await supersedeEntries(paths, { ids: ['RM1'], reason: 'obsolete', replaced_by: [] });

    const lines = await readNdjson(paths.overrideLog);
    const supersede = lines.find((line) => line.operation === 'roadmap-supersede');
    expect(supersede).toBeTruthy();
    expect(supersede.reason).toBe('obsolete');
    expect(supersede.ids).toEqual(['RM1']);
  });

  it('requires a non-empty reason and leaves the entry untouched on refusal', async () => {
    const { registerEntries, supersedeEntries } = await importRoadmap();
    const paths = await tempPaths();
    await registerEntries(paths, { entries: [inputEntry('RM1')], reason: 'seed' });

    await expect(
      supersedeEntries(paths, { ids: ['RM1'], reason: '   ', replaced_by: [] }),
    ).rejects.toThrow();

    const stored = await readJson(roadmapFile(paths));
    expect(stored.entries[0].superseded).toBeUndefined();
  });

  it('rejects superseding an unknown id', async () => {
    const { registerEntries, supersedeEntries } = await importRoadmap();
    const paths = await tempPaths();
    await registerEntries(paths, { entries: [inputEntry('RM1')], reason: 'seed' });

    await expect(
      supersedeEntries(paths, { ids: ['RM-unknown'], reason: 'no such entry', replaced_by: [] }),
    ).rejects.toThrow();
  });

  it('rejects superseding an already-superseded id', async () => {
    const { registerEntries, supersedeEntries } = await importRoadmap();
    const paths = await tempPaths();
    await registerEntries(paths, { entries: [inputEntry('RM1')], reason: 'seed' });
    await supersedeEntries(paths, { ids: ['RM1'], reason: 'first', replaced_by: [] });

    await expect(
      supersedeEntries(paths, { ids: ['RM1'], reason: 'second', replaced_by: [] }),
    ).rejects.toThrow();
  });
});
