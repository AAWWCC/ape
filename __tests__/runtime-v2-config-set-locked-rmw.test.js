import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
// Pause the first completed ordinary-file read at the storage seam. The
// bytes and read guards remain real; only delivery of that first value waits.
// A FIFO cannot represent stored configuration now that readers reject it.
// With no RMW lock, writer two commits while writer one holds the old value,
// then writer one overwrites it. Assertions exercise the public set/init
// outcomes and exact surviving provenance, without mocking either lock.
const heldRead = vi.hoisted(() => ({ file: null, arrive: null, release: null, wait: null }));
vi.mock('../lib/runtime/bounded-file.js', async (original) => {
  const actual = await original();
  return { ...actual, readBoundedJson: async (...args) => {
    const value = await actual.readBoundedJson(...args);
    if (args[0] === heldRead.file) {
      heldRead.file = null;
      heldRead.arrive();
      await heldRead.wait;
    }
    return value;
  } };
});

const cleanups = [];
afterEach(async () => {
  heldRead.release?.();
  Object.assign(heldRead, { file: null, arrive: null, release: null, wait: null });
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
// exists with well-formed bytes and one provenance entry.
async function seededProject() {
  const dir = await project();
  const seeded = await configAction(dir, 'set', { key: 'custom.seed', value: 'baseline' });
  expect(seeded.ok).toBe(true);
  const paths = runtimePaths(dir);
  return { dir, paths };
}

function pauseConfigRead(paths) {
  heldRead.file = paths.config;
  const arrived = new Promise(resolve => { heldRead.arrive = resolve; });
  heldRead.wait = new Promise(resolve => { heldRead.release = resolve; });
  return { arrived, release: () => heldRead.release() };
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

  it(
    'racing: a set that overlaps another set never drops the other writer\'s key or its explicit_keys provenance entry',
    async () => {
      const { dir, paths } = await seededProject();
      const barrier = pauseConfigRead(paths);

      const first = configAction(dir, 'set', { key: 'custom.alpha', value: 'from-first-writer' });
      first.catch(() => {});
      let second = null;
      try {
        // The first set is now held at its base read, mid read-modify-write.
        await barrier.arrived;


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
        // Deliver the original parsed base, then drain both calls.
        barrier.release();
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

  it(
    'racing: the init --apply per-slot loop rides the same serialization — a concurrent set survives it',
    async () => {
      const { dir, paths } = await seededProject();
      const barrier = pauseConfigRead(paths);

      // No runner manifest exists in the fixture, so the proposal is empty
      // and the operator-supplied values drive the per-slot persist loop:
      // two setRuntimeConfig calls, in whitelist order (targeted_template,
      // then full). The first slot's base read is paused before returning.
      const init = configAction(dir, 'init', {
        apply: true,
        values: { targeted_template: 'node --test {paths}', full: 'node --test' },
      });
      init.catch(() => {});
      let concurrentSet = null;
      try {
        await barrier.arrived;


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
        barrier.release();
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
