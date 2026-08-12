import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { historyAction } from '../lib/runtime/service.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { atomicWriteJson } from '../lib/runtime/storage.js';

// Imported synthetic history records must never shadow real runs: the old
// `run-import-<hex>` ids sorted above every real `run-<timestamp>-<uuid>` id
// in the descending unfiltered listing ('i' > any digit), so one import
// permanently headed the listing and a large legacy import could evict every
// real run from the 256-record cap. Imported ids now sort below real runs.

const cleanups = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function project() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-import-listing-'));
  cleanups.push(dir);
  await mkdir(path.join(dir, '.planning'), { recursive: true });
  await writeFile(
    path.join(dir, '.planning', '1-1-PLAN.md'),
    '# Plan 1-1\n\nDelivers R3.\n\nStatus: shipped\n',
  );
  return dir;
}

async function seedRealRun(dir, runId) {
  const paths = runtimePaths(dir);
  await mkdir(paths.history, { recursive: true });
  await atomicWriteJson(path.join(paths.history, `${runId}.json`), {
    schema_version: '2.0.0',
    run_id: runId,
    objective: 'A real archived run',
    mode: 'phase',
    lane: 'fast',
    status: 'completed',
    requirements: ['R1'],
    receipts: [],
    tickets: [],
  });
}

describe('APE v2 imported history records in the unfiltered listing', () => {
  it('lists real runs ahead of imported records', async () => {
    const dir = await project();
    const realRunId = 'run-fixture-49ec19e2e301';
    await seedRealRun(dir, realRunId);
    const { migration } = await historyAction(dir, 'import', {});
    expect(migration.record_count).toBe(1);
    const importedId = migration.records[0].history_run_id;

    const { records } = await historyAction(dir, 'query', {});
    const ids = records.map((record) => record.run_id);
    expect(ids).toEqual([realRunId, importedId]);
  });

  it('explains an imported record without rendering an undefined lane', async () => {
    const dir = await project();
    const { migration } = await historyAction(dir, 'import', {});
    const importedId = migration.records[0].history_run_id;

    const explained = await historyAction(dir, 'explain', { run_id: importedId });
    expect(explained.record.run_id).toBe(importedId);
    expect(explained.text).not.toContain('undefined');
    expect(explained.text).toContain('lane: none');
  });
});

describe('APE v2 import records the file\'s true byte SHA-256', () => {
  it('hashes the raw bytes of a non-ASCII source, not a latin1 re-encoding', async () => {
    const dir = await project();
    // The body carries a non-ASCII UTF-8 sequence ('é' = bytes 0xC3 0xA9). The
    // published hash must be the file's real byte SHA-256 — exactly what
    // `shasum -a 256` / createHash('sha256').update(<raw buffer>) reports.
    // Hashing the latin1 `body.toString('binary')` string instead re-encodes
    // every byte >= 0x80 into two UTF-8 bytes, producing a different,
    // non-auditable digest for any non-ASCII file.
    const body = Buffer.from('# Plan 9-9\n\nDelivers a café résumé é.\n', 'utf8');
    await writeFile(path.join(dir, '.planning', '9-9-PLAN.md'), body);
    const trueDigest = createHash('sha256').update(body).digest('hex');

    const { migration } = await historyAction(dir, 'import', {});

    const source = migration.sources.find((entry) => entry.path === '.planning/9-9-PLAN.md');
    expect(source).toBeDefined();
    expect(source.sha256).toBe(trueDigest);

    const record = migration.records.find((entry) => entry.source_path === '.planning/9-9-PLAN.md');
    expect(record).toBeDefined();
    expect(record.source_hash).toBe(trueDigest);
  });
});
