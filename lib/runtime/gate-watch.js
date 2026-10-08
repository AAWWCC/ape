import { localExecutionIdentity } from './host-identity.js';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sha256 } from './canonical.js';
import { boundedGateSummary } from './bounded-summary.js';
import {
  GATE_RUNNER_HEARTBEAT_MS,
  GATE_RUNNER_MAX_SPAWNS,
  GATE_SUITE_TEMP_SWEEP_SCAN_CAP,
  GATE_SUITE_TEMP_SWEEP_STALE_MS,
} from './constants.js';
import { buildSpawnPlan, detectTestRunner, GATE_RUNNER_SENTINEL, splitCommand } from './runner.js';
import { atomicWriteJson } from './storage.js';
import { spawnDetached, readGateOwnership, queryGateBroker } from './spawn.js';
import { gateOwnershipPath, gateGenerationFiles, inspectGateOwnership, reserveGateOwnership, retireInvalidatedGate, gateProducersComplete, drainGateCleanup, markGateConsumed } from './gate-launch-ownership.js';
import { prepareGatePollContext, prepareGateWatchContext } from './gate-evaluation.js';


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
// `watch.host !== localExecutionIdentity()`; it may then respawn once the heartbeat itself
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
    if (!command) return { error: 'Configured full-suite command must contain an executable.' };
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
  if (!entry) return { launched: false, reason: 'gate runner entry could not be resolved; cannot run the detached merge-gate suite' };
  await mkdir(files.dir, { recursive: true });
  await sweepStaleGateSuiteTemps(files.dir).catch(() => {});
  const job = { version: 1, heartbeat_ms: GATE_RUNNER_HEARTBEAT_MS, ...jobFields,
    project_dir: realpathSync(projectDir), suite_cwd: suiteDir, artifact_file: files.artifact,
    heartbeat_file: files.heartbeat, host: localExecutionIdentity() };
  const noStart = async () => {
    const record = await readGateOwnership(job.ownership_file);
    if (record.phase === 'reserved' && record.generation === job.nonce) {
      await atomicWriteJson(job.ownership_file, { ...record, phase: 'no-start' });
    }
  };
  try { await atomicWriteJson(files.job, job); }
  catch (error) {
    await noStart().catch(() => {});
    return { launched: false, reason: boundedGateSummary(`gate-suite job descriptor write failed (${error?.code ?? 'unknown error'}): ${error?.message ?? String(error)}`) };
  }
  const child = spawnDetached(process.execPath, [entry, GATE_RUNNER_SENTINEL], {
    cwd: projectDir, ipc: true, env: { APE_GATE_RUNNER_JOB: files.job },
  });
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => { if (settled) return; settled = true; clearTimeout(timer); resolve(value); };
    const timer = setTimeout(() => {
      if (child.connected) child.disconnect();
      finish({ launched: false, reason: 'gate runner registration timed out; ownership retained' });
    }, 30000);
    child.once('error', async (error) => {
      await noStart().catch(() => {});
      finish({ launched: false, reason: boundedGateSummary(`gate runner process could not start (${(/** @type {any} */ (error))?.code ?? 'unknown'})`) });
    });
    child.once('exit', () => finish({ launched: false, reason: 'gate runner exited before registration; ownership retained' }));
    child.on('message', async (input) => {
      const message = /** @type {any} */ (input);
      if (settled || message?.type !== 'registered' || message.generation !== job.nonce) return;
      try {
        const record = await readGateOwnership(job.ownership_file);
        const broker = await queryGateBroker(record);
        if (!broker || broker.watch.pid !== child.pid || broker.generation !== job.nonce) throw new Error('registration authentication failed');
        child.send({ type: 'execute', generation: job.nonce }, (error) => {
          if (error) finish({ launched: false, reason: 'gate execution permission could not be delivered; ownership retained' });
          else finish({ launched: true, pid: child.pid, watch: broker.watch });
        });
      } catch {
        if (child.connected) child.disconnect();
        finish({ launched: false, reason: 'gate registration could not be authenticated; ownership retained' });
      }
    });
  });
}

async function launchOwnedWatch(projectDir, paths, state, config, ctx, command, plan, extra = {}, suiteDir = projectDir) {
  if (!resolveRunnerEntry()) return { blocked: 'gate runner entry could not be resolved; cannot run the detached merge-gate suite' };
  const nonce = randomUUID();
  const files = gateGenerationFiles(paths, nonce);
  const timeoutMs = Number.isFinite(config.deadlines_ms?.[state.lane]) ? config.deadlines_ms[state.lane] : 30 * 60000;
  const watch = { nonce, generation: nonce, ownership_file: gateOwnershipPath(paths, state.run_id),
    cache_key: ctx.cacheKey, command, tree_sha: ctx.treeSha, plan, timeout_ms: timeoutMs,
    job_file: files.job, artifact_file: files.artifact, heartbeat_file: files.heartbeat,
    pid: null, host: localExecutionIdentity(), spawn_attempts: 1, poll_count: 0, last_poll_at: null,
    last_summary: null, created_at: new Date().toISOString(), preflight: ctx.watchPreflight, ...extra };
  try {
    await reserveGateOwnership(projectDir, paths, state, watch);
  } catch (error) {
    return { blocked: `gate ownership reservation failed (${error?.code ?? 'unknown'}); no runner was launched` };
  }
  const result = await launchGateRunner(projectDir, files, {
    run_id: state.run_id, nonce, cache_key: watch.cache_key, tree_sha: watch.tree_sha,
    plan, timeout_ms: watch.timeout_ms, created_at: watch.created_at,
    ownership_file: watch.ownership_file, heartbeat_ms: config.gates?.heartbeat_ms ?? GATE_RUNNER_HEARTBEAT_MS,
  }, suiteDir);
  if (!result.launched) return { blocked: result.reason };
  return { watch: result.watch };
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
    : await resolveSuitePlan(runnerSuiteDir(projectDir, participant.root), participant.command);
}

// MULTI strategy start: launch ONLY the first uncached participating runner and
// rest in the gating watch; the rest run one at a time as pollGateSuite adopts
// each and re-arms the same watch. An all-cached-green union returns a
// synchronous all-pass hit; an orphan block returns a synchronous fail-closed
// hit having launched NO runner suite.
async function startGateSuiteMulti(projectDir, paths, state, config, ctx) {
  if (ctx.blocked) return { hit: { ctx: { ...ctx, runnerResults: [] }, full: null, cached: false } };
  const cachedResults = [], uncached = [];
  for (const participant of ctx.participants) {
    if (participant.cachedEntry?.passed === true) cachedResults.push(runnerResultEntry(participant, participant.cachedEntry, true));
    else uncached.push(participant);
  }
  const runnerOrder = uncached.map((p) => p.id).sort();
  if (!runnerOrder.length) return { hit: { ctx: { ...ctx, runnerResults: cachedResults }, full: null, cached: true } };
  const current = uncached.find((p) => p.id === runnerOrder[0]);
  const resolved = await resolveRunnerPlan(projectDir, current);
  if (resolved.error) {
    const failed = toolingFailureFull(ctx.treeSha, current.command, resolved.error);
    return { hit: { ctx: { ...ctx, runnerResults: [...cachedResults, runnerResultEntry(current, failed, false)] }, full: null, cached: false } };
  }
  const started = await launchOwnedWatch(projectDir, paths, state, config, ctx, current.command, resolved.plan, {
    cache_key: current.keyR, runner_order: runnerOrder, runner_index: 0, runner_results: cachedResults,
  }, runnerSuiteDir(projectDir, current.root));
  if (started.watch) return started;
  const failed = toolingFailureFull(ctx.treeSha, current.command, started.blocked);
  return { hit: { ctx: { ...ctx, runnerResults: [...cachedResults, runnerResultEntry(current, failed, false)] }, full: null, cached: false } };
}

export async function startGateSuite(projectDir, paths, state, config, prepared) {
  // Reconciliation precedes preflight execution and every cache shortcut.
  await drainGateCleanup(paths, state);
  const ownership = await inspectGateOwnership(projectDir, paths, state);
  if (ownership.blocked) return { blocked: ownership.blocked };
  if (ownership.proof?.cleanup?.status === 'unknown') {
    return { blocked: boundedGateSummary(`gate descendant retirement is unknown; ownership retained: ${ownership.proof.cleanup.cause}`) };
  }
  if (ownership.watch && !ownership.retired) {
    const previousAttempt = ownership.record.state_fields;
    const sameAttempt = (previousAttempt.regate_attempts ?? 0) === (state.regate_attempts ?? 0) &&
      previousAttempt.ship_requested === (state.ship_requested === true);
    const retryRetired = ownership.proof?.cleanup?.status === 'confirmed' && ownership.proof?.retry === true;
    if (ownership.record.invalidation || sameAttempt || (!gateProducersComplete(ownership.proof) && !retryRetired)) return { watch: ownership.watch };
    // An explicitly advanced audited attempt may retire a proven prior one.
    await markGateConsumed(paths, state, ownership.record);
  }
  const ctx = prepared ?? await prepareGateWatchContext(projectDir, paths, state, config);
  if (!ctx.preflight.passed) return { hit: { ctx, full: ctx.skippedFull, cached: false } };
  if (ctx.strategy === 'multi') return startGateSuiteMulti(projectDir, paths, state, config, ctx);
  if (ctx.cachedEntry?.passed === true) return { hit: { ctx, full: ctx.cachedEntry, cached: true } };
  const resolved = ctx.suiteMode === 'impacted' && ctx.suiteInvocation
    ? { plan: buildSpawnPlan(ctx.suiteInvocation.command, ctx.suiteInvocation.args) }
    : await resolveSuitePlan(projectDir, ctx.suiteCommand);
  if (resolved.error) return { hit: { ctx, full: toolingFailureFull(ctx.treeSha, ctx.suiteCommand, resolved.error), cached: false } };
  const started = await launchOwnedWatch(projectDir, paths, state, config, ctx, ctx.suiteCommand, resolved.plan);
  return started.watch ? started : { hit: { ctx, full: toolingFailureFull(ctx.treeSha, ctx.suiteCommand, started.blocked), cached: false } };
}

// A result and its containment proof are distinct inputs. Only the broker's
// signed proof can authorize consumption, cursor advancement or replacement.
export async function pollGateSuite(projectDir, paths, state, config, prepared) {
  await drainGateCleanup(paths, state);
  const watch = state.gates_watch;
  if (!watch) throw new Error('pollGateSuite requires a persisted gates_watch');
  if (!watch.ownership_file || !watch.generation) {
    return { failed: 'legacy gate ownership identity has no descendant-retirement proof; ownership is retained and explicit recovery is required' };
  }
  const ownership = await inspectGateOwnership(projectDir, paths, state, watch);
  if (ownership.identity_problem) return { failed: boundedGateSummary(ownership.blocked) };
  if (ownership.retired || (!ownership.watch && !ownership.record?.watch)) {
    return { pending: { summary: boundedGateSummary(ownership.blocked ?? 'gate ownership is unavailable; retirement is unknown') } };
  }
  // A completed broker cannot produce another proof. Fail closed before any
  // retry, cache acceptance or runner advancement, preserving the reservation.
  if (ownership.proof?.cleanup?.status === 'unknown') {
    return { failed: boundedGateSummary(`gate descendant retirement is unknown; ownership retained: ${ownership.proof.cleanup.cause}`) };
  }
  const previousAttempt = ownership.record.state_fields;
  const advancedAttempt = (previousAttempt.regate_attempts ?? 0) !== (state.regate_attempts ?? 0) ||
    previousAttempt.ship_requested !== (state.ship_requested === true);
  if (ownership.record.invalidation) {
    return retireInvalidatedGate(projectDir, paths, state, ownership, ownership.record.invalidation.reason);
  }
  // Resolve the old attempt when reconciling an audited retry. Configuration
  // and tree drift must still cancel that generation before replacement.
  prepared ??= await prepareGatePollContext(projectDir, paths, { ...state, ...previousAttempt }, config);
  let invalidation = null;
  if (watch.preflight && watch.preflight.key !== prepared.preflightKey) {
    invalidation = 'the resolved merge-gate preflight changed after the gate suite started; re-gate to verify the current targeted-test and policy configuration';
  }
  const ctx = watch.preflight ? { ...prepared, preflight: watch.preflight } : prepared;
  const multi = ctx.strategy === 'multi';
  const current = multi ? ctx.participants.find((p) => p.id === watch.runner_order?.[watch.runner_index ?? 0]) : null;
  const key = multi ? current?.keyR : ctx.cacheKey;
  if (!invalidation && key !== watch.cache_key) {
    invalidation = ctx.treeSha === watch.tree_sha
      ? 'the resolved merge-gate suite changed after the gate suite started; re-gate to run the now-resolved suite'
      : `working tree changed after the gate suite started (started against ${watch.tree_sha}, now ${ctx.treeSha}); the detached result is bound only to the tree it ran on`;
  }
  if (invalidation) return retireInvalidatedGate(projectDir, paths, state, ownership, invalidation);
  if (ownership.blocked || !ownership.watch) {
    return { pending: { summary: boundedGateSummary(ownership.blocked ?? 'gate ownership is unavailable; retirement is unknown') } };
  }
  if (ownership.unstarted) {
    const files = gateGenerationFiles(paths, watch.nonce);
    const started = await launchGateRunner(projectDir, files, {
      run_id: state.run_id, nonce: watch.nonce, cache_key: watch.cache_key,
      tree_sha: watch.tree_sha, plan: watch.plan, timeout_ms: watch.timeout_ms,
      created_at: watch.created_at, ownership_file: watch.ownership_file,
      heartbeat_ms: config.gates?.heartbeat_ms ?? GATE_RUNNER_HEARTBEAT_MS,
    }, multi ? runnerSuiteDir(projectDir, current.root) : projectDir);
    return started.launched ? { pending: { summary: 'launched the durably reserved gate runner', watch: started.watch } }
      : { failed: started.reason };
  }
  if (advancedAttempt) {
    // An audited retry may wait on an earlier attempt whose resolved command
    // is no longer current. Do not reject that old watch again or overlap it:
    // reconcile its retirement before resolving and launching the new attempt.
    const retryRetired = ownership.proof?.cleanup?.status === 'confirmed' && ownership.proof?.retry === true;
    if (!gateProducersComplete(ownership.proof) && !retryRetired) {
      return { pending: { summary: 'waiting for prior gate descendant retirement before the audited retry' } };
    }
    const restarted = await startGateSuite(projectDir, paths, state, config);
    if (restarted.watch) return { pending: { summary: 'started the audited gate retry after confirmed retirement', watch: restarted.watch } };
    if (restarted.hit) return { ready: restarted.hit };
    return { failed: restarted.blocked };
  }
  const proof = ownership.proof;
  if (proof?.cleanup?.status !== 'confirmed') {
    return { pending: { summary: boundedGateSummary(proof ? 'gate descendant retirement is unknown; ownership retained' : 'gate suite still running') } };
  }
  if (proof.retry) {
    const attempts = watch.spawn_attempts ?? 1;
    if (attempts >= (config.gates?.max_spawns ?? GATE_RUNNER_MAX_SPAWNS)) {
      return { failed: `the detached gate runner produced no result within ${attempts} spawn attempts; confirmed retirement allows a re-gate` };
    }
    const restarted = await launchOwnedWatch(projectDir, paths, state, config, ctx, watch.command, watch.plan, {
      cache_key: watch.cache_key, spawn_attempts: attempts + 1, preflight: watch.preflight,
      ...(multi ? { runner_order: watch.runner_order, runner_index: watch.runner_index, runner_results: watch.runner_results } : {}),
    }, multi ? runnerSuiteDir(projectDir, current.root) : projectDir);
    return restarted.watch ? { pending: { summary: 'respawned the retired detached gate runner', watch: restarted.watch } }
      : { failed: restarted.blocked };
  }
  if (!gateProducersComplete(proof)) {
    return { pending: { summary: 'waiting for authenticated result publication and heartbeat drain' } };
  }
  const artifact = proof.artifact;
  if (!artifact || artifact.run_id !== state.run_id || artifact.nonce !== watch.nonce || artifact.cache_key !== watch.cache_key) {
    return { pending: { summary: 'gate completion proof does not bind an admissible result' } };
  }
  const verification = artifact.verification;
  const full = { passed: artifact.passed === true, tree_sha: ctx.treeSha, command: watch.command,
    result_hash: sha256(verification), recorded_at: artifact.recorded_at, verification };
  const duration = Number.isFinite(artifact.duration_ms) ? artifact.duration_ms : 0;
  if (!multi) return { ready: { ctx, full, cached: false, artifact_duration_ms: duration } };
  const results = [...(watch.runner_results ?? []), runnerResultEntry(current, full, false)];
  const nextIndex = (watch.runner_index ?? 0) + 1;
  if (nextIndex >= watch.runner_order.length) {
    return { ready: { ctx: { ...ctx, runnerResults: results }, full: null, cached: false, artifact_duration_ms: duration } };
  }
  const nextId = watch.runner_order[nextIndex];
  const next = ctx.participants.find((p) => p.id === nextId);
  if (!next) return { failed: 'the next merge-gate runner is no longer in the resolved runner set' };
  const resolved = await resolveRunnerPlan(projectDir, next);
  if (resolved.error) return { failed: `the merge-gate runner ${nextId} command could not be resolved: ${resolved.error}` };
  // The reservation contains the consumed cursor/results before the next
  // child can execute. Neither state sink is required to have caught up yet.
  const advanced = await launchOwnedWatch(projectDir, paths, state, config, ctx, next.command, resolved.plan, {
    cache_key: next.keyR, runner_order: watch.runner_order, runner_index: nextIndex,
    runner_results: results, preflight: watch.preflight,
  }, runnerSuiteDir(projectDir, next.root));
  return advanced.watch ? { pending: { summary: boundedGateSummary(`gate suite advanced to runner ${nextId}`), watch: advanced.watch } }
    : { failed: advanced.blocked };
}
