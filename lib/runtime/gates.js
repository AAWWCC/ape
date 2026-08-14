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

// Bounded helper for non-suite gate commands (`gh pr checks --watch` runs for
// up to 45 minutes). Tree kill with escalation and a drained settle live in
// spawnWithTimeout: a gh invocation that outlives its deadline must never
// park the merge inside the receipt-effects lock. Output stays interleaved
// stdout+stderr by arrival, which the PR-URL scan below relies on.
async function run(command, args, cwd, timeoutMs = 120_000) {
  const result = await spawnWithTimeout(command, args, {
    cwd,
    shell: false,
    collect: 'combined',
    timeout_ms: timeoutMs,
  });
  if (result.spawn_error) {
    return { passed: false, exit_code: null, output: result.spawn_error.message };
  }
  return {
    passed: result.exit_code === 0 && result.timed_out !== true,
    exit_code: result.exit_code,
    output: result.combined,
    ...(result.timed_out === true ? { timed_out: true } : {}),
  };
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

export function evaluateMergePrerequisites({
  receipts,
  lane,
  security_review_required,
  full_suite,
  unexpected_dirty,
  plugin_validation,
  tree_binding,
  targeted = null,
}) {
  const targetedReceipts = receipts.filter((receipt) =>
    receipt.tests.some((test) => test.passed) &&
    ['implementer', 'test_writer'].includes(receipt.agent.role));
  const receiptChainValid = receipts.every((receipt, index) =>
    receipt.previous_receipt_hash === (receipts[index - 1]?.receipt_hash ?? null));
  // receipt.tests[] is agent-asserted and never executed by the runtime, so it
  // is advisory evidence only and can NEVER decide the gate on a behavioral
  // lane (F12): fabricated receipt evidence must not ship. The gate passes
  // only on a runtime-executed result (configured or derived command); the
  // mechanical lane, which requires no behavioral tests, keeps its
  // unconditional pass.
  const advisory = { source: 'receipt.tests', receipts_with_passing_tests: targetedReceipts.length };
  const targetedTests = targeted?.executed === true
    ? {
        passed: targeted.passed === true,
        verified: true,
        command: targeted.command,
        result_hash: targeted.result_hash,
        // Polyglot: the AND is over per-runner targeted verdicts, each scoped to
        // its own test paths and run at its own root (single keeps no runners[]).
        ...(targeted.runners ? { runners: targeted.runners } : {}),
        ...(targeted.derived === true ? { derived: true, test_paths: targeted.test_paths } : {}),
        // Surface a deadline kill as the cause (absent-when-false so the
        // check shape is unchanged on every ordinary verdict): a blocked
        // operator must be able to tell "your tests are red" from "your
        // suite outlived the lane deadline and was killed".
        ...(targeted.verification?.timed_out === true ? { timed_out: true } : {}),
        advisory,
      }
    : {
        passed: lane === 'mechanical',
        verified: false,
        advisory,
        ...(lane === 'mechanical' ? {} : {
          // prose-bound-exempt: targeted.reason is always one of this module's own
          // fixed tooling-diagnostic strings (evaluateTargetedRunners/evaluateGates
          // below), and the fallback is itself a fixed literal; never agent- or
          // attacker-controlled text.
          reason: targeted?.reason
            // prose-bound-exempt: targeted.reason is always one of this module's
            // own fixed tooling-diagnostic strings (evaluateTargetedRunners/
            // evaluateGates below), and this fallback is itself a fixed literal.
            ?? 'behavioral lanes require runtime-executed targeted tests; configure test_commands.targeted',
        }),
      };
  const checks = {
    receipts: { passed: receiptChainValid && receipts.length > 0 },
    clean_tree: { passed: unexpected_dirty.length === 0, unexpected: unexpected_dirty },
    tree_binding,
    targeted_tests: targetedTests,
    full_suite: full_suite,
    // The audit requirement follows the persisted run policy snapshot, the
    // same value the pipeline uses to schedule (or skip) the security-review
    // stage — disabling the policy must not leave a high-risk run
    // unshippable (F18).
    conditional_audits: {
      passed: security_review_required !== true || receipts.some((receipt) =>
        receipt.agent.role === 'security_reviewer' && receipt.status === 'passed'),
      required: security_review_required === true,
    },
    plugin_validation,
  };
  return {
    passed: Object.values(checks).every((check) => check.passed === true),
    checks,
  };
}

// The resolved full-suite command for this evaluation. A gate block caused by a
// parallel-execution race in the project's own suite (an xdist-style flake) must
// not burn bounded re-gate attempts (MAX_REGATE_ATTEMPTS) re-rolling the
// identical command. When the operator configures test_commands.full_serial —
// attested to be the SAME suite with a serialized execution shape, trusted
// exactly as test_commands.full is — every re-gate evaluation executes it
// instead. The signal is state.regate_attempts > 0: the REGATE arm increments
// the counter in the same transition that re-enters run_gates, so the first
// evaluation always sees 0. This is not a bypass or waiver (invariant 9): the
// full suite still executes and still decides the gate; only its execution shape
// changes. Unconfigured, re-gate behavior is byte-identical to the first
// evaluation. The cache key hashes the resolved command, so full and full_serial
// results can never answer for each other (serial re-gate, 2.0.32).
function resolveSuiteCommand(state, config) {
  const regate = (state.regate_attempts ?? 0) > 0;
  const serialCommand = config.test_commands?.full_serial ?? null;
  const full = config.test_commands?.full ?? null;
  // full_serial is the escape hatch and keeps precedence: on re-gate its whole
  // serialized command replaces `full` and the serialize modifier is NOT also
  // appended (byte-identical to today).
  if (regate && serialCommand) return serialCommand;
  // Composable serialize modifier (test-command-modifiers): on re-gate, with no
  // full_serial escape hatch set, append test_commands.serialize to `full` to
  // form the serialized re-gate command. Composes ONLY on re-gate and only when
  // `full` is a real command, so an unset slot (or the first evaluation) is
  // byte-identical to today. The suite cache key downstream hashes this resolved
  // command, so the composed serial can never be cross-answered by the parallel
  // base's cached pass (invariant 9).
  const serializeModifier = config.test_commands?.serialize ?? null;
  if (regate && serializeModifier && typeof full === 'string' && full) {
    return `${full} ${serializeModifier}`;
  }
  return full;
}

// The resolved FULL-suite command for ONE polyglot runner (the multi-runner
// analogue of resolveSuiteCommand). Mirrors that function's re-gate serialize
// precedence exactly — full_serial escape hatch first, then the composable
// serialize modifier appended to full — but reads the runner's own
// profile.full / profile.full_serial / profile.serialize instead of the
// top-level test_commands. Byte-identical to profile.full on the first
// evaluation and whenever no serial shape is configured. The per-runner cache
// key hashes THIS resolved command, so a runner's parallel and serialized full
// results can never cross-answer each other.
function resolveRunnerFullCommand(runner, state) {
  const regate = (state.regate_attempts ?? 0) > 0;
  const serialCommand = runner.profile?.full_serial ?? null;
  const full = runner.profile?.full ?? null;
  if (regate && serialCommand) return serialCommand;
  const serializeModifier = runner.profile?.serialize ?? null;
  if (regate && serializeModifier && typeof full === 'string' && full) {
    return `${full} ${serializeModifier}`;
  }
  return full;
}

// A rendered impacted command longer than this falls back to the FULL suite
// (critic C4): a giant changed set could otherwise produce a command line past
// the win32 ~32k limit (or the argv/env limits elsewhere) that is unspawnable —
// so impacted degrades to the always-runnable full gate rather than crashing the
// detached runner. A conservative bound well under every platform ceiling.
const IMPACTED_COMMAND_MAX_CHARS = 6000;

// The suite selected for THIS evaluation: FULL by default, or the impacted
// command when it is both eligible and usable. Precedence, resolved identically
// by runMergeGates, startGateSuite, and pollGateSuite (via gateSuiteContext):
//   * regate_attempts > 0 → the serial re-gate rule (full_serial ?? full),
//     NEVER impacted — a re-gate re-proves the same suite it blocked on.
//   * ship_requested → the same full/full_serial rule, NEVER impacted — an
//     audited ship re-runs the true full suite.
//   * otherwise impacted IFF test_commands.impacted_template is a non-empty
//     string AND shipping.required_remote_checks !== false (invariant 9: the
//     remote CI full suite must exist to substitute the local one) AND the
//     changed-path set (receipts changed_files, deduped, existing-on-disk,
//     sorted) is non-empty AND the template renders (contains {paths}, tokenizes
//     cleanly) within the length bound; else FULL fail-safe (never skipping).
// The rendered argv travels as an invocation ({command,args}) so callers spawn
// it via buildSpawnPlan / runTestSuite({override}) — never re-joined and
// re-tokenized, which would split a path containing spaces.
async function resolveSuiteSelection(projectDir, state, config) {
  const fullCommand = resolveSuiteCommand(state, config);
  const full = { mode: 'full', command: fullCommand, invocation: null, impacted_paths: null, template: null };
  const templateRaw = config.test_commands?.impacted_template;
  const template = typeof templateRaw === 'string' && templateRaw.trim() ? templateRaw : null;
  const regateActive = (state.regate_attempts ?? 0) > 0;
  const shipRequested = state.ship_requested === true;
  const remoteChecksEnabled = config.shipping?.required_remote_checks !== false;
  if (regateActive || shipRequested || !template || !remoteChecksEnabled) return full;
  // Changed paths from the run's independently-recomputed receipt diffs,
  // deduped, filtered to files that still exist on disk (a deleted claim must
  // not fabricate an impacted set), and sorted for a stable cache key + argv.
  const changed = [...new Set((state.receipts ?? []).flatMap((receipt) => receipt.changed_files ?? []))];
  const present = [];
  for (const file of changed) {
    if (await exists(path.join(projectDir, file))) present.push(file);
  }
  present.sort();
  if (present.length === 0) return full;
  let invocation = null;
  try {
    invocation = templateInvocation(template, present);
  } catch {
    // Malformed template (e.g. an unterminated quote): fail-safe to FULL.
    invocation = null;
  }
  if (!invocation) return full;
  const rendered = [invocation.command, ...invocation.args].join(' ');
  if (rendered.length > IMPACTED_COMMAND_MAX_CHARS) return full;
  return {
    mode: 'impacted',
    command: rendered,
    invocation: { command: invocation.command, args: invocation.args },
    impacted_paths: present,
    template,
  };
}

// Dependency-free `owns` glob → anchored RegExp (invariant 6: no glob library is
// added to the repo). BOTH the glob and the candidate file are normalized
// through normalizeClaimPath first so the two sides agree on the same bytes.
// Every regex metacharacter — INCLUDING `.` — is escaped to a literal before the
// glob operators are translated below, and the result is anchored `^…$`.
export function ownsGlobToRegExp(glob) {
  const normalized = normalizeClaimPath(glob);
  const escaped = normalized.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  // Translate the glob operators in ONE pass so ordering is structural, not
  // placeholder-based: the alternation tries `**` (matching ACROSS `/`) before
  // single `*` (staying within one segment), so `**` never degrades into
  // `[^/]*[^/]*`.
  const translated = escaped.replace(/\*\*|\*/g, (match) => (match === '**' ? '.*' : '[^/]*'));
  return new RegExp(`^${translated}$`);
}

// A file belongs to a runner when any POSITIVE `owns` glob matches it AND no
// NEGATED (`!`-prefixed) glob matches. A `!`-glob is an exclusion carve-out and
// a HARD veto (order-independent): it lets a broad owner (e.g. a repo-root
// runner's `**`) exclude a more-specific sub-runner's subtree without adding a
// glob library (invariant 6). Positive-only `owns` — every hand-written config
// today — behaves exactly as before, and union ownership ACROSS runners is
// unchanged (a file may still be owned by more than one runner). The candidate
// arrives already normalized so only the globs compile here.
export function runnerOwnsFile(runner, normalizedFile) {
  const owns = Array.isArray(runner.owns) ? runner.owns : [];
  let matched = false;
  for (const glob of owns) {
    if (typeof glob !== 'string' || glob === '') continue;
    if (glob.startsWith('!')) {
      if (ownsGlobToRegExp(glob.slice(1)).test(normalizedFile)) return false;
    } else if (ownsGlobToRegExp(glob).test(normalizedFile)) {
      matched = true;
    }
  }
  return matched;
}

// resolveRunnerSet — the PURE deterministic routing function for the polyglot
// multi-runner merge gate. It is intentionally UNWIRED here (the sequential-
// union gate wires it later): nothing in the bundled entry graphs references it,
// so esbuild tree-shakes it out and the committed dist bundles stay
// byte-identical. It is homed beside resolveSuiteSelection and DUPLICATES the
// ~4-line impacted-eligibility check rather than routing through a shared helper
// — extracting one would change resolveSuiteSelection's already-reachable
// (bundled) code. Identical inputs yield identical output: participants,
// subsets, and orphans are all sorted and no env/platform/timestamp/random
// input is read.
export async function resolveRunnerSet(projectDir, state, config) {
  // EMPTY/UNSET runners → the single-suite strategy, byte-identical to today's
  // resolveSuiteSelection path.
  if (!Array.isArray(config.runners) || config.runners.length === 0) {
    return {
      strategy: 'single',
      selection: await resolveSuiteSelection(projectDir, state, config),
      orphans: [],
    };
  }
  const runners = config.runners;
  // Changed-set normalization mirrors resolveSuiteSelection: the de-duplicated
  // union of every receipt.changed_files (missing → []), filtered to files that
  // still exist on disk under projectDir (a deleted claim must not fabricate a
  // routed set), sorted ascending for a stable output.
  const changed = [...new Set((state.receipts ?? []).flatMap((receipt) => receipt.changed_files ?? []))];
  const present = [];
  for (const file of changed) {
    if (await exists(path.join(projectDir, file))) present.push(file);
  }
  present.sort();

  // (1) UNION owns-matching: each present file belongs to EVERY runner whose any
  // `owns` glob matches; a file matched by NO runner is an ORPHAN. `present` is
  // already sorted, so each runner's matched subset stays sorted as it is built.
  const matchedByRunner = new Map(runners.map((runner) => [runner, []]));
  const orphans = [];
  for (const file of present) {
    const normalizedFile = normalizeClaimPath(file);
    let owned = false;
    for (const runner of runners) {
      if (runnerOwnsFile(runner, normalizedFile)) {
        matchedByRunner.get(runner).push(file);
        owned = true;
      }
    }
    if (!owned) orphans.push(file);
  }
  orphans.sort();

  const sortByRunner = (list) =>
    list.sort((a, b) => (a.runner < b.runner ? -1 : a.runner > b.runner ? 1 : 0));
  const fullParticipant = (runner) => ({
    runner: runner.id,
    root: runner.root,
    changedSubset: matchedByRunner.get(runner).slice(),
    mode: 'full',
    invocation: null,
    impacted_paths: null,
    template: null,
  });

  // (2) BLOCK — fail closed on an orphan, NEVER a silent skip.
  if (config.gates?.block_on_orphan === true && orphans.length > 0) {
    return {
      strategy: 'multi',
      participants: [],
      orphans,
      orphan_forced_full: false,
      orphan_policy: 'block',
      blocked: true,
    };
  }

  // (3) COVERAGE FAIL-SAFE — run ALL configured runners at full when either
  // nothing is routable (present empty) or an orphan slipped through under the
  // default run-all-full policy. Every runner participates (its subset may be
  // empty); orphan_forced_full records whether an orphan drove it.
  if (present.length === 0 || orphans.length > 0) {
    return {
      strategy: 'multi',
      participants: sortByRunner(runners.map((runner) => fullParticipant(runner))),
      orphans,
      orphan_forced_full: orphans.length > 0,
      orphan_policy: 'run-all-full',
      blocked: false,
    };
  }

  // Only runners that actually own a present file participate from here on.
  const participating = runners.filter((runner) => matchedByRunner.get(runner).length > 0);

  // (4) FORCE-FULL on regate/ship — every participating runner runs full, never
  // impacted (a re-gate or audited ship re-proves the true full suite).
  if ((state.regate_attempts ?? 0) > 0 || state.ship_requested === true) {
    return {
      strategy: 'multi',
      participants: sortByRunner(participating.map((runner) => fullParticipant(runner))),
      orphans,
      orphan_forced_full: false,
      orphan_policy: 'run-all-full',
      blocked: false,
    };
  }

  // (5) PER-RUNNER IMPACTED (normal). Invariant 9 applied per runner: the GLOBAL
  // shipping.required_remote_checks flag must be on for an impacted local run to
  // substitute the remote full suite. The eligibility check is DUPLICATED here
  // (not shared with resolveSuiteSelection) so the bundled single-suite path
  // stays byte-identical; templateInvocation + IMPACTED_COMMAND_MAX_CHARS are
  // the same module-level helpers. Any failure to render cleanly falls back to
  // full — never a skip.
  const remoteChecksEnabled = config.shipping?.required_remote_checks !== false;
  const participants = participating.map((runner) => {
    const changedSubset = matchedByRunner.get(runner).slice();
    const templateRaw = runner.profile?.impacted_template;
    const template = typeof templateRaw === 'string' && templateRaw.trim() ? templateRaw : null;
    if (template && remoteChecksEnabled && changedSubset.length > 0) {
      let invocation = null;
      try {
        invocation = templateInvocation(template, changedSubset);
      } catch {
        // Malformed template (e.g. an unterminated quote): fail-safe to full.
        invocation = null;
      }
      if (invocation) {
        const rendered = [invocation.command, ...invocation.args].join(' ');
        if (rendered.length <= IMPACTED_COMMAND_MAX_CHARS) {
          return {
            runner: runner.id,
            root: runner.root,
            changedSubset,
            mode: 'impacted',
            invocation: { command: invocation.command, args: invocation.args },
            impacted_paths: changedSubset,
            template,
          };
        }
      }
    }
    return fullParticipant(runner);
  });
  return {
    strategy: 'multi',
    participants: sortByRunner(participants),
    orphans,
    orphan_forced_full: false,
    orphan_policy: 'run-all-full',
    blocked: false,
  };
}

// Pure predicate (D6-L3): refuse an auto-merge whose PASSING local gates ran the
// IMPACTED suite when the remote CI full suite no longer exists for this merge
// (shipping.required_remote_checks flipped false) and no audited ship re-ran the
// FULL suite. true = refuse. Belt-and-suspenders over resolveSuiteSelection's
// invariant-9 rule: a gate can only render impacted while remote checks are on,
// so this catches a state whose recorded impacted result would otherwise satisfy
// a merge after remote checks were disabled out of band.
/**
 * @param {{ gates?: { checks?: { full_suite?: { mode?: string, runners?: Array<{ mode?: string }> } } }, ship_requested?: boolean }} state
 * @param {{ shipping?: { required_remote_checks?: boolean } }} config
 * @returns {boolean}
 */
export function impactedMergeGuard(state, config) {
  const fullSuite = state?.gates?.checks?.full_suite;
  // Single-suite gate: the historic full_suite.mode disjunct (unchanged).
  const singleImpacted = fullSuite?.mode === 'impacted';
  // Multi-runner union: ANY participating runner that ran impacted taints the
  // merge under the same invariant-9 condition — the per-runner union verdicts,
  // not a top-level mode, carry the impacted signal here.
  const multiImpacted = Array.isArray(fullSuite?.runners)
    && fullSuite.runners.some((runner) => runner?.mode === 'impacted');
  const ranImpacted = singleImpacted || multiImpacted;
  const remoteChecksOff = config?.shipping?.required_remote_checks === false;
  const shipAuthorized = state?.ship_requested === true;
  return ranImpacted && remoteChecksOff && !shipAuthorized;
}

// The shared gate-evaluation context: the observed tree sha, the resolved suite
// selection (full or impacted), and the suite cache read. Both the in-call
// runMergeGates and the detached startGateSuite/pollGateSuite path compute it
// identically so the cache key, cache write, and check shapes stay byte-identical
// across the two paths.
async function gateSuiteContext(projectDir, paths, state, config) {
  const treeSha = await currentTreeSha(projectDir);
  // Route through the polyglot router: an empty/unset config.runners yields the
  // 'single' strategy whose .selection IS resolveSuiteSelection's return, so the
  // single branch below stays BYTE-IDENTICAL to today (no `runners` metadata).
  const runnerSet = await resolveRunnerSet(projectDir, state, config);
  const cachePath = path.join(paths.runtime, 'suite-cache.json');
  const cache = await readJson(cachePath, { schema_version: '2.0.0', results: {} });
  // policy.full_suite_cache=false disables reading the cache entirely: the
  // suite re-executes even when this exact tree+command already passed.
  const cacheReadable = config.policy?.full_suite_cache !== false;
  if (runnerSet.strategy === 'single') {
    const selection = runnerSet.selection;
    const suiteCommand = selection.command;
    // The cache key binds the tree AND the resolved suite: changing
    // test_commands.full must never be answered from a result the old command
    // produced, and an IMPACTED pass must never satisfy a later FULL evaluation
    // (or vice versa) at the same tree — the impacted key embeds mode + template +
    // paths, so it can never collide with the full key's {command} hash. Only
    // passing results are served — a cached failure (flaky suite, missing runner
    // configuration) would otherwise pin the tree forever.
    const cacheKey = selection.mode === 'impacted'
      ? `${treeSha}:${sha256({ mode: 'impacted', template: selection.template, paths: selection.impacted_paths })}`
      : `${treeSha}:${sha256({ command: suiteCommand })}`;
    const cachedEntry = cacheReadable ? cache.results[cacheKey] ?? null : null;
    return {
      strategy: 'single',
      treeSha,
      suiteCommand,
      suiteMode: selection.mode,
      suiteInvocation: selection.invocation,
      impactedPaths: selection.impacted_paths,
      impactedTemplate: selection.template,
      cachePath,
      cache,
      cacheKey,
      cacheReadable,
      cachedEntry,
    };
  }
  // MULTI (polyglot union): resolve every participating runner's command, its
  // per-runner cache key, and its cache read up front. keyR binds the ONE shared
  // treeSha AND the runner id AND the resolved suite, so full↔impacted (mode +
  // template + paths vs {runner,command}) and cross-runner keys can never
  // cross-answer. Only the current runner runs at a time; start/poll pick the
  // cursor from the PERSISTED runner_order.
  const participants = (runnerSet.participants ?? []).map((participant) => {
    const runnerConfig = (config.runners ?? []).find((runner) => runner.id === participant.runner) ?? {};
    const command = participant.mode === 'impacted' && participant.invocation
      ? [participant.invocation.command, ...participant.invocation.args].join(' ')
      : resolveRunnerFullCommand(runnerConfig, state);
    const keyR = participant.mode === 'impacted'
      ? `${treeSha}:${sha256({ runner: participant.runner, mode: 'impacted', template: participant.template, paths: participant.impacted_paths })}`
      : `${treeSha}:${sha256({ runner: participant.runner, command })}`;
    const cachedEntry = cacheReadable ? cache.results[keyR] ?? null : null;
    return {
      id: participant.runner,
      root: participant.root,
      mode: participant.mode,
      command,
      invocation: participant.invocation,
      impacted_paths: participant.impacted_paths,
      template: participant.template,
      keyR,
      cachedEntry,
    };
  });
  return {
    strategy: 'multi',
    treeSha,
    cachePath,
    cache,
    cacheReadable,
    participants,
    blocked: runnerSet.blocked === true,
    orphans: runnerSet.orphans ?? [],
  };
}

export async function runMergeGates(projectDir, paths, state, config) {
  const baseCtx = await gateSuiteContext(projectDir, paths, state, config);
  const preflight = await evaluateGatePreflight(projectDir, state, config, baseCtx);
  const ctx = { ...baseCtx, preflight };
  if (!preflight.passed) {
    return evaluateGates(projectDir, paths, state, config, {
      ...ctx,
      full: skippedFullSuite(ctx.treeSha),
      cached: false,
    });
  }
  let full = ctx.cachedEntry?.passed === true ? ctx.cachedEntry : null;
  const cached = full !== null;
  if (!full) {
    const verification = await runTestSuite(projectDir, {
      // Impacted travels as a pre-tokenized invocation (the derived-targeted
      // channel) so a rendered path with spaces stays one argv entry; full runs
      // the resolved command string exactly as before.
      ...(ctx.suiteMode === 'impacted' && ctx.suiteInvocation
        ? { override: ctx.suiteInvocation }
        : { command: ctx.suiteCommand ?? undefined }),
      timeout_ms: config.deadlines_ms?.[state.lane],
    });
    full = {
      passed: verification.passed === true,
      tree_sha: ctx.treeSha,
      command: ctx.suiteCommand,
      result_hash: sha256(verification),
      recorded_at: new Date().toISOString(),
      verification,
    };
    // The cache write is deferred until after the post-gate tree recompute:
    // a suite command that mutates an attributed path and exits 0 correctly
    // blocks this run on tree_binding, but persisting its "pass" keyed to the
    // entry tree would poison the cache — a later run starting from the same
    // tree+command would be served evidence produced against mutated bytes.
  }
  return evaluateGates(projectDir, paths, state, config, { ...ctx, full, cached });
}

// Per-runner TARGETED gate (polyglot). Routes the run's present test paths to
// their owning runners and runs each participating runner's SCOPED targeted
// invocation at its OWN root, then ANDs the verdicts — so a mixed monorepo never
// runs one toolchain over another toolchain's test paths (e.g. pytest over a
// .tsx path). Mirrors the merge gate's per-runner union and the red-admission
// router (observeRedTestPerRunner): owns already carries proposeRunners'
// carve-outs, so each path lands on exactly its owner. Fails closed
// (executed:false) on an orphan test path or a runner that cannot be scoped — an
// unverifiable path is never a pass. The refusal wordings are gate-flavored (not
// red admission), so this does not share the admission router's messages.
export async function evaluateTargetedRunners(projectDir, present, config, timeoutMs, treeSha) {
  const runners = config.runners ?? [];
  const owned = new Map(runners.map((runner) => [runner, []]));
  const orphans = [];
  for (const file of present) {
    const normalized = normalizeClaimPath(file);
    let anyOwner = false;
    for (const runner of runners) {
      if (runnerOwnsFile(runner, normalized)) { owned.get(runner).push(file); anyOwner = true; }
    }
    if (!anyOwner) orphans.push(file);
  }
  if (orphans.length > 0) {
    // prose-bound-exempt: fixed diagnostic template; ${orphans} interpolates
    // runtime-derived project file paths (this run's own test_paths/changed_files),
    // never raw agent-authored prose.
    return { executed: false, reason: `targeted test path(s) ${orphans.sort().join(', ')} are owned by no configured runner; add an owns glob or a runner that owns them` };
  }
  // Spawn-free prologue: resolve every participating runner's scoped invocation
  // and collect any fail-closed refusal BEFORE any suite executes.
  const participants = [];
  for (const runner of runners) {
    const subset = owned.get(runner);
    if (subset.length === 0) continue; // owns no present test path — not a participant
    const runnerRootRel = normalizeClaimPath(runner.root ?? '.');
    const subsetRel = subset.map((file) => path.posix.relative(runnerRootRel, normalizeClaimPath(file))).sort();
    const profile = runner.profile ?? {};
    const template = typeof profile.targeted_template === 'string' && profile.targeted_template.trim() ? profile.targeted_template : null;
    const staticTargeted = typeof profile.targeted === 'string' && profile.targeted.trim() ? profile.targeted : null;
    let invocation = null; let targetedCmd = null; let command = null;
    if (template) {
      let rendered;
      try { rendered = templateInvocation(template, subsetRel); }
      // prose-bound-exempt: fixed diagnostic template; ${runner.id} is the
      // operator's own configured runner id and ${error.message} is this
      // module's own template-parse error, never agent-authored free text.
      catch (error) { return { executed: false, reason: `runner '${runner.id}' targeted_template is malformed: ${error.message}` }; }
      // prose-bound-exempt: fixed diagnostic template; ${runner.id} is the
      // operator's own configured runner id, never agent-authored free text.
      if (!rendered) return { executed: false, reason: `runner '${runner.id}' targeted_template must contain the {paths} placeholder to scope its targeted tests` };
      invocation = rendered; command = [rendered.command, ...rendered.args].join(' ');
    } else if (staticTargeted) {
      targetedCmd = staticTargeted; command = staticTargeted;
    } else {
      const detected = await detectTestRunner(path.join(projectDir, runner.root ?? '.'));
      invocation = targetedInvocation(detected, subsetRel);
      if (!invocation && subsetRel.length > 0 && subsetRel.every((file) => /\.(test|spec)\.(js|mjs|cjs)$/i.test(file))) {
        invocation = { command: process.execPath, args: ['--test', ...subsetRel], scoped: true };
      }
      if (!invocation || invocation.scoped !== true) {
        // prose-bound-exempt: fixed diagnostic template; ${runner.id} is the
        // operator's own configured runner id and ${detected?.runner} is a
        // fixed detector-enum name, never agent-authored free text.
        return { executed: false, reason: `runner '${runner.id}' cannot scope the detected ${detected?.runner ?? 'none'} runner to its targeted test paths; configure its profile.targeted_template` };
      }
      command = [invocation.command, ...invocation.args].join(' ');
    }
    participants.push({ runner, subset, invocation, targetedCmd, command });
  }
  if (participants.length === 0) {
    return { executed: false, reason: 'no runtime-verifiable targeted test paths route to any configured runner' };
  }
  const runnerResults = [];
  for (const participant of participants) {
    const runnerCwd = path.join(projectDir, participant.runner.root ?? '.');
    const verification = await runTestSuite(runnerCwd, {
      ...(participant.invocation ? { override: participant.invocation } : { command: participant.targetedCmd }),
      timeout_ms: timeoutMs,
    });
    runnerResults.push({
      id: participant.runner.id,
      command: participant.command,
      passed: verification.passed === true,
      test_paths: [...participant.subset].sort(),
      result_hash: sha256(verification),
      ...(verification.timed_out === true ? { timed_out: true } : {}),
    });
  }
  runnerResults.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {
    executed: true,
    derived: true,
    test_paths: present,
    passed: runnerResults.every((entry) => entry.passed),
    command: runnerResults.map((entry) => `${entry.id}: ${entry.command}`).join(' | '),
    tree_sha: treeSha,
    result_hash: sha256(runnerResults.map((entry) => entry.result_hash)),
    runners: runnerResults,
    verification: { timed_out: runnerResults.some((entry) => entry.timed_out) },
  };
}

async function evaluateGatePreflight(projectDir, state, config, ctx) {
  const { treeSha, strategy, blocked, orphans } = ctx;
  const isMulti = strategy === 'multi';
  // When test_commands.targeted is configured the runtime executes it itself
  // and the result decides the targeted_tests gate; agent-asserted
  // receipt.tests[] evidence is advisory. No cache: targeted runs are cheap
  // and the gate must attest an actual execution against this exact tree.
  const targetedCommand = config.test_commands?.targeted ?? null;
  let targeted = null;
  if (targetedCommand) {
    const verification = await runTestSuite(projectDir, {
      command: targetedCommand,
      timeout_ms: config.deadlines_ms?.[state.lane],
    });
    targeted = {
      executed: true,
      command: targetedCommand,
      passed: verification.passed === true,
      tree_sha: treeSha,
      result_hash: sha256(verification),
      verification,
    };
  } else if (state.lane !== 'mechanical') {
    // No configured command on a behavioral lane: derive a bounded
    // deterministic invocation from runtime-validated state — the detected
    // test runner applied to the union of receipt-attested test paths (the
    // changed_files sets are recomputed from the git diff at receipt
    // admission, never trusted from the agent) and the run's declared
    // test_paths. Agent-asserted receipt.tests[] evidence alone can never
    // decide this gate (F12).
    const candidates = [...new Set([
      ...state.receipts.flatMap((receipt) => receipt.changed_files).filter((file) => TEST_PATH_PATTERN.test(file)),
      ...(state.test_paths ?? []),
    ])].sort();
    const present = [];
    for (const file of candidates) {
      if (await exists(path.join(projectDir, file))) present.push(file);
    }
    if (isMulti) {
      // Polyglot: route the present test paths to their owning runners and run
      // each participating runner's scoped targeted invocation at its OWN root,
      // then AND the verdicts — never one toolchain over another's test paths.
      targeted = await evaluateTargetedRunners(
        projectDir, present, config, config.deadlines_ms?.[state.lane], treeSha,
      );
    } else {
      const runner = await detectTestRunner(projectDir);
      const invocation = targetedInvocation(runner, present);
      if (!invocation) {
        targeted = {
          executed: false,
          reason: present.length === 0
            ? 'no runtime-verifiable test paths exist for this run; configure test_commands.targeted'
            // prose-bound-exempt: both ternary branches are fixed string literals
            // with no interpolation; the scanner's literal check does not
            // special-case a ternary of two literals.
            : 'no test runner detected for derived targeted execution; configure test_commands.targeted',
        };
      } else {
        const verification = await runTestSuite(projectDir, {
          override: invocation,
          timeout_ms: config.deadlines_ms?.[state.lane],
        });
        targeted = {
          executed: true,
          derived: true,
          command: [invocation.command, ...invocation.args].join(' '),
          test_paths: present,
          passed: verification.passed === true,
          tree_sha: treeSha,
          result_hash: sha256(verification),
          verification,
        };
      }
    }
  }

  const status = await workingTreeStatus(projectDir);
  const allowedDirty = new Set(state.receipts.flatMap((receipt) => receipt.changed_files));
  const unexpectedDirty = status
    .map((line) => line.slice(3))
    .filter((file) => !allowedDirty.has(file) && !file.startsWith('.ape/'));

  let pluginValidation = { required: false, passed: true };
  const changedFiles = state.receipts.flatMap((receipt) => receipt.changed_files);
  const pluginMetadataChanged = changedFiles.some((file) =>
    file === '.mcp.json'
      || file === '.claude-plugin'
      || file.startsWith('.claude-plugin/')
      || file === '.codex-plugin'
      || file.startsWith('.codex-plugin/'));
  // `hooks`, `skills`, `agents`, `commands`, `prompts`, and `dist` are common
  // names in ordinary repositories. Treat them as a plugin surface only when
  // a real host manifest exists; otherwise an unrelated application changing
  // (say) dist/app.js must not suddenly acquire plugin-validation requirements.
  const pluginManifestExists = await Promise.all([
    exists(path.join(projectDir, '.claude-plugin', 'plugin.json')),
    exists(path.join(projectDir, '.codex-plugin', 'plugin.json')),
  ]).then((present) => present.some(Boolean));
  const shippedPluginSurfaceChanged = changedFiles.some((file) => [
    'hooks/',
    'skills/',
    'agents/',
    'commands/',
    'prompts/',
    'dist/',
  ].some((prefix) => file.startsWith(prefix)));
  const pluginRelevant = pluginMetadataChanged
    || (pluginManifestExists && shippedPluginSurfaceChanged);
  if (pluginRelevant) {
    // In-process structural validation: gates must run identically on hosts
    // without any vendor CLI installed (invariant 6). Each host is validated
    // only when its plugin DIRECTORY exists on disk: .mcp.json is ordinary
    // host MCP config in a plain project, and a Claude-only plugin repo has
    // no .codex-plugin mirror — demanding both manifests unconditionally made
    // such runs permanently unshippable (every re-gate re-failed on the same
    // ENOENT). The directory, not the manifest file, is the presence signal:
    // a plugin dir whose manifest was deleted while components remain still
    // fails closed through the validator's own cannot-read error, because a
    // half-deleted plugin surface must never ship silently.
    const skipped = (host) => ({
      passed: true,
      skipped: true,
      note: `no ${host} directory in this project; validation skipped`,
    });
    const claude = await exists(path.join(projectDir, '.claude-plugin'))
      ? await validateClaudePlugin(projectDir)
      : skipped('.claude-plugin');
    const codex = await exists(path.join(projectDir, '.codex-plugin'))
      ? await validateCodexPlugin(projectDir)
      : skipped('.codex-plugin');
    pluginValidation = {
      required: true,
      passed: claude.passed && codex.passed,
      claude,
      codex,
      // Truthful completion: a pass that validated nothing says so.
      ...(claude.skipped === true && codex.skipped === true
        ? { note: 'no plugin directory exists in this project; validation skipped' }
        : {}),
    };
  }

  // A targeted command is executable configuration and can mutate the tree.
  // Sample again before launching the expensive suite; a dirty/invalid plugin
  // or receipt/tree mismatch is a deterministic red that should fail in
  // seconds, not after the full suite. evaluateGates repeats the status/tree
  // reads after the suite, preserving the mutation fence.
  const postPreflightTreeSha = await currentTreeSha(projectDir);
  const lastReceipt = state.receipts.at(-1) ?? null;
  const treeBinding = {
    passed: lastReceipt !== null
      && lastReceipt.head_tree_sha === treeSha
      && postPreflightTreeSha === treeSha,
    attested_tree_sha: lastReceipt?.head_tree_sha ?? null,
    merge_tree_sha: treeSha,
    post_gate_tree_sha: postPreflightTreeSha,
  };
  const evaluated = evaluateMergePrerequisites({
    receipts: state.receipts,
    lane: state.lane,
    security_review_required: state.high_risk === true
      && state.policy?.high_risk_security_review !== false,
    full_suite: isMulti && blocked === true
      ? { passed: false, skipped: true, orphans: orphans ?? [] }
      : { passed: true, preflight: true },
    unexpected_dirty: unexpectedDirty,
    plugin_validation: pluginValidation,
    tree_binding: treeBinding,
    targeted,
  });
  return {
    key: gatePreflightKey(state, config, ctx),
    passed: evaluated.passed,
    targeted,
    pluginValidation,
    unexpectedDirty,
    treeBinding,
  };
}

function gatePreflightKey(state, config, ctx) {
  return sha256({
    tree_sha: ctx.treeSha,
    strategy: ctx.strategy,
    blocked: ctx.blocked === true,
    orphans: ctx.orphans ?? [],
    lane: state.lane,
    high_risk: state.high_risk === true,
    high_risk_security_review: state.policy?.high_risk_security_review !== false,
    receipts: state.receipts.map((receipt) => ({
      receipt_hash: receipt.receipt_hash,
      previous_receipt_hash: receipt.previous_receipt_hash,
      head_tree_sha: receipt.head_tree_sha,
      changed_files: receipt.changed_files,
      role: receipt.agent?.role,
      status: receipt.status,
    })),
    test_paths: state.test_paths ?? [],
    targeted: config.test_commands?.targeted ?? null,
    runners: config.runners ?? [],
    deadline_ms: config.deadlines_ms?.[state.lane] ?? null,
  });
}

function skippedFullSuite(treeSha) {
  return {
    passed: false,
    skipped: true,
    tree_sha: treeSha,
    reason: 'full suite skipped because a deterministic preflight check failed',
  };
}

// Only a green preflight enters a detached watch. Its targeted command output
// can still be large, but the final check consumes only the verdict/hash and
// timed_out bit; keep those and omit raw stdout/stderr from persisted state and
// MCP status projections. The result hash remains the durable binding to the
// complete execution result observed before launch.
function gateWatchPreflight(preflight) {
  const targeted = preflight.targeted;
  if (!targeted?.verification) return preflight;
  const { verification: _verification, ...summary } = targeted;
  return {
    ...preflight,
    targeted: {
      ...summary,
      ...(targeted.verification.timed_out === true
        ? { verification: { timed_out: true } }
        : {}),
    },
  };
}

// The evaluation core, factored out of runMergeGates so the detached gate path
// (a poll consuming the runner's artifact) reaches byte-identical check shapes.
// Targeted tests, plugin validation, and initial dirty/tree sanity execute in a
// preflight before the full suite. Their result is carried through a detached
// watch; the dirty/tree reads below still repeat after the suite so a command
// that mutates the worktree can never ship or poison the suite cache.
export async function evaluateGates(projectDir, paths, state, config, ctx) {
  const { treeSha, suiteCommand, suiteMode, impactedPaths, impactedTemplate, cachePath, cache, cacheKey, full, cached, strategy, runnerResults, blocked, orphans } = ctx;
  const isMulti = strategy === 'multi';
  // Compatibility for a persisted watch created by an older plugin version:
  // it has no preflight payload, so perform the checks now rather than trusting
  // absent evidence. New watches always take this path before suite launch.
  const preflight = ctx.preflight ?? await evaluateGatePreflight(projectDir, state, config, ctx);
  const targeted = preflight.targeted;
  const pluginValidation = preflight.pluginValidation;

  // Recompute clean-tree state after the full suite. This is intentionally not
  // reused from preflight: suite mutations must remain visible.
  const status = await workingTreeStatus(projectDir);
  const allowedDirty = new Set(state.receipts.flatMap((receipt) => receipt.changed_files));
  const unexpectedDirty = status
    .map((line) => line.slice(3))
    .filter((file) => !allowedDirty.has(file) && !file.startsWith('.ape/'));

  // Bind the merge-time tree to the last attested receipt tree: every byte that
  // ships must be the tree the final receipt attested. Post-receipt tampering
  // inside already-claimed files passes clean_tree but must fail here. The
  // tree is recomputed AFTER every gate command has finished (F4): a test
  // command that mutates an already-attributed path would otherwise leave the
  // entry-time SHA — the tree the suite was believed to test — looking bound.
  const lastReceipt = state.receipts.at(-1) ?? null;
  const postGateTreeSha = await currentTreeSha(projectDir);
  // Gate-level flake signal (red-admission-flake-screen part iii): a FRESH
  // passing evaluation whose suite cache holds a prior FAILED entry at this
  // exact cacheKey (same tree, same resolved suite) must not read as a clean
  // pass — the pass is recorded WITH the prior same-tree failure as a
  // bounded, factual annotation. Advisory only: it never feeds any passed
  // computation and never blocks. The RAW cache entry is read here, never the
  // policy-gated ctx.cachedEntry — policy.full_suite_cache=false disables
  // SERVING cached passes, not the flake history — and a prior tooling fault
  // or deadline kill is excluded: neither is evidence the suite flaked.
  // Computed BEFORE the deferred cache write below overwrites the prior
  // entry at this key; the written entry itself stays byte-identical.
  let flakeSignal = null;
  if (preflight.passed === true && !isMulti && !cached && full?.passed === true) {
    const prior = cache.results[cacheKey];
    if (
      prior?.passed === false &&
      prior.verification?.tooling_failure !== true &&
      prior.verification?.timed_out !== true
    ) {
      flakeSignal = {
        prior_same_tree_failure: {
          recorded_at: prior.recorded_at ?? prior.executed_at ?? null,
          result_hash: prior.result_hash ?? null,
        },
      };
    }
  }
  // Persist a fresh full-suite result only when the tree stayed stable across
  // every gate command: cache entries must attest an execution against the
  // exact keyed tree. Served hits need no invalidation — by induction they
  // were only ever written from tree-stable executions.
  if (preflight.passed !== true) {
    // No suite ran, so there is no result to cache. The post-preflight status
    // and tree reads above still make the returned checks current.
  } else if (isMulti) {
    // Persist EACH uncached participating runner's keyR entry — but only when
    // the tree proved stable across every runner command (F4). Cached-green
    // runners are idempotent no-ops. On a mid-sequence drift pollGateSuite
    // already failed the whole union closed BEFORE reaching here, so no keyR is
    // ever persisted for a drifted tree.
    if (postGateTreeSha === treeSha) {
      let dirty = false;
      for (const runner of runnerResults ?? []) {
        if (!runner.cached && runner.result) {
          cache.results[runner.keyR] = runner.result;
          dirty = true;
        }
      }
      if (dirty) await atomicWriteJson(cachePath, cache);
    }
  } else if (!cached && full?.skipped !== true && postGateTreeSha === treeSha) {
    cache.results[cacheKey] = full;
    await atomicWriteJson(cachePath, cache);
  }
  const treeBinding = {
    passed: lastReceipt !== null
      && lastReceipt.head_tree_sha === treeSha
      && postGateTreeSha === treeSha,
    attested_tree_sha: lastReceipt?.head_tree_sha ?? null,
    merge_tree_sha: treeSha,
    post_gate_tree_sha: postGateTreeSha,
  };

  const evaluated = evaluateMergePrerequisites({
    receipts: state.receipts,
    lane: state.lane,
    // The persisted run-policy snapshot decides whether a security review is
    // required — the same decision the pipeline used when scheduling stages
    // (F18). Live config must not be consulted here.
    security_review_required: state.high_risk === true
      && state.policy?.high_risk_security_review !== false,
    // timed_out is absent-when-false; a cached entry can never carry it
    // because only passing results are served and a timed-out run never
    // passes.
    full_suite: preflight.passed !== true
      ? skippedFullSuite(treeSha)
      : isMulti
      // Polyglot union: the gate passes IFF every participating runner passed
      // (an orphan block fails closed with zero participants). Each runners[]
      // entry is truthful — id, verdict, whether it was cache-served, its
      // resolved command, whether it ran full or impacted, and its result hash —
      // sorted by id for a deterministic shape.
      ? {
          passed: blocked === true ? false : (runnerResults ?? []).every((runner) => runner.passed === true),
          tree_sha: treeSha,
          runners: (runnerResults ?? [])
            .map((runner) => ({
              id: runner.id,
              passed: runner.passed === true,
              cached: runner.cached === true,
              command: runner.command,
              mode: runner.mode,
              result_hash: runner.result_hash,
            }))
            .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
          ...(blocked === true ? { orphans: orphans ?? [] } : {}),
        }
      : {
          passed: full?.passed === true,
          cached,
          command: suiteCommand,
          tree_sha: treeSha,
          // Truthful completion (invariant 9): when the impacted command substituted
          // the local full suite, say so honestly (a distinct shape) with the
          // rendered command, the changed paths, and the template — never silently
          // reporting an impacted run as the full suite. Absent on a full-suite run,
          // so the check shape and its hash stay byte-identical to today then.
          ...(suiteMode === 'impacted'
            ? { mode: 'impacted', impacted_paths: impactedPaths, template: impactedTemplate }
            : {}),
          ...(full?.verification?.timed_out === true ? { timed_out: true } : {}),
          // Absent-when-none: every clean pass with no flake history keeps a
          // byte-identical check shape (and hash).
          ...(flakeSignal !== null ? { flake_signal: flakeSignal } : {}),
        },
    unexpected_dirty: unexpectedDirty,
    plugin_validation: pluginValidation,
    tree_binding: treeBinding,
    targeted,
  });
  return {
    passed: evaluated.passed,
    tree_sha: treeSha,
    checks: evaluated.checks,
  };
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
      preflight: gateWatchPreflight(ctx.preflight),
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
export async function startGateSuite(projectDir, paths, state, config) {
  const baseCtx = await gateSuiteContext(projectDir, paths, state, config);
  const preflight = await evaluateGatePreflight(projectDir, state, config, baseCtx);
  const ctx = { ...baseCtx, preflight };
  if (!preflight.passed) {
    return { hit: { ctx, full: skippedFullSuite(ctx.treeSha), cached: false } };
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
      preflight: gateWatchPreflight(preflight),
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
export async function pollGateSuite(projectDir, paths, state, config) {
  const watch = state.gates_watch;
  if (!watch) throw new Error('pollGateSuite requires a persisted gates_watch');
  const baseCtx = await gateSuiteContext(projectDir, paths, state, config);
  if (watch.preflight && watch.preflight.key !== gatePreflightKey(state, config, baseCtx)) {
    return { failed: 'the resolved merge-gate preflight changed after the gate suite started; re-gate to verify the current targeted-test and policy configuration' };
  }
  const ctx = watch.preflight ? { ...baseCtx, preflight: watch.preflight } : baseCtx;
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

// The PR base is the full symbolic-ref tail past the remote prefix:
// `.split('/').at(-1)` truncated slashed default branches like release/stable
// to 'stable', so `gh pr create --base` targeted a branch that does not exist
// and the post-merge fetch/switch/pull chased the same wrong name. When
// origin/HEAD is unset (push-only clone that never fetched; git < 2.42 never
// auto-created it on fetch either), probe the conventional defaults in a
// deterministic order — local ref reads only, never ls-remote: a merge gate
// must not grow hidden network calls — and otherwise fail with the remedy.
async function resolveDefaultBase(projectDir) {
  const prefix = 'refs/remotes/origin/';
  const ref = await runGit(projectDir, ['symbolic-ref', 'refs/remotes/origin/HEAD'])
    .catch(() => '');
  if (ref.startsWith(prefix)) return ref.slice(prefix.length);
  for (const name of ['main', 'master']) {
    const present = await runGit(
      projectDir,
      ['show-ref', '--verify', '--quiet', `refs/remotes/origin/${name}`],
    ).then(() => true, () => false);
    if (present) return name;
  }
  throw new Error('cannot determine default branch: refs/remotes/origin/HEAD is unset and neither origin/main nor origin/master exists; run `git remote set-head origin --auto`, then re-gate');
}

// Word-boundary truncation for commit subjects and PR titles (friction #12):
// the old blind slice(0, 72) shipped `feat: Add a runtime-owned re-gate
// recovery operation: a run blocked at t` — cut mid-word — for every
// objective longer than ~65 chars. Cut at the last space inside the budget
// and mark the cut with an ellipsis. A cut that would keep almost nothing is
// degenerate (one enormous word; `feat: ` alone puts a space at index 5), so
// it falls back to the hard slice: bounded beats pretty there.
function truncateAtWordBoundary(text, max = 72) {
  if (text.length <= max) return text;
  const hard = text.slice(0, max - 1);
  const cut = hard.lastIndexOf(' ');
  if (cut < 8) return `${hard}…`;
  return `${hard.slice(0, cut).trimEnd()}…`;
}

// The one no-checks message `gh pr checks` emits (stable across gh versions:
// "no checks reported on the '<branch>' branch"). Deliberately narrow — any
// other failure text is a real verdict and must never be retried.
const NO_CHECKS_PATTERN = /no checks reported/i;

// Parse the newest `STATE URL MERGED_AT HEAD_OID` line out of the PR probe.
// run() interleaves stderr by arrival, so scan lines in reverse for the
// shaped one instead of trusting the last line.
function parsePrProbe(output) {
  const line = output.trim().split(/\r?\n/)
    .map((entry) => entry.trim())
    .reverse()
    .find((entry) => /^(OPEN|MERGED|CLOSED) https:\/\/\S+ \S+ \S+$/.test(entry));
  if (!line) return null;
  const [prState, url, mergedAt, headOid] = line.split(' ');
  return { state: prState, url, merged_at: mergedAt === '-' ? null : mergedAt, head_oid: headOid };
}

// Post-merge local cleanup. Idempotent by construction — fetch and switch
// tolerate re-runs, the ff-only pull is a no-op when already current, and the
// branch delete tolerates an already-deleted branch — so the merged-PR
// re-entry path can re-run it safely.
async function finalizeAfterMerge(projectDir, branch, base) {
  await runGit(projectDir, ['fetch', 'origin', base], { timeout_ms: 120_000 });
  const localBase = await runGit(
    projectDir,
    ['show-ref', '--verify', '--quiet', `refs/heads/${base}`],
  ).then(() => true, () => false);
  if (localBase) {
    await runGit(projectDir, ['switch', base], { timeout_ms: 120_000 });
  } else {
    await runGit(
      projectDir,
      ['switch', '-c', base, `refs/remotes/origin/${base}`, '--no-track'],
      { timeout_ms: 120_000 },
    );
  }
  await runGit(projectDir, ['pull', '--ff-only', 'origin', base], { timeout_ms: 120_000 });
  await runGit(projectDir, ['branch', '-D', branch]).catch(() => {});
}

// Returns the in-call merge shape `{ provider, url, branch, base, merged_at }`
// (required_remote_checks:false, or a re-entry that finds the run's PR already
// merged) OR the non-blocking `{ watch: {...} }` handoff descriptor
// (required_remote_checks !== false). The service discriminates on the `watch`
// key. Fields are optional in the annotation so both shapes assign.
/**
 * @returns {Promise<{
 *   watch?: { provider: string, pr_url: string, branch: string, base: string, head_oid: string, created_at: string },
 *   provider?: string, url?: string, branch?: string, base?: string, merged_at?: string,
 * }>}
 */
export async function autoMergeGithub(projectDir, state, config) {
  if (config.shipping?.provider !== 'github') throw new Error('unsupported merge provider');
  const remote = await runGit(projectDir, ['remote', 'get-url', 'origin']);
  if (!/github\.com[:/]/i.test(remote)) throw new Error('origin is not a GitHub remote');
  // Ship the live branch when it is a feature branch. After a fully-merged PR
  // whose local cleanup failed, the live branch is the base — `gh pr merge
  // --delete-branch` switches the checkout to the default branch before
  // deleting — so the run's recorded branch stands in for the merged-PR probe
  // below. Committing or pushing FROM the base stays forbidden either way.
  const isFeatureBranch = (name) => Boolean(name) && name !== 'main' && name !== 'master';
  const liveBranch = await runGit(projectDir, ['branch', '--show-current']);
  const branch = isFeatureBranch(liveBranch) ? liveBranch
    : isFeatureBranch(state.branch) ? state.branch
      : null;
  if (!branch) throw new Error('shipping requires a feature branch');
  // New runs persist the exact default branch they were based on so a default
  // change mid-run cannot retarget their PR or cleanup. Legacy states fall
  // back to the live resolver for byte-compatible recovery.
  const base = typeof state.base_branch === 'string' && state.base_branch.trim() !== ''
    ? state.base_branch
    : await resolveDefaultBase(projectDir);
  const changedFiles = [...new Set(state.receipts.flatMap((receipt) => receipt.changed_files))];
  if (changedFiles.length === 0) throw new Error('shipping has no validated changed files');
  // Shipping must be re-entrant: any failure past the commit below (push, PR
  // creation, the checks-registration race, the merge call, local cleanup)
  // blocks the run at stage gates, and the runtime's own hinted recovery —
  // REGATE — re-enters this function with some effects already applied. Dying
  // at `git commit` on the then-clean tree burned every bounded re-gate
  // attempt (friction #4/#21). Probe the branch's PR state first; every later
  // step is individually idempotent or probe-guarded.
  const probe = await run('gh', [
    'pr', 'view', branch,
    '--json', 'url,state,mergedAt,headRefOid',
    '--jq', '[.state, .url, (.mergedAt // "-"), .headRefOid] | join(" ")',
  ], projectDir);
  const existing = probe.passed ? parsePrProbe(probe.output) : null;
  if (existing?.state === 'MERGED') {
    // gh resolves a branch name to its most recent PR, so MERGED can name a
    // stale PR from a previous life of a reused branch name. Continue only
    // when the PR is provably this run's shipped work. When phase 1 persisted a
    // pushed-head attestation (state.shipping_watch.head_oid), the proof is an
    // EXACT head match — the same A2 rule the poll phase enforces — so a merge
    // that landed at a DIFFERENT head (someone else's merge over unrelated
    // commits) is never adopted, even if it merged during the run. Only when NO
    // watch was persisted does the looser evidence stand: the merged head is the
    // local HEAD (re-entry from the feature branch), or the PR merged after this
    // run started (re-entry after gh already switched the checkout to the base
    // and deleted the branch). A stale/foreign merged PR completing a run that
    // shipped nothing would violate truthful completion (invariant 8).
    const attestedHead = state.shipping_watch?.head_oid ?? null;
    const head = await runGit(projectDir, ['rev-parse', 'HEAD']);
    const mergedDuringRun = Date.parse(existing.merged_at ?? '') >= Date.parse(state.created_at ?? '');
    const provenBySelf = attestedHead
      ? existing.head_oid === attestedHead
      : existing.head_oid === head || mergedDuringRun;
    if (provenBySelf) {
      // Never push on this path: --delete-branch removed the remote branch,
      // and a re-entry push would recreate it. Only local cleanup remains.
      await finalizeAfterMerge(projectDir, branch, base);
      return {
        provider: 'github',
        url: existing.url,
        branch,
        base,
        merged_at: existing.merged_at ?? new Date().toISOString(),
      };
    }
  }
  if (!isFeatureBranch(liveBranch)) throw new Error('shipping requires a feature branch');
  // Split the changed set two ways against git's actual pathspec rules. `git add
  // -- <path>` matches a pathspec against the INDEX and the worktree only, never
  // HEAD (builtin/add.c), so a `git rm`-staged deletion — gone from the index
  // AND the worktree yet still tracked in HEAD — dies "pathspec did not match
  // any files" if handed to `git add`. But a HEAD-tracked path absent from the
  // index IS an already-staged deletion by definition, and it rides into the
  // commit through the index untouched. So `toAdd` (the `git add` argv) takes
  // only pathspecs git can match — index-listed (`git ls-files`) or on disk —
  // while `shippable` (the emptiness guard's set) additionally counts the
  // already-staged deletion. raw: -z output is already NUL-delimited; trim would
  // eat the leading space of a space-prefixed first path before the split.
  const trackedOutput = await runGit(projectDir, ['ls-files', '-z', '--', ...changedFiles], { raw: true });
  const tracked = new Set(trackedOutput.split('\0').filter(Boolean));
  const headOutput = await runGit(projectDir, ['ls-tree', '-r', '--name-only', '-z', 'HEAD', '--', ...changedFiles], { raw: true });
  const headTracked = new Set(headOutput.split('\0').filter(Boolean));
  const toAdd = [];
  const shippable = [];
  for (const file of changedFiles) {
    const inIndex = tracked.has(file);
    const onDisk = await exists(path.join(projectDir, file));
    if (inIndex || onDisk) toAdd.push(file);
    if (inIndex || onDisk || headTracked.has(file)) shippable.push(file);
  }
  // Recompute the tree immediately before staging (F4): an external write in the
  // window between gates passing and the merge would ship bytes no gate and no
  // receipt ever attested. Hoisted above the emptiness guard so the re-entry
  // decision below can read shipTreeSha === gateTreeSha; the guard itself is
  // unchanged, so an out-of-band write still fails closed here with 'working
  // tree changed after gates passed' whether or not the candidate set is empty.
  const gateTreeSha = state.gates?.tree_sha ?? null;
  if (!gateTreeSha) throw new Error('shipping requires a recorded passed-gate tree');
  const shipTreeSha = await currentTreeSha(projectDir);
  if (shipTreeSha !== gateTreeSha) {
    throw new Error(`working tree changed after gates passed (gate tree ${gateTreeSha}, ship tree ${shipTreeSha})`);
  }
  // Stage only the pathspecs git can match; a `git rm`-staged deletion is
  // already in the index and must never reach `git add`. Skipping an empty argv
  // is what lets a deletions-only diff through — a deletion-only path list would
  // otherwise die at the pathspec, taking every re-gate attempt with it.
  if (toAdd.length > 0) {
    await runGit(projectDir, ['add', '--', ...toAdd], { timeout_ms: 120_000 });
  }
  // Idempotent commit: on re-entry after a successful commit `git add` stages
  // nothing and `git commit` on that clean tree exits 1 — which previously
  // killed every re-gate (git prints "nothing to commit" to stdout, so the
  // stderr-carrying error surfaced an empty detail on top). Skipping on empty
  // staging is sound because the ship-tree guard above already proved the
  // working tree holds exactly the gate-attested bytes: nothing staged means
  // HEAD already carries them.
  const staged = await runGit(projectDir, ['diff', '--cached', '--name-only']);
  if (shippable.length === 0) {
    // Re-entrancy: a successful deletions-only commit removes the deleted paths
    // from the index, the worktree, AND the new HEAD, so `shippable` empties on
    // every later re-gate even though the run already did its work. The MERGED
    // probe above only covers a provably-merged PR, so recognize the
    // already-committed case here: the ship-tree guard already proved the
    // worktree still equals the gate tree and nothing is staged, so proceed
    // idempotently to push/PR only when HEAD carries a non-empty commit relative
    // to BOTH the origin base tip AND the run's own attested start
    // (state.base_commit_sha) — a run-bound test, not a purely global one. Every
    // genuine crash-after-commit re-entry clears both conjuncts because the ship
    // commit is always non-empty; but a first-entry phantom-only set on a branch
    // that was ALREADY diverged from origin at first entry cannot look 'already
    // committed', because HEAD's tree still equals the run's start tree even
    // though it differs from the origin tip. Fail closed when either base tree is
    // unresolvable (a missing/invalid base_commit_sha never proceeds
    // idempotently), so a stage-created-then-deleted phantom never ships.
    const headTree = await runGit(projectDir, ['rev-parse', 'HEAD^{tree}']);
    const baseTree = await runGit(projectDir, ['rev-parse', `refs/remotes/origin/${base}^{tree}`]).catch(() => null);
    const runBaseTree = await runGit(projectDir, ['rev-parse', `${state.base_commit_sha}^{tree}`]).catch(() => null);
    const alreadyCommitted = staged === ''
      && baseTree !== null && headTree !== baseTree
      && runBaseTree !== null && headTree !== runBaseTree;
    if (!alreadyCommitted) {
      // Fail closed either way, but tell the two failures apart. A genuine no-op
      // (both base trees resolved, HEAD simply never advanced past them) is the
      // NO_VALIDATED case and must keep that exact message. But an UNRESOLVABLE
      // base tree — origin/<base> or the run's attested base_commit_sha rev-parsed
      // to null — is not "no validated changes": the re-entry decision itself
      // could not be evaluated, and the generic message misdiagnoses it (a low
      // finding on run-20260716000644427/#276). When nothing is staged and a base
      // tree is null, name the unresolvable side and its remedy (fetch the base
      // ref / verify the run's base commit) so the operator can act, without ever
      // implying committed or validated work exists. Single-line and bounded: the
      // message flows verbatim into block_reason surfaces.
      if (staged === '' && (baseTree === null || runBaseTree === null)) {
        const unresolved = [];
        if (baseTree === null) {
          unresolved.push(`origin base ref refs/remotes/origin/${base} (fetch the base ref so its tree resolves)`);
        }
        if (runBaseTree === null) {
          unresolved.push(`run base commit ${state.base_commit_sha} (verify the run's attested base commit exists)`);
        }
        throw new Error(`cannot verify ship re-entry: ${unresolved.join(' and ')} could not be resolved`);
      }
      throw new Error('shipping has no validated changed files');
    }
  } else if (staged !== '') {
    const subject = truncateAtWordBoundary(`feat: ${state.objective}`);
    await runGit(projectDir, ['commit', '-m', subject], { timeout_ms: 120_000 });
  }
  // Re-pushing an already-pushed branch is a no-op success.
  await runGit(projectDir, ['push', '--set-upstream', 'origin', branch], { timeout_ms: 120_000 });
  const title = truncateAtWordBoundary(state.objective);
  const body = [
    `APE v2 run: ${state.run_id}`,
    '',
    `Mode: ${state.mode}`,
    `Lane: ${state.lane}`,
    `Receipts: ${state.receipts.length}`,
  ].join('\n');
  // Re-entry after a successful create reuses the OPEN PR (the push above
  // already updated its head). A CLOSED PR is not reusable — gh pr create
  // starts a fresh one for the same branch.
  let url = existing?.state === 'OPEN' ? existing.url : null;
  if (!url) {
    const created = await run('gh', ['pr', 'create', '--base', base, '--head', branch, '--title', title, '--body', body], projectDir);
    if (!created.passed) throw new Error(`failed to create pull request: ${created.output.trim()}`);
    // run() interleaves stderr into output, so take the last URL-shaped line
    // rather than blindly trusting the final line.
    url = created.output.trim().split(/\r?\n/)
      .map((line) => line.trim())
      .reverse()
      .find((line) => /^https:\/\/\S+$/.test(line));
    if (!url) throw new Error(`could not determine pull request URL from gh output: ${created.output.trim()}`);
  }
  if (config.shipping?.required_remote_checks !== false) {
    // Non-blocking handoff (backlog: make the shipping watch resumable). The
    // synchronous in-call `gh pr checks --watch` loop is GONE: it held the
    // record/regate MCP call and the run lock for the entire 5-8 minute watch,
    // and a watcher that died mid-poll (local ephemeral-port exhaustion)
    // stranded a ship whose checks later passed. Instead capture the pushed
    // feature-branch head and hand a NON-BLOCKING watch descriptor back to the
    // caller, which persists it as state.shipping_watch and rests the run in
    // 'shipping'. The bounded poll (pollRemoteChecksAndMerge) drives the merge
    // on a later `ape_run next`. head_oid lets a later MERGED probe prove
    // idempotent completion vs. an external head drift (invariant 8); pr_url and
    // branch are the poll's PR selectors, so no poll-phase gh call ever depends
    // on the current checkout.
    const headOid = await runGit(projectDir, ['rev-parse', 'HEAD']);
    return {
      watch: {
        provider: 'github',
        pr_url: url,
        branch,
        base,
        head_oid: headOid,
        created_at: new Date().toISOString(),
      },
    };
  }
  // required_remote_checks:false — no CI to watch, so phase 1 proceeds straight
  // to the in-call merge for zero added latency (unchanged), returning the merge
  // shape (no watch key).
  const merge = await run('gh', ['pr', 'merge', '--squash', '--delete-branch'], projectDir, 120_000);
  if (!merge.passed) throw new Error(`squash merge failed: ${merge.output.trim()}`);
  await finalizeAfterMerge(projectDir, branch, base);
  return { provider: 'github', url, branch, base, merged_at: new Date().toISOString() };
}

// Whitespace-flatten and bound a gh output tail or a pending summary so a wire
// response or a persisted watch cursor never carries an unbounded multi-line
// blob (≤400 chars). gh colorizes failing check rows, so first strip terminal
// escapes: ANSI/CSI sequences and any remaining non-whitespace C0 control byte
// or DEL — a failure tail reaches wire responses, the statusline, and status.md
// as readable text, never raw escapes. Whitespace controls (tab/newline/CR) are
// left for the flatten pass below to collapse into single spaces.
function boundedTail(text, max = 400) {
  const flat = String(text ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0e-\x1f\x7f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

// The bounded, RESUMABLE remote-checks poll that replaces the in-call
// `gh pr checks --watch` loop. Reads the persisted state.shipping_watch, runs
// exactly ONE non-watch `gh pr checks <selector>` (selector from the watch,
// never the checkout — A1), classifies the result, and on green re-probes the
// PR BY SELECTOR and drives the runtime-owned squash merge. Bounded to seconds:
// a dead/interrupted poll is recovered by simply calling next again. Returns a
// discriminated union:
//   { merged: {...} }                 merged in-call, or observed merged externally at the pushed head
//   { pending: { summary, reason? } } still in progress; call next again
//   { failed: <tail> }                a real check failure or a refused PR state (regate recovers)
// summaries/tails are whitespace-flattened and bounded (≤400).
/**
 * @returns {Promise<{
 *   merged?: object,
 *   pending?: { summary: (string|null), reason?: string },
 *   failed?: string,
 * }>}
 */
export async function pollRemoteChecksAndMerge(projectDir, state, config) {
  if (config.shipping?.provider !== 'github') throw new Error('unsupported merge provider');
  const watch = state.shipping_watch;
  if (!watch) throw new Error('pollRemoteChecksAndMerge requires a persisted shipping_watch');
  // Every poll-phase gh call selects the PR by the persisted URL (A1) — never
  // the current checkout, which may have moved since phase 1.
  const selector = watch.pr_url;
  const checks = await run('gh', ['pr', 'checks', selector], projectDir, 120_000);
  if (!checks.passed) {
    if (NO_CHECKS_PATTERN.test(checks.output)) {
      // CI registers a just-created PR's check runs asynchronously: inside the
      // registration window this is a pure timing race (pending — call next
      // again); past the window a repository with truly no CI must state that
      // intent explicitly and is failed closed (invariant 9: never auto-pass an
      // unchecked merge).
      const createdAt = Date.parse(watch.created_at ?? '');
      const withinWindow = Number.isFinite(createdAt)
        && Date.now() < createdAt + CHECKS_REGISTRATION_WINDOW_MS;
      if (withinWindow) {
        return { pending: { summary: 'no remote checks registered yet', reason: 'checks not yet registered' } };
      }
      return { failed: `no remote checks registered within ${CHECKS_REGISTRATION_WINDOW_MS / 1000}s of PR creation; if this repository has no CI, set shipping.required_remote_checks=false` };
    }
    // Exit code 1 is gh's "a required check failed" verdict — the real tail
    // blocks the run (regate is the recovery). Any OTHER non-zero/absent code
    // (gh's pending exit 8, or a transient spawn fault such as the ephemeral-
    // port exhaustion this feature exists to survive) is ambiguity → pending,
    // never a false failure and never a green pass.
    if (checks.exit_code === 1) {
      return { failed: boundedTail(checks.output) || 'required remote checks failed' };
    }
    return { pending: { summary: boundedTail(checks.output) || 'remote checks in progress', reason: 'checks running' } };
  }
  // Checks are green: re-probe the PR BY SELECTOR (A1) and let its state decide.
  const probe = await run('gh', [
    'pr', 'view', selector,
    '--json', 'url,state,mergedAt,headRefOid',
    '--jq', '[.state, .url, (.mergedAt // "-"), .headRefOid] | join(" ")',
  ], projectDir);
  const pr = probe.passed ? parsePrProbe(probe.output) : null;
  if (!pr) {
    // Green checks but an unreadable PR state: never merge blind (invariant 8).
    return { pending: { summary: 'remote checks passed; PR state not yet readable', reason: 'pr probe unreadable' } };
  }
  if (pr.state === 'MERGED') {
    // Idempotent completion ONLY when the merged head is EXACTLY the head phase
    // 1 pushed (A2): a merge that landed out-of-band at our pushed commit
    // between poll slices completes this run truthfully, marked as
    // probe-observed rather than runtime-performed. A drifted merged head is
    // someone else's merge over unrelated commits and must never complete this
    // run as its own (invariant 8) — it blocks as an external-merge/head-drift.
    if (pr.head_oid === watch.head_oid) {
      await finalizeAfterMerge(projectDir, watch.branch, watch.base);
      return {
        merged: {
          provider: 'github',
          url: pr.url ?? watch.pr_url,
          branch: watch.branch,
          base: watch.base,
          merged_at: pr.merged_at ?? new Date().toISOString(),
          provenance: 'observed-external',
        },
      };
    }
    return { failed: `pull request ${watch.pr_url} was merged at a drifted head (${pr.head_oid}), not the pushed commit ${watch.head_oid}; refusing to complete this run on an external merge (invariant 8)` };
  }
  if (pr.state === 'CLOSED') {
    return { failed: `pull request ${watch.pr_url} was closed without merging; shipping cannot complete — recover with regate or start a new run` };
  }
  if (pr.head_oid !== watch.head_oid) {
    // OPEN but the remote head drifted from the pushed commit: an external push
    // landed un-attested bytes on the branch, so merging would ship what no gate
    // or receipt attested (invariant 8) — fail closed.
    return { failed: `pull request ${watch.pr_url} head drifted from the pushed commit (${pr.head_oid} vs ${watch.head_oid}); refusing to merge un-attested changes — start a fresh run` };
  }
  // OPEN at the pushed head with green checks: the runtime-owned squash merge by
  // selector (A1), then idempotent local cleanup against the persisted base.
  const merge = await run('gh', ['pr', 'merge', selector, '--squash', '--delete-branch'], projectDir, 120_000);
  if (!merge.passed) return { failed: boundedTail(merge.output) || 'squash merge failed' };
  await finalizeAfterMerge(projectDir, watch.branch, watch.base);
  return {
    merged: {
      provider: 'github',
      url: pr.url ?? watch.pr_url,
      branch: watch.branch,
      base: watch.base,
      merged_at: new Date().toISOString(),
    },
  };
}
