import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { atomicWriteJson, readJson } from '../lib/runtime/storage.js';

// Seeded-deterministic property suite over atomic storage
// (lib/runtime/storage.js) — invariant 7's atomic-state half: under generated
// write/crash sequences a reader observes only old-complete or new-complete
// state, never a partial write.
//
// Crash injection is structural: a partial `${file}.<pid>.<ts>.<rand>.tmp`
// sibling stands in for a writer that died mid-write (temp staged, rename
// never happened). By DOCUMENTED DISPOSITION the newest write may be LOST on
// an OS/power crash (no parent-directory fsync) — so no property here asserts
// newest-write durability, and appendJsonLine's unsynced append is asserted
// nowhere: only never-torn, only-complete-values reads and debris inertness.
const SEED = 20260723;

const FALLBACK = Object.freeze({ fallback: 'missing-file-sentinel' });

// Payloads derive entirely from their index so completeness is checkable by
// deep equality; every third value carries a ~64KB blob so torn writes would
// have room to surface.
function payload(index) {
  return {
    index,
    generation: `value-${index}`,
    blob: index % 3 === 0 ? 'x'.repeat(64 * 1024) : `small-${index}`,
  };
}

const commandArb = fc.oneof(
  fc.record({ op: fc.constant('write'), index: fc.nat({ max: 30 }) }),
  fc.record({
    op: fc.constant('burst'),
    indices: fc.array(fc.nat({ max: 30 }), { minLength: 2, maxLength: 3 }),
  }),
  fc.record({ op: fc.constant('read') }),
  fc.record({
    op: fc.constant('debris'),
    torn: fc.constantFrom('', '{', '{"torn":', '{"index":9999,"blob":"xxxx'),
  }),
);

// A successful read must parse to a COMPLETE previously-written value: its
// index is in the written set and the whole value deep-equals the payload that
// index generates. The missing-file fallback is admissible only while the
// file may not exist yet.
function observeComplete(value, allowedIndices, allowFallback) {
  if (allowFallback && JSON.stringify(value) === JSON.stringify(FALLBACK)) return;
  expect(typeof value?.index, 'a reader observed a value no completed write produced').toBe('number');
  expect(allowedIndices.has(value.index), `observed index ${value?.index} was never written`).toBe(true);
  expect(value, 'a reader observed a partial (torn) value').toEqual(payload(value.index));
}

describe('APE v2 atomic storage properties: old-complete or new-complete, never partial (invariant 7)', () => {
  it('generated write/crash sequences: every read parses to a complete written value; debris never wedges or leaks', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(commandArb, { minLength: 1, maxLength: 8 }), async (commands) => {
        const dir = await mkdtemp(path.join(tmpdir(), 'ape-property-storage-'));
        try {
          const file = path.join(dir, 'state.json');
          const written = new Set();
          let debrisCount = 0;
          for (const command of commands) {
            if (command.op === 'write') {
              await atomicWriteJson(file, payload(command.index));
              written.add(command.index);
            } else if (command.op === 'burst') {
              // Concurrent replacements of the SAME path, with a reader
              // interleaved mid-burst: the reader may observe any complete
              // generation (or the pre-first-write absence), never a torn one.
              const writtenAtStart = new Set(written);
              const concurrentRead = readJson(file, FALLBACK);
              await Promise.all(command.indices.map((index) => atomicWriteJson(file, payload(index))));
              for (const index of command.indices) written.add(index);
              const observed = await concurrentRead;
              const allowed = new Set([...writtenAtStart, ...command.indices]);
              observeComplete(observed, allowed, writtenAtStart.size === 0);
            } else if (command.op === 'read') {
              const observed = await readJson(file, FALLBACK);
              observeComplete(observed, written, written.size === 0);
            } else if (command.op === 'debris') {
              // A crashed writer's staged temp file in the documented debris
              // shape `${file}.<pid>.<ts>.<rand>.tmp`, torn mid-payload.
              debrisCount += 1;
              await writeFile(
                `${file}.${process.pid}.${Date.now()}.dead${debrisCount}.tmp`,
                command.torn,
                'utf8',
              );
            }
          }
          // After the whole sequence the file equals ONE complete written
          // value (when anything was written at all).
          if (written.size > 0) {
            observeComplete(await readJson(file), written, false);
          }
          // Injected crash debris never wedges a later atomic write and is
          // never observed by a later read.
          await atomicWriteJson(file, payload(999));
          expect(await readJson(file)).toEqual(payload(999));
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      }),
      { seed: SEED, numRuns: 30, verbose: 2 },
    );
  }, 30_000);

  it('readJson fallback semantics: a missing file yields the provided fallback verbatim and rethrows without one', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          fc.integer(),
          fc.string(),
          fc.constant(null),
          fc.array(fc.integer(), { maxLength: 4 }),
          fc.record({ key: fc.string() }),
        ),
        async (fallback) => {
          const dir = await mkdtemp(path.join(tmpdir(), 'ape-property-storage-'));
          try {
            const missing = path.join(dir, 'missing.json');
            await expect(readJson(missing, fallback)).resolves.toEqual(fallback);
            await expect(readJson(missing)).rejects.toMatchObject({ code: 'ENOENT' });
          } finally {
            await rm(dir, { recursive: true, force: true });
          }
        },
      ),
      { seed: SEED, numRuns: 15, verbose: 2 },
    );
  }, 30_000);
});
