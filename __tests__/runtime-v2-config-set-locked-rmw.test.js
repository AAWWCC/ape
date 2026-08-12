import { execFileSync } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { configAction } from '../lib/runtime/service.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { readJson } from '../lib/runtime/storage.js';

// Audit 1.10 (invariant 7: one active writer and atomic state): the
// setRuntimeConfig read-modify-write behind `ape_config set`
// (service.js:2371) — and the per-slot loop behind `ape_config init --apply`
// (service.js:2442-2447), which persists each detected slot through the same
// RMW — must be serialized. Unserialized, two concurrent writers read the
// same stored base, and the last atomic write silently drops the other
// writer's key AND its explicit_keys provenance entry while BOTH calls
// return ok: silent config loss on a success response.
//
// Interleaving technique (deterministic, public surface only): every set
// reads the stored config file (.ape/runtime/config.json) at the top of its
// read-modify-write. Swapping that file for a FIFO holds the first writer at
// exactly its base read; the test then restores the real stored bytes, lets
// a second writer run, and only afterwards releases the held writer by
// feeding its already-open descriptor the ORIGINAL base bytes. Under the
// unserialized RMW the held writer's write-back lands strictly after the
// second writer's and erases it. A correct runtime — whichever way it
// serializes the RMW (withReceiptLock, a dedicated config lock on the same
// helper, or an equivalent) — never lets the second writer's landed key
// vanish: either the second writer queues behind the held first (the bounded
// wait below then times out and the release happens first) or its write is
// re-read before the first writer's write-back. Every assertion is about the
// raced OUTCOME (which keys and provenance entries survive in the stored
// config), never about which lock either call held. Same deterministic
// hold/release-of-an-on-disk-file discipline as the sibling
// start-override-reset race test.

const cleanups = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function project() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-config-locked-rmw-'));
  cleanups.push(dir);
  return dir;
}

// Seed one stored override through the public surface alone so the store
// exists with well-formed bytes (and one provenance entry) to feed the held
// reader later.
async function seededProject() {
  const dir = await project();
  const seeded = await configAction(dir, 'set', { key: 'custom.seed', value: 'baseline' });
  expect(seeded.ok).toBe(true);
  const paths = runtimePaths(dir);
  const baseBytes = await readFile(paths.config, 'utf8');
  return { dir, paths, baseBytes };
}

// Plant the deterministic stall point: swap the stored config file for a FIFO
// so the next writer blocks inside its read-modify-write, between its base
// read and its write-back.
async function plantConfigFifo(paths) {
  await rm(paths.config, { force: true });
  execFileSync('mkfifo', [paths.config]);
}

// Rendezvous with the in-flight writer: a non-blocking write-open of a FIFO
// succeeds only once a reader has it open, i.e. only once the writer has
// reached its base read mid-RMW. Bounded retry, no fixed sleeps.
async function openWriteEndWhenReaderArrives(fifoPath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await open(fifoPath, fsConstants.O_WRONLY | fsConstants.O_NONBLOCK);
    } catch (error) {
      if (error?.code !== 'ENXIO') throw error;
      if (Date.now() > deadline) {
        throw new Error('timed out waiting for the config writer to reach its base read');
      }
      await sleep(10);
    }
  }
}

async function waitFor(probe, timeoutMs, intervalMs = 25) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await probe()) return true;
    if (Date.now() > deadline) return false;
    await sleep(intervalMs);
  }
}

describe('APE v2 setRuntimeConfig serialized read-modify-write (audit 1.10, invariant 7)', () => {
  it('control: two sequential sets both land with both explicit_keys provenance entries', async () => {
    const { dir, paths } = await seededProject();

    const first = await configAction(dir, 'set', { key: 'custom.alpha', value: 'from-first-writer' });
    expect(first.ok).toBe(true);
    const second = await configAction(dir, 'set', { key: 'custom.beta', value: 'from-second-writer' });
    expect(second.ok).toBe(true);
    expect(second.config.custom.alpha).toBe('from-first-writer');
    expect(second.config.custom.beta).toBe('from-second-writer');

    const stored = await readJson(paths.config, null);
    expect(stored).not.toBeNull();
    expect(stored.custom).toMatchObject({
      seed: 'baseline',
      alpha: 'from-first-writer',
      beta: 'from-second-writer',
    });
    expect(stored.explicit_keys ?? []).toEqual(
      expect.arrayContaining(['custom.alpha', 'custom.beta', 'custom.seed']),
    );
  });

  it.skipIf(process.platform === 'win32')(
    'racing: a set that overlaps another set never drops the other writer\'s key or its explicit_keys provenance entry',
    async () => {
      const { dir, paths, baseBytes } = await seededProject();
      await plantConfigFifo(paths);

      const first = configAction(dir, 'set', { key: 'custom.alpha', value: 'from-first-writer' });
      first.catch(() => {});
      let second = null;
      let writeEnd = null;
      try {
        // The first set is now held at its base read, mid read-modify-write.
        writeEnd = await openWriteEndWhenReaderArrives(paths.config, 4_000);
        // Restore the real stored bytes for every other reader; the held
        // first set keeps its already-open FIFO descriptor.
        await rm(paths.config, { force: true });
        await writeFile(paths.config, baseBytes);

        second = configAction(dir, 'set', { key: 'custom.beta', value: 'from-second-writer' });
        second.catch(() => {});

        // Today the unserialized second set completes its whole RMW while the
        // first is still held; wait for its key to land so the first set's
        // write-back is released strictly after it. A runtime that serializes
        // the second writer behind the in-flight first never lands during
        // this bounded wait — the timeout arm then releases the first writer
        // and the second completes afterwards. Both orderings are asserted
        // below.
        await waitFor(async () => {
          const storedNow = await readJson(paths.config, null).catch(() => null);
          return storedNow?.custom?.beta === 'from-second-writer';
        }, 3_000);
      } finally {
        // Release the held first set: feed it the original base bytes and
        // EOF, then drain both calls so no promise or descriptor outlives
        // the test.
        if (writeEnd) {
          await writeEnd.write(baseBytes).catch(() => {});
          await writeEnd.close().catch(() => {});
        }
        await Promise.allSettled([first, second ?? Promise.resolve()]);
      }
      const [firstSettled, secondSettled] = await Promise.allSettled([first, second]);

      // Both calls report success — exactly why a silent drop would be
      // invisible to the operator.
      expect(firstSettled.status).toBe('fulfilled');
      expect(firstSettled.value.ok).toBe(true);
      expect(secondSettled.status).toBe('fulfilled');
      expect(secondSettled.value.ok).toBe(true);

      const stored = await readJson(paths.config, null);
      expect(stored).not.toBeNull();
      expect(stored.custom?.seed).toBe('baseline');
      expect(stored.custom?.alpha).toBe('from-first-writer');
      // RED anchor (the audited defect): the held writer's write-back was
      // computed from a base read taken before the second writer landed, so
      // the unserialized RMW erases custom.beta while both calls returned ok.
      expect(
        stored.custom?.beta,
        'a concurrent set was silently dropped: the unserialized read-modify-write overwrote the other writer\'s key on an ok response',
      ).toBe('from-second-writer');
      // Provenance must survive with the keys: explicit_keys is how a stored
      // value is distinguished from a materialized default (F36).
      expect(stored.explicit_keys ?? []).toEqual(
        expect.arrayContaining(['custom.alpha', 'custom.beta', 'custom.seed']),
      );
    },
  );

  it.skipIf(process.platform === 'win32')(
    'racing: the init --apply per-slot loop rides the same serialization — a concurrent set survives it',
    async () => {
      const { dir, paths, baseBytes } = await seededProject();
      await plantConfigFifo(paths);

      // No runner manifest exists in the fixture, so the proposal is empty
      // and the operator-supplied values drive the per-slot persist loop:
      // two setRuntimeConfig calls, in whitelist order (targeted_template,
      // then full). The first slot's base read is held at the FIFO.
      const init = configAction(dir, 'init', {
        apply: true,
        values: { targeted_template: 'node --test {paths}', full: 'node --test' },
      });
      init.catch(() => {});
      let concurrentSet = null;
      let writeEnd = null;
      try {
        writeEnd = await openWriteEndWhenReaderArrives(paths.config, 4_000);
        await rm(paths.config, { force: true });
        await writeFile(paths.config, baseBytes);

        concurrentSet = configAction(dir, 'set', { key: 'custom.gamma', value: 'from-concurrent-set' });
        concurrentSet.catch(() => {});

        // Unserialized today: the concurrent set lands while the init loop's
        // first slot is still held mid-RMW, and the loop's write-backs then
        // bury it. A serialized loop queues the set instead; the timeout arm
        // covers that ordering.
        await waitFor(async () => {
          const storedNow = await readJson(paths.config, null).catch(() => null);
          return storedNow?.custom?.gamma === 'from-concurrent-set';
        }, 3_000);
      } finally {
        if (writeEnd) {
          await writeEnd.write(baseBytes).catch(() => {});
          await writeEnd.close().catch(() => {});
        }
        await Promise.allSettled([init, concurrentSet ?? Promise.resolve()]);
      }
      const [initSettled, setSettled] = await Promise.allSettled([init, concurrentSet]);

      expect(initSettled.status).toBe('fulfilled');
      expect(initSettled.value.ok).toBe(true);
      expect(initSettled.value.init.applied).toBe(true);
      expect(initSettled.value.init.applied_keys).toEqual(
        expect.arrayContaining(['test_commands.targeted_template', 'test_commands.full']),
      );
      expect(setSettled.status).toBe('fulfilled');
      expect(setSettled.value.ok).toBe(true);

      const stored = await readJson(paths.config, null);
      expect(stored).not.toBeNull();
      // Both applied slots landed (shared ground under every serialization).
      expect(stored.test_commands?.targeted_template).toBe('node --test {paths}');
      expect(stored.test_commands?.full).toBe('node --test');
      expect(stored.custom?.seed).toBe('baseline');
      // RED anchor: the init loop's first-slot write-back was computed from a
      // base read taken before the concurrent set landed, so today the loop
      // erases custom.gamma (and its provenance) while both calls returned ok.
      expect(
        stored.custom?.gamma,
        'a set racing the init --apply per-slot loop was silently dropped: the loop\'s unserialized read-modify-write overwrote it on an ok response',
      ).toBe('from-concurrent-set');
      expect(stored.explicit_keys ?? []).toEqual(
        expect.arrayContaining([
          'custom.gamma',
          'custom.seed',
          'test_commands.full',
          'test_commands.targeted_template',
        ]),
      );
    },
  );
});
