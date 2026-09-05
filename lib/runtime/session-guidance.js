import { stat } from 'node:fs/promises';
import {
  RUNTIME_VERSION,
  SCHEMA_VERSION,
  SEALED_STATUSES,
  SESSION_GUIDANCE_MAX_BYTES,
} from './constants.js';
import { isCanonicalRunId, projectRunDiagnostic, safeDiagnosticText } from './diagnostics.js';
import { runtimePaths } from './paths.js';
import { activeState, dispatchLiveness } from './status-service.js';
import { resolveCodexBootstrapCandidate } from './codex-bootstrap.js';
import { bindingProbeStatus } from './binding-probe.js';
import { APE_VERSION, validatedVersionProvenance } from './versions.js';

// Session guidance is orientation, not enforcement. Hooks and the scheduler
// remain authoritative for permissions and transitions; this small context
// keeps a newly started/resumed/cleared/compacted main session synchronized
// without asking APE to own a repository's AGENTS.md or CLAUDE.md.
export const SESSION_GUIDANCE_VERSION = 1;
export { SESSION_GUIDANCE_MAX_BYTES } from './constants.js';
export const SESSION_START_SOURCES = Object.freeze(['startup', 'resume', 'clear', 'compact']);

const HASH = /^[0-9a-f]{64}$/i;
const DISPATCH_STATES = new Set(['pending', 'needs-redispatch', 'live', 'stopped', 'error', 'none']);
const NEXT_ACTION_KIND = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const FAILED_PROBE_GUIDANCE = 'diagnose the native binding failure with ape_run probe-status; do not automatically launch or replace a probe or start a run';

function boundedUtf8(text, maxBytes = SESSION_GUIDANCE_MAX_BYTES) {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  const suffix = '\n[APE session guidance truncated at its runtime byte bound]';
  const suffixBytes = Buffer.byteLength(suffix, 'utf8');
  let output = '';
  let used = 0;
  for (const character of text) {
    const width = Buffer.byteLength(character, 'utf8');
    if (used + width + suffixBytes > maxBytes) break;
    output += character;
    used += width;
  }
  return `${output}${suffix}`;
}

function contractSummary(state) {
  const runContractHash = typeof state?.run_contract?.hash === 'string' &&
    HASH.test(state.run_contract.hash)
    ? state.run_contract.hash.toLowerCase()
    : null;
  const planVersion = Number.isInteger(state?.plan_contract_version)
    ? state.plan_contract_version
    : null;
  const receiptVersions = new Set();
  if (Array.isArray(state?.tickets) && state.tickets.length <= 256) {
    for (const ticket of state.tickets) {
      if (Number.isInteger(ticket?.receipt_contract_version)) {
        receiptVersions.add(ticket.receipt_contract_version);
      }
    }
  }
  const parts = [
    runContractHash ? `immutable run contract ${runContractHash}` : 'no immutable run-contract hash recorded',
    planVersion === null ? 'planning contract unversioned' : `planning contract v${planVersion}`,
    receiptVersions.size === 0
      ? 'receipt contract unversioned'
      : `receipt contract v${[...receiptVersions].sort((left, right) => left - right).join('/')}`,
  ];
  return parts.join('; ');
}

function safeDispatchState(state, supplied) {
  if (DISPATCH_STATES.has(supplied)) return supplied;
  if (DISPATCH_STATES.has(state?.dispatch_state)) return state.dispatch_state;
  // Runtime-v2 deliberately derives dispatch liveness from the intent/lock
  // plane instead of persisting it in active.json. Callers that cannot inspect
  // that plane still need a valid, conservative diagnostic input: `pending`
  // says "re-check/recover dispatch" without mislabelling healthy state as
  // corrupt merely because the derived field is absent.
  if (state?.version === 2 || state?.runtime_version === 2) return 'pending';
  return undefined;
}

function responseNextSafeAction(response) {
  const actions = Array.isArray(response?.actions) ? response.actions : [];
  if (actions.some((action) => action?.type === 'dispatch_agent')) {
    return 'launch the returned dispatch_agent action exactly as provided';
  }
  const nextActionKind = response?.next_action?.kind;
  if (typeof nextActionKind === 'string' && NEXT_ACTION_KIND.test(nextActionKind)) {
    return `follow the returned next_action (kind ${nextActionKind}) exactly as provided`;
  }
  if (actions.some((action) => action?.type === 'dispatch_pending')) {
    return 'follow the returned dispatch_pending recovery: wait for the existing flight or use its audited expire-dispatch lever';
  }
  if (actions.some((action) => action?.type === 'reject')) {
    return 'stop and follow the returned rejection; no lifecycle transition was authorized';
  }
  if (actions.some((action) => action?.type === 'blocked')) {
    return 'stop and follow the returned blocked recovery; do not advance automatically';
  }
  return null;
}

export function runtimeGuidanceForState(state, options = {}) {
  const corrupt = options.corrupt === true;
  const dispatchState = safeDispatchState(state, options.dispatchState);
  const diagnostic = projectRunDiagnostic(state, { corrupt, dispatchState });
  // SessionStart prerequisites belong to the host running this session, not
  // necessarily the host recorded on retained sealed history. State-bearing
  // ape_run responses omit this override and continue to use the run's host.
  const host = options.host ?? state?.host;
  const codexStartPrerequisites = new Set(['inactive', 'completed', 'aborted']).has(
    diagnostic.reason_code,
  ) && host === 'codex'
    ? 'review a ready ape_run preview admission manifest; complete ape_run probe, launch dispatch.spawn_args unchanged, confirm ape_run probe-status, send ape_run probe-ack, then ape_run start with expected_admission_digest from preview'
    : null;
  const nextSafeAction = safeDiagnosticText(options.nextSafeAction, 256)
    ?? codexStartPrerequisites
    ?? diagnostic.next_safe_action;
  const source = SESSION_START_SOURCES.includes(options.source) ? options.source : null;
  const lines = [
    `APE runtime guidance v${SESSION_GUIDANCE_VERSION} (authoritative session orientation)`,
    `Loaded runtime: APE ${APE_VERSION}; runtime v${RUNTIME_VERSION}; state schema ${SCHEMA_VERSION}.`,
    ...(source ? [`Session refresh: ${source}.`] : []),
  ];

  if (diagnostic.reason_code === 'inactive') {
    lines.push(
      'Run state: no active APE run.',
      `Next safe action: ${nextSafeAction}. Invoke APE only when the user explicitly requests it.`,
    );
  } else if (diagnostic.reason_code === 'corrupt_state') {
    lines.push(
      'Run state: active state is unavailable or invalid; do not infer lifecycle authority from repository prose.',
      `Next safe action: ${nextSafeAction}.`,
    );
  } else {
    const runId = isCanonicalRunId(state?.run_id) ? state.run_id : 'unknown';
    const status = safeDiagnosticText(state?.status, 64) ?? 'unknown';
    const stage = safeDiagnosticText(state?.stage, 64) ?? 'unknown';
    const mode = safeDiagnosticText(state?.mode, 32) ?? 'unknown';
    const lane = safeDiagnosticText(state?.lane, 32) ?? 'unknown';
    const provenance = validatedVersionProvenance(state);
    const runLabel = SEALED_STATUSES.has(status) ? 'Last sealed run' : 'Active run';
    lines.push(
      `${runLabel}: ${runId}; status ${status}; stage ${stage}; mode ${mode}; lane ${lane}.`,
      `Run contract: ${contractSummary(state)}.`,
      ...(provenance.ape_version
        ? [`Admitted runtime: APE ${provenance.ape_version}; runtime v${provenance.runtime_version}.`]
        : []),
      `Next safe action: ${nextSafeAction}.`,
    );
  }

  lines.push(
    'Use ape_status to refresh state and ape_run for lifecycle transitions; follow the returned next_action exactly.',
    ...(host === 'codex' ? ['Native children call ape_bind with their launch bootstrap arguments; only trusted hook-injected context authorizes stage work.'] : []),
    'Do not edit .ape/runtime directly. Stage work belongs to workers carrying APE-injected ticket context.',
    'Repository instruction files remain repository-owned; APE does not install or update operational policy in them.',
  );
  return boundedUtf8(lines.join('\n'));
}

export async function loadSessionGuidance(projectDir, options = {}) {
  if (options.is_subagent === true) return null;
  const paths = runtimePaths(projectDir);
  const configured = await stat(paths.runtime).then(
    (metadata) => metadata.isDirectory(),
    () => false,
  );
  if (!configured) return null;
  if (options.host === 'codex' && options.native_input &&
      typeof options.native_input === 'object' && !Array.isArray(options.native_input)) {
    try {
      // Native SessionStart can omit agent_id just like a child tool event.
      // Exact observed child evidence suppresses parent-only orientation; it
      // never binds a ticket or provides bootstrap/stage authority.
      if (await resolveCodexBootstrapCandidate(paths, options.native_input)) return null;
    } catch (error) {
      // A known child with a missing/new turn or conflicting exact evidence
      // must not become a main session. Unrelated storage damage does not
      // identify the caller and must not silence the parent's recovery help.
      if (error?.bootstrap_identity_known === true) return null;
    }
  }
  let state;
  try {
    state = await activeState(paths);
  } catch {
    return runtimeGuidanceForState(null, {
      corrupt: true,
      host: options.host,
      source: options.source,
    });
  }
  let dispatchState = safeDispatchState(state);
  if (state && typeof state === 'object' && !Array.isArray(state)) {
    try {
      dispatchState = (await dispatchLiveness(paths, state, { tolerateCorrupt: true })).dispatch_state;
    } catch {
      // Dispatch artifacts are a separate diagnostic plane. An I/O failure is
      // not corruption of readable active.json, but it still makes RESUME and
      // NEXT unsafe; expose the same fail-closed abort guidance as malformed
      // intent evidence instead of falling back to a redispatch suggestion.
      dispatchState = 'error';
    }
  }
  let nextSafeAction;
  if ((options.host ?? state?.host) === 'codex' &&
      (!state || SEALED_STATUSES.has(state.status))) {
    try {
      // Orientation may inspect bounded proof, but must never publish legacy
      // quarantine, bind a child, replace a probe, or repair runtime evidence.
      if ((await bindingProbeStatus(paths, { readOnly: true })).infrastructure_status === 'failed') {
        nextSafeAction = FAILED_PROBE_GUIDANCE;
      }
    } catch {
      // Corrupt/unreadable proof cannot become permission to launch again.
      // Use fixed guidance rather than reflecting paths, errors, or bearers.
      nextSafeAction = FAILED_PROBE_GUIDANCE;
    }
  }
  return runtimeGuidanceForState(state, {
    dispatchState,
    nextSafeAction,
    host: options.host,
    source: options.source,
  });
}

export function formatSessionGuidanceResponse(guidance) {
  if (typeof guidance !== 'string' || guidance.length === 0) return {};
  return {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: boundedUtf8(guidance),
    },
  };
}

export function attachRuntimeGuidance(response) {
  if (!response || typeof response !== 'object' || Array.isArray(response) || !response.run) {
    return response;
  }
  return {
    ...response,
    runtime_guidance: runtimeGuidanceForState(response.run, {
      dispatchState: response.dispatch_state,
      nextSafeAction: responseNextSafeAction(response),
    }),
  };
}
