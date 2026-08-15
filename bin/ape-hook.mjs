#!/usr/bin/env node
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  normalizeLifecycleEvent,
  evaluateLifecyclePolicy,
  evaluateStartBinding,
  evaluateTreePolicy,
  driftGuardApplies,
  formatHookResponse,
  parseDeletionCommand,
  parseEvidenceCommand,
  evidenceOperandCandidates,
  evidenceOperandNeedsRoot,
  verifyEvidenceExecutableSnapshot,
  pathResolvesWithinClaims,
  pathResolvesOutsideProject,
  resolveOutOfProjectTarget,
  normalizePath,
  looksLikeTest,
  withinTestScope,
  CONTROL_PLANE_TOOLS,
  evaluateWriteContentPolicy,
  isAgentDispatchTool,
} from '../lib/runtime/hooks.js';
import { SCHEMA_VERSION, SEALED_STATUSES } from '../lib/runtime/constants.js';
import { widenedTestClaims } from '../lib/runtime/path-scope.js';
import { resolveGovernedRoot, runtimePaths } from '../lib/runtime/paths.js';
import { appendJsonLine, readJson } from '../lib/runtime/storage.js';
import { currentTreeSha, diffFiles } from '../lib/runtime/git.js';
import { resolveClaimedPluginRead } from '../lib/runtime/external-tools.js';
import {
  bindClaudeSubagent,
  bindCodexSubagent,
  bindGeminiSubagent,
  isCodexDispatchTaskName,
  launchClaudeIntent,
  launchCodexIntent,
  launchGeminiIntent,
  resolveCodexBindingOutcome,
  resolveClaudeBindingOutcome,
  resolveGeminiBindingOutcome,
  resolveSealedCodexBinding,
  resolveSealedClaudeBinding,
  resolveSealedGeminiBinding,
  observeClaudeSubagentStop,
  observeCodexSubagentStop,
  observeGeminiSubagentStop,
} from '../lib/runtime/claude-dispatch.js';
import {
  bindBindingProbe,
  isBindingProbeTaskName,
  launchBindingProbe,
  resolvesBindingProbeIdentity,
} from '../lib/runtime/binding-probe.js';

// Hard bound on hook input. 8 MB clears every legitimate host payload seen in
// the field (an Edit to package-lock.json carries the whole hunk inline) while
// still refusing an unbounded stream; an oversized body is handled by the
// catch, which consults the active run before denying.
const INPUT_CAP_BYTES = 8 * 1024 * 1024;

// The claims a ticket's targets resolve against — identical for the host edit
// tool (event.path_safe) and the deletion channel (event.deletion): a test
// writer resolves against its test_paths (widenedTestClaims: a file-shaped
// claim widens to its directory so a not-yet-existing test file still
// resolves), everyone else against claimed_paths.
function ticketPathClaims(ticket) {
  return ticket.role === 'test_writer' ? widenedTestClaims(ticket.test_paths) : ticket.claimed_paths;
}
// Accumulate raw stdin Buffers and decode EXACTLY ONCE below: appending each
// chunk to a string (`body += chunk`) re-decodes every Buffer independently, so
// a multibyte UTF-8 codepoint whose bytes straddle a pipe-read boundary mangles
// into U+FFFD (audit finding 1.8). Buffer.concat then one toString('utf8')
// decodes the stream intact. The cap still counts BYTE length (Buffer.byteLength
// of each raw Buffer) and the fail-closed oversize path is unchanged: over the
// cap, flag and stop pushing (bounded memory); the try below throws so the catch
// consults the active run before denying.
const chunks = [];
let bodyBytes = 0;
let bodyTooLarge = false;
for await (const chunk of process.stdin) {
  bodyBytes += Buffer.byteLength(chunk);
  if (bodyBytes > INPUT_CAP_BYTES) bodyTooLarge = true;
  else chunks.push(chunk);
}
const body = Buffer.concat(chunks).toString('utf8');

// Corrupt-input project salvage (audit 1.13 nit 9): the fail-closed catch can
// only consult the project the event NAMED if that name survives the parse
// failure. Hoisted so the catch sees whatever the try established — the
// parsed payload's TOP-LEVEL project_dir on any post-parse throw, or null
// when the body never parsed. bodyNeverParsed is the parse-failure flag the
// catch's regex salvage is gated on: it is set ONLY when the body itself
// never parsed (the oversize refusal or JSON.parse throwing), never by a
// post-parse throw (a git failure, a dispatch-resolver exception). Without
// that gate a post-parse throw would regex-scan a fully PARSEABLE body whose
// only '"project_dir"' occurrences can be NESTED raw keys (an MCP tool's
// tool_input arguments, a structured tool_response) that the parseable path
// would ignore — letting attacker-shaped content redirect the failure
// consult.
let salvagedProjectDir = null;
let bodyNeverParsed = false;

try {
  if (bodyTooLarge) {
    bodyNeverParsed = true;
    throw new Error(`APE hook input exceeds ${INPUT_CAP_BYTES} UTF-8 bytes`);
  }
  let input = {};
  if (body.trim()) {
    try {
      input = JSON.parse(body);
    } catch (parseCause) {
      bodyNeverParsed = true;
      throw parseCause;
    }
  }
  if (typeof input.project_dir === 'string' && input.project_dir) {
    salvagedProjectDir = input.project_dir;
  }
  const event = normalizeLifecycleEvent(input);

  // The APE control-plane MCP tools (ape_run / ape_config / ape_history) are the
  // runtime's own surface — the sanctioned path to record receipts, abort, and
  // override. They never write production files, and gating them behind the
  // stage/tree guard deadlocks recovery: a failed stage's unattributed tree
  // change would otherwise block the very record/abort/override call needed to
  // clear it. Their own validation (receipt binding, lane policy, input guard)
  // is the trust boundary, not this hook. Always allow, and never let a launch/
  // bind branch misfire on a look-alike prompt.
  //
  // The exemption is UNBOUND-MAIN-SESSION-ONLY: the recovery-deadlock concern
  // is the orchestrator's alone (friction #13; phantom-dispatch incident). A
  // subagent's control-plane call deliberately falls through binding resolution
  // below (so event.ape_managed is known from resolveClaudeBinding or the ape:*
  // agent_type fallback) into evaluateLifecyclePolicy's one-owner deny —
  // denying it here instead would misfire on non-APE-managed subagents the
  // runtime does not govern. event.is_subagent (hooks.js) is
  // Boolean(agent_identity || input.is_subagent), the same identity attestation
  // the binding flow relies on. A host-delivered ticket binding
  // (event.ticket_id: an explicit ticket_id payload field or the APE_TICKET_ID
  // environment value the normalization seam accepts) is equally
  // disqualifying: a bound control-plane event is a worker call even when the
  // host attaches no agent identity, so it too falls through to the one-owner
  // deny. The binding term is TRUTHINESS, not != null, so an empty-string
  // APE_TICKET_ID is no binding and keeps the exemption. Operational
  // consequence: an APE_TICKET_ID exported in the operator's own shell binds
  // every main-session event and forfeits main-session control-plane recovery
  // — including the corrupt-state fail-closed path below — until it is unset.
  // The fallthrough is inert for the other branches: the launch branch
  // requires tool_name === 'Agent', SubagentStart requires that event, and
  // driftGuardApplies never binds an MCP tool name, so a main-session-shaped
  // analysis is unaffected.
  //
  // Ordering is load-bearing: this exemption runs BEFORE the runtimePaths /
  // active-state read below, so a corrupt or unreadable active.json still
  // allows the operator's control-plane recovery instead of failing closed.
  if (!event.is_subagent && !event.ticket_id && CONTROL_PLANE_TOOLS.test(event.tool_name)) {
    process.stdout.write(`${JSON.stringify(formatHookResponse(event, {
      decision: 'allow',
      reason: 'APE control-plane MCP call is exempt from the stage guard',
    }))}\n`);
    process.exit(0);
  }

  const paths = runtimePaths(event.project_dir);
  const state = await readJson(paths.active, null);

  let ticket = null;
  // Third container matches extractPath's own priority order (lib/runtime/
  // hooks.js normalizeLifecycleEvent): a payload shaped {tool_name, input:
  // {...}} carries its tool input under the bare `input` key, and the path
  // check below (event.file, via extractPath) already resolves through that
  // container. This local `toolInput` feeds both the launch-detection reads
  // just below AND the write-content byte gate; missing `input.input` would
  // leave the byte gate closed for that spelling even though the path check
  // right below it is fully governed for the same event.
  const toolInput = input.tool_input ?? input.toolInput ?? input.input ?? {};
  const requestedAgentType =
    toolInput.subagent_type ?? toolInput.subagentType ?? toolInput.agent_type ?? toolInput.agentType ?? '';
  const requestedTaskName = toolInput.task_name ?? toolInput.taskName ?? '';
  const subagentPrompt = Array.isArray(toolInput.Subagents) ? toolInput.Subagents[0]?.Prompt : null;
  const prompt = toolInput.prompt ?? toolInput.message ?? subagentPrompt ?? '';
  const isApeLaunch =
    requestedAgentType.startsWith('ape:') ||
    /(?:^|\n)APE_DISPATCH_NONCE=/.test(prompt) ||
    (event.host === 'codex' && isCodexDispatchTaskName(requestedTaskName));
  if (
    event.host === 'codex' &&
    event.event === 'PreToolUse' &&
    isAgentDispatchTool(event.tool_name) &&
    isBindingProbeTaskName(requestedTaskName)
  ) {
    const launch = await launchBindingProbe(paths, input);
    process.stdout.write(`${JSON.stringify(formatHookResponse(event, {
      decision: launch.valid ? 'allow' : 'deny',
      reason: launch.reason,
    }))}\n`);
    process.exit(0);
  }
  if (
    state &&
    event.event === 'PreToolUse' &&
    isAgentDispatchTool(event.tool_name) &&
    isApeLaunch
  ) {
    const launch = event.host === 'codex'
      ? await launchCodexIntent(paths, state, input)
      : event.host === 'gemini'
        ? await launchGeminiIntent(paths, state, input)
        : await launchClaudeIntent(paths, state, input);
    process.stdout.write(`${JSON.stringify(formatHookResponse(event, {
      decision: launch.valid ? 'allow' : 'deny',
      reason: launch.reason,
    }))}\n`);
    process.exit(0);
  }
  const lifecycleAgentType = input.agent_type ?? input.agentType ?? '';
  if (event.host === 'codex' && event.event === 'SubagentStart') {
    const probeBinding = await bindBindingProbe(paths, input);
    if (probeBinding.matched) {
      process.stdout.write(`${JSON.stringify(formatHookResponse(event, {
        decision: probeBinding.valid ? 'allow' : 'deny',
        reason: probeBinding.reason,
        additional_context: probeBinding.additional_context,
      }))}\n`);
      process.exit(0);
    }
  }
  if (
    event.host === 'codex' &&
    event.event === 'PreToolUse' &&
    await resolvesBindingProbeIdentity(paths, input)
  ) {
    process.stdout.write(`${JSON.stringify(formatHookResponse(event, {
      decision: 'deny',
      reason: 'APE binding canary may not call tools; return only the injected probe acknowledgement JSON',
    }))}\n`);
    process.exit(0);
  }
  // Backward-compatible host-delivered binding seam. New Codex launches use
  // the nonce reservation below; an explicit lifecycle ticket remains valid
  // for hosts that already attach one directly.
  if (state && event.host === 'codex' && event.event === 'SubagentStart' && event.ticket_id) {
    const binding = evaluateStartBinding(state, event);
    process.stdout.write(`${JSON.stringify(formatHookResponse(event, {
      decision: binding.valid ? 'allow' : 'deny',
      reason: binding.reason,
    }))}\n`);
    process.exit(0);
  }
  const codexHasLaunchedIntent =
    event.host === 'codex' && event.event === 'SubagentStart';
  const geminiHasLaunchedIntent =
    event.host === 'gemini' && event.event === 'SubagentStart';
  if (
    state &&
    event.event === 'SubagentStart' &&
    (lifecycleAgentType.startsWith('ape:') || codexHasLaunchedIntent || geminiHasLaunchedIntent)
  ) {
    const binding = event.host === 'codex'
      ? await bindCodexSubagent(paths, state, input)
      : event.host === 'gemini'
        ? await bindGeminiSubagent(paths, state, input)
        : await bindClaudeSubagent(paths, state, input);
    process.stdout.write(`${JSON.stringify(formatHookResponse(event, {
      decision: binding.valid ? 'allow' : 'deny',
      reason: binding.reason,
      additional_context: binding.additional_context,
    }))}\n`);
    process.exit(0);
  }
  // dispatch-deny-reason-is-non-discriminating: the LIVE resolver reports WHY
  // it denied a binding alongside the record-or-null outcome, and that cause
  // is carried into evaluateLifecyclePolicy's context so the tool-call deny at
  // hooks.js can name it instead of always emitting the same fixed sentence.
  // The sealed path answers identity, not liveness — its own branch
  // (hooks.js's sealed handling) returns before ever reaching that generic
  // deny, so it is left posture-unchanged and reports no cause.
  let dispatchBindingDenialCause = null;
  let stoppedBinding = null;
  if (state && event.event === 'SubagentStop' && event.agent_identity) {
    const observation = event.host === 'codex'
      ? await observeCodexSubagentStop(paths, state, input)
      : event.host === 'gemini'
        ? await observeGeminiSubagentStop(paths, state, input)
        : await observeClaudeSubagentStop(paths, state, input);
    stoppedBinding = observation.record;
  }
  if (stoppedBinding) {
    ticket = state.tickets.find((entry) => entry.ticket_id === stoppedBinding.ticket_id) ?? null;
    event.ticket_id = stoppedBinding.ticket_id;
    event.ape_managed = true;
  } else if (state && (event.host === 'codex' || event.host === 'gemini') && event.ticket_id) {
    ticket = state.tickets.find((entry) => entry.ticket_id === event.ticket_id) ?? null;
    event.ape_managed = true;
  } else if (state && event.agent_identity) {
    let binding;
    if (SEALED_STATUSES.has(state.status)) {
      // A sealed run's orphaned subagent must still resolve its binding — the
      // intent is 'expired' and its ticket no longer pending, so the live
      // resolver returns null and the orphan would look like unbound host
      // activity. The sealed resolver answers identity, not liveness, and the
      // lifecycle policy's sealed branch denies the orphan's writes.
      binding = event.host === 'codex'
        ? await resolveSealedCodexBinding(paths, state, input)
        : event.host === 'gemini'
          ? await resolveSealedGeminiBinding(paths, state, input)
          : await resolveSealedClaudeBinding(paths, state, input);
    } else {
      const outcome = event.host === 'codex'
        ? await resolveCodexBindingOutcome(paths, state, input)
        : event.host === 'gemini'
          ? await resolveGeminiBindingOutcome(paths, state, input)
          : await resolveClaudeBindingOutcome(paths, state, input);
      binding = outcome.record;
      dispatchBindingDenialCause = outcome.cause;
    }
    if (binding) {
      ticket = state.tickets.find((entry) => entry.ticket_id === binding.ticket_id) ?? null;
      event.ticket_id = binding.ticket_id;
      event.ape_managed = true;
    } else {
      event.ape_managed = lifecycleAgentType.startsWith('ape:') || event.host === 'codex' || event.host === 'gemini';
    }
  } else if (state && event.ticket_id) {
    ticket = state.tickets.find((entry) => entry.ticket_id === event.ticket_id) ?? null;
  }
  // Generic Codex plugins are not trusted merely because they are installed.
  // Once the immutable ticket is resolved, an exact per-operation read claim
  // may narrow an otherwise unknown plugin MCP call to a conservative read.
  // Store the resolved classification on the event so lifecycle policy, drift
  // reconciliation, and the persisted effect audit all consume one verdict.
  event.external_tool = resolveClaimedPluginRead(
    event.external_tool,
    ticket?.tool_claims,
  );
  if (ticket && event.targets.length > 0) {
    for (const target of event.targets) {
      if (target.file) {
        const mutableTarget = /** @type {typeof target & { path_safe?: boolean }} */ (target);
        mutableTarget.path_safe = await pathResolvesWithinClaims(
          paths.root,
          target.file,
          ticketPathClaims(ticket),
        );
      }
    }
    // A freeform apply_patch may govern several files. The synchronous policy
    // consumes one aggregate verdict, so every in-project target must pass and
    // a lexical outside target stays false until the out-of-project walk below
    // proves that the entire operation is exempt.
    event.path_safe = event.targets.every((target) =>
      /** @type {typeof target & { path_safe?: boolean }} */ (target).path_safe === true);
  }
  // Write-content byte gate (roadmap entry authored-and-agent-facing-byte-
  // integrity, WRITE side): beside the path-safety precompute above, which
  // inspects only WHERE a Write/Edit/MultiEdit/NotebookEdit call writes, this
  // inspects WHAT it writes. Pure and synchronous (string scanning only, no
  // I/O) — see evaluateWriteContentPolicy (lib/runtime/hooks.js) for the
  // route table and the hazard code-point class — computed here for every
  // bound-ticket event, not only a path-bearing one, since content is
  // orthogonal to path; evaluateWriteContentPolicy itself returns `{safe:
  // true}` for a tool_name with no content-bearing route, so this precompute
  // is a no-op for every call this gate does not govern.
  if (ticket) {
    event.write_content_hazard = evaluateWriteContentPolicy(event.tool_name, toolInput);
  }
  // Deletion channel: the host edit tools can only replace content, so a
  // parsed `rm` / `git rm` from a bound subagent is path-checked here — same
  // claims selection and realpath semantics as the edit gate, plus the role
  // rules — and the synchronous policy consumes only event.deletion. Safe is
  // true only if EVERY target passes; the first failure carries the reason.
  if (ticket && event.tool_name === 'Bash') {
    const parsed = parseDeletionCommand(event.command ?? '');
    if (parsed) {
      let safe = true;
      let reason = null;
      // A relative `rm` target is resolved by the shell against the session's
      // current directory, which drifts below paths.root when the session cd's
      // into a subdirectory (resolveProjectRoot exists precisely because it
      // does). Resolving against paths.root instead would check a different
      // path than the one the shell deletes — a false deny when cwd is deeper,
      // a false allow when it sits in a sibling subtree. Resolve against the
      // reported cwd first, then normalize to root-relative.
      const sessionCwd =
        typeof input.cwd === 'string' && input.cwd.length > 0 ? input.cwd : paths.root;
      for (const target of parsed.targets) {
        const absoluteTarget = path.isAbsolute(target)
          ? target
          : path.resolve(sessionCwd, target);
        const relative = normalizePath(absoluteTarget, paths.root);
        if (!relative) {
          safe = false;
          reason = `deletion target ${target} resolves outside the project`;
          break;
        }
        if (ticket.role === 'implementer' && looksLikeTest(relative, ticket.test_paths)) {
          safe = false;
          reason = 'implementers may not delete authored tests';
          break;
        }
        if (ticket.role === 'test_writer' && !withinTestScope(relative, ticket.test_paths)) {
          safe = false;
          reason = 'test writers may delete only claimed test paths';
          break;
        }
        if (!(await pathResolvesWithinClaims(paths.root, relative, ticketPathClaims(ticket)))) {
          safe = false;
          reason = `deletion target ${relative} resolves outside the ticket claims`;
          break;
        }
      }
      event.deletion = { targets: parsed.targets, safe, reason };
    }
  }
  // Evidence-command containment: the realpath-grade half of the bound-subagent
  // Bash gate. evaluateLifecyclePolicy is SYNCHRONOUS (consumed with no await
  // below) and must stay so, and realpath is async — so the verdict is computed
  // here, beside the deletion and path_safe precomputes, and the policy only
  // READS event.evidence.
  //
  // TWO INDEPENDENT VERDICTS, deliberately not folded together:
  //   cwd_safe  the session's reported cwd must resolve inside the governed
  //             root. Claude's Bash tool keeps a persistent shell whose cwd
  //             drifts on `cd`, and every relative operand resolves against
  //             THAT — the deletion channel above already learned this. It is a
  //             PRECONDITION of the policy's lexical containment shortcut
  //             ("relative + no `..` segment implies contained"), which with cwd
  //             at /other/repo would be false, so it is consulted for EVERY
  //             bound evidence command, not only path-bearing ones.
  //   safe      every operand that NEEDS a root — a bare token, an `=`-suffix,
  //             or a path stuck onto a short flag, when it is absolute or
  //             carries a `..` segment — resolves inside the root with realpath
  //             semantics. A relative, dotdot-free TOKEN needs no root and is
  //             judged lexically by the policy, which is published residual R3.
  //             The `cd` TARGET is the ONE exception, added by round 5: it is
  //             resolved UNCONDITIONALLY, whatever its shape.
  //
  // POLARITY TRAP (why the catch WRITES a verdict instead of swallowing):
  // pathResolvesOutsideProject returns FALSE for a path it cannot resolve, i.e.
  // "inside/safe" on this polarity — the OPPOSITE of its write-gate use — and it
  // swallows only ENOENT. An EACCES throw from nearestExistingPath would
  // otherwise reach the top-level catch below, which while a run is live DENIES
  // EVERY SUBSEQUENT TOOL EVENT and bricks the session until dist/ is reverted
  // by hand. The catch therefore records an explicit unsafe verdict the policy
  // acts on, and the assignment happens on BOTH paths.
  if (ticket && event.tool_name === 'Bash' && typeof event.command === 'string') {
    try {
      const sessionCwd =
        typeof input.cwd === 'string' && input.cwd.length > 0 ? input.cwd : paths.root;
      // Fails OPEN on an unresolvable cwd (pathResolvesOutsideProject returns
      // false there) — the safe direction for a check whose false positive is a
      // total session lockout, and the escape it closes still needs a cwd that
      // really exists outside the root.
      const cwdSafe = !(await pathResolvesOutsideProject(paths.root, sessionCwd));
      const parsedEvidence = parseEvidenceCommand(event.command);
      const executionCwd = parsedEvidence?.cdTarget === null || !parsedEvidence
        ? sessionCwd
        : path.resolve(sessionCwd, parsedEvidence.cdTarget);
      const executableVerdict = parsedEvidence
        ? verifyEvidenceExecutableSnapshot(
            state?.policy?.evidence_executables,
            parsedEvidence.tokens[0],
            { env: process.env, cwd: executionCwd },
          )
        : null;
      let safe = true;
      let reason = cwdSafe
        ? null
        : `session cwd ${sessionCwd} resolves outside the governed project`;
      if (parsedEvidence) {
        // ROUND 5, FINDING 4 — THE CD TARGET IS RESOLVED UNCONDITIONALLY, and
        // it is the only operand that is. R3's residual is that a relative,
        // dotdot-free operand is judged LEXICALLY on both sides, so an IN-TREE
        // SYMLINK pointing outside is admitted; for an ordinary token that
        // still needs a second step to matter, but for the `cd` target it needs
        // none — `cd <in-tree symlink to outside> && npm test` relocates the
        // ENTIRE execution in ONE admitted command and runs a foreign
        // package.json's script where the drift guard and receipt-time diff
        // recomputation have no reach. Lexically `escape` is indistinguishable
        // from `sub`, so only a realpath resolution separates them.
        //
        // The fix is deliberately HERE and not in evidenceOperandNeedsRoot:
        // widening that predicate would make EVERY relative token need a root,
        // and every event that carries no project_dir would fail closed. This
        // costs exactly one extra pathResolvesOutsideProject call per command,
        // inside the existing try/catch, and it still ADMITS an in-tree target
        // — a plain directory, an in-tree symlink to another in-tree directory,
        // or a not-yet-created one (nearestExistingPath walks up to the root).
        // The TOKEN half of R3 is NOT closed by this and stays published.
        if (parsedEvidence.cdTarget !== null) {
          const cdAbsolute = path.resolve(sessionCwd, parsedEvidence.cdTarget);
          if (await pathResolvesOutsideProject(paths.root, cdAbsolute)) {
            safe = false;
            reason = reason ?? `cd target ${parsedEvidence.cdTarget} resolves outside the governed project`;
          }
        }
        outer: for (const token of parsedEvidence.tokens) {
          if (!safe) break;
          for (const candidate of evidenceOperandCandidates(token)) {
            if (!evidenceOperandNeedsRoot(candidate)) continue;
            // Relative operands resolve against the session cwd, exactly as the
            // shell resolves them — same reasoning as the deletion targets.
            const absolute = path.resolve(sessionCwd, candidate);
            if (await pathResolvesOutsideProject(paths.root, absolute)) {
              safe = false;
              reason = reason ?? `evidence operand ${candidate} resolves outside the governed project`;
              break outer;
            }
          }
        }
      }
      event.evidence = {
        tokens: parsedEvidence?.tokens ?? null,
        safe,
        cwd_safe: cwdSafe,
        executable_safe: executableVerdict?.safe ?? null,
        executable_reason: executableVerdict?.reason ?? null,
        reason,
      };
    } catch (cause) {
      event.evidence = {
        tokens: null,
        safe: false,
        cwd_safe: false,
        executable_safe: false,
        executable_reason: `evidence executable check failed: ${cause?.code ?? cause?.message ?? String(cause)}`,
        reason: `evidence operand check failed: ${cause?.code ?? cause?.message ?? String(cause)}`,
      };
    }
  }
  // Out-of-project exemption: only a target that BOTH looks outside the project
  // (event.file is null while a path was present) AND realpath-resolves outside
  // the project root is exempt from the write gate. A no-path payload
  // (event.target_path null) and a raw-outside path aliasing an in-project file
  // keep failing closed; an in-project-looking path never reaches this branch.
  //
  // The same walk also exposes the RESOLVED target, because the exemption is no
  // longer unconditional: the execution-redirecting-configuration refusal in
  // evaluateLifecyclePolicy keys on the final path SEGMENTS, and it consults the
  // RAW target and this RESOLVED one as TWO lookups of which NEITHER SUBSUMES
  // the other. They catch OPPOSITE symlink layouts. The RAW tail is what catches
  // the dotfile-manager layout: under stow/chezmoi $HOME/.cargo is a symlink INTO
  // a managed store, so resolution ERASES the match — the resolved tail is
  // cargo/config.toml, which is in no table — and only the raw tail matches at
  // all. The RESOLVED tail catches the mirror layout, an ordinary-named path
  // (link/config.toml) that resolves ONTO a covered directory, which the raw tail
  // cannot see. Deleting either lookup drops a whole layout. The boolean's own
  // value and polarity are unchanged, and the policy consults the resolved path
  // only as a SECOND chance to match — an absent field (every direct unit call,
  // and any event this precompute skips) degrades to the raw tail alone.
  if (state && event.targets.length > 0) {
    for (const target of event.targets) {
      if (!target.file && target.target_path) {
        const outOfProject = await resolveOutOfProjectTarget(paths.root, target.target_path);
        const mutableTarget = /** @type {typeof target & {
         *   out_of_project?: boolean,
         *   resolved_target_path?: string | null,
         * }} */ (target);
        mutableTarget.out_of_project = outOfProject.outside;
        mutableTarget.resolved_target_path = outOfProject.resolved;
      }
    }
    // Preserve the legacy scalar fields for ordinary one-path write tools.
    // For a multi-file patch, the out-of-project exemption applies only when
    // every target independently resolves outside the governed project.
    event.out_of_project = event.targets.every((target) =>
      /** @type {typeof target & { out_of_project?: boolean }} */ (target).out_of_project === true);
    if (event.targets.length === 1) {
      event.resolved_target_path = /** @type {typeof event.targets[0] & {
       *   resolved_target_path?: string | null,
       * }} */ (event.targets[0]).resolved_target_path ?? null;
    }
  }
  let decision;
  const reconcileEvents = new Set([
    'PreToolUse',
    'PostToolUse',
    'PostToolUseFailure',
    'SubagentStop',
  ]);
  // The drift lockdown engages only while a run is actually writing: a
  // terminal run left behind in active.json must not police the repo. And it
  // binds only where the drift could be extended or laundered into a result
  // (driftGuardApplies) — read-only tools stay available for the diagnosis
  // and recovery an unattributed change demands. One deliberate widening
  // (audit finding 1.7): every MAIN-SESSION Bash post event reconciles, so a
  // shell write verb the SHELL_WRITE blocklist does not enumerate is DENIED as
  // unattributed drift at its own post event (a loud, operator-visible
  // refusal). NOTE: the deny does not REVERT the write, so if the persisted
  // drift falls within a pending ticket's claims it can still be re-attributed
  // to that ticket at its later Agent post-event below — a known, tracked gap
  // (docs/research/2026-07-22-main-session-write-laundering.md), not a closed
  // one.
  if (
    state?.status === 'running' &&
    reconcileEvents.has(event.event) &&
    driftGuardApplies(event)
  ) {
    const tree = await currentTreeSha(paths.root);
    const baseline =
      state.tree_sha ??
      state.tickets?.map((entry) => entry.base_tree_sha).find(Boolean);
    const changed = baseline && baseline !== tree
      ? await diffFiles(paths.root, baseline, tree)
      : [];
    if (changed.length > 0) {
      // Expired tickets share stage/claims with their retry replacement; if
      // they stayed in the pending pool every post-expiry write would match
      // both and be denied as ambiguous (same exclusion as activeTickets).
      const expired = new Set(state.expired_tickets ?? []);
      const pending = state.tickets.filter((candidate) =>
        candidate.writable &&
        !expired.has(candidate.ticket_id) &&
        !state.receipts?.some((receipt) => receipt.ticket_id === candidate.ticket_id));
      const candidates = pending.filter((candidate) =>
        evaluateTreePolicy(
          { ...event, is_subagent: true },
          { state, ticket: candidate },
          changed,
        ).decision === 'allow');
      // Friction #6/#15: the parent's Agent-result payload carries no agent
      // identity, so a successful writer stage's return always reaches this
      // guard unbound (ticket null) even though the diff is exactly the
      // pending ticket's claimed work — the deny fired on every writer
      // stage. When the change matches EXACTLY ONE pending ticket's claims,
      // attribute it to that ticket and defer to receipt admission, which
      // independently recomputes and re-validates the same diff before
      // anything is accepted. Scope is deliberately the main session's
      // Agent post-events alone: zero candidates (genuinely unattributed
      // drift), ambiguous coverage (>1), main-session Bash/Edit drift,
      // foreign subagents at SubagentStop, and a bound subagent whose sole
      // candidate is not its own ticket all keep the deny below.
      if (
        candidates.length === 1 &&
        !ticket &&
        !event.is_subagent &&
        event.tool_name === 'Agent' &&
        (event.event === 'PostToolUse' || event.event === 'PostToolUseFailure')
      ) {
        decision = {
          decision: 'allow',
          reason: `APE tree change attributed to sole pending ticket ${candidates[0].ticket_id}; receipt admission re-verifies the diff`,
        };
      } else if (candidates.length !== 1 || !ticket || candidates[0].ticket_id !== ticket.ticket_id) {
        decision = {
          decision: 'deny',
          reason: candidates.length > 1
            ? 'APE result denied: shared-tree change has ambiguous ticket attribution'
            : 'APE result denied: tree change has no exact active ticket attribution',
        };
      } else {
        const treeDecision = evaluateTreePolicy(event, { state, ticket }, changed);
        if (
          treeDecision.decision === 'deny' ||
          !['PreToolUse', 'PostToolUse', 'PostToolUseFailure'].includes(event.event)
        ) {
          decision = treeDecision;
        }
      }
    }
  }
  if (!decision) decision = evaluateLifecyclePolicy(event, {
    state,
    ticket,
    claudeBindingDenialCause: dispatchBindingDenialCause,
  });
  if (
    ticket &&
    event.external_tool &&
    (event.event === 'PostToolUse' || event.event === 'PostToolUseFailure')
  ) {
    try {
      const response = input.tool_response ?? input.toolResponse ?? null;
      const responseHash = response === null
        ? null
        : createHash('sha256').update(JSON.stringify(response)).digest('hex');
      await appendJsonLine(paths.externalToolEffects, {
        schema_version: SCHEMA_VERSION,
        run_id: state.run_id,
        ticket_id: ticket.ticket_id,
        host: event.host,
        agent_identity: event.agent_identity,
        provider: event.external_tool.provider,
        operation: event.external_tool.operation,
        effect: event.external_tool.effect,
        resources: event.external_tool.resources,
        tool_use_id: input.tool_use_id ?? input.toolUseId ?? null,
        status: event.event === 'PostToolUse' ? 'completed' : 'failed',
        response_hash: responseHash,
        occurred_at: new Date().toISOString(),
      });
    } catch (cause) {
      decision = {
        decision: 'deny',
        reason: `APE external tool result denied: effect audit could not be persisted (${cause?.code ?? cause?.message ?? String(cause)})`,
      };
    }
  }
  process.stdout.write(`${JSON.stringify(formatHookResponse(event, decision))}\n`);
} catch (cause) {
  // The input may be unparseable (oversized or corrupt), so consult the
  // active run before deciding: failing closed is only meaningful while a
  // run can still write or resume. A project with no run in flight — or a
  // finished one left in active.json — must never be governed by the failure
  // path. `blocked` is terminal for scheduling but the run stays live for
  // recovery (re-gate/reset), and `shipping` is mid-merge, so both keep the
  // deny: the unparseable path must not be more permissive than the
  // parseable one for a run an operator can still resume. Unreadable state
  // keeps the conservative deny.
  //
  // Salvage (audit 1.13 nit 9): ONLY when the body itself never parsed
  // (bodyNeverParsed — the oversize refusal or JSON.parse throwing), recover
  // the named project_dir from the retained (<= 8 MB) prefix with a bounded
  // quoted-JSON-string match and decode the captured token with JSON.parse
  // in its own try. A post-parse throw keeps the parsed payload's hoisted
  // top-level project_dir (or null) and never regex-scans the body: on a
  // parseable body the first '"project_dir"' key match can be a NESTED raw
  // key the parseable path would ignore.
  if (bodyNeverParsed && salvagedProjectDir === null) {
    const salvage = /"project_dir"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(body);
    if (salvage) {
      try {
        const named = JSON.parse(salvage[1]);
        if (typeof named === 'string' && named) salvagedProjectDir = named;
      } catch {
        // The captured token did not decode as a JSON string; keep env/cwd.
      }
    }
  }
  const event = normalizeLifecycleEvent({ project_dir: salvagedProjectDir });
  // Monotonicity guard: consult BOTH candidate roots — the env/cwd
  // resolution the pre-salvage catch always used (the CLAUDE_PROJECT_DIR /
  // CODEX_CWD pins seeding the `.ape` marker walk from cwd) AND the
  // salvaged/parsed explicit dir — and allow only when NEITHER holds a live
  // run. A salvaged name can therefore only ADD a deny (corrupt stdin naming
  // a run-holding project fails closed against THAT project even when the
  // process cwd is a run-less one); it can never steer the consult AWAY from
  // a run-holding env/cwd root, so for every input this path is at least as
  // strict as env/cwd-only resolution — stricter, never looser. The Set
  // dedupes: with nothing salvaged, event.project_dir IS the env/cwd root.
  const candidateRoots = new Set([resolveGovernedRoot(), event.project_dir]);
  let decision = null;
  try {
    let liveRun = false;
    for (const candidate of candidateRoots) {
      const state = await readJson(runtimePaths(candidate).active, null);
      if (state && state.status !== 'completed' && state.status !== 'aborted') {
        liveRun = true;
        break;
      }
    }
    if (!liveRun) {
      decision = {
        decision: 'allow',
        reason: `APE hook error with no live run; host behavior is unchanged (${cause?.message ?? String(cause)})`,
      };
    }
  } catch {
    // active.json exists but cannot be read in some candidate root: keep
    // failing closed.
  }
  if (!decision) {
    decision = {
      decision: 'deny',
      reason: `APE hook failed closed: ${cause?.message ?? String(cause)}`,
    };
  }
  process.stdout.write(`${JSON.stringify(formatHookResponse(event, decision))}\n`);
}
