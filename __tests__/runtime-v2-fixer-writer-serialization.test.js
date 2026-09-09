import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as locks from '../lib/runtime/lock.js';
import { historyAction, nextRun, startRun, withReceiptLock } from '../lib/runtime/service.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { atomicReplaceText, atomicWriteJson } from '../lib/runtime/storage.js';

// The deadline-timeout transition made NEXT a state writer (it can mark
// tickets expired, issue a retry ticket, and persist), and the import
// round-trip made `ape_history import` a requirement-index/history writer.
// Both must serialize on the receipt-effects lock like every other writer
// (invariant 7): an unlocked next or import racing an in-flight receipt's
// gate run interleaves two writers and the last one silently clobbers the
// other.

const cleanups = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function behindReceiptLock(dir, operation, completedEvent) {
  const paths = runtimePaths(dir);
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const requested = Promise.withResolvers();
  const events = [];
  let receiptHeld = false;
  const holder = withReceiptLock(paths, async () => {
    receiptHeld = true;
    events.push('receipt-start');
    entered.resolve();
    await release.promise;
    receiptHeld = false;
    events.push('receipt-end');
  });
  holder.catch((error) => entered.reject(error));
  let writer;
  let observedLock;
  try {
    // An elapsed delay cannot establish which contender acquired the lock.
    // Wait for the actual holder, then observe the writer's request while
    // delegating to the real lock; release only after that request arrives.
    await entered.promise;
    const withDirLock = locks.withDirLock;
    observedLock = vi.spyOn(locks, 'withDirLock').mockImplementation((lockPath, callback, options) => {
      if (lockPath !== paths.receiptLock) return withDirLock(lockPath, callback, options);
      requested.resolve();
      return withDirLock(lockPath, (lease) => {
        expect(receiptHeld, 'writer entered while receipt effects still held the lock').toBe(false);
        return callback(lease);
      }, options);
    });
    writer = operation().then((result) => {
      events.push(completedEvent);
      return result;
    });
    await Promise.race([
      requested.promise,
      writer.then(() => { throw new Error('writer completed without requesting the receipt-effects lock'); }),
    ]);
    expect(events).toEqual(['receipt-start']);
    release.resolve();
    const result = await writer;
    await holder;
    expect(events).toEqual(['receipt-start', 'receipt-end', completedEvent]);
    return result;
  } finally {
    release.resolve();
    await Promise.allSettled([holder, writer]);
    observedLock?.mockRestore();
  }
}

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function project() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-writer-serialization-'));
  cleanups.push(dir);
  await mkdir(path.join(dir, 'src'));
  await mkdir(path.join(dir, 'tests'));
  await writeFile(path.join(dir, 'src', 'value.js'), 'export const value = 1;\n');
  await writeFile(path.join(dir, 'tests', 'value.test.js'), 'throw new Error("red");\n');
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'ape@example.test');
  git(dir, 'config', 'user.name', 'APE Test');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'baseline');
  await atomicWriteJson(runtimePaths(dir).config, {
    shipping: { auto_merge: false, provider: 'github', required_remote_checks: false },
    test_commands: { full: 'node --test', targeted_template: 'node --test {paths}' },
  });
  return dir;
}

function startInput() {
  return {
    objective: 'Exercise writer serialization',
    mode: 'phase',
    lane: 'fast',
    host: 'codex',
    claimed_paths: ['src/value.js'],
    test_paths: ['tests/value.test.js'],
    requirements: [],
    risk_triggers: [],
    behavioral: true,
    hooks_trusted: true,
    subagents_available: true,
    explicit_invocation: true,
  };
}

describe('APE v2 NEXT serialization on the receipt-effects lock', () => {
  it('serializes nextRun behind in-flight receipt processing instead of interleaving writers', async () => {
    const dir = await project();
    const started = await startRun(dir, startInput());
    expect(started.ok).toBe(true);
    const next = await behindReceiptLock(dir, () => nextRun(dir), 'next-done');
    expect(next.ok).toBe(true);
  });
});

describe('APE v2 history import serialization on the receipt-effects lock', () => {
  it('serializes the importer requirement-index/history writes behind in-flight receipt effects', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ape-import-serialization-'));
    cleanups.push(dir);
    await mkdir(path.join(dir, '.planning'), { recursive: true });
    await writeFile(
      path.join(dir, '.planning', '1-1-PLAN.md'),
      '# Plan 1-1\n\nDelivers R5.\n\nStatus: shipped\n',
    );
    const imported = await behindReceiptLock(dir, () => historyAction(dir, 'import', {}), 'import-done');
    expect(imported.ok).toBe(true);
    expect(imported.migration.record_count).toBe(1);
  });
});

// T8: the atomic writers stage to `${file}.${pid}.${Date.now()}.tmp` opened
// with 'wx'. Two same-process writes of the same file in the same millisecond
// compute the identical temp name, so the second open('wx') throws EEXIST even
// though nothing is corrupted. Firing many concurrent writes at one path
// guarantees same-millisecond pairs. A correct implementation (an entropy
// component in the temp suffix) resolves every write, leaves the target as one
// of the written values, and leaves no orphaned *.tmp behind. These are red
// today (the concurrent same-ms opens collide) and green once the temp name
// carries entropy — nothing else about the write discipline changes.

const CONCURRENCY = 64;
const ROUNDS = 8;

async function collectRejections(spawn) {
  const rejections = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const settled = await Promise.allSettled(
      Array.from({ length: CONCURRENCY }, (_, index) => spawn(round, index)),
    );
    for (const outcome of settled) {
      if (outcome.status === 'rejected') rejections.push(outcome.reason);
    }
  }
  // Compact summary so a red run reports the failure mode (EEXIST from the
  // same-millisecond temp-name collision) instead of dumping every rejection.
  return { count: rejections.length, codes: [...new Set(rejections.map((error) => error?.code))] };
}

async function leftoverTempFiles(dir) {
  return (await readdir(dir)).filter((name) => name.endsWith('.tmp'));
}

describe('APE v2 atomic writers tolerate same-file concurrency (T8 temp-name entropy)', () => {
  it('resolves every concurrent atomicWriteJson to the same path with no EEXIST or leftover temp files', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ape-atomic-json-entropy-'));
    cleanups.push(dir);
    const target = path.join(dir, 'state.json');

    const rejections = await collectRejections((round, index) =>
      atomicWriteJson(target, { round, index }),
    );

    expect(rejections).toEqual({ count: 0, codes: [] });
    const parsed = JSON.parse(await readFile(target, 'utf8'));
    expect(parsed.round).toBeGreaterThanOrEqual(0);
    expect(parsed.round).toBeLessThan(ROUNDS);
    expect(parsed.index).toBeGreaterThanOrEqual(0);
    expect(parsed.index).toBeLessThan(CONCURRENCY);
    expect(await leftoverTempFiles(dir)).toEqual([]);
  });

  it('resolves every concurrent atomicReplaceText to the same path with no EEXIST or leftover temp files', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ape-atomic-text-entropy-'));
    cleanups.push(dir);
    const target = path.join(dir, 'settings.txt');

    const rejections = await collectRejections((round, index) =>
      atomicReplaceText(target, `round=${round} index=${index}\n`),
    );

    expect(rejections).toEqual({ count: 0, codes: [] });
    expect(await readFile(target, 'utf8')).toMatch(/^round=\d+ index=\d+\n$/);
    expect(await leftoverTempFiles(dir)).toEqual([]);
  });
});
