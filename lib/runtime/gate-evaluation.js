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

export async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
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
export const IMPACTED_COMMAND_MAX_CHARS = 6000;

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
export async function resolveSuiteSelection(projectDir, state, config) {
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

// The shared gate-evaluation context: the observed tree sha, the resolved suite
// selection (full or impacted), and the suite cache read. Both the in-call
// runMergeGates and the detached startGateSuite/pollGateSuite path compute it
// identically so the cache key, cache write, and check shapes stay byte-identical
// across the two paths.
export async function gateSuiteContext(projectDir, paths, state, config) {
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

export async function evaluateGatePreflight(projectDir, state, config, ctx) {
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

export function skippedFullSuite(treeSha) {
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


export async function prepareGateWatchContext(projectDir, paths, state, config) {
  const baseCtx = await gateSuiteContext(projectDir, paths, state, config);
  const preflight = await evaluateGatePreflight(projectDir, state, config, baseCtx);
  return {
    ...baseCtx,
    preflight,
    preflightKey: gatePreflightKey(state, config, baseCtx),
    watchPreflight: gateWatchPreflight(preflight),
    skippedFull: skippedFullSuite(baseCtx.treeSha),
  };
}

export async function prepareGatePollContext(projectDir, paths, state, config) {
  const baseCtx = await gateSuiteContext(projectDir, paths, state, config);
  return {
    ...baseCtx,
    preflightKey: gatePreflightKey(state, config, baseCtx),
  };
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

