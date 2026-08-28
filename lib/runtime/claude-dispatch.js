import { createHash, randomBytes } from 'node:crypto';
import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { atomicReplaceText, atomicWriteJson, readJson } from './storage.js';
import { withDirLock } from './lock.js';
import { renderStatusDoc } from './status-doc.js';
import { codexInjectedDispatchContext } from './adapters.js';

const NONCE_PATTERN = /^[A-Za-z0-9_-]{32,256}$/;
const CODEX_TASK_NAME_PATTERN = /^ape_[a-z0-9_]+_[a-f0-9]{32}$/;
const MAX_PROMPT_BYTES = 256 * 1024;
const LAUNCH_TTL_MS = 60_000;
const LOCK_STALE_MS = 10_000;
const LOCK_HEARTBEAT_MS = 2_500;
const LOCK_WAIT_MS = 2_000;
const CODEX_V2_DEFAULT_AGENT_TYPE = 'default';

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function intentPath(paths, ticketId) {
  return path.join(paths.dispatchIntents, `${digest(ticketId)}.json`);
}

function iso(ms = Date.now()) {
  return new Date(ms).toISOString();
}

function expired(value, at = Date.now()) {
  const parsed = Date.parse(value ?? '');
  return !Number.isFinite(parsed) || parsed <= at;
}

function boundedIdentity(value, max = 512) {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function intentMatchesHost(record, host) {
  // Records created before Codex binding support shipped had no host field
  // and were necessarily Claude records. Keep those resumable after upgrade.
  return record?.host === host || (host === 'claude' && record?.host == null);
}

function boundSessionMatches(record, sessionId, host) {
  // Pre-Multi-Agent-V2 Codex records used the parent session for both sides.
  // Prefer the child session on new records while keeping an in-flight legacy
  // binding resolvable after a plugin update.
  return (host === 'codex'
    ? (record.bound_session_id ?? record.parent_session_id)
    : record.parent_session_id) === sessionId;
}

function hostLabel(host) {
  return host === 'codex' ? 'Codex' : 'Claude';
}

// Claude's Agent lifecycle reports the requested role. Codex Multi-Agent V2's
// collaboration.spawn_agent has no agent_type input, while SubagentStart
// reports the host-effective role (`default`). Keep that binding identity
// separate from APE's logical worker/explorer role. Omission remains accepted
// for older Codex hook payloads, but a supplied host type is always checked.
function agentTypeInputValid(agentType, host) {
  return (host === 'codex') && agentType == null
    ? true
    : boundedIdentity(agentType);
}

function effectiveLaunchAgentType(host, suppliedAgentType, logicalAgentType) {
  if (host === 'codex' && suppliedAgentType == null) return CODEX_V2_DEFAULT_AGENT_TYPE;
  return suppliedAgentType ?? logicalAgentType;
}

function intentAgentTypeMatches(record, agentType, host) {
  if (host !== 'codex') return record.agent_type === agentType;
  if (agentType == null) return true;
  if (boundedIdentity(record.binding_agent_type)) {
    // Some downstream Codex hook payloads echo APE's logical role even though
    // SubagentStart reported the V2 host-effective role. Both are persisted,
    // bounded expectations on the same bound session + agent identity.
    return record.binding_agent_type === agentType || record.agent_type === agentType;
  }
  // Records launched before binding_agent_type was persisted may be either an
  // older explicit-role launch or a V2 default-role launch. Admit either shape
  // only as a candidate; all callers still require a unique identity match.
  return record.agent_type === agentType || agentType === CODEX_V2_DEFAULT_AGENT_TYPE;
}

// Documented minimal model equivalence (F11): a ticket resolves a Claude model
// alias family ('haiku' | 'sonnet' | 'opus' | 'fable'); the Agent tool
// accepts either that alias verbatim or a fully qualified model id of the same family.
const CLAUDE_MODEL_FAMILIES = Object.freeze(['haiku', 'sonnet', 'opus', 'fable']);

function requestedModelSatisfiesTicket(requested, ticketModel) {
  if (typeof requested !== 'string' || typeof ticketModel !== 'string' || !ticketModel) return false;
  if (requested === ticketModel) return true;
  if (CLAUDE_MODEL_FAMILIES.includes(ticketModel)) {
    return new RegExp(`^claude-${ticketModel}-\\d[\\w.-]*$`).test(requested);
  }
  return false;
}

// dispatch-deny-reason-is-non-discriminating (roadmap entry). The finite,
// independently observable grounds resolveClaudeBindingOutcome below can
// report for a denied LIVE tool-call binding resolution, as plain string
// literals rather than a shared top-level exported table: this file is
// already bundled into BOTH dist/ape-hooks.bundle.mjs and
// dist/ape-mcp.bundle.mjs (service.js imports six of its other exports), and
// a NEW top-level `Object.freeze(...)`-backed export here would ship into
// dist/ape-mcp.bundle.mjs too even though nothing reachable from that entry
// point ever calls this resolver — esbuild's tree shaking removes an unused
// FUNCTION (resolveClaudeBinding/resolveClaudeBindingOutcome, exactly like
// evaluateLifecyclePolicy, never appear there) but is conservative about a
// top-level call expression's side effects, so an unused frozen object is not
// guaranteed to be shaken out. Every value below is an opaque class label,
// never caller-observed data (no session id, agent id, or ticket id), so a
// denial can never leak another agent's identity; lib/runtime/hooks.js's own
// `claudeBindingDenialReason` switches on these SAME string literals, and the
// authored suite (__tests__/runtime-v2-dispatch-deny-reason-causes.test.js)
// pins the two sides to agree behaviorally end to end through the real hook.
//   'no_session_id'      — the payload carried no usable session id
//   'no_agent_id'         — the payload carried no usable agent id
//   'no_agent_type'       — Claude carried no usable agent type, or Codex
//                           carried an explicitly malformed one (omission is
//                           accepted for compatibility with older payloads)
//   'different_agent_id'  — a bound record exists for this run, session and
//                           agent type, but under a different agent id
//   'ticket_not_pending'  — the identity resolves, but its ticket is no
//                           longer active and pending
//   'deadline_elapsed'    — the identity resolves, but its ticket/launch
//                           deadline has elapsed
//   'ambiguous'           — more than one record matches (fail closed; never
//                           narrated as a single-record story)

function pendingTicket(state, ticketId) {
  return (
    state?.status === 'running' &&
    state.tickets?.some((ticket) => ticket.ticket_id === ticketId) &&
    // A ticket the deadline-timeout transition marked expired was superseded
    // by its retry ticket: it is no longer pending, so its intent can neither
    // launch, bind, nor validate a late receipt against the retried stage.
    !(state.expired_tickets ?? []).includes(ticketId) &&
    !state.receipts?.some((receipt) => receipt.ticket_id === ticketId)
  );
}

// Same shared dir lock as the receipt-effects writer, with dispatch-scale
// constants. The heartbeat matters here too: intent writes normally finish in
// milliseconds, but a holder suspended or I/O-stalled past LOCK_STALE_MS used
// to get stolen while alive, letting two writers race the same intent file
// (an expired capability could resurrect under last-writer-wins).
async function withDispatchLock(paths, callback) {
  return withDirLock(paths.dispatchLock, callback, {
    staleMs: LOCK_STALE_MS,
    heartbeatMs: LOCK_HEARTBEAT_MS,
    busyMs: LOCK_WAIT_MS,
    serializeLocal: true,
    busyMessage: 'Claude dispatch binding is busy; retry the native tool call',
  });
}

async function readIntents(paths) {
  let names;
  try {
    names = await readdir(paths.dispatchIntents);
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const records = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const record = await readJson(path.join(paths.dispatchIntents, name), null);
    if (record) records.push({ file: path.join(paths.dispatchIntents, name), record });
  }
  return records;
}

// status.md is a bounded derived view. Dispatch intent files and active.json
// remain authoritative, so a projection/read/write failure must never change
// the result of the lifecycle transition that already persisted its truth.
async function refreshDispatchStatusDoc(paths, runId, dispatchState) {
  try {
    const state = await readJson(paths.active, null);
    if (!state || typeof state !== 'object' || Array.isArray(state) || state.run_id !== runId) return;
    await atomicReplaceText(
      path.join(paths.runtime, 'status.md'),
      renderStatusDoc(state, { dispatchState }),
    );
  } catch {
    // Best effort by contract: never weaken intent/state durability.
  }
}

// Safe, capability-free projection for the orchestrator's post-spawn check.
// A Codex spawn call is not considered successfully dispatched merely because
// the native tool returned an agent id: the PreToolUse reservation and
// SubagentStart bind must have advanced this record to `bound`. Never expose
// nonce/capability hashes or host identities on this diagnostic surface.
export async function dispatchIntentStatuses(paths, state) {
  if (!state || !['claude', 'codex'].includes(state.host)) return [];
  const receipted = new Set((state.receipts ?? []).map((receipt) => receipt.ticket_id));
  const expiredTickets = new Set(state.expired_tickets ?? []);
  const pendingIds = (state.tickets ?? [])
    .map((ticket) => ticket.ticket_id)
    .filter((ticketId) => !receipted.has(ticketId) && !expiredTickets.has(ticketId));
  if (pendingIds.length === 0) return [];
  const records = await readIntents(paths);
  return pendingIds.map((ticketId) => {
    const matches = records.filter(({ record }) =>
      record.run_id === state.run_id && record.ticket_id === ticketId && intentMatchesHost(record, state.host));
    if (matches.length !== 1) {
      return {
        ticket_id: ticketId,
        status: matches.length === 0 ? 'missing' : 'ambiguous',
        launch_attempts: 0,
      };
    }
    const record = matches[0].record;
    const agentState = record.agent_stopped_at
      ? 'observed-stopped'
      : record.status === 'bound'
        ? 'active-bound'
        : record.status === 'completed'
          ? 'receipt-completed'
          : 'not-bound';
    return {
      ticket_id: ticketId,
      status: record.status,
      agent_state: agentState,
      launch_attempts: record.launch_attempts ?? 0,
      prepared_at: record.prepared_at ?? null,
      launched_at: record.launched_at ?? null,
      bound_at: record.bound_at ?? null,
      agent_stopped_at: record.agent_stopped_at ?? null,
      expires_at: record.expires_at ?? null,
    };
  });
}

// SubagentStop is the one host lifecycle event that proves the physical
// native agent ended. Persist only that non-secret observation on the unique
// bound/completed intent; never copy transcript paths, result prose, or host
// identities beyond the fields already sealed by binding. Status and NEXT use
// this stamp to avoid treating a deadline as proof of process termination.
async function observeDispatchSubagentStop(paths, state, input, host) {
  const sessionId = input.session_id ?? input.sessionId;
  const agentId = input.agent_id ?? input.agentId;
  const agentType = input.agent_type ?? input.agentType;
  if (!boundedIdentity(sessionId) || !boundedIdentity(agentId) || !agentTypeInputValid(agentType, host)) {
    return { observed: false, record: null, reason: 'malformed native identity' };
  }
  return withDispatchLock(paths, async () => {
    const matches = (await readIntents(paths)).filter(({ record }) =>
      record.run_id === state?.run_id &&
      intentMatchesHost(record, host) &&
      ['bound', 'completed', 'expired'].includes(record.status) &&
      boundSessionMatches(record, sessionId, host) &&
      record.bound_agent_id === agentId &&
      intentAgentTypeMatches(record, agentType, host));
    if (matches.length !== 1) {
      return {
        observed: false,
        record: null,
        reason: matches.length === 0
          ? 'no matching bound native agent'
          : 'ambiguous bound native agent identity',
      };
    }
    const { file, record } = matches[0];
    if (record.agent_stopped_at) {
      await refreshDispatchStatusDoc(paths, state?.run_id, 'stopped');
      return { observed: true, record, reason: 'stop already observed' };
    }
    const stopped = { ...record, agent_stopped_at: iso() };
    await atomicWriteJson(file, stopped);
    await refreshDispatchStatusDoc(paths, state?.run_id, 'stopped');
    return { observed: true, record: stopped, reason: 'native agent stop observed' };
  });
}

export async function observeClaudeSubagentStop(paths, state, input) {
  return observeDispatchSubagentStop(paths, state, input, 'claude');
}

export async function observeCodexSubagentStop(paths, state, input) {
  return observeDispatchSubagentStop(paths, state, input, 'codex');
}

function extractNonce(prompt) {
  if (typeof prompt !== 'string' || Buffer.byteLength(prompt) > MAX_PROMPT_BYTES) return null;
  const matches = [...prompt.matchAll(/(?:^|\r?\n)APE_DISPATCH_NONCE=([A-Za-z0-9_-]{1,300})(?=\r?\n|$)/g)];
  if (matches.length !== 1 || !NONCE_PATTERN.test(matches[0][1])) return null;
  return matches[0][1];
}

export function isCodexDispatchTaskName(taskName) {
  return typeof taskName === 'string' && CODEX_TASK_NAME_PATTERN.test(taskName);
}

async function prepareDispatchIntent(paths, ticket, agentType, host) {
  if (!boundedIdentity(agentType) || !boundedIdentity(ticket.ticket_id, 2048)) {
    throw new Error(`${hostLabel(host)} dispatch intent has an invalid ticket or agent type`);
  }
  const nonce = host === 'claude' ? randomBytes(32).toString('base64url') : null;
  const agentName = host === 'codex'
    ? `ape_${ticket.role}_${randomBytes(16).toString('hex')}`
    : null;
  const createdAt = Date.now();
  const record = {
    version: 2,
    host,
    run_id: ticket.run_id,
    ticket_id: ticket.ticket_id,
    ticket_hash: ticket.ticket_hash,
    agent_type: agentType,
    ...(nonce ? { nonce_hash: digest(nonce) } : {}),
    ...(agentName ? { launch_name_hash: digest(agentName) } : {}),
    ...(host === 'codex'
      ? { injected_context_hash: digest(codexInjectedDispatchContext(ticket)) }
      : {}),
    status: 'prepared',
    prepared_at: iso(createdAt),
    expires_at: ticket.deadline_at,
    launch_attempts: 0,
  };
  await withDispatchLock(paths, async () => {
    const file = intentPath(paths, ticket.ticket_id);
    const current = await readJson(file, null);
    const currentExpiry =
      current?.status === 'launched' ? current.launch_expires_at :
      current?.expires_at;
    if (current && !expired(currentExpiry) && ['launched', 'bound'].includes(current.status)) {
      throw new Error(`${hostLabel(host)} dispatch for ${ticket.ticket_id} is already ${current.status}`);
    }
    await atomicWriteJson(file, record);
  });
  await refreshDispatchStatusDoc(paths, ticket.run_id, 'pending');
  const prompt = host === 'claude'
    ? [
        `Execute the immutable APE StageTicket ${ticket.ticket_id}.`,
        `APE_DISPATCH_NONCE=${nonce}`,
      ].join('\n')
    : `Execute the immutable APE StageTicket ${ticket.ticket_id}.`;
  // Claude's established public seam exposes these convenience mirrors.
  // Codex keeps the wire minimal because the one-time launch capability rides
  // in agent_name/task_name; Multi-Agent V2 encrypts prompt/message before the
  // PreToolUse boundary. The complete record remains persisted for both hosts.
  return host === 'claude'
    ? { nonce, expires_at: record.expires_at, prompt }
    : { prompt, agent_name: agentName };
}

export async function prepareClaudeIntent(paths, ticket, agentType) {
  return prepareDispatchIntent(paths, ticket, agentType, 'claude');
}

export async function prepareCodexIntent(paths, ticket, agentType) {
  return prepareDispatchIntent(paths, ticket, agentType, 'codex');
}

// Adapter side of the audited expire-dispatch lever (frictions #27/#30): void whatever
// intent the ticket holds so the revocation is durable and auditable. The
// retry ticket maps to its own intent file (fresh ticket_id, fresh nonce), so
// this exists to close the old capability: an 'expired' record no longer
// matches the bound/completed filter in validateClaudeReceiptBinding, and
// pendingTicket independently excludes the runtime-expired ticket.
export async function expireClaudeIntent(paths, ticketId) {
  return withDispatchLock(paths, async () => {
    const file = intentPath(paths, ticketId);
    const current = await readJson(file, null);
    if (!current || current.status === 'expired') return current;
    const voided = { ...current, status: 'expired', expired_at: iso() };
    await atomicWriteJson(file, voided);
    return voided;
  });
}

// Run-scoped revocation on abort: every prepared/launched/bound flight of the
// run is voided so an orphaned subagent's launch nonce and receipt capability
// both fail closed. 'completed' records are skipped — they prove an already-
// admitted receipt (the idempotent-retry branch of
// validateClaudeReceiptBinding) — and the bound identity fields survive on the
// expired record so the sealed hook fence can still name the orphan.
export async function expireClaudeIntentsForRun(paths, runId) {
  return withDispatchLock(paths, async () => {
    const intents = await readIntents(paths);
    const voided = [];
    for (const { file, record } of intents) {
      if (record.run_id !== runId) continue;
      if (['expired', 'completed'].includes(record.status)) continue;
      const next = { ...record, status: 'expired', expired_at: iso() };
      await atomicWriteJson(file, next);
      voided.push(next);
    }
    return voided;
  });
}

// Intent-file lifecycle cleanup (audit: nothing ever deleted intent files, so
// readIntents — which runs on EVERY subagent tool event while a run is active
// — re-read a directory that grew monotonically with project history). Legal
// exactly when a new run has become active.json: every reader (launch, bind,
// resolve, the sealed-orphan fence, receipt binding) filters
// record.run_id === state.run_id, so records of any OTHER run are provably
// unreachable. Records of keepRunId are kept regardless of status — expired
// and completed records still back the sealed fence and the idempotent
// receipt-retry branch. Never call this at seal/abort: the sealed run remains
// active.json and its records must stay resolvable. Corrupt records are
// removed too — no reader can ever match them, and one unparseable file
// otherwise fails every readIntents call closed. Runs under the dispatch
// lock so an in-flight intent write is never sheared.
export async function pruneClaudeIntents(paths, keepRunId) {
  return withDispatchLock(paths, async () => {
    let names;
    try {
      names = await readdir(paths.dispatchIntents);
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
    const pruned = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const file = path.join(paths.dispatchIntents, name);
      // Corrupt JSON throws out of readJson (its fallback covers only ENOENT);
      // both cases mean "no reader can match this record": prune it.
      const record = await readJson(file, null).catch(() => null);
      if (record !== null && record.run_id === keepRunId) continue;
      await rm(file, { force: true });
      pruned.push(name);
    }
    return pruned;
  });
}

async function launchDispatchIntent(paths, state, input, host) {
  const label = hostLabel(host);
  const sessionId = input.session_id ?? input.sessionId;
  const toolUseId = input.tool_use_id ?? input.toolUseId;
  // Third container matches bin/ape-hook.mjs's own DETECTION priority order
  // (its own `toolInput` local, feeding isApeLaunch) — without it, a launch
  // whose tool input arrives shaped {tool_name, input: {...}} is DETECTED as
  // an APE launch there (isApeLaunch reads the same third container) but
  // re-derives agentType/nonce here from only the first two, so the payload
  // that triggered this very call always reads as malformed and the launch
  // can only ever be denied.
  const toolInput = input.tool_input ?? input.toolInput ?? input.input ?? {};
  const subagentPrompt = Array.isArray(toolInput.Subagents) ? toolInput.Subagents[0]?.Prompt : null;
  const rawPrompt = toolInput.prompt ?? toolInput.message ?? subagentPrompt;
  const subagentType = Array.isArray(toolInput.Subagents) ? toolInput.Subagents[0]?.TypeName : null;
  const suppliedAgentType =
    toolInput.subagent_type ?? toolInput.subagentType ?? toolInput.agent_type ?? toolInput.agentType ?? subagentType;
  const nonce = host === 'claude' ? extractNonce(rawPrompt) : null;
  const taskName = toolInput.task_name ?? toolInput.taskName;
  const hasCapability = host === 'codex' ? isCodexDispatchTaskName(taskName) : Boolean(nonce);
  // Multi-Agent V2's Codex collaboration.spawn_agent call has no agent_type
  // input. Its random task_name is the opaque launch capability, so recover the
  // logical prepared type only after that capability uniquely matches, then
  // persist the host-effective `default` type for lifecycle binding. Claude
  // still requires its native type, and an explicitly supplied Codex type must
  // remain bounded and match the logical intent exactly.
  const suppliedTypeValid =
    suppliedAgentType === undefined || suppliedAgentType === null
      ? (host === 'codex')
      : boundedIdentity(suppliedAgentType);
  if (!boundedIdentity(sessionId) || !boundedIdentity(toolUseId) || !suppliedTypeValid || !hasCapability) {
    return { valid: false, reason: `APE ${label} launch denied: malformed or missing dispatch capability` };
  }

  return withDispatchLock(paths, async () => {
    const intents = await readIntents(paths);
    const matching = intents.filter(({ record }) =>
      record.run_id === state?.run_id &&
      intentMatchesHost(record, host) &&
      (suppliedAgentType === undefined || suppliedAgentType === null || record.agent_type === suppliedAgentType) &&
      (host === 'codex'
        ? record.launch_name_hash === digest(taskName)
        : record.nonce_hash === digest(nonce)));
    if (matching.length !== 1) {
      return { valid: false, reason: `APE ${label} launch denied: capability or agent type mismatch` };
    }
    const { file, record } = matching[0];
    const agentType = suppliedAgentType ?? record.agent_type;
    const bindingAgentType = effectiveLaunchAgentType(host, suppliedAgentType, record.agent_type);
    if (!pendingTicket(state, record.ticket_id)) {
      return { valid: false, reason: `APE ${label} launch denied: ticket is not active and pending` };
    }
    const ticket = state.tickets.find((candidate) => candidate.ticket_id === record.ticket_id);
    if (expired(record.expires_at) || expired(ticket?.deadline_at)) {
      await atomicWriteJson(file, { ...record, status: 'expired', expired_at: iso() });
      return { valid: false, reason: `APE ${label} launch denied: ticket deadline elapsed` };
    }
    if (record.status === 'launched' && expired(record.launch_expires_at)) {
      await atomicWriteJson(file, { ...record, status: 'expired', expired_at: iso() });
      return { valid: false, reason: `APE ${label} launch denied: launched intent expired` };
    }
    if (record.status === 'launched') {
      const sameInvocation =
        record.parent_session_id === sessionId &&
        record.tool_use_id === toolUseId &&
        record.agent_type === agentType &&
        intentAgentTypeMatches(record, bindingAgentType, host);
      if (sameInvocation && host === 'codex' && !record.binding_agent_type) {
        await atomicWriteJson(file, { ...record, binding_agent_type: bindingAgentType });
      }
      return sameInvocation
        ? { valid: true, reason: `APE ${label} launch already authorized for this native tool call` }
        : { valid: false, reason: `APE ${label} launch denied: dispatch capability replayed` };
    }
    if (record.status !== 'prepared') {
      return { valid: false, reason: `APE ${label} launch denied: intent is ${record.status}` };
    }
    const collision = intents.some(({ record: other }) =>
      other.ticket_id !== record.ticket_id &&
      other.status === 'launched' &&
      intentMatchesHost(other, host) &&
      (host === 'codex' || other.parent_session_id === sessionId) &&
      intentAgentTypeMatches(other, bindingAgentType, host) &&
      !expired(other.launch_expires_at ?? other.expires_at));
    if (collision) {
      return { valid: false, reason: `APE ${label} launch denied: session and agent type collision` };
    }
    // Ticket model policy (F11): the Agent tool call's `model` parameter is
    // the host-observed *request*. The runtime enforces it here — a launch
    // whose requested model is absent or outside the documented equivalence
    // with the ticket's resolved model is denied, so a scheduled deep-tier
    // stage cannot silently execute on a cheaper or different model.
    const requestedModel =
      typeof toolInput.model === 'string' && boundedIdentity(toolInput.model, 256)
        ? toolInput.model
        : null;
    const ticketModel = ticket?.model?.model ?? null;
    if (!requestedModelSatisfiesTicket(requestedModel, ticketModel)) {
      return {
        valid: false,
        reason: `APE ${label} launch denied: requested model ${requestedModel ?? '(absent)'} does not satisfy the ticket model ${ticketModel ?? '(unset)'}; restate the ticket model on the Agent call — pass model: '${ticketModel ?? '<dispatch.model.model>'}' or a fully qualified same-family id`,
      };
    }
    const requestedReasoningEffort =
      typeof (toolInput.reasoning_effort ?? toolInput.reasoningEffort) === 'string'
        ? (toolInput.reasoning_effort ?? toolInput.reasoningEffort)
        : null;
    const ticketReasoningEffort = ticket?.model?.reasoning_effort ?? null;
    if (host === 'codex' && requestedReasoningEffort !== ticketReasoningEffort) {
      return {
        valid: false,
        reason: `APE Codex launch denied: requested reasoning effort ${requestedReasoningEffort ?? '(absent)'} does not satisfy the ticket effort ${ticketReasoningEffort ?? '(unset)'}`,
      };
    }
    const launchedAt = Date.now();
    // Persist the requested model on the intent — the bound/completed writes
    // spread the record forward — and recordReceiptLocked stamps it into
    // receipt provenance as requested_model/requested_model_attested. A
    // PreToolUse payload attests the request, not execution, so it is never
    // recorded as the effective model.
    await atomicWriteJson(file, {
      ...record,
      status: 'launched',
      requested_model: requestedModel,
      ...(requestedReasoningEffort ? { requested_reasoning_effort: requestedReasoningEffort } : {}),
      ...(host === 'codex' ? { binding_agent_type: bindingAgentType } : {}),
      parent_session_id: sessionId,
      tool_use_id: toolUseId,
      launched_at: iso(launchedAt),
      launch_expires_at: iso(Math.min(Date.parse(record.expires_at), launchedAt + LAUNCH_TTL_MS)),
      launch_attempts: (record.launch_attempts ?? 0) + 1,
    });
    return { valid: true, reason: `APE ${label} launch authorized for ${record.ticket_id}` };
  });
}

export async function launchClaudeIntent(paths, state, input) {
  return launchDispatchIntent(paths, state, input, 'claude');
}

export async function launchCodexIntent(paths, state, input) {
  return launchDispatchIntent(paths, state, input, 'codex');
}

async function bindDispatchSubagent(paths, state, input, host) {
  const label = hostLabel(host);
  const sessionId = input.session_id ?? input.sessionId;
  const agentId = input.agent_id ?? input.agentId;
  const agentType = input.agent_type ?? input.agentType;
  if (!boundedIdentity(sessionId) || !boundedIdentity(agentId) || !agentTypeInputValid(agentType, host)) {
    return { valid: false, reason: `APE ${label} binding denied: malformed native identity` };
  }

  return withDispatchLock(paths, async () => {
    const intents = await readIntents(paths);

    // RESUME across the launch_expires_at boundary (dispatch-binding-resume-gap,
    // disposition (a)). launch_expires_at governs only the ~60s window in which
    // a FRESH nonce may be claimed and a FRESH SubagentStart may consume it — it
    // is not the ticket's authorization horizon (deadline_at is). IF a host
    // re-fires SubagentStart for an identity that is ALREADY 'bound' — one shape
    // a subagent resume-after-crash could take — resolveClaudeBinding (the read
    // path every ordinary bound tool call resolves through) already treats that
    // binding as live for the remainder of the TICKET deadline: it filters only
    // on the intent's own `expires_at` (which mirrors the ticket deadline),
    // NEVER on launch_expires_at (re-verified against this tree: `git log
    // -Slaunch_expires_at -- lib/runtime/hooks.js` is empty — no tool-call gate
    // anywhere in hooks.js has ever consulted that field). Re-admitting the
    // EXACT host identity here (run, parent/child session and native agent id;
    // plus agent type whenever the host supplies it)
    // closes THAT disagreement: SubagentStart stops denying a binding its own
    // sibling read path already honors, for an identity presented unchanged.
    // It closes only that seam. A resumed process presenting a genuinely
    // DIFFERENT session_id/agent_id (or an explicitly different agent_type) —
    // a distinct, unverified
    // hypothesis for what the originating incident's tool-call denials
    // actually were, since those denials cannot have been caused by
    // launch_expires_at — is not, and must not be, admitted by this branch:
    // the exact-identity match below is the security boundary, not an
    // oversight, and bridging a changed identity would widen who is admitted,
    // which is out of bounds for this ticket (see its load-bearing security
    // constraint). Whether a resumed subagent's native identity is actually
    // preserved end-to-end is an open adapter-side question this change does
    // not answer; it is recorded as a finding, not silently closed. Nothing
    // about WHAT the binding authorizes widens — claimed_paths, required checks
    // and the ticket deadline are untouched — and every other shape still falls
    // through to the denials below: a wrong agent id (bound_agent_id mismatch),
    // no prior binding at all, and — checked explicitly and cause-specifically,
    // since pendingTicket alone does not look at the deadline — a binding
    // whose TICKET deadline has genuinely elapsed versus one merely no longer
    // active/pending (superseded by its own retry, or already receipted).
    //
    // Mirrors resolveClaudeBinding's own shape: filter() plus a length !== 1
    // fail-closed deny (never find()'s first-match-wins), so a duplicate bound
    // record for the same identity denies here exactly as the read path
    // already would under the same ambiguity, rather than the two seams
    // disagreeing.
    const resumeMatches = intents.filter(({ record }) =>
      record.run_id === state?.run_id &&
      intentMatchesHost(record, host) &&
      record.status === 'bound' &&
      boundSessionMatches(record, sessionId, host) &&
      record.bound_agent_id === agentId &&
      intentAgentTypeMatches(record, agentType, host));
    if (resumeMatches.length === 1) {
      const { file, record } = resumeMatches[0];
      const ticket = state?.tickets?.find((candidate) => candidate.ticket_id === record.ticket_id);
      // Cause-specific, mirroring launchClaudeIntent's own two-step split
      // (line 232 vs 238) and evaluateStartBinding's four-way split (hooks.js):
      // "not active and pending" (run not running, superseded by a retry, or
      // already receipted) is a DIFFERENT cause from a genuine deadline
      // overrun, and collapsing them into one reason misleads an operator who
      // copies the literal into evidence.summary per prompts/common.md.
      if (!pendingTicket(state, record.ticket_id)) {
        return { valid: false, reason: `APE ${label} binding denied: ticket is not active and pending` };
      }
      if (expired(ticket?.deadline_at) || expired(record.expires_at)) {
        return { valid: false, reason: `APE ${label} binding denied: ticket deadline elapsed` };
      }
      let injectedContext = null;
      let resumedCapability = null;
      if (host === 'codex') {
        if (record.ticket_hash !== ticket?.ticket_hash) {
          return { valid: false, reason: 'APE Codex binding denied: dispatch ticket hash mismatch' };
        }
        try {
          injectedContext = codexInjectedDispatchContext(ticket);
        } catch {
          return { valid: false, reason: 'APE Codex binding denied: authoritative context unavailable' };
        }
        if (record.injected_context_hash !== digest(injectedContext)) {
          return { valid: false, reason: 'APE Codex binding denied: authoritative context hash mismatch' };
        }
        // A resumed Codex lifecycle event receives the authoritative contract
        // again. Rotate the receipt capability so the re-injected value is the
        // only live one for this exact native identity.
        resumedCapability = randomBytes(32).toString('base64url');
      }
      // Audit trace: every other lifecycle transition on this record is
      // stamped (launched_at, bound_at, expired_at, completed_at); a resumed
      // re-admission gets the same treatment. Status and bound_agent_id remain
      // untouched; Claude retains its original capability, while Codex rotates
      // the capability it re-injects with the authoritative context. A bound
      // intent can be resumed repeatedly and each event remains attributable.
      await atomicWriteJson(file, {
        ...record,
        ...(resumedCapability ? { capability_hash: digest(resumedCapability) } : {}),
        resumed_at: iso(),
        resume_count: (record.resume_count ?? 0) + 1,
      });
      return {
        valid: true,
        reason: `APE ${label} native identity re-admitted to ${record.ticket_id} after the launch window closed`,
        ticket_id: record.ticket_id,
        ...(injectedContext
          ? {
              additional_context: [
                `APE_BOUND_CAPABILITY=${resumedCapability}`,
                `APE_RECEIPT_CAPABILITY=${resumedCapability}`,
                '',
                injectedContext,
              ].join('\n'),
            }
          : {}),
      };
    }

    const launchedForIdentity = intents.filter(({ record }) =>
      record.run_id === state?.run_id &&
      intentMatchesHost(record, host) &&
      record.status === 'launched' &&
      (host === 'codex' || record.parent_session_id === sessionId) &&
      intentAgentTypeMatches(record, agentType, host));
    for (const candidate of launchedForIdentity) {
      if (expired(candidate.record.launch_expires_at ?? candidate.record.expires_at)) {
        await atomicWriteJson(candidate.file, {
          ...candidate.record,
          status: 'expired',
          expired_at: iso(),
        });
      }
    }
    const launched = launchedForIdentity.filter(({ record }) =>
      !expired(record.launch_expires_at ?? record.expires_at));
    if (launched.length !== 1) {
      return { valid: false, reason: `APE ${label} binding denied: no unique active launched intent` };
    }
    if (intents.some(({ record }) =>
      record.run_id === state?.run_id &&
      intentMatchesHost(record, host) &&
      record.status === 'bound' &&
      record.bound_agent_id === agentId)) {
      return { valid: false, reason: `APE ${label} binding denied: native agent identity already bound` };
    }
    const { file, record } = launched[0];
    if (!pendingTicket(state, record.ticket_id)) {
      return { valid: false, reason: `APE ${label} binding denied: ticket is not active and pending` };
    }
    const ticket = state.tickets.find((candidate) => candidate.ticket_id === record.ticket_id);
    let injectedContext = null;
    if (host === 'codex') {
      if (record.ticket_hash !== ticket?.ticket_hash) {
        return { valid: false, reason: 'APE Codex binding denied: dispatch ticket hash mismatch' };
      }
      try {
        injectedContext = codexInjectedDispatchContext(ticket);
      } catch {
        return { valid: false, reason: 'APE Codex binding denied: authoritative context unavailable' };
      }
      if (record.injected_context_hash !== digest(injectedContext)) {
        return { valid: false, reason: 'APE Codex binding denied: authoritative context hash mismatch' };
      }
    }
    const capability = randomBytes(32).toString('base64url');
    await atomicWriteJson(file, {
      ...record,
      status: 'bound',
      ...(host === 'codex' ? { bound_session_id: sessionId } : {}),
      bound_agent_id: agentId,
      capability_hash: digest(capability),
      bound_at: iso(),
    });
    await refreshDispatchStatusDoc(paths, state?.run_id, 'live');
    return {
      valid: true,
      reason: `APE ${label} native identity bound to ${record.ticket_id}`,
      ticket_id: record.ticket_id,
      additional_context: [
        `APE_BOUND_CAPABILITY=${capability}`,
        `APE_RECEIPT_CAPABILITY=${capability}`,
        ...(injectedContext ? ['', injectedContext] : []),
      ].join('\n'),
    };
  });
}

export async function bindClaudeSubagent(paths, state, input) {
  return bindDispatchSubagent(paths, state, input, 'claude');
}

export async function bindCodexSubagent(paths, state, input) {
  return bindDispatchSubagent(paths, state, input, 'codex');
}

// Reports WHICH class of ground denied the binding, alongside resolveClaudeBinding's
// own record-or-null outcome (F1, plan review: ONE admission predicate, never two
// independently maintained copies of the same filter — resolveClaudeBinding below
// DELEGATES here rather than re-implementing the filter, so admission cannot
// silently diverge between the record-returning caller and this cause-reporting
// one). Every branch here was already a bare-`null` denial before this change;
// nothing here widens or narrows admission — it only attaches a cause label
// (one of the string literals documented above) to each existing denial branch.
//
// DIAGNOSTIC ONLY, and NO IDENTITY LEAK: `cause` is always one of those labels,
// never a session id, agent id, or ticket id — a caller denied under
// 'different_agent_id' learns that some other identity is bound, never which.
//
// (F2) The three identity-shape grounds are checked and reported SEPARATELY —
// an unusable SESSION id must never be reported as an agent-id problem, and vice
// versa — rather than collapsed onto one "unusable identity" cause the way the
// single `boundedIdentity(...) || boundedIdentity(...) || ...` guard used to.
//
// (F5, precedence) The zero-exact-match sub-classification below relaxes exactly
// ONE predicate at a time from the same exact-match filter: DIFFERENT_AGENT_ID
// relaxes only `bound_agent_id === agentId` (so it can only ever match a record
// whose bound_agent_id differs from the caller's), and DEADLINE_ELAPSED relaxes
// only `!expired(record.expires_at)` (so it can only ever match a record bound to
// the caller's OWN agent id). The two relaxations are therefore mutually
// exclusive by construction — an expired record under the caller's own agent id
// can never satisfy the DIFFERENT_AGENT_ID branch, and a live record under a
// different agent id can never satisfy DEADLINE_ELAPSED — so no precedence
// ordering between them can ever matter, and the order below is fixed regardless.
async function resolveDispatchBindingOutcome(paths, state, input, host) {
  const sessionId = input.session_id ?? input.sessionId;
  const agentId = input.agent_id ?? input.agentId;
  const agentType = input.agent_type ?? input.agentType;
  if (!boundedIdentity(sessionId)) {
    return { record: null, cause: 'no_session_id' };
  }
  if (!boundedIdentity(agentId)) {
    return { record: null, cause: 'no_agent_id' };
  }
  if (!agentTypeInputValid(agentType, host)) {
    return { record: null, cause: 'no_agent_type' };
  }

  const intents = await readIntents(paths);
  // Exactly resolveClaudeBinding's original filter, unwidened.
  const exact = intents.filter(({ record }) =>
    record.run_id === state?.run_id &&
    intentMatchesHost(record, host) &&
    record.status === 'bound' &&
    boundSessionMatches(record, sessionId, host) &&
    record.bound_agent_id === agentId &&
    intentAgentTypeMatches(record, agentType, host) &&
    !expired(record.expires_at));
  // FAIL CLOSED ON AMBIGUITY (hard constraint): zero or several matches are both
  // still a denial; several is never narrated as a single-record story.
  if (exact.length > 1) {
    return { record: null, cause: 'ambiguous' };
  }
  if (exact.length === 1) {
    const { record } = exact[0];
    if (!pendingTicket(state, record.ticket_id)) {
      return { record: null, cause: 'ticket_not_pending' };
    }
    return { record, cause: null };
  }

  // exact.length === 0: sub-classify with the two disjoint single-predicate
  // relaxations described above.
  const differentAgentLive = intents.some(({ record }) =>
    record.run_id === state?.run_id &&
    intentMatchesHost(record, host) &&
    record.status === 'bound' &&
    boundSessionMatches(record, sessionId, host) &&
    intentAgentTypeMatches(record, agentType, host) &&
    record.bound_agent_id !== agentId &&
    !expired(record.expires_at));
  if (differentAgentLive) {
    return { record: null, cause: 'different_agent_id' };
  }
  const sameAgentExpired = intents.some(({ record }) =>
    record.run_id === state?.run_id &&
    intentMatchesHost(record, host) &&
    record.status === 'bound' &&
    boundSessionMatches(record, sessionId, host) &&
    record.bound_agent_id === agentId &&
    intentAgentTypeMatches(record, agentType, host) &&
    expired(record.expires_at));
  if (sameAgentExpired) {
    return { record: null, cause: 'deadline_elapsed' };
  }
  // No record at all matches even a relaxed filter: nothing more specific is
  // observable, so no cause is reported and the hook's generic fallback stands.
  return { record: null, cause: null };
}

export async function resolveClaudeBindingOutcome(paths, state, input) {
  return resolveDispatchBindingOutcome(paths, state, input, 'claude');
}

export async function resolveCodexBindingOutcome(paths, state, input) {
  return resolveDispatchBindingOutcome(paths, state, input, 'codex');
}

export async function resolveClaudeBinding(paths, state, input) {
  return (await resolveClaudeBindingOutcome(paths, state, input)).record;
}

export async function resolveCodexBinding(paths, state, input) {
  return (await resolveCodexBindingOutcome(paths, state, input)).record;
}

// After abort the intent is 'expired' and pendingTicket is false, so
// resolveClaudeBinding can no longer name the orphan; this resolver exists
// solely so the sealed-state hook branch can deny the orphan's writes. It
// answers identity ("was this agent bound to this run"), not liveness — hence
// no expires_at, no pendingTicket, no unique-match requirement: any match must
// fence rather than fail open. Never-bound expired records self-exclude
// because bound_agent_id is unset.
async function resolveSealedDispatchBinding(paths, state, input, host) {
  const sessionId = input.session_id ?? input.sessionId;
  const agentId = input.agent_id ?? input.agentId;
  const agentType = input.agent_type ?? input.agentType;
  if (!boundedIdentity(sessionId) || !boundedIdentity(agentId) || !agentTypeInputValid(agentType, host)) return null;
  const intents = await readIntents(paths);
  const matches = intents.filter(({ record }) =>
    record.run_id === state?.run_id &&
    intentMatchesHost(record, host) &&
    ['bound', 'completed', 'expired'].includes(record.status) &&
    boundSessionMatches(record, sessionId, host) &&
    record.bound_agent_id === agentId &&
    intentAgentTypeMatches(record, agentType, host));
  return matches[0]?.record ?? null;
}

export async function resolveSealedClaudeBinding(paths, state, input) {
  return resolveSealedDispatchBinding(paths, state, input, 'claude');
}

export async function resolveSealedCodexBinding(paths, state, input) {
  return resolveSealedDispatchBinding(paths, state, input, 'codex');
}

export async function validateClaudeReceiptBinding(
  paths,
  state,
  ticket,
  receiptCapability,
  inputHash,
) {
  if (
    !NONCE_PATTERN.test(receiptCapability ?? '') ||
    !boundedIdentity(inputHash, 128)
  ) return { valid: false };
  const intents = await readIntents(paths);
  // The receipt capability is a unique, server-minted secret handed to exactly one
  // subagent (via SubagentStart additional_context) and pinned here to a single
  // intent record by run_id + ticket_id + ticket_hash. Presenting it is proof the
  // receipt came from the subagent APE bound to this ticket. The host agent
  // identity is trustworthy only in live hook payloads, where the host attests it
  // (see resolveClaudeBinding); a receipt's self-reported identity carries no
  // independent trust and the subagent is never told the id it would need to echo,
  // so binding rests on the capability alone. The runtime then stamps the
  // authoritative bound_agent_id onto the receipt (agent_identity below) so the
  // recorded identity is host-attested rather than guessed.
  // Deliberately no expires_at filter here: a BOUND (or completed) intent past
  // the ticket deadline still cryptographically proves who produced the
  // receipt. Hard-rejecting on expiry would make deadline-aware admission dead
  // code on Claude — validateStageReceipt adjudicates lateness (a late receipt
  // is admitted only while it is still provably valid against the live tree)
  // and the runtime records the overrun in state.deadline_overruns. It also
  // keeps the completed-record idempotent-retry branch reachable after expiry.
  // A receipt with no binding at all still fails closed below.
  const matches = intents.filter(({ record }) =>
    record.run_id === state?.run_id &&
    intentMatchesHost(record, state.host) &&
    record.ticket_id === ticket.ticket_id &&
    record.ticket_hash === ticket.ticket_hash &&
    ['bound', 'completed'].includes(record.status) &&
    record.capability_hash === digest(receiptCapability));
  if (matches.length !== 1) return { valid: false };
  const { file, record } = matches[0];
  if (record.status === 'completed') {
    return {
      valid: record.receipt_input_hash === inputHash,
      retry: record.receipt_input_hash === inputHash,
      receipt_id: record.receipt_id,
      receipt_hash: record.receipt_hash,
      agent_identity: record.bound_agent_id,
    };
  }
  return {
    valid: pendingTicket(state, ticket.ticket_id),
    retry: false,
    file,
    record,
    agent_identity: record.bound_agent_id,
  };
}

export async function completeClaudeReceiptBinding(paths, ticket, binding, inputHash, receipt) {
  if (!binding?.file || !binding?.record) return;
  await withDispatchLock(paths, async () => {
    const current = await readJson(binding.file, null);
    if (
      current?.ticket_id !== ticket.ticket_id ||
      current?.ticket_hash !== ticket.ticket_hash ||
      current?.status !== 'bound' ||
      current?.capability_hash !== binding.record.capability_hash
    ) {
      throw new Error('Claude receipt capability changed before completion');
    }
    await atomicWriteJson(binding.file, {
      ...current,
      status: 'completed',
      receipt_input_hash: inputHash,
      receipt_id: receipt.receipt_id,
      receipt_hash: receipt.receipt_hash,
      completed_at: iso(),
    });
  });
}

// ---------------------------------------------------------------------------
// Draft validation tracking on dispatch intents
// ---------------------------------------------------------------------------
// Observes that a draft receipt was validated during the bound agent's
// lifecycle. This is a non-destructive observation: it never consumes the
// receipt capability, modifies the ticket, or mutates run state. The parent
// reads valid_draft_observed at SubagentStop to decide whether an
// infrastructure failure should be recorded.

/**
 * Records that a draft receipt validation was performed for a dispatch intent.
 * Non-destructive: does not consume the capability or stage attempt.
 * @param {object} paths - Runtime paths
 * @param {string} ticketId - The ticket the validation pertains to
 * @param {{ valid: boolean, attempt: number }} observation
 * @returns {Promise<{ observed: boolean }>}
 */
export async function observeDispatchDraftValidation(paths, ticketId, observation) {
  return withDispatchLock(paths, async () => {
    const file = intentPath(paths, ticketId);
    const current = await readJson(file, null);
    if (!current || !['bound', 'completed'].includes(current.status)) {
      return { observed: false };
    }
    // Track validation observations without modifying status or capability_hash
    const validationAttempts = (current.validation_attempts ?? 0) + 1;
    const validDraftObserved = current.valid_draft_observed === true || observation?.valid === true;
    await atomicWriteJson(file, {
      ...current,
      validation_attempts: validationAttempts,
      valid_draft_observed: validDraftObserved,
      last_validation_at: iso(),
    });
    return { observed: true };
  });
}

/**
 * Marks a dispatch intent as having an infrastructure failure because no
 * valid draft was observed before the agent terminated. Non-destructive:
 * does not consume the capability, attempt, or create a replacement ticket.
 * @param {object} paths - Runtime paths
 * @param {string} ticketId - The ticket that failed validation
 * @returns {Promise<{ marked: boolean }>}
 */
export async function markDispatchInfrastructureFailure(paths, ticketId) {
  return withDispatchLock(paths, async () => {
    const file = intentPath(paths, ticketId);
    const current = await readJson(file, null);
    if (!current || !['bound', 'completed', 'expired'].includes(current.status)) {
      return { marked: false };
    }
    await atomicWriteJson(file, {
      ...current,
      infrastructure_failure: true,
      infrastructure_failure_at: iso(),
    });
    return { marked: true };
  });
}
