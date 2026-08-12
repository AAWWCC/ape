import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importLegacyPlanning } from '../lib/runtime/importer.js';
import { runtimePaths } from '../lib/runtime/paths.js';

// Audit 1.12 (docs/research/2026-07-19-runtime-audit.md, invariant 4): the
// legacy-planning importer must be deterministic and deletion-safe.
//
// Plan — three independent behavioral pins, each red pre-fix:
//   (a) source_hash must depend only on the set of (path, bytes, sha256) of
//       the .planning tree, never on filesystem enumeration order. Pin:
//       import the identical tree twice, the second time with readdir
//       adversarially reversed at every level; both manifests must publish
//       the same source_hash. Red today because walk() emits raw readdir
//       order into manifest.sources, which sha256(sources) then hashes.
//   (b) Re-importing an unchanged source must keep the archived history
//       record_hash stable (history.js F40 discipline: wall-clock fields sit
//       outside the hash). Pin: import twice with different `now` values and
//       require the archived record_hash to be identical while imported_at
//       is still carried on the record. Red today because imported_at is
//       hashed inside the archived record.
//   (c) delete_legacy must never delete a source that changed after its
//       manifest verification (TOCTOU). Pin: mutate the last-deleted source
//       at the moment the first source is unlinked — i.e. after the
//       verification read, before the deletion — and require the mutated
//       file to survive. Red today because verification and deletion are two
//       separate passes over the whole tree.
//
// The fs hooks below interpose only on the two syscalls the defects hinge on
// (readdir order, rm timing); everything else passes through untouched.
const fsHooks = vi.hoisted(() => ({ readdirOrder: null, beforeRm: null }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    readdir: async (...args) => {
      const entries = await actual.readdir(...args);
      if (fsHooks.readdirOrder && Array.isArray(entries)) return fsHooks.readdirOrder([...entries]);
      return entries;
    },
    rm: async (target, ...rest) => {
      if (fsHooks.beforeRm) fsHooks.beforeRm(String(target));
      return actual.rm(target, ...rest);
    },
  };
});

const entryName = (entry) => (typeof entry === 'string' ? entry : entry.name);
const sortEntries = (entries) =>
  entries.sort((a, b) => (entryName(a) < entryName(b) ? -1 : entryName(a) > entryName(b) ? 1 : 0));

describe('ape v2 importer determinism and deletion TOCTOU (audit 1.12)', () => {
  const dirs = [];
  afterEach(() => {
    fsHooks.readdirOrder = null;
    fsHooks.beforeRm = null;
    dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
  });

  function makeProject(files) {
    const dir = mkdtempSync(join(tmpdir(), 'ape-importer-audit-'));
    dirs.push(dir);
    for (const [relative, body] of Object.entries(files)) {
      const absolute = join(dir, ...relative.split('/'));
      mkdirSync(join(absolute, '..'), { recursive: true });
      writeFileSync(absolute, body);
    }
    return dir;
  }

  it('publishes an identical source_hash when filesystem enumeration order is reversed', async () => {
    const dir = makeProject({
      '.planning/PROJECT.md': '# Project\n\nDelivers R1.\n\nStatus: shipped\n',
      '.planning/context.md': 'Retained background context referencing R2.\n',
      '.planning/phase-1/1-1-PLAN.md': '# Plan 1-1\n\nDelivers R3.\n\nStatus: shipped\n',
      '.planning/phase-1/1-2-SUMMARY.md': '# Summary 1-2\n\nDelivers R4.\n\nStatus: complete\n',
      '.planning/phase-2/2-1-PLAN.md': '# Plan 2-1\n\nDelivers R5.\n\nStatus: blocked\n',
    });
    const paths = runtimePaths(dir);
    const now = '2026-07-01T00:00:00.000Z';

    const natural = await importLegacyPlanning(dir, paths, { now });

    let reversedCalls = 0;
    fsHooks.readdirOrder = (entries) => {
      reversedCalls += 1;
      return entries.reverse();
    };
    const adversarial = await importLegacyPlanning(dir, paths, { now });
    fsHooks.readdirOrder = null;

    // The adversarial enumeration genuinely engaged and saw the same files.
    expect(reversedCalls).toBeGreaterThan(0);
    const naturalPaths = natural.sources.map((source) => source.path).sort();
    const adversarialPaths = adversarial.sources.map((source) => source.path).sort();
    expect(adversarialPaths).toEqual(naturalPaths);
    expect(naturalPaths).toHaveLength(5);

    // Invariant 4: the identical tree must hash identically regardless of
    // how the filesystem chose to enumerate it.
    expect(adversarial.source_hash).toBe(natural.source_hash);
  });

  it('keeps the archived record_hash stable when re-importing an unchanged source at a later time', async () => {
    const dir = makeProject({
      '.planning/1-1-PLAN.md': '# Plan 1-1\n\nDelivers R3 and R7.\n\nStatus: shipped\n',
    });
    const paths = runtimePaths(dir);

    const first = await importLegacyPlanning(dir, paths, { now: '2026-07-01T00:00:00.000Z' });
    expect(first.records).toHaveLength(1);
    const runId = first.records[0].history_run_id;
    const recordFile = join(dir, '.ape', 'runtime', 'history', `${runId}.json`);
    const before = JSON.parse(readFileSync(recordFile, 'utf8'));
    expect(typeof before.record_hash).toBe('string');

    const second = await importLegacyPlanning(dir, paths, { now: '2026-07-02T00:00:00.000Z' });
    expect(second.records[0].history_run_id).toBe(runId);
    const after = JSON.parse(readFileSync(recordFile, 'utf8'));

    // Sanity: the source itself is byte-identical across the two imports.
    expect(after.source_hash).toBe(before.source_hash);
    // The import timestamp is still carried on the record (outside the hash,
    // like history.js), so provenance is not lost by the fix.
    expect(typeof after.imported_at).toBe('string');
    expect(after.imported_at.length).toBeGreaterThan(0);
    // F40 discipline: an unchanged source re-imported at a different wall
    // clock must produce the identical record_hash.
    expect(after.record_hash).toBe(before.record_hash);
  });

  it('does not delete a source mutated after manifest verification but before its deletion', async () => {
    const decoyBody = '# Plan 1-1\n\nDelivers R3.\n\nStatus: shipped\n';
    const victimBody = '# Plan 9-9\n\nDelivers R9.\n\nStatus: shipped\n';
    const mutatedBody = 'operator edited this plan after the manifest was verified\n';
    const dir = makeProject({
      '.planning/1-1-PLAN.md': decoyBody,
      '.planning/9-9-PLAN.md': victimBody,
    });
    const paths = runtimePaths(dir);
    const victim = join(dir, '.planning', '9-9-PLAN.md');

    // Deterministic enumeration so the decoy is processed before the victim
    // on every machine; a sorted-walk implementation is unaffected.
    fsHooks.readdirOrder = sortEntries;

    // Simulate the concurrent writer: the instant the first legacy source is
    // unlinked (verification of the manifest necessarily already happened),
    // rewrite the still-present victim.
    let mutations = 0;
    fsHooks.beforeRm = (target) => {
      if (mutations === 0 && target.endsWith('1-1-PLAN.md')) {
        mutations += 1;
        writeFileSync(victim, mutatedBody);
      }
    };

    let error = null;
    try {
      await importLegacyPlanning(dir, paths, { now: '2026-07-01T00:00:00.000Z', delete_legacy: true });
    } catch (caught) {
      error = caught; // a refusal error is an acceptable surface; silent skip is too
    }
    fsHooks.beforeRm = null;
    fsHooks.readdirOrder = null;

    // Whether the importer surfaces the refusal as an error or completes
    // while sparing the file is implementation-neutral; if it does throw, it
    // must be a real Error, not a stray rejection value.
    if (error !== null) expect(error).toBeInstanceOf(Error);
    // The race genuinely fired, and it fired via the decoy's deletion.
    expect(mutations).toBe(1);
    // The decoy verified clean before the race, so it was deleted.
    expect(existsSync(join(dir, '.planning', '1-1-PLAN.md'))).toBe(false);
    // The victim changed between its verification and its deletion: it must
    // survive, with the operator's new content intact.
    expect(existsSync(victim)).toBe(true);
    expect(readFileSync(victim, 'utf8')).toBe(mutatedBody);
  });
});
