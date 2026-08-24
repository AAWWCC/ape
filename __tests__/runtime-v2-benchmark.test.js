import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { linkSync, lstatSync, mkdtempSync, mkdirSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync, readFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  appendBenchmarkRecord,
  validateBenchmarkRecord,
  verifyBenchmarks,
} from '../scripts/benchmark-v2.mjs';
import * as benchmarkModule from '../scripts/benchmark-v2.mjs';
import { DEFAULT_DEADLINES_MS } from '../lib/runtime/constants.js';

const SCRIPT = join(process.cwd(), 'scripts', 'benchmark-v2.mjs');

function records(slowPerGroup = 2) {
  return ['claude', 'codex'].flatMap((host) =>
    ['mechanical', 'fast', 'full'].flatMap((lane) =>
      Array.from({ length: 20 }, (_, index) => {
        const limit = DEFAULT_DEADLINES_MS[lane];
        const adjusted = index < 20 - slowPerGroup ? limit - 1 : limit + 1;
        return {
          host,
          lane,
          raw_ms: adjusted + 15_000,
          test_ms: 10_000,
          remote_ci_ms: 5_000,
        };
      }),
    ),
  );
}

function runCli(args, options = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    ...options,
    env: { ...process.env, ...options.env },
  });
}

async function waitForFileCount(directory, suffix, count, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (readdirSync(directory).filter((name) => name.endsWith(suffix)).length >= count) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

function completedChild(child) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

describe('APE v2 latency certification', () => {
  it('requires 20 runs and permits at most two misses per host and lane', () => {
    expect(verifyBenchmarks(records(2)).passed).toBe(true);
    expect(verifyBenchmarks(records(3)).passed).toBe(false);
    expect(verifyBenchmarks(records(2).slice(1)).passed).toBe(false);
  });

  it('thresholds are the runtime lane deadlines, per host/lane group', () => {
    const report = verifyBenchmarks(records(2));
    expect(report.groups).toHaveLength(6);
    for (const group of report.groups) {
      expect(['claude', 'codex']).toContain(group.host);
      expect(['mechanical', 'fast', 'full']).toContain(group.lane);
    }
  });

  it('reports the governing threshold and explicit certification fields at both boundaries', () => {
    const group = (count, passing) => Array.from({ length: count }, (_, index) => ({
      host: 'claude',
      lane: 'mechanical',
      raw_ms: index < passing ? DEFAULT_DEADLINES_MS.mechanical : DEFAULT_DEADLINES_MS.mechanical + 1,
    }));
    const mechanical = (count, passing) => verifyBenchmarks(group(count, passing)).groups
      .find((candidate) => candidate.host === 'claude' && candidate.lane === 'mechanical');

    expect(mechanical(19, 18)).toMatchObject({
      count: 19,
      required_count: 20,
      passing_count: 18,
      required_passing: 18,
      threshold_ms: DEFAULT_DEADLINES_MS.mechanical,
      certification_status: 'insufficient-records',
    });
    expect(mechanical(20, 17)).toMatchObject({
      count: 20,
      passing_count: 17,
      certification_status: 'insufficient-passes',
    });
    expect(mechanical(20, 18)).toMatchObject({
      count: 20,
      passing_count: 18,
      certification_status: 'certified',
    });
    for (const value of [mechanical(19, 18), mechanical(20, 17), mechanical(20, 18)]) {
      expect(value).toHaveProperty('raw_p90_ms');
      expect(value).toHaveProperty('adjusted_p90_ms');
    }
  });

  it('reports records matching no host/lane group instead of dropping them silently', () => {
    const report = verifyBenchmarks([
      ...records(2),
      // A pre-collapse mode-shaped record has no lane: it must be surfaced.
      { host: 'claude', mode: 'patch', raw_ms: 60_000 },
    ]);
    expect(report.unclassified).toBe(1);
    expect(verifyBenchmarks(records(2))).not.toHaveProperty('unclassified');
  });
});

describe('benchmark record validation', () => {
  it('normalizes a valid record and stamps recorded_at', () => {
    const normalized = validateBenchmarkRecord({ host: 'claude', lane: 'mechanical', raw_ms: 120_000 });
    expect(normalized.host).toBe('claude');
    expect(normalized.raw_ms).toBe(120_000);
    expect(typeof normalized.recorded_at).toBe('string');
    expect(normalized).not.toHaveProperty('test_ms');
  });

  it('rejects unknown hosts, unknown lanes, and non-positive raw_ms', () => {
    expect(() => validateBenchmarkRecord({ host: 'unsupported_host', lane: 'mechanical', raw_ms: 1 })).toThrow(/host/);
    expect(validateBenchmarkRecord({ host: 'codex', lane: 'mechanical', raw_ms: 1000 }).host).toBe('codex');
    expect(() => validateBenchmarkRecord({ host: 'claude', lane: 'spike', raw_ms: 1 })).toThrow(/lane/);
    expect(() => validateBenchmarkRecord({ host: 'claude', mode: 'phase', raw_ms: 1 })).toThrow(/lane/);
    expect(() => validateBenchmarkRecord({ host: 'claude', lane: 'mechanical', raw_ms: 0 })).toThrow(/raw_ms/);
    expect(() => validateBenchmarkRecord({ host: 'claude', lane: 'mechanical', raw_ms: 1, test_ms: -5 })).toThrow(/test_ms/);
  });

  it('rejects timing components whose sum exceeds raw wall-clock time', () => {
    expect(() => validateBenchmarkRecord({
      host: 'claude',
      lane: 'mechanical',
      raw_ms: 100,
      test_ms: 70,
      remote_ci_ms: 31,
    })).toThrow(/timing components|adjusted/iu);
  });
});

describe('benchmark CLI', () => {
  let tempRoot;
  let file;
  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'ape-benchmark-'));
    file = join(tempRoot, 'reference-runs.json');
  });
  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('verify on an EMPTY ledger exits 0 with a clear no-records report', () => {
    writeFileSync(file, '[]\n');
    const result = runCli(['verify', file]);
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.status).toBe('no-records');
    expect(report.message).toContain('record --host');
  });

  it('verify still exits 1 when records exist but certification is not met', () => {
    writeFileSync(file, `${JSON.stringify([{ host: 'claude', lane: 'mechanical', raw_ms: 60_000 }])}\n`);
    const result = runCli(['verify', file]);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).passed).toBe(false);
  });

  it('record appends a validated record that verify then consumes', () => {
    writeFileSync(file, '[]\n');
    const result = runCli([
      'record', '--host', 'claude', '--lane', 'mechanical', '--raw-ms', '120000',
      '--test-ms', '10000', '--file', file,
    ]);
    expect(result.status).toBe(0);
    const stored = JSON.parse(readFileSync(file, 'utf8'));
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ host: 'claude', lane: 'mechanical', raw_ms: 120_000, test_ms: 10_000 });
    expect(typeof stored[0].recorded_at).toBe('string');
    // The appended record is now real (insufficient) data: verify reports it and fails.
    const verify = runCli(['verify', file]);
    expect(verify.status).toBe(1);
    expect(JSON.parse(verify.stdout).groups.find((g) => g.host === 'claude' && g.lane === 'mechanical').count).toBe(1);
  });

  it('record rejects an invalid record without touching the ledger', () => {
    writeFileSync(file, '[]\n');
    const result = runCli(['record', '--host', 'unsupported_host', '--lane', 'mechanical', '--raw-ms', '1000', '--file', file]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/host/);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual([]);
  });

  it('record rejects negative adjusted timing and preserves the destination byte-for-byte', () => {
    writeFileSync(file, '[\n]\n');
    const before = readFileSync(file);

    const result = runCli([
      'record', '--host', 'claude', '--lane', 'mechanical', '--raw-ms', '100',
      '--test-ms', '70', '--remote-ci-ms', '31', '--file', file,
    ]);

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('benchmark-v2: record timing components exceed raw_ms\n');
    expect(readFileSync(file)).toEqual(before);
  });

  it('rejects malformed and unknown-field existing records before certification with identifier-free diagnostics', () => {
    const privateIdentifier = 'run-private-malformed-ledger';
    for (const record of [
      { host: 'claude', lane: 'mechanical', raw_ms: null },
      { host: 'claude', lane: 'mechanical', raw_ms: 1, run_id: privateIdentifier },
    ]) {
      const malformed = Array.from({ length: 20 }, () => record);
      writeFileSync(file, `${JSON.stringify(malformed)}\n`);
      const before = readFileSync(file);

      const result = runCli(['verify', file]);

      expect(result.status).not.toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('benchmark-v2: benchmark ledger contains an invalid record\n');
      expect(result.stderr).not.toContain(privateIdentifier);
      expect(result.stderr).not.toMatch(/run_id|null|raw_ms/iu);
      expect(readFileSync(file)).toEqual(before);
    }
  });

  it('publishes finite pre-allocation ceilings for ledger, history, and serialized output', () => {
    const limits = benchmarkModule.BENCHMARK_LIMITS;
    for (const key of [
      'existingLedgerBytes',
      'ledgerRecords',
      'ledgerOutputBytes',
      'historyEntries',
      'historyEntryBytes',
      'historyTotalBytes',
    ]) {
      expect(Number.isSafeInteger(limits?.[key]), key).toBe(true);
      expect(limits?.[key], key).toBeGreaterThan(0);
    }
    expect(limits.historyTotalBytes).toBeGreaterThanOrEqual(limits.historyEntryBytes);
  });

  it('rejects a symlink ledger without changing its target or replacing the link', () => {
    const victim = join(tempRoot, 'victim.json');
    writeFileSync(victim, '[{"manual":true}]\n');
    rmSync(file, { force: true });
    symlinkSync(victim, file);
    const before = readFileSync(victim);

    const result = runCli([
      'record', '--host', 'claude', '--lane', 'mechanical', '--raw-ms', '120000', '--file', file,
    ]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toBe('benchmark-v2: benchmark ledger must be a regular file\n');
    expect(lstatSync(file).isSymbolicLink()).toBe(true);
    expect(readFileSync(victim)).toEqual(before);
  });

  it('rejects an oversized existing ledger before parsing its invalid JSON tail and preserves every byte', () => {
    const configuredLimit = benchmarkModule.BENCHMARK_LIMITS?.existingLedgerBytes;
    const byteLimit = Number.isSafeInteger(configuredLimit) && configuredLimit > 0
      ? configuredLimit
      : 64 * 1024;
    const privateIdentifier = 'run-private-tail-must-not-appear';
    const oversized = Buffer.from(`[${' '.repeat(byteLimit)}{"run_id":"${privateIdentifier}"},not-json`);
    writeFileSync(file, oversized);
    const before = readFileSync(file);

    const result = runCli(['verify', file]);

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('benchmark-v2: existing benchmark ledger exceeds byte limit\n');
    expect(result.stderr).not.toMatch(/run-private|JSON|parse|Unexpected|position|token/iu);
    expect(readFileSync(file)).toEqual(before);
    expect(configuredLimit).toBe(byteLimit);
  });

  it('rejects a record that would cross the ledger count ceiling without changing the destination', () => {
    const configuredLimit = benchmarkModule.BENCHMARK_LIMITS?.ledgerRecords;
    const recordLimit = Number.isSafeInteger(configuredLimit) && configuredLimit > 0 ? configuredLimit : 64;
    const existing = Array.from({ length: recordLimit }, () => ({
      host: 'claude', lane: 'mechanical', raw_ms: 1, recorded_at: '2026-01-01T00:00:00.000Z',
    }));
    writeFileSync(file, `${JSON.stringify(existing)}\n`);
    const before = readFileSync(file);

    const result = runCli([
      'record', '--host', 'claude', '--lane', 'mechanical', '--raw-ms', '1', '--file', file,
    ]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toBe('benchmark-v2: benchmark ledger record count exceeds limit\n');
    expect(readFileSync(file)).toEqual(before);
    expect(configuredLimit).toBe(recordLimit);
  });

  it.each(['destination', 'staging'])('fails closed on a %s identity race at replacement time', (race) => {
    writeFileSync(file, '[]\n');
    const before = readFileSync(file);
    const racedDestination = Buffer.from('[{"host":"codex","lane":"fast","raw_ms":7,"recorded_at":"2026-01-01T00:00:00.000Z"}]\n');
    const foreignTarget = join(tempRoot, 'foreign-staging-target');
    writeFileSync(foreignTarget, 'foreign staging payload\n');
    const injector = join(tempRoot, `inject-${race}-race.mjs`);
    writeFileSync(injector, `
      import fs from 'node:fs';
      import path from 'node:path';
      import { syncBuiltinESMExports } from 'node:module';
      const originalLstatSync = fs.lstatSync;
      let triggered = false;
      fs.lstatSync = function(file, ...rest) {
        const result = originalLstatSync.call(this, file, ...rest);
        if (!triggered && path.resolve(String(file)) === path.resolve(process.env.APE_RACE_DESTINATION)) {
          const staged = fs.readdirSync(path.dirname(String(file)))
            .find((name) => name.startsWith('.benchmark-ledger.') && name.endsWith('.tmp'));
          if (staged) {
            triggered = true;
            if (process.env.APE_RACE_MODE === 'destination') {
              fs.writeFileSync(String(file), Buffer.from(process.env.APE_RACE_DESTINATION_BYTES, 'base64'));
            } else {
              const stagedPath = path.join(path.dirname(String(file)), staged);
              fs.unlinkSync(stagedPath);
              fs.symlinkSync(process.env.APE_RACE_FOREIGN_TARGET, stagedPath);
            }
          }
        }
        return result;
      };
      syncBuiltinESMExports();
    `);

    const result = runCli([
      'record', '--host', 'claude', '--lane', 'mechanical', '--raw-ms', '120000', '--file', file,
    ], {
      env: {
        NODE_OPTIONS: `--import=${injector}`,
        APE_RACE_MODE: race,
        APE_RACE_DESTINATION: file,
        APE_RACE_DESTINATION_BYTES: racedDestination.toString('base64'),
        APE_RACE_FOREIGN_TARGET: foreignTarget,
      },
    });

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
    if (race === 'destination') {
      expect(readFileSync(file)).toEqual(racedDestination);
    } else {
      expect(readFileSync(file)).toEqual(before);
      const foreignStaging = readdirSync(tempRoot)
        .map((name) => join(tempRoot, name))
        .find((candidate) => lstatSync(candidate).isSymbolicLink());
      expect(foreignStaging).toBeDefined();
      expect(readFileSync(foreignTarget, 'utf8')).toBe('foreign staging payload\n');
    }
  });

  it('fails closed when destination bytes change but injected metadata remains identical', () => {
    writeFileSync(file, '[]\n');
    const racedDestination = Buffer.from('{}\n');
    expect(racedDestination).toHaveLength(readFileSync(file).length);
    const injector = join(tempRoot, 'inject-benchmark-destination-byte-race.mjs');
    writeFileSync(injector, `
      import fs from 'node:fs';
      import path from 'node:path';
      import { syncBuiltinESMExports } from 'node:module';
      const originalLstatSync = fs.lstatSync;
      let baseline;
      let triggered = false;
      fs.lstatSync = function(candidate, ...rest) {
        const result = originalLstatSync.call(this, candidate, ...rest);
        if (path.resolve(String(candidate)) !== path.resolve(process.env.APE_RACE_DESTINATION)) return result;
        const staged = fs.readdirSync(path.dirname(String(candidate)))
          .find((name) => name.startsWith('.benchmark-ledger.') && name.endsWith('.tmp'));
        if (!staged) {
          baseline = result;
          return result;
        }
        if (!triggered) {
          triggered = true;
          fs.writeFileSync(String(candidate), Buffer.from(process.env.APE_RACE_BYTES, 'base64'));
        }
        return baseline;
      };
      syncBuiltinESMExports();
    `);

    const result = runCli([
      'record', '--host', 'claude', '--lane', 'mechanical', '--raw-ms', '120000', '--file', file,
    ], {
      env: {
        NODE_OPTIONS: `--import=${injector}`,
        APE_RACE_DESTINATION: file,
        APE_RACE_BYTES: racedDestination.toString('base64'),
      },
    });

    expect(result.status).not.toBe(0);
    expect(readFileSync(file)).toEqual(racedDestination);
  });

  it('fails closed when the owned staging inode is rewritten with same-size valid bytes', () => {
    writeFileSync(file, '[]\n');
    const before = readFileSync(file);
    const injector = join(tempRoot, 'inject-benchmark-staging-byte-race.mjs');
    writeFileSync(injector, `
      import fs from 'node:fs';
      import path from 'node:path';
      import { syncBuiltinESMExports } from 'node:module';
      const originalLstatSync = fs.lstatSync;
      let triggered = false;
      fs.lstatSync = function(candidate, ...rest) {
        const result = originalLstatSync.call(this, candidate, ...rest);
        const name = path.basename(String(candidate));
        if (!triggered && name.startsWith('.benchmark-ledger.') && name.endsWith('.tmp')) {
          triggered = true;
          const bytes = fs.readFileSync(String(candidate));
          const replacement = Buffer.from(bytes);
          const marker = Buffer.from('claude');
          const offset = replacement.indexOf(marker);
          if (offset < 0) throw new Error('test injector could not find fixed-size marker');
          replacement.set(Buffer.from('codex '), offset);
          fs.writeFileSync(String(candidate), replacement);
        }
        return result;
      };
      syncBuiltinESMExports();
    `);

    const result = runCli([
      'record', '--host', 'claude', '--lane', 'mechanical', '--raw-ms', '120000', '--file', file,
    ], { env: { NODE_OPTIONS: `--import=${injector}` } });

    expect(result.status).not.toBe(0);
    expect(readFileSync(file)).toEqual(before);
  });

  it('fails closed if the primary benchmark lock is replaced after reclaimed-owner metadata is synced', () => {
    writeFileSync(file, '[]\n');
    const before = readFileSync(file);
    const lock = join(tempRoot, '.benchmark-ledger.lock');
    writeFileSync(lock, '{"pid":2147483647}\n', { mode: 0o600 });
    const foreignSource = join(tempRoot, 'foreign-live-benchmark-lock');
    const foreignBytes = Buffer.from(`${JSON.stringify({ pid: process.pid })}\n`);
    writeFileSync(foreignSource, foreignBytes, { mode: 0o600 });
    const foreignIdentity = lstatSync(foreignSource);
    const injector = join(tempRoot, 'replace-primary-benchmark-lock.mjs');
    writeFileSync(injector, `
      import fs from 'node:fs';
      import path from 'node:path';
      import { syncBuiltinESMExports } from 'node:module';
      const primary = path.resolve(process.env.APE_PRIMARY_LOCK);
      const foreign = path.resolve(process.env.APE_FOREIGN_LOCK_SOURCE);
      const originalFsyncSync = fs.fsyncSync;
      let injected = false;
      fs.fsyncSync = function(fd, ...rest) {
        const result = originalFsyncSync.call(this, fd, ...rest);
        if (!injected) {
          try {
            const metadata = JSON.parse(fs.readFileSync(primary, 'utf8'));
            if (metadata.pid === process.pid) {
              injected = true;
              fs.unlinkSync(primary);
              fs.linkSync(foreign, primary);
            }
          } catch {}
        }
        return result;
      };
      syncBuiltinESMExports();
    `);

    const result = runCli([
      'record', '--host', 'claude', '--lane', 'mechanical', '--raw-ms', '120000', '--file', file,
    ], {
      timeout: 1_500,
      env: {
        NODE_OPTIONS: `--import=${injector}`,
        APE_PRIMARY_LOCK: lock,
        APE_FOREIGN_LOCK_SOURCE: foreignSource,
      },
    });

    expect(result.status).not.toBe(0);
    expect(readFileSync(file)).toEqual(before);
    expect(readFileSync(foreignSource)).toEqual(foreignBytes);
    expect(readFileSync(lock)).toEqual(foreignBytes);
    const current = lstatSync(lock);
    expect({ dev: current.dev, ino: current.ino }).toEqual({
      dev: foreignIdentity.dev,
      ino: foreignIdentity.ino,
    });
  });

  it('reclaims a stale hard-linked benchmark lock without writing through the foreign inode', () => {
    writeFileSync(file, '[]\n');
    const lock = join(tempRoot, '.benchmark-ledger.lock');
    const victim = join(tempRoot, 'benchmark-lock-hardlink-victim');
    const victimBytes = Buffer.from('{"pid":2147483647}\n');
    writeFileSync(victim, victimBytes, { mode: 0o600 });
    linkSync(victim, lock);
    const victimIdentity = lstatSync(victim);

    const result = runCli([
      'record', '--host', 'claude', '--lane', 'mechanical', '--raw-ms', '120000', '--file', file,
    ], { timeout: 1_500 });

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(victim)).toEqual(victimBytes);
    const currentVictim = lstatSync(victim);
    expect({ dev: currentVictim.dev, ino: currentVictim.ino }).toEqual({
      dev: victimIdentity.dev,
      ino: victimIdentity.ino,
    });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toHaveLength(1);
    expect(() => lstatSync(lock)).toThrow(/ENOENT/u);
  });

  it.each([
    ['young', 0, false],
    ['lease-expired', 61_000, true],
  ])('%s oversized malformed benchmark locks obey the conservative lease', (_label, ageMs, recovers) => {
    writeFileSync(file, '[]\n');
    const before = readFileSync(file);
    const lock = join(tempRoot, '.benchmark-ledger.lock');
    const oversized = Buffer.alloc(4 * 1024 + 1, 0x78);
    writeFileSync(lock, oversized, { mode: 0o600 });
    if (ageMs > 0) {
      const old = new Date(Date.now() - ageMs);
      utimesSync(lock, old, old);
    }
    const beforeIdentity = lstatSync(lock);

    const result = runCli([
      'record', '--host', 'claude', '--lane', 'mechanical', '--raw-ms', '120000', '--file', file,
    ], { timeout: recovers ? 1_500 : 400 });

    if (recovers) {
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(readFileSync(file, 'utf8'))).toHaveLength(1);
      expect(() => lstatSync(lock)).toThrow(/ENOENT/u);
    } else {
      expect(result.status).not.toBe(0);
      expect(readFileSync(file)).toEqual(before);
      expect(readFileSync(lock)).toEqual(oversized);
      const current = lstatSync(lock);
      expect({ dev: current.dev, ino: current.ino }).toEqual({
        dev: beforeIdentity.dev,
        ino: beforeIdentity.ino,
      });
    }
  });

  it('preserves a replacement oversized benchmark lock injected during reclaim revalidation', () => {
    writeFileSync(file, '[]\n');
    const before = readFileSync(file);
    const lock = join(tempRoot, '.benchmark-ledger.lock');
    writeFileSync(lock, Buffer.alloc(4 * 1024 + 1, 0x78), { mode: 0o600 });
    const old = new Date(Date.now() - 61_000);
    utimesSync(lock, old, old);
    const foreignSource = join(tempRoot, 'replacement-oversized-benchmark-lock');
    const foreignBytes = Buffer.alloc(4 * 1024 + 1, 0x79);
    writeFileSync(foreignSource, foreignBytes, { mode: 0o600 });
    const foreignIdentity = lstatSync(foreignSource);
    const marker = join(tempRoot, 'oversized-benchmark-lock-replaced');
    const injector = join(tempRoot, 'mutate-oversized-benchmark-lock.mjs');
    writeFileSync(injector, `
      import fs from 'node:fs';
      import path from 'node:path';
      import { syncBuiltinESMExports } from 'node:module';
      const primary = path.resolve(process.env.APE_PRIMARY_LOCK);
      const foreign = path.resolve(process.env.APE_FOREIGN_LOCK_SOURCE);
      const marker = path.resolve(process.env.APE_MUTATION_MARKER);
      const prefix = path.basename(primary) + '.reclaimer-';
      const originalLstatSync = fs.lstatSync;
      let injected = false;
      fs.lstatSync = function(candidate, ...rest) {
        const result = originalLstatSync.call(this, candidate, ...rest);
        if (!injected && path.resolve(String(candidate)) === primary
          && fs.readdirSync(path.dirname(primary)).some((name) => name.startsWith(prefix))) {
          injected = true;
          fs.unlinkSync(primary);
          fs.linkSync(foreign, primary);
          fs.writeFileSync(marker, 'injected\\n');
        }
        return result;
      };
      syncBuiltinESMExports();
    `);

    const result = runCli([
      'record', '--host', 'claude', '--lane', 'mechanical', '--raw-ms', '120000', '--file', file,
    ], {
      timeout: 1_500,
      env: {
        NODE_OPTIONS: `--import=${injector}`,
        APE_PRIMARY_LOCK: lock,
        APE_FOREIGN_LOCK_SOURCE: foreignSource,
        APE_MUTATION_MARKER: marker,
      },
    });

    expect(result.status).not.toBe(0);
    expect(readFileSync(marker, 'utf8')).toBe('injected\n');
    expect(readFileSync(file)).toEqual(before);
    expect(readFileSync(foreignSource)).toEqual(foreignBytes);
    expect(readFileSync(lock)).toEqual(foreignBytes);
    const current = lstatSync(lock);
    expect({ dev: current.dev, ino: current.ino }).toEqual({
      dev: foreignIdentity.dev,
      ino: foreignIdentity.ino,
    });
  });

  it.each([
    ['confirmed-dead metadata', '{"pid":2147483647}\n', 0],
    ['lease-expired empty metadata', '', 61_000],
    ['lease-expired malformed metadata', '{not-json\n', 61_000],
  ])('recovers an unchanged %s benchmark writer lock', (_label, contents, ageMs) => {
    writeFileSync(file, '[]\n');
    const lock = join(tempRoot, '.benchmark-ledger.lock');
    writeFileSync(lock, contents, { mode: 0o600 });
    if (ageMs > 0) {
      const old = new Date(Date.now() - ageMs);
      utimesSync(lock, old, old);
    }

    const result = runCli([
      'record', '--host', 'claude', '--lane', 'mechanical', '--raw-ms', '120000', '--file', file,
    ], { timeout: 1_500 });

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toHaveLength(1);
    expect(() => lstatSync(lock)).toThrow(/ENOENT/u);
  });

  it.each(['before-metadata', 'after-metadata'])(
    'recovers after a benchmark stale-lock reclaimer dies %s',
    (deathBoundary) => {
      writeFileSync(file, '[]\n');
      const lock = join(tempRoot, '.benchmark-ledger.lock');
      const claim = `${lock}.reclaim`;
      writeFileSync(lock, '{"pid":2147483647}\n', { mode: 0o600 });
      const injector = join(tempRoot, `kill-benchmark-reclaimer-${deathBoundary}.mjs`);
      writeFileSync(injector, `
        import fs from 'node:fs';
        import path from 'node:path';
        import { syncBuiltinESMExports } from 'node:module';
        const claim = path.resolve(process.env.APE_RECLAIM_CLAIM);
        const boundary = process.env.APE_RECLAIM_DEATH_BOUNDARY;
        const originalLinkSync = fs.linkSync;
        const originalFsyncSync = fs.fsyncSync;
        fs.linkSync = function(from, to, ...rest) {
          const result = originalLinkSync.call(this, from, to, ...rest);
          if (boundary === 'before-metadata' && path.resolve(String(to)) === claim) {
            process.kill(process.pid, 'SIGKILL');
          }
          return result;
        };
        fs.fsyncSync = function(fd, ...rest) {
          const result = originalFsyncSync.call(this, fd, ...rest);
          if (boundary === 'after-metadata' && fs.existsSync(claim)) {
            try {
              const metadata = JSON.parse(fs.readFileSync(claim, 'utf8'));
              if (metadata.pid === process.pid) process.kill(process.pid, 'SIGKILL');
            } catch {}
          }
          return result;
        };
        syncBuiltinESMExports();
      `);

      const crashed = runCli([
        'record', '--host', 'claude', '--lane', 'mechanical', '--raw-ms', '120000', '--file', file,
      ], {
        timeout: 2_000,
        env: {
          NODE_OPTIONS: `--import=${injector}`,
          APE_RECLAIM_CLAIM: claim,
          APE_RECLAIM_DEATH_BOUNDARY: deathBoundary,
        },
      });

      expect(crashed.signal).toBe('SIGKILL');
      expect(lstatSync(claim).isFile()).toBe(true);
      if (deathBoundary === 'after-metadata') {
        expect(JSON.parse(readFileSync(claim, 'utf8'))).toEqual({ pid: crashed.pid });
      }

      const recovered = runCli([
        'record', '--host', 'codex', '--lane', 'mechanical', '--raw-ms', '120001', '--file', file,
      ], { timeout: 1_500 });

      expect(recovered.status, recovered.stderr).toBe(0);
      expect(JSON.parse(readFileSync(file, 'utf8'))).toHaveLength(1);
      expect(() => lstatSync(lock)).toThrow(/ENOENT/u);
      expect(() => lstatSync(claim)).toThrow(/ENOENT/u);
    },
    10_000,
  );

  it('recovers a dead benchmark lock without deleting a foreign reclaim object', () => {
    writeFileSync(file, '[]\n');
    const lock = join(tempRoot, '.benchmark-ledger.lock');
    const claim = `${lock}.reclaim`;
    const foreignBytes = Buffer.from('foreign reclaim owner\n');
    writeFileSync(lock, '{"pid":2147483647}\n', { mode: 0o600 });
    writeFileSync(claim, foreignBytes, { mode: 0o600 });
    const foreignIdentity = lstatSync(claim);

    const recovered = runCli([
      'record', '--host', 'codex', '--lane', 'mechanical', '--raw-ms', '120001', '--file', file,
    ], { timeout: 1_500 });

    expect(recovered.status, recovered.stderr).toBe(0);
    expect(readFileSync(claim)).toEqual(foreignBytes);
    const currentForeignIdentity = lstatSync(claim);
    expect({ dev: currentForeignIdentity.dev, ino: currentForeignIdentity.ino }).toEqual({
      dev: foreignIdentity.dev,
      ino: foreignIdentity.ino,
    });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toHaveLength(1);
  });

  it.each([
    ['live metadata owner', () => `{"pid":${process.pid}}\n`, 0, null],
    ['permission-ambiguous metadata owner', () => '{"pid":424242}\n', 61_000, 'eperm'],
    ['young empty metadata', () => '', 0, null],
    ['young malformed metadata', () => '{not-json\n', 0, null],
  ])('does not reclaim a %s benchmark writer lock', (_label, makeContents, ageMs, probe) => {
    writeFileSync(file, '[]\n');
    const lock = join(tempRoot, '.benchmark-ledger.lock');
    const contents = makeContents();
    writeFileSync(lock, contents, { mode: 0o600 });
    if (ageMs > 0) {
      const old = new Date(Date.now() - ageMs);
      utimesSync(lock, old, old);
    }
    let injector;
    if (probe === 'eperm') {
      injector = join(tempRoot, 'inject-benchmark-eperm.mjs');
      writeFileSync(injector, `
        const originalKill = process.kill.bind(process);
        process.kill = function(pid, signal) {
          if (signal === 0) {
            const error = new Error('injected permission ambiguity');
            error.code = 'EPERM';
            throw error;
          }
          return originalKill(pid, signal);
        };
      `);
    }
    const beforeIdentity = lstatSync(lock);

    const result = runCli([
      'record', '--host', 'claude', '--lane', 'mechanical', '--raw-ms', '120000', '--file', file,
    ], {
      timeout: 400,
      ...(injector ? { env: { NODE_OPTIONS: `--import=${injector}` } } : {}),
    });

    expect(result.status).not.toBe(0);
    expect(readFileSync(lock, 'utf8')).toBe(contents);
    const afterIdentity = lstatSync(lock);
    expect({ dev: afterIdentity.dev, ino: afterIdentity.ino }).toEqual({
      dev: beforeIdentity.dev,
      ino: beforeIdentity.ino,
    });
    expect(readFileSync(file, 'utf8')).toBe('[]\n');
  });

  it.each(['file', 'symlink'])('treats a pre-existing %s at a randomized staging candidate as an untouched collision', (kind) => {
    writeFileSync(file, '[]\n');
    const before = readFileSync(file);
    const victim = join(tempRoot, 'collision-victim');
    writeFileSync(victim, 'collision victim bytes\n');
    const collision = join(tempRoot, `.benchmark-ledger.${'ab'.repeat(16)}.tmp`);
    if (kind === 'symlink') symlinkSync(victim, collision);
    else writeFileSync(collision, 'existing collision bytes\n');
    const injector = join(tempRoot, 'fixed-benchmark-random.mjs');
    writeFileSync(injector, `
      import crypto from 'node:crypto';
      import { syncBuiltinESMExports } from 'node:module';
      crypto.randomBytes = (size) => Buffer.alloc(size, 0xab);
      syncBuiltinESMExports();
    `);

    const result = runCli([
      'record', '--host', 'claude', '--lane', 'mechanical', '--raw-ms', '120000', '--file', file,
    ], { env: { NODE_OPTIONS: `--import=${injector}` } });

    expect(result.status).not.toBe(0);
    expect(readFileSync(file)).toEqual(before);
    expect(readFileSync(victim, 'utf8')).toBe('collision victim bytes\n');
    expect(lstatSync(collision).isSymbolicLink()).toBe(kind === 'symlink');
    if (kind === 'file') expect(readFileSync(collision, 'utf8')).toBe('existing collision bytes\n');
  });

  it('does not rename or retain its owned staging file when owned-handle sync fails', () => {
    writeFileSync(file, '[]\n');
    const before = readFileSync(file);
    const injector = join(tempRoot, 'fail-benchmark-sync.mjs');
    writeFileSync(injector, `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      fs.fsyncSync = () => { throw new Error('injected owned-handle sync failure'); };
      syncBuiltinESMExports();
    `);

    const result = runCli([
      'record', '--host', 'claude', '--lane', 'mechanical', '--raw-ms', '120000', '--file', file,
    ], { env: { NODE_OPTIONS: `--import=${injector}` } });

    expect(result.status).not.toBe(0);
    expect(readFileSync(file)).toEqual(before);
    expect(readdirSync(tempRoot).filter((name) => name.startsWith('.benchmark-ledger.'))).toEqual([]);
  });

  it('never silently loses a record when two writers race from the same ledger snapshot', async () => {
    writeFileSync(file, '[]\n');
    const barrier = join(tempRoot, 'writer-barrier');
    mkdirSync(barrier);
    const injector = join(tempRoot, 'benchmark-writer-barrier.mjs');
    writeFileSync(injector, `
      import fs from 'node:fs';
      import path from 'node:path';
      import { syncBuiltinESMExports } from 'node:module';
      const barrier = process.env.APE_WRITER_BARRIER;
      const pause = new Int32Array(new SharedArrayBuffer(4));
      fs.writeFileSync(path.join(barrier, process.pid + '.loaded'), '');
      while (!fs.existsSync(path.join(barrier, process.pid + '.start'))) Atomics.wait(pause, 0, 0, 10);
      const originalRenameSync = fs.renameSync;
      fs.renameSync = function(from, to) {
        if (path.resolve(String(to)) === path.resolve(process.env.APE_WRITER_DESTINATION)) {
          fs.writeFileSync(path.join(barrier, process.pid + '.ready'), '');
          while (!fs.existsSync(path.join(barrier, process.pid + '.release'))) Atomics.wait(pause, 0, 0, 10);
        }
        return originalRenameSync.call(this, from, to);
      };
      syncBuiltinESMExports();
    `);
    const spawnWriter = (host, rawMs) => spawn(process.execPath, [
      SCRIPT, 'record', '--host', host, '--lane', 'mechanical', '--raw-ms', String(rawMs), '--file', file,
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        NODE_OPTIONS: `--import=${injector}`,
        APE_WRITER_BARRIER: barrier,
        APE_WRITER_DESTINATION: file,
      },
    });
    const first = spawnWriter('claude', 101);
    const second = spawnWriter('codex', 202);
    const firstResult = completedChild(first);
    const secondResult = completedChild(second);
    expect(await waitForFileCount(barrier, '.loaded', 2, 3_000)).toBe(true);
    writeFileSync(join(barrier, `${first.pid}.start`), '');
    writeFileSync(join(barrier, `${second.pid}.start`), '');
    expect(await waitForFileCount(barrier, '.ready', 1, 3_000)).toBe(true);
    await waitForFileCount(barrier, '.ready', 2, 1_000);
    writeFileSync(join(barrier, `${first.pid}.release`), '');
    writeFileSync(join(barrier, `${second.pid}.release`), '');
    const outcomes = await Promise.all([firstResult, secondResult]);
    const ledger = JSON.parse(readFileSync(file, 'utf8'));
    const passed = outcomes.filter((result) => result.status === 0);
    const failed = outcomes.filter((result) => result.status !== 0);

    expect(
      (passed.length === 2 && failed.length === 0 && ledger.length === 2)
      || (passed.length === 1 && failed.length === 1 && ledger.length === 1),
    ).toBe(true);
    expect(new Set(ledger.map((record) => `${record.host}:${record.raw_ms}`)).size).toBe(ledger.length);
  }, 10_000);

  it('serializes two writers that concurrently reclaim the same confirmed-dead lock', async () => {
    writeFileSync(file, '[]\n');
    const lock = join(tempRoot, '.benchmark-ledger.lock');
    writeFileSync(lock, '{"pid":2147483647}\n', { mode: 0o600 });
    const barrier = join(tempRoot, 'stale-lock-reclaimer-barrier');
    mkdirSync(barrier);
    const injector = join(tempRoot, 'benchmark-stale-lock-reclaimers.mjs');
    writeFileSync(injector, `
      import fs from 'node:fs';
      import path from 'node:path';
      import { syncBuiltinESMExports } from 'node:module';
      const lock = path.resolve(process.env.APE_STALE_LOCK);
      const destination = path.resolve(process.env.APE_WRITER_DESTINATION);
      const barrier = process.env.APE_WRITER_BARRIER;
      const pause = new Int32Array(new SharedArrayBuffer(4));
      const originalOpenSync = fs.openSync;
      const originalUnlinkSync = fs.unlinkSync;
      const originalRenameSync = fs.renameSync;
      let reclaimAttempted = false;
      fs.unlinkSync = function(candidate, ...rest) {
        if (!reclaimAttempted && path.resolve(String(candidate)) === lock) {
          reclaimAttempted = true;
          fs.writeFileSync(path.join(barrier, process.pid + '.unlink-ready'), '');
          const deadline = Date.now() + 750;
          while (Date.now() < deadline
            && fs.readdirSync(barrier).filter((name) => name.endsWith('.unlink-ready')).length < 2) {
            Atomics.wait(pause, 0, 0, 10);
          }
          const participants = fs.readdirSync(barrier)
            .filter((name) => name.endsWith('.unlink-ready'))
            .map((name) => Number(name.split('.')[0]))
            .sort((left, right) => left - right);
          if (participants.length >= 2 && process.pid !== participants[0]) {
            while (!fs.existsSync(path.join(barrier, 'successor-acquired'))) Atomics.wait(pause, 0, 0, 10);
          }
          return originalUnlinkSync.call(this, candidate, ...rest);
        }
        return originalUnlinkSync.call(this, candidate, ...rest);
      };
      fs.openSync = function(candidate, flags, ...rest) {
        const fd = originalOpenSync.call(this, candidate, flags, ...rest);
        if (reclaimAttempted && path.resolve(String(candidate)) === lock && flags === 'wx') {
          fs.writeFileSync(path.join(barrier, 'successor-acquired'), String(process.pid));
        }
        return fd;
      };
      fs.renameSync = function(from, to) {
        if (path.resolve(String(to)) === destination) {
          fs.writeFileSync(path.join(barrier, process.pid + '.rename-ready'), '');
          while (!fs.existsSync(path.join(barrier, process.pid + '.release'))) Atomics.wait(pause, 0, 0, 10);
        }
        return originalRenameSync.call(this, from, to);
      };
      syncBuiltinESMExports();
    `);
    const spawnWriter = (host, rawMs) => spawn(process.execPath, [
      SCRIPT, 'record', '--host', host, '--lane', 'mechanical', '--raw-ms', String(rawMs), '--file', file,
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        NODE_OPTIONS: `--import=${injector}`,
        APE_STALE_LOCK: lock,
        APE_WRITER_BARRIER: barrier,
        APE_WRITER_DESTINATION: file,
      },
    });
    const first = spawnWriter('claude', 101);
    const second = spawnWriter('codex', 202);
    const outcomes = [completedChild(first), completedChild(second)];
    expect(await waitForFileCount(barrier, '.rename-ready', 1, 4_000)).toBe(true);
    const overlapped = await waitForFileCount(barrier, '.rename-ready', 2, 1_000);
    const readyPids = readdirSync(barrier)
      .filter((name) => name.endsWith('.rename-ready'))
      .map((name) => name.split('.')[0]);
    for (const pid of readyPids) writeFileSync(join(barrier, `${pid}.release`), '');
    if (!overlapped) {
      expect(await waitForFileCount(barrier, '.rename-ready', 2, 4_000)).toBe(true);
      for (const child of [first, second]) writeFileSync(join(barrier, `${child.pid}.release`), '');
    }
    const results = await Promise.all(outcomes);

    expect(results.every((result) => result.status === 0), results).toBe(true);
    expect(overlapped).toBe(false);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toHaveLength(2);
  }, 15_000);
});

describe('appendBenchmarkRecord', () => {
  it('creates the ledger file when absent and accumulates records', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'ape-benchmark-append-'));
    const file = join(tempRoot, 'reference-runs.json');
    try {
      const first = appendBenchmarkRecord(file, { host: 'codex', lane: 'full', raw_ms: 1_000_000 });
      expect(first.count).toBe(1);
      const second = appendBenchmarkRecord(file, { host: 'codex', lane: 'full', raw_ms: 2_000_000 });
      expect(second.count).toBe(2);
      expect(JSON.parse(readFileSync(file, 'utf8'))).toHaveLength(2);
      expect(statSync(file).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

// T14: the benchmark producer derives certification records from a project's
// machine history on demand. These tests operate on TEMP-DIR ledgers only and
// never touch the tracked benchmarks/reference-runs.json.
describe('benchmark import from run history', () => {
  let projectDir;
  let historyDir;
  let ledgerRoot;
  let file;

  function writeRecord(record) {
    writeFileSync(join(historyDir, `${record.run_id}.json`), `${JSON.stringify(record, null, 2)}\n`);
  }

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'ape-import-project-'));
    historyDir = join(projectDir, '.ape', 'runtime', 'history');
    mkdirSync(historyDir, { recursive: true });
    ledgerRoot = mkdtempSync(join(tmpdir(), 'ape-import-ledger-'));
    file = join(ledgerRoot, 'reference-runs.json');
    writeFileSync(file, '[]\n');

    // a — completed run archived under the LEGACY 'patch' mode label WITH a
    // runtime timing block and an explicit host: history is immutable, so the
    // old label must stay certifiable. The lane sets its group.
    writeRecord({
      run_id: 'run-aaaa', status: 'completed', mode: 'patch', lane: 'mechanical',
      created_at: '2026-07-01T00:00:00.000Z', completed_at: '2026-07-01T00:05:00.000Z',
      host: 'claude',
      timing: { raw_ms: 300_000, test_ms: 40_000, remote_ci_ms: 20_000 },
      record_hash: 'a'.repeat(64),
    });
    // b — completed phase run PREDATING timing: host falls back to
    // receipts[0].agent.host, test/CI default to 0, raw_ms derives from the
    // timestamps (20 min).
    writeRecord({
      run_id: 'run-bbbb', status: 'completed', mode: 'phase', lane: 'full',
      created_at: '2026-07-01T00:00:00.000Z', completed_at: '2026-07-01T00:20:00.000Z',
      receipts: [{ agent: { host: 'codex', role: 'implementer' } }],
      record_hash: 'b'.repeat(64),
    });
    // c — a blocked run is never certifiable: skipped.
    writeRecord({
      run_id: 'run-cccc', status: 'blocked', mode: 'phase', lane: 'fast',
      created_at: '2026-07-01T00:00:00.000Z', completed_at: '2026-07-01T00:03:00.000Z',
      host: 'claude', record_hash: 'c'.repeat(64),
    });
    // d — a legacy imported record (mode 'import', no wall clock): skipped by
    // the building-mode filter.
    writeRecord({
      run_id: 'run-dddd', status: 'completed', mode: 'import',
      host: 'claude', record_hash: 'd'.repeat(64),
    });
    // e — a corrupt timing block whose test_ms + remote_ci_ms exceeds raw_ms
    // would certify with a NEGATIVE adjusted_ms: skipped WITH a printed reason.
    writeRecord({
      run_id: 'run-eeee', status: 'completed', mode: 'phase', lane: 'mechanical',
      created_at: '2026-07-01T00:00:00.000Z', completed_at: '2026-07-01T00:01:00.000Z',
      host: 'claude',
      timing: { raw_ms: 60_000, test_ms: 50_000, remote_ci_ms: 20_000 },
      record_hash: 'e'.repeat(64),
    });
    // f — a completed building run with no archived lane cannot be grouped:
    // skipped WITH a reason, never guessed into a lane.
    writeRecord({
      run_id: 'run-ffff', status: 'completed', mode: 'phase',
      created_at: '2026-07-01T00:00:00.000Z', completed_at: '2026-07-01T00:02:00.000Z',
      host: 'claude', record_hash: 'f'.repeat(64),
    });
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(ledgerRoot, { recursive: true, force: true });
  });

  it('imports only certifiable effective runs, preserves manual rows, and emits no source identifiers', () => {
    const manual = {
      host: 'codex', lane: 'fast', raw_ms: 42_000, recorded_at: '2026-06-01T00:00:00.000Z',
    };
    writeFileSync(file, `${JSON.stringify([manual], null, 2)}\n`);
    const result = runCli(['import', '--project', projectDir, '--file', file]);
    expect(result.status).toBe(0);

    const ledger = JSON.parse(readFileSync(file, 'utf8'));
    expect(ledger).toHaveLength(3);
    expect(ledger).toContainEqual(manual);
    expect(ledger.find((record) => record.host === 'claude')).toMatchObject({
      host: 'claude', lane: 'mechanical', raw_ms: 300_000, test_ms: 40_000, remote_ci_ms: 20_000,
    });
    // Pre-timing record: host from the receipts fallback, zero-defaulted
    // test/CI, and a raw_ms derived from created_at -> completed_at.
    expect(ledger.find((record) => record.host === 'codex' && record.lane === 'full')).toMatchObject({
      host: 'codex', lane: 'full', raw_ms: 1_200_000, test_ms: 0, remote_ci_ms: 0,
    });
    expect(ledger.every((record) => typeof record.recorded_at === 'string')).toBe(true);

    // Skips remain observable only as bounded aggregate reason counts. Neither
    // the durable ledger nor operator diagnostics may carry source identifiers.
    const report = JSON.parse(result.stdout);
    expect(Array.isArray(report.skipped)).toBe(true);
    for (const skipped of report.skipped) {
      expect(skipped).toEqual({ reason: expect.any(String), count: expect.any(Number) });
      expect(skipped.count).toBeGreaterThan(0);
    }
    const emitted = `${readFileSync(file, 'utf8')}\n${result.stdout}\n${result.stderr}`;
    for (const forbidden of ['run-aaaa', 'run-bbbb', 'run-cccc', 'run-dddd', 'run-eeee', 'run-ffff', historyDir, file]) {
      expect(emitted).not.toContain(forbidden);
    }
  });

  it('is byte-idempotent and replaces a superseded history timing exactly once', () => {
    expect(runCli(['import', '--project', projectDir, '--file', file]).status).toBe(0);
    const first = readFileSync(file);
    expect(runCli(['import', '--project', projectDir, '--file', file]).status).toBe(0);
    expect(readFileSync(file)).toEqual(first);

    writeFileSync(join(historyDir, 'run-aaaa-superseding.json'), `${JSON.stringify({
      run_id: 'run-aaaa', status: 'completed', mode: 'patch', lane: 'mechanical',
      created_at: '2026-07-01T00:00:00.000Z', completed_at: '2026-07-01T00:06:00.000Z',
      host: 'claude',
      timing: { raw_ms: 360_000, test_ms: 40_000, remote_ci_ms: 20_000 },
      record_hash: 'f'.repeat(64),
    }, null, 2)}\n`);
    expect(runCli(['import', '--project', projectDir, '--file', file]).status).toBe(0);
    const ledger = JSON.parse(readFileSync(file, 'utf8'));
    const claudeMechanical = ledger.filter((record) => record.host === 'claude' && record.lane === 'mechanical');
    expect(claudeMechanical).toHaveLength(1);
    expect(claudeMechanical[0].raw_ms).toBe(360_000);
  });

  it('deterministically rejects completed legacy history without completed_at and remains byte-idempotent', () => {
    rmSync(historyDir, { recursive: true, force: true });
    mkdirSync(historyDir, { recursive: true });
    const privateIdentifier = 'run-private-missing-completed-at';
    writeRecord({
      run_id: privateIdentifier,
      status: 'completed',
      mode: 'phase',
      lane: 'fast',
      host: 'codex',
      created_at: '2026-07-01T00:00:00.000Z',
      timing: { raw_ms: 60_000, test_ms: 10_000, remote_ci_ms: 5_000 },
      record_hash: 'f'.repeat(64),
    });
    const injector = join(projectDir, 'fixed-import-clock.mjs');
    writeFileSync(injector, `
      const OriginalDate = Date;
      globalThis.Date = class extends OriginalDate {
        constructor(...args) {
          super(...(args.length > 0 ? args : [process.env.APE_FIXED_IMPORT_TIME]));
        }
        static now() { return OriginalDate.parse(process.env.APE_FIXED_IMPORT_TIME); }
      };
    `);
    const runImport = (timestamp) => runCli(['import', '--project', projectDir, '--file', file], {
      env: {
        NODE_OPTIONS: `--import=${injector}`,
        APE_FIXED_IMPORT_TIME: timestamp,
      },
    });

    const first = runImport('2026-07-02T00:00:00.000Z');
    expect(first.status, first.stderr).toBe(0);
    const firstBytes = readFileSync(file);
    const second = runImport('2026-07-03T00:00:00.000Z');
    expect(second.status, second.stderr).toBe(0);
    expect(readFileSync(file)).toEqual(firstBytes);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual([]);
    const emitted = `${first.stdout}\n${first.stderr}\n${second.stdout}\n${second.stderr}`;
    expect(emitted).toMatch(/completed_at|stable completion time|timing is unavailable/iu);
    expect(emitted).not.toContain(privateIdentifier);
    expect(emitted).not.toMatch(/record_hash|\.json|ape-import-project|ape-import-ledger/iu);
  });

  it('migrates a prior-format ledger with run_id without losing the observation or retaining the identifier', () => {
    rmSync(historyDir, { recursive: true, force: true });
    mkdirSync(historyDir, { recursive: true });
    const privateIdentifier = 'run-prior-import-format-private';
    const priorObservation = {
      host: 'claude',
      lane: 'mechanical',
      raw_ms: 123_456,
      test_ms: 12_345,
      remote_ci_ms: 2_345,
      recorded_at: '2026-06-01T00:00:00.000Z',
      run_id: privateIdentifier,
    };
    writeFileSync(file, `${JSON.stringify([priorObservation], null, 2)}\n`);

    const first = runCli(['import', '--project', projectDir, '--file', file]);
    expect(first.status, first.stderr).toBe(0);
    const firstBytes = readFileSync(file);
    expect(JSON.parse(firstBytes.toString('utf8'))).toEqual([{
      host: priorObservation.host,
      lane: priorObservation.lane,
      raw_ms: priorObservation.raw_ms,
      test_ms: priorObservation.test_ms,
      remote_ci_ms: priorObservation.remote_ci_ms,
      recorded_at: priorObservation.recorded_at,
    }]);
    expect(`${firstBytes}\n${first.stdout}\n${first.stderr}`).not.toContain(privateIdentifier);

    const second = runCli(['import', '--project', projectDir, '--file', file]);
    expect(second.status, second.stderr).toBe(0);
    expect(readFileSync(file)).toEqual(firstBytes);
  });

  it('coalesces ten legacy run_id rows with their matching history records without certifying', () => {
    rmSync(historyDir, { recursive: true, force: true });
    mkdirSync(historyDir, { recursive: true });
    const privateIdentifiers = Array.from(
      { length: 10 },
      (_, index) => `run-private-legacy-match-${String(index).padStart(2, '0')}`,
    );
    const legacyRows = privateIdentifiers.map((run_id, index) => ({
      host: 'claude',
      lane: 'mechanical',
      raw_ms: 60_000 + index,
      test_ms: 10_000,
      remote_ci_ms: 5_000,
      recorded_at: `2026-07-01T00:00:${String(index).padStart(2, '0')}.000Z`,
      run_id,
    }));
    writeFileSync(file, `${JSON.stringify(legacyRows, null, 2)}\n`);
    for (const [index, run_id] of privateIdentifiers.entries()) {
      writeRecord({
        run_id,
        status: 'completed',
        mode: 'phase',
        lane: 'mechanical',
        host: 'claude',
        created_at: '2026-07-01T00:00:00.000Z',
        completed_at: `2026-07-01T00:00:${String(index).padStart(2, '0')}.000Z`,
        timing: { raw_ms: 60_000 + index, test_ms: 10_000, remote_ci_ms: 5_000 },
        record_hash: index.toString(16).repeat(64),
      });
    }

    const first = runCli(['import', '--project', projectDir, '--file', file]);
    expect(first.status, first.stderr).toBe(0);
    const firstBytes = readFileSync(file);
    const ledger = JSON.parse(firstBytes.toString('utf8'));
    expect(ledger).toHaveLength(10);
    expect(ledger.every((record) => !Object.hasOwn(record, 'run_id'))).toBe(true);

    const verification = runCli(['verify', file]);
    expect(verification.status).toBe(1);
    const report = JSON.parse(verification.stdout);
    expect(report.groups.find((group) => group.host === 'claude' && group.lane === 'mechanical')).toMatchObject({
      count: 10,
      certification_status: 'insufficient-records',
    });

    const emitted = `${firstBytes}\n${first.stdout}\n${first.stderr}\n${verification.stdout}\n${verification.stderr}`;
    for (const privateIdentifier of privateIdentifiers) expect(emitted).not.toContain(privateIdentifier);

    const second = runCli(['import', '--project', projectDir, '--file', file]);
    expect(second.status, second.stderr).toBe(0);
    expect(readFileSync(file)).toEqual(firstBytes);
    expect(`${second.stdout}\n${second.stderr}`).not.toMatch(/run-private-legacy-match/iu);
  });

  it('preserves a valid manual row that omits recorded_at across repeat imports', () => {
    rmSync(historyDir, { recursive: true, force: true });
    mkdirSync(historyDir, { recursive: true });
    const manual = { host: 'codex', lane: 'fast', raw_ms: 42_000 };
    writeFileSync(file, `${JSON.stringify([manual], null, 2)}\n`);

    const first = runCli(['import', '--project', projectDir, '--file', file]);
    expect(first.status, first.stderr).toBe(0);
    const firstBytes = readFileSync(file);
    expect(JSON.parse(firstBytes.toString('utf8'))).toEqual([manual]);
    expect(JSON.parse(firstBytes.toString('utf8'))[0]).not.toHaveProperty('recorded_at');

    const second = runCli(['import', '--project', projectDir, '--file', file]);
    expect(second.status, second.stderr).toBe(0);
    expect(readFileSync(file)).toEqual(firstBytes);
  });

  it('validation strips transient history identifiers from durable records', () => {
    const normalized = validateBenchmarkRecord({ host: 'claude', lane: 'mechanical', raw_ms: 120_000, run_id: 'run-xyz' });
    expect(normalized).not.toHaveProperty('run_id');
    expect(JSON.stringify(normalized)).not.toContain('run-xyz');
  });

  it('preserves equal timing observations from distinct effective runs', () => {
    rmSync(historyDir, { recursive: true, force: true });
    mkdirSync(historyDir, { recursive: true });
    for (const run_id of ['run-equal-a', 'run-equal-b']) {
      writeRecord({
        run_id, status: 'completed', mode: 'phase', lane: 'fast', host: 'codex',
        created_at: '2026-07-01T00:00:00.000Z', completed_at: '2026-07-01T00:01:00.000Z',
        timing: { raw_ms: 60_000, test_ms: 10_000, remote_ci_ms: 5_000 },
        record_hash: run_id.endsWith('a') ? 'a'.repeat(64) : 'b'.repeat(64),
      });
    }
    expect(runCli(['import', '--project', projectDir, '--file', file]).status).toBe(0);
    const ledger = JSON.parse(readFileSync(file, 'utf8'));
    expect(ledger).toHaveLength(2);
    expect(ledger[0]).toEqual(ledger[1]);
    expect(readFileSync(file, 'utf8')).not.toMatch(/run-equal|record_hash/iu);
  });

  it('groups history with append-based arrays rather than quadratic copies', () => {
    const source = readFileSync(SCRIPT, 'utf8');
    expect(/byRun\.set\([^;]*\.\.\.\(/su.test(source)).toBe(false);
    expect(/byRun\.get\([^;]*\.push\(/su.test(source)).toBe(true);
  });

  it('rejects an oversized history entry before parsing its private invalid tail', () => {
    rmSync(historyDir, { recursive: true, force: true });
    mkdirSync(historyDir, { recursive: true });
    const configuredLimit = benchmarkModule.BENCHMARK_LIMITS?.historyEntryBytes;
    const byteLimit = Number.isSafeInteger(configuredLimit) && configuredLimit > 0
      ? configuredLimit
      : 64 * 1024;
    const privateIdentifier = 'run-private-history-tail';
    writeFileSync(
      join(historyDir, 'oversized.json'),
      `[${' '.repeat(byteLimit)}{"run_id":"${privateIdentifier}"},not-json`,
    );
    const before = readFileSync(file);

    const result = runCli(['import', '--project', projectDir, '--file', file]);

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('benchmark-v2: history entry exceeds byte limit\n');
    expect(result.stderr).not.toMatch(/run-private|JSON|parse|Unexpected|position|token/iu);
    expect(readFileSync(file)).toEqual(before);
    expect(configuredLimit).toBe(byteLimit);
  });

  it('counts non-JSON directory entries without first materializing an unbounded directory listing', () => {
    rmSync(historyDir, { recursive: true, force: true });
    mkdirSync(historyDir, { recursive: true });
    const configuredLimit = benchmarkModule.BENCHMARK_LIMITS?.historyEntries;
    const entryLimit = Number.isSafeInteger(configuredLimit) && configuredLimit > 0 ? configuredLimit : 64;
    for (let index = 0; index <= entryLimit; index += 1) {
      writeFileSync(join(historyDir, `noise-${String(index).padStart(6, '0')}.txt`), 'noise\n');
    }
    const before = readFileSync(file);

    const result = runCli(['import', '--project', projectDir, '--file', file]);

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('benchmark-v2: history entry count exceeds limit\n');
    expect(readFileSync(file)).toEqual(before);
    expect(configuredLimit).toBe(entryLimit);
  });

  it('rechecks the aggregate opened history bytes before allocation when entries grow after metadata', () => {
    rmSync(historyDir, { recursive: true, force: true });
    mkdirSync(historyDir, { recursive: true });
    const limits = benchmarkModule.BENCHMARK_LIMITS;
    const entryCount = Math.floor(limits.historyTotalBytes / limits.historyEntryBytes) + 1;
    for (let index = 0; index < entryCount; index += 1) {
      writeRecord({
        run_id: `run-growth-${String(index).padStart(4, '0')}`,
        status: 'completed', mode: 'phase', lane: 'mechanical', host: 'claude',
        created_at: '2026-07-01T00:00:00.000Z', completed_at: '2026-07-01T00:00:01.000Z',
        record_hash: String(index).padStart(64, '0').slice(-64),
      });
    }
    const injector = join(projectDir, 'grow-history-before-open.mjs');
    writeFileSync(injector, `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const originalOpenSync = fs.openSync;
      fs.openSync = function(file, flags, ...rest) {
        const name = String(file);
        if (name.startsWith(process.env.APE_GROW_HISTORY_DIR + '/') && name.endsWith('.json')) {
          const target = Number(process.env.APE_GROW_HISTORY_BYTES);
          const current = fs.statSync(name).size;
          if (current < target) {
            const appendFd = originalOpenSync.call(fs, name, 'a');
            try {
              fs.writeSync(appendFd, Buffer.alloc(target - current, 0x20));
            } finally {
              fs.closeSync(appendFd);
            }
          }
        }
        return originalOpenSync.call(this, file, flags, ...rest);
      };
      syncBuiltinESMExports();
    `);
    const before = readFileSync(file);

    const result = runCli(['import', '--project', projectDir, '--file', file], {
      env: {
        NODE_OPTIONS: `--import=${injector}`,
        APE_GROW_HISTORY_DIR: historyDir,
        APE_GROW_HISTORY_BYTES: String(limits.historyEntryBytes),
      },
    });

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('benchmark-v2: history total exceeds byte limit\n');
    expect(readFileSync(file)).toEqual(before);
    expect(entryCount * limits.historyEntryBytes).toBeGreaterThan(limits.historyTotalBytes);
  });
});
