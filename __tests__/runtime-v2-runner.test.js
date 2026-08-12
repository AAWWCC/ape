import { spawn } from 'node:child_process';
import { mkdtemp, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildSpawnPlan,
  detectTestRunner,
  GATE_RUNNER_SENTINEL,
  runTestSuite,
} from '../lib/runtime/runner.js';

const cleanups = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture(file, body = '') {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-runner-'));
  cleanups.push(dir);
  await writeFile(path.join(dir, file), body);
  return dir;
}

describe('APE v2 project-agnostic runner detection', () => {
  it.each([
    ['package.json', '{"scripts":{"test":"vitest run"}}', 'javascript', 'npm', 'npm.cmd'],
    ['pytest.ini', '[pytest]', 'python', 'python3', 'py'],
    ['go.mod', 'module example.test/project', 'go', 'go', 'go'],
    ['Cargo.toml', '[package]', 'rust', 'cargo', 'cargo'],
    ['Gemfile', 'source "https://rubygems.org"', 'ruby', 'bundle', 'bundle.bat'],
    ['pom.xml', '<project/>', 'maven', 'mvn', 'mvn'],
    ['build.gradle', 'plugins {}', 'gradle', 'gradle', 'gradle'],
  ])('detects %s on macOS and Windows', async (file, body, runner, macCommand, winCommand) => {
    const dir = await fixture(file, body);
    const mac = await detectTestRunner(dir, { platform: 'darwin' });
    const win = await detectTestRunner(dir, { platform: 'win32' });
    expect(mac).toMatchObject({ runner, command: macCommand });
    expect(win).toMatchObject({ runner, command: winCommand });
  });

  it('detects a uv-managed project via uv.lock and runs the suite through uv on every platform', async () => {
    const dir = await fixture('uv.lock', 'version = 1\n');
    const mac = await detectTestRunner(dir, { platform: 'darwin' });
    const win = await detectTestRunner(dir, { platform: 'win32' });
    expect(mac).toMatchObject({ runner: 'python-uv', command: 'uv', args: ['run', 'pytest'] });
    expect(win).toMatchObject({ runner: 'python-uv', command: 'uv', args: ['run', 'pytest'] });
  });

  it('prefers uv over a bare pyproject when uv.lock is present', async () => {
    const dir = await fixture('uv.lock', 'version = 1\n');
    await writeFile(path.join(dir, 'pyproject.toml'), '[project]\nname = "x"\n');
    expect(await detectTestRunner(dir, { platform: 'darwin' })).toMatchObject({
      runner: 'python-uv',
      command: 'uv',
    });
  });

  it('abstains instead of guessing in an unknown project', async () => {
    const dir = await fixture('README.md', '# unknown');
    expect(await detectTestRunner(dir)).toMatchObject({ runner: 'none', command: null });
  });
});

// Windows spawns .cmd/.bat batch scripts only through a shell (Node's
// CVE-2024-27980 hardening raises EINVAL on shell:false), so the derived
// npm.cmd invocation must become one cmd.exe-quoted shell string while real
// executables keep the safer argv spawn. Regression for the CI-only
// `spawn EINVAL` failure of the derived targeted gate on the Windows shards.
describe('buildSpawnPlan', () => {
  it('routes Windows batch shims through the shell as one quoted string', () => {
    const plan = buildSpawnPlan('npm.cmd', ['test', '--', 'tests/some dir/value.test.js'], 'win32');
    expect(plan).toEqual({
      command: 'npm.cmd test -- "tests/some dir/value.test.js"',
      args: [],
      shell: true,
    });
  });

  it('keeps real executables on the shell-less argv spawn everywhere', () => {
    expect(buildSpawnPlan('node', ['--test', 'a.test.js'], 'win32')).toEqual({
      command: 'node',
      args: ['--test', 'a.test.js'],
      shell: false,
    });
    expect(buildSpawnPlan('npm', ['test'], 'darwin')).toEqual({
      command: 'npm',
      args: ['test'],
      shell: false,
    });
  });

  it('escapes embedded quotes and cmd metacharacters for the shell string', () => {
    const plan = buildSpawnPlan('gradlew.bat', ['test', 'a"b', 'c&d'], 'win32');
    expect(plan.command).toBe('gradlew.bat test "a""b" "c&d"');
    expect(plan.shell).toBe(true);
  });
});

// runTestSuite is the evidence engine for the merge gates (invariant 9) and
// red-test admission (invariant 3): its timeout, output-cap, and
// tooling-failure semantics are load-bearing verification shape. These tests
// drive the public surface with real child processes.
describe('runTestSuite execution semantics', () => {
  it('kills a SIGTERM-trapping suite at the deadline and marks the result timed_out', async () => {
    const dir = await fixture(
      'trap.mjs',
      'process.on("SIGTERM", () => {});\nsetInterval(() => {}, 1000);\n',
    );
    const startedAt = Date.now();
    const result = await runTestSuite(dir, {
      override: { command: process.execPath, args: [path.join(dir, 'trap.mjs')] },
      timeout_ms: 300,
      kill_grace_ms: 300,
      drain_ms: 500,
    });
    // The old single-SIGTERM runner never resolved here; the receipt lock
    // heartbeat then starved abort/override until the host died.
    expect(Date.now() - startedAt).toBeLessThan(10_000);
    expect(result.passed).toBe(false);
    expect(result.tooling_failure).toBe(false);
    expect(result.timed_out).toBe(true);
    // POSIX: killed by signal, so no exit code. win32's taskkill yields a
    // numeric code — there the timed_out marker is what admission must read.
    if (process.platform !== 'win32') expect(result.exit_code).toBe(null);
  }, 15_000);

  it('omits the timed_out key entirely on a run that finished before the deadline', async () => {
    const dir = await fixture('quick.mjs', 'console.log("ok");\n');
    const result = await runTestSuite(dir, {
      override: { command: process.execPath, args: [path.join(dir, 'quick.mjs')] },
      timeout_ms: 30_000,
    });
    expect(result.passed).toBe(true);
    expect(result.exit_code).toBe(0);
    expect(result.tooling_failure).toBe(false);
    // Absent, not false: sha256(verification) feeds gate result hashes and
    // the suite cache, so the non-timeout shape must stay byte-identical.
    expect('timed_out' in result).toBe(false);
  });

  it('caps captured output at 200k plus at most one pipe chunk', async () => {
    const dir = await fixture('noisy.mjs', 'process.stdout.write("x".repeat(400_000));\n');
    const result = await runTestSuite(dir, {
      override: { command: process.execPath, args: [path.join(dir, 'noisy.mjs')] },
      timeout_ms: 30_000,
    });
    expect(result.passed).toBe(true);
    expect(result.output.length).toBeGreaterThanOrEqual(200_000);
    // The cap is checked before each append, so the overshoot is bounded by
    // one 64 KiB pipe chunk.
    expect(result.output.length).toBeLessThanOrEqual(200_000 + 65_536);
  }, 15_000);

  it('reports a malformed configured command as a tooling failure instead of rejecting', async () => {
    const dir = await fixture('README.md', '# fixture');
    // An unbalanced quote in test_commands.* used to reject the promise up
    // through the merge gates inside the receipt-effects lock.
    const result = await runTestSuite(dir, { command: 'node "unterminated' });
    expect(result).toMatchObject({ passed: false, tooling_failure: true, exit_code: null });
    expect(result.output).toMatch(/quote/);
  });

  it('reports a nonexistent override command as a tooling failure', async () => {
    const dir = await fixture('README.md', '# fixture');
    const result = await runTestSuite(dir, {
      override: { command: path.join(dir, 'no-such-runner-xyz'), args: [] },
      timeout_ms: 5_000,
    });
    expect(result).toMatchObject({ passed: false, tooling_failure: true, exit_code: null });
    expect(result.output).toBeTruthy();
  });
});

// ===========================================================================
// THE DETACHED GATE RUNNER'S HEARTBEAT IS AN ATOMIC, PRIVATE WRITE
// (roadmap: runner-heartbeat-atomic-0600)
//
// runner.js's gate-runner CLI mode beats a heartbeat file for the whole life of
// the suite it supervises, and that file stopped being a liveness touch file the
// moment killProcessTree started reading it: it is now the IDENTITY WITNESS that
// authorizes process.kill(-pid, 'SIGKILL') on POSIX and taskkill /T /F on win32
// (spawn.js reads it and requires beat.pid === watch.pid). Two properties follow
// from that role, and neither is asserted anywhere today.
//
//   ATOMICITY. The beat must be published by temp + rename, never by an in-place
//   open-truncate-write. A reader landing inside an in-place beat sees a
//   truncated file, JSON.parse throws, the witness reads as ABSENT, and the kill
//   is vetoed against a runner that is fully alive and heartbeating —
//   false-negative ledger entry (b) of
//   __tests__/runtime-v2-kill-process-tree-stale-pid.test.js. rename(2) publishes
//   the whole file in one step, so no reader can ever observe a partial beat.
//
//   PRIVACY. The same file must be 0600, matching the result artifact the very
//   same module already writes through its atomicWriteFile600 helper. A plain
//   writeFile with no mode lands at 0o666 & ~umask (0644 under the usual umask
//   022), publishing the witness to every local account. This is a
//   permission-exposure fix and NOT a privilege escalation in the documented
//   single-user model — killProcessTree signals as the same uid that can write
//   those files — and is deliberately not overstated as one.
//
// WHY THE INODE, NOT THE MODE, IS THE PRIMARY DISCRIMINATOR. 0600 is
// umask-dependent: under `umask 0077` a plain writeFile ALREADY lands at 0600, so
// a mode assertion on its own would be green before the fix on some hosts and is
// a weak anchor. The behavioral difference that does not depend on the ambient
// umask is that an in-place rewrite keeps the SAME inode for every beat while
// temp + rename installs a NEW file each time. Both are asserted; only the inode
// one is load-bearing.
//
// WHY A SET OF INODES ACROSS SEVERAL BEATS, NOT A TWO-SAMPLE DIFF. rename frees
// the previous inode NUMBER, and an allocator that hands the freed number
// straight back to the next temp file makes consecutive-beat inodes ALTERNATE
// between two values rather than march monotonically — stable on APFS, not on
// ext4. Sampling many beats and asserting the observed SET has more than one
// member holds under both allocation policies (a brand-new temp file can never be
// handed the inode of the still-linked heartbeat, so consecutive beats always
// differ), whereas a first-vs-last diff is a coin flip on a reusing allocator.
// birthtime is recorded as a diagnostic but NOT asserted: where a filesystem has
// no real birthtime the field falls back to ctime, which an in-place rewrite
// advances too, so an assertion on it could pass before the fix.
//
// NO FIXED SLEEPS ANYWHERE. This file is deliberately NOT in vitest.config.js's
// SPAWN_SERIAL_FILES: it stays in the parallel `default` project at maxWorkers 3,
// where a sleep sized against an unstarved host is exactly how a spawn-heavy arm
// turns into a serial-quarantine request. The observer POLLS until it has seen
// enough beats (or a generous budget expires) and the suite child exits on a
// RELEASE FLAG the observer writes, so the arm costs about one node cold start
// plus a handful of 20ms heartbeat periods and never waits on a wall clock it
// does not control. One real runner serves both arms. vitest.config.js is
// unclaimed by this run and stays unedited — a disposition, not dropped scope.
//
// POSIX ONLY. Mode bits and inode identity do not carry to win32, so both arms
// skip there. Stated plainly because it has a consequence: .github/workflows/
// ci.yml is this repo's only workflow and runs a single windows-latest job, so
// these arms run in local `npm test` on macOS — which is where the runtime's own
// red-test admission and merge gates execute — and nowhere in CI.
//
// WHAT THIS FILE DELIBERATELY DOES NOT ARM, NAMED RATHER THAN OMITTED:
//   * The TORN READ itself. "A concurrent reader never observes a partial beat"
//     is only observable before the fix by winning a microsecond-wide race, so an
//     arm for it would be nondeterministically red — which is refused as a red
//     anchor, and rightly. The inode discriminator pins the MECHANISM (temp +
//     rename) that makes the torn read impossible, which is the deterministic
//     proxy for it. The observer counts unparseable heartbeat reads and reports
//     the count in its failure diagnostics, but asserts nothing about it.
//   * The false-negative ledger entry (b) prose in lib/runtime/spawn.js and its
//     twin in __tests__/runtime-v2-kill-process-tree-stale-pid.test.js. Comment
//     edits with no behavioral surface; neither file is claimed here.
//   * dist/ape-mcp.bundle.mjs regeneration. Owned end to end by
//     __tests__/runtime-v2-bundle-freshness.test.js; a second failure site for
//     one fact buys nothing.
//   * The other three roadmap entries this run disposes of —
//     cmd-delayed-expansion-residual, narrowed-test-claims-fail-wide-fallback and
//     preclaim-pays-off-only-on-a-blocking-finding. Each closes as a RECORDED
//     DECISION plus comment/prose edits with NO behavioral surface: a cmd.exe
//     delayed-expansion arm would have to observe an operator registry setting on
//     a real win32 host, the narrowed-claims fail-wide fallback is argued
//     UNREACHABLE (routing, narrowing and the notice all derive from one
//     declaredTestRemediations scan over one state object inside a single
//     applyActions chain, so the branch has no reachable input to drive it), and
//     the pre-claim entry is a skill-surface convention that is explicitly
//     forbidden from growing enforcement code. Unarmed BY DESIGN, not by
//     omission.
// ===========================================================================

// The gate runner is spawned exactly as gates.js launchGateRunner spawns it:
// `node <realpath of runner.js> --ape-gate-runner` with APE_GATE_RUNNER_JOB
// pointing at a job descriptor. runner.js's own main-module guard realpath's
// argv[1] against its own URL, so the entry must be the real file, not a copy.
const GATE_RUNNER_ENTRY = fileURLToPath(new URL('../lib/runtime/runner.js', import.meta.url));

// Short beats keep the arm cheap; the observer stops as soon as it has enough.
const HEARTBEAT_MS = 20;
const BEATS_WANTED = 6;
const MIN_BEATS = 3;
const POLL_MS = 2;
// Generous relative to BEATS_WANTED * HEARTBEAT_MS (120ms) so a starved worker
// on the parallel project still finishes, and small enough that every backstop
// below lands well inside the 15s testTimeout.
const OBSERVE_BUDGET_MS = 6_000;
const SUITE_SELF_TIMEOUT_MS = 8_000;
const JOB_TIMEOUT_MS = 10_000;
const EXIT_BUDGET_MS = 4_000;

// The "suite" the gate runner supervises. It exits the instant the observer
// drops a release flag, and self-terminates on its own deadline if the observer
// dies first, so no fixed sleep sets the length of the heartbeating window and
// nothing is left running behind a failed arm.
function releaseFlagSuiteSource(releaseFile) {
  return [
    'import { existsSync } from "node:fs";',
    `const release = ${JSON.stringify(releaseFile)};`,
    `const deadline = Date.now() + ${SUITE_SELF_TIMEOUT_MS};`,
    'const timer = setInterval(() => {',
    '  if (existsSync(release) || Date.now() >= deadline) {',
    '    clearInterval(timer);',
    '    process.exit(0);',
    '  }',
    '}, 5);',
    '',
  ].join('\n');
}

// Run ONE real gate runner and sample its heartbeat file while it beats.
// Everything both arms assert over is captured here, so the temp dir may be
// reaped by afterEach before the second arm reads the result.
async function runGateRunnerAndSampleHeartbeat() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-heartbeat-'));
  cleanups.push(dir);
  const heartbeatFile = path.join(dir, 'heartbeat.json');
  const artifactFile = path.join(dir, 'artifact.json');
  const jobFile = path.join(dir, 'job.json');
  const releaseFile = path.join(dir, 'release.flag');
  const suiteFile = path.join(dir, 'suite.mjs');

  await writeFile(suiteFile, releaseFlagSuiteSource(releaseFile), 'utf8');
  // The job descriptor shape gates.js launchGateRunner persists, including the
  // fields runGateJob actually reads: plan, timeout_ms, heartbeat_ms,
  // suite_cwd, heartbeat_file, artifact_file.
  await writeFile(jobFile, JSON.stringify({
    version: 1,
    run_id: 'run-heartbeat-observer',
    nonce: '9f1d6c2a-0000-4000-8000-00000000ab01',
    cache_key: 'runner-heartbeat-atomic-0600',
    tree_sha: '0000000000000000000000000000000000000000',
    plan: buildSpawnPlan(process.execPath, [suiteFile], process.platform),
    timeout_ms: JOB_TIMEOUT_MS,
    heartbeat_ms: HEARTBEAT_MS,
    created_at: new Date().toISOString(),
    project_dir: dir,
    suite_cwd: dir,
    artifact_file: artifactFile,
    heartbeat_file: heartbeatFile,
    host: hostname(),
  }), 'utf8');

  const child = spawn(process.execPath, [GATE_RUNNER_ENTRY, GATE_RUNNER_SENTINEL], {
    cwd: dir,
    env: { ...process.env, APE_GATE_RUNNER_JOB: jobFile },
    stdio: 'ignore',
  });
  let exitCode = null;
  let running = true;
  const exited = new Promise((resolve) => {
    child.once('exit', (code) => { exitCode = code; running = false; resolve('exit'); });
    child.once('error', (error) => { exitCode = `spawn error: ${error.message}`; running = false; resolve('error'); });
  });

  const inodes = new Set();
  const modes = new Set();
  const births = new Set();
  const beatsByContent = new Set();
  const beatsByMtime = new Set();
  let parsedReads = 0;
  let unparseableReads = 0;
  const beatCount = () => Math.max(beatsByContent.size, beatsByMtime.size);

  // POLL-UNTIL-OBSERVED. Content is read before the stat so a beat identity is
  // available even where the filesystem's timestamp granularity is coarse; the
  // two beat counters are independent of each other and of the inode set, so a
  // sample straddling a beat can never mis-count anything.
  const budgetAt = Date.now() + OBSERVE_BUDGET_MS;
  while (running && Date.now() < budgetAt && beatCount() < BEATS_WANTED) {
    let raw = null;
    try {
      raw = await readFile(heartbeatFile, 'utf8');
    } catch { /* before the first beat, or after the runner removed it */ }
    if (raw !== null) {
      try {
        const beat = JSON.parse(raw);
        if (Number.isFinite(beat?.beat_at)) {
          beatsByContent.add(beat.beat_at);
          parsedReads += 1;
        } else {
          unparseableReads += 1;
        }
      } catch {
        // Ledger (b) in the flesh: a read that landed inside a non-atomic beat.
        // COUNTED, never asserted on — it is a race, not a contract.
        unparseableReads += 1;
      }
    }
    try {
      const info = await stat(heartbeatFile, { bigint: true });
      inodes.add(String(info.ino));
      modes.add(Number(info.mode) & 0o777);
      births.add(String(info.birthtimeNs));
      beatsByMtime.add(String(info.mtimeNs));
    } catch { /* same two windows as above */ }
    await delay(POLL_MS);
  }

  // Release the suite and let the runner finish its own cycle (result artifact,
  // then heartbeat removal). The bounded race is insurance only: the suite's
  // self-deadline and the job's timeout_ms both already bound this.
  await writeFile(releaseFile, 'release', 'utf8').catch(() => {});
  const settled = await Promise.race([exited, delay(EXIT_BUDGET_MS, 'gave-up', { ref: false })]);
  if (settled === 'gave-up') {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }

  let artifactMode = null;
  try {
    artifactMode = Number((await stat(artifactFile, { bigint: true })).mode) & 0o777;
  } catch { /* the runner never got as far as its artifact */ }
  let heartbeatRemoved = false;
  try {
    await stat(heartbeatFile);
  } catch {
    heartbeatRemoved = true;
  }

  return {
    beatCount: beatCount(),
    beatsByContent: beatsByContent.size,
    beatsByMtime: beatsByMtime.size,
    inodes,
    modes,
    births,
    parsedReads,
    unparseableReads,
    artifactMode,
    heartbeatRemoved,
    exitCode,
    settled,
  };
}

// One runner for the whole file. Memoized LAZILY rather than in a beforeAll, so
// either arm still drives the observation on its own when run in isolation.
let heartbeatObservation = null;
function observeHeartbeat() {
  heartbeatObservation ??= runGateRunnerAndSampleHeartbeat();
  return heartbeatObservation;
}

const octal = (mode) => (mode === null ? 'absent' : `0${mode.toString(8).padStart(3, '0')}`);

// Bounded, secret-free diagnostics attached to every assertion below, so a red
// says which of "the harness never saw a runner" and "the beat is written in
// place" happened.
function diagnose(observed) {
  return [
    `beats=${observed.beatCount} (content ${observed.beatsByContent}, mtime ${observed.beatsByMtime})`,
    `inodes=${observed.inodes.size} [${[...observed.inodes].join(' ')}]`,
    `birthtimes=${observed.births.size}`,
    `modes=[${[...observed.modes].map(octal).join(' ')}]`,
    `reads: ${observed.parsedReads} parsed / ${observed.unparseableReads} unparseable`,
    `artifact_mode=${octal(observed.artifactMode)}`,
    `heartbeat_removed=${observed.heartbeatRemoved}`,
    `runner_exit=${observed.exitCode} (${observed.settled})`,
  ].join('; ');
}

describe.skipIf(process.platform === 'win32')('gate-runner heartbeat: atomic and private', () => {
  it('(premise) an in-place rewrite keeps the inode; a temp+rename rewrite replaces it', async () => {
    // Pins the FILESYSTEM PREMISE the arm below rests on, on whatever host is
    // running, using a local reproduction of the temp+rename shape rather than
    // anything imported from the runtime. Green on both sides of the fix by
    // construction: it says nothing about runner.js. Its whole job is to make
    // the red below unambiguous — if this one ever fails, the discriminator
    // stopped discriminating and the arm's verdict means nothing.
    const dir = await mkdtemp(path.join(tmpdir(), 'ape-heartbeat-premise-'));
    cleanups.push(dir);

    const inPlace = path.join(dir, 'in-place.json');
    await writeFile(inPlace, JSON.stringify({ pid: 1, beat_at: 1 }), 'utf8');
    const firstIno = (await stat(inPlace, { bigint: true })).ino;
    await writeFile(inPlace, JSON.stringify({ pid: 1, beat_at: 2 }), 'utf8');
    await writeFile(inPlace, JSON.stringify({ pid: 1, beat_at: 3 }), 'utf8');
    expect((await stat(inPlace, { bigint: true })).ino).toBe(firstIno);

    const published = path.join(dir, 'published.json');
    const observed = new Set();
    for (const beat of [1, 2, 3, 4]) {
      const temporary = `${published}.${beat}.tmp`;
      const handle = await open(temporary, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({ pid: 1, beat_at: beat }), 'utf8');
      await handle.close();
      await rename(temporary, published);
      observed.add(String((await stat(published, { bigint: true })).ino));
    }
    // A brand-new temp file can never be given the inode the still-linked
    // destination holds, so consecutive beats differ even where the allocator
    // recycles the number freed by the previous rename.
    expect(observed.size).toBeGreaterThan(1);
  });

  it('H1 — publishes every beat as a new file rather than rewriting one in place', async () => {
    const observed = await observeHeartbeat();

    // NON-VACUITY FIRST. An observer that saw no beats at all would make the
    // inode assertion below true or false for reasons that have nothing to do
    // with how a beat is written.
    expect(
      observed.beatCount,
      `no gate-runner heartbeat was observed, so this arm asserts nothing about how it is written — ${diagnose(observed)}`,
    ).toBeGreaterThanOrEqual(MIN_BEATS);

    // THE ARM. An in-place open-truncate-write keeps one inode for the runner's
    // whole life; temp + rename installs a new file per beat, which is what
    // makes a concurrent reader's view of the identity witness whole-or-nothing.
    expect(
      observed.inodes.size,
      `the heartbeat held a single inode across ${observed.beatCount} beats, so it is being rewritten in place — a reader landing inside a beat can still see a truncated witness and veto a kill against a live runner — ${diagnose(observed)}`,
    ).toBeGreaterThan(1);
  });

  it('H2 — creates the heartbeat 0600, the same privacy the result artifact already gets', async () => {
    const observed = await observeHeartbeat();

    // REFERENCE CONTROL, green on both sides of the fix: the result artifact in
    // this same module already goes through the atomic 0600 helper, so 0600 is
    // the runner's own established privacy for a file it owns — the heartbeat is
    // not being held to an invented bar. It also proves the runner ran its whole
    // cycle rather than dying early.
    expect(
      observed.artifactMode,
      `the gate runner never completed and wrote its result artifact, so this arm has no reference to compare against — ${diagnose(observed)}`,
    ).toBe(0o600);

    expect(
      observed.beatCount,
      `no gate-runner heartbeat was observed, so no mode was sampled — ${diagnose(observed)}`,
    ).toBeGreaterThanOrEqual(MIN_BEATS);

    // The SECONDARY discriminator, deliberately not the only one: a plain
    // writeFile lands at 0o666 & ~umask, so under `umask 0077` this alone would
    // already be green before the fix. H1 is what makes the pair honest.
    expect(
      [...observed.modes].sort((a, b) => a - b).map(octal),
      `the heartbeat is world- or group-readable; the identity witness must be as private as the artifact beside it — ${diagnose(observed)}`,
    ).toEqual(['0600']);
  });
});
