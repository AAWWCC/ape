import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { abortRun, overrideRun, startRun, withReceiptLock } from '../lib/runtime/service.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { atomicWriteJson } from '../lib/runtime/storage.js';

const cleanups = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function scratch() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-receipt-lock-'));
  cleanups.push(dir);
  return dir;
}

async function project() {
  const dir = await scratch();
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
    test_commands: { full: 'node --test' },
  });
  return dir;
}

function startInput() {
  return {
    objective: 'Exercise receipt-effects serialization',
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

describe('APE v2 receipt-effects lock liveness (F9)', () => {
  it('does not steal the lock from a live long-running holder: the heartbeat keeps it fresh', async () => {
    const dir = await scratch();
    const paths = runtimePaths(dir);
    const events = [];
    // Wide margins (staleness 20x the heartbeat) so CPU-oversubscribed CI
    // cannot starve the real-timer heartbeat past staleness and flake this
    // into a false steal.
    const options = { staleMs: 1_200, heartbeatMs: 60, busyMs: 10_000 };
    const holder = withReceiptLock(paths, async () => {
      events.push('holder-start');
      // Longer than staleMs: without the heartbeat the intruder would judge
      // the lock stale mid-flight and steal it.
      await sleep(2_600);
      events.push('holder-end');
    }, options);
    await sleep(300);
    const intruder = withReceiptLock(paths, async () => {
      events.push('intruder');
    }, options);
    await Promise.all([holder, intruder]);
    expect(events).toEqual(['holder-start', 'holder-end', 'intruder']);
  });

  it('still steals a genuinely stale lock left by a dead holder', async () => {
    const dir = await scratch();
    const paths = runtimePaths(dir);
    await mkdir(paths.runtime, { recursive: true });
    await mkdir(paths.receiptLock);
    // A crashed holder never refreshes the heartbeat; backdate far past staleness.
    const dead = new Date(Date.now() - 10 * 60_000);
    await utimes(paths.receiptLock, dead, dead);
    const result = await withReceiptLock(paths, async () => 'recovered');
    expect(result).toBe('recovered');
  });
});

describe('APE v2 abort/override serialization (F14)', () => {
  it('serializes abortRun behind in-flight receipt processing instead of interleaving writers', async () => {
    const dir = await project();
    const started = await startRun(dir, startInput());
    expect(started.ok).toBe(true);
    const paths = runtimePaths(dir);
    const events = [];
    const holder = withReceiptLock(paths, async () => {
      events.push('receipt-start');
      await sleep(400);
      events.push('receipt-end');
    });
    await sleep(50);
    const aborted = await abortRun(dir, 'abort during in-flight receipt effects').then((result) => {
      events.push('abort-done');
      return result;
    });
    await holder;
    expect(events).toEqual(['receipt-start', 'receipt-end', 'abort-done']);
    expect(aborted.run.status).toBe('aborted');
  });

  it('serializes overrideRun behind in-flight receipt processing', async () => {
    const dir = await project();
    const started = await startRun(dir, startInput());
    expect(started.ok).toBe(true);
    const paths = runtimePaths(dir);
    const events = [];
    const holder = withReceiptLock(paths, async () => {
      events.push('receipt-start');
      await sleep(400);
      events.push('receipt-end');
    });
    await sleep(50);
    const overridden = await overrideRun(dir, 'abort', 'override during in-flight receipt effects')
      .then((result) => {
        events.push('override-done');
        return result;
      });
    await holder;
    expect(events).toEqual(['receipt-start', 'receipt-end', 'override-done']);
    expect(overridden.ok).toBe(true);
    expect(overridden.run.status).toBe('aborted');
  });
});
