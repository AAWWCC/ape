import { spawn, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  listTestFiles,
  selectCiTests,
} from '../scripts/run-ci-tests.mjs';

const ROOT = process.cwd();
const UPDATE_SCRIPT = join(ROOT, 'scripts', 'update-test-durations.mjs');
const temporaryRoots = [];

function temporaryRoot(prefix) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  temporaryRoots.push(root);
  return root;
}

function fixtureProject() {
  const root = temporaryRoot('ape-duration-contract-');
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'node_modules', 'vitest'), { recursive: true });
  mkdirSync(join(root, '.github'), { recursive: true });
  mkdirSync(join(root, '__tests__'), { recursive: true });
  copyFileSync(UPDATE_SCRIPT, join(root, 'scripts', 'update-test-durations.mjs'));
  writeFileSync(join(root, '__tests__', 'a.test.js'), 'export {}\n');
  writeFileSync(join(root, '__tests__', 'b.test.js'), 'export {}\n');
  writeFileSync(join(root, '.github', 'test-durations.json'), '{"sentinel":17}\n');
  writeFileSync(join(root, 'node_modules', 'vitest', 'vitest.mjs'), `
    import { writeFileSync } from 'node:fs';
    const output = process.argv.find((value) => value.startsWith('--outputFile=')).slice('--outputFile='.length);
    writeFileSync(output, process.env.APE_TEST_REPORT ?? '{}');
    process.exitCode = Number(process.env.APE_TEST_EXIT ?? 0);
  `);
  return root;
}

function timingResult(root, relative, startTime, endTime, status = 'passed') {
  return {
    name: join(root, relative),
    status,
    startTime,
    endTime,
    assertionResults: [],
  };
}

function runRefresh(root, payload, exit = 0, extraEnv = {}, options = {}) {
  return spawnSync(process.execPath, [join(root, 'scripts', 'update-test-durations.mjs')], {
    cwd: root,
    encoding: 'utf8',
    ...(options.timeout ? { timeout: options.timeout } : {}),
    env: {
      ...process.env,
      APE_TEST_REPORT: typeof payload === 'string' ? payload : JSON.stringify(payload),
      APE_TEST_EXIT: String(exit),
      ...extraEnv,
    },
  });
}

async function waitForPath(file, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      lstatSync(file);
      return true;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
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

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('committed duration inventory and deterministic CI partition', () => {
  it('commits one sorted positive duration for every supported test file', async () => {
    const inventory = await listTestFiles();
    const durations = JSON.parse(readFileSync(join(ROOT, '.github', 'test-durations.json'), 'utf8'));
    expect(Object.keys(durations)).toEqual([...inventory].sort());
    expect(Object.values(durations).every((value) => Number.isFinite(value) && value > 0)).toBe(true);
  });

  it('assigns a disjoint smoke set and every other test exactly once across three nonempty stable shards', async () => {
    const inventory = await listTestFiles();
    const smoke = await selectCiTests('smoke');
    const first = await Promise.all([1, 2, 3].map((number) => selectCiTests('shard', number, 3)));
    const second = await Promise.all([1, 2, 3].map((number) => selectCiTests('shard', number, 3)));
    expect(first).toEqual(second);
    expect(smoke.length).toBeGreaterThan(0);
    expect(first.every((shard) => shard.length > 0)).toBe(true);
    const assigned = [...smoke, ...first.flat()];
    expect(new Set(assigned).size).toBe(assigned.length);
    expect([...assigned].sort()).toEqual(inventory);
  });

  it('executes only the smoke set and three shards, then aggregates without rerunning Vitest', () => {
    const workflow = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
    expect(workflow).toMatch(/run-ci-tests\.mjs\s+smoke/u);
    for (const shard of [1, 2, 3]) {
      expect(workflow).toMatch(new RegExp(`run-ci-tests\\.mjs\\s+shard\\s+${shard}\\s+3`, 'u'));
    }
    expect(workflow.match(/run-ci-tests\.mjs\s+smoke/gu)).toHaveLength(1);
    expect(workflow.match(/run-ci-tests\.mjs\s+shard\s+[123]\s+3/gu)).toHaveLength(3);
    expect(workflow).not.toMatch(/(?:npm test|vitest run)/u);
  });
});

describe('strict complete duration refresh', () => {
  it('uses randomized same-directory exclusive mode-0600 staging with owned sync and identity-checked cleanup', () => {
    for (const source of [
      readFileSync(UPDATE_SCRIPT, 'utf8'),
      readFileSync(join(ROOT, 'scripts', 'benchmark-v2.mjs'), 'utf8'),
    ]) {
      expect(/randomBytes|randomUUID|randomFill/iu.test(source)).toBe(true);
      expect(/['"]wx['"]/u.test(source)).toBe(true);
      expect(/0o600/u.test(source)).toBe(true);
      expect(/\.sync\(/u.test(source)).toBe(true);
      expect(/rename/u.test(source)).toBe(true);
      expect(/lstat/u.test(source)).toBe(true);
      expect(/\.dev/u.test(source)).toBe(true);
      expect(/\.ino/u.test(source)).toBe(true);
    }
  });

  it('fails closed for failed, malformed, duplicate, missing, extra, escaped, non-finite, and inverted reports', () => {
    const invalidReports = [
      { payload: { testResults: [] }, exit: 1 },
      { payload: '{not-json', exit: 0 },
      { payload: { success: true, testResults: [timingResult('/tmp', '../escaped.test.js', 1, 2)] }, exit: 0 },
    ];
    for (const make of [
      (root) => ({ success: true, testResults: [timingResult(root, '__tests__/a.test.js', 1, 2)] }),
      (root) => ({ success: true, testResults: [
        timingResult(root, '__tests__/a.test.js', 1, 2),
        timingResult(root, '__tests__/a.test.js', 1, 3),
        timingResult(root, '__tests__/b.test.js', 1, 2),
      ] }),
      (root) => ({ success: true, testResults: [
        timingResult(root, '__tests__/a.test.js', 1, 2),
        timingResult(root, '__tests__/b.test.js', 1, 2),
        timingResult(root, 'outside.test.js', 1, 2),
      ] }),
      (root) => ({ success: true, testResults: [
        timingResult(root, '__tests__/a.test.js', 2, 1),
        timingResult(root, '__tests__/b.test.js', 1, 2),
      ] }),
      (root) => ({ success: true, testResults: [
        timingResult(root, '__tests__/a.test.js', 1, 'Infinity'),
        timingResult(root, '__tests__/b.test.js', 1, 2),
      ] }),
    ]) invalidReports.push({ make, exit: 0 });

    for (const scenario of invalidReports) {
      const root = fixtureProject();
      const destination = join(root, '.github', 'test-durations.json');
      const before = readFileSync(destination);
      const payload = scenario.make ? scenario.make(root) : scenario.payload;
      const result = runRefresh(root, payload, scenario.exit);
      expect(result.status, result.stderr).not.toBe(0);
      expect(readFileSync(destination)).toEqual(before);
    }
  });

  it('fails closed when finite timing endpoints overflow during subtraction', () => {
    const root = fixtureProject();
    const destination = join(root, '.github', 'test-durations.json');
    const before = readFileSync(destination);
    const result = runRefresh(root, {
      success: true,
      testResults: [
        timingResult(root, '__tests__/a.test.js', -1e308, 1e308),
        timingResult(root, '__tests__/b.test.js', 10, 20),
      ],
    });

    expect(result.status, result.stderr).not.toBe(0);
    expect(readFileSync(destination)).toEqual(before);
  });

  it('installs complete results in canonical order with private mode', () => {
    const root = fixtureProject();
    const result = runRefresh(root, {
      success: true,
      testResults: [
        timingResult(root, '__tests__/b.test.js', 10, 40),
        timingResult(root, '__tests__/a.test.js', 10, 20),
      ],
    });
    expect(result.status, result.stderr).toBe(0);
    const destination = join(root, '.github', 'test-durations.json');
    expect(readFileSync(destination, 'utf8')).toBe('{\n  "__tests__/a.test.js": 10,\n  "__tests__/b.test.js": 30\n}\n');
    expect(statSync(destination).mode & 0o777).toBe(0o600);
  });

  it.each(['destination', 'staging'])('fails closed on a %s identity race at replacement time', (race) => {
    const root = fixtureProject();
    const destination = join(root, '.github', 'test-durations.json');
    const before = readFileSync(destination);
    const racedDestination = Buffer.from('{"raced":29}\n');
    const foreignTarget = join(root, 'foreign-duration-staging-target');
    writeFileSync(foreignTarget, 'foreign duration staging payload\n');
    const injector = join(root, `inject-${race}-duration-race.mjs`);
    writeFileSync(injector, `
      import fs from 'node:fs';
      import path from 'node:path';
      const originalLstat = fs.promises.lstat.bind(fs.promises);
      let triggered = false;
      fs.promises.lstat = async function(file, ...rest) {
        const result = await originalLstat(file, ...rest);
        if (!triggered && path.resolve(String(file)) === path.resolve(process.env.APE_RACE_DESTINATION)) {
          const staged = fs.readdirSync(path.dirname(String(file)))
            .find((name) => name.startsWith('.test-durations.') && name.endsWith('.tmp'));
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
    `);

    const result = runRefresh(root, {
      success: true,
      testResults: [
        timingResult(root, '__tests__/a.test.js', 10, 20),
        timingResult(root, '__tests__/b.test.js', 10, 40),
      ],
    }, 0, {
      NODE_OPTIONS: `--import=${injector}`,
      APE_RACE_MODE: race,
      APE_RACE_DESTINATION: destination,
      APE_RACE_DESTINATION_BYTES: racedDestination.toString('base64'),
      APE_RACE_FOREIGN_TARGET: foreignTarget,
    });

    expect(result.status).not.toBe(0);
    if (race === 'destination') {
      expect(readFileSync(destination)).toEqual(racedDestination);
    } else {
      expect(readFileSync(destination)).toEqual(before);
      const foreignStaging = readdirSync(join(root, '.github'))
        .map((name) => join(root, '.github', name))
        .find((candidate) => lstatSync(candidate).isSymbolicLink());
      expect(foreignStaging).toBeDefined();
      expect(lstatSync(foreignStaging).isSymbolicLink()).toBe(true);
      expect(readFileSync(foreignTarget, 'utf8')).toBe('foreign duration staging payload\n');
    }
  });

  it('fails closed when destination bytes change but injected metadata remains identical', () => {
    const root = fixtureProject();
    const destination = join(root, '.github', 'test-durations.json');
    const racedDestination = Buffer.from('{"raced___":29}\n');
    expect(racedDestination).toHaveLength(readFileSync(destination).length);
    const injector = join(root, 'inject-duration-destination-byte-race.mjs');
    writeFileSync(injector, `
      import fs from 'node:fs';
      import path from 'node:path';
      const originalLstat = fs.promises.lstat.bind(fs.promises);
      let baseline;
      let triggered = false;
      fs.promises.lstat = async function(candidate, ...rest) {
        const result = await originalLstat(candidate, ...rest);
        if (path.resolve(String(candidate)) !== path.resolve(process.env.APE_RACE_DESTINATION)) return result;
        const staged = fs.readdirSync(path.dirname(String(candidate)))
          .find((name) => name.startsWith('.test-durations.') && name.endsWith('.tmp'));
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
    `);

    const result = runRefresh(root, {
      success: true,
      testResults: [
        timingResult(root, '__tests__/a.test.js', 10, 20),
        timingResult(root, '__tests__/b.test.js', 10, 40),
      ],
    }, 0, {
      NODE_OPTIONS: `--import=${injector}`,
      APE_RACE_DESTINATION: destination,
      APE_RACE_BYTES: racedDestination.toString('base64'),
    });

    expect(result.status).not.toBe(0);
    expect(readFileSync(destination)).toEqual(racedDestination);
  });

  it('fails closed when the owned staging inode is rewritten with same-size valid bytes', () => {
    const root = fixtureProject();
    const destination = join(root, '.github', 'test-durations.json');
    const before = readFileSync(destination);
    const injector = join(root, 'inject-duration-staging-byte-race.mjs');
    writeFileSync(injector, `
      import fs from 'node:fs';
      import path from 'node:path';
      const originalLstat = fs.promises.lstat.bind(fs.promises);
      let triggered = false;
      fs.promises.lstat = async function(candidate, ...rest) {
        const result = await originalLstat(candidate, ...rest);
        const name = path.basename(String(candidate));
        if (!triggered && name.startsWith('.test-durations.') && name.endsWith('.tmp')) {
          triggered = true;
          const bytes = fs.readFileSync(String(candidate));
          const replacement = Buffer.from(bytes);
          const marker = Buffer.from('10');
          const offset = replacement.indexOf(marker);
          if (offset < 0) throw new Error('test injector could not find fixed-size marker');
          replacement.set(Buffer.from('11'), offset);
          fs.writeFileSync(String(candidate), replacement);
        }
        return result;
      };
    `);

    const result = runRefresh(root, {
      success: true,
      testResults: [
        timingResult(root, '__tests__/a.test.js', 10, 20),
        timingResult(root, '__tests__/b.test.js', 10, 40),
      ],
    }, 0, { NODE_OPTIONS: `--import=${injector}` });

    expect(result.status).not.toBe(0);
    expect(readFileSync(destination)).toEqual(before);
  });

  it('fails closed if the primary duration lock is replaced after reclaimed-owner metadata is synced', () => {
    const root = fixtureProject();
    const destination = join(root, '.github', 'test-durations.json');
    const before = readFileSync(destination);
    const lock = join(root, '.github', '.test-durations.lock');
    writeFileSync(lock, '{"pid":2147483647}\n', { mode: 0o600 });
    const foreignSource = join(root, 'foreign-live-duration-lock');
    const foreignBytes = Buffer.from(`${JSON.stringify({ pid: process.pid })}\n`);
    writeFileSync(foreignSource, foreignBytes, { mode: 0o600 });
    const foreignIdentity = lstatSync(foreignSource);
    const injector = join(root, 'replace-primary-duration-lock.mjs');
    writeFileSync(injector, `
      import fs from 'node:fs';
      import path from 'node:path';
      const primary = path.resolve(process.env.APE_PRIMARY_LOCK);
      const foreign = path.resolve(process.env.APE_FOREIGN_LOCK_SOURCE);
      const originalOpen = fs.promises.open.bind(fs.promises);
      let injected = false;
      fs.promises.open = async function(candidate, flags, ...rest) {
        const handle = await originalOpen(candidate, flags, ...rest);
        const originalSync = handle.sync.bind(handle);
        handle.sync = async function() {
          const result = await originalSync();
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
        return handle;
      };
    `);

    const result = runRefresh(root, {
      success: true,
      testResults: [
        timingResult(root, '__tests__/a.test.js', 10, 20),
        timingResult(root, '__tests__/b.test.js', 10, 40),
      ],
    }, 0, {
      NODE_OPTIONS: `--import=${injector}`,
      APE_PRIMARY_LOCK: lock,
      APE_FOREIGN_LOCK_SOURCE: foreignSource,
    }, { timeout: 1_500 });

    expect(result.status).not.toBe(0);
    expect(readFileSync(destination)).toEqual(before);
    expect(readFileSync(foreignSource)).toEqual(foreignBytes);
    expect(readFileSync(lock)).toEqual(foreignBytes);
    const current = lstatSync(lock);
    expect({ dev: current.dev, ino: current.ino }).toEqual({
      dev: foreignIdentity.dev,
      ino: foreignIdentity.ino,
    });
  });

  it('reclaims a stale hard-linked duration lock without writing through the foreign inode', () => {
    const root = fixtureProject();
    const destination = join(root, '.github', 'test-durations.json');
    const lock = join(root, '.github', '.test-durations.lock');
    const victim = join(root, 'duration-lock-hardlink-victim');
    const victimBytes = Buffer.from('{"pid":2147483647}\n');
    writeFileSync(victim, victimBytes, { mode: 0o600 });
    linkSync(victim, lock);
    const victimIdentity = lstatSync(victim);

    const result = runRefresh(root, {
      success: true,
      testResults: [
        timingResult(root, '__tests__/a.test.js', 10, 20),
        timingResult(root, '__tests__/b.test.js', 10, 40),
      ],
    }, 0, {}, { timeout: 1_500 });

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(victim)).toEqual(victimBytes);
    const currentVictim = lstatSync(victim);
    expect({ dev: currentVictim.dev, ino: currentVictim.ino }).toEqual({
      dev: victimIdentity.dev,
      ino: victimIdentity.ino,
    });
    expect(JSON.parse(readFileSync(destination, 'utf8'))).toEqual({
      '__tests__/a.test.js': 10,
      '__tests__/b.test.js': 30,
    });
    expect(() => lstatSync(lock)).toThrow(/ENOENT/u);
  });

  it.each([
    ['young', 0, false],
    ['lease-expired', 61_000, true],
  ])('%s oversized malformed duration locks obey the conservative lease', (_label, ageMs, recovers) => {
    const root = fixtureProject();
    const destination = join(root, '.github', 'test-durations.json');
    const before = readFileSync(destination);
    const lock = join(root, '.github', '.test-durations.lock');
    const oversized = Buffer.alloc(4 * 1024 + 1, 0x78);
    writeFileSync(lock, oversized, { mode: 0o600 });
    if (ageMs > 0) {
      const old = new Date(Date.now() - ageMs);
      utimesSync(lock, old, old);
    }
    const beforeIdentity = lstatSync(lock);

    const result = runRefresh(root, {
      success: true,
      testResults: [
        timingResult(root, '__tests__/a.test.js', 10, 20),
        timingResult(root, '__tests__/b.test.js', 10, 40),
      ],
    }, 0, {}, { timeout: recovers ? 1_500 : 400 });

    if (recovers) {
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(readFileSync(destination, 'utf8'))).toEqual({
        '__tests__/a.test.js': 10,
        '__tests__/b.test.js': 30,
      });
      expect(() => lstatSync(lock)).toThrow(/ENOENT/u);
    } else {
      expect(result.status).not.toBe(0);
      expect(readFileSync(destination)).toEqual(before);
      expect(readFileSync(lock)).toEqual(oversized);
      const current = lstatSync(lock);
      expect({ dev: current.dev, ino: current.ino }).toEqual({
        dev: beforeIdentity.dev,
        ino: beforeIdentity.ino,
      });
    }
  });

  it('preserves a replacement oversized duration lock injected during reclaim revalidation', () => {
    const root = fixtureProject();
    const destination = join(root, '.github', 'test-durations.json');
    const before = readFileSync(destination);
    const lock = join(root, '.github', '.test-durations.lock');
    writeFileSync(lock, Buffer.alloc(4 * 1024 + 1, 0x78), { mode: 0o600 });
    const old = new Date(Date.now() - 61_000);
    utimesSync(lock, old, old);
    const foreignSource = join(root, 'replacement-oversized-duration-lock');
    const foreignBytes = Buffer.alloc(4 * 1024 + 1, 0x79);
    writeFileSync(foreignSource, foreignBytes, { mode: 0o600 });
    const foreignIdentity = lstatSync(foreignSource);
    const marker = join(root, 'oversized-duration-lock-replaced');
    const injector = join(root, 'mutate-oversized-duration-lock.mjs');
    writeFileSync(injector, `
      import fs from 'node:fs';
      import path from 'node:path';
      const primary = path.resolve(process.env.APE_PRIMARY_LOCK);
      const foreign = path.resolve(process.env.APE_FOREIGN_LOCK_SOURCE);
      const marker = path.resolve(process.env.APE_MUTATION_MARKER);
      const prefix = path.basename(primary) + '.reclaimer-';
      const originalLstat = fs.promises.lstat.bind(fs.promises);
      let injected = false;
      fs.promises.lstat = async function(candidate, ...rest) {
        const result = await originalLstat(candidate, ...rest);
        if (!injected && path.resolve(String(candidate)) === primary
          && fs.readdirSync(path.dirname(primary)).some((name) => name.startsWith(prefix))) {
          injected = true;
          fs.unlinkSync(primary);
          fs.linkSync(foreign, primary);
          fs.writeFileSync(marker, 'injected\\n');
        }
        return result;
      };
    `);

    const result = runRefresh(root, {
      success: true,
      testResults: [
        timingResult(root, '__tests__/a.test.js', 10, 20),
        timingResult(root, '__tests__/b.test.js', 10, 40),
      ],
    }, 0, {
      NODE_OPTIONS: `--import=${injector}`,
      APE_PRIMARY_LOCK: lock,
      APE_FOREIGN_LOCK_SOURCE: foreignSource,
      APE_MUTATION_MARKER: marker,
    }, { timeout: 1_500 });

    expect(result.status).not.toBe(0);
    expect(readFileSync(marker, 'utf8')).toBe('injected\n');
    expect(readFileSync(destination)).toEqual(before);
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
  ])('recovers an unchanged %s duration writer lock', (_label, contents, ageMs) => {
    const root = fixtureProject();
    const lock = join(root, '.github', '.test-durations.lock');
    writeFileSync(lock, contents, { mode: 0o600 });
    if (ageMs > 0) {
      const old = new Date(Date.now() - ageMs);
      utimesSync(lock, old, old);
    }
    const result = runRefresh(root, {
      success: true,
      testResults: [
        timingResult(root, '__tests__/a.test.js', 10, 20),
        timingResult(root, '__tests__/b.test.js', 10, 40),
      ],
    }, 0, {}, { timeout: 1_500 });

    expect(result.status, result.stderr).toBe(0);
    expect(() => lstatSync(lock)).toThrow(/ENOENT/u);
    expect(JSON.parse(readFileSync(join(root, '.github', 'test-durations.json'), 'utf8'))).toEqual({
      '__tests__/a.test.js': 10,
      '__tests__/b.test.js': 30,
    });
  });

  it.each(['before-metadata', 'after-metadata'])(
    'recovers after a duration stale-lock reclaimer dies %s',
    (deathBoundary) => {
      const root = fixtureProject();
      const destination = join(root, '.github', 'test-durations.json');
      const lock = join(root, '.github', '.test-durations.lock');
      const claim = `${lock}.reclaim`;
      writeFileSync(lock, '{"pid":2147483647}\n', { mode: 0o600 });
      const injector = join(root, `kill-duration-reclaimer-${deathBoundary}.mjs`);
      writeFileSync(injector, `
        import fs from 'node:fs';
        import path from 'node:path';
        import { syncBuiltinESMExports } from 'node:module';
        const claim = path.resolve(process.env.APE_RECLAIM_CLAIM);
        const boundary = process.env.APE_RECLAIM_DEATH_BOUNDARY;
        const originalLink = fs.promises.link.bind(fs.promises);
        const originalOpen = fs.promises.open.bind(fs.promises);
        fs.promises.link = async function(from, to, ...rest) {
          const result = await originalLink(from, to, ...rest);
          if (boundary === 'before-metadata' && path.resolve(String(to)) === claim) {
            process.kill(process.pid, 'SIGKILL');
          }
          return result;
        };
        fs.promises.open = async function(candidate, flags, ...rest) {
          const handle = await originalOpen(candidate, flags, ...rest);
          if (boundary === 'after-metadata'
            && path.resolve(String(candidate)) === claim
            && flags === 'r+') {
            const originalSync = handle.sync.bind(handle);
            handle.sync = async function() {
              const result = await originalSync();
              process.kill(process.pid, 'SIGKILL');
              return result;
            };
          }
          return handle;
        };
        syncBuiltinESMExports();
      `);
      const payload = {
        success: true,
        testResults: [
          timingResult(root, '__tests__/a.test.js', 10, 20),
          timingResult(root, '__tests__/b.test.js', 10, 40),
        ],
      };

      const crashed = runRefresh(root, payload, 0, {
        NODE_OPTIONS: `--import=${injector}`,
        APE_RECLAIM_CLAIM: claim,
        APE_RECLAIM_DEATH_BOUNDARY: deathBoundary,
      }, { timeout: 2_000 });

      expect(crashed.signal).toBe('SIGKILL');
      expect(lstatSync(claim).isFile()).toBe(true);
      if (deathBoundary === 'after-metadata') {
        expect(JSON.parse(readFileSync(claim, 'utf8'))).toEqual({ pid: crashed.pid });
      }

      const recovered = runRefresh(root, payload, 0, {}, { timeout: 1_500 });

      expect(recovered.status, recovered.stderr).toBe(0);
      expect(JSON.parse(readFileSync(destination, 'utf8'))).toEqual({
        '__tests__/a.test.js': 10,
        '__tests__/b.test.js': 30,
      });
      expect(() => lstatSync(lock)).toThrow(/ENOENT/u);
      expect(() => lstatSync(claim)).toThrow(/ENOENT/u);
    },
    10_000,
  );

  it('recovers a dead duration lock without deleting a foreign reclaim object', () => {
    const root = fixtureProject();
    const destination = join(root, '.github', 'test-durations.json');
    const lock = join(root, '.github', '.test-durations.lock');
    const claim = `${lock}.reclaim`;
    const foreignBytes = Buffer.from('foreign reclaim owner\n');
    writeFileSync(lock, '{"pid":2147483647}\n', { mode: 0o600 });
    writeFileSync(claim, foreignBytes, { mode: 0o600 });
    const foreignIdentity = lstatSync(claim);

    const recovered = runRefresh(root, {
      success: true,
      testResults: [
        timingResult(root, '__tests__/a.test.js', 10, 20),
        timingResult(root, '__tests__/b.test.js', 10, 40),
      ],
    }, 0, {}, { timeout: 1_500 });

    expect(recovered.status, recovered.stderr).toBe(0);
    expect(readFileSync(claim)).toEqual(foreignBytes);
    const currentForeignIdentity = lstatSync(claim);
    expect({ dev: currentForeignIdentity.dev, ino: currentForeignIdentity.ino }).toEqual({
      dev: foreignIdentity.dev,
      ino: foreignIdentity.ino,
    });
    expect(JSON.parse(readFileSync(destination, 'utf8'))).toEqual({
      '__tests__/a.test.js': 10,
      '__tests__/b.test.js': 30,
    });
  });

  it.each([
    ['live metadata owner', () => `{"pid":${process.pid}}\n`, 0, null],
    ['permission-ambiguous metadata owner', () => '{"pid":424242}\n', 61_000, 'eperm'],
    ['young empty metadata', () => '', 0, null],
    ['young malformed metadata', () => '{not-json\n', 0, null],
  ])('does not reclaim a %s duration writer lock', (_label, makeContents, ageMs, probe) => {
    const root = fixtureProject();
    const destination = join(root, '.github', 'test-durations.json');
    const beforeDestination = readFileSync(destination);
    const lock = join(root, '.github', '.test-durations.lock');
    const contents = makeContents();
    writeFileSync(lock, contents, { mode: 0o600 });
    if (ageMs > 0) {
      const old = new Date(Date.now() - ageMs);
      utimesSync(lock, old, old);
    }
    let injector;
    if (probe === 'eperm') {
      injector = join(root, 'inject-duration-eperm.mjs');
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
    const result = runRefresh(root, {
      success: true,
      testResults: [
        timingResult(root, '__tests__/a.test.js', 10, 20),
        timingResult(root, '__tests__/b.test.js', 10, 40),
      ],
    }, 0, injector ? { NODE_OPTIONS: `--import=${injector}` } : {}, { timeout: 400 });

    expect(result.status).not.toBe(0);
    expect(readFileSync(lock, 'utf8')).toBe(contents);
    const afterIdentity = lstatSync(lock);
    expect({ dev: afterIdentity.dev, ino: afterIdentity.ino }).toEqual({
      dev: beforeIdentity.dev,
      ino: beforeIdentity.ino,
    });
    expect(readFileSync(destination)).toEqual(beforeDestination);
  });

  it.each(['file', 'symlink'])('treats a pre-existing %s at a randomized staging candidate as an untouched collision', (kind) => {
    const root = fixtureProject();
    const destination = join(root, '.github', 'test-durations.json');
    const before = readFileSync(destination);
    const victim = join(root, 'duration-collision-victim');
    writeFileSync(victim, 'duration collision victim bytes\n');
    const collision = join(root, '.github', `.test-durations.${'ab'.repeat(16)}.tmp`);
    if (kind === 'symlink') symlinkSync(victim, collision);
    else writeFileSync(collision, 'existing duration collision bytes\n');
    const injector = join(root, 'fixed-duration-random.mjs');
    writeFileSync(injector, `
      import crypto from 'node:crypto';
      import { syncBuiltinESMExports } from 'node:module';
      crypto.randomBytes = (size) => Buffer.alloc(size, 0xab);
      syncBuiltinESMExports();
    `);

    const result = runRefresh(root, {
      success: true,
      testResults: [
        timingResult(root, '__tests__/a.test.js', 10, 20),
        timingResult(root, '__tests__/b.test.js', 10, 40),
      ],
    }, 0, { NODE_OPTIONS: `--import=${injector}` });

    expect(result.status).not.toBe(0);
    expect(readFileSync(destination)).toEqual(before);
    expect(readFileSync(victim, 'utf8')).toBe('duration collision victim bytes\n');
    expect(lstatSync(collision).isSymbolicLink()).toBe(kind === 'symlink');
    if (kind === 'file') expect(readFileSync(collision, 'utf8')).toBe('existing duration collision bytes\n');
  });

  it('does not rename or retain its owned staging file when owned-handle sync fails', () => {
    const root = fixtureProject();
    const destination = join(root, '.github', 'test-durations.json');
    const before = readFileSync(destination);
    const injector = join(root, 'fail-duration-sync.mjs');
    writeFileSync(injector, `
      import fs from 'node:fs';
      const originalOpen = fs.promises.open.bind(fs.promises);
      fs.promises.open = async function(file, ...args) {
        const handle = await originalOpen(file, ...args);
        if (String(file).includes('.test-durations.') && String(file).endsWith('.tmp')) {
          handle.sync = async () => { throw new Error('injected owned-handle sync failure'); };
        }
        return handle;
      };
    `);

    const result = runRefresh(root, {
      success: true,
      testResults: [
        timingResult(root, '__tests__/a.test.js', 10, 20),
        timingResult(root, '__tests__/b.test.js', 10, 40),
      ],
    }, 0, { NODE_OPTIONS: `--import=${injector}` });

    expect(result.status).not.toBe(0);
    expect(readFileSync(destination)).toEqual(before);
    expect(readdirSync(join(root, '.github')).filter((name) => name.startsWith('.test-durations.'))).toEqual([]);
  });

  it('never lets an older concurrent refresh silently overwrite a newer completed snapshot', async () => {
    const root = fixtureProject();
    const destination = join(root, '.github', 'test-durations.json');
    const barrier = join(root, 'duration-writer-barrier');
    mkdirSync(barrier);
    const injector = join(root, 'duration-writer-barrier.mjs');
    writeFileSync(injector, `
      import fs from 'node:fs';
      import path from 'node:path';
      const originalRename = fs.promises.rename.bind(fs.promises);
      fs.promises.rename = async function(from, to) {
        if (path.resolve(String(to)) === path.resolve(process.env.APE_WRITER_DESTINATION)) {
          fs.writeFileSync(path.join(process.env.APE_WRITER_BARRIER, process.pid + '.ready'), '');
          while (!fs.existsSync(path.join(process.env.APE_WRITER_BARRIER, process.pid + '.release'))) {
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
        }
        return originalRename(from, to);
      };
    `);
    const spawnRefresh = (aDuration, bDuration) => spawn(process.execPath, [
      join(root, 'scripts', 'update-test-durations.mjs'),
    ], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        NODE_OPTIONS: `--import=${injector}`,
        APE_TEST_EXIT: '0',
        APE_TEST_REPORT: JSON.stringify({
          success: true,
          testResults: [
            timingResult(root, '__tests__/a.test.js', 0, aDuration),
            timingResult(root, '__tests__/b.test.js', 0, bDuration),
          ],
        }),
        APE_WRITER_BARRIER: barrier,
        APE_WRITER_DESTINATION: destination,
      },
    });

    const older = spawnRefresh(10, 20);
    const olderResult = completedChild(older);
    expect(await waitForPath(join(barrier, `${older.pid}.ready`), 3_000)).toBe(true);
    const newer = spawnRefresh(30, 40);
    const newerResult = completedChild(newer);
    const newerReachedRename = await waitForPath(join(barrier, `${newer.pid}.ready`), 1_000);
    if (newerReachedRename) {
      writeFileSync(join(barrier, `${newer.pid}.release`), '');
      await newerResult;
      writeFileSync(join(barrier, `${older.pid}.release`), '');
    } else {
      writeFileSync(join(barrier, `${older.pid}.release`), '');
      await olderResult;
      writeFileSync(join(barrier, `${newer.pid}.release`), '');
    }
    const [olderOutcome, newerOutcome] = await Promise.all([olderResult, newerResult]);
    const finalBytes = readFileSync(destination, 'utf8');
    const olderBytes = '{\n  "__tests__/a.test.js": 10,\n  "__tests__/b.test.js": 20\n}\n';
    const newerBytes = '{\n  "__tests__/a.test.js": 30,\n  "__tests__/b.test.js": 40\n}\n';

    expect(
      (olderOutcome.status === 0 && newerOutcome.status === 0 && finalBytes === newerBytes)
      || (olderOutcome.status === 0 && newerOutcome.status !== 0 && finalBytes === olderBytes),
    ).toBe(true);
  }, 10_000);

  it('serializes two refreshers that concurrently reclaim the same confirmed-dead lock', async () => {
    const root = fixtureProject();
    const destination = join(root, '.github', 'test-durations.json');
    const lock = join(root, '.github', '.test-durations.lock');
    writeFileSync(lock, '{"pid":2147483647}\n', { mode: 0o600 });
    const barrier = join(root, 'duration-stale-lock-reclaimer-barrier');
    mkdirSync(barrier);
    const injector = join(root, 'duration-stale-lock-reclaimers.mjs');
    writeFileSync(injector, `
      import fs from 'node:fs';
      import path from 'node:path';
      const lock = path.resolve(process.env.APE_STALE_LOCK);
      const destination = path.resolve(process.env.APE_WRITER_DESTINATION);
      const barrier = process.env.APE_WRITER_BARRIER;
      const originalOpen = fs.promises.open.bind(fs.promises);
      const originalRm = fs.promises.rm.bind(fs.promises);
      const originalRename = fs.promises.rename.bind(fs.promises);
      let reclaimAttempted = false;
      fs.promises.rm = async function(candidate, ...rest) {
        if (!reclaimAttempted && path.resolve(String(candidate)) === lock) {
          reclaimAttempted = true;
          fs.writeFileSync(path.join(barrier, process.pid + '.unlink-ready'), '');
          const deadline = Date.now() + 750;
          while (Date.now() < deadline
            && fs.readdirSync(barrier).filter((name) => name.endsWith('.unlink-ready')).length < 2) {
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          const participants = fs.readdirSync(barrier)
            .filter((name) => name.endsWith('.unlink-ready'))
            .map((name) => Number(name.split('.')[0]))
            .sort((left, right) => left - right);
          if (participants.length >= 2 && process.pid !== participants[0]) {
            while (!fs.existsSync(path.join(barrier, 'successor-acquired'))) {
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
          }
          return originalRm(candidate, ...rest);
        }
        return originalRm(candidate, ...rest);
      };
      fs.promises.open = async function(candidate, flags, ...rest) {
        const handle = await originalOpen(candidate, flags, ...rest);
        if (reclaimAttempted && path.resolve(String(candidate)) === lock && flags === 'wx') {
          fs.writeFileSync(path.join(barrier, 'successor-acquired'), String(process.pid));
        }
        return handle;
      };
      fs.promises.rename = async function(from, to) {
        if (path.resolve(String(to)) === destination) {
          fs.writeFileSync(path.join(barrier, process.pid + '.rename-ready'), '');
          while (!fs.existsSync(path.join(barrier, process.pid + '.release'))) {
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
        }
        return originalRename(from, to);
      };
    `);
    const spawnRefresh = (aDuration, bDuration) => spawn(process.execPath, [
      join(root, 'scripts', 'update-test-durations.mjs'),
    ], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        NODE_OPTIONS: `--import=${injector}`,
        APE_TEST_EXIT: '0',
        APE_TEST_REPORT: JSON.stringify({
          success: true,
          testResults: [
            timingResult(root, '__tests__/a.test.js', 0, aDuration),
            timingResult(root, '__tests__/b.test.js', 0, bDuration),
          ],
        }),
        APE_STALE_LOCK: lock,
        APE_WRITER_BARRIER: barrier,
        APE_WRITER_DESTINATION: destination,
      },
    });
    const first = spawnRefresh(10, 20);
    const second = spawnRefresh(30, 40);
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
    expect([
      { '__tests__/a.test.js': 10, '__tests__/b.test.js': 20 },
      { '__tests__/a.test.js': 30, '__tests__/b.test.js': 40 },
    ]).toContainEqual(JSON.parse(readFileSync(destination, 'utf8')));
  }, 15_000);
});
