// MCP wire projection (friction #26; roadmap entry ape-run-response-size-cap).
// This module bounds ape_run responses at the MCP boundary only: persistence,
// ticket files, receipts, and history on disk remain complete and
// authoritative, and service functions keep returning full state to internal
// consumers. Three bounds compose here: the UNCONDITIONAL per-record summaries
// (run.tickets[], run.receipts[], history records) applied on every response,
// the equally unconditional roadmap-block field trim reached from BOTH
// projections (see boundRoadmapBlock — the only bound that reaches a response
// carrying neither actions[] nor records[]),
// a SIZE-TRIGGERED dedupe pass, and finally a hard UTF-8 byte check that falls
// back to resolvable on-disk references. Below the byte budget the legacy wire
// content remains additive; above it, `.ape/runtime` stays authoritative. Pure
// functions, no I/O, and no in-place writes: every caller hands in LIVE runtime
// objects (see compactAction).

import { RECEIPT_INPUT_SCHEMA } from './receipt-input.js';
import { canonicalJson, sha256 } from './canonical.js';
import {
  hasPersistedFailureDomain,
  hasPersistedTerminalReasonCode,
  projectTerminalRecovery,
  terminalFailureDomain,
} from './terminal-telemetry.js';
import {
  FAILURE_DOMAIN_TAXONOMY_VERSION,
  isFailureDomain,
  validatedOrchestrationTelemetry,
} from './orchestration-telemetry.js';
import {
  isApeVersion,
  isDispatchEnvelopeVersion,
  isDispatchProtocolVersion,
  isRuntimeVersion,
} from './versions.js';

// friction #26 follow-up: a pending ticket that crosses the wire in run.tickets[]
// re-embeds two fields verbatim — the full run objective (ticketObjective at
// service.js:53 appends `Run objective: ${run.objective}`) and the ~1.6 KB
// record-input contract (pipeline.js:20 assigns the shared RECEIPT_INPUT_SCHEMA
// as output_schema). Neither is unique information, so the wire summary
// references them, but they are recoverable from DIFFERENT places. The
// objective is recoverable from this response on the normal path and from
// active.json/ticket files after the hard reference fallback. The output_schema
// rides the
// dispatch_agent action ticket only while that ticket crosses whole, the
// size-triggered pass below compacts it too on an over-budget response, and an
// ape_run status response carries no actions array at all. In both of those
// cases the on-disk ticket file is the ONLY place the full contract exists
// (prompts/common.md sanctions exactly that read).
// Elision requires CANONICAL equality with RECEIPT_INPUT_SCHEMA (a custom stage
// output_schema is never dropped) and an exact suffix match against the
// ticketObjective template (a template drift fails open to the full string), so
// no unique information is ever destroyed.
const RECEIPT_INPUT_SCHEMA_CANONICAL = canonicalJson(RECEIPT_INPUT_SCHEMA);
export const OUTPUT_SCHEMA_REFERENCE = Object.freeze({
  see: 'full output_schema: read .ape/runtime/tickets/<ticket_id with ":" replaced by "_">.json; an under-budget dispatch_agent response also includes it',
});

// Roadmap entry ape-run-response-size-cap. Two measured host rejections of a
// live ape_run response (71,183 and 71,534 chars) bracket the real ceiling:
// Claude Code's default MCP tool-result limit is 25,000 tokens, and this
// response family tokenized at ~2.85 chars/token across those two samples.
// 48,000 chars sits ~33% below the smaller rejection, and ~1.31x above the
// A3 dominating superset the authored suite fences with (~36.7 KB) — a strict
// superset of every shape the existing bounded-responses fixtures produce,
// whose own largest projection is ~24.8 KB (~1.94x). The size pass therefore
// stays additive rather than reshaping today's wire.
// The original estimate used UTF-16 String.length against a host token cap. The
// implementation now enforces the more conservative and deterministic bound on
// serialized UTF-8 bytes. If ordinary lossless dedupe cannot satisfy it, the
// final projection carries explicit authoritative references instead of prose
// truncation or another recovery loop.
export const RESPONSE_BUDGET_BYTES = 48_000;
// Compatibility alias for callers that imported the original name. The hard
// enforcement unit is now UTF-8 bytes, not UTF-16 String.length.
export const RESPONSE_BUDGET_CHARS = RESPONSE_BUDGET_BYTES;
export const NEXT_ACTION_KINDS = Object.freeze([
  'continue_same_agent',
  'redispatch_same_ticket',
  'stage_retry',
  'directed_replan',
  'remediate_product_finding',
  'wait',
  'answer_preflight',
  'blocked',
]);
// Keep the exported historical vocabulary byte-stable while accepting the
// receipt-v1 capability successor control that predates this typed list.
const NEXT_ACTION_KIND_SET = new Set([...NEXT_ACTION_KINDS, 'capability_recovery']);
// Only values the reducer and launch recovery paths emit may survive into the
// action-priority fallback. Arbitrary legacy strings are recoverable from the
// authoritative state and must not crowd out a native launch capability.
const DISPATCH_RECOVERY_KIND_SET = new Set([
  'directed_replan',
  'legacy_receipt_interrupted',
  'receipt_validation_exhausted',
  'redispatch_same_ticket',
  'reissue_same_contract',
  'remediate_product_finding',
  'capability_scope_expansion',
  'stage_retry',
]);

// The single marker every compacted form carries: compactPendingTicket builds
// its objective suffix from it and the size pass assigns it to a compacted
// status state.objective, so the pinned `Run objective: see run.objective`
// literal and the status marker have one source of truth.
export const RUN_OBJECTIVE_REFERENCE = 'see run.objective';

// Wire-only dedupe of a pending StageTicket's two duplicated fields. Every other
// field pending-ticket admission and expire-dispatch consume (ids, hashes,
// deadline_at, model, claims, attempt) passes through whole. Fail-open: a custom
// schema or an objective lacking the exact template suffix crosses unchanged.
export function compactPendingTicket(ticket, runObjective) {
  const compact = { ...ticket };
  if (
    typeof runObjective === 'string' &&
    runObjective.length > 0 &&
    typeof ticket.objective === 'string'
  ) {
    const suffix = `Run objective: ${runObjective}`;
    if (ticket.objective === runObjective) {
      compact.objective = RUN_OBJECTIVE_REFERENCE;
    } else if (ticket.objective.endsWith(suffix)) {
      // Legacy persisted tickets used the decorated objective form. Retain its
      // wire-only compaction without rewriting the on-disk ticket hash.
      compact.objective =
        ticket.objective.slice(0, ticket.objective.length - suffix.length) +
        `Run objective: ${RUN_OBJECTIVE_REFERENCE}`;
    }
  }
  // Reference-equality fast path (pipeline.js:20 hands every stage the shared
  // frozen object) avoids re-serializing the schema on the hot in-memory
  // start/next path; the canonical fallback still covers disk-round-tripped state.
  if (
    ticket.output_schema &&
    (ticket.receipt_contract_version === 1 ||
      ticket.output_schema === RECEIPT_INPUT_SCHEMA ||
      canonicalJson(ticket.output_schema) === RECEIPT_INPUT_SCHEMA_CANONICAL)
  ) {
    compact.output_schema = OUTPUT_SCHEMA_REFERENCE;
  }
  if (ticket.receipt_contract_version === 1 && ticket.capability_manifest) {
    compact.capability_manifest = {
      version: ticket.capability_manifest.version,
      config_hash: ticket.capability_manifest.config_hash,
      objective_hash: ticket.capability_manifest.objective_hash,
      preflight_hash: ticket.capability_manifest.preflight_hash,
      ...(ticket.capability_manifest.run_contract
        ? { run_contract: ticket.capability_manifest.run_contract }
        : {}),
      see: 'full execution-role and planning capability views: read the immutable ticket file referenced by ticket_id',
    };
  }
  return compact;
}

function summarizeTicket(ticket, status) {
  return {
    ticket_id: ticket.ticket_id,
    stage_id: ticket.stage_id,
    role: ticket.role,
    attempt: ticket.attempt,
    status,
    ticket_hash: ticket.ticket_hash,
    issued_at: ticket.issued_at,
  };
}

function summarizeReceipt(receipt, ticketsById) {
  return {
    receipt_id: receipt.receipt_id,
    ticket_id: receipt.ticket_id,
    stage_id: ticketsById.get(receipt.ticket_id)?.stage_id ?? null,
    status: receipt.status,
    receipt_hash: receipt.receipt_hash,
    head_tree_sha: receipt.head_tree_sha,
  };
}

function projectSuccessorGuidance(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  if (
    value.version !== 2 ||
    value.eligible !== true ||
    typeof value.predecessor_run_id !== 'string' ||
    typeof value.retained_tree_sha !== 'string' ||
    typeof value.config_hash !== 'string' ||
    typeof value.eligibility_reason !== 'string'
  ) return undefined;
  return {
    version: 2,
    eligible: true,
    predecessor_run_id: value.predecessor_run_id.slice(0, 128),
    retained_tree_sha: value.retained_tree_sha.slice(0, 64),
    config_hash: value.config_hash.slice(0, 64),
    eligibility_reason: value.eligibility_reason.slice(0, 64),
    structured_successor_supported: false,
    unavailable_reason: 'authenticated-host-approval-unavailable',
    recovery_action: 'override-reset',
    required_authorization: 'explicit-operator-override',
    automatic_start: false,
    automatic_ship: false,
    ...(typeof value.configuration_drift?.changed === 'boolean'
      ? { configuration_drift: { changed: value.configuration_drift.changed } }
      : {}),
  };
}

function summarizePreflight(preflight) {
  const artifact = preflight?.artifact;
  if (!artifact || typeof artifact !== 'object') return preflight;
  return {
    version: preflight.version,
    artifact_hash: preflight.artifact_hash,
    receipt_hash: preflight.receipt_hash,
    acceptance_count: Array.isArray(artifact.acceptance) ? artifact.acceptance.length : 0,
    non_goal_count: Array.isArray(artifact.non_goals) ? artifact.non_goals.length : 0,
    required_profile_ids: (artifact.verification_profiles ?? [])
      .filter((profile) => profile?.disposition === 'required')
      .map((profile) => profile.id),
    question_ids: (artifact.questions ?? []).map((question) => question.id),
  };
}

export function summarizeHistoryRecord(record) {
  const orchestration = validatedOrchestrationTelemetry(record.orchestration);
  return {
    schema_version: record.schema_version,
    ...(isApeVersion(record.ape_version) ? { ape_version: record.ape_version } : {}),
    ...(isRuntimeVersion(record.runtime_version) ? { runtime_version: record.runtime_version } : {}),
    ...(isApeVersion(record.host_plugin_version)
      ? { host_plugin_version: record.host_plugin_version }
      : {}),
    ...(isDispatchProtocolVersion(record.protocol_version)
      ? { protocol_version: record.protocol_version }
      : {}),
    ...(isDispatchEnvelopeVersion(record.envelope_version)
      ? { envelope_version: record.envelope_version }
      : {}),
    run_id: record.run_id,
    status: record.status,
    mode: record.mode,
    lane: record.lane,
    block_reason: record.block_reason,
    ...(record.abort_reason ? { abort_reason: record.abort_reason } : {}),
    ...(hasPersistedTerminalReasonCode(record)
      ? { terminal_reason_code: record.terminal_reason_code }
      : {}),
    ...(isDispatchEnvelopeVersion(record.terminal_reason_taxonomy_version)
      ? { terminal_reason_taxonomy_version: record.terminal_reason_taxonomy_version }
      : {}),
    ...(hasPersistedFailureDomain(record)
      ? {
          failure_domain: record.failure_domain,
          failure_domain_taxonomy_version: record.failure_domain_taxonomy_version,
        }
      : {}),
    ...(orchestration
      ? {
          orchestration: {
            receipt_accepts: orchestration.receipt_accepts,
            receipt_first_pass_accepts: orchestration.receipt_first_pass_accepts,
            receipt_rejections: orchestration.receipt_rejections,
            protocol_redispatches: orchestration.protocol_redispatches,
            stage_retries: orchestration.stage_retries,
            directed_replans: orchestration.directed_replans,
            remediation_cycles: orchestration.remediation_cycles,
            time_to_first_writer_ms: orchestration.time_to_first_writer_ms,
            token_dispatches: orchestration.token_usage.dispatches,
            token_attested_dispatches: orchestration.token_usage.attested_dispatches,
            token_unobserved_dispatches: Math.max(
              0,
              orchestration.token_usage.dispatches - orchestration.token_usage.attested_dispatches,
            ),
          },
        }
      : {}),
    ...projectTerminalRecovery(record),
    completed_at: record.completed_at,
    ...(record.base_branch ? { base_branch: record.base_branch } : {}),
    base_commit_sha: record.base_commit_sha,
    final_tree_sha: record.final_tree_sha,
    merge: record.merge,
    record_hash: record.record_hash,
    ticket_count: record.tickets?.length ?? 0,
    receipt_count: record.receipts?.length ?? 0,
    ...(record.supersedes ? { supersedes: record.supersedes } : {}),
    // Legacy cross-run supersession remains visible as audit metadata. Primary
    // lineage collapse separately requires the immutable structured attestation.
    ...(record.supersedes_run ? { supersedes_run: record.supersedes_run } : {}),
    // Imported-record provenance is a truthfulness marker: without it a
    // legacy plan imported as 'completed' is indistinguishable on the wire
    // from a run the runtime actually gated.
    ...(record.imported ? { imported: record.imported } : {}),
    ...(record.source_path ? { source_path: record.source_path } : {}),
    ...(record.preflight ? { preflight: summarizePreflight(record.preflight) } : {}),
    ...(record.remediation_route ? { remediation_route: record.remediation_route } : {}),
  };
}

function ticketIndex(tickets) {
  return new Map(
    Array.isArray(tickets) ? tickets.map((ticket) => [ticket.ticket_id, ticket]) : [],
  );
}

export function projectRunState(state) {
  // Every run-level field passes through as-is, and run.objective is the SINGLE
  // full objective copy on the wire: a pending ticket keeps its stage-specific
  // prefix but references run.objective for the suffix, and references the
  // dispatch ticket for its record-input output_schema (friction #26 follow-up).
  // Only tickets[] and receipts[] are transformed, and only when they are arrays
  // — minimal fixture states without them must round-trip untouched.
  const projected = { ...state };
  delete projected.verification_profile_roots;
  delete projected.execution_budget;
  delete projected.budget_continuation;
  if (state.status === 'input_required' && state.input_required?.kind === 'execution_budget') {
    projected.status = ['starting', 'running', 'gating', 'shipping']
      .includes(state.input_required.resume_status)
      ? state.input_required.resume_status
      : 'running';
    projected.stage = state.input_required.resume_stage ?? 'resume';
    delete projected.input_required;
  }
  if (state.run_contract && state.capability_snapshot?.version === 1) {
    projected.capability_snapshot = {
      version: state.capability_snapshot.version,
      config_hash: state.capability_snapshot.config_hash,
      required_capabilities: structuredClone(
        state.capability_snapshot.required_capabilities ?? [],
      ),
      see: 'full capability catalog: read run.run_contract.ref and verify run.run_contract.hash',
    };
  }
  if (state.status === 'completed' || !isFailureDomain(state.failure_domain)) {
    delete projected.failure_domain;
    delete projected.failure_domain_taxonomy_version;
  }
  if (state.preflight) projected.preflight = summarizePreflight(state.preflight);
  if (state.input_required?.preflight_hash) {
    projected.input_required = {
      preflight_hash: state.input_required.preflight_hash,
      question_ids: Array.isArray(state.input_required.question_ids)
        ? state.input_required.question_ids
        : (state.input_required.questions ?? []).map((question) => question?.id).filter(Boolean),
    };
  }
  // The trusted-start executable snapshot is enforcement-only persisted state:
  // it can contain several dozen absolute realpaths/fingerprints, but no
  // orchestrator decision reads it from an MCP response. Keep it in active and
  // archived state while removing it from every wire projection, otherwise a
  // fresh run spends the response budget on redundant host-local PATH detail
  // and can trigger dispatch-ticket compaction on an otherwise small action.
  if (
    state.policy &&
    typeof state.policy === 'object' &&
    !Array.isArray(state.policy) &&
    Object.hasOwn(state.policy, 'evidence_executables')
  ) {
    projected.policy = { ...state.policy };
    delete projected.policy.evidence_executables;
  }
  if (Array.isArray(state.tickets)) {
    const receiptedIds = new Set(
      Array.isArray(state.receipts) ? state.receipts.map((receipt) => receipt.ticket_id) : [],
    );
    // Expired means marked by the runtime in state.expired_tickets, never a
    // deadline_at clock check: deadline-overrun admission keeps a past-deadline
    // unexpired ticket actionable, so its receipt is still admissible. Such a
    // ticket stays in the pending branch and keeps every field late-receipt
    // admission and expire-dispatch consume (ticket_id, ticket_hash, deadline_at,
    // model, claims, attempt); only the two duplicated fields are referenced, and
    // both remain recoverable from run.objective, the dispatch_agent action
    // ticket, and the on-disk ticket file.
    const expiredIds = new Set(state.expired_tickets ?? []);
    projected.tickets = state.tickets.map((ticket) => {
      if (receiptedIds.has(ticket.ticket_id)) return summarizeTicket(ticket, 'receipted');
      if (expiredIds.has(ticket.ticket_id)) return summarizeTicket(ticket, 'expired');
      return compactPendingTicket(ticket, state.objective);
    });
  }
  if (Array.isArray(state.receipts)) {
    const ticketsById = ticketIndex(state.tickets);
    projected.receipts = state.receipts.map((receipt) => summarizeReceipt(receipt, ticketsById));
  }
  return projected;
}

function projectAction(action) {
  if (action?.type === 'dispatch_agent') {
    // action.ticket is the canonical ticket (by construction pending) and the
    // one the orchestrator hands to the subagent (skills/run/SKILL.md step 5),
    // never the deduped run.tickets[] entry — so this unconditional pass never
    // summarizes it, and below the size budget it crosses complete. Over the
    // budget the size pass in projectRunResponse dedupes this ticket's two
    // duplicated fields as well and the on-disk ticket file becomes the only
    // complete copy. The second copy embedded in the dispatch metadata is
    // UNCONDITIONALLY collapsed to a bare ticket_id here, on every response,
    // over the budget and under it alike; nothing else in action.dispatch is
    // read or rewritten.
    return {
      ...action,
      ...(action.dispatch
        ? {
            dispatch: {
              ...action.dispatch,
              ...(action.dispatch.ticket
                ? { ticket: { ticket_id: action.dispatch.ticket.ticket_id } }
                : {}),
            },
          }
        : {}),
    };
  }
  if (action?.type === 'history_archived') {
    // The immutable on-disk record keeps everything; ape_history serves it.
    return { ...action, record: summarizeHistoryRecord(action.record) };
  }
  if (action?.type === 'status' && action.state && typeof action.state === 'object') {
    // Zero-pending NEXT embeds the full run state in a status action; project
    // it — never drop it, callers may read it — so it stays consistent with
    // the projected response.run instead of smuggling every output_schema and
    // receipt evidence blob past the bound.
    return { ...action, state: projectRunState(action.state) };
  }
  return action;
}

// --- The derived roadmap block (roadmap entry ape-run-status-roadmap-unbounded).
// The THIRD bound, unconditional like the first, and the only one that reaches a
// response carrying neither actions[] nor records[]. The derived roadmap crosses
// the wire on FOUR surfaces past TWO different short-circuits: ape_run status
// (service.js:2808-2814 returns { ok, active, run, sealed?, roadmap? } with no
// actions key, so the size-triggered pass below is structurally unable to see
// it) and ape_history roadmap-status/-register/-supersede (service.js:3099,
// :3109 and :3119 each return { ok, roadmap } with no records key, so
// projectHistoryResponse's fast path hands them straight back). Both projections
// therefore call this helper.
//
// TWO FIELDS, and only two. Every other field of a derived entry
// (roadmap.js:269-276) is already capped in the store by LIMITS
// (roadmap.js:26-35) — id, title, depends_on, superseded.replaced_by,
// discovered_by — and the derived entry carries neither description nor
// acceptance. superseded.reason is the exception: supersedeEntries
// (roadmap.js:127-130) validates it for non-emptiness ONLY, so its sole ceiling
// is the 64 KB assertSafeInput envelope and one supersede call can put ~64 KB on
// one entry. The ape_run-only corrupt marker (service.js:2802-2807) carries a
// raw derivation error message, unbounded for the same reason. Capping reason in
// roadmap.js is NOT the fix: it could not shrink what is already stored, and it
// would edit stored audit truth.
//
// UNCONDITIONAL, never size-triggered: run.tickets[]/receipts[] are already
// summarized unconditionally, so a live status response sits under
// RESPONSE_BUDGET_CHARS and a bound gated on overBudget() would never fire.
//
// RECOVERY, and who may use it. A trimmed superseded.reason stays verbatim in
// .ape/runtime/roadmap.json, and deriveRoadmap, the service results themselves,
// and the persist-path status.md renderer (service.js:454-455,
// status-doc.js:255-276 — a fifth, non-wire consumer this bound leaves complete)
// all keep the full text. status.md lists each entry's id/title/status/
// provenance but NOT its reason, so roadmap.json is the only recovery for a
// trimmed reason, and reading it belongs to the ORCHESTRATOR or the OPERATOR: a
// bound subagent may read exactly one .ape file, its own ticket
// (prompts/common.md). corrupt.reason is stored in NO file, so its recovery is
// instead ape_history roadmap-status, which does not catch a derivation fault
// and surfaces it untruncated as an error — hence its more generous cap.
//
// This first pass bounds fields without dropping entries. If the complete
// response still exceeds the hard byte ceiling, the final projection replaces
// the roadmap block with counts plus `.ape/runtime/roadmap.json`, explicitly
// disclosing the authoritative source rather than silently discarding entries.
const ELLIPSIS = '…';

// Fixed widths, so a reader's rule is the tight "exactly N characters ending in
// U+2026" and not the ambiguous "ends in U+2026" — this repo's own bounded
// summaries end in U+2026 (boundedGateSummary, service.js:87-91) and a
// supersession reason routinely quotes one. Derivation: 8 stale entries (the
// shape of a real store) at 4,096 is 32,768 chars, ~68% of
// RESPONSE_BUDGET_CHARS, which still leaves room for the projected run state
// beside it on the tighter of the two surfaces (ape_run status also carries the
// whole projected run and its full run.objective; ape_history's { ok, roadmap }
// has roughly double the headroom, so the constant binds there with slack).
const ROADMAP_REASON_CHARS = 4_096;
const ROADMAP_CORRUPT_REASON_CHARS = 8_192;

// The in-tree convention, slice(0, N - 1) + U+2026: what is kept is a verbatim
// prefix and the marker is the last character and the only one added. Returns
// its input BY IDENTITY when nothing changed — throughout this bound the
// identity predicate is "nothing changed", never "in bounds".
function trimProse(value, max) {
  if (typeof value !== 'string' || value.length <= max) return value;
  return `${value.slice(0, max - 1)}${ELLIPSIS}`;
}

// CONSTRUCTS a new entry and a new entry.superseded rather than assigning in
// place: roadmap.js:275 spreads the STORED superseded object by reference, so an
// in-place trim would corrupt the store's own in-memory copy and the next
// persist would write the corruption to disk (see the module header).
function boundRoadmapEntry(entry) {
  const superseded = entry === null || typeof entry !== 'object' ? null : entry.superseded;
  if (superseded === null || typeof superseded !== 'object') return entry;
  const reason = trimProse(superseded.reason, ROADMAP_REASON_CHARS);
  if (reason === superseded.reason) return entry;
  return { ...entry, superseded: { ...superseded, reason } };
}

// Key-gated (RM7): an absent roadmap key and a `roadmap: null` block
// (roadmap-status on a roadmap-less project — note typeof null === 'object')
// both cross byte-identical, and so does any block this changes nothing in.
// Idempotent by construction: a second pass meets a reason of exactly N
// characters, which is not OVER N, so it re-trims nothing, mints no second
// marker and returns the block by identity.
function boundRoadmapBlock(roadmap) {
  if (roadmap === null || typeof roadmap !== 'object') return roadmap;
  const entries = Array.isArray(roadmap.entries) ? roadmap.entries.map(boundRoadmapEntry) : null;
  const entriesChanged =
    entries !== null && entries.some((entry, index) => entry !== roadmap.entries[index]);
  // A corrupt marker carries no entries[]; never invent one.
  const reason =
    roadmap.corrupt === true
      ? trimProse(roadmap.reason, ROADMAP_CORRUPT_REASON_CHARS)
      : roadmap.reason;
  if (!entriesChanged && reason === roadmap.reason) return roadmap;
  return {
    ...roadmap,
    ...(entriesChanged ? { entries } : {}),
    ...(reason === roadmap.reason ? {} : { reason }),
  };
}

function responseUtf8Bytes(response) {
  try {
    return Buffer.byteLength(JSON.stringify(response), 'utf8');
  } catch {
    return null;
  }
}

function boundedWireText(value, max = 512) {
  if (typeof value !== 'string') return value;
  return value.length <= max ? value : `${value.slice(0, max - 1)}${ELLIPSIS}`;
}

// next_action is control data, not an open-ended response envelope. Keep its
// public vocabulary exact and its payload bounded so even the final reference-
// only fallback cannot be defeated by a valid `kind` carrying arbitrary extra
// fields. The runtime currently emits only these scalar/short-list fields.
function boundedNextAction(value) {
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || !NEXT_ACTION_KIND_SET.has(value.kind)
  ) return null;
  const output = { kind: value.kind };
  for (const field of [
    'ticket_id',
    'terminal_reason_code',
    'state',
    'required_operator_action',
    'required_control_action',
  ]) {
    if (typeof value[field] === 'string') output[field] = boundedWireText(value[field], 160);
  }
  if (DISPATCH_RECOVERY_KIND_SET.has(value.recovery_kind)) {
    output.recovery_kind = value.recovery_kind;
  }
  if (Array.isArray(value.ticket_ids)) {
    output.ticket_ids = value.ticket_ids
      .filter((ticketId) => typeof ticketId === 'string')
      .slice(0, 16)
      .map((ticketId) => boundedWireText(ticketId, 160));
  }
  if (typeof value.consumes_product_attempt === 'boolean') {
    output.consumes_product_attempt = value.consumes_product_attempt;
  }
  if (isFailureDomain(value.failure_domain)) output.failure_domain = value.failure_domain;
  // There is deliberately no `automatic_successor: true` representation.
  // Only a stable blocked result may state the negative guarantee explicitly.
  if (value.kind === 'blocked' && value.automatic_successor === false) {
    output.automatic_successor = false;
  }
  return output;
}

function ticketReference(ticket) {
  if (!ticket || typeof ticket !== 'object') return ticket;
  const ticketId = ticket.ticket_id;
  return {
    ticket_id: ticketId,
    stage_id: ticket.stage_id,
    role: ticket.role,
    attempt: ticket.attempt,
    writable: ticket.writable,
    ticket_hash: ticket.ticket_hash,
    ...(ticket.model ? { model: ticket.model } : {}),
    ...(typeof ticketId === 'string'
      ? { ticket_ref: `.ape/runtime/tickets/${ticketId.replaceAll(':', '_')}.json` }
      : {}),
  };
}

function minimalTicketReference(ticket) {
  if (!ticket || typeof ticket !== 'object') return ticket;
  const minimal = {};
  for (const field of ['ticket_id', 'role', 'attempt', 'writable', 'ticket_hash']) {
    if (ticket[field] !== undefined) minimal[field] = ticket[field];
  }
  if (typeof ticket.ticket_id === 'string') {
    minimal.ticket_ref = `.ape/runtime/tickets/${ticket.ticket_id.replaceAll(':', '_')}.json`;
  }
  return minimal;
}

function runReference(state) {
  if (!state || typeof state !== 'object') return state;
  const receipts = Array.isArray(state.receipts) ? state.receipts : [];
  const receipted = new Set(receipts.map((receipt) => receipt.ticket_id));
  const expired = new Set(state.expired_tickets ?? []);
  const pending = Array.isArray(state.tickets)
    ? state.tickets
      .filter((ticket) => !receipted.has(ticket.ticket_id) && !expired.has(ticket.ticket_id))
      .map(ticketReference)
    : [];
  return {
    run_id: state.run_id,
    status: state.status,
    stage: state.stage,
    mode: state.mode,
    lane: state.lane,
    ...(state.terminal_reason_code ? { terminal_reason_code: state.terminal_reason_code } : {}),
    ...(state.status !== 'completed' && isFailureDomain(state.failure_domain)
      ? {
          failure_domain: state.failure_domain,
          failure_domain_taxonomy_version:
            state.failure_domain_taxonomy_version ?? FAILURE_DOMAIN_TAXONOMY_VERSION,
        }
      : {}),
    pending_tickets: pending,
    ticket_count: Array.isArray(state.tickets) ? state.tickets.length : 0,
    receipt_count: receipts.length,
    run_ref: '.ape/runtime/active.json',
  };
}

function dispatchReference(dispatch, ticket) {
  if (!dispatch || typeof dispatch !== 'object') return dispatch;
  const ticketId = ticket?.ticket_id ?? dispatch.ticket_id ?? dispatch.ticket?.ticket_id;
  const allowed = {};
  for (const field of [
    'host',
    'native_tool',
    'agent_name',
    'agent_type',
    'prompt_path',
    'prompt_paths',
    'model',
    'protocol_version',
    'envelope_version',
    'ticket_id',
    'ticket_projection',
    'spawn_args',
    'next_control',
    // This is the only wire-carried source for Claude's one-time launch nonce.
    // The persisted intent record deliberately contains only its hash, so a
    // file reference cannot substitute for this small, load-bearing value.
    'dispatch_intent',
  ]) {
    if (dispatch[field] !== undefined) allowed[field] = dispatch[field];
  }
  if (typeof ticketId === 'string' && dispatch.dispatch_intent) {
    allowed.dispatch_intent_ref = `.ape/runtime/dispatch-intents/${sha256(ticketId)}.json`;
  }
  if (typeof ticketId === 'string') allowed.ticket = { ticket_id: ticketId };
  return allowed;
}

function minimalLaunchDispatch(dispatch) {
  if (!dispatch || typeof dispatch !== 'object') return dispatch;
  const base = {
    ...(dispatch.host !== undefined ? { host: dispatch.host } : {}),
    ...(dispatch.native_tool !== undefined ? { native_tool: dispatch.native_tool } : {}),
  };
  if (dispatch.host === 'claude') {
    const intent = dispatch.dispatch_intent;
    const model = dispatch.model;
    return {
      ...base,
      ...(dispatch.agent_type !== undefined ? { agent_type: dispatch.agent_type } : {}),
      ...(model && typeof model === 'object' && !Array.isArray(model)
        ? { model: { ...(model.model !== undefined ? { model: model.model } : {}) } }
        : model !== undefined ? { model } : {}),
      // expires_at is enforced from the hash-bound persisted intent, not sent
      // to Agent. Keep only the exact values the native launch consumes.
      ...(intent && typeof intent === 'object' && !Array.isArray(intent)
        ? {
            dispatch_intent: {
              ...(intent.nonce !== undefined ? { nonce: intent.nonce } : {}),
              ...(intent.prompt !== undefined ? { prompt: intent.prompt } : {}),
            },
          }
        : intent !== undefined ? { dispatch_intent: intent } : {}),
      ...(dispatch.dispatch_intent_ref !== undefined
        ? { dispatch_intent_ref: dispatch.dispatch_intent_ref }
        : {}),
    };
  }
  if (dispatch.host === 'codex') {
    const model = dispatch.model;
    const spawnArgs = dispatch.spawn_args;
    return {
      ...base,
      ...(dispatch.agent_name !== undefined ? { agent_name: dispatch.agent_name } : {}),
      ...(dispatch.agent_type !== undefined ? { agent_type: dispatch.agent_type } : {}),
      ...(dispatch.protocol_version !== undefined
        ? { protocol_version: dispatch.protocol_version }
        : {}),
      ...(dispatch.envelope_version !== undefined
        ? { envelope_version: dispatch.envelope_version }
        : {}),
      ...(dispatch.ticket_projection !== undefined
        ? { ticket_projection: dispatch.ticket_projection }
        : {}),
      ...(model && typeof model === 'object' && !Array.isArray(model)
        ? {
            model: {
              ...(model.model !== undefined ? { model: model.model } : {}),
              ...(model.reasoning_effort !== undefined
                ? { reasoning_effort: model.reasoning_effort }
                : {}),
            },
          }
        : model !== undefined ? { model } : {}),
      // spawn_args is the Codex native launch authority. Its schema is closed
      // here so an unused extension cannot crowd the action itself off wire.
      ...(spawnArgs && typeof spawnArgs === 'object' && !Array.isArray(spawnArgs)
        ? {
            spawn_args: {
              ...(spawnArgs.task_name !== undefined ? { task_name: spawnArgs.task_name } : {}),
              ...(spawnArgs.fork_turns !== undefined ? { fork_turns: spawnArgs.fork_turns } : {}),
              ...(spawnArgs.model !== undefined ? { model: spawnArgs.model } : {}),
              ...(spawnArgs.reasoning_effort !== undefined
                ? { reasoning_effort: spawnArgs.reasoning_effort }
                : {}),
              ...(spawnArgs.message !== undefined ? { message: spawnArgs.message } : {}),
            },
          }
        : spawnArgs !== undefined ? { spawn_args: spawnArgs } : {}),
      ...(dispatch.next_control !== undefined ? { next_control: dispatch.next_control } : {}),
      ...(dispatch.dispatch_intent_ref !== undefined
        ? { dispatch_intent_ref: dispatch.dispatch_intent_ref }
        : {}),
    };
  }
  return base;
}

function actionReference(value) {
  if (value?.type === 'dispatch_agent') {
    return {
      type: value.type,
      ...(value.recovery_kind ? { recovery_kind: value.recovery_kind } : {}),
      ...(value.source_ticket_id ? { source_ticket_id: value.source_ticket_id } : {}),
      ...(isFailureDomain(value.failure_domain) ? { failure_domain: value.failure_domain } : {}),
      ticket: ticketReference(value.ticket),
      dispatch: dispatchReference(value.dispatch, value.ticket),
    };
  }
  if (value?.type === 'status') return { type: value.type, state: runReference(value.state) };
  if (value?.type === 'history_archived') {
    return { type: value.type, record: summarizeHistoryRecord(value.record) };
  }
  return value;
}

function projectionMarker(originalBytes, authoritativeRef) {
  return {
    kind: 'reference-only-v1',
    original_utf8_bytes: originalBytes,
    budget_utf8_bytes: RESPONSE_BUDGET_BYTES,
    ...(authoritativeRef ? { authoritative_ref: authoritativeRef } : {}),
  };
}

function boundedInlineProjectionMarker(originalBytes) {
  return {
    kind: 'bounded-inline-v1',
    original_utf8_bytes: originalBytes,
    budget_utf8_bytes: RESPONSE_BUDGET_BYTES,
  };
}

function boundedStringList(values, limit = 32) {
  if (!Array.isArray(values)) return [];
  return values
    .filter((value) => typeof value === 'string')
    .slice(0, limit)
    .map((value) => boundedWireText(value, 120));
}

function boundedCapability(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const capability = {};
  if (typeof value.kind === 'string') capability.kind = boundedWireText(value.kind, 40);
  if (typeof value.id === 'string') capability.id = boundedWireText(value.id, 120);
  if (typeof value.role === 'string') capability.role = boundedWireText(value.role, 80);
  return Object.keys(capability).length > 0 ? capability : null;
}

function boundedReadinessIssue(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return boundedWireText(String(value), 240);
  }
  const output = {};
  if (typeof value.code === 'string') output.code = boundedWireText(value.code, 120);
  const capability = boundedCapability(value.capability);
  if (capability) output.capability = capability;
  for (const field of ['required', 'provided', 'worst_case']) {
    if (Number.isFinite(value[field])) output[field] = value[field];
  }
  for (const field of ['targeted', 'full']) {
    if (typeof value[field] === 'boolean') output[field] = value[field];
  }
  return output;
}

function boundedCatalogNames(values, selector) {
  const entries = Array.isArray(values) ? values : [];
  const names = entries
    .map(selector)
    .filter((value) => typeof value === 'string');
  return {
    count: entries.length,
    ids: boundedStringList(names, 16),
    truncated: names.length > 16,
  };
}

function boundedCapabilityCatalog(catalog) {
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) return null;
  const testCommands = catalog.test_commands && typeof catalog.test_commands === 'object'
    ? Object.entries(catalog.test_commands)
      .filter(([, value]) => typeof value === 'string' && value.length > 0)
      .map(([key]) => key)
    : [];
  return {
    version: catalog.version,
    config_hash: catalog.config_hash,
    catalog_hash: catalog.catalog_hash,
    evidence_scripts: boundedCatalogNames(catalog.evidence_scripts, (value) => value),
    command_profiles: boundedCatalogNames(catalog.command_profiles, (value) => value?.id),
    verification_profiles: boundedCatalogNames(catalog.verification_profiles, (value) => value?.id),
    runners: boundedCatalogNames(catalog.runners, (value) => value?.id ?? value?.root),
    test_command_profiles: boundedStringList(testCommands, 16),
  };
}

function boundedPreviewBlueprint(blueprint) {
  const readiness = blueprint?.readiness && typeof blueprint.readiness === 'object'
    ? blueprint.readiness
    : {};
  const requested = Array.isArray(readiness.requested_capabilities)
    ? readiness.requested_capabilities
    : [];
  const blocking = Array.isArray(readiness.blocking) ? readiness.blocking : [];
  const warnings = Array.isArray(readiness.warnings) ? readiness.warnings : [];
  const derived = readiness.derived_capability_requirements ?? {};
  return {
    lane: boundedWireText(blueprint?.lane, 40),
    lane_reasons: boundedStringList(blueprint?.lane_reasons, 16),
    dispatch_bounds: structuredClone(blueprint?.dispatch_bounds ?? null),
    // This is the operator-visible authority that replaces objective prose as
    // a timebox. It must survive the oversized-preview projection just like
    // lane and dispatch bounds; the shape is fixed and budget-negligible.
    ticket_deadline: blueprint?.ticket_deadline &&
        typeof blueprint.ticket_deadline === 'object'
      ? {
          deadline_ms: blueprint.ticket_deadline.deadline_ms,
          source: boundedWireText(blueprint.ticket_deadline.source, 80),
        }
      : null,
    readiness: {
      ...(typeof readiness.healthy === 'boolean' ? { healthy: readiness.healthy } : {}),
      ...(typeof readiness.ready === 'boolean' ? { ready: readiness.ready } : {}),
      blocking: blocking.slice(0, 16).map(boundedReadinessIssue),
      blocking_count: blocking.length,
      warnings: warnings.slice(0, 16).map(boundedReadinessIssue),
      warning_count: warnings.length,
      requested_capabilities: requested.slice(0, 32).map(boundedCapability).filter(Boolean),
      requested_capability_count: requested.length,
      requested_capabilities_truncated: requested.length > 32,
      derived_capability_requirements: {
        stage_roles: boundedStringList(derived.stage_roles, 32),
        stage_checks: boundedStringList(derived.stage_checks, 32),
        test_runner_profiles: boundedStringList(derived.test_runner_profiles, 16),
      },
      available_capability_catalog: boundedCapabilityCatalog(
        readiness.available_capability_catalog,
      ),
    },
  };
}

function hardBoundHistoryResponse(response) {
  if (!overBudget(response)) return response;
  const originalBytes = responseUtf8Bytes(response);
  const record = response.record && typeof response.record === 'object'
    ? summarizeHistoryRecord(response.record)
    : response.record;
  const roadmap = response.roadmap && typeof response.roadmap === 'object'
    ? {
        counts: response.roadmap.counts,
        corrupt: response.roadmap.corrupt,
        roadmap_ref: '.ape/runtime/roadmap.json',
      }
    : response.roadmap;
  const projected = {
    ok: response.ok,
    ...(response.active !== undefined ? { active: response.active } : {}),
    ...(record ? { record } : {}),
    ...(Array.isArray(response.records)
      ? {
          records: [],
          record_count: response.records.length,
          records_ref: '.ape/runtime/history/',
        }
      : {}),
    ...(roadmap ? { roadmap } : {}),
    ...(response.reason ? { reason: boundedWireText(response.reason) } : {}),
    projection: projectionMarker(originalBytes, '.ape/runtime/history/'),
  };
  if (!overBudget(projected)) return projected;
  return {
    ok: response.ok,
    projection: projectionMarker(originalBytes, '.ape/runtime/history/'),
  };
}

// ape_history's bulk bound. An unfiltered query returns up to 256 immutable
// records, each embedding full tickets (each embedding the ~1.6 KB
// record-input schema) and receipts with complete agent evidence — the same
// payload class friction #26 removed from ape_run. Summarize every listed
// record at the wire; the active-run stub passes through untouched, and
// explain/import responses carry no records[] so they cross unchanged —
// run_id-scoped explain stays the full-record channel (see projectAction).
export function projectHistoryResponse(response) {
  if (response === null || typeof response !== 'object') return response;
  // The three roadmap verbs return { ok, roadmap } with NO records key, so the
  // bulk guard below would hand them back unbounded: bound the block on both
  // sides of it. An unchanged block comes back BY IDENTITY, which is exactly
  // what keeps the explain/import fast path returning the very same object.
  const roadmap = boundRoadmapBlock(response.roadmap);
  const roadmapChanged = roadmap !== response.roadmap;
  if (!Array.isArray(response.records)) {
    const projected = roadmapChanged ? { ...response, roadmap } : response;
    // A run-scoped explain keeps the full immutable record, including its
    // structured plan fields. Apply only the wire plan dedupe; every other
    // audit field remains the full-record channel and persistence is untouched.
    return hardBoundHistoryResponse(dedupeWirePlans(projected));
  }
  return hardBoundHistoryResponse(dedupeWirePlans({
    ...response,
    ...(roadmapChanged ? { roadmap } : {}),
    records: response.records.map((record) =>
      record?.active === true ? record : summarizeHistoryRecord(record)),
  }));
}

// --- Size-triggered action compaction (roadmap entry ape-run-response-size-cap).
// The summaries above are unconditional; this pass is not. A dispatch_agent
// action ticket and a status action's embedded state carry the response's
// remaining full-objective copies, and below the budget they must keep crossing
// whole. Over the budget they dedupe exactly the two fields run.tickets[]
// already dedupes, and nothing unique is lost: the objective stays recoverable
// from run.objective in this same response, the record-input contract from the
// on-disk ticket file.

// The correctness-bearing guard. A dispatch_agent action ticket is compactable
// on its own merits — compactPendingTicket fails open per FIELD, so with no run
// objective to match against the objective crosses whole while the shared
// record-input schema still dedupes. A status action is compactable only when
// its state.objective is the SAME NON-EMPTY string as run.objective: bare
// equality also holds with both undefined, which would mint a marker out of
// nothing, and a state.objective that merely resembles run.objective is unique
// information that must not be referenced away.
function compactableAction(action, runObjective) {
  if (action?.type === 'dispatch_agent') {
    return action.ticket !== null && typeof action.ticket === 'object';
  }
  if (action?.type === 'status') {
    return (
      typeof runObjective === 'string' &&
      runObjective.length > 0 &&
      action.state !== null &&
      typeof action.state === 'object' &&
      action.state.objective === runObjective
    );
  }
  return false;
}

// Always CONSTRUCTS new objects, never assigns in place. service.js pushes the
// SAME ticket object into state.tickets and into the dispatch_agent action
// (:326 and :400) and scheduler.js:307 hands the status action the state object
// itself, so response.run.tickets[k] IS response.actions[j].ticket and
// response.run IS the status action's state IS the LIVE in-memory run state. An
// in-place assignment here would corrupt that state for every in-process
// consumer and the next persist would write the corruption to disk.
// THIS pass never reads or rewrites action.dispatch at all, so a Claude
// dispatch_intent prompt and its host-specific launch material cross verbatim
// (Claude's nonce line or Codex's generated agent_name). Scoped deliberately:
// projectAction above DOES rewrite
// action.dispatch on every response, but only to collapse its duplicate ticket
// copy to a bare ticket_id — the launch payload itself is never touched.
function compactAction(action, runObjective) {
  if (action.type === 'dispatch_agent') {
    return { ...action, ticket: compactPendingTicket(action.ticket, runObjective) };
  }
  if (action.type === 'status') {
    return { ...action, state: { ...action.state, objective: RUN_OBJECTIVE_REFERENCE } };
  }
  return action;
}

// Measurement must never become a new throw site: a response the runtime can
// serialize for the wire is measurable, and one it cannot is already failing at
// the serializer, so a throw here reports "not over budget" and the response
// crosses exactly as it does today.
function overBudget(response) {
  try {
    return Buffer.byteLength(JSON.stringify(response), 'utf8') > RESPONSE_BUDGET_BYTES;
  } catch {
    return false;
  }
}

function fullPlanEnvelope(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof value.plan_hash === 'string' &&
    value.plan !== null &&
    typeof value.plan === 'object'
  );
}

function collectPlanTicketIds(response) {
  const ids = new Map();
  const collectTicket = (ticket) => {
    if (!ticket || typeof ticket !== 'object' || typeof ticket.ticket_id !== 'string') return;
    for (const field of ['candidate_plan', 'approved_plan']) {
      const value = ticket[field];
      if (fullPlanEnvelope(value) && !ids.has(`${field}:${value.plan_hash}`)) {
        ids.set(`${field}:${value.plan_hash}`, ticket.ticket_id);
      }
    }
  };
  const collectState = (state) => {
    if (!state || typeof state !== 'object') return;
    for (const ticket of state.tickets ?? []) collectTicket(ticket);
  };
  collectState(response.run);
  collectState(response.record);
  for (const action of response.actions ?? []) {
    if (action?.type === 'dispatch_agent') collectTicket(action.ticket);
    if (action?.type === 'status') collectState(action.state);
  }
  return ids;
}

function planReference(field, value, ticketId, canonicalLocation) {
  return Object.freeze({
    ...(field === 'approved_plan'
      ? {
          version: value.version,
          approval_route: value.approval_route,
          reviewer_receipt_hashes: value.reviewer_receipt_hashes,
        }
      : {}),
    plan_hash: value.plan_hash,
    ticket_id: ticketId,
    plan_ref: canonicalLocation,
  });
}

function dedupePlanValue(field, value, ticketId, context, location) {
  if (!fullPlanEnvelope(value)) return value;
  // One canonical plan body per hash across BOTH candidate and approved
  // envelopes. dedupeStatePlans processes run.approved_plan before tickets, so
  // a post-approval response retains the approval envelope as authority and
  // candidate copies of its plan become references too. Remember whether that
  // authority is itself a state/record/patch value on this wire response: unlike
  // a ticket artifact it remains resolvable after archived artifacts are
  // compacted.
  const key = value.plan_hash;
  if (!context.seen.has(key)) {
    context.seen.set(key, {
      location,
      inlineAuthority: field === 'approved_plan' && ticketId === null,
    });
    return value;
  }
  const recoveryTicket =
    ticketId ??
    context.ticketIds.get(`${field}:${value.plan_hash}`) ??
    context.ticketIds.get(`candidate_plan:${value.plan_hash}`) ??
    context.ticketIds.get(`approved_plan:${value.plan_hash}`);
  // Every duplicate ticket copy is persisted with the full envelope. A rare
  // state-only fixture with no ticket id fails open to the full plan rather
  // than minting an unresolvable reference.
  if (typeof recoveryTicket !== 'string') return value;
  const canonical = context.seen.get(key);
  return planReference(
    field,
    value,
    recoveryTicket,
    canonical.inlineAuthority
      ? canonical.location
      : `.ape/runtime/tickets/${recoveryTicket.replaceAll(':', '_')}.json#${field}`,
  );
}

function dedupeTicketPlans(ticket, context, location) {
  if (!ticket || typeof ticket !== 'object') return ticket;
  const candidate = dedupePlanValue(
    'candidate_plan',
    ticket.candidate_plan,
    ticket.ticket_id,
    context,
    `${location}.candidate_plan`,
  );
  const approved = dedupePlanValue(
    'approved_plan',
    ticket.approved_plan,
    ticket.ticket_id,
    context,
    `${location}.approved_plan`,
  );
  if (candidate === ticket.candidate_plan && approved === ticket.approved_plan) return ticket;
  return {
    ...ticket,
    ...(candidate === undefined ? {} : { candidate_plan: candidate }),
    ...(approved === undefined ? {} : { approved_plan: approved }),
  };
}

function dedupeStatePlans(state, context, location) {
  if (!state || typeof state !== 'object') return state;
  const approved = dedupePlanValue(
    'approved_plan',
    state.approved_plan,
    null,
    context,
    `${location}.approved_plan`,
  );
  const mappedTickets = Array.isArray(state.tickets)
    ? state.tickets.map((ticket, index) => dedupeTicketPlans(ticket, context, `${location}.tickets.${index}`))
    : state.tickets;
  const ticketsChanged = Array.isArray(state.tickets) &&
    mappedTickets.some((ticket, index) => ticket !== state.tickets[index]);
  const tickets = ticketsChanged ? mappedTickets : state.tickets;
  if (approved === state.approved_plan && !ticketsChanged) return state;
  return {
    ...state,
    ...(approved === undefined ? {} : { approved_plan: approved }),
    ...(Array.isArray(state.tickets) ? { tickets } : {}),
  };
}

// Plan contracts are already individually bounded, but a plan-review response
// carries the same candidate in two pending tickets and two dispatch actions;
// after approval the run plus each downstream ticket repeats approved_plan.
// Keep exactly one complete envelope per field/hash on the wire and replace
// duplicates with resolvable references. This pass is unconditional and pure:
// persisted tickets and the service result remain byte-identical.
function dedupeWirePlans(response) {
  const context = {
    seen: new Map(),
    ticketIds: collectPlanTicketIds(response),
  };
  const run = dedupeStatePlans(response.run, context, 'run');
  const record = dedupeStatePlans(response.record, context, 'record');
  const mappedActions = Array.isArray(response.actions)
    ? response.actions.map((action, index) => {
        if (action?.type === 'dispatch_agent') {
          const ticket = dedupeTicketPlans(action.ticket, context, `actions.${index}.ticket`);
          return ticket === action.ticket ? action : { ...action, ticket };
        }
        if (action?.type === 'status') {
          const state = dedupeStatePlans(action.state, context, `actions.${index}.state`);
          return state === action.state ? action : { ...action, state };
        }
        if (action?.type === 'transition' && action.patch && typeof action.patch === 'object') {
          const approved = dedupePlanValue(
            'approved_plan',
            action.patch.approved_plan,
            null,
            context,
            `actions.${index}.patch.approved_plan`,
          );
          if (approved !== action.patch.approved_plan) {
            return { ...action, patch: { ...action.patch, approved_plan: approved } };
          }
        }
        return action;
      })
    : response.actions;
  const actionsChanged = Array.isArray(response.actions) &&
    mappedActions.some((action, index) => action !== response.actions[index]);
  const actions = actionsChanged ? mappedActions : response.actions;
  if (run === response.run && record === response.record && !actionsChanged) return response;
  return {
    ...response,
    ...(run === undefined ? {} : { run }),
    ...(record === undefined ? {} : { record }),
    ...(Array.isArray(response.actions) ? { actions } : {}),
  };
}

function deriveNextAction(response) {
  const explicit = boundedNextAction(response.next_action);
  if (explicit) return explicit;
  const dispatches = Array.isArray(response.actions)
    ? response.actions.filter((entry) => entry?.type === 'dispatch_agent')
    : [];
  if (dispatches.length > 0) {
    const kinds = dispatches.map((entry) => entry.recovery_kind).filter(Boolean);
    const explicitDomains = [...new Set(
      dispatches.map((entry) => entry.failure_domain).filter(isFailureDomain),
    )];
    const recoveryKind = kinds.includes('redispatch_same_ticket')
      ? 'redispatch_same_ticket'
      : kinds.includes('capability_scope_expansion')
        ? 'capability_recovery'
      : kinds.includes('directed_replan')
        ? 'directed_replan'
        : kinds.includes('remediate_product_finding')
          ? 'remediate_product_finding'
          : kinds.includes('stage_retry') || kinds.includes('reissue_same_contract')
            ? 'stage_retry'
            : 'wait';
    return {
      kind: recoveryKind,
      ...(kinds.length === 1 ? { recovery_kind: kinds[0] } : {}),
      ticket_ids: dispatches
        .map((entry) => entry.ticket?.ticket_id ?? entry.dispatch?.ticket_id)
        .filter((ticketId) => typeof ticketId === 'string')
        .slice(0, 16),
      ...(['stage_retry', 'capability_recovery'].includes(recoveryKind)
        ? { consumes_product_attempt: recoveryKind === 'stage_retry' && !kinds.includes('reissue_same_contract') }
        : {}),
      ...(explicitDomains.length === 1
        ? { failure_domain: explicitDomains[0] }
        : kinds.includes('redispatch_same_ticket') || kinds.includes('reissue_same_contract')
          ? { failure_domain: 'orchestration' }
          : ['stage_retry', 'directed_replan', 'remediate_product_finding'].includes(recoveryKind)
            ? { failure_domain: 'product' }
            : {}),
    };
  }
  const run = response.run;
  if (!run || typeof run !== 'object') return null;
  if (run.status === 'input_required') {
    if (run.input_required?.kind === 'receipt_retry') {
      return {
        kind: 'continue_same_agent',
        ticket_id: run.input_required.ticket_id,
        failure_domain: 'orchestration',
        required_control_action: 'record_exact_attested_receipt',
      };
    }
    return { kind: run.input_required?.kind === 'execution_budget' ? 'wait' : 'answer_preflight' };
  }
  if (run.status === 'completed') return null;
  if (run.status === 'aborted') {
    return { kind: 'blocked', failure_domain: 'operator', automatic_successor: false };
  }
  if (run.status === 'blocked') {
    const terminalReasonCode = run.terminal_reason_code ?? null;
    return {
      kind: 'blocked',
      terminal_reason_code: terminalReasonCode,
      failure_domain: isFailureDomain(run.failure_domain)
        ? run.failure_domain
        : terminalFailureDomain(run),
      automatic_successor: false,
      ...(terminalReasonCode === 'capability_blocked'
        ? { required_operator_action: 'update_configuration_or_start_authorized_run' }
        : {}),
    };
  }
  if (run.status === 'gating' || run.status === 'shipping') {
    return { kind: 'wait', state: run.status };
  }
  const receipted = new Set((run.receipts ?? []).map((receipt) => receipt.ticket_id));
  const expired = new Set(run.expired_tickets ?? []);
  const pending = (run.tickets ?? []).filter(
    (ticket) => !receipted.has(ticket.ticket_id) && !expired.has(ticket.ticket_id),
  );
  if (pending.length > 0) {
    return {
      kind: 'wait',
      ticket_ids: pending.map((ticket) => ticket.ticket_id).filter(Boolean).slice(0, 16),
    };
  }
  return null;
}

function legacyContinuationNextAction(response) {
  const run = response?.run;
  if (!run || typeof run !== 'object' || Array.isArray(run)) return null;
  if (['completed', 'blocked', 'aborted'].includes(run.status)) return null;
  const paused = run.status === 'input_required'
    && run.input_required?.kind === 'execution_budget';
  const continuation = run.budget_continuation
    && typeof run.budget_continuation === 'object'
    && !Array.isArray(run.budget_continuation);
  return paused || continuation
    ? { kind: 'wait', state: 'continuation_pending' }
    : null;
}

function hardBoundRunResponse(response) {
  if (!overBudget(response)) return response;
  const originalBytes = responseUtf8Bytes(response);
  // Preview is deliberately read-only and therefore has no persisted preview
  // artifact to reference. Keep its decision-bearing facts inline under the
  // hard bound instead of inventing `.ape/runtime/` as an authoritative file.
  if (response.advisory === true && response.blueprint && !response.run) {
    return {
      ok: response.ok,
      advisory: true,
      blueprint: boundedPreviewBlueprint(response.blueprint),
      projection: boundedInlineProjectionMarker(originalBytes),
    };
  }
  const authoritativeRef = response.run ? '.ape/runtime/active.json' : null;
  const marker = authoritativeRef
    ? projectionMarker(originalBytes, authoritativeRef)
    : boundedInlineProjectionMarker(originalBytes);
  const roadmap = response.roadmap && typeof response.roadmap === 'object'
    ? {
        counts: response.roadmap.counts,
        corrupt: response.roadmap.corrupt,
        roadmap_ref: '.ape/runtime/roadmap.json',
      }
    : response.roadmap;
  const projected = {
    ok: response.ok,
    ...(response.active !== undefined ? { active: response.active } : {}),
    ...(response.blocked !== undefined ? { blocked: response.blocked } : {}),
    ...(response.rejected !== undefined ? { rejected: response.rejected } : {}),
    ...(response.idempotent !== undefined ? { idempotent: response.idempotent } : {}),
    ...(response.recovered !== undefined ? { recovered: response.recovered } : {}),
    ...(response.successor_guidance
      ? { successor_guidance: projectSuccessorGuidance(response.successor_guidance) }
      : {}),
    ...(response.run ? { run: runReference(response.run) } : {}),
    ...(response.receipt ? { receipt: response.receipt } : {}),
    ...(Array.isArray(response.actions)
      ? { actions: response.actions.map(actionReference) }
      : {}),
    ...(response.record ? { record: summarizeHistoryRecord(response.record) } : {}),
    ...(roadmap ? { roadmap } : {}),
    ...(response.next_action ? { next_action: response.next_action } : {}),
    ...(response.reason ? { reason: boundedWireText(response.reason) } : {}),
    ...(Array.isArray(response.errors)
      ? { errors: response.errors.slice(0, 8).map((entry) => boundedWireText(entry)) }
      : {}),
    projection: marker,
  };
  if (!overBudget(projected)) return projected;
  const minimalActions = (projected.actions ?? [])
    .filter((entry) => entry?.type === 'dispatch_agent')
    .map((entry) => ({
      type: entry.type,
      ...(DISPATCH_RECOVERY_KIND_SET.has(entry.recovery_kind)
        ? { recovery_kind: entry.recovery_kind }
        : {}),
      // The full model record is recoverable from the ticket file and may
      // contain arbitrary operator annotations. Native launch needs only the
      // launch-bearing model selector retained in dispatch below.
      ticket: minimalTicketReference(entry.ticket),
      dispatch: minimalLaunchDispatch(entry.dispatch),
      dispatch_ref: entry.dispatch?.dispatch_intent_ref ?? entry.ticket?.ticket_ref,
    }));
  const minimal = {
    ok: response.ok,
    ...(response.successor_guidance
      ? { successor_guidance: projectSuccessorGuidance(response.successor_guidance) }
      : {}),
    ...(response.run ? { run: runReference(response.run) } : {}),
    ...(minimalActions.length ? { actions: minimalActions } : {}),
    ...(response.next_action ? { next_action: response.next_action } : {}),
    projection: marker,
  };
  if (!overBudget(minimal)) return minimal;
  // A pathological run reference (for example, a corrupt or legacy state with
  // an enormous pending-ticket list) must not make an otherwise small native
  // launch disappear. The action is the live capability; the run remains
  // authoritatively available from the projection marker.
  const launchOnly = {
    ok: response.ok,
    ...(minimalActions.length ? { actions: minimalActions } : {}),
    ...(response.next_action ? { next_action: response.next_action } : {}),
    projection: marker,
  };
  if (!overBudget(launchOnly)) return launchOnly;
  const actionsOnly = {
    ok: response.ok,
    ...(minimalActions.length ? { actions: minimalActions } : {}),
    projection: marker,
  };
  if (minimalActions.length && !overBudget(actionsOnly)) return actionsOnly;
  return {
    ok: response.ok,
    next_action: response.next_action ?? { kind: 'wait' },
    projection: marker,
  };
}

export function projectRunResponse(response) {
  if (response === null || typeof response !== 'object') return response;
  // Preserve a budget-neutral control signal before projectRunState strips the
  // retired budget fields. NEXT will migrate the hold and replay any retained
  // reducer continuation automatically; the wire must not make that work look
  // like an idle running state with no next action.
  const legacyNextAction = legacyContinuationNextAction(response);
  // Shallow clone: every top-level key not explicitly transformed passes
  // through unchanged (ok, reason, errors, rejected, blocked, doctor,
  // idempotent, recovered, active, normalized_fields, ...).
  let projected = { ...response };
  if (Object.hasOwn(projected, 'successor_guidance')) {
    const successorGuidance = projectSuccessorGuidance(projected.successor_guidance);
    if (successorGuidance) projected.successor_guidance = successorGuidance;
    else delete projected.successor_guidance;
  }
  if (projected.failure_domain !== undefined && !isFailureDomain(projected.failure_domain)) {
    delete projected.failure_domain;
  }
  if (projected.receipt && typeof projected.receipt === 'object') {
    // The LARP PostToolUse cue (larp.js classifyApeRunOutcome) reads the acting
    // role off the WIRE receipt to tell a plan approval from other hand-offs;
    // summarizeReceipt otherwise drops it, so carry the role (canonical
    // agent.role, or a flat mirror) onto the top-level summary. Only this
    // top-level action receipt gains it; projectRunState's state.receipts[]
    // summaries are unchanged. Resolve stage_id against the original,
    // unprojected run tickets.
    const role = projected.receipt.agent?.role ?? projected.receipt.role ?? null;
    projected.receipt = {
      ...summarizeReceipt(projected.receipt, ticketIndex(response.run?.tickets)),
      ...(role ? { role } : {}),
    };
  }
  if (projected.run && typeof projected.run === 'object') {
    projected.run = projectRunState(projected.run);
  }
  // statusRun's derived roadmap. A status response carries no actions[], so the
  // size-triggered pass below never reaches it; this unconditional trim is the
  // only bound that does. Assigned only when something actually changed, so a
  // response with no roadmap key never gains one (RM7).
  const roadmap = boundRoadmapBlock(projected.roadmap);
  if (roadmap !== projected.roadmap) projected.roadmap = roadmap;
  if (Array.isArray(projected.actions)) {
    projected.actions = projected.actions.map(projectAction);
    // Remove repeated complete plan envelopes before measuring the remaining
    // response for legacy objective/schema compaction. A response made small
    // enough by plan references should not trigger unrelated wire rewrites.
    projected = dedupeWirePlans(projected);
    // ONE pass: measure once, map once, never re-measure and never loop. The
    // compacted forms are bounded by construction. If this lossless pass is not
    // enough, hardBoundRunResponse later replaces large bodies with explicit
    // authoritative references.
    // Evaluating the predicate before serializing is a COST property (it keeps
    // the ordinary under-budget path off the serializer entirely), not what
    // makes the pass correct; compactableAction is the correctness-bearing
    // guard.
    const runObjective =
      projected.run !== null && typeof projected.run === 'object'
        ? projected.run.objective
        : undefined;
    if (
      projected.actions.some((action) => compactableAction(action, runObjective)) &&
      overBudget(projected)
    ) {
      projected.actions = projected.actions.map((action) =>
        (compactableAction(action, runObjective) ? compactAction(action, runObjective) : action));
    }
  } else {
    projected = dedupeWirePlans(projected);
  }
  const nextAction = boundedNextAction(deriveNextAction(projected) ?? legacyNextAction);
  if (nextAction) {
    projected = { ...projected, next_action: nextAction };
  } else if (projected.next_action !== undefined) {
    projected = { ...projected };
    delete projected.next_action;
  }
  return hardBoundRunResponse(projected);
}
