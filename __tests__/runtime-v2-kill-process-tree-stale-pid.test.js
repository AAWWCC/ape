import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GATE_RUNNER_STALE_MS } from '../lib/runtime/constants.js';
// NAMESPACE import, deliberately: arm A7 reads a constant that does not exist
// on the pre-fix tree. A static named import of a missing export can fail at
// LINK time and take the whole file red for the wrong reason, which would make
// every arm below vacuous. A namespace property read is just `undefined`.
import * as spawnModule from '../lib/runtime/spawn.js';

const { killProcessTree } = spawnModule;

// ===========================================================================
// killProcessTree STALE-PID PARITY — DECISION LOG (roadmap:
// kill-process-tree-stale-pid-parity). This entry was recorded as NOT IN SCOPE
// by the 2026-07-24 LOW/NIT sweep's ITEM 3 (spawn.js's owed SIGKILL
// escalation) in __tests__/runtime-v2-audit-2026-07-24-nits.test.js, whose
// item-3 "NOT IN SCOPE" paragraph names this roadmap entry and says nothing
// there touches it. This file is where it gets touched. (Referenced BY ITEM
// NAME, never by line number: acme PR #356 already left line-number-coupling
// residue in that file and this run adds none.)
// Prose-header + named-decision convention: that file's header, and the 1.13
// sweep's decision-log block at __tests__/runtime-v2-audit-1-13-nits.test.js.
//
// THE DECISION IS FIX, NOT WON'T-FIX, AND THE DECISIVE FACT IS ON DISK. The
// gate runner's heartbeat file is NOT a touch file. runner.js writes
// JSON.stringify({ pid: process.pid, beat_at: Date.now() }) at startup and
// every heartbeat_ms, and rm's the file when the runner finishes. That is a
// runner-ATTESTED IDENTITY WITNESS: "no heartbeat" is precisely "nothing is
// attesting that this number is still our runner", so the pid may already have
// been recycled — exactly the case today's killProcessTree signals
// unconditionally, from a pid read off durable run state that may have rested
// in `gating` for an arbitrary wall-clock interval. The pgid-reservation
// argument that settled the 2026-07-24 sweep's item 3 (a pid NUMBER stays
// allocated while it is in use as an active process-group id, so kill(-pid) can
// only mis-target once the group is already EMPTY) does NOT transfer here,
// because "already empty" is the expected steady state for an old watch rather
// than the harmless-ESRCH corner it is for a live child handle. A won't-fix
// would have had to answer the AGE of the persisted pid, and it cannot.
//
// THE FOUR SUB-DECISIONS, EACH RECORDED SEPARATELY:
//  (1) THE -pid PATH — FIX BY GUARDING, not by deleting. The kill still
//      happens; it is now authorized by the witness. Order: watch is an object;
//      watch.host === hostname() (TIGHTENED — today a watch with NO host at all
//      passes the `typeof host === 'string' && host` test and gets signalled);
//      Number.isInteger(pid) && pid > 1; the heartbeat JSON parses AND
//      beat.pid === pid (the identity witness); then freshness, then the
//      liveness probe.
//      `pid > 1`, NOT `pid > 0`: POSIX kill(-1, sig) is a BROADCAST to every
//      process the caller may signal, so a watch that somehow persisted pid 1
//      would turn one abort into a machine-wide SIGTERM and then SIGKILL. No
//      gate runner is ever pid 1 (init/launchd owns that number), so excluding
//      it forfeits nothing real. Arms A1/A2/A6a/A6b/A8/A9/A11a.
//  (2) THE BARE-pid CATCH-FALLBACK (today spawn.js's `try { process.kill(pid,
//      signal) }` inside the catch) — DELETED OUTRIGHT, no gate, no exception,
//      in BOTH catches (the SIGTERM one and the SIGKILL one). It runs precisely
//      when process.kill(-pid, signal) threw, i.e. when no process group with
//      that id exists — the STRONGEST available evidence that the group has
//      emptied and the number is eligible for reuse. Under the escalate timer it
//      delivered SIGKILL to a bare persisted pid that may by then belong to an
//      unrelated process on the operator's own machine. Post-fix the ONLY thing
//      a positive pid is ever passed to is the liveness PROBE (signal 0), which
//      delivers nothing. Arms A2/A2b.
//  (3) THE unref'd ESCALATE TIMER — DELETED, and replaced by a BOUNDED, AWAITED,
//      GROUP-OBSERVING escalation. Today's `setTimeout(..., 10_000).unref()` is
//      wrong in both directions at once: in a short-lived process that returns
//      before the grace elapses the SIGKILL never fires at all (a
//      SIGTERM-ignoring suite survives the abort — the same LOST-escalation
//      class acme PR #357 just closed on the spawnWithTimeout side), and in a
//      long-lived one it fires blind at a group that may have emptied and been
//      recycled in the meantime. killProcessTree therefore becomes async and
//      both service.js call sites await it; it polls the group and escalates
//      only while the group is still observably there. It never throws and
//      never rejects. Arms A3/A4/A12/A18.
//  (4) win32 taskkill — IN SCOPE, under the same gate, FRESH-WITNESS ONLY.
//      Windows recycles pids aggressively and `taskkill /T` walks a LIVE
//      parent-pid chain, which is broken the moment the runner dies, so there
//      is no orphan branch to be had there: the POSIX age fence authorizes a
//      stale-but-plausibly-alive watch, win32 does not. The taskkill invocation
//      itself stays byte-identical to today's. Arms A5/A10b/A11a/A11c/A13/A16.
//
// SHIPPED SIGNATURE the arms below call:
//     export async function killProcessTree(watch, options = {})
//       options: { stale_ms, kill_grace_ms, platform }
// plus a new export KILL_IDENTITY_STALE_MS = 30_000, a DELIBERATE DUPLICATE of
// constants.js GATE_RUNNER_STALE_MS.
// THE DUPLICATE IS A CONVENTION, NOT A TECHNICAL NECESSITY — stated correctly
// here because an earlier draft of this log over-claimed it. gates.js
// resolveRunnerEntry always spawns the SOURCE lib/runtime/runner.js, so
// constants.js (an import-free leaf) would in fact always resolve as a sibling
// of the entry that actually runs. What the duplication buys is the posture
// runner.js states for itself — its runtime-module imports are pinned to
// ./spawn.js alone, so keeping spawn.js to node BUILTINS ONLY holds the
// detached runner's whole dependency surface to one auditable file. The only
// new import spawn.js takes is node:fs/promises. Arm A7 is the drift pin that
// keeps the duplicate honest.
//
// REJECTED ALTERNATIVES (recorded so they are not re-proposed):
//  - Won't-fix by restating the live-handle/pgid-reservation argument that
//    settled item 3. Rejected: it is an argument about a LIVE child handle and
//    says nothing about a pid persisted hours earlier.
//  - Import gates.js's processExists()/isHeartbeatFresh() rather than
//    re-deriving them. Rejected: see the builtins-only convention above.
//  - Reuse isHeartbeatFresh's mtime STAT as the oracle. Rejected: an mtime is
//    a timestamp, not an identity. The recycled-pid hazard needs beat.pid ===
//    watch.pid, which only the file's CONTENTS can attest. Note the polarity of
//    the derived checks is deliberately OPPOSITE to gates.js's on EPERM: there
//    EPERM means "alive, so veto the RESPAWN"; here it means "not ours, so veto
//    the KILL". Same principle (fail toward not acting), opposite conclusion.
//  - Keep the bare-pid fallback behind the new gate. Rejected: see (2) — the
//    gate authorizes "this pid was our runner recently", not "this number is
//    still our runner NOW", and the fallback fires exactly on the evidence that
//    it is not.
//  - Keep the unref'd timer and merely shorten it. Rejected: shortening trades
//    one blind signal for an earlier blind signal and keeps the LOST-escalation
//    half of the defect.
//  - /proc-style introspection to identify the process. Rejected outright:
//    invariant 6 (host neutrality), no new dependencies.
//
// THE CORRECTNESS BAR, MET RATHER THAN ASSERTED. The A6 contract these call
// sites implement is that aborting a gating run leaves no surviving suite
// grandchild writing the tree later evidence is computed over (invariant 4). A
// guard that skips whenever it is unsure would trade the stray-signal hazard
// for a false-NEGATIVE class, so the fix does NOT skip on staleness alone:
// A6a pins that a STALE-but-present witness whose watch is still inside its
// armed lifetime (created_at + timeout_ms + 60s slack) STILL gets killed —
// that is the orphaned-suite case, and it must stay green forever. A6b pins
// the other side: past that lifetime the age fence vetoes. Unparseable
// created_at fails CLOSED (A10c); an absent timeout_ms falls back to the same
// 30-minute armed default runner.js already uses (A15).
//
// ===========================================================================
// FALSE-NEGATIVE LEDGER (a)-(f) — every case in which the guard SKIPS a kill
// today's unguarded code would have delivered. Each is ARGUED, not asserted
// safe; none is silently dropped.
//
//  (a) ABSENT WITNESS AFTER A NORMAL RUNNER COMPLETION — THE LARGEST MEMBER,
//      and the ORDINARY case rather than a corner. runner.js writes its result
//      artifact and then rm's the heartbeat, and the run KEEPS RESTING in
//      'gating' for an unbounded wall-clock interval until some later poll
//      adopts that artifact. Every abort arriving in that window finds no
//      witness and skips. The tree is not necessarily quiet then:
//      spawnWithTimeout settles after its BOUNDED drain even while a
//      pipe-holding GRANDCHILD is still alive — the npm -> vitest -> dev-server
//      fan-out killTree's own header exists for — and that grandchild is still
//      in the runner's process group and still writing the tree. The old code
//      killed it, and killed it SAFELY, because a non-empty group is exactly
//      the case where the pgid is still RESERVED by its own members and
//      kill(-pid) cannot mis-target.
//      WHY THE SKIP NEVERTHELESS STANDS: groupExists(pid) answers only "some
//      process group with this id exists". It CANNOT distinguish our own
//      surviving grandchild from a pgid that was freed and retaken by an
//      unrelated process — that indistinguishability IS the recycled-pid hazard
//      this function exists for, and it is not resolvable from inside an
//      aborting process that holds no handle. Signalling on that evidence would
//      put a SIGTERM and then a SIGKILL into a stranger's process group on the
//      operator's own machine. Weighed: the false negative is BOUNDED and
//      self-limiting (the leftover grandchild is a suite process that exits on
//      its own, and the run whose tree it writes is being ABORTED, so its
//      evidence is discarded rather than admitted), while the false positive is
//      UNBOUNDED (an arbitrary unrelated group, force-killed). The lesser harm
//      wins and the veto stays. The honest closing move is NOT to widen this
//      guard: it is to stop producing witness-less live trees at all (keep the
//      runner heartbeating until its group is empty, and/or close the 'gating'
//      rest window by adopting the artifact promptly). Both live in runner.js
//      and the poll path, neither claimed here.
//  (b) TORN HEARTBEAT READ AGAINST A FULLY LIVE RUNNER — CLOSED. runner.js used
//      to write the heartbeat with a plain NON-ATOMIC writeFile
//      (open-truncate-then-write), so a read landing inside a beat saw a
//      truncated file, JSON.parse threw, the witness read as absent, and the
//      kill was vetoed against a runner that was alive and heartbeating. It now
//      routes every beat through the same atomicWriteFile600 the artifact
//      already used (temp + 0600 + fsync + rename), so a reader sees whole
//      beats only. The authoritative record — what the swap traded, and the
//      orphaned-temp and win32 no-retry residuals it left behind — is ledger (b)
//      in lib/runtime/spawn.js. It is deliberately NOT restated here: two
//      divergent copies of one entry is the drift this ledger exists to prevent,
//      which is why this twin carries a pointer rather than a paraphrase.
//  (c) PAST-LIFETIME + STALE (A6b). Argued at the age fence; see also the
//      recorded respawn-anchoring disagreement below.
//  (d) WIN32 + STALE (A5). No orphan branch at all: taskkill /T walks a LIVE
//      parent-pid chain that a dead runner has already broken, so the kill would
//      be both useless against the orphaned tree and dangerous against whatever
//      now holds the number.
//  (e) BEAT.PID DISAGREEMENT (A8). A heartbeat that parses but names a
//      different pid vetoes. This one is the guard working as designed rather
//      than a debt: it is exactly the case where the persisted pid is provably
//      NOT the process that is attesting.
//  (f) PRE-FIRST-BEAT. A runner spawned but not yet through its first beat has
//      written no heartbeat, so an abort in that window skips. Bounded by the
//      spawn-to-first-write interval, and the suite grandchild has not been
//      spawned yet at that point, so there is nothing to leak.
//
// RECORDED DISAGREEMENT, FENCE UNCHANGED. The code review observed that an A2
// respawn re-passes the ORIGINAL created_at (gates.js re-arms only
// { pid, host, spawn_attempts }), so a SECOND runner launched at T1 is fenced
// from T0, and proposed measuring the age from
// Math.max(Date.parse(created_at), beat.beat_at). The SECURITY review forbade
// exactly that: beat_at is FILE-SUPPLIED, and using it to WIDEN the
// authorization to signal re-introduces a file-controlled widener. Both cannot
// be honoured, so the fence is UNCHANGED and the residual is recorded: for a
// RESPAWNED runner it may veto a kill up to one armed deadline early. Bounded
// by GATE_RUNNER_MAX_SPAWNS = 2 (at most one respawn) and it can only ever cost
// a FALSE NEGATIVE, never a stray signal. Any comment claiming "past the armed
// lifetime, nothing of ours can still be there" must name this exception. A
// sound fix needs a runtime-recorded spawned_at on the watch — gates.js, out of
// this run's claims.
//
// ALSO RECORDED: abort latency is now bounded-but-NONZERO. The awaited
// escalation can hold the receipt-effects critical section for up to
// kill_grace_ms (10s by default) where the old unref'd timer returned instantly
// — and routinely DROPPED the kill. The same lock already tolerates a 5-minute
// inline gate grace (GATE_INLINE_GRACE_MS), so 10s is comfortably inside its
// budget.
//
// TOCTOU, STATED RATHER THAN PAPERED OVER. The window is NOT the gap between
// the liveness probe and the SIGTERM — those are one synchronous turn with no
// await between them. It is opened EARLIER, by the awaited heartbeat read,
// which yields the event loop: the identity witness is already at least one
// turn stale before any signal lands. The escalation's re-probe NARROWS the
// window ahead of the most destructive signal but does not close it. Closing it
// needs a live handle, which is exactly what the aborting process does not have.
//
// ===========================================================================
// MUTANTS THIS FILE DOES NOT ARM — NAMED AND ARGUED, NEVER OMITTED (invariant
// 8). The next reviewer will mutate the production diff and grade against the
// map below; these three are the disclosed residuals, so a survivor here is
// EXPECTED and already accounted for rather than a hole nobody saw.
//   * service.js's SECOND call site (the OVERRIDE-abort mirror) deleted
//     outright. Unarmed here: this file is a UNIT suite over spawn.js, and the
//     only honest arm is a real-process e2e that drives overrideRun('abort')
//     from gating and observes a real suite grandchild die — the shape of
//     __tests__/runtime-v2-gating-watch.test.js's abort arm, in a file this run
//     does not claim.
//   * dropping `{ stale_ms: config.gates?.stale_ms }` at either call site. Same
//     reason; its whole BEHAVIORAL content is armed at the unit boundary by A16,
//     which pins that an operator-supplied stale_ms and the built-in default
//     reach opposite verdicts on the identical watch. What survives is only the
//     wiring of config to the parameter.
//   * dropping the `await` at either abort/override call site remains outside
//     this unit boundary. The task-cancellation integration now arms its own
//     cleanup call by asserting that the locally spawned runner is reaped when
//     cancellation becomes terminal; exact child-handle retention makes that
//     awaited/un-awaited distinction observable there.
//   * ORDERING at the FIRST call site (killProcessTree before cleanupGateSuite)
//     IS already armed, and by a real-process test: cleanupGateSuite rm's the
//     heartbeat file, so reordering deletes the witness and every guard here
//     vetoes — the real suite pid then survives the abort and
//     __tests__/runtime-v2-gating-watch.test.js's "abort from gating kills the
//     recorded runner and seals aborted without invoking gh (f, A6)" arm goes
//     red. CITED, deliberately NOT re-authored here: duplicating a real-process
//     e2e in a unit file buys nothing and would import the starvation profile
//     vitest.config.js's spawn-serial quarantine exists to keep out.
//
// BUNDLES — STATED AS FACT. killProcessTree is TREE-SHAKEN out of
// dist/ape-hooks.bundle.mjs and dist/ape-larp.bundle.mjs:
// `git log -S killProcessTree -- dist/ape-hooks.bundle.mjs
// dist/ape-larp.bundle.mjs` is EMPTY across ALL history, while the positive
// control `git log -S DEFAULT_KILL_GRACE_MS` over the same two paths hits
// 2018fb1a and 2f528ab7, and scripts/bundle-mcp.mjs sets minifyWhitespace only
// (no identifier minification), so the pickaxe is sound. Expect
// dist/ape-mcp.bundle.mjs ALONE to move on `npm run bundle`; an unchanged
// ape-hooks/ape-larp bundle is NOT drift and must never be hand-edited.
// __tests__/runtime-v2-audit-2026-07-24-nits.test.js's BUNDLE NOTE says a
// spawn.js edit moves all three bundles; that sentence is scoped to
// spawnWithTimeout's TIMER BLOCK (which is inlined in all three) and is true of
// it. Read as a general rule about spawn.js it would contradict the pickaxe
// above. That file is unclaimed and stays unedited.
//
// vitest.config.js IS DELIBERATELY UNEDITED — a disposition, not dropped scope.
// Every arm here observes delivery through a FULL mock of process.kill and a
// mocked node:child_process, so this file awaits no real child and has none of
// the starvation profile SPAWN_SERIAL_FILES exists to quarantine. It stays in
// the parallel `default` project. Nothing here pins spawnWithTimeout/killTree
// internals either — acme PR #357's escalate-once path stays byte-unchanged.
//
// ===========================================================================
// THE 25 ARMS, AND THE MUTANT EACH ONE KILLS. 24 are red on the pre-fix tree;
// the '(sanity)' observer arm is the ONLY pre-fix green.
//  (sanity) the OBSERVER itself: bare-pid and group signals are both recorded,
//           and only probes (signal 0) are excluded. Green on both sides of the
//           fix by construction — without it every "no signal" half below would
//           be true for free.
//  A1   absent witness is NOT signalled; a witnessed runner still is  -> !beat
//  A2   group gone, NUMBER live: no signal reaches the bare positive pid
//  A2b  every real signal on -P throws: the pair is [-P SIGTERM, -P SIGKILL]
//       and NOTHING positive -> the bare-pid fallback in BOTH catches
//  A3   a SIGTERM-surviving group is SIGKILLed INSIDE the awaited call
//       -> the unref'd timer; -> 'SIGKILL' in the escalation (exact pair)
//  A4   a group that dies leaves NO delayed signal behind (11s later, silence)
//       -> the unref'd timer; -> the loop's re-probe
//  A5   win32 taskkill only under a fresh witness, exact argv -> win32 !fresh;
//       -> beatAge <= staleMs
//  A6a  stale witness INSIDE the armed lifetime is still killed
//       -> the !withinArmedLifetime conjunct of the age fence
//  A6b  stale witness PAST the armed lifetime is vetoed -> the age fence line
//  A7   KILL_IDENTITY_STALE_MS === GATE_RUNNER_STALE_MS drift pin
//  A8   heartbeat naming ANOTHER pid vetoes -> beat.pid !== pid
//  A9   foreign host and ABSENT host both veto, same host acts
//       -> watch.host !== hostname(), including the tightening
//  A10a fresh witness, group gone: STRICTLY no signal, no pid-sign filter
//       -> the pre-SIGTERM groupExists; -> its catch polarity
//  A10b win32, fresh witness, pid gone: no taskkill -> the win32 pidExists;
//       -> its catch polarity
//  A10c unparseable created_at FAILS CLOSED -> !Number.isFinite(started)
//  A11a win32: pid 1 and a NON-INTEGER pid are both refused -> pid <= 1 (not
//       <= 0); -> !Number.isInteger(pid)
//  A11b/c a FUTURE beat_at is not fresh, POSIX and win32 -> beatAge >= 0
//  A11d a FUTURE created_at is not inside the lifetime -> age >= 0
//  A12  a floored grace still re-probes before escalating: SIGTERM, no SIGKILL
//       -> the positive floor on kill_grace_ms; -> the loop's re-probe
//  A13  a heartbeat with NO beat_at key is not fresh -> the `beatAge !== null`
//       conjunct (deleting it makes a TIMESTAMPLESS heartbeat MAXIMALLY fresh,
//       because ToNumber(null) is +0 so null >= 0 and null <= staleMs are both
//       true while null === 0 is false)
//  A14  FRESH witness past the armed lifetime is STILL killed -> the `!fresh &&`
//       conjunct of the age fence
//  A15  absent timeout_ms falls back to 30 minutes -> that fallback
//  A16  the SAME watch, one call with stale_ms and one without, reaches
//       OPPOSITE verdicts -> the options.stale_ms ternary (invisible to every
//       other arm, because KILL_IDENTITY_STALE_MS equals this file's STALE_MS)
//  A17  the lifetime bound is timeout_ms + 60s -> RUNNER_LIFETIME_SLACK_MS
//  A18  a watch whose pid getter THROWS resolves undefined and signals nothing
//       -> the function-wide try/catch
// Three mutants are EQUIVALENT and carry no arm, by construction rather than by
// omission: the `watch && typeof watch === 'object'` shape guard (without it
// null.host throws into the outer catch — observationally identical); the
// `Number.isFinite(beat.beat_at)` ternary IN ISOLATION while the `beatAge !==
// null` conjunct stands (NaN >= 0 is false, same verdict as the null sentinel);
// and the pollMs clamp (timing only — the loop always probes before the
// SIGKILL).
//
// WHY EVERY ARM CARRIES AN AUTHORIZED CONTROL IN THE SAME it(). The signature
// change is itself a vacuity trap: PRE-fix, killProcessTree's first parameter is
// a pid, so a call passing a WATCH hits `!Number.isInteger(pid)` and returns
// silently for every arm here. A bare "no signal was delivered" assertion is
// therefore green today for entirely the wrong reason. Each arm is red today on
// its AUTHORIZED half — the kill that must still happen and does not — and the
// unauthorized half becomes load-bearing only once the new signature lands.
// Recorded so nobody later "simplifies" the controls away.
//
// A1'S HONEST LIMITATION, STATED BECAUSE AN EARLIER DRAFT OVER-CLAIMED IT.
// A1's veto half kills no single-guard DELETION mutant on its own: with `!beat`
// removed, `beat.pid` is dereferenced downstream on a null and the function-wide
// catch turns the TypeError into a silent return — observationally identical to
// the veto. A1's real mutant is the defensive REFACTOR (`Number.isFinite(
// beat?.beat_at)` with the witness check softened), which reaches the signal.
// The witness-MISMATCH half is a different predicate over different inputs and
// is armed separately by A8; A1 does not anchor it.
//
// WHY THERE IS NO PLATFORM SKIP HERE. .github/workflows/ci.yml is this repo's
// ONLY workflow and runs exactly ONE job, on windows-latest. A
// `describe.skipIf(process.platform === 'win32')` around the POSIX arms would
// therefore gate NOTHING: every one of them would be skipped in the only CI
// that runs. Each POSIX arm instead injects `platform: 'linux'` through the
// shipped options.platform seam, so the branch under test is selected by the
// FIXTURE and both halves run everywhere. Consequence, used deliberately below:
// a POSIX arm and its win32 counterpart may share one it().
// ===========================================================================

// A5 and its win32 peers need to observe whether `taskkill` is spawned at all,
// so node:child_process is mocked file-wide (nothing else here spawns).
// vi.hoisted is required: the vi.mock factory is hoisted above every import, so
// it cannot close over an ordinary module-scope const.
const { taskkillSpawns } = vi.hoisted(() => ({ taskkillSpawns: [] }));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    spawn: (command, args, options) => {
      taskkillSpawns.push({ command, args, options });
      // Today's win32 body does `killer.on('error', ...)` then `killer.unref?.()`
      // and the fix keeps it byte-identical, so the stub must answer both.
      return { pid: 1, on() {}, once() {}, unref() {}, kill() {} };
    },
  };
});

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

// Pids are FABRICATED and above BOTH platform ceilings (macOS caps at 99_998;
// Linux's pid_max cannot exceed 2^22 = 4_194_304), so none of them can name a
// real process anywhere. That is defense in depth only: the spy below is a FULL
// mock that NEVER passes through to the real process.kill, because a
// passing-through spy would deliver the exact stray signal under test to the
// operator's own machine.
const A1_ORPHANED_PID = 4_242_001;
const A1_WITNESSED_PID = 4_242_002;
const A2_RECYCLED_PID = 4_242_003;
const A2_WITNESSED_PID = 4_242_004;
const A3_SURVIVING_PID = 4_242_005;
const A4_DYING_PID = 4_242_006;
const A5_STALE_PID = 4_242_007;
const A5_FRESH_PID = 4_242_008;
const A6A_ORPHAN_SUITE_PID = 4_242_009;
const A6B_EXPIRED_PID = 4_242_010;
const A6B_WITHIN_PID = 4_242_011;
const A2B_HOSTILE_PID = 4_242_012;
const A2B_CONTROL_PID = 4_242_013;
const A8_WATCH_PID = 4_242_014;
const A8_ATTESTING_PID = 4_242_015;
const A8_CONTROL_PID = 4_242_016;
const A9_FOREIGN_PID = 4_242_017;
const A9_HOSTLESS_PID = 4_242_018;
const A9_CONTROL_PID = 4_242_019;
const A10A_GONE_GROUP_PID = 4_242_020;
const A10A_CONTROL_PID = 4_242_021;
const A10B_GONE_PID = 4_242_022;
const A10B_CONTROL_PID = 4_242_023;
const A10C_UNPARSEABLE_PID = 4_242_024;
const A10C_CONTROL_PID = 4_242_025;
// The pid guard's two refused shapes. INIT_PID is POSIX pid 1, whose NEGATION
// is the kill(-1) broadcast; the fractional one is what `Number.isInteger`
// exists for. Both are exercised on the WIN32 branch on purpose (see A11a).
const A11A_INIT_PID = 1;
const A11A_FRACTIONAL_PID = 4_242_026.5;
const A11A_CONTROL_PID = 4_242_027;
const A11B_FUTURE_BEAT_PID = 4_242_028;
const A11B_CONTROL_PID = 4_242_029;
const A11C_FUTURE_BEAT_PID = 4_242_030;
const A11C_CONTROL_PID = 4_242_031;
const A11D_FUTURE_CREATED_PID = 4_242_032;
const A11D_CONTROL_PID = 4_242_033;
const A12_FLOORED_GRACE_PID = 4_242_034;
const A13_WIN32_PID = 4_242_035;
const A13_WIN32_CONTROL_PID = 4_242_036;
const A13_POSIX_PID = 4_242_037;
const A13_POSIX_CONTROL_PID = 4_242_038;
const A14_FRESH_PID = 4_242_039;
const A14_STALE_PID = 4_242_040;
const A15_DEFAULT_WITHIN_PID = 4_242_041;
const A15_DEFAULT_PAST_PID = 4_242_042;
const A16_CONFIGURED_PID = 4_242_043;
const A17_WITHIN_SLACK_PID = 4_242_044;
const A17_PAST_SLACK_PID = 4_242_045;
const A18_THROWING_PID = 4_242_046;
const A18_CONTROL_PID = 4_242_047;
const SANITY_PID = 4_242_099;

// The armed deadline a real watch carries (config.deadlines_ms[lane], resolved
// finite by startGateSuite) and an age that is unambiguously past it plus the
// 60s runner-lifetime slack — 8 minutes of margin, so no wall-clock threshold
// is ever raced.
const ARMED_TIMEOUT_MS = 60_000;
const AGED_MS = 10 * 60_000;
// Passed explicitly to every call so no arm depends on the SHIPPED default's
// value: freshness here is a 30s margin against a beat stamped microseconds
// earlier, or a 10-minute-old beat. Neither can flake. A16 is the ONE arm that
// deliberately omits it, precisely to observe the default.
const STALE_MS = 30_000;

const isProbe = (signal) => signal === 0 || signal === '0';

// Record every process.kill this file provokes as {pid, signal}, and answer
// liveness from the fixture rather than the machine.
//
// DISCRIMINATE ON SIGNAL, NEVER ON PID SIGN. The in-repo precedent
// (__tests__/runtime-v2-audit-2026-07-24-nits.test.js's recordGroupSignals)
// filters on NEGATIVE pids so its own liveness probe cannot record itself.
// That filter CANNOT be copied here: the fix introduces bare-pid probes
// `process.kill(pid, 0)`, and arms A2/A2b exist precisely to observe whether a
// bare-pid SIGNAL is delivered — a pid-sign filter would hide the very thing
// under test. Probes carry signal 0 and deliver nothing, so signal 0 is the
// correct and only exclusion.
//
// live(target, signal) SEES BOTH ARGUMENTS. It receives the RAW target
// (negative = process group) AND the signal, which is what lets a fixture
// express "the probe succeeds but the real signal throws" — the shape A2b
// needs, and the ONLY shape under which the two catch blocks around
// process.kill are reachable at all. A one-argument fixture (`live: (t) => ...`)
// keeps working unchanged; it simply ignores the second parameter.
// die_on_signal models a group that dies of the polite SIGTERM. Note the call
// is RECORDED BEFORE the throw, so a signal that ESRCHes is still observed.
function installKillSpy({ live = () => true, die_on_signal = false } = {}) {
  const calls = [];
  const killed = new Set();
  vi.spyOn(process, 'kill').mockImplementation((target, signal) => {
    calls.push({ pid: target, signal });
    if (killed.has(Math.abs(target)) || !live(target, signal)) {
      throw Object.assign(new Error('kill ESRCH'), {
        code: 'ESRCH',
        errno: -3,
        syscall: 'kill',
      });
    }
    if (die_on_signal && !isProbe(signal)) killed.add(Math.abs(target));
    return true;
  });
  return {
    calls,
    // Everything delivered since the last drain, probes excluded.
    drainSignals: () => calls.splice(0).filter((call) => !isProbe(call.signal)),
  };
}

const tempDirs = [];

afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  taskkillSpawns.length = 0;
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

// Temp dirs only: no arm writes anywhere inside the project tree.
async function tempDir() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-killtree-'));
  tempDirs.push(dir);
  return dir;
}

// The runner's heartbeat bytes, reproduced exactly: runner.js writes
// JSON.stringify({ pid: process.pid, beat_at: Date.now() }).
async function writeHeartbeat(dir, name, beat) {
  const file = path.join(dir, name);
  await writeFile(file, JSON.stringify(beat), 'utf8');
  return file;
}

// A gates_watch shaped exactly as startGateSuite persists it. The trailing
// ...overrides is what lets an arm vary ONE field (host, created_at,
// timeout_ms) against an otherwise identical control; no arm needs a new
// parameter.
function watchFor(dir, overrides) {
  return {
    nonce: '0d2f1e6a-0000-4000-8000-000000000001',
    cache_key: 'kill-process-tree-stale-pid',
    command: 'npm test',
    tree_sha: '6d06f6bd28c66639863d4b4a4779635fafcb776e',
    plan: { command: 'npm', args: ['test'], shell: false },
    timeout_ms: ARMED_TIMEOUT_MS,
    job_file: path.join(dir, 'job.json'),
    artifact_file: path.join(dir, 'artifact.json'),
    heartbeat_file: path.join(dir, 'heartbeat.json'),
    pid: null,
    host: hostname(),
    spawn_attempts: 1,
    poll_count: 0,
    last_poll_at: null,
    last_summary: null,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

// The taskkill invocation shipping today, which the fix keeps byte-identical.
const taskkillArgv = () => taskkillSpawns.map(({ command, args }) => ({ command, args }));
const expectedTaskkill = (pid) => ({
  command: 'taskkill',
  args: ['/pid', String(pid), '/T', '/F'],
});
const resetTaskkills = () => {
  taskkillSpawns.length = 0;
};

// ---------------------------------------------------------------------------
// Harness non-vacuity. Every arm below asserts over what the spy RECORDED, so
// a spy that recorded nothing would make each "no signal" half true for free
// and each red misleading. This pins the observer itself, and nothing about
// killProcessTree — it stays green on both sides of the fix.
// ---------------------------------------------------------------------------

describe('killProcessTree — signal observer', () => {
  it('(sanity) records bare-pid and group signals alike, and excludes only probes', () => {
    const spy = installKillSpy();
    process.kill(-SANITY_PID, 'SIGTERM');
    process.kill(SANITY_PID, 0);
    process.kill(SANITY_PID, 'SIGKILL');
    // The POSITIVE-pid SIGTERM/SIGKILL is exactly what arms A2/A2b assert must
    // never happen, so the observer must be able to see it: discrimination is
    // on SIGNAL (probes carry 0 and deliver nothing), never on pid sign.
    expect(spy.drainSignals()).toEqual([
      { pid: -SANITY_PID, signal: 'SIGTERM' },
      { pid: SANITY_PID, signal: 'SIGKILL' },
    ]);
    expect(spy.drainSignals()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The identity witness: who is allowed to be signalled at all.
// ---------------------------------------------------------------------------

describe('killProcessTree — the persisted pid must be authorized by the runner\'s own heartbeat witness', () => {
  it('A1 — does not signal a watch whose heartbeat witness is ABSENT, and still signals a witnessed one', async () => {
    const dir = await tempDir();
    const spy = installKillSpy({ die_on_signal: true });

    // The runner COMPLETED: its last act is `rm(heartbeatFile, {force:true})`,
    // so nothing on disk attests that this number is still our runner. This is
    // the ordinary end state of every finished gate suite (ledger (a)), and the
    // number may have been recycled by the OS since.
    const orphaned = watchFor(dir, {
      pid: A1_ORPHANED_PID,
      heartbeat_file: path.join(dir, 'removed-heartbeat.json'),
    });
    await killProcessTree(orphaned, {
      stale_ms: STALE_MS,
      kill_grace_ms: 200,
      platform: 'linux',
    });
    expect(spy.drainSignals()).toEqual([]);

    // AUTHORIZED CONTROL, same it(): identical in every respect except that
    // the runner's own heartbeat attests THIS pid. The kill must still
    // happen — the guard authorizes, it does not disable.
    const witnessed = watchFor(dir, {
      pid: A1_WITNESSED_PID,
      heartbeat_file: await writeHeartbeat(dir, 'live-heartbeat.json', {
        pid: A1_WITNESSED_PID,
        beat_at: Date.now(),
      }),
    });
    await killProcessTree(witnessed, {
      stale_ms: STALE_MS,
      kill_grace_ms: 200,
      platform: 'linux',
    });
    expect(spy.drainSignals()).toEqual([{ pid: -A1_WITNESSED_PID, signal: 'SIGTERM' }]);
  });

  it('A2 — never signals the BARE persisted pid when the process group is already gone', async () => {
    const dir = await tempDir();
    // The recycled-pid hazard in its sharpest form: the process GROUP is
    // empty (kill(-pid, ...) => ESRCH) while the NUMBER itself is live and
    // signalable, i.e. it now belongs to something that is not ours. Today
    // the ESRCH is exactly what triggers the bare-pid catch-fallback.
    const spy = installKillSpy({
      live: (target) => target !== -A2_RECYCLED_PID,
      die_on_signal: true,
    });

    const recycled = watchFor(dir, {
      pid: A2_RECYCLED_PID,
      heartbeat_file: await writeHeartbeat(dir, 'recycled-heartbeat.json', {
        pid: A2_RECYCLED_PID,
        beat_at: Date.now(),
      }),
    });
    await killProcessTree(recycled, {
      stale_ms: STALE_MS,
      kill_grace_ms: 200,
      platform: 'linux',
    });
    // THIS ARM OWNS THE BARE-PID CONTRACT, and its filter is deliberate: the
    // contract is about the POSITIVE pid, not about whether the group signal
    // was attempted (a SIGTERM to an empty group is a harmless ESRCH; a SIGTERM
    // to the bare number is the stray signal this entry exists for). A10a is
    // the arm that asserts the STRICT emptiness this filter cannot.
    expect(spy.drainSignals().filter((call) => call.pid > 0)).toEqual([]);

    // AUTHORIZED CONTROL, same it(): a live group is still signalled.
    const witnessed = watchFor(dir, {
      pid: A2_WITNESSED_PID,
      heartbeat_file: await writeHeartbeat(dir, 'a2-live-heartbeat.json', {
        pid: A2_WITNESSED_PID,
        beat_at: Date.now(),
      }),
    });
    await killProcessTree(witnessed, {
      stale_ms: STALE_MS,
      kill_grace_ms: 200,
      platform: 'linux',
    });
    expect(spy.drainSignals()).toEqual([{ pid: -A2_WITNESSED_PID, signal: 'SIGTERM' }]);
  });

  it('A2b — when EVERY real signal on the group throws, both escalation catches stay off the bare pid', async () => {
    const dir = await tempDir();
    // The fixture the one-argument live() could not express, and the reason it
    // was widened: the liveness PROBE on -P succeeds (so the group reads as
    // present and the escalation loop keeps running), while every real signal
    // on -P throws (so BOTH catch blocks around process.kill are entered), and
    // the bare positive number is fully live and signalable. That is precisely
    // the state in which the deleted fallback would have delivered a SIGTERM
    // and then a SIGKILL to a stranger.
    const spy = installKillSpy({
      live: (target, signal) => !(target === -A2B_HOSTILE_PID && !isProbe(signal)),
      die_on_signal: true,
    });

    const hostile = watchFor(dir, {
      pid: A2B_HOSTILE_PID,
      heartbeat_file: await writeHeartbeat(dir, 'a2b-hostile-heartbeat.json', {
        pid: A2B_HOSTILE_PID,
        beat_at: Date.now(),
      }),
    });
    await killProcessTree(hostile, {
      stale_ms: STALE_MS,
      kill_grace_ms: 50,
      platform: 'linux',
    });
    const delivered = spy.drainSignals();
    expect(delivered).toEqual([
      { pid: -A2B_HOSTILE_PID, signal: 'SIGTERM' },
      { pid: -A2B_HOSTILE_PID, signal: 'SIGKILL' },
    ]);
    // Stated twice on purpose: the shape above already forbids a bare-pid
    // signal, and this is the contract restated in the terms the fallback was
    // written in, so a future reader cannot mistake the pair for incidental.
    expect(delivered.filter((call) => call.pid > 0)).toEqual([]);

    // AUTHORIZED CONTROL, same it(): an ordinary group that dies of the polite
    // signal takes SIGTERM only.
    const normal = watchFor(dir, {
      pid: A2B_CONTROL_PID,
      heartbeat_file: await writeHeartbeat(dir, 'a2b-control-heartbeat.json', {
        pid: A2B_CONTROL_PID,
        beat_at: Date.now(),
      }),
    });
    await killProcessTree(normal, {
      stale_ms: STALE_MS,
      kill_grace_ms: 50,
      platform: 'linux',
    });
    expect(spy.drainSignals()).toEqual([{ pid: -A2B_CONTROL_PID, signal: 'SIGTERM' }]);
  });

  it('A8 — vetoes a heartbeat that parses but names a DIFFERENT pid, and signals one that names this pid', async () => {
    const dir = await tempDir();
    const spy = installKillSpy({ die_on_signal: true });

    // Ledger (e). The witness is present, parseable and FRESH — everything the
    // freshness check wants — but it attests a different process. beat.pid is
    // the single mechanism that makes the heartbeat an IDENTITY witness rather
    // than a touch file, and it is never trusted alone: the file cannot
    // redirect the signal to whatever pid it names, it can only corroborate the
    // pid the runtime already persisted.
    const mismatched = watchFor(dir, {
      pid: A8_WATCH_PID,
      heartbeat_file: await writeHeartbeat(dir, 'a8-mismatch-heartbeat.json', {
        pid: A8_ATTESTING_PID,
        beat_at: Date.now(),
      }),
    });
    await killProcessTree(mismatched, {
      stale_ms: STALE_MS,
      kill_grace_ms: 200,
      platform: 'linux',
    });
    expect(spy.drainSignals()).toEqual([]);

    // AUTHORIZED CONTROL, same it(): identical but for the pid the heartbeat
    // names.
    const matched = watchFor(dir, {
      pid: A8_CONTROL_PID,
      heartbeat_file: await writeHeartbeat(dir, 'a8-match-heartbeat.json', {
        pid: A8_CONTROL_PID,
        beat_at: Date.now(),
      }),
    });
    await killProcessTree(matched, {
      stale_ms: STALE_MS,
      kill_grace_ms: 200,
      platform: 'linux',
    });
    expect(spy.drainSignals()).toEqual([{ pid: -A8_CONTROL_PID, signal: 'SIGTERM' }]);
  });

  it('A9 — vetoes a foreign-host watch AND a watch with no host at all, and signals a same-host one', async () => {
    const dir = await tempDir();
    const spy = installKillSpy({ die_on_signal: true });

    // A pid number means nothing off the machine that minted it. Each fixture
    // carries a FRESH heartbeat naming its own pid, so the host field is the
    // only thing standing between it and a signal.
    const foreign = watchFor(dir, {
      pid: A9_FOREIGN_PID,
      host: 'some-other-host',
      heartbeat_file: await writeHeartbeat(dir, 'a9-foreign-heartbeat.json', {
        pid: A9_FOREIGN_PID,
        beat_at: Date.now(),
      }),
    });
    await killProcessTree(foreign, {
      stale_ms: STALE_MS,
      kill_grace_ms: 200,
      platform: 'linux',
    });
    expect(spy.drainSignals()).toEqual([]);

    // THE TIGHTENING, pinned separately: the old fence was `typeof host ===
    // 'string' && host && host !== hostname()`, which skipped only a NON-EMPTY
    // mismatch — so a watch carrying no host at all was signalled on whatever
    // machine happened to read it. An exact `watch.host === hostname()` refuses
    // it.
    const hostless = watchFor(dir, {
      pid: A9_HOSTLESS_PID,
      host: undefined,
      heartbeat_file: await writeHeartbeat(dir, 'a9-hostless-heartbeat.json', {
        pid: A9_HOSTLESS_PID,
        beat_at: Date.now(),
      }),
    });
    await killProcessTree(hostless, {
      stale_ms: STALE_MS,
      kill_grace_ms: 200,
      platform: 'linux',
    });
    expect(spy.drainSignals()).toEqual([]);

    // AUTHORIZED CONTROL, same it(): this machine's own watch is signalled.
    const local = watchFor(dir, {
      pid: A9_CONTROL_PID,
      heartbeat_file: await writeHeartbeat(dir, 'a9-local-heartbeat.json', {
        pid: A9_CONTROL_PID,
        beat_at: Date.now(),
      }),
    });
    await killProcessTree(local, {
      stale_ms: STALE_MS,
      kill_grace_ms: 200,
      platform: 'linux',
    });
    expect(spy.drainSignals()).toEqual([{ pid: -A9_CONTROL_PID, signal: 'SIGTERM' }]);
  });

  it('A10a — a fresh witness does not authorize a signal once the GROUP is observably gone', async () => {
    const dir = await tempDir();
    // Same fixture family as A2 — group gone, number live — but asserted
    // STRICTLY, with no pid-sign filter at all. This is what A2 cannot say: not
    // merely "nothing positive was signalled" but "nothing was signalled",
    // which is the only assertion that observes the liveness probe standing
    // BEFORE the SIGTERM rather than the catch behind it.
    const spy = installKillSpy({
      live: (target) => target !== -A10A_GONE_GROUP_PID,
      die_on_signal: true,
    });

    const gone = watchFor(dir, {
      pid: A10A_GONE_GROUP_PID,
      heartbeat_file: await writeHeartbeat(dir, 'a10a-gone-heartbeat.json', {
        pid: A10A_GONE_GROUP_PID,
        beat_at: Date.now(),
      }),
    });
    await killProcessTree(gone, {
      stale_ms: STALE_MS,
      kill_grace_ms: 200,
      platform: 'linux',
    });
    expect(spy.drainSignals()).toEqual([]);

    // AUTHORIZED CONTROL, same it(): a group that IS there is signalled.
    const present = watchFor(dir, {
      pid: A10A_CONTROL_PID,
      heartbeat_file: await writeHeartbeat(dir, 'a10a-present-heartbeat.json', {
        pid: A10A_CONTROL_PID,
        beat_at: Date.now(),
      }),
    });
    await killProcessTree(present, {
      stale_ms: STALE_MS,
      kill_grace_ms: 200,
      platform: 'linux',
    });
    expect(spy.drainSignals()).toEqual([{ pid: -A10A_CONTROL_PID, signal: 'SIGTERM' }]);
  });

  it('A18 — a watch whose pid getter THROWS resolves undefined and signals nothing', async () => {
    const dir = await tempDir();
    const spy = installKillSpy({ die_on_signal: true });

    // Both call sites await this INSIDE the receipt-effects critical section,
    // where a rejection would break the abort itself: the run would never seal.
    // A throwing property getter is the smallest fixture that reaches the
    // function-wide catch without stubbing anything the function calls.
    const hostile = watchFor(dir, {
      heartbeat_file: await writeHeartbeat(dir, 'a18-hostile-heartbeat.json', {
        pid: A18_THROWING_PID,
        beat_at: Date.now(),
      }),
    });
    Object.defineProperty(hostile, 'pid', {
      configurable: true,
      enumerable: true,
      get() {
        throw new Error('boom');
      },
    });
    const settled = killProcessTree(hostile, {
      stale_ms: STALE_MS,
      kill_grace_ms: 200,
      platform: 'linux',
    });
    // AWAITABLE FIRST, then resolved. Asserted in that order deliberately: both
    // call sites `await` this, so a non-thenable return is itself a contract
    // break, and checking it as an ordinary value keeps the failure an
    // assertion about behavior rather than a harness TypeError from `.resolves`.
    expect(typeof settled?.then).toBe('function');
    await expect(settled).resolves.toBeUndefined();
    expect(spy.drainSignals()).toEqual([]);

    // AUTHORIZED CONTROL, same it(): an ordinary watch still resolves AND still
    // kills, so "never throws" is not being met by never doing anything.
    const normal = watchFor(dir, {
      pid: A18_CONTROL_PID,
      heartbeat_file: await writeHeartbeat(dir, 'a18-control-heartbeat.json', {
        pid: A18_CONTROL_PID,
        beat_at: Date.now(),
      }),
    });
    await expect(
      killProcessTree(normal, { stale_ms: STALE_MS, kill_grace_ms: 200, platform: 'linux' }),
    ).resolves.toBeUndefined();
    expect(spy.drainSignals()).toEqual([{ pid: -A18_CONTROL_PID, signal: 'SIGTERM' }]);
  });
});

// ---------------------------------------------------------------------------
// The bounded, awaited, group-observing escalation.
// ---------------------------------------------------------------------------

describe('killProcessTree — the SIGKILL escalation is owed and delivered inside the call', () => {
  it('A3 — escalates a SIGTERM-surviving group to SIGKILL inside the awaited call', async () => {
    const dir = await tempDir();
    // A suite that ignores SIGTERM: the group stays alive no matter what is
    // delivered, so only the escalation can end it.
    const spy = installKillSpy({ die_on_signal: false });

    const watch = watchFor(dir, {
      pid: A3_SURVIVING_PID,
      heartbeat_file: await writeHeartbeat(dir, 'surviving-heartbeat.json', {
        pid: A3_SURVIVING_PID,
        beat_at: Date.now(),
      }),
    });
    await killProcessTree(watch, {
      stale_ms: STALE_MS,
      kill_grace_ms: 250,
      platform: 'linux',
    });

    // Both signals are OWED by the time the promise resolves — no unref'd
    // timer, no signal left to a process that may exit first. The exact PAIR
    // also pins that the escalation is SIGKILL and that it goes to the GROUP.
    expect(spy.drainSignals()).toEqual([
      { pid: -A3_SURVIVING_PID, signal: 'SIGTERM' },
      { pid: -A3_SURVIVING_PID, signal: 'SIGKILL' },
    ]);
  });

  it('A4 — leaves no delayed signal armed once the group is gone', async () => {
    const dir = await tempDir();
    // PITFALL, handled: vitest's fake timers fake Date.now() too, so the
    // heartbeat is stamped from the real clock and the fake clock is then
    // PINNED to that same instant (`beatAt`). A beat_at from the other clock
    // would invert the freshness check. shouldAdvanceTime keeps the fake
    // clock moving with real time so the awaited escalation still resolves.
    const beatAt = Date.now();
    const heartbeatFile = await writeHeartbeat(dir, 'dying-heartbeat.json', {
      pid: A4_DYING_PID,
      beat_at: beatAt,
    });
    vi.useFakeTimers({ shouldAdvanceTime: true, now: beatAt });

    const spy = installKillSpy({ die_on_signal: true });
    const watch = watchFor(dir, { pid: A4_DYING_PID, heartbeat_file: heartbeatFile });
    await killProcessTree(watch, {
      stale_ms: STALE_MS,
      kill_grace_ms: 200,
      platform: 'linux',
    });
    expect(spy.drainSignals()).toEqual([{ pid: -A4_DYING_PID, signal: 'SIGTERM' }]);

    // Past DEFAULT_KILL_GRACE_MS (10s): today's orphaned unref'd escalate
    // timer would fire a stray SIGKILL here, at a group that died long ago
    // and a number the OS is free to hand out again.
    vi.advanceTimersByTime(11_000);
    await Promise.resolve();
    expect(spy.drainSignals()).toEqual([]);
  });

  it('A12 — a degenerate kill_grace_ms still re-probes before escalating, so a dead group is never SIGKILLed', async () => {
    const dir = await tempDir();
    // DETERMINISTIC BY CONSTRUCTION, with REAL timers: the clock is pinned with
    // vi.spyOn(Date, 'now') rather than faked, so the awaited sleep still
    // resolves off the real event loop and the arm terminates in ONE loop
    // iteration. (Fake timers hang here: the loop awaits a timer nothing is
    // advancing.)
    const T = Date.now();
    const heartbeatFile = await writeHeartbeat(dir, 'a12-heartbeat.json', {
      pid: A12_FLOORED_GRACE_PID,
      beat_at: T,
    });
    vi.spyOn(Date, 'now').mockReturnValue(T);

    const spy = installKillSpy({ die_on_signal: true });
    const watch = watchFor(dir, {
      pid: A12_FLOORED_GRACE_PID,
      heartbeat_file: heartbeatFile,
      created_at: new Date(T).toISOString(),
    });
    // kill_grace_ms 0 is the degenerate input: a grace that does not survive to
    // a positive window collapses the escalation into a BLIND SIGKILL fired
    // with no re-probe between it and the SIGTERM — the exact blind escalation
    // this function exists to replace. The group here dies of the polite
    // signal, so a correct implementation observes that and stops.
    await killProcessTree(watch, {
      stale_ms: STALE_MS,
      kill_grace_ms: 0,
      platform: 'linux',
    });
    // This assertion IS the authorized control: the SIGTERM must be delivered
    // (red today), and the SIGKILL must NOT follow it.
    expect(spy.drainSignals()).toEqual([{ pid: -A12_FLOORED_GRACE_PID, signal: 'SIGTERM' }]);
  });
});

// ---------------------------------------------------------------------------
// win32: fresh-witness only, and the pid guard.
// ---------------------------------------------------------------------------

describe('killProcessTree — win32 taskkill runs only under a fresh witness', () => {
  it('A5 — skips taskkill for a stale witness and issues the exact taskkill argv for a fresh one', async () => {
    const dir = await tempDir();
    const spy = installKillSpy();

    // Deliberately WITHIN the armed lifetime: the POSIX age fence would
    // authorize this very watch (that is arm A6a), and win32 still must not
    // act — `taskkill /T` walks a live parent-pid chain that a dead runner has
    // already broken, so there is no orphan branch to be had there (ledger (d)).
    const stale = watchFor(dir, {
      pid: A5_STALE_PID,
      heartbeat_file: await writeHeartbeat(dir, 'win32-stale-heartbeat.json', {
        pid: A5_STALE_PID,
        beat_at: Date.now() - AGED_MS,
      }),
    });
    await killProcessTree(stale, { stale_ms: STALE_MS, platform: 'win32' });
    expect(taskkillSpawns).toEqual([]);

    // AUTHORIZED CONTROL, same it(): a fresh witness still gets the identical
    // taskkill invocation shipping today, options included.
    const fresh = watchFor(dir, {
      pid: A5_FRESH_PID,
      heartbeat_file: await writeHeartbeat(dir, 'win32-fresh-heartbeat.json', {
        pid: A5_FRESH_PID,
        beat_at: Date.now(),
      }),
    });
    await killProcessTree(fresh, { stale_ms: STALE_MS, platform: 'win32' });
    expect(taskkillArgv()).toEqual([expectedTaskkill(A5_FRESH_PID)]);
    expect(taskkillSpawns[0].options).toEqual({ stdio: 'ignore', windowsHide: true });
    // No POSIX group signal is delivered on the win32 branch; the only
    // process.kill it may make is the bare-pid liveness PROBE (signal 0).
    expect(spy.drainSignals()).toEqual([]);
  });

  it('A10b — win32 does not taskkill a pid that is no longer there, even under a fresh witness', async () => {
    const dir = await tempDir();
    // The win32 counterpart of A10a: the witness is fresh, but the number
    // itself no longer answers, so the runner is gone and the number is
    // eligible for reuse. taskkill /T on it would walk a stranger's tree.
    const spy = installKillSpy({ live: (target) => target !== A10B_GONE_PID });

    const gone = watchFor(dir, {
      pid: A10B_GONE_PID,
      heartbeat_file: await writeHeartbeat(dir, 'a10b-gone-heartbeat.json', {
        pid: A10B_GONE_PID,
        beat_at: Date.now(),
      }),
    });
    await killProcessTree(gone, { stale_ms: STALE_MS, platform: 'win32' });
    expect(taskkillSpawns).toEqual([]);

    // AUTHORIZED CONTROL, same it(): a pid that IS there is taskkilled.
    const present = watchFor(dir, {
      pid: A10B_CONTROL_PID,
      heartbeat_file: await writeHeartbeat(dir, 'a10b-present-heartbeat.json', {
        pid: A10B_CONTROL_PID,
        beat_at: Date.now(),
      }),
    });
    await killProcessTree(present, { stale_ms: STALE_MS, platform: 'win32' });
    expect(taskkillArgv()).toEqual([expectedTaskkill(A10B_CONTROL_PID)]);
    // The probe is the only process.kill the win32 branch makes.
    expect(spy.drainSignals()).toEqual([]);
  });

  it('A11a — refuses pid 1 and a non-integer pid, and accepts an ordinary one', async () => {
    const dir = await tempDir();
    const spy = installKillSpy();

    // ON THE WIN32 BRANCH ON PURPOSE. Under a MUTATED tree these two fixtures
    // reach the platform branch's only syscall, and on win32 that syscall is
    // `process.kill(pid, 0)` — a PROBE, which delivers nothing. The POSIX
    // branch would instead reach `process.kill(-1, 'SIGTERM')`, a machine-wide
    // BROADCAST; vitest 4's forks pool gives the worker no process group of its
    // own, so under a mutation that broadcast would escape into the whole
    // `npm test` job. The guard is platform-independent, so pinning it on the
    // harmless branch costs nothing.
    //
    // EACH FIXTURE CARRIES A HEARTBEAT NAMING ITS OWN pid VALUE. Without that
    // the identity witness vetoes first and the arm is vacuous under exactly
    // the mutants it exists to catch.
    const initPid = watchFor(dir, {
      pid: A11A_INIT_PID,
      heartbeat_file: await writeHeartbeat(dir, 'a11a-init-heartbeat.json', {
        pid: A11A_INIT_PID,
        beat_at: Date.now(),
      }),
    });
    await killProcessTree(initPid, { stale_ms: STALE_MS, platform: 'win32' });
    expect(taskkillSpawns).toEqual([]);

    const fractional = watchFor(dir, {
      pid: A11A_FRACTIONAL_PID,
      heartbeat_file: await writeHeartbeat(dir, 'a11a-fractional-heartbeat.json', {
        pid: A11A_FRACTIONAL_PID,
        beat_at: Date.now(),
      }),
    });
    await killProcessTree(fractional, { stale_ms: STALE_MS, platform: 'win32' });
    expect(taskkillSpawns).toEqual([]);

    // AUTHORIZED CONTROL, same it(): an ordinary integer pid above 1 acts.
    const ordinary = watchFor(dir, {
      pid: A11A_CONTROL_PID,
      heartbeat_file: await writeHeartbeat(dir, 'a11a-control-heartbeat.json', {
        pid: A11A_CONTROL_PID,
        beat_at: Date.now(),
      }),
    });
    await killProcessTree(ordinary, { stale_ms: STALE_MS, platform: 'win32' });
    expect(taskkillArgv()).toEqual([expectedTaskkill(A11A_CONTROL_PID)]);
    expect(spy.drainSignals()).toEqual([]);
  });

  it('A16 — the SAME watch is killed under a configured stale_ms and vetoed under the built-in default', async () => {
    const dir = await tempDir();
    const spy = installKillSpy();

    // THE ONE ARM THAT OBSERVES THE stale_ms PARAMETER AT ALL. Every other arm
    // passes STALE_MS explicitly, and STALE_MS equals the shipped
    // KILL_IDENTITY_STALE_MS, so replacing the whole options.stale_ms lookup
    // with the bare constant is invisible to all of them. Here one watch, one
    // beat age of 45s, and two option sets reach OPPOSITE verdicts: 45s is
    // inside a configured 90s window and outside the 30s default, with a 15s
    // margin against the default and a 45s margin against the configured value,
    // so neither side can race the wall clock.
    //
    // WHY IT MATTERS IN PRODUCTION: both service.js call sites pass
    // { stale_ms: config.gates?.stale_ms }, the same operator knob the A2
    // respawn fence in gates.js reads. Without the wiring, an operator who
    // raised gates.stale_ms would make every win32 abort veto its taskkill
    // against a runner the runtime's own poll path still considered alive.
    const watch = watchFor(dir, {
      pid: A16_CONFIGURED_PID,
      heartbeat_file: await writeHeartbeat(dir, 'a16-heartbeat.json', {
        pid: A16_CONFIGURED_PID,
        beat_at: Date.now() - 45_000,
      }),
    });

    await killProcessTree(watch, { stale_ms: 90_000, platform: 'win32' });
    expect(taskkillArgv()).toEqual([expectedTaskkill(A16_CONFIGURED_PID)]);

    resetTaskkills();
    await killProcessTree(watch, { platform: 'win32' });
    expect(taskkillSpawns).toEqual([]);
    expect(spy.drainSignals()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Freshness, and the armed-lifetime age fence that authorizes the orphan case.
// ---------------------------------------------------------------------------

describe('killProcessTree — freshness and the armed-lifetime age fence', () => {
  it('A6a — still kills a STALE-witnessed runner that is inside its armed lifetime', async () => {
    const dir = await tempDir();
    const spy = installKillSpy({ die_on_signal: true });

    // The orphaned-suite case the A6 contract exists for: the runner stopped
    // heartbeating (crashed, or was stopped) but its watch was created
    // moments ago, so the suite grandchild it fanned out is very plausibly
    // still running and still writing the tree. Skipping here would trade the
    // stray-signal hazard for a false NEGATIVE, which invariant 4 forbids.
    const watch = watchFor(dir, {
      pid: A6A_ORPHAN_SUITE_PID,
      heartbeat_file: await writeHeartbeat(dir, 'stale-heartbeat.json', {
        pid: A6A_ORPHAN_SUITE_PID,
        beat_at: Date.now() - AGED_MS,
      }),
    });
    await killProcessTree(watch, {
      stale_ms: STALE_MS,
      kill_grace_ms: 200,
      platform: 'linux',
    });
    expect(spy.drainSignals()).toEqual([{ pid: -A6A_ORPHAN_SUITE_PID, signal: 'SIGTERM' }]);
  });

  it('A6b — vetoes a stale witness whose watch is past its armed lifetime, and not one inside it', async () => {
    const dir = await tempDir();
    const spy = installKillSpy({ die_on_signal: true });

    // The AGE of the persisted pid, which is the acceptance bar this roadmap
    // entry sets: the watch was armed for ARMED_TIMEOUT_MS and created AGED_MS
    // ago, so even the runner's own deadline plus the lifetime slack cannot
    // explain a live runner (ledger (c) — with the recorded respawn exception).
    const expired = watchFor(dir, {
      pid: A6B_EXPIRED_PID,
      created_at: new Date(Date.now() - AGED_MS).toISOString(),
      heartbeat_file: await writeHeartbeat(dir, 'expired-heartbeat.json', {
        pid: A6B_EXPIRED_PID,
        beat_at: Date.now() - AGED_MS,
      }),
    });
    await killProcessTree(expired, {
      stale_ms: STALE_MS,
      kill_grace_ms: 200,
      platform: 'linux',
    });
    expect(spy.drainSignals()).toEqual([]);

    // AUTHORIZED CONTROL, same it(): IDENTICALLY stale, differing only in
    // created_at. The fence is about the watch's AGE, not its staleness.
    const within = watchFor(dir, {
      pid: A6B_WITHIN_PID,
      heartbeat_file: await writeHeartbeat(dir, 'within-heartbeat.json', {
        pid: A6B_WITHIN_PID,
        beat_at: Date.now() - AGED_MS,
      }),
    });
    await killProcessTree(within, {
      stale_ms: STALE_MS,
      kill_grace_ms: 200,
      platform: 'linux',
    });
    expect(spy.drainSignals()).toEqual([{ pid: -A6B_WITHIN_PID, signal: 'SIGTERM' }]);
  });

  it('A10c — an unparseable created_at FAILS CLOSED for a stale witness', async () => {
    const dir = await tempDir();
    const spy = installKillSpy({ die_on_signal: true });
    const now = Date.now();

    // No age evidence, no kill. The fence's whole job is to bound how old a
    // persisted pid may be before it stops meaning anything, and a timestamp
    // that does not parse is not an answer to that question.
    const unparseable = watchFor(dir, {
      pid: A10C_UNPARSEABLE_PID,
      created_at: 'not-a-date',
      heartbeat_file: await writeHeartbeat(dir, 'a10c-unparseable-heartbeat.json', {
        pid: A10C_UNPARSEABLE_PID,
        beat_at: now - AGED_MS,
      }),
    });
    await killProcessTree(unparseable, {
      stale_ms: STALE_MS,
      kill_grace_ms: 200,
      platform: 'linux',
    });
    expect(spy.drainSignals()).toEqual([]);

    // AUTHORIZED CONTROL, same it(): an IDENTICALLY stale witness whose
    // created_at parses and is inside the lifetime is still killed.
    const parseable = watchFor(dir, {
      pid: A10C_CONTROL_PID,
      created_at: new Date(now).toISOString(),
      heartbeat_file: await writeHeartbeat(dir, 'a10c-parseable-heartbeat.json', {
        pid: A10C_CONTROL_PID,
        beat_at: now - AGED_MS,
      }),
    });
    await killProcessTree(parseable, {
      stale_ms: STALE_MS,
      kill_grace_ms: 200,
      platform: 'linux',
    });
    expect(spy.drainSignals()).toEqual([{ pid: -A10C_CONTROL_PID, signal: 'SIGTERM' }]);
  });

  it('A11b/c — a beat stamped in the FUTURE is not fresh, on POSIX and on win32 alike', async () => {
    const dir = await tempDir();
    const spy = installKillSpy({ die_on_signal: true });
    const now = Date.now();

    // beat_at is FILE-supplied. An unclamped `Date.now() - beat_at <= staleMs`
    // reads any future timestamp as MAXIMALLY fresh, which is a file-controlled
    // widener of the authorization to signal. A beat stamped in the future is
    // not evidence of liveness, so it must read as NOT fresh.
    //
    // THE PAST-LIFETIME created_at IS MANDATORY on the POSIX half: with a young
    // watch the age fence would authorize the kill on its own and the arm would
    // be green under the very mutation it exists to catch.
    const posixFuture = watchFor(dir, {
      pid: A11B_FUTURE_BEAT_PID,
      created_at: new Date(now - AGED_MS).toISOString(),
      heartbeat_file: await writeHeartbeat(dir, 'a11b-future-heartbeat.json', {
        pid: A11B_FUTURE_BEAT_PID,
        beat_at: now + AGED_MS,
      }),
    });
    await killProcessTree(posixFuture, {
      stale_ms: STALE_MS,
      kill_grace_ms: 200,
      platform: 'linux',
    });
    expect(spy.drainSignals()).toEqual([]);

    // AUTHORIZED CONTROL, same it(): identical in every field except the SIGN
    // of the beat's offset — a beat stamped now IS fresh, and a fresh witness
    // acts even past the armed lifetime.
    const posixNow = watchFor(dir, {
      pid: A11B_CONTROL_PID,
      created_at: new Date(now - AGED_MS).toISOString(),
      heartbeat_file: await writeHeartbeat(dir, 'a11b-now-heartbeat.json', {
        pid: A11B_CONTROL_PID,
        beat_at: now,
      }),
    });
    await killProcessTree(posixNow, {
      stale_ms: STALE_MS,
      kill_grace_ms: 200,
      platform: 'linux',
    });
    expect(spy.drainSignals()).toEqual([{ pid: -A11B_CONTROL_PID, signal: 'SIGTERM' }]);

    // The win32 half needs no lifetime setup: that branch is fresh-witness only,
    // so "not fresh" is the whole verdict.
    const winFuture = watchFor(dir, {
      pid: A11C_FUTURE_BEAT_PID,
      heartbeat_file: await writeHeartbeat(dir, 'a11c-future-heartbeat.json', {
        pid: A11C_FUTURE_BEAT_PID,
        beat_at: now + AGED_MS,
      }),
    });
    await killProcessTree(winFuture, { stale_ms: STALE_MS, platform: 'win32' });
    expect(taskkillSpawns).toEqual([]);

    const winNow = watchFor(dir, {
      pid: A11C_CONTROL_PID,
      heartbeat_file: await writeHeartbeat(dir, 'a11c-now-heartbeat.json', {
        pid: A11C_CONTROL_PID,
        beat_at: now,
      }),
    });
    await killProcessTree(winNow, { stale_ms: STALE_MS, platform: 'win32' });
    expect(taskkillArgv()).toEqual([expectedTaskkill(A11C_CONTROL_PID)]);
  });

  it('A11d — a created_at stamped in the FUTURE is not inside the armed lifetime', async () => {
    const dir = await tempDir();
    const spy = installKillSpy({ die_on_signal: true });
    const now = Date.now();

    // The same clamp on the other timestamp. An unclamped `age <= bound` reads
    // every future created_at as inside the lifetime, so a timestamp that is
    // not evidence of youth would widen the authorization to signal.
    const future = watchFor(dir, {
      pid: A11D_FUTURE_CREATED_PID,
      created_at: new Date(now + AGED_MS).toISOString(),
      heartbeat_file: await writeHeartbeat(dir, 'a11d-future-heartbeat.json', {
        pid: A11D_FUTURE_CREATED_PID,
        beat_at: now - AGED_MS,
      }),
    });
    await killProcessTree(future, {
      stale_ms: STALE_MS,
      kill_grace_ms: 200,
      platform: 'linux',
    });
    expect(spy.drainSignals()).toEqual([]);

    // AUTHORIZED CONTROL, same it(): IDENTICALLY stale, created_at now.
    const present = watchFor(dir, {
      pid: A11D_CONTROL_PID,
      created_at: new Date(now).toISOString(),
      heartbeat_file: await writeHeartbeat(dir, 'a11d-present-heartbeat.json', {
        pid: A11D_CONTROL_PID,
        beat_at: now - AGED_MS,
      }),
    });
    await killProcessTree(present, {
      stale_ms: STALE_MS,
      kill_grace_ms: 200,
      platform: 'linux',
    });
    expect(spy.drainSignals()).toEqual([{ pid: -A11D_CONTROL_PID, signal: 'SIGTERM' }]);
  });

  it('A13 — a heartbeat with NO beat_at key is not fresh, on win32 and on POSIX alike', async () => {
    const dir = await tempDir();
    const spy = installKillSpy({ die_on_signal: true });
    const now = Date.now();

    // A TIMESTAMPLESS heartbeat is the sharpest edge of the freshness check,
    // because the obvious simplification is silently catastrophic: with the
    // "there is no age at all" sentinel folded away, ToNumber(null) is +0, so
    // `null >= 0` and `null <= staleMs` are BOTH true and a heartbeat carrying
    // no timestamp reads as MAXIMALLY fresh — the most permissive verdict, from
    // the least evidence.
    const winNoBeat = watchFor(dir, {
      pid: A13_WIN32_PID,
      heartbeat_file: await writeHeartbeat(dir, 'a13-win32-heartbeat.json', {
        pid: A13_WIN32_PID,
      }),
    });
    await killProcessTree(winNoBeat, { stale_ms: STALE_MS, platform: 'win32' });
    expect(taskkillSpawns).toEqual([]);

    // AUTHORIZED CONTROL, same it(): the identical heartbeat plus a beat_at.
    const winBeat = watchFor(dir, {
      pid: A13_WIN32_CONTROL_PID,
      heartbeat_file: await writeHeartbeat(dir, 'a13-win32-control-heartbeat.json', {
        pid: A13_WIN32_CONTROL_PID,
        beat_at: now,
      }),
    });
    await killProcessTree(winBeat, { stale_ms: STALE_MS, platform: 'win32' });
    expect(taskkillArgv()).toEqual([expectedTaskkill(A13_WIN32_CONTROL_PID)]);

    // POSIX half. The past-lifetime created_at is mandatory for the same reason
    // as A11b: otherwise the age fence authorizes the kill regardless of what
    // freshness decided.
    const posixNoBeat = watchFor(dir, {
      pid: A13_POSIX_PID,
      created_at: new Date(now - AGED_MS).toISOString(),
      heartbeat_file: await writeHeartbeat(dir, 'a13-posix-heartbeat.json', {
        pid: A13_POSIX_PID,
      }),
    });
    await killProcessTree(posixNoBeat, {
      stale_ms: STALE_MS,
      kill_grace_ms: 200,
      platform: 'linux',
    });
    expect(spy.drainSignals()).toEqual([]);

    const posixBeat = watchFor(dir, {
      pid: A13_POSIX_CONTROL_PID,
      created_at: new Date(now - AGED_MS).toISOString(),
      heartbeat_file: await writeHeartbeat(dir, 'a13-posix-control-heartbeat.json', {
        pid: A13_POSIX_CONTROL_PID,
        beat_at: now,
      }),
    });
    await killProcessTree(posixBeat, {
      stale_ms: STALE_MS,
      kill_grace_ms: 200,
      platform: 'linux',
    });
    expect(spy.drainSignals()).toEqual([{ pid: -A13_POSIX_CONTROL_PID, signal: 'SIGTERM' }]);
  });

  it('A14 — a FRESH witness authorizes the kill even past the armed lifetime', async () => {
    const dir = await tempDir();
    const spy = installKillSpy({ die_on_signal: true });
    const now = Date.now();

    // The age fence gates the STALE branch ONLY. A runner that is heartbeating
    // RIGHT NOW is alive by direct attestation, and no amount of elapsed
    // wall-clock time makes that evidence weaker — an over-running suite is
    // exactly the case an abort exists for. A fence that also vetoed the fresh
    // case would leave a live, attesting, tree-writing runner alone.
    const freshPastLifetime = watchFor(dir, {
      pid: A14_FRESH_PID,
      created_at: new Date(now - AGED_MS).toISOString(),
      heartbeat_file: await writeHeartbeat(dir, 'a14-fresh-heartbeat.json', {
        pid: A14_FRESH_PID,
        beat_at: now,
      }),
    });
    await killProcessTree(freshPastLifetime, {
      stale_ms: STALE_MS,
      kill_grace_ms: 200,
      platform: 'linux',
    });
    expect(spy.drainSignals()).toEqual([{ pid: -A14_FRESH_PID, signal: 'SIGTERM' }]);

    // The other side, same it(): identical watch, stale beat — now the fence
    // does apply and vetoes.
    const stalePastLifetime = watchFor(dir, {
      pid: A14_STALE_PID,
      created_at: new Date(now - AGED_MS).toISOString(),
      heartbeat_file: await writeHeartbeat(dir, 'a14-stale-heartbeat.json', {
        pid: A14_STALE_PID,
        beat_at: now - AGED_MS,
      }),
    });
    await killProcessTree(stalePastLifetime, {
      stale_ms: STALE_MS,
      kill_grace_ms: 200,
      platform: 'linux',
    });
    expect(spy.drainSignals()).toEqual([]);
  });

  it('A15 — a watch with no timeout_ms is fenced by the 30-minute armed default', async () => {
    const dir = await tempDir();
    const spy = installKillSpy({ die_on_signal: true });
    const now = Date.now();

    // runner.js falls back to 30 minutes for a non-finite job timeout_ms; the
    // fence mirrors that number so the two cannot disagree about how long a
    // runner is allowed to live. 10 minutes is inside it by 21 minutes of
    // margin.
    const within = watchFor(dir, {
      pid: A15_DEFAULT_WITHIN_PID,
      timeout_ms: undefined,
      created_at: new Date(now - 10 * 60_000).toISOString(),
      heartbeat_file: await writeHeartbeat(dir, 'a15-within-heartbeat.json', {
        pid: A15_DEFAULT_WITHIN_PID,
        beat_at: now - AGED_MS,
      }),
    });
    await killProcessTree(within, {
      stale_ms: STALE_MS,
      kill_grace_ms: 200,
      platform: 'linux',
    });
    expect(spy.drainSignals()).toEqual([{ pid: -A15_DEFAULT_WITHIN_PID, signal: 'SIGTERM' }]);

    // 40 minutes is outside it by 9 minutes of margin.
    const past = watchFor(dir, {
      pid: A15_DEFAULT_PAST_PID,
      timeout_ms: undefined,
      created_at: new Date(now - 40 * 60_000).toISOString(),
      heartbeat_file: await writeHeartbeat(dir, 'a15-past-heartbeat.json', {
        pid: A15_DEFAULT_PAST_PID,
        beat_at: now - AGED_MS,
      }),
    });
    await killProcessTree(past, {
      stale_ms: STALE_MS,
      kill_grace_ms: 200,
      platform: 'linux',
    });
    expect(spy.drainSignals()).toEqual([]);
  });

  it('A17 — the armed lifetime is the watch timeout PLUS a 60s shutdown slack', async () => {
    const dir = await tempDir();
    const spy = installKillSpy({ die_on_signal: true });
    const now = Date.now();

    // A runner may outlive its own armed deadline by its bounded shutdown
    // (spawnWithTimeout's 2 * kill grace + drain = 25s) plus margin for the
    // artifact write and host scheduling. With timeout_ms 60s the bound is
    // 120s: a 90s-old watch is inside it (30s of margin) and a 150s-old watch
    // is outside it (30s of margin). Drop the slack and the first fixture
    // flips.
    const withinSlack = watchFor(dir, {
      pid: A17_WITHIN_SLACK_PID,
      timeout_ms: 60_000,
      created_at: new Date(now - 90_000).toISOString(),
      heartbeat_file: await writeHeartbeat(dir, 'a17-within-heartbeat.json', {
        pid: A17_WITHIN_SLACK_PID,
        beat_at: now - AGED_MS,
      }),
    });
    await killProcessTree(withinSlack, {
      stale_ms: STALE_MS,
      kill_grace_ms: 200,
      platform: 'linux',
    });
    expect(spy.drainSignals()).toEqual([{ pid: -A17_WITHIN_SLACK_PID, signal: 'SIGTERM' }]);

    const pastSlack = watchFor(dir, {
      pid: A17_PAST_SLACK_PID,
      timeout_ms: 60_000,
      created_at: new Date(now - 150_000).toISOString(),
      heartbeat_file: await writeHeartbeat(dir, 'a17-past-heartbeat.json', {
        pid: A17_PAST_SLACK_PID,
        beat_at: now - AGED_MS,
      }),
    });
    await killProcessTree(pastSlack, {
      stale_ms: STALE_MS,
      kill_grace_ms: 200,
      platform: 'linux',
    });
    expect(spy.drainSignals()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The deliberate constant duplication
// ---------------------------------------------------------------------------

describe('killProcessTree — identity-staleness constant', () => {
  it('A7 — KILL_IDENTITY_STALE_MS mirrors constants.js GATE_RUNNER_STALE_MS', () => {
    // spawn.js keeps its imports to node builtins by CONVENTION (the detached
    // runner's whole dependency surface is then one auditable file), so this
    // value is duplicated on purpose rather than imported. This is the drift
    // pin that keeps the two definitions equal, read off the module NAMESPACE
    // so a missing export is one red assertion rather than a link-time failure
    // of the whole file.
    expect(spawnModule.KILL_IDENTITY_STALE_MS).toBe(GATE_RUNNER_STALE_MS);
  });
});
