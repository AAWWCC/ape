import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { hostname } from 'node:os';

const DEFAULT_KILL_GRACE_MS = 10_000;
const DEFAULT_DRAIN_MS = 5_000;

// Force-kill the child's entire process tree. A bare child.kill() reaches only
// the direct child: test suites and remote-check watchers routinely fan out
// grandchildren (npm -> vitest -> dev server) that survive it and keep running.
// POSIX children are spawned detached — each is its own process-group leader —
// so signalling -pid reaches every descendant that has not re-detached itself.
// win32 has no signal-able process groups: taskkill /T /F walks the tree by
// pid and force-terminates it (D1); if taskkill itself cannot run, the direct
// child is terminated so its 'exit' event still fires.
function killTree(child, signal) {
  if (process.platform !== 'win32') {
    try {
      process.kill(-child.pid, signal);
    } catch {
      // Group already reaped (or never became signalable): fall back to the
      // direct child handle so a lone straggler still dies.
      try { child.kill(signal); } catch { /* already gone */ }
    }
    return;
  }
  let killer = null;
  try {
    killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
  } catch { /* fall through to the direct kill below */ }
  if (killer) {
    killer.on('error', () => { try { child.kill(); } catch { /* gone */ } });
  } else {
    try { child.kill(); } catch { /* gone */ }
  }
}

// Bounded process execution shared by every runtime spawn site (test suites,
// merge-gate commands, git plumbing). The per-site pattern it replaces — one
// SIGTERM on timeout, resolve only on 'close' — had two liveness holes, both
// fatal inside the receipt-effects lock where a parked promise starves abort,
// override, and next until the host process dies:
//   1. a child that traps SIGTERM (or a win32 tree whose grandchildren never
//      receive it) simply keeps running;
//   2. 'close' waits for the stdio pipes to drain, so a grandchild that
//      inherited them keeps the promise pending even after the child exited.
// This helper always settles and never rejects — every failure mode is a
// field on the resolved result.
//
// Options: cwd, shell, env (merged over process.env only when provided),
// timeout_ms (callers own their defaults; no timer is armed without one),
// kill_grace_ms (SIGTERM -> SIGKILL escalation window), drain_ms (post-exit
// stdio wait), collect ('combined' default | 'separate'), max_output
// (combined only; checked before append, so output overshoots by at most one
// pipe chunk — byte-identical to the historical runner cap).
//
// Result: { exit_code, signal, timed_out, stdout, stderr, combined,
// spawn_error }. timed_out is true only when the timeout fired and initiated
// the kill. Callers whose results feed sha256 hashes must translate it to an
// absent-when-false field so every non-timeout hash stays byte-identical.
export function spawnWithTimeout(command, args, options = {}) {
  const killGraceMs = options.kill_grace_ms ?? DEFAULT_KILL_GRACE_MS;
  const drainMs = options.drain_ms ?? DEFAULT_DRAIN_MS;
  const combinedMode = options.collect !== 'separate';
  const maxOutput = options.max_output;
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args ?? [], {
        cwd: options.cwd,
        shell: options.shell ?? false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        // POSIX: make the child a process-group leader so the timeout can
        // signal the whole tree at once. Never detach on win32 — taskkill
        // walks the tree by pid there instead. A caller may force detached:false
        // to keep the child in its OWN process group (the gate runner does this
        // so an ABORT that signals the runner's group also reaches the suite —
        // A6), at the cost of the timeout's group tree-kill degrading to a
        // direct-child kill (fine for the single-process suites this covers).
        detached: options.detached ?? process.platform !== 'win32',
        ...(options.env ? { env: { ...process.env, ...options.env } } : {}),
      });
    } catch (error) {
      resolve({
        exit_code: null, signal: null, timed_out: false,
        stdout: '', stderr: '', combined: '', spawn_error: error,
      });
      return;
    }
    let stdout = '';
    let stderr = '';
    let combined = '';
    let timedOut = false;
    // Whether the timeout's force-kill has already been delivered to the tree.
    // Exactly one of the escalate callback and the 'exit' handler below may
    // deliver it; a second one would double-signal the group.
    let escalated = false;
    let exitInfo = null;
    let settled = false;
    let timeoutTimer = null;
    let escalateTimer = null;
    let failsafeTimer = null;
    let drainTimer = null;

    const settle = (spawnError = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(escalateTimer);
      clearTimeout(failsafeTimer);
      clearTimeout(drainTimer);
      resolve({
        exit_code: exitInfo?.code ?? null,
        signal: exitInfo?.signal ?? null,
        timed_out: timedOut,
        stdout,
        stderr,
        combined,
        spawn_error: spawnError,
      });
    };
    const collect = (chunk, stream) => {
      if (combinedMode) {
        // The cap is checked before the append (never mid-chunk), preserving
        // the historical overshoot-by-at-most-one-chunk cap semantics.
        if (maxOutput === undefined || combined.length < maxOutput) combined += chunk;
      } else if (stream === 'stdout') {
        stdout += chunk;
      } else {
        stderr += chunk;
      }
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => collect(chunk, 'stdout'));
    child.stderr.on('data', (chunk) => collect(chunk, 'stderr'));

    // Arm the deadline for any finite number a caller provided (setTimeout
    // clamps degenerate values to "immediately", which fails closed: a
    // nonsense deadline must never mean "no deadline"). Only an absent
    // timeout_ms leaves the timer unarmed — setTimeout with an undefined
    // delay would fire on the next tick and brand everything timed_out.
    if (Number.isFinite(options.timeout_ms)) {
      timeoutTimer = setTimeout(() => {
        // The child can exit in the same tick the timer fires; a verdict that
        // beat the deadline must not be branded timed_out.
        if (child.exitCode !== null || child.signalCode !== null) return;
        timedOut = true;
        killTree(child, 'SIGTERM');
        escalateTimer = setTimeout(() => {
          // Both branches below force-kill, so the escalation is spent either
          // way and the 'exit' handler must not repeat it.
          escalated = true;
          if (process.platform !== 'win32') {
            killTree(child, 'SIGKILL');
          } else {
            // taskkill /F already force-killed; this only matters when
            // taskkill itself failed to act.
            try { child.kill(); } catch { /* gone */ }
          }
          // Last-resort liveness: if even the forced kill produces no 'exit'
          // (win32 taskkill denied, or a child stuck in uninterruptible
          // sleep), settle anyway with what we have — a timed-out result must
          // never park the receipt lock behind an unkillable process. unref
          // so the zombie handle cannot pin the host process either.
          failsafeTimer = setTimeout(() => {
            child.stdout?.destroy();
            child.stderr?.destroy();
            child.unref?.();
            settle();
          }, killGraceMs);
        }, killGraceMs);
      }, options.timeout_ms);
    }

    child.on('error', (error) => {
      // Spawn failures (ENOENT and friends) may never emit 'exit'.
      settle(error);
    });
    child.on('exit', (code, signal) => {
      exitInfo = { code, signal };
      // An OWED escalation is DELIVERED here rather than dropped. The direct
      // child routinely dies on the polite group SIGTERM (sh, npm and vitest
      // all do) while a DESCENDANT ignores or slow-walks it; settle() then
      // clears escalateTimer — on the shipped defaults the drain deadline
      // lands 5s BEFORE the escalate deadline — so the only force-kill that
      // ever reaches that descendant would be LOST, not merely late, and it
      // would survive to keep writing the project tree. Delivering it at the
      // exit instant is safe because POSIX keeps a pid NUMBER allocated while
      // it is still in use as an active process-group id: kill(-pid) can
      // only miss the original group once that group is EMPTY, exactly when
      // there is nothing left to kill and the ESRCH is harmless.
      if (timedOut && !escalated) {
        escalated = true;
        // win32 is never owed one: killTree's polite step there is ALREADY
        // `taskkill /T /F` on the whole tree, and node closes the process
        // handle before emitting 'exit', so a second taskkill here would
        // target a pid Windows may have already reused.
        if (process.platform !== 'win32') killTree(child, 'SIGKILL');
      }
      // The process is dead; the deadline, the escalation and the forced-kill
      // failsafe no longer apply. drainTimer is deliberately left armed — it
      // is what settles this promise.
      clearTimeout(timeoutTimer);
      clearTimeout(escalateTimer);
      clearTimeout(failsafeTimer);
      // 'close' can lag 'exit' indefinitely: a grandchild that inherited the
      // stdio pipes holds them for its whole lifetime. Wait a bounded drain
      // window for trailing output, then destroy our read ends and settle —
      // a pipe-holding grandchild must never park this promise.
      drainTimer = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        settle();
      }, drainMs);
    });
    child.on('close', (code, signal) => {
      exitInfo = { code, signal };
      settle();
    });
  });
}

// Spawn a fire-and-forget detached child that OUTLIVES the parent MCP call: the
// gate-suite runner keeps executing after `ape_run` returns, and a later poll
// reads its artifact. detached:true makes it a new session/process-group leader
// on POSIX (so it survives the parent exiting AND an ABORT can signal its whole
// group by -pid); stdio:'ignore' means no inherited pipe keeps either process
// alive; unref() lets the parent event loop exit without waiting on it. On win32
// the recorded pid is walked by `taskkill /T` for the same tree kill. env, when
// provided, is merged over process.env exactly like spawnWithTimeout. Returns the
// child handle so the caller can record child.pid for the respawn fence and the
// abort kill; a spawn fault surfaces asynchronously on the ignored child and is
// tolerated (the poll's respawn fence recovers a runner that never started).
export function spawnDetached(command, args, options = {}) {
  const child = spawn(command, args ?? [], {
    cwd: options.cwd,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    ...(options.env ? { env: { ...process.env, ...options.env } } : {}),
  });
  retainDetachedChild(child);
  child.unref();
  return child;
}

// `unref()` removes the detached runner from the event-loop liveness decision,
// but it must not also make its ChildProcess handle collectible while this MCP
// process is still alive. On Linux containers in particular, dropping that
// handle can leave a killed runner visible as an unreaped zombie until pid 1
// eventually collects it. A cancellation could then publish `cancelled` while
// `kill(pid, 0)` still reported the exact attributed runner as present.
//
// Retain only runners spawned by this module, keyed by their exact pid, and
// release each handle as soon as Node observes its exit. This registry is NOT
// kill authorization: the persisted heartbeat/host/age checks below remain the
// sole authority to signal. It only lets an already-authorized kill wait for
// the launcher's own waitpid/exit observation before returning.
const detachedChildren = new Map();

function retainDetachedChild(child) {
  if (!Number.isInteger(child?.pid) || child.pid <= 1) return;
  const pid = child.pid;
  let settle;
  const exited = new Promise((resolve) => { settle = resolve; });
  const record = { child, exited };
  detachedChildren.set(pid, record);
  const release = () => {
    if (detachedChildren.get(pid) === record) detachedChildren.delete(pid);
    settle();
  };
  child.once('exit', release);
  // A spawn error has no process left for this handle to reap. Listening also
  // keeps the fire-and-forget helper's asynchronous error path non-fatal.
  child.once('error', release);
}

// A heartbeat older than this no longer attests that the recorded pid is still
// OUR gate runner. DELIBERATE DUPLICATE of GATE_RUNNER_STALE_MS in
// ./constants.js, kept as a CONVENTION and NOT as a technical necessity —
// importing it would not in fact break the unbundled runner, because gates.js
// resolveRunnerEntry always spawns the SOURCE lib/runtime/runner.js and
// constants.js is an import-free leaf that is always a resolvable sibling of the
// entry that actually runs. What the duplication buys is the posture runner.js
// states for itself: its runtime-module imports are pinned to ./spawn.js alone,
// so keeping spawn.js to node BUILTINS ONLY (the one non-builtin-free addition
// here is node:fs/promises) holds the detached runner's whole dependency surface
// to one file that can be audited by inspection.
// __tests__/runtime-v2-kill-process-tree-stale-pid.test.js arm A7 pins the two
// values equal, so the duplicate cannot drift silently.
export const KILL_IDENTITY_STALE_MS = 30_000;

// How much longer than its own armed deadline a runner could still plausibly be
// alive. spawnWithTimeout's bounded shutdown is 2 * DEFAULT_KILL_GRACE_MS +
// DEFAULT_DRAIN_MS = 25s; the rest is margin for the artifact write and host
// scheduling.
const RUNNER_LIFETIME_SLACK_MS = 60_000;

// The escalation's poll delay. Deliberately NOT unref'd — that is the exact
// reversal of the unref'd `setTimeout(() => signalGroup('SIGKILL'), ...)` this
// replaced, which was wrong in both directions at once: a short-lived process
// that returned before the grace elapsed DROPPED the force-kill entirely (a
// SIGTERM-ignoring suite then survived the abort), and when it did fire it fired
// blind at a group that may have emptied and been recycled meanwhile. The caller
// awaits this sleep, so the escalation is owed AND delivered inside the call,
// and no timer can outlive it.
function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

// Wait only for a runner this exact module instance launched. The bound keeps
// abort/cancellation from parking forever on an uninterruptible kernel task;
// ordinary SIGTERM/SIGKILL exits resolve through ChildProcess's waitpid-backed
// `exit` event and clear the timer immediately.
async function awaitOwnedDetachedExit(pid, maxWaitMs = DEFAULT_DRAIN_MS) {
  const record = detachedChildren.get(pid);
  if (!record) return;
  const waitMs = Math.max(1, Number.isFinite(maxWaitMs) ? maxWaitMs : DEFAULT_DRAIN_MS);
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, waitMs);
    record.exited.then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

// Liveness probes. process.kill(target, 0) delivers NOTHING; it only asks the
// kernel whether the target exists and is signalable by us. Any error answers
// "do not signal": ESRCH means gone, and EPERM means the number exists but is
// not ours.
//
// THE EPERM POLARITY IS DELIBERATELY OPPOSITE to gates.js's processExists()
// (gates.js:24-32, which returns `error?.code === 'EPERM'`), and both are right
// for their own question. There EPERM means "alive, so VETO the respawn"; here
// it means "not ours, so VETO the kill". Same principle — fail toward NOT
// acting — opposite conclusion, because there the dangerous act is launching a
// second runner and here it is signalling a stranger's process.
function groupExists(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

function pidExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// The runner's own attestation, read back. runner.js writes
// JSON.stringify({ pid: process.pid, beat_at: Date.now() }) at startup and every
// heartbeat_ms, and rm's the file when it finishes — so this is an IDENTITY
// witness, not a mere touch file. Missing or unparseable => no witness.
//
// WHAT ABSENCE ACTUALLY MEANS, STATED HONESTLY. Absence proves only that nothing
// is currently ATTESTING; it does NOT prove the runner's process group is empty,
// and the group may still hold OUR OWN suite grandchild. The
// witness-less-but-possibly-live cases are argued rather than assumed away at
// FALSE-NEGATIVE LEDGER (a) and (f) on killProcessTree below. UNPARSEABLE no
// longer joins them by way of a torn read: runner.js now publishes each beat
// atomically (temp + rename), so a reader sees the previous beat or the next one
// and never half of one. Ledger (b) records what that closed and what it traded.
async function readRunnerWitness(file) {
  try {
    const beat = JSON.parse(await readFile(file, 'utf8'));
    return beat && typeof beat === 'object' ? beat : null;
  } catch {
    return null;
  }
}

// Could this watch's runner still plausibly be alive AT ALL? It is bounded by
// its own armed deadline (runner.js falls back to 30 minutes for a non-finite
// job timeout_ms — mirrored here) plus its bounded shutdown. An unparseable
// created_at FAILS CLOSED: no age evidence, no kill. This fence gates only the
// STALE branch; a fresh witness is self-bounding through beat_at.
//
// ANCHORED TO THE ORIGINAL created_at ACROSS AN A2 RESPAWN — A RECORDED
// DISAGREEMENT BETWEEN THE CODE AND SECURITY REVIEWS, LEFT AS-IS. The code
// review observed that gates.js re-passes `created_at: watch.created_at` on a
// respawn and re-arms only { pid, host, spawn_attempts } (gates.js:1496, :1501),
// so a SECOND runner launched at T1 is fenced from T0, and proposed measuring
// the age from Math.max(Date.parse(watch.created_at), beat.beat_at). The
// SECURITY review forbade exactly that construction: beat_at is FILE-supplied,
// and using it to WIDEN the authorization to signal re-introduces a
// file-controlled widener. Both cannot be honoured, so the fence is UNCHANGED
// and the residual is recorded instead: for a RESPAWNED runner this may veto a
// kill up to one armed deadline early. Bounded by GATE_RUNNER_MAX_SPAWNS = 2 (at
// most one respawn), and it can only ever cost a FALSE NEGATIVE — never a stray
// signal. Resolving it properly needs a runtime-recorded spawned_at on the watch
// (a gates.js change, outside the claims of the run that landed this).
function withinArmedLifetime(watch) {
  const started = Date.parse(watch.created_at);
  if (!Number.isFinite(started)) return false;
  const timeoutMs = Number.isFinite(watch.timeout_ms) ? watch.timeout_ms : 30 * 60_000;
  const age = Date.now() - started;
  // NON-NEGATIVE CLAMP: unclamped, `age <= bound` reads every FUTURE created_at
  // as inside the lifetime, so a timestamp that is not evidence of youth would
  // widen the authorization to signal. Fail closed.
  return age >= 0 && age <= timeoutMs + RUNNER_LIFETIME_SLACK_MS;
}

// Best-effort kill of a detached gate-runner's whole process tree, Windows-safe
// (mirrors killTree's discipline, but keyed on a PERSISTED watch rather than a
// live child handle — the aborting process is a different `ape_run` call than the
// one that spawned the runner).
//
// THE HAZARD THIS GUARDS. watch.pid is read off durable run state, and a run can
// rest in 'gating' for an arbitrary wall-clock interval, so the number may name a
// process that exited long ago and one the OS has since RECYCLED. The
// pgid-reservation argument that makes spawnWithTimeout's escalation safe (a pid
// NUMBER stays allocated while it is in use as an active process-group id, so
// kill(-pid) can only mis-target once the group is already EMPTY) does NOT
// transfer here: "already empty" is the expected steady state for an old watch,
// not the harmless corner it is for a live child handle.
//
// AUTHORIZATION, IN ORDER: same host (EXACT match, mirroring the A2 respawn fence
// at gates.js:1471); an integer pid above 1; the runner's own heartbeat file
// parses AND names THIS pid — the identity witness, where beat.pid is never
// trusted alone or a parseable file could redirect a SIGKILL; then either that
// witness is FRESH, or the watch is still inside its armed lifetime. That last
// branch is deliberate: a runner that stopped heartbeating may still have left a
// suite grandchild writing the tree, and skipping there would trade the
// stray-signal hazard for a false NEGATIVE against the A6 contract (invariant 4).
// Only then is the group probed and signalled. Nothing is EVER signalled through
// the bare positive pid: the old catch-fallback fired precisely on the strongest
// available evidence that the number had been recycled, so the only thing a
// positive pid reaches now is the probe (signal 0), which delivers nothing.
//
// TOCTOU, STATED RATHER THAN PAPERED OVER. The window is opened by the awaited
// heartbeat read, which yields the event loop, so the witness is already at least
// one turn stale before any signal lands. The probe and the SIGTERM below are ONE
// synchronous turn, and the escalation re-probes immediately before the SIGKILL,
// which NARROWS the window ahead of the most destructive signal without closing
// it. Closing it needs a live handle — exactly what an aborting process does not
// have.
//
// ===========================================================================
// FALSE-NEGATIVE LEDGER — every case in which this guard SKIPS a kill the old
// unguarded code would have delivered. The A6 contract these call sites
// implement is that aborting a gating run leaves no surviving suite grandchild
// writing the tree that later evidence is computed over (invariant 4), so each
// skip is a DEBT against that contract and is argued here rather than asserted
// safe. Nothing is silently dropped.
//
//  (a) ABSENT WITNESS AFTER A NORMAL RUNNER COMPLETION — THE LARGEST MEMBER,
//      and the ORDINARY case rather than a corner. runner.js writes its result
//      artifact and then rm's the heartbeat, and the run KEEPS RESTING in
//      'gating' for an unbounded wall-clock interval until some later poll
//      adopts that artifact. Every abort arriving in that window finds no
//      witness and skips. And the tree is not necessarily quiet then:
//      spawnWithTimeout settles after its BOUNDED drain even while a
//      pipe-holding GRANDCHILD is still alive — the npm -> vitest -> dev-server
//      fan-out that killTree's own header exists for — and that grandchild is
//      still in the runner's process group and still writing the tree. The old
//      code killed it, and killed it SAFELY, because a non-empty group is
//      exactly the case where the pgid is still RESERVED by its own members and
//      kill(-pid) cannot mis-target.
//      WHY THE SKIP NEVERTHELESS STANDS: groupExists(pid) answers only "some
//      process group with this id exists". It CANNOT distinguish our own
//      surviving grandchild from a pgid that was freed and retaken by an
//      unrelated process — that indistinguishability IS the recycled-pid hazard
//      this function exists for, and it is not resolvable from inside an
//      aborting process that holds no handle. Signalling on that evidence would
//      put a SIGTERM and then a SIGKILL into a stranger's process group on the
//      operator's own machine. Weighed against each other: the false negative is
//      BOUNDED and self-limiting (the leftover grandchild is a suite process
//      that exits on its own, and the run whose tree it writes is being ABORTED,
//      so its evidence is discarded rather than admitted), while the false
//      positive is UNBOUNDED (an arbitrary unrelated group, force-killed). The
//      lesser harm wins and the veto stays.
//      THE DEBT IS REAL, AND THE HONEST CLOSING MOVE IS NOT TO WIDEN THIS GUARD.
//      It is to stop producing witness-less live trees at all: keep the runner
//      heartbeating until its process group is actually empty, and/or close the
//      'gating' rest window by adopting the artifact promptly. Both live in
//      runner.js and the poll path, neither of which is claimed here.
//
//  (b) TORN HEARTBEAT READ AGAINST A FULLY LIVE RUNNER — CLOSED, and kept here
//      because closing it bought a smaller cost that is now the live residual.
//      IT USED TO READ: runner.js wrote the heartbeat with a plain NON-ATOMIC
//      writeFile (open-truncate-then-write), unlike the atomicWriteFile600
//      temp+rename it used for the artifact in the same file, so a read landing
//      inside a beat saw a truncated file, JSON.parse threw, readRunnerWitness
//      returned null, and the kill was vetoed against a runner that was alive,
//      healthy and heartbeating. That was OBSERVED rather than postulated: the
//      heartbeat observer in __tests__/runtime-v2-runner.test.js counted 1
//      unparseable read against 34 parsed ones while sampling a real gate runner
//      on the pre-swap tree, and it still counts both (its `reads:` diagnostic),
//      so the claim stays checkable. runner.js now routes every beat through
//      atomicWriteFile600, so the reader above sees whole beats only.
//      WHAT THE SWAP TRADED, IN ITS OWN UNITS — not "the same race, rarer". A
//      beat can now fail to LAND where it used to fail half-written. runner.js's
//      helper deliberately does not import storage.js (that import limit is what
//      lets the parent spawn the runner unbundled), so its rename carries NONE
//      of replaceFile's bounded EPERM/EACCES/EBUSY retry — the transient
//      antivirus/indexer locks docs/configuration.md documents atomic state
//      replacement surviving. Failed beats do not tear the witness; they AGE it,
//      and an aged witness is a veto here just the same. The margin on shipped
//      defaults is SIX consecutive dropped beats from failed renames ALONE
//      (GATE_RUNNER_HEARTBEAT_MS 5s against GATE_RUNNER_STALE_MS 30s,
//      constants.js), but both are operator knobs — config.gates.heartbeat_ms
//      and gates.stale_ms — and raising the beat toward stale shrinks that
//      margin to one. THAT MARGIN NOW HAS A SECOND SOURCE, RECORD DRIFT
//      OTHERWISE: runGateJob (runner.js) serializes its beat writes by
//      SKIPPING a tick while the previous write is still in flight, so a write
//      slow enough to still be running at the next heartbeat_ms tick costs a
//      beat the same as a failed rename does — the six-consecutive-drops
//      figure above is a floor against renames alone, not the whole margin.
//      The platform where those rename locks actually occur is also the one
//      with the least slack: win32 takes the FRESH-WITNESS-ONLY branch below
//      (`if (!fresh) return;`) and has no orphan arm, so an aged witness there
//      leaves NO second authorization path, while POSIX still falls through to
//      the armed-lifetime fence. NOT AN ESCALATION IN EITHER DIRECTION:
//      killProcessTree signals as the same uid that writes these files, so the
//      0600 half closed an exposure, not a privilege boundary. THE
//      ORPHANED-TEMP RESIDUAL THE SWAP WIDENED IS NOW BOUNDED, NOT LIVE: a
//      bounded sweep closes the ordinary producer's residue at every
//      gate-runner launch. The full record — what closed, what remains, and
//      why — is recorded once, at atomicWriteFile600 in runner.js, and
//      deliberately not restated here so the two records cannot drift.
//
//  (c) PAST-LIFETIME + STALE. A stale witness whose watch is older than
//      created_at + timeout_ms + RUNNER_LIFETIME_SLACK_MS is vetoed by the age
//      fence below. Argued there; see also the recorded respawn-anchoring
//      disagreement on withinArmedLifetime.
//
//  (d) WIN32 + STALE. The win32 branch has no orphan arm at all: taskkill /T
//      walks a LIVE parent-pid chain that a dead runner has already broken, so
//      the kill would be both useless against the orphaned tree and dangerous
//      against whatever now holds the number. Argued at the branch below.
//
//  (e) BEAT.PID DISAGREEMENT. A heartbeat that parses but names a different pid
//      vetoes. This one is the guard working as designed rather than a debt: it
//      is exactly the case where the persisted pid is provably NOT the process
//      that is attesting.
//
//  (f) PRE-FIRST-BEAT. A runner spawned but not yet through its first beat has
//      written no heartbeat, so an abort in that window skips. Bounded by the
//      spawn-to-first-write interval, and the suite grandchild has not been
//      spawned yet at that point, so there is nothing to leak.
// ===========================================================================
//
// ABORT LATENCY IS NOW BOUNDED-BUT-NONZERO, RECORDED AS A COST. The awaited
// escalation can hold the receipt-effects critical section for up to
// kill_grace_ms (10s on the shipped default) where the old unref'd timer
// returned instantly — and routinely DROPPED the kill outright. The same lock
// already tolerates a 5-minute inline gate grace (GATE_INLINE_GRACE_MS), so 10s
// is comfortably inside its budget.
//
// RESIDUAL MUTANTS THIS CHANGE DOES NOT ARM — NAMED, NOT OMITTED (invariant 8).
// __tests__/runtime-v2-kill-process-tree-stale-pid.test.js arms every
// authorization check, the escalation and the never-throws contract below. Three
// mutations of the service.js WIRING survive it, by construction rather than by
// oversight, and a reviewer mutating this diff should expect them:
//   1. Deleting the SECOND call site outright (the OVERRIDE-abort mirror in
//      overrideRun). The only honest arm is a real-process e2e that drives
//      overrideRun('abort') from gating and observes a real suite grandchild
//      die, in a file that run did not claim. The FIRST call site's ORDERING
//      (this call BEFORE cleanupGateSuite) is NOT a residual — it is already
//      armed by a real-process test, __tests__/runtime-v2-gating-watch.test.js's
//      "abort from gating kills the recorded runner and seals aborted without
//      invoking gh (f, A6)": cleanupGateSuite rm's the heartbeat file, so
//      reordering deletes the witness, every guard below vetoes, and the real
//      suite pid survives the abort.
//   2. Dropping `{ stale_ms: config.gates?.stale_ms }` at either call site. Its
//      whole BEHAVIORAL content is armed at this unit boundary by arm A16, which
//      pins that an operator-supplied stale_ms and the built-in default reach
//      OPPOSITE verdicts on the identical watch; what survives is only the
//      wiring of config to the parameter.
//   3. Dropping the `await` at either abort/override call site remains outside
//      this unit boundary. The task-cancellation call is now armed separately:
//      runtime-v2-mcp-tasks-cancellation asserts that its locally spawned
//      runner has been reaped when cancellation becomes terminal. Retaining
//      that exact child handle makes awaited and un-awaited cleanup observably
//      different there; the old unreaped-zombie rationale no longer applies.
// Every line below is load-bearing AND witnessed; those three are the only known
// survivors, and they are debts against the CALL SITES, not against this guard.
//
// Never throws and never rejects: both call sites await this INSIDE the
// receipt-effects critical section, where a rejection would break the abort
// itself and the run would never seal.
// Options: stale_ms, kill_grace_ms, platform (injected by tests; defaults to
// process.platform).
//
// stale_ms IS WIRED FROM CONFIG, not left on the default. Both service.js call
// sites pass `{ stale_ms: config.gates?.stale_ms }` from the `config` already
// loaded in their own critical section, so the operator knob gates.stale_ms means
// the same thing here as it does at the A2 respawn fence in gates.js, which reads
// `config.gates?.stale_ms ?? GATE_RUNNER_STALE_MS`. The consequence of NOT wiring
// it is concrete and win32-specific: an operator who raised gates.stale_ms would
// make every win32 abort veto its taskkill (the fresh-witness-only branch below)
// against a runner the runtime's own poll path still considered alive. An absent
// or non-finite value falls back to KILL_IDENTITY_STALE_MS through the
// Number.isFinite guard, so an unconfigured project is byte-for-byte unchanged.
export async function killProcessTree(watch, options = {}) {
  try {
    if (!watch || typeof watch !== 'object') return;
    // Exact host match, mirroring the A2 respawn fence's `watch.host ===
    // hostname()`. The old `typeof host === 'string' && host && host !==
    // hostname()` form skipped only a non-empty MISMATCH, so a watch carrying
    // no host at all was signalled on whatever machine happened to read it.
    if (watch.host !== hostname()) return;
    const pid = watch.pid;
    // `pid <= 1`, NOT `pid <= 0`. POSIX kill(-1, sig) is a BROADCAST to every
    // process the caller may signal, so a watch that somehow persisted pid 1
    // would turn an abort into a machine-wide SIGTERM and then SIGKILL. No gate
    // runner is ever pid 1 (init/launchd owns that number), so excluding it
    // forfeits nothing real.
    if (!Number.isInteger(pid) || pid <= 1) return;
    const staleMs = Number.isFinite(options.stale_ms) ? options.stale_ms : KILL_IDENTITY_STALE_MS;
    // POSITIVE FLOOR on the grace. A finite kill_grace_ms <= 0 defeats the
    // default and makes `deadline <= Date.now()`, so the poll loop below never
    // executes its body at all and the SIGKILL fires with NO re-probe — the
    // blind escalation this function exists to replace. The floor makes
    // `deadline > Date.now()` hold, so the loop runs. STATED EXACTLY, not
    // over-claimed: the floor does not make a re-probe unconditional for every
    // input. `deadline` and the loop's first `left` read Date.now() in adjacent
    // statements, so a 1ms tick landing between them still skips the body. That
    // residual is materially different from the defect: at graceMs=1 the SIGKILL
    // follows a SIGTERM issued microseconds earlier, itself immediately preceded
    // by the groupExists probe, so nothing fires across a stale gap. Only a test
    // can inject a non-positive grace — service.js passes none — so the shipped
    // path always takes the default.
    const graceMs = Math.max(
      1,
      Number.isFinite(options.kill_grace_ms) ? options.kill_grace_ms : DEFAULT_KILL_GRACE_MS,
    );
    const platform = options.platform ?? process.platform;

    const beat = await readRunnerWitness(watch.heartbeat_file);
    if (!beat || beat.pid !== pid) return;
    // The beat age is clamped NON-NEGATIVE. beat_at is FILE-supplied, and an
    // unclamped `Date.now() - beat_at <= staleMs` reads any FUTURE timestamp as
    // maximally fresh — a file-controlled widener of the authorization to
    // signal. A beat stamped in the future is not evidence of liveness, so it
    // reads as NOT fresh: on POSIX the age fence below then decides, and on
    // win32 it vetoes. Fail-closed either way.
    //
    // ALL THREE CONJUNCTS BELOW ARE LOAD-BEARING, and `beatAge !== null` is the
    // least obvious of them: with the "there is no age at all" sentinel folded
    // away, ToNumber(null) is +0, so `null >= 0` and `null <= staleMs` are BOTH
    // true and a TIMESTAMPLESS heartbeat would read as MAXIMALLY fresh — the
    // most permissive verdict, from the least evidence.
    const beatAge = Number.isFinite(beat.beat_at) ? Date.now() - beat.beat_at : null;
    const fresh = beatAge !== null && beatAge >= 0 && beatAge <= staleMs;

    if (platform === 'win32') {
      // FRESH WITNESS ONLY — no orphan branch here. Windows recycles pids
      // aggressively and `taskkill /T` walks a LIVE parent-pid chain, which is
      // already broken the moment the runner died: a kill keyed on a dead
      // runner's pid is both useless against the orphaned tree and dangerous
      // against whatever now holds the number. Knowing false negative (ledger
      // (d)), bounded by the fact that taskkill could not have reached that tree
      // anyway.
      if (!fresh) return;
      // A PROBE, not a signal: process.kill(pid, 0) delivers nothing.
      if (!pidExists(pid)) return;
      try {
        const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        });
        killer.on('error', () => {});
        killer.unref?.();
      } catch { /* nothing more we can do */ }
      await awaitOwnedDetachedExit(pid);
      return;
    }

    // AGE FENCE (POSIX only): a stale witness still authorizes the kill while
    // the watch is inside its armed lifetime — the orphaned-suite case. Past it,
    // nothing of ours can still be there — EXCEPT after an A2 respawn, where the
    // lifetime is still measured from the FIRST runner's created_at. That
    // exception is real, bounded, and argued on withinArmedLifetime above
    // (ledger entry (c)); it is not silently assumed away here. The `!fresh &&`
    // conjunct is equally load-bearing in the other direction: a runner that is
    // heartbeating RIGHT NOW is alive by direct attestation, and an over-running
    // suite is exactly what an abort exists for, so the fence must not veto it.
    if (!fresh && !withinArmedLifetime(watch)) return;
    // The probe and the signal are one synchronous turn: no await may separate
    // them, or the window this narrows re-opens between them.
    if (!groupExists(pid)) {
      await awaitOwnedDetachedExit(pid);
      return;
    }
    try {
      process.kill(-pid, 'SIGTERM');
    } catch { /* the group emptied between the probe and here; NO bare-pid fallback */ }

    // Bounded, AWAITED, group-observing escalation. Poll instead of firing
    // blind: the moment the group is gone we stop, so a group that died of the
    // polite signal is never SIGKILLed, and the caller cannot return with a
    // force-kill still owed to it.
    const pollMs = Math.max(10, Math.min(100, Math.floor(graceMs / 4)));
    const deadline = Date.now() + graceMs;
    for (let left = deadline - Date.now(); left > 0; left = deadline - Date.now()) {
      await sleep(Math.min(pollMs, left));
      // The final iteration's probe IS the re-probe: nothing but synchronous
      // loop bookkeeping separates it from the SIGKILL below.
      if (!groupExists(pid)) {
        await awaitOwnedDetachedExit(pid);
        return;
      }
    }
    try {
      process.kill(-pid, 'SIGKILL');
    } catch { /* the group emptied in the last microseconds; NO bare-pid fallback */ }
    await awaitOwnedDetachedExit(pid);
  } catch { /* best-effort: an abort must never fail because a kill did */ }
}
