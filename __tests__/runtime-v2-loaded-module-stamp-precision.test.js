import { describe, it, expect, vi } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import {
  appendFileSync,
  cpSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const sha256Hex = (buf) => createHash('sha256').update(buf).digest('hex');

// ===========================================================================
// Residual (1) -- doctor.js:65-78 (review of run-fixture-40cc7402c031,
// acme PR #378). captureLoadedBundleStamp reads the candidate bundle's bytes
// (readFileSync) and its size/mtime (statSync) as TWO separate syscalls. A
// concurrent same-length rewrite landing between them makes the size/mtime
// hint describe the file AFTER the rewrite while the sha256 still describes
// the file BEFORE it -- a hash strictly OLDER than its own hint. That pairing
// is the exact defect acme PR #378 exists to close: loadedBundleDrift's fast path
// trusts an unchanged size+mtime pair and skips re-hashing, so it reports "no
// drift" forever even though the hash it never rechecks no longer matches
// what a rebuild put on disk.
//
// A real sub-millisecond race at module init cannot be summoned on demand, so
// the two syscalls the defect hinges on are interposed deterministically.
// Critically, the interposition does NOT decide which physical call (read or
// stat) sees which state -- it hands out "the file as it stood before the
// concurrent rewrite" to whichever of the two syscalls doctor.js issues
// FIRST, and "the file as it stood after" to whichever it issues SECOND. The
// assertion below is then read off doctor.js's OWN observed call order
// (recorded in `observedCallOrder`), never assumed by the test -- so a fix
// that reorders the two syscalls (stat first, so the hint is the OLDER state
// and can never claim to be newer than an unrefreshed hash) and a fix that
// fuses them into one atomic read both satisfy it the same natural way; only
// a fix that keeps reading bytes before stat-ing them would still trip it.
// This mirrors the same-file interposition technique already used for a
// different TOCTOU in __tests__/runtime-v2-importer-determinism-toctou.test.js.
const concurrentRewrite = vi.hoisted(() => {
  const byteLength = 512;
  return {
    // What a real `import` moments earlier would have loaded.
    beforeRewrite: { bytes: Buffer.alloc(byteLength, 0x11), mtimeMs: 1_700_000_000_000 },
    // Same length, different content, a strictly later mtime -- a concurrent
    // writer landing between doctor.js's read and its stat, in either order.
    afterRewrite: { bytes: Buffer.alloc(byteLength, 0x22), mtimeMs: 1_700_000_120_000 },
    observedCallOrder: [],
    // Populated by the mocked readFileSync below with whatever bytes it
    // actually returned to doctor.js's own call -- the unconditional
    // invariant below is pinned against this, never against an assumption
    // about which physical call (read or stat) went first.
    readFileSyncReturnedBytes: null,
  };
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal();
  // The one URL captureLoadedBundleStamp's source-execution fallback
  // resolves to when THIS test file is the first thing to import doctor.js
  // (this repository's own dist/ape-mcp.bundle.mjs). The sibling
  // bundled-execution candidate (lib/runtime/ape-mcp.bundle.mjs) is passed
  // straight through and genuinely does not exist, so the real syscalls
  // throw ENOENT for it exactly as they would unmocked, and the candidate
  // loop falls through to the one faked below. No file on disk is ever read
  // or written by this mock -- it answers entirely from memory.
  const isRacedCandidate = (target) => target instanceof URL && /\/dist\/ape-mcp\.bundle\.mjs$/.test(target.href);
  const nextObservedState = (label) => {
    const state = concurrentRewrite.observedCallOrder.length === 0 ? concurrentRewrite.beforeRewrite : concurrentRewrite.afterRewrite;
    concurrentRewrite.observedCallOrder.push(label);
    return state;
  };
  return {
    ...actual,
    readFileSync: (target, ...rest) => {
      if (!isRacedCandidate(target)) return actual.readFileSync(target, ...rest);
      const state = nextObservedState('read');
      // Recorded unconditionally (never assumed) so the test below can pin
      // the hash against exactly the bytes doctor.js's OWN readFileSync call
      // received, regardless of call order.
      concurrentRewrite.readFileSyncReturnedBytes = state.bytes;
      return state.bytes;
    },
    statSync: (target, ...rest) => {
      if (!isRacedCandidate(target)) return actual.statSync(target, ...rest);
      const state = nextObservedState('stat');
      return { size: state.bytes.length, mtimeMs: state.mtimeMs };
    },
  };
});

// The only place in this file that first evaluates '../lib/runtime/doctor.js'
// -- its top-level captureLoadedBundleStamp() call is what races the two
// mocked syscalls above.
import { LOADED_BUNDLE_STAMP } from '../lib/runtime/doctor.js';

describe('doctor.js LOADED_BUNDLE_STAMP: hash/hint pairing under a same-length concurrent rewrite (residual 1)', () => {
  it('never records a hash of the pre-rewrite bytes beside a size/mtime hint that already reflects the post-rewrite file', () => {
    // Fixture truth first: without this, everything below would pass
    // vacuously for the wrong reason (the mock never engaged at all).
    expect(
      concurrentRewrite.observedCallOrder,
      'doctor.js never touched the raced candidate bundle at module init -- the invariant below was never exercised',
    ).toHaveLength(2);
    expect(LOADED_BUNDLE_STAMP, 'module init resolved no candidate bundle at all').not.toBeNull();

    // Same byte length on both sides of the rewrite, so `size` can never
    // discriminate before from after -- only mtime_ms (the cheap hint) and
    // sha256 (the authority the hint is only ever a shortcut for) can.
    expect(LOADED_BUNDLE_STAMP.size).toBe(concurrentRewrite.beforeRewrite.bytes.length);

    // UNCONDITIONAL invariant (not gated on hintSaysAfterRewrite below, which
    // this fixture's own [stat, read] call order leaves false, so the guarded
    // block beneath is unreached on the current tree): the recorded sha256
    // must match bytes ACTUALLY READ by doctor.js's own readFileSync call --
    // never merely bytes it could have re-derived some other way. Today's
    // fixture proves the mock's readFileSync branch genuinely fired (it is
    // this module's only source of the raced candidate's bytes), and pins
    // the hash to exactly what that call returned. An implementation that
    // statSync'd the candidate twice and never called readFileSync at all
    // (e.g. deriving a hash from a cached read done elsewhere) would leave
    // `readFileSyncReturnedBytes` null and fail the first assertion; one
    // that reads but hashes different bytes than it recorded would fail the
    // second.
    expect(
      concurrentRewrite.observedCallOrder,
      'doctor.js never called the mocked readFileSync on the raced candidate at all',
    ).toContain('read');
    expect(LOADED_BUNDLE_STAMP.sha256).toBe(sha256Hex(concurrentRewrite.readFileSyncReturnedBytes));

    const hintSaysAfterRewrite = LOADED_BUNDLE_STAMP.mtime_ms === concurrentRewrite.afterRewrite.mtimeMs;
    const hashSaysAfterRewrite = LOADED_BUNDLE_STAMP.sha256 === sha256Hex(concurrentRewrite.afterRewrite.bytes);
    const hashSaysBeforeRewrite = LOADED_BUNDLE_STAMP.sha256 === sha256Hex(concurrentRewrite.beforeRewrite.bytes);

    // The invariant: whenever the recorded hint already reports the
    // post-rewrite file, the recorded hash must report that SAME file --
    // otherwise a later doctor() call whose on-disk state still matches this
    // (now-stale) hint takes loadedBundleDrift's fast path and calls it "no
    // drift", while the hash it never rechecks reflects bytes nobody can see
    // on disk any more.
    if (hintSaysAfterRewrite) {
      expect(
        hashSaysAfterRewrite,
        `doctor.js issued its two syscalls in order [${concurrentRewrite.observedCallOrder.join(', ')}]: the ` +
          'resulting mtime_ms hint already reflects the post-rewrite file, but sha256 still reflects the ' +
          'pre-rewrite bytes -- a hash strictly OLDER than its own hint, exactly the pairing that lets ' +
          'loadedBundleDrift mask a real hash mismatch as "no drift"',
      ).toBe(true);
      expect(hashSaysBeforeRewrite).toBe(false);
    }
  });
});

// ===========================================================================
// Residuals (2) and (3) -- exercised against REAL, live MCP servers. Each
// scenario needs a DIFFERENT execution shape, so each gets its own staged
// deployment and its own server:
//
// (2) THE SOURCE-EXECUTION NOTICE NAMES A FILE THE PROCESS NEVER LOADED.
//     Exercised against a server started the unbundled way
//     (`node bin/ape-mcp.mjs`), which is SOURCE execution: the process
//     imports lib/**/*.js directly and never `import`s
//     dist/ape-mcp.bundle.mjs at all. runtimeBundleCandidates() still falls
//     back to dist/ape-mcp.bundle.mjs for fingerprinting purposes even when
//     nothing ever imported it, and the current wording asserts "the live
//     MCP server is executing a STALE runtime module: ape-mcp.bundle.mjs ...
//     after this process loaded it" -- untrue for a process that only ever
//     executed lib/**/*.js. The ticket accepts either repair shape (suppress
//     the dimension under source execution, or reword the detail to stop
//     attesting to a load that never happened), so this pin only forbids the
//     untrue claim; an empty notice list satisfies it too.
// (3) A DOCUMENTED SILENCE NO TEST PINS (docs/architecture.md:104-116): a
//     rewrite that lands byte-identical content under a fresh mtime -- the
//     shape of an idempotent rebuild, and of CI's `npm run bundle && git diff
//     -- dist/` freshness check on every clean build -- must report no
//     drift. This is already-correct today (the slow hash-comparison path
//     already agrees with the hint), so this pin is expected GREEN from the
//     start; it lives in this same file only so the file still fails as a
//     whole while (1) is open.
//
//     This pin MUST run against a BUNDLED-execution server
//     (`node dist/ape-mcp.bundle.mjs`), never the source-execution server
//     residual (2) uses. The fix for residual (2) gates the whole
//     loaded-module dimension on LOADED_BUNDLE_STAMP_IS_EXECUTING
//     (lib/runtime/doctor.js:107 and :415), which is FALSE for any server
//     started as `node bin/ape-mcp.mjs` -- so under source execution the
//     dimension never reports anything at all, and an "empty notices" pin
//     there would hold vacuously no matter what loadedBundleDrift did,
//     including a regression to comparing mtime alone. Only under bundled
//     execution -- where import.meta.url IS the resolved candidate and the
//     gate is true -- does the dimension actually run, so only there can this
//     pin genuinely fail on an mtime-only regression.
// ===========================================================================
describe('doctor loaded-module-drift reported by genuine source- and bundled-execution servers (residuals 2 and 3)', () => {
  const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
  const staged = [];

  function stagedTempDir(prefix) {
    // realpathSync: the ESM loader reports RESOLVED paths in import.meta.url,
    // so an unresolved /var vs /private/var spelling would compare two names
    // for the same directory for reasons unrelated to this contract.
    const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
    staged.push(dir);
    return dir;
  }

  function discardStagedDirs() {
    for (const dir of staged.splice(0)) {
      try {
        // Unlink the node_modules SYMLINK before the recursive remove, so no
        // cleanup path can ever reach into this repository's real node_modules.
        rmSync(join(dir, 'node_modules'), { force: true, maxRetries: 10, retryDelay: 500 });
      } catch {
        /* not staged with a symlink */
      }
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
    }
  }

  function runGitQuiet(dir, args) {
    execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  }

  function commitEverything(dir, message) {
    runGitQuiet(dir, ['add', '--all']);
    runGitQuiet(dir, [
      '-c',
      'user.email=ape@test.invalid',
      '-c',
      'user.name=ape-test',
      'commit',
      '--no-verify',
      '--no-gpg-sign',
      '-m',
      message,
    ]);
  }

  // The project's own bundler, run against the staged copy, so whatever it
  // bakes into dist/ape-mcp.bundle.mjs (including any build stamp) is
  // exactly what a real release build produces -- never a hand-built stand-in.
  function rebuildDistBundle(dir) {
    execFileSync(process.execPath, [join(dir, 'scripts', 'bundle-mcp.mjs')], { cwd: dir, stdio: 'ignore' });
  }

  // A throwaway deployment carrying this checkout's own sources and a real
  // built dist/, so `node <dir>/bin/ape-mcp.mjs` is a genuine, self-contained
  // source-execution server -- never touching the governed tree it was staged
  // from.
  function stageSourceExecutionProject() {
    const dir = stagedTempDir('ape-stamp-precision-');
    for (const entry of ['package.json', 'bin', 'lib', 'scripts']) {
      cpSync(join(REPO_ROOT, entry), join(dir, entry), { recursive: true });
    }
    symlinkSync(join(REPO_ROOT, 'node_modules'), join(dir, 'node_modules'), 'dir');
    writeFileSync(join(dir, '.gitignore'), 'node_modules\n');
    runGitQuiet(dir, ['init']);
    rebuildDistBundle(dir);
    commitEverything(dir, 'stage a source-execution deployment');
    return dir;
  }

  // Shared JSON-RPC wiring for a live `ape_config doctor` server, parameterized
  // only by WHICH file is actually executed -- the one thing that differs
  // between the two execution shapes residuals (2) and (3) each require.
  function launchApeServer(projectDir, entryParts, label) {
    const env = { ...process.env };
    delete env.CLAUDE_PROJECT_DIR;
    delete env.CODEX_CWD;
    const child = spawn(process.execPath, [join(projectDir, ...entryParts)], {
      cwd: projectDir,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const pendingRequests = new Map();
    let stdoutBuffer = '';
    let stderrBuffer = '';
    let exitInfo = null;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk;
      let newlineAt = stdoutBuffer.indexOf('\n');
      while (newlineAt >= 0) {
        const line = stdoutBuffer.slice(0, newlineAt).trim();
        stdoutBuffer = stdoutBuffer.slice(newlineAt + 1);
        newlineAt = stdoutBuffer.indexOf('\n');
        if (line === '') continue;
        let message = null;
        try {
          message = JSON.parse(line);
        } catch {
          continue; // progress/diagnostic noise, not a JSON-RPC response frame
        }
        const waiter = pendingRequests.get(message?.id);
        if (waiter) {
          pendingRequests.delete(message.id);
          waiter.resolve(message);
        }
      }
    });
    child.stderr.on('data', (chunk) => {
      stderrBuffer += chunk;
    });
    child.on('exit', (code, signal) => {
      exitInfo = { code, signal };
      for (const waiter of pendingRequests.values()) {
        waiter.reject(new Error(`${label} server exited (${code}/${signal}): ${stderrBuffer}`));
      }
      pendingRequests.clear();
    });
    let nextRequestId = 0;
    const call = (method, params) =>
      new Promise((resolve, reject) => {
        if (exitInfo !== null) {
          reject(new Error(`${label} server already exited: ${stderrBuffer}`));
          return;
        }
        const id = ++nextRequestId;
        const timer = setTimeout(() => {
          pendingRequests.delete(id);
          reject(new Error(`no response to ${method} within 60s: ${stderrBuffer}`));
        }, 60_000);
        pendingRequests.set(id, {
          resolve: (message) => {
            clearTimeout(timer);
            resolve(message);
          },
          reject: (cause) => {
            clearTimeout(timer);
            reject(cause);
          },
        });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    return {
      isAlive: () => exitInfo === null,
      async requestDoctorReport(args) {
        const message = await call('tools/call', { name: 'ape_config', arguments: { action: 'doctor', ...args } });
        const text = message.result?.content?.[0]?.text ?? '';
        if (message.result?.isError) throw new Error(`ape_config doctor reported an error: ${text}`);
        const payload = JSON.parse(text);
        if (!Array.isArray(payload?.doctor?.checks)) {
          throw new Error(`ape_config doctor returned no checks: ${text.slice(0, 400)}`);
        }
        return payload.doctor;
      },
      terminate() {
        try {
          child.stdin.end();
        } catch {
          /* already gone */
        }
        child.kill('SIGKILL');
        return new Promise((resolve) => {
          if (exitInfo !== null) resolve();
          else child.once('exit', resolve);
        });
      },
    };
  }

  // `node bin/ape-mcp.mjs` -- deliberately NOT the bundled
  // dist/ape-mcp.bundle.mjs the sibling runtime-v2-loaded-module-drift.test.js
  // spawns. This process only ever resolves and evaluates lib/**/*.js, so
  // import.meta.url never equals the candidate bundle: LOADED_BUNDLE_STAMP_IS_EXECUTING
  // is false here, and the loaded-module dimension stays silent (residual 2's scope).
  function launchSourceExecutionServer(projectDir) {
    return launchApeServer(projectDir, ['bin', 'ape-mcp.mjs'], 'source-execution');
  }

  // `node dist/ape-mcp.bundle.mjs` -- the bundled-execution deployment shape.
  // Here import.meta.url IS the resolved candidate bundle, so
  // LOADED_BUNDLE_STAMP_IS_EXECUTING is true and the loaded-module dimension
  // actually runs -- required for residual (3)'s idempotent-rebuild pin to be
  // capable of failing at all.
  function launchBundledExecutionServer(projectDir) {
    return launchApeServer(projectDir, ['dist', 'ape-mcp.bundle.mjs'], 'bundled-execution');
  }

  // Any check entry naming the LOADED-module dimension (matched on content --
  // an implementation may keep the existing 'loaded-module-drift' name, fold
  // it into 'bundle-drift', or rename it entirely).
  const isModuleDriftNotice = (entry) => entry.passed !== true && /module/i.test(`${entry.name ?? ''} ${entry.detail ?? ''}`);
  const moduleDriftNotices = (report) => report.checks.filter(isModuleDriftNotice);

  const SOURCE_PROBE =
    '\n// residual-2 probe: a genuine source edit, so the rebuilt dist/ape-mcp.bundle.mjs truly differs\n' +
    "if (process.env.APE_STAMP_PRECISION_PROBE === 'never-set') process.stderr.write('ape stamp-precision probe\\n');\n";

  it(
    'stays silent on an idempotent rebuild under bundled execution, where the loaded-module dimension actually runs (residual 3)',
    async () => {
      // stageSourceExecutionProject() (and the server launch right after it)
      // live INSIDE this try, not before it: stagedTempDir already records
      // the mkdtemp'd dir the instant it is created, so a throw partway
      // through staging (a failed cpSync, symlinkSync, or bundle rebuild)
      // must still reach the finally below, or the half-staged dir and its
      // node_modules symlink leak on disk with nothing left to clean them up.
      let server = null;
      try {
        const project = stageSourceExecutionProject();
        const distBundlePath = join(project, 'dist', 'ape-mcp.bundle.mjs');
        server = launchBundledExecutionServer(project);
        // Session start: this server IS `node dist/ape-mcp.bundle.mjs`, so
        // import.meta.url resolves to that same file and
        // LOADED_BUNDLE_STAMP_IS_EXECUTING is true -- unlike the
        // source-execution server below, where the production gate
        // (lib/runtime/doctor.js:107 and :415) suppresses the loaded-module
        // dimension outright and this same assertion would hold vacuously no
        // matter what loadedBundleDrift did.
        await server.requestDoctorReport({ project_dir: project });

        // An idempotent rebuild -- identical bytes, a fresh mtime pushed into
        // the future -- must stay silent. Already-correct behavior today (the
        // slow hash-comparison path already agrees with the hint), so this
        // half is expected GREEN.
        const bytesBeforeTouch = readFileSync(distBundlePath);
        writeFileSync(distBundlePath, bytesBeforeTouch);
        const future = new Date(Date.now() + 10_000);
        utimesSync(distBundlePath, future, future);
        const reportAfterIdempotentTouch = await server.requestDoctorReport({ project_dir: project });

        expect(server.isAlive(), 'the bundled-execution server crashed mid-fixture').toBe(true);
        expect(moduleDriftNotices(reportAfterIdempotentTouch)).toEqual([]);
        expect(reportAfterIdempotentTouch.healthy).toBe(true);

        // Fixture truth: without this, the empty-array assertion above would
        // hold vacuously if the loaded-module dimension never fires for this
        // server at all -- exactly the defect this rewrite exists to stop
        // (the prior version of this pin ran against a source-execution
        // server where the dimension is unconditionally silent). A genuine,
        // content-changing rebuild right afterward must produce a real
        // notice, proving the dimension is live and that the silence just
        // asserted above was actually earned rather than unreachable.
        appendFileSync(join(project, 'bin', 'ape-mcp.mjs'), SOURCE_PROBE);
        rebuildDistBundle(project);
        const reportAfterRealRebuild = await server.requestDoctorReport({ project_dir: project });
        expect(server.isAlive(), 'the bundled-execution server crashed after a real rebuild').toBe(true);
        expect(
          moduleDriftNotices(reportAfterRealRebuild).length,
          'the loaded-module dimension never fired for this server -- the idempotent silence above was never actually exercised',
        ).toBeGreaterThan(0);
      } finally {
        if (server) await server.terminate();
        discardStagedDirs();
      }
    },
    240_000,
  );

  it(
    'reports a real rebuild honestly under source execution, without claiming to have loaded a bundle it never ran (residual 2)',
    async () => {
      // See the sibling residual-3 test above: staging happens INSIDE this
      // try so a throw mid-stage still reaches the cleanup below.
      let server = null;
      try {
        const project = stageSourceExecutionProject();
        const distBundlePath = join(project, 'dist', 'ape-mcp.bundle.mjs');
        server = launchSourceExecutionServer(project);
        // Session start: the server evaluates bin/ape-mcp.mjs + lib/**/*.js
        // exactly once, never importing dist/ape-mcp.bundle.mjs.
        await server.requestDoctorReport({ project_dir: project });

        // Fixture truth: capture the bundle bytes the session started with,
        // so the rebuild below is proven to have actually changed them on
        // disk -- otherwise the whole "real rebuild" scenario would rest on
        // an unverified premise, matching the fixture-truth discipline the
        // sibling suite already applies
        // (__tests__/runtime-v2-loaded-module-drift.test.js:312) and residual
        // (1)'s half of this file already applies at line 98.
        const bytesBeforeRebuild = readFileSync(distBundlePath);

        // A REAL rebuild (genuinely different bytes) after editing a bundled
        // source file -- the ordinary friction-18 trigger, under source
        // execution. Expected RED: current wording claims this process
        // loaded a bundle it never imported.
        appendFileSync(join(project, 'bin', 'ape-mcp.mjs'), SOURCE_PROBE);
        rebuildDistBundle(project);
        const bytesAfterRebuild = readFileSync(distBundlePath);
        expect(
          bytesAfterRebuild.equals(bytesBeforeRebuild),
          'fixture truth: the rebuild did not actually change dist/ape-mcp.bundle.mjs -- the "real rebuild" scenario below was never exercised',
        ).toBe(false);

        const reportAfterRealRebuild = await server.requestDoctorReport({ project_dir: project });

        expect(server.isAlive(), 'the source-execution server crashed after a real rebuild').toBe(true);
        const notices = moduleDriftNotices(reportAfterRealRebuild);
        for (const notice of notices) {
          expect(notice.informational, `${notice.name} must stay informational`).toBe(true);
          expect(notice.passed, `${notice.name} must never fail health`).not.toBe(false);
          const detail = String(notice.detail ?? '');
          // Fixture truth: this server ran as `node bin/ape-mcp.mjs` and never
          // imported dist/ape-mcp.bundle.mjs, so any claim that THIS PROCESS
          // loaded or is executing that named bundle is false, whichever
          // repair shape a fix takes (an empty `notices` array above already
          // satisfies this loop with nothing to check).
          const falselyClaimsThisProcessRanTheBundle =
            /this process loaded it/i.test(detail) || /is executing a stale runtime module/i.test(detail);
          expect(
            falselyClaimsThisProcessRanTheBundle,
            `notice claims this source-execution process itself loaded/executed the bundle, which is untrue: ${detail}`,
          ).toBe(false);
        }
        expect(reportAfterRealRebuild.healthy).toBe(true);
      } finally {
        if (server) await server.terminate();
        discardStagedDirs();
      }
    },
    240_000,
  );
});
