// MCP wire projection (friction #26; roadmap entry ape-run-response-size-cap).
// This module bounds ape_run responses at the MCP boundary only: persistence,
// ticket files, receipts, and history on disk remain complete and
// authoritative, and service functions keep returning full state to internal
// consumers. Three bounds compose here: the UNCONDITIONAL per-record summaries
// (run.tickets[], run.receipts[], history records) applied on every response,
// the equally unconditional roadmap-block field trim reached from BOTH
// projections (see boundRoadmapBlock — the only bound that reaches a response
// carrying neither actions[] nor records[]),
// and a SIZE-TRIGGERED pass that dedupes the action payloads only when the
// projected response exceeds RESPONSE_BUDGET_CHARS. Below the budget the wire
// shape is byte-identical to the unconditional projection, so the size pass is
// purely additive. Pure functions, no I/O, and no in-place writes: every caller
// hands in LIVE runtime objects (see compactAction).

import { RECEIPT_INPUT_SCHEMA } from './receipt-input.js';
import { canonicalJson } from './canonical.js';

// friction #26 follow-up: a pending ticket that crosses the wire in run.tickets[]
// re-embeds two fields verbatim — the full run objective (ticketObjective at
// service.js:53 appends `Run objective: ${run.objective}`) and the ~1.6 KB
// record-input contract (pipeline.js:20 assigns the shared RECEIPT_INPUT_SCHEMA
// as output_schema). Neither is unique information, so the wire summary
// references them, but they are recoverable from DIFFERENT places. The
// objective is always recoverable from this very response: no projection ever
// rewrites run.objective, so a full copy is always on the wire (over the budget
// it is the only one left). The output_schema is not: it rides the
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
// ASSUMPTION, not a proven margin: this compares UTF-16 String.length against a
// cap the host enforces in TOKENS over UTF-8 bytes, and the 2.85 chars/token
// constant was fitted to two samples of ONE response family. Hash-dense JSON
// tokenizes nearer 2 chars/token, which would leave ~4% headroom, not 33%.
// It is also a TARGET, not a hard cap: the pass measures once and dedupes once
// (see projectRunResponse), one full run.objective copy always remains on the
// wire, and input-guard.js:4 admits 64 KB of input — so an objective above
// roughly 45 KB can still approach the host cap. A behavioural arm pins that
// cliff rather than leaving it as prose.
export const RESPONSE_BUDGET_CHARS = 48_000;

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
    (ticket.output_schema === RECEIPT_INPUT_SCHEMA ||
      canonicalJson(ticket.output_schema) === RECEIPT_INPUT_SCHEMA_CANONICAL)
  ) {
    compact.output_schema = OUTPUT_SCHEMA_REFERENCE;
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
  return {
    schema_version: record.schema_version,
    run_id: record.run_id,
    status: record.status,
    mode: record.mode,
    lane: record.lane,
    block_reason: record.block_reason,
    ...(record.abort_reason ? { abort_reason: record.abort_reason } : {}),
    completed_at: record.completed_at,
    ...(record.base_branch ? { base_branch: record.base_branch } : {}),
    base_commit_sha: record.base_commit_sha,
    final_tree_sha: record.final_tree_sha,
    merge: record.merge,
    record_hash: record.record_hash,
    ticket_count: record.tickets?.length ?? 0,
    receipt_count: record.receipts?.length ?? 0,
    ...(record.supersedes ? { supersedes: record.supersedes } : {}),
    // Cross-run supersession (friction #10) is exactly the collapse signal a
    // history reader needs; it must survive the wire summary.
    ...(record.supersedes_run ? { supersedes_run: record.supersedes_run } : {}),
    // Imported-record provenance is a truthfulness marker: without it a
    // legacy plan imported as 'completed' is indistinguishable on the wire
    // from a run the runtime actually gated.
    ...(record.imported ? { imported: record.imported } : {}),
    ...(record.source_path ? { source_path: record.source_path } : {}),
    ...(record.preflight ? { preflight: summarizePreflight(record.preflight) } : {}),
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
// A TARGET, not a hard cap, exactly as RESPONSE_BUDGET_CHARS above. This bounds
// FIELDS, not the block: entries are never dropped, because counts describes the
// WHOLE roadmap and a wire that discarded entries would replace a disclosed loss
// with a silent lie. After the trim a derived entry is still bounded only by the
// store's own LIMITS at roughly 4.7 KB (128 id + 200 title + 32x128 depends_on +
// 32x128 replaced_by) plus at most ROADMAP_REASON_CHARS, so a roadmap of enough
// entries can still exceed the response budget. What IS guaranteed is that no
// single field carries unbounded prose across the wire.
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
    return dedupeWirePlans(projected);
  }
  return dedupeWirePlans({
    ...response,
    ...(roadmapChanged ? { roadmap } : {}),
    records: response.records.map((record) =>
      record?.active === true ? record : summarizeHistoryRecord(record)),
  });
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
    return JSON.stringify(response).length > RESPONSE_BUDGET_CHARS;
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

export function projectRunResponse(response) {
  if (response === null || typeof response !== 'object') return response;
  // Shallow clone: every top-level key not explicitly transformed passes
  // through unchanged (ok, reason, errors, rejected, blocked, doctor,
  // idempotent, recovered, active, normalized_fields, ...).
  let projected = { ...response };
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
    // compacted forms are bounded by construction and a second round could only
    // chase a target this pass cannot move — run.objective is the operator's own
    // text and the sole complete wire copy, so it is never rewritten.
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
  return projected;
}
