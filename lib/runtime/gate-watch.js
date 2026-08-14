import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { access, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sha256 } from './canonical.js';
import {
  CHECKS_REGISTRATION_WINDOW_MS,
  GATE_RUNNER_HEARTBEAT_MS,
  GATE_RUNNER_MAX_SPAWNS,
  GATE_RUNNER_STALE_MS,
  GATE_SUITE_TEMP_SWEEP_SCAN_CAP,
  GATE_SUITE_TEMP_SWEEP_STALE_MS,
} from './constants.js';
import { buildSpawnPlan, detectTestRunner, GATE_RUNNER_SENTINEL, runTestSuite, splitCommand, targetedInvocation, templateInvocation } from './runner.js';
import { atomicWriteJson, readJson } from './storage.js';
import { currentTreeSha, runGit, workingTreeStatus } from './git.js';
import { normalizeClaimPath, TEST_PATH_PATTERN } from './path-scope.js';
import { spawnDetached, spawnWithTimeout } from './spawn.js';
import { validateClaudePlugin, validateCodexPlugin } from './plugin-validation.js';
import { prepareGatePollContext, prepareGateWatchContext } from './gate-evaluation.js';

// Same liveness probe as lock.js: process.kill(pid, 0) signals nothing —
// ESRCH => dead, EPERM => alive but unsignalable (still alive), so the respawn
// fence never double-launches a working runner (A2).
function processExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

// ---------------------------------------------------------------------------
// Non-blocking local merge gates (the 'gating' watch). The full suite runs in a
// runtime-spawned detached child; startGateSuite launches it and rests, and
// pollGateSuite consumes its artifact on a later `ape_run next`. Everything here
// is host- and framework-agnostic: the suite command stays config-supplied, the
// child uses Node child_process only, and it NEVER runs git or touches the tree.
// ---------------------------------------------------------------------------

function gateSuiteFiles(paths, cacheKey) {
  // Filenames derive from sha256(cacheKey) so job/artifact/heartbeat for one
  // tree+command sit together and a stale set is deterministically locatable.
  const stem = sha256(cacheKey);
  const dir = path.join(paths.runtime, 'gate-suite');
  return {
    dir,
    job: path.join(dir, `${stem}.job.json`),
    artifact: path.join(dir, `${stem}.result.json`),
    heartbeat: path.join(dir, `${stem}.heartbeat`),
  };
}

// The two temp shapes this runtime actually produces in the gate-suite
// directory: runner.js's atomicWriteFile600 (`<file>.<pid>.<ms>.tmp` — the
// heartbeat and artifact family) and storage.js's atomicWriteJson
// (`<file>.<pid>.<ms>.<hex8>.tmp` — files.job). Anchored on this family
// rather than a bare `*.tmp` glob so the sweep below can never match a
// heartbeat/job/artifact file itself (none of those end in `.tmp`).
const GATE_SUITE_TEMP_PATTERN = /\.\d+\.\d+\.tmp$|\.\d+\.\d+\.[0-9a-f]{8}\.tmp$/i;

// Bounded sweep of orphaned atomic-write temps (roadmap
// orphaned-heartbeat-temp-has-no-sweeper), run at every launchGateRunner
// chokepoint below — every initial start, respawn, and multi-runner advance
// funnels through it. A write interrupted before its rename (an external
// SIGKILL mid-write is the one producer that remains reachable at all — see
// the ledger at atomicWriteFile600 in runner.js) leaves a temp that no
// heartbeat/job/artifact removal in this runtime ever matches, because each
// of those names an exact final path, never a directory.
//
// BOUNDED REMOVALS, ONE DIRECTORY LISTING — that is exactly what is bounded
// here, no more: ONE readdir per call (never a recursive walk or a second
// pass) lists every matching name, and every matching name is then stat'd for
// its age — that reach scales with the directory and is NOT capped. What IS
// capped is the removal work: candidates are ordered by AGE (oldest mtime
// first, NEVER by lexicographic name) so that GATE_SUITE_TEMP_SWEEP_SCAN_CAP-
// or-more temps that are merely fresher and simply happen to sort earlier by
// name can never shadow one genuinely stale temp out of the removal pass, and
// only then is the age-ordered list capped at GATE_SUITE_TEMP_SWEEP_SCAN_CAP
// before any rm runs (a directory holding more stale candidates than the cap
// is drained incrementally across later launches, not all at once); and only
// a temp OLDER than GATE_SUITE_TEMP_SWEEP_STALE_MS is removed — a temp at or
// under that age may belong to a live concurrent runner's in-progress write,
// and removing THAT one would BREAK a healthy write rather than merely miss a
// stale one. Never touches the heartbeat, job or artifact files themselves;
// existing code already owns those. A stat/rm failure on one candidate is
// swallowed and the sweep moves to the next; a readdir failure (directory
// missing or unreadable) is swallowed too — this must never fail a launch.
//
// THE MTIME FENCE IS A CLOCK ASSUMPTION, NOT A LIVENESS PROBE, AND THAT IS
// BOUNDED, NOT CORRUPTING. The A2 respawn fence in pollGateSuite/
// pollGateSuiteMulti below only SKIPS the PID liveness probe when
// `watch.host !== hostname()`; it may then respawn once the heartbeat itself
// has aged past stale_ms, not unconditionally. So the process running this
// sweep and the process mid-write on a given temp can be different hosts;
// clock skew or a wedged filesystem can age a genuinely in-flight temp past
// the threshold.
// The cost is bounded: the writer's own `rename(temporary, file)` then fails
// ENOENT. The heartbeat and artifact writers (runner.js) already swallow that
// with an inert `.catch(() => {})` and drop the beat/result silently; the job
// write is the one call site that does NOT use that idiom — launchGateRunner
// below wraps it instead so the same failure returns the same `{ launched:
// false }` shape every unresolvable-launch path already returns, and every
// call site that launches a runner — startGateSuite, startGateSuiteMulti, and
// the pollGateSuite/pollGateSuiteMulti respawns — already fails its own
// caller closed on that shape. Either way the outcome is one dropped beat,
// result, or job write, never a corrupted one.
//
// FIRES ONLY AT A LAUNCH, RECORDED RATHER THAN IMPLIED CLOSED. A kill against
// the LAST launch of a run leaves its orphan on disk until some future gate
// evaluation calls launchGateRunner again; the single-runner success path
// launches exactly once per run, so that orphan can outlive the run itself
// until a later evaluation (this project's or another cache key's) sweeps it.
async function sweepStaleGateSuiteTemps(dir) {
  let entries;
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  // ONE wall-clock read, taken BEFORE the stat pass begins
  // (gate-sweep-staleness-clock-drift): every candidate's staleness verdict is
  // decided against this single value below, so a candidate's measured age can
  // never be inflated by however long the O(N) stat pass (and the age-sort)
  // over the OTHER matching candidates takes — an interval that GROWS with the
  // number of matches, precisely the case this sweep exists to handle. A live
  // concurrent runner's in-progress write must never be judged stale merely
  // because many other temps happened to share its directory.
  const now = Date.now();
  const aged = [];
  for (const name of entries) {
    if (!GATE_SUITE_TEMP_PATTERN.test(name)) continue;
    const file = path.join(dir, name);
    try {
      const info = await stat(file);
      aged.push({ file, mtimeMs: info.mtimeMs });
    } catch {
      // best-effort: a candidate that vanished or could not be stat'd between
      // the readdir and here is not this sweep's job to report
    }
  }
  // AGE-ORDERED, not name-ordered: the oldest candidates sort first so the
  // cap below can never let fresher temps shadow a genuinely stale one.
  const candidates = aged
    .sort((a, b) => a.mtimeMs - b.mtimeMs)
    .slice(0, GATE_SUITE_TEMP_SWEEP_SCAN_CAP);
  for (const { file, mtimeMs } of candidates) {
    if (now - mtimeMs > GATE_SUITE_TEMP_SWEEP_STALE_MS) {
      try {
        await rm(file, { force: true });
      } catch {
        // best-effort: removal race lost to another process is not this
        // sweep's job to report
      }
    }
  }
}

// Locate the UNBUNDLED runner entry to spawn (A4): probe './runner.js' first
// (the lib/runtime layout the tests and dev server use), then
// '../lib/runtime/runner.js' (the bundled dist/ layout, where this module's code
// lives beside the runner one directory up). Realpath'd string comparison keeps
// the child's own main-module guard honest. Unresolvable returns null so the
// caller fails the gate closed in-call rather than silently skipping it.
function resolveRunnerEntry() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const rel of ['./runner.js', '../lib/runtime/runner.js']) {
    const candidate = path.resolve(here, rel);
    try {
      return realpathSync(candidate);
    } catch {
      // not here; try the next layout
    }
  }
  return null;
}

// A synthetic full-suite result for an IN-CALL tooling failure (a malformed
// configured command, no detectable runner, or an unresolvable runner entry).
// Shaped exactly like a runTestSuite verification so evaluateGates fails the
// full_suite check closed and the run blocks honestly, same as today.
function toolingFailureFull(treeSha, suiteCommand, message) {
  const verification = {
    passed: false,
    exit_code: null,
    duration_ms: 0,
    output: message,
    tooling_failure: true,
  };
  return {
    passed: false,
    tree_sha: treeSha,
    command: suiteCommand,
    result_hash: sha256(verification),
    recorded_at: new Date().toISOString(),
    verification,
  };
}

// Resolve the suite spawn plan in the PARENT (A3): a configured command is
// tokenized (a malformed one is a tooling failure, not a detached crash); an
// absent command auto-detects a runner (no runner detected is a tooling
// failure). detectTestRunner + buildSpawnPlan is exactly today's in-call suite
// resolution, preserved so the detached path runs the identical invocation.
async function resolveSuitePlan(projectDir, suiteCommand) {
  if (suiteCommand) {
    let tokens;
    try {
      tokens = splitCommand(suiteCommand);
    } catch (error) {
      return { error: error.message };
    }
    const [command, ...args] = tokens;
    return { plan: buildSpawnPlan(command, args) };
  }
  const runner = await detectTestRunner(projectDir);
  if (!runner.command) {
    return { error: 'No test runner detected. Configure test_commands.full.' };
  }
  return { plan: buildSpawnPlan(runner.command, runner.args) };
}

// The detached gate suite for a polyglot runner must execute at that runner's
// OWN root — a subdir command (`cargo test`, `go test ./...`, a bare
// `npx vitest run`) resolves its manifest/config from cwd. This mirrors the
// red-admission sibling observeRedTestPerRunner (service.js), which runs each
// participant at path.join(paths.root, runner.root ?? '.'). A '.'/absent root
// resolves to the repo root, so single-runner and root-runner gates stay
// byte-identical to today.
function runnerSuiteDir(projectDir, root) {
  return root && root !== '.' ? path.join(projectDir, root) : projectDir;
}

// Write the job descriptor and launch the detached runner. Returns the runner
// pid (null on an unresolvable entry — the caller fails closed). Shared by the
// initial start and the bounded respawn so both carry an identical job shape.
// suiteDir is the cwd the SUITE executes at (a polyglot runner's own root);
// project_dir stays the repo root for any repo-scoped use.
async function launchGateRunner(projectDir, files, jobFields, suiteDir = projectDir) {
  const entry = resolveRunnerEntry();
  if (!entry) return { pid: null, launched: false };
  await mkdir(files.dir, { recursive: true });
  // Bounded directory hygiene at the chokepoint (orphaned-heartbeat-temp-has-
  // no-sweeper) — see sweepStaleGateSuiteTemps above; never fails the launch.
  await sweepStaleGateSuiteTemps(files.dir).catch(() => {});
  // Clear a stale heartbeat so a fresh runner's absence-of-beat is unambiguous.
  await rm(files.heartbeat, { force: true }).catch(() => {});
  const job = {
    version: 1,
    heartbeat_ms: GATE_RUNNER_HEARTBEAT_MS,
    ...jobFields,
    project_dir: projectDir,
    suite_cwd: suiteDir,
    artifact_file: files.artifact,
    heartbeat_file: files.heartbeat,
    host: hostname(),
  };
  try {
    await atomicWriteJson(files.job, job);
  } catch (error) {
    // Fail closed (never let a job-write failure — e.g. storage.js's
    // replaceFile rethrowing a non-transient rename error — propagate out of
    // launchGateRunner as a rejected promise), but CARRY the real cause
    // (gate-launch-failure-cause-is-discarded): every call site renders
    // `reason` when present and falls back to its own fixed
    // resolution-failure string only when it is absent, so a disk/permission
    // fault on the job write is never misreported as an unresolvable runner
    // entry.
    return {
      pid: null,
      launched: false,
      // prose-bound-exempt: fixed diagnostic template; ${error?.code} and
      // ${error?.message} are this module's own filesystem-error fields from the
      // job-descriptor write, never agent-authored text.
      reason: `gate-suite job descriptor write failed (${error?.code ?? 'unknown error'}): ${error?.message ?? String(error)}`,
    };
  }
  const child = spawnDetached(process.execPath, [entry, GATE_RUNNER_SENTINEL], {
    cwd: projectDir,
    env: { APE_GATE_RUNNER_JOB: files.job },
  });
  return { pid: child?.pid ?? null, launched: true };
}

// One accumulator entry in the sequential union's runner_results — everything
// evaluateGates needs to build full_suite.runners[] AND to persist the deferred
// per-runner keyR cache write. `result` (the full-shaped suite result) is
// carried only for uncached runners (the ones that will be written); a
// cache-served runner needs no re-write.
function runnerResultEntry(participant, result, cached) {
  return {
    id: participant.id,
    mode: participant.mode,
    command: participant.command,
    cached,
    keyR: participant.keyR,
    ...(cached ? {} : { result }),
    passed: result.passed === true,
    result_hash: result.result_hash,
  };
}

// Build the spawn plan for ONE participating runner: impacted travels as its
// pre-tokenized invocation (never re-tokenized — a rendered path with spaces
// would split); full resolves its plan from the resolved command string exactly
// as the single suite does.
async function resolveRunnerPlan(projectDir, participant) {
  return participant.mode === 'impacted' && participant.invocation
    ? { plan: buildSpawnPlan(participant.invocation.command, participant.invocation.args) }
    : await resolveSuitePlan(projectDir, participant.command);
}

// MULTI strategy start: launch ONLY the first uncached participating runner and
// rest in the gating watch; the rest run one at a time as pollGateSuite adopts
// each and re-arms the same watch. An all-cached-green union returns a
// synchronous all-pass hit; an orphan block returns a synchronous fail-closed
// hit having launched NO runner suite.
async function startGateSuiteMulti(projectDir, paths, state, config, ctx) {
  // Orphan block (invariant 9 fail-closed): zero participants, gate fails.
  if (ctx.blocked) {
    return { hit: { ctx: { ...ctx, runnerResults: [] }, full: null, cached: false } };
  }
  // Partition: cache-served greens are recorded directly; the rest queue to run
  // ONE AT A TIME, ordered by id and PERSISTED so the cursor is tamper-evident.
  const cachedResults = [];
  const uncached = [];
  for (const participant of ctx.participants) {
    if (participant.cachedEntry?.passed === true) {
      cachedResults.push(runnerResultEntry(participant, participant.cachedEntry, true));
    } else {
      uncached.push(participant);
    }
  }
  const runnerOrder = uncached.map((participant) => participant.id).sort();
  // Every participating runner already cache-served green → synchronous all-pass
  // hit whose union is the AND of the served results (no runner executes).
  if (runnerOrder.length === 0) {
    return { hit: { ctx: { ...ctx, runnerResults: cachedResults }, full: null, cached: true } };
  }
  const current = uncached.find((participant) => participant.id === runnerOrder[0]);
  const resolved = await resolveRunnerPlan(projectDir, current);
  if (resolved.error) {
    const failed = toolingFailureFull(ctx.treeSha, current.command, resolved.error);
    return { hit: { ctx: { ...ctx, runnerResults: [...cachedResults, runnerResultEntry(current, failed, false)] }, full: null, cached: false } };
  }
  const configuredDeadline = config.deadlines_ms?.[state.lane];
  const timeoutMs = Number.isFinite(configuredDeadline) ? configuredDeadline : 30 * 60_000;
  const nonce = randomUUID();
  const createdAt = new Date().toISOString();
  const files = gateSuiteFiles(paths, current.keyR);
  await mkdir(files.dir, { recursive: true });
  await rm(files.artifact, { force: true }).catch(() => {});
  // prose-bound-exempt: destructuring binding of launchGateRunner's return, not a sink
  const { pid, launched, reason } = await launchGateRunner(projectDir, files, {
    run_id: state.run_id,
    nonce,
    cache_key: current.keyR,
    tree_sha: ctx.treeSha,
    plan: resolved.plan,
    timeout_ms: timeoutMs,
    heartbeat_ms: config.gates?.heartbeat_ms ?? GATE_RUNNER_HEARTBEAT_MS,
    created_at: createdAt,
  }, runnerSuiteDir(projectDir, current.root));
  if (!launched) {
    const failed = toolingFailureFull(ctx.treeSha, current.command, reason ?? 'gate runner entry could not be resolved; cannot run the detached merge-gate suite');
    return { hit: { ctx: { ...ctx, runnerResults: [...cachedResults, runnerResultEntry(current, failed, false)] }, full: null, cached: false } };
  }
  // The live watch fields (nonce/cache_key/command/plan/*_file/pid/spawn_attempts/
  // tree_sha) point at the CURRENT runner only; runner_order + runner_index drive
  // the cursor from the PERSISTED set and runner_results accumulates every
  // participating runner (the cache-served greens seed it here).
  return {
    watch: {
      nonce,
      cache_key: current.keyR,
      command: current.command,
      tree_sha: ctx.treeSha,
      plan: resolved.plan,
      timeout_ms: timeoutMs,
      job_file: files.job,
      artifact_file: files.artifact,
      heartbeat_file: files.heartbeat,
      pid,
      host: hostname(),
      spawn_attempts: 1,
      poll_count: 0,
      last_poll_at: null,
      last_summary: null,
      created_at: createdAt,
      runner_order: runnerOrder,
      runner_index: 0,
      runner_results: cachedResults,
      preflight: ctx.watchPreflight,
    },
  };
}

// Start the full merge-gate suite without holding the call. Returns a
// discriminated union the service's run_gates handler reduces on:
//   { hit: { ctx, full, cached } }  evaluate synchronously and transition NOW
//                                   (a suite-cache hit, or an in-call tooling
//                                   failure that must block honestly)
//   { watch: {...} }                the detached suite is running; rest in
//                                   'gating' and persist this as state.gates_watch
export async function startGateSuite(projectDir, paths, state, config, prepared) {
  const ctx = prepared ?? await prepareGateWatchContext(projectDir, paths, state, config);
  const preflight = ctx.preflight;
  if (!preflight.passed) {
    return { hit: { ctx, full: ctx.skippedFull, cached: false } };
  }
  if (ctx.strategy === 'multi') {
    return startGateSuiteMulti(projectDir, paths, state, config, ctx);
  }
  if (ctx.cachedEntry?.passed === true) {
    return { hit: { ctx, full: ctx.cachedEntry, cached: true } };
  }
  // Impacted was rendered to a pre-tokenized invocation in resolveSuiteSelection;
  // build its spawn plan from those argv entries directly (NEVER re-tokenize the
  // rendered display string — a path with spaces would split). Full resolves its
  // plan from the command string exactly as before.
  const resolved = ctx.suiteMode === 'impacted' && ctx.suiteInvocation
    ? { plan: buildSpawnPlan(ctx.suiteInvocation.command, ctx.suiteInvocation.args) }
    : await resolveSuitePlan(projectDir, ctx.suiteCommand);
  if (resolved.error) {
    return { hit: { ctx, full: toolingFailureFull(ctx.treeSha, ctx.suiteCommand, resolved.error), cached: false } };
  }
  // A5: resolve a FINITE armed deadline in the parent — the job must never carry
  // a non-finite timeout, so a hung suite can never pend gating forever.
  const configuredDeadline = config.deadlines_ms?.[state.lane];
  const timeoutMs = Number.isFinite(configuredDeadline) ? configuredDeadline : 30 * 60_000;
  const nonce = randomUUID();
  const createdAt = new Date().toISOString();
  const files = gateSuiteFiles(paths, ctx.cacheKey);
  await mkdir(files.dir, { recursive: true });
  // A1: a fresh watch never adopts a prior run's leftover artifact at this same
  // tree+command path — a REGATE must re-execute. The new nonce is the durable
  // proof (pollGateSuite validates run_id + nonce); clearing the file removes
  // the adoption race up front.
  await rm(files.artifact, { force: true }).catch(() => {});
  // prose-bound-exempt: destructuring binding of launchGateRunner's return, not a sink
  const { pid, launched, reason } = await launchGateRunner(projectDir, files, {
    run_id: state.run_id,
    nonce,
    cache_key: ctx.cacheKey,
    tree_sha: ctx.treeSha,
    plan: resolved.plan,
    timeout_ms: timeoutMs,
    heartbeat_ms: config.gates?.heartbeat_ms ?? GATE_RUNNER_HEARTBEAT_MS,
    created_at: createdAt,
  });
  if (!launched) {
    return { hit: { ctx, full: toolingFailureFull(ctx.treeSha, ctx.suiteCommand, reason ?? 'gate runner entry could not be resolved; cannot run the detached merge-gate suite'), cached: false } };
  }
  return {
    watch: {
      nonce,
      cache_key: ctx.cacheKey,
      command: ctx.suiteCommand,
      tree_sha: ctx.treeSha,
      plan: resolved.plan,
      timeout_ms: timeoutMs,
      job_file: files.job,
      artifact_file: files.artifact,
      heartbeat_file: files.heartbeat,
      pid,
      host: hostname(),
      spawn_attempts: 1,
      poll_count: 0,
      last_poll_at: null,
      last_summary: null,
      created_at: createdAt,
      preflight: ctx.watchPreflight,
    },
  };
}

async function isHeartbeatFresh(heartbeatFile, staleMs = GATE_RUNNER_STALE_MS) {
  if (!heartbeatFile) return false;
  try {
    const info = await stat(heartbeatFile);
    return Date.now() - info.mtimeMs <= staleMs;
  } catch {
    return false;
  }
}

// ONE bounded poll of a resting MULTI (polyglot union) gating run. The cursor
// (runner_order + runner_index) is driven from the PERSISTED watch, never
// recomputed, so one-at-a-time execution is tamper-evident by construction.
// Adopts the CURRENT runner's artifact, appends it to runner_results, then
// either RE-ARMS the same watch for the next uncached runner or, at the last,
// hands the accumulated union to evaluateGates for the AND join.
async function pollGateSuiteMulti(projectDir, paths, state, config, ctx, watch) {
  const runnerOrder = Array.isArray(watch.runner_order) ? watch.runner_order : [];
  const runnerIndex = watch.runner_index ?? 0;
  const currentId = runnerOrder[runnerIndex];
  const current = ctx.participants.find((participant) => participant.id === currentId);
  const currentKeyR = current ? current.keyR : null;
  // Tree binding is absolute (F4/invariant 4): keyR embeds the tree, so ANY
  // mid-sequence drift — or a current runner that vanished from the recomputed
  // set — flips the current runner's keyR vs the watch and fails the WHOLE union
  // closed BEFORE adopting any runner's artifact at the drifted tree. No keyR is
  // persisted then (the deferred cache write is never reached).
  if (currentKeyR !== watch.cache_key) {
    if (ctx.treeSha === watch.tree_sha) {
      return { failed: `the resolved merge-gate runner set changed after the gate suite started (runner ${currentId ?? '?'} selection changed at tree ${ctx.treeSha}); the detached result is bound only to the exact suite it ran, so re-gate to run the now-resolved runners` };
    }
    return { failed: `working tree changed after the gate suite started (started against ${watch.tree_sha}, now ${ctx.treeSha}); the detached result is bound only to the tree it ran on` };
  }
  const artifact = await readJson(watch.artifact_file, null).catch(() => null);
  // A1: adopt ONLY an artifact bound to this run and this watch nonce.
  const artifactValid = Boolean(artifact)
    && typeof artifact === 'object'
    && artifact.run_id === state.run_id
    && artifact.nonce === watch.nonce;
  if (artifactValid) {
    const verification = artifact.verification && typeof artifact.verification === 'object'
      ? artifact.verification
      : { passed: artifact.passed === true, duration_ms: artifact.duration_ms ?? 0 };
    const result = {
      passed: artifact.passed === true,
      tree_sha: ctx.treeSha,
      command: watch.command,
      result_hash: sha256(verification),
      recorded_at: artifact.recorded_at ?? new Date().toISOString(),
      verification,
    };
    const runnerResults = [...(watch.runner_results ?? []), runnerResultEntry(current, result, false)];
    const artifactDurationMs = Number.isFinite(artifact.duration_ms)
      ? artifact.duration_ms
      : Number.isFinite(verification.duration_ms) ? verification.duration_ms : 0;
    // More uncached runners queued → RE-ARM the SAME watch for the next one.
    if (runnerIndex + 1 < runnerOrder.length) {
      const nextId = runnerOrder[runnerIndex + 1];
      const next = ctx.participants.find((participant) => participant.id === nextId);
      if (!next) {
        return { failed: `the next merge-gate runner (${nextId}) is no longer in the resolved runner set; re-gate to run the now-resolved runners` };
      }
      // Disk hygiene: drop the adopted runner's job/heartbeat/artifact.
      await rm(watch.job_file, { force: true }).catch(() => {});
      await rm(watch.heartbeat_file, { force: true }).catch(() => {});
      await rm(watch.artifact_file, { force: true }).catch(() => {});
      const resolved = await resolveRunnerPlan(projectDir, next);
      if (resolved.error) {
        return { failed: `the merge-gate runner ${nextId} command could not be resolved: ${resolved.error}` };
      }
      const nextFiles = gateSuiteFiles(paths, next.keyR);
      await mkdir(nextFiles.dir, { recursive: true });
      await rm(nextFiles.artifact, { force: true }).catch(() => {});
      const nextNonce = randomUUID();
      const nextCreatedAt = new Date().toISOString();
      // prose-bound-exempt: destructuring binding of launchGateRunner's return, not a sink
      const { pid, launched, reason } = await launchGateRunner(projectDir, nextFiles, {
        run_id: state.run_id,
        nonce: nextNonce,
        cache_key: next.keyR,
        tree_sha: ctx.treeSha,
        plan: resolved.plan,
        timeout_ms: watch.timeout_ms,
        heartbeat_ms: config.gates?.heartbeat_ms ?? GATE_RUNNER_HEARTBEAT_MS,
        created_at: nextCreatedAt,
      }, runnerSuiteDir(projectDir, next.root));
      if (!launched) {
        return { failed: reason ?? `gate runner entry could not be resolved for runner ${nextId}; cannot run the detached merge-gate suite` };
      }
      // CRITICAL: service.js SHALLOW-merges poll.pending.watch, so the re-arm must
      // pack the FULLY renewed watch — fresh nonce, next keyR, NEW job/artifact/
      // heartbeat files, advanced cursor, appended runner_results, spawn_attempts
      // reset, new pid. Renewing only pid/spawn_attempts (the respawn shape) would
      // leave the next poll reading the PRIOR runner's artifact_file.
      return {
        pending: {
          // prose-bound-exempt: fixed diagnostic template; ${nextId} is an
          // operator-configured runner id, never agent-authored free text.
          summary: `gate suite advanced to runner ${nextId}`,
          watch: {
            nonce: nextNonce,
            cache_key: next.keyR,
            command: next.command,
            tree_sha: ctx.treeSha,
            plan: resolved.plan,
            timeout_ms: watch.timeout_ms,
            job_file: nextFiles.job,
            artifact_file: nextFiles.artifact,
            heartbeat_file: nextFiles.heartbeat,
            pid,
            host: hostname(),
            spawn_attempts: 1,
            created_at: nextCreatedAt,
            runner_order: runnerOrder,
            runner_index: runnerIndex + 1,
            runner_results: runnerResults,
            preflight: watch.preflight,
          },
        },
      };
    }
    // Last runner adopted → evaluate the union AND join in-call.
    return {
      ready: {
        ctx: { ...ctx, runnerResults },
        full: null,
        cached: false,
        artifact_duration_ms: artifactDurationMs,
      },
    };
  }
  // No adoptable artifact for the CURRENT runner: the A2 respawn fence, scoped to
  // this runner's keyR files, nonce, and plan (never the union's other runners).
  const sameHost = watch.host === hostname();
  if (sameHost && processExists(watch.pid)) {
    return { pending: { summary: 'gate suite still running' } };
  }
  const staleMs = config.gates?.stale_ms ?? GATE_RUNNER_STALE_MS;
  if (await isHeartbeatFresh(watch.heartbeat_file, staleMs)) {
    return { pending: { summary: 'gate suite still running' } };
  }
  const attempts = watch.spawn_attempts ?? 1;
  const maxSpawns = config.gates?.max_spawns ?? GATE_RUNNER_MAX_SPAWNS;
  if (attempts >= maxSpawns) {
    return { failed: `the detached gate runner produced no result within ${attempts} spawn attempts and is not alive; re-gate to retry` };
  }
  const files = gateSuiteFiles(paths, watch.cache_key);
  await rm(watch.artifact_file, { force: true }).catch(() => {});
  // prose-bound-exempt: destructuring binding of launchGateRunner's return, not a sink
  const { pid, launched, reason } = await launchGateRunner(projectDir, files, {
    run_id: state.run_id,
    nonce: watch.nonce,
    cache_key: watch.cache_key,
    tree_sha: watch.tree_sha,
    plan: watch.plan,
    timeout_ms: watch.timeout_ms,
    heartbeat_ms: config.gates?.heartbeat_ms ?? GATE_RUNNER_HEARTBEAT_MS,
    created_at: watch.created_at,
  }, runnerSuiteDir(projectDir, current.root));
  if (!launched) {
    return { failed: reason ?? 'gate runner entry could not be resolved; cannot respawn the detached merge-gate suite' };
  }
  return {
    pending: {
      summary: 'respawned the detached gate runner',
      watch: { pid, host: hostname(), spawn_attempts: attempts + 1 },
    },
  };
}

// ONE bounded poll of a resting gating run. Returns a discriminated union:
//   { ready: { ctx, full, cached, artifact_duration_ms } }  artifact adopted;
//        the caller evaluates the remaining checks in-call and transitions
//   { pending: { summary, watch? } }  still running (or respawned); rest, record
//        the cursor, and optionally persist the respawn's renewed watch fields
//   { failed: <reason> }  tree drift or an exhausted/dead runner — block honestly
export async function pollGateSuite(projectDir, paths, state, config, prepared) {
  const watch = state.gates_watch;
  if (!watch) throw new Error('pollGateSuite requires a persisted gates_watch');
  prepared ??= await prepareGatePollContext(projectDir, paths, state, config);
  if (watch.preflight && watch.preflight.key !== prepared.preflightKey) {
    return { failed: 'the resolved merge-gate preflight changed after the gate suite started; re-gate to verify the current targeted-test and policy configuration' };
  }
  const ctx = watch.preflight ? { ...prepared, preflight: watch.preflight } : prepared;
  if (ctx.strategy === 'multi') {
    return pollGateSuiteMulti(projectDir, paths, state, config, ctx, watch);
  }
  // Tree binding is absolute (F4): the detached result is valid ONLY for the
  // tree it started against. Any drift since start invalidates it fail-closed.
  // The cache key binds BOTH the tree and the resolved suite, so a mismatch is
  // one of two drifts — distinguished for an honest block reason: the tree moved
  // (the classic F4 case), or the suite RESOLUTION changed at the same tree (an
  // impacted↔full flip, e.g. shipping.required_remote_checks toggled mid-watch —
  // D6), whose recomputed cache key no longer matches the impacted watch key.
  if (ctx.cacheKey !== watch.cache_key) {
    if (ctx.treeSha === watch.tree_sha) {
      return { failed: `the resolved merge-gate suite changed after the gate suite started (impacted/full selection changed at tree ${ctx.treeSha}); the detached result is bound only to the exact suite it ran, so re-gate to run the now-resolved suite` };
    }
    return { failed: `working tree changed after the gate suite started (started against ${watch.tree_sha}, now ${ctx.treeSha}); the detached result is bound only to the tree it ran on` };
  }
  const artifact = await readJson(watch.artifact_file, null).catch(() => null);
  // A1: adopt ONLY an artifact bound to this run and this watch nonce; a foreign
  // leftover (a prior run at the same tree+command) is never a pass.
  const artifactValid = Boolean(artifact)
    && typeof artifact === 'object'
    && artifact.run_id === state.run_id
    && artifact.nonce === watch.nonce;
  if (artifactValid) {
    const verification = artifact.verification && typeof artifact.verification === 'object'
      ? artifact.verification
      : { passed: artifact.passed === true, duration_ms: artifact.duration_ms ?? 0 };
    const full = {
      passed: artifact.passed === true,
      tree_sha: ctx.treeSha,
      command: ctx.suiteCommand,
      result_hash: sha256(verification),
      recorded_at: artifact.recorded_at ?? new Date().toISOString(),
      verification,
    };
    return {
      ready: {
        ctx,
        full,
        cached: false,
        // N-d: only a Number.isFinite duration accumulates into timing.test_ms.
        // A crafted non-numeric duration_ms on EITHER slot (artifact or
        // verification) must not NaN-poison timing — fall through to 0.
        artifact_duration_ms: Number.isFinite(artifact.duration_ms)
          ? artifact.duration_ms
          : Number.isFinite(verification.duration_ms)
            ? verification.duration_ms
            : 0,
      },
    };
  }
  // No adoptable artifact: the A2 respawn fence. A live same-host pid VETOES a
  // respawn even with a stale heartbeat (mirror lock.js:292 — EPERM counts as
  // alive). Otherwise a bounded respawn is authorized only when the recorded pid
  // is not provably alive AND the heartbeat is absent or stale.
  const sameHost = watch.host === hostname();
  if (sameHost && processExists(watch.pid)) {
    return { pending: { summary: 'gate suite still running' } };
  }
  const staleMs = config.gates?.stale_ms ?? GATE_RUNNER_STALE_MS;
  if (await isHeartbeatFresh(watch.heartbeat_file, staleMs)) {
    return { pending: { summary: 'gate suite still running' } };
  }
  const attempts = watch.spawn_attempts ?? 1;
  const maxSpawns = config.gates?.max_spawns ?? GATE_RUNNER_MAX_SPAWNS;
  if (attempts >= maxSpawns) {
    return { failed: `the detached gate runner produced no result within ${attempts} spawn attempts and is not alive; re-gate to retry` };
  }
  // Respawn a fresh runner for the SAME watch (nonce preserved so its artifact
  // still validates); renew pid + spawn_attempts for the caller to persist.
  const files = gateSuiteFiles(paths, ctx.cacheKey);
  await rm(watch.artifact_file, { force: true }).catch(() => {});
  // prose-bound-exempt: destructuring binding of launchGateRunner's return, not a sink
  const { pid, launched, reason } = await launchGateRunner(projectDir, files, {
    run_id: state.run_id,
    nonce: watch.nonce,
    cache_key: watch.cache_key,
    tree_sha: watch.tree_sha,
    plan: watch.plan,
    timeout_ms: watch.timeout_ms,
    heartbeat_ms: config.gates?.heartbeat_ms ?? GATE_RUNNER_HEARTBEAT_MS,
    created_at: watch.created_at,
  });
  if (!launched) {
    return { failed: reason ?? 'gate runner entry could not be resolved; cannot respawn the detached merge-gate suite' };
  }
  return {
    pending: {
      summary: 'respawned the detached gate runner',
      watch: { pid, host: hostname(), spawn_attempts: attempts + 1 },
    },
  };
}


