import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, mkdir, open, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteJson, publishImmutableJson } from './storage.js';
import { withDirLock } from './lock.js';
import { validateGovernedRuntimeAncestor } from './paths.js';
import { SCHEMA_VERSION } from './constants.js';
import { finalizeTicket, validateTicket } from './schemas.js';
import {
  bindCodexSubagent,
  bootstrapCodexSubagent,
  corroboratesCodexProbeBinding,
  corroboratesCodexProbeLifecycle,
  launchCodexIntent,
  prepareCodexIntent,
  readCodexBootstrapIntent,
  isCodexBootstrapReplay,
} from './claude-dispatch.js';
import { BOOTSTRAP_TOOL_PATTERN, codexBootstrapOrientation, recordCodexBootstrapCandidate, resolveCodexBootstrapCandidate } from './codex-bootstrap.js';

const PROBE_TTL_MS = 5 * 60_000;
const LAUNCH_TTL_MS = 60_000;
const LOCK_STALE_MS = 10_000;
const LOCK_HEARTBEAT_MS = 2_500;
const LOCK_WAIT_MS = 2_000;
const CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{32,256}$/;
const PROBE_ID_PATTERN = /^probe-[A-Za-z0-9_-]{8,128}$/;
const GENERATED_PROBE_ID_PATTERN =
  /^probe-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const PROBE_TASK_NAME_PATTERN = /^ape_probe_[a-f0-9]{32}$/;
const CODEX_V2_DEFAULT_AGENT_TYPE = 'default';
const PROBE_ROLE = 'preflight_analyst';
const PROBE_TICKET_SUFFIX = ':binding-probe:ticket';
const PROBE_STATUSES = new Set([
  'prepared',
  'launched',
  'bound',
  'completed',
  'consumed',
]);
const PROBE_RESERVATION_STATUSES = new Set([
  'prepared',
  'launched',
  'bound',
  'completed',
]);
const PROBE_REPLACEMENT_BLOCKING_STATUSES = PROBE_RESERVATION_STATUSES;
const MAX_RETIRED_PROBE_IDENTITIES = 256;
const PROBE_QUARANTINE_VERSION = 1;
const PROBE_RETIRED_TURN_VERSION = 1;
const MAX_PROBE_ARTIFACT_BYTES = 1024 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const MISSING_PROBE_RECORD = Symbol('missing-binding-probe-record');
const PROBE_TRANSITION_SEQUENCE = Object.freeze([
  'prepared',
  'launched',
  'bound',
  'completed',
  'consumed',
]);

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function iso(ms = Date.now()) {
  return new Date(ms).toISOString();
}

function expired(value, at = Date.now()) {
  const parsed = Date.parse(value ?? '');
  return !Number.isFinite(parsed) || parsed <= at;
}

function bounded(value, max = 512) {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

// Every probe artifact is owned by this runtime. Check each intermediate
// directory as well as the leaf: O_NOFOLLOW alone does not stop a ledger or
// shard symlink from redirecting an immutable publication outside the project.
async function probeArtifactContainer(paths, file, { create = false } = {}) {
  if (!(await validateGovernedRuntimeAncestor(paths))) return false;
  const relative = path.relative(paths.runtime, path.dirname(file));
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
    throw new Error('native binding probe artifact is outside the governed runtime');
  }
  let directory = paths.runtime;
  let canonical = await realpath(paths.runtime);
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    directory = path.join(directory, segment);
    canonical = path.join(canonical, segment);
    if (create) {
      try {
        await mkdir(directory, { mode: 0o700 });
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
      }
    }
    let metadata;
    try {
      metadata = await lstat(directory);
    } catch (error) {
      if (!create && error?.code === 'ENOENT') return false;
      throw error;
    }
    if (metadata.isSymbolicLink() || !metadata.isDirectory() || await realpath(directory) !== canonical) {
      throw new Error('native binding probe artifact directory is not a governed plain directory');
    }
  }
  return true;
}

async function readProbeArtifact(paths, file) {
  if (!(await probeArtifactContainer(paths, file))) return MISSING_PROBE_RECORD;
  let before;
  try {
    before = await lstat(file);
  } catch (error) {
    if (error?.code === 'ENOENT') return MISSING_PROBE_RECORD;
    throw error;
  }
  const ordinary = (metadata) => metadata.isFile() && !metadata.isSymbolicLink() &&
    metadata.size <= MAX_PROBE_ARTIFACT_BYTES;
  const same = (left, right) => left.dev === right.dev && left.ino === right.ino &&
    left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
  if (!ordinary(before)) throw new Error('native binding probe artifact must be a bounded ordinary file');
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);
  const handle = await open(file, flags);
  try {
    const opened = await handle.stat();
    if (!ordinary(opened) || !same(before, opened)) {
      throw new Error('native binding probe artifact changed during open');
    }
    const buffer = Buffer.alloc(MAX_PROBE_ARTIFACT_BYTES + 1);
    let used = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, used, buffer.length - used, used);
      used += bytesRead;
      if (used > MAX_PROBE_ARTIFACT_BYTES) throw new Error('native binding probe artifact exceeds size limit');
      if (bytesRead === 0) break;
    }
    const after = await handle.stat();
    const current = await lstat(file);
    if (!ordinary(after) || !ordinary(current) || !same(opened, after) || !same(after, current)) {
      throw new Error('native binding probe artifact changed during read');
    }
    return JSON.parse(buffer.subarray(0, used).toString('utf8'));
  } finally {
    await handle.close();
  }
}

function bindingAgentTypeMatches(record, agentType) {
  if (agentType == null) return true;
  if (bounded(record.binding_agent_type)) {
    return record.binding_agent_type === agentType || record.agent_type === agentType;
  }
  // Compatibility for a probe launched before the effective host type was
  // persisted. Unique probe state and the launch capability still fail closed.
  return record.agent_type === agentType || agentType === CODEX_V2_DEFAULT_AGENT_TYPE;
}

function validProbeTicketId(probeId, ticketId) {
  return (
    GENERATED_PROBE_ID_PATTERN.test(probeId ?? '') &&
    ticketId === `${probeId}${PROBE_TICKET_SUFFIX}`
  );
}

function probeTicketPath(paths, probeId, ticketId) {
  if (!validProbeTicketId(probeId, ticketId)) {
    throw new Error('invalid native binding probe ticket identifier');
  }
  return path.join(paths.tickets, `${ticketId.replaceAll(':', '_')}.json`);
}

function makeProbeTicket(probeId, model, issuedAt, expiresAt) {
  return finalizeTicket({
    schema_version: SCHEMA_VERSION,
    ticket_id: `${probeId}:binding-probe:ticket`,
    run_id: probeId,
    stage_id: 'binding-probe',
    parallel_group: null,
    role: PROBE_ROLE,
    objective: 'Verify native Codex launch, SubagentStart binding, and authoritative ticket-context delivery.',
    claimed_paths: [],
    test_paths: [],
    model_tier: 'fast',
    model,
    deadline_at: expiresAt,
    output_schema: {
      type: 'object',
      required: ['probe_id', 'probe_capability'],
      additionalProperties: false,
    },
    required_checks: [],
    parent_hash: null,
    base_tree_sha: '0'.repeat(40),
    attempt: 1,
    writable: false,
    issued_at: issuedAt,
  });
}

async function readProbeTicket(paths, record) {
  if (
    !validProbeTicketId(record?.probe_id, record?.ticket_id) ||
    !/^[a-f0-9]{64}$/u.test(record?.ticket_hash ?? '')
  ) return null;
  let validation;
  try {
    const ticket = await readProbeArtifact(
      paths,
      probeTicketPath(paths, record.probe_id, record.ticket_id),
    );
    validation = validateTicket(ticket);
  } catch {
    // A malformed or unreadable authoritative ticket is failed evidence, not
    // an exception that may escape the dedicated pre-run hook path.
    return null;
  }
  if (
    !validation.valid ||
    validation.value.run_id !== record.probe_id ||
    validation.value.ticket_id !== record.ticket_id ||
    validation.value.ticket_hash !== record.ticket_hash ||
    validation.value.role !== PROBE_ROLE ||
    validation.value.model?.model !== record.model?.model ||
    (validation.value.model?.reasoning_effort ?? null) !==
      (record.model?.reasoning_effort ?? null) ||
    validation.value.issued_at !== record.prepared_at ||
    validation.value.deadline_at !== record.expires_at ||
    expired(validation.value.deadline_at)
  ) return null;
  return validation.value;
}

function probeBindingState(record, ticket) {
  return {
    run_id: record.probe_id,
    host: 'codex',
    status: 'running',
    tickets: [ticket],
    receipts: [],
    expired_tickets: [],
  };
}

async function withProbeLock(paths, callback) {
  if (!(await validateGovernedRuntimeAncestor(paths))) {
    throw new Error('APE native binding probe runtime is not initialized');
  }
  return withDirLock(paths.bindingProbeLock, callback, {
    staleMs: LOCK_STALE_MS,
    heartbeatMs: LOCK_HEARTBEAT_MS,
    busyMs: LOCK_WAIT_MS,
    serializeLocal: true,
    busyMessage: 'APE native binding probe is busy; retry the probe action',
  });
}

function effectiveStatus(record, at = Date.now()) {
  if (!record) return 'missing';
  if (record.status === 'consumed') return 'consumed';
  if (expired(record.expires_at, at)) return 'expired';
  return record.status;
}

function projectedBindingObservation(value) {
  if (
    !value ||
    typeof value.observed_at !== 'string' ||
    value.observed_at.length > 32 ||
    !Number.isFinite(Date.parse(value.observed_at)) ||
    !['accepted', 'rejected', 'error'].includes(value.outcome) ||
    !/^[a-z][a-z0-9_]{0,63}$/.test(value.code ?? '')
  ) return null;
  return {
    observed_at: value.observed_at,
    outcome: value.outcome,
    code: value.code,
  };
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validTimestamp(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 32) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function validRetiredIdentity(value) {
  return (
    plainObject(value) &&
    bounded(value.session_id) &&
    bounded(value.agent_id) &&
    validTimestamp(value.retired_at)
  );
}

// Version 1 was the 2.24.10 on-disk shape. It carried enough exact native
// identity evidence to fence an already-bound canary, but no production
// StageTicket or turn hash with which the v2 proof can safely continue. Keep a
// strict, bounded reader solely for upgrade quarantine and diagnostics; v1 is
// never accepted as current proof authority.
function validLegacyProbeRecord(record) {
  if (
    !plainObject(record) ||
    record.version !== 1 ||
    !PROBE_ID_PATTERN.test(record.probe_id ?? '') ||
    record.host !== 'codex' ||
    record.agent_type !== 'explorer' ||
    !plainObject(record.model) ||
    !bounded(record.model.model, 256) ||
    (
      record.model.reasoning_effort !== undefined &&
      !bounded(record.model.reasoning_effort, 64)
    ) ||
    !SHA256_PATTERN.test(record.launch_name_hash ?? '') ||
    !PROBE_STATUSES.has(record.status) ||
    !validTimestamp(record.prepared_at) ||
    !validTimestamp(record.expires_at) ||
    Date.parse(record.expires_at) - Date.parse(record.prepared_at) !== PROBE_TTL_MS ||
    !Number.isSafeInteger(record.launch_observations) ||
    record.launch_observations < 0 ||
    !Array.isArray(record.transitions)
  ) return false;

  const expectedTransitionCount = PROBE_TRANSITION_SEQUENCE.indexOf(record.status) + 1;
  const transitionTimestamps = {
    prepared: record.prepared_at,
    launched: record.launched_at,
    bound: record.bound_at,
    completed: record.completed_at,
    consumed: record.consumed_at,
  };
  if (
    record.transitions.length !== expectedTransitionCount ||
    record.transitions.some((transition, index) =>
      !plainObject(transition) ||
      transition.status !== PROBE_TRANSITION_SEQUENCE[index] ||
      !validTimestamp(transition.at) ||
      transition.at !== transitionTimestamps[transition.status] ||
      (index > 0 && Date.parse(transition.at) < Date.parse(record.transitions[index - 1].at))
    )
  ) return false;
  if (record.status === 'prepared') return record.launch_observations === 0;
  if (
    (
      record.binding_agent_type !== undefined &&
      !bounded(record.binding_agent_type)
    ) ||
    !bounded(record.parent_session_id) ||
    !bounded(record.tool_use_id) ||
    !validTimestamp(record.launched_at) ||
    !validTimestamp(record.launch_expires_at) ||
    Date.parse(record.launch_expires_at) > Date.parse(record.expires_at) ||
    record.launch_observations !== 1
  ) return false;
  if (record.status === 'launched') return true;
  if (
    !bounded(record.bound_session_id ?? record.parent_session_id) ||
    !bounded(record.bound_agent_id) ||
    !SHA256_PATTERN.test(record.capability_hash ?? '') ||
    !validTimestamp(record.bound_at) ||
    Date.parse(record.bound_at) < Date.parse(record.launched_at)
  ) return false;
  if (record.status === 'bound') return true;
  if (
    !validTimestamp(record.completed_at) ||
    Date.parse(record.completed_at) < Date.parse(record.bound_at)
  ) return false;
  if (record.status === 'completed') return true;
  return (
    validTimestamp(record.consumed_at) &&
    Date.parse(record.consumed_at) >= Date.parse(record.completed_at)
  );
}

function validProbeBootstrapInvocation(invocation) {
  return plainObject(invocation) && invocation.version === 1 &&
    bounded(invocation.session_id) && bounded(invocation.agent_id) &&
    SHA256_PATTERN.test(invocation.turn_id_hash ?? '') && bounded(invocation.tool_use_id) &&
    Number.isSafeInteger(invocation.launch_generation) && invocation.launch_generation >= 1 &&
    validTimestamp(invocation.admitted_at);
}

function legacyBoundIdentity(record) {
  if (
    !plainObject(record) ||
    record.version !== 1 ||
    record.host !== 'codex' ||
    record.agent_type !== 'explorer' ||
    !PROBE_ID_PATTERN.test(record.probe_id ?? '') ||
    !['bound', 'completed', 'consumed'].includes(record.status) ||
    !bounded(record.bound_session_id ?? record.parent_session_id) ||
    !bounded(record.bound_agent_id) ||
    !validTimestamp(record.bound_at)
  ) return null;
  return {
    session_id: record.bound_session_id ?? record.parent_session_id,
    agent_id: record.bound_agent_id,
    retired_at: record.bound_at,
  };
}

async function quarantineLegacyBoundIdentity(paths, record) {
  const identity = legacyBoundIdentity(record);
  if (!identity) return false;
  await quarantineProbeIdentity(
    paths,
    identity.session_id,
    identity.agent_id,
    identity.retired_at,
  );
  return true;
}

function retiredIdentityMatches(record, sessionId, agentId) {
  return (record?.retired_identities ?? []).some(
    (identity) => identity.session_id === sessionId && identity.agent_id === agentId,
  );
}

function currentIdentityPairMatches(record, sessionId, agentId) {
  return Boolean(
    record &&
    ['bound', 'completed', 'consumed'].includes(record.status) &&
    (record.bound_session_id ?? record.parent_session_id) === sessionId &&
    record.bound_agent_id === agentId
  );
}

function currentIdentityMatches(record, sessionId, agentId) {
  return currentIdentityPairMatches(record, sessionId, agentId);
}

function probeIdentityHash(sessionId, agentId) {
  return digest(JSON.stringify([sessionId, agentId]));
}

function shardedEvidenceFile(root, evidenceHash, label) {
  if (!SHA256_PATTERN.test(evidenceHash ?? '')) {
    throw new Error(`invalid native binding probe ${label} hash`);
  }
  return path.join(root, evidenceHash.slice(0, 2), `${evidenceHash}.json`);
}

function quarantineFile(paths, identityHash, root = paths.bindingProbeQuarantine) {
  if (!SHA256_PATTERN.test(identityHash ?? '')) {
    throw new Error('invalid native binding probe quarantine identity hash');
  }
  return shardedEvidenceFile(root, identityHash, 'quarantine identity');
}

function retiredTurnFile(paths, turnHash) {
  return shardedEvidenceFile(paths.bindingProbeRetiredTurns, turnHash, 'retired turn');
}

function validQuarantineEntry(value, identityHash) {
  return Boolean(
    plainObject(value) &&
    Object.keys(value).length === 3 &&
    value.version === PROBE_QUARANTINE_VERSION &&
    value.identity_hash === identityHash &&
    validTimestamp(value.retired_at)
  );
}

function validRetiredTurnEntry(value, turnHash) {
  return Boolean(
    plainObject(value) &&
    Object.keys(value).length === 3 &&
    value.version === PROBE_RETIRED_TURN_VERSION &&
    value.turn_id_hash === turnHash &&
    validTimestamp(value.retired_at)
  );
}

async function contentAddressedEvidenceState(paths, file, validate) {
  // A missing safe container is a miss. An unsafe ancestor is never evidence
  // about an exact identity, so let callers try the independent ledger.
  if (!(await probeArtifactContainer(paths, file))) return { present: false, valid: false };
  try {
    const existing = await readProbeArtifact(paths, file);
    if (existing === MISSING_PROBE_RECORD) return { present: false, valid: false };
    return { present: true, valid: validate(existing) };
  } catch (error) {
    // The canonical pathname is itself derived from the exact secret-free
    // hash. Corrupt bytes or a wrong-type object at that exact immutable slot
    // remain conservative pair/turn-local evidence; never replace or erase it.
    if (error instanceof SyntaxError) return { present: true, valid: false };
    try {
      await lstat(file);
      return { present: true, valid: false };
    } catch (metadataError) {
      if (metadataError?.code === 'ENOENT') return { present: false, valid: false };
      throw error;
    }
  }
}

async function publishContentAddressedEvidence(paths, file, entry, validate, label) {
  if (!(await probeArtifactContainer(paths, file, { create: true }))) {
    throw new Error('APE native binding probe runtime is not initialized');
  }
  const published = await publishImmutableJson(file, entry);
  if (published) return;
  const existing = await contentAddressedEvidenceState(paths, file, validate);
  if (!existing.present) {
    throw new Error(`native binding probe ${label} disappeared during immutable publication`);
  }
  // A racing valid publisher is reusable. Invalid bytes at the exact slot are
  // still one-way deny evidence, so preserving them is safer than destructive
  // repair and sufficient for the content-addressed fence.
}

function quarantineRoots(paths) {
  // Publish the independent fallback first. A process crash after that point
  // can lose only the compatibility copy, never the sole durable tombstone.
  return [paths.bindingProbeQuarantineFallback, paths.bindingProbeQuarantine];
}

async function quarantineProbeIdentity(paths, sessionId, agentId, retiredAt = iso()) {
  if (!bounded(sessionId) || !bounded(agentId) || !validTimestamp(retiredAt)) {
    throw new Error('native binding probe quarantine requires a bounded exact identity');
  }
  return quarantineProbeHash(paths, probeIdentityHash(sessionId, agentId), retiredAt);
}

async function quarantineProbeHash(paths, identityHash, retiredAt) {
  if (!(await validateGovernedRuntimeAncestor(paths))) {
    throw new Error('APE native binding probe runtime is not initialized');
  }
  if (!SHA256_PATTERN.test(identityHash) || !validTimestamp(retiredAt)) {
    throw new Error('native binding probe quarantine requires a bounded exact hash');
  }
  const entry = {
    version: PROBE_QUARANTINE_VERSION,
    identity_hash: identityHash,
    retired_at: retiredAt,
  };
  const errors = [];
  let durableCopies = 0;
  for (const root of quarantineRoots(paths)) {
    try {
      await publishContentAddressedEvidence(
        paths,
        quarantineFile(paths, identityHash, root),
        entry,
        (value) => validQuarantineEntry(value, identityHash),
        'quarantine evidence',
      );
      durableCopies += 1;
    } catch (error) {
      errors.push(error);
    }
  }
  if (durableCopies === 0) {
    throw new AggregateError(
      errors,
      'native binding probe could not durably quarantine the exact identity',
    );
  }
}

async function quarantinedIdentityMatches(paths, sessionId, agentId) {
  if (!bounded(sessionId) || !bounded(agentId)) return false;
  return quarantinedProbeHashMatches(paths, probeIdentityHash(sessionId, agentId));
}

async function quarantinedProbeHashMatches(paths, identityHash) {
  if (!(await validateGovernedRuntimeAncestor(paths))) return false;
  const errors = [];
  let readableLedgers = 0;
  for (const root of quarantineRoots(paths)) {
    try {
      const state = await contentAddressedEvidenceState(
        paths,
        quarantineFile(paths, identityHash, root),
        (value) => validQuarantineEntry(value, identityHash),
      );
      readableLedgers += 1;
      if (state.present) return true;
    } catch (error) {
      errors.push(error);
    }
  }
  // One readable independent ledger can safely establish an exact miss. A
  // primary directory-wide failure therefore stays neutral for unrelated
  // identities while the fallback remains authoritative for observed pairs.
  if (readableLedgers > 0) return false;
  throw new AggregateError(
    errors,
    'native binding probe quarantine ledgers are unreadable',
  );
}

// These domains can deny only a canary that already authenticated its probe
// bootstrap. Generic SubagentStart evidence never publishes them, and a
// parent session alone is never a key. Reuse the same bounded, immutable,
// independent quarantine ledgers without introducing another authority store.
function nativeProbeChildHash(agentId) {
  return digest(`ape-native-canary-alias-v1:${JSON.stringify(['canary-child-v1', agentId])}`);
}

function nativeProbeTurnHash(parentSessionId, childTurn) {
  return digest(`ape-native-canary-alias-v1:${JSON.stringify(['canary-turn-v1', parentSessionId, childTurn])}`);
}

async function quarantineNativeProbeAliases(paths, candidate, retiredAt = iso()) {
  if (!bounded(candidate?.agent_id)) throw new Error('native canary alias requires an exact child identity');
  await quarantineProbeHash(paths, nativeProbeChildHash(candidate.agent_id), retiredAt);
  if (bounded(candidate.parent_session_id) && bounded(candidate.turn_id)) {
    await quarantineProbeHash(paths, nativeProbeTurnHash(candidate.parent_session_id, candidate.turn_id), retiredAt);
  }
}

async function nativeProbeAliasMatches(paths, input) {
  const sessions = [...new Set([input.session_id, input.sessionId].filter((value) => bounded(value)))];
  const children = [...new Set([...sessions, input.agent_id, input.agentId, input.subagent_id, input.subagentId]
    .filter((value) => bounded(value)))];
  const turns = [...new Set([input.turn_id, input.turnId].filter((value) => bounded(value)))];
  const hashes = [...children.map(nativeProbeChildHash),
    ...sessions.flatMap((session) => turns.map((turn) => nativeProbeTurnHash(session, turn)))];
  const errors = [];
  let readable = 0;
  for (const hash of hashes) {
    try {
      if (await quarantinedProbeHashMatches(paths, hash)) return true;
      readable += 1;
    } catch (error) { errors.push(error); }
  }
  if (readable > 0 || hashes.length === 0) return false;
  throw new AggregateError(errors, 'native binding probe alias ledgers are unreadable');
}

function currentNativeProbeAlias(record, input) {
  if (record?.bootstrap_protocol !== 1 || !['bound', 'completed', 'consumed'].includes(record.status)) return null;
  const invocation = record.bootstrap_invocation;
  const sessions = [input.session_id, input.sessionId];
  const children = [...sessions, input.agent_id, input.agentId, input.subagent_id, input.subagentId];
  const turn = [input.turn_id, input.turnId].find((value) => bounded(value) && digest(value) === invocation.turn_id_hash);
  if (!children.includes(record.bound_agent_id) &&
      !(turn && sessions.includes(record.bound_session_id))) return null;
  return {
    agent_id: record.bound_agent_id,
    parent_session_id: record.bound_session_id,
    ...(turn ? { turn_id: turn } : {}),
  };
}

async function retireProbeLaunchTurn(paths, record, retiredAt) {
  if (
    !record ||
    record.bootstrap_protocol === 1 ||
    !['launched', 'bound', 'completed', 'consumed'].includes(record.status) ||
    !SHA256_PATTERN.test(record.launch_turn_id_hash ?? '') ||
    !validTimestamp(retiredAt)
  ) return;
  if (!(await validateGovernedRuntimeAncestor(paths))) {
    throw new Error('APE native binding probe runtime is not initialized');
  }
  const turnHash = record.launch_turn_id_hash;
  await publishContentAddressedEvidence(
    paths,
    retiredTurnFile(paths, turnHash),
    {
      version: PROBE_RETIRED_TURN_VERSION,
      turn_id_hash: turnHash,
      retired_at: retiredAt,
    },
    (value) => validRetiredTurnEntry(value, turnHash),
    'retired launch-turn evidence',
  );
}

async function retiredProbeTurnMatches(paths, turnId) {
  if (!bounded(turnId)) return false;
  if (!(await validateGovernedRuntimeAncestor(paths))) return false;
  const turnHash = digest(turnId);
  const state = await contentAddressedEvidenceState(
    paths,
    retiredTurnFile(paths, turnHash),
    (value) => validRetiredTurnEntry(value, turnHash),
  );
  return state.present;
}

async function quarantineIdentitiesForReplacement(paths, record, retiredAt) {
  if (!record) return;
  // Retire correlation before replacing the only mutable record that names the
  // launched turn. Publication failure aborts replacement and preserves it.
  await retireProbeLaunchTurn(paths, record, retiredAt);
  for (const identity of record.retired_identities ?? []) {
    await quarantineProbeIdentity(
      paths,
      identity.session_id,
      identity.agent_id,
      identity.retired_at,
    );
  }
  if (['bound', 'completed', 'consumed'].includes(record.status)) {
    // Upgrade a pre-alias protocol-1 snapshot before replacing the only
    // projection that still names its native child UUID. No plaintext child
    // turn survives in that snapshot, so never invent a parent-turn alias.
    if (record.bootstrap_protocol === 1 && validPersistedProbeRecord(record)) {
      await quarantineNativeProbeAliases(paths, { agent_id: record.bound_agent_id }, retiredAt);
    }
    await quarantineProbeIdentity(
      paths,
      record.bound_session_id ?? record.parent_session_id,
      record.bound_agent_id,
      retiredAt,
    );
  }
}

// binding-probe.json is hook authority, not an advisory cache. A JSON value
// can parse successfully while still being torn or attacker-shaped (`{}` was
// the original fail-open): validate the complete state machine shape before a
// lifecycle event is allowed to interpret absence/non-match. The projection
// deliberately remains separate so corrupt state cannot be reflected back as
// an unbounded diagnostic.
function validPersistedProbeRecord(record) {
  if (
    !plainObject(record) ||
    !(
      (record.version === 2 && record.bootstrap_protocol === undefined) ||
      (record.version === 3 && record.bootstrap_protocol === 1 &&
        SHA256_PATTERN.test(record.bootstrap_capability_hash ?? ''))
    ) ||
    !validProbeTicketId(record.probe_id, record.ticket_id) ||
    record.host !== 'codex' ||
    record.agent_type !== 'explorer' ||
    !plainObject(record.model) ||
    !bounded(record.model.model, 256) ||
    (
      record.model.reasoning_effort !== undefined &&
      !bounded(record.model.reasoning_effort, 64)
    ) ||
    !SHA256_PATTERN.test(record.ticket_hash ?? '') ||
    !SHA256_PATTERN.test(record.launch_name_hash ?? '') ||
    !PROBE_STATUSES.has(record.status) ||
    !validTimestamp(record.prepared_at) ||
    !validTimestamp(record.expires_at) ||
    Date.parse(record.expires_at) - Date.parse(record.prepared_at) !== PROBE_TTL_MS ||
    !Number.isSafeInteger(record.launch_observations) ||
    record.launch_observations < 0 ||
    !Array.isArray(record.transitions) ||
    record.transitions.length < 1 ||
    record.transitions.length > PROBE_STATUSES.size ||
    record.transitions.some((transition) =>
      !plainObject(transition) ||
      !PROBE_STATUSES.has(transition.status) ||
      !validTimestamp(transition.at)) ||
    (
      record.retired_identities !== undefined &&
      (
        !Array.isArray(record.retired_identities) ||
        record.retired_identities.length > MAX_RETIRED_PROBE_IDENTITIES ||
        record.retired_identities.some((identity) => !validRetiredIdentity(identity)) ||
        new Set(record.retired_identities.map(
          (identity) => `${identity.session_id}\u0000${identity.agent_id}`,
        )).size !== record.retired_identities.length
      )
    ) ||
    (
      record.last_binding_observation != null &&
      projectedBindingObservation(record.last_binding_observation) === null
    ) ||
    (
      record.canary_stopped_at !== undefined &&
      (
        !validTimestamp(record.canary_stopped_at) ||
        !['bound', 'completed', 'consumed'].includes(record.status)
      )
    )
  ) return false;

  const expectedTransitionCount = PROBE_TRANSITION_SEQUENCE.indexOf(record.status) + 1;
  const transitionTimestamps = {
    prepared: record.prepared_at,
    launched: record.launched_at,
    bound: record.bound_at,
    completed: record.completed_at,
    consumed: record.consumed_at,
  };
  if (
    record.transitions.length !== expectedTransitionCount ||
    record.transitions.some((transition, index) =>
      transition.status !== PROBE_TRANSITION_SEQUENCE[index] ||
      transition.at !== transitionTimestamps[transition.status]) ||
    record.transitions.some((transition, index) =>
      (index > 0 && Date.parse(transition.at) < Date.parse(record.transitions[index - 1].at)) ||
      Date.parse(transition.at) > Date.parse(record.expires_at)
    )) return false;

  if (record.status === 'prepared') return record.launch_observations === 0;
  if (
    !bounded(record.binding_agent_type) ||
    !bounded(record.parent_session_id) ||
    !bounded(record.tool_use_id) ||
    !validTimestamp(record.launched_at) ||
    !validTimestamp(record.launch_expires_at) ||
    Date.parse(record.launch_expires_at) < Date.parse(record.launched_at) ||
    Date.parse(record.launch_expires_at) > Date.parse(record.expires_at) ||
    record.launch_observations !== 1 ||
    !SHA256_PATTERN.test(record.launch_turn_id_hash ?? '')
  ) return false;
  if (record.status === 'launched') return true;
  if (record.bootstrap_protocol === 1 && (
    !validProbeBootstrapInvocation(record.bootstrap_invocation) ||
    record.bootstrap_invocation.session_id !== record.bound_session_id ||
    record.bootstrap_invocation.agent_id !== record.bound_agent_id
  )) return false;
  if (
    !bounded(record.bound_session_id) ||
    !bounded(record.bound_agent_id) ||
    !SHA256_PATTERN.test(record.capability_hash ?? '') ||
    !validTimestamp(record.bound_at) ||
    Date.parse(record.bound_at) < Date.parse(record.launched_at)
  ) return false;
  if (
    record.canary_stopped_at &&
    Date.parse(record.canary_stopped_at) < Date.parse(record.bound_at)
  ) return false;
  const bindingObservation = projectedBindingObservation(record.last_binding_observation);
  if (
    bindingObservation?.outcome !== 'accepted' ||
    !['bound', 'resumed'].includes(bindingObservation.code)
  ) return false;
  if (record.status === 'bound') return true;
  if (
    !validTimestamp(record.completed_at) ||
    Date.parse(record.completed_at) < Date.parse(record.bound_at)
  ) return false;
  if (record.status === 'completed') return true;
  return (
    validTimestamp(record.consumed_at) &&
    Date.parse(record.consumed_at) >= Date.parse(record.completed_at)
  );
}

function assertValidPersistedProbeRecord(record) {
  if (!validPersistedProbeRecord(record)) {
    throw new Error('native binding probe state is structurally invalid');
  }
  return record;
}

async function readPersistedProbeRecord(paths) {
  const record = await readRawProbeRecord(paths);
  if (record === MISSING_PROBE_RECORD) return null;
  return assertValidPersistedProbeRecord(record);
}

async function readRawProbeRecord(paths) {
  return readProbeArtifact(paths, paths.bindingProbe);
}

// Capability-free diagnostics. The status is intentionally infrastructure
// language rather than stage language: nothing here is a run or attempt.
export function projectBindingProbe(record, at = Date.now()) {
  const status = effectiveStatus(record, at);
  let infrastructure_status = {
    missing: 'required',
    prepared: 'awaiting_launch',
    launched: 'awaiting_binding',
    bound: 'awaiting_acknowledgement',
    completed: 'ready',
    consumed: 'consumed',
    expired: 'failed',
  }[status] ?? 'failed';
  if (!record) {
    return {
      status,
      infrastructure_status,
      attempts_consumed: 0,
      reason: 'no native binding probe has been prepared',
    };
  }
  const bindingObservation = projectedBindingObservation(record.last_binding_observation);
  const launchExpired = status === 'launched' && expired(record.launch_expires_at, at);
  const bindingRejected = status === 'launched' &&
    ['rejected', 'error'].includes(bindingObservation?.outcome);
  if (launchExpired || bindingRejected) infrastructure_status = 'failed';
  const projectedModel = plainObject(record.model)
    ? {
        ...(bounded(record.model.model, 256) ? { model: record.model.model } : {}),
        ...(bounded(record.model.reasoning_effort, 64)
          ? { reasoning_effort: record.model.reasoning_effort }
          : {}),
      }
    : {};
  const projectedTransitions = Array.isArray(record.transitions)
    ? record.transitions.slice(0, PROBE_STATUSES.size)
      .filter((transition) =>
        plainObject(transition) &&
        PROBE_STATUSES.has(transition.status) &&
        validTimestamp(transition.at))
      .map((transition) => ({ status: transition.status, at: transition.at }))
    : [];
  return {
    probe_id: record.probe_id,
    host: record.host,
    agent_type: record.agent_type,
    model: projectedModel,
    status,
    infrastructure_status,
    attempts_consumed: 0,
    launch_observations: record.launch_observations ?? 0,
    prepared_at: validTimestamp(record.prepared_at) ? record.prepared_at : null,
    launched_at: validTimestamp(record.launched_at) ? record.launched_at : null,
    bound_at: validTimestamp(record.bound_at) ? record.bound_at : null,
    completed_at: validTimestamp(record.completed_at) ? record.completed_at : null,
    consumed_at: validTimestamp(record.consumed_at) ? record.consumed_at : null,
    launch_expires_at: validTimestamp(record.launch_expires_at) ? record.launch_expires_at : null,
    expires_at: validTimestamp(record.expires_at) ? record.expires_at : null,
    transitions: projectedTransitions,
    ...(bindingObservation
      ? { binding_observation: bindingObservation }
      : {}),
    ...(status === 'expired'
      ? { reason: 'native binding diagnostic expired before acknowledgement' }
      : launchExpired
        ? { reason: 'native binding probe launch window expired before authenticated binding; wait for the probe reservation to expire before preparing a fresh probe' }
        : bindingRejected
          ? { reason: 'native binding bootstrap was rejected; inspect binding_observation before further action' }
      : {}),
  };
}

export async function bindingProbeStatus(paths, { readOnly = false } = {}) {
  const rawRecord = await readRawProbeRecord(paths);
  const legacyIdentity = legacyBoundIdentity(rawRecord);
  if (legacyIdentity) {
    if (!readOnly) await quarantineLegacyBoundIdentity(paths, rawRecord);
    return {
      ...projectBindingProbe(rawRecord),
      infrastructure_status: 'failed',
      reason: 'legacy native binding probe cannot satisfy the production-path proof; prepare a fresh probe',
    };
  }
  if (validLegacyProbeRecord(rawRecord)) {
    return {
      ...projectBindingProbe(rawRecord),
      infrastructure_status: 'failed',
      reason: rawRecord.status === 'launched' && !expired(rawRecord.expires_at)
        ? 'legacy native binding probe launch is still live; wait for its bounded expiry, then prepare a fresh probe'
        : 'legacy native binding probe cannot satisfy the production-path proof; prepare a fresh probe',
    };
  }
  const record = rawRecord === MISSING_PROBE_RECORD
    ? null
    : assertValidPersistedProbeRecord(rawRecord);
  const projected = projectBindingProbe(record);
  const requiresLiveEvidence = Boolean(
    record &&
    !['missing', 'expired', 'consumed'].includes(projected.status)
  );
  if (requiresLiveEvidence && !(await readProbeTicket(paths, record))) {
    return {
      ...projected,
      infrastructure_status: 'failed',
      reason: 'authoritative native binding probe ticket unavailable; prepare a fresh probe',
    };
  }
  if (requiresLiveEvidence && !(await corroboratesCodexProbeLifecycle(paths, record))) {
    return {
      ...projected,
      infrastructure_status: 'failed',
      reason: `production binding intent does not corroborate the ${record.status} native probe; prepare a fresh probe`,
    };
  }
  return projected;
}

export async function prepareBindingProbe(paths, { host, model, bootstrap_protocol = 1 }) {
  if (host !== 'codex') throw new Error('native binding probe currently supports host codex only');
  if (!model || !bounded(model.model, 256)) throw new Error('native binding probe requires a resolved model');
  if (![0, 1].includes(bootstrap_protocol)) throw new Error('unsupported native binding probe bootstrap protocol');
  const probe_id = `probe-${randomUUID()}`;
  const preparedAt = Date.now();
  const preparedAtIso = iso(preparedAt);
  const expiresAt = iso(preparedAt + PROBE_TTL_MS);
  const ticket = makeProbeTicket(probe_id, model, preparedAtIso, expiresAt);
  let preparedAgentName = null;
  let bootstrapCapability = null;
  const record = await withProbeLock(paths, async () => {
    let current = null;
    try {
      const existing = await readRawProbeRecord(paths);
      current = existing === MISSING_PROBE_RECORD ? null : existing;
    } catch (error) {
      // An explicit new prepare is the recovery action for syntactically torn
      // probe state. Other I/O failures retain their ordinary error.
      if (!(error instanceof SyntaxError)) throw error;
    }
    const currentIsLegacy = validLegacyProbeRecord(current);
    if (
      currentIsLegacy &&
      current.status === 'launched' &&
      !expired(current.expires_at)
    ) {
      throw new Error(
        'legacy native binding probe launch is still live; wait for its bounded expiry before preparing a fresh probe',
      );
    }
    // v1 proof cannot be promoted—the authoritative ticket/turn evidence did
    // not exist yet—but an exact bound task remains resumable even when a v1
    // operation crossed its TTL write boundary. Retire any bounded historical
    // identity before v2 replaces the only legacy reference.
    await quarantineLegacyBoundIdentity(paths, current);
    const currentIsValid = validPersistedProbeRecord(current);
    const currentIsLiveReservation = Boolean(
      currentIsValid &&
      !expired(current.expires_at) &&
      PROBE_REPLACEMENT_BLOCKING_STATUSES.has(current.status)
    );
    const currentTicket = currentIsLiveReservation
      ? await readProbeTicket(paths, current)
      : null;
    const currentEvidenceValid = Boolean(
      currentTicket && await corroboratesCodexProbeLifecycle(paths, current)
    );
    if (currentIsLiveReservation && current.status === 'prepared' && currentEvidenceValid) {
      if ((current.bootstrap_protocol ?? 0) !== bootstrap_protocol) {
        throw new Error('native binding probe uses an older bootstrap protocol; wait for its bounded expiry before preparing a fresh probe');
      }
      const replay = await prepareCodexIntent(paths, currentTicket, 'explorer', {
        codex_task_namespace: 'probe',
        allow_prepared_replay: true,
        ...(bootstrap_protocol === 1 ? { bootstrap_protocol: 1 } : {}),
      });
      if (digest(replay.agent_name) !== current.launch_name_hash) {
        throw new Error('native binding probe replay did not reproduce its durable launch authority');
      }
      preparedAgentName = replay.agent_name;
      if (bootstrap_protocol === 1) {
        if (!CAPABILITY_PATTERN.test(replay.bootstrap_capability ?? '') ||
            digest(replay.bootstrap_capability) !== current.bootstrap_capability_hash) {
          throw new Error('native binding probe replay did not reproduce its durable bootstrap authority');
        }
        bootstrapCapability = replay.bootstrap_capability;
      }
      return current;
    }
    if (currentIsLiveReservation && currentEvidenceValid) {
      throw new Error(
        `native binding probe is already ${current.status}; finish it or wait for its bounded expiry before preparing another`,
      );
    }
    if (currentIsValid) {
      await quarantineIdentitiesForReplacement(paths, current, preparedAtIso);
    }
    const ticketFile = probeTicketPath(paths, probe_id, ticket.ticket_id);
    await probeArtifactContainer(paths, ticketFile, { create: true });
    await atomicWriteJson(ticketFile, ticket);
    const intent = await prepareCodexIntent(paths, ticket, 'explorer', {
      codex_task_namespace: 'probe',
      ...(bootstrap_protocol === 1 ? { bootstrap_protocol: 1 } : {}),
    });
    preparedAgentName = intent.agent_name;
    if (bootstrap_protocol === 1) {
      if (!CAPABILITY_PATTERN.test(intent.bootstrap_capability ?? '')) {
        throw new Error('native binding probe preparation returned no bounded bootstrap authority');
      }
      bootstrapCapability = intent.bootstrap_capability;
    }
    const prepared = {
      version: bootstrap_protocol === 1 ? 3 : 2,
      ...(bootstrap_protocol === 1
        ? { bootstrap_protocol: 1, bootstrap_capability_hash: digest(bootstrapCapability) }
        : {}),
      probe_id,
      host,
      agent_type: 'explorer',
      model,
      ticket_id: ticket.ticket_id,
      ticket_hash: ticket.ticket_hash,
      launch_name_hash: digest(intent.agent_name),
      status: 'prepared',
      prepared_at: preparedAtIso,
      expires_at: expiresAt,
      launch_observations: 0,
      retired_identities: [],
      transitions: [{ status: 'prepared', at: preparedAtIso }],
    };
    await atomicWriteJson(paths.bindingProbe, prepared);
    return prepared;
  });
  const prompt = record.bootstrap_protocol === 1 ? [
    'APE native binding infrastructure probe bootstrap protocol 1.',
    '1. Execute this assigned bootstrap now. Before binding, authoritative ticket/receipt/probe context is expected to be absent. Do not stop for that absence. Tool discovery and ape_bind are permitted bootstrap operations, not stage work.',
    'If that tool is not visible, you may first make at most one bounded host tool-catalog search (such as tool_search.tool_search_tool) using only the literal registered tool name ape_bind, not a host-qualified invocation alias. Never include the bootstrap capability, project path, or task data in the search.',
    'If the host exposes tools through functions.exec, that wrapper is permitted only to inspect exact-matching ALL_TOOLS metadata for ape_bind or invoke that one installed tool. This does not permit functions.exec_command, shell commands, or executing APE through a shell.',
    'Do not inspect or modify the project, access files, do stage work, or call any other MCP tool. If the exact installed tool cannot be found, stop.',
    '2. Your first APE operation must be the installed ape_bind tool, called exactly once with the exact arguments below. Invoke the returned namespace/function from the installed APE server (currently mcp__ape.ape_bind; normalized alias mcp__ape__ape_bind), never a similarly named tool from another plugin.',
    JSON.stringify({ project_dir: paths.root, bootstrap_capability: bootstrapCapability }),
    '3. Only AFTER ape_bind returns, check for the complete authenticated hook context containing APE_PROBE_CAPABILITY and the exact final acknowledgement JSON. If missing then, stop without acknowledgement.',
    'Do not call any tools after ape_bind, including tool discovery. No other tools are permitted.',
    'Return only that injected acknowledgement.',
    `APE_BINDING_PROBE_ID=${record.probe_id}`,
  ].join('\n') : [
    'Execute the APE native binding infrastructure probe.',
    'Do not call tools and do not inspect or modify the project.',
    'After SubagentStart injects APE_PROBE_CAPABILITY, return only the JSON object requested there.',
    `APE_BINDING_PROBE_ID=${record.probe_id}`,
  ].join('\n');
  const spawnArgs = {
    task_name: preparedAgentName,
    fork_turns: 'none',
    message: prompt,
    model: record.model.model,
    ...(record.model.reasoning_effort
      ? { reasoning_effort: record.model.reasoning_effort }
      : {}),
  };
  return {
    type: 'dispatch_probe',
    probe: projectBindingProbe(record),
    dispatch: {
      host,
      native_tool: 'spawn_agent',
      ...(record.bootstrap_protocol === 1 ? {
        bootstrap_protocol: 1,
        bootstrap_args: { project_dir: paths.root, bootstrap_capability: bootstrapCapability },
      } : {}),
      agent_name: preparedAgentName,
      agent_type: record.agent_type,
      model: record.model,
      message: prompt,
      spawn_args: spawnArgs,
    },
  };
}

export function isBindingProbeTaskName(taskName) {
  return typeof taskName === 'string' && PROBE_TASK_NAME_PATTERN.test(taskName);
}

export async function launchBindingProbe(paths, input) {
  const toolInput =
    input.tool_input ?? input.toolInput ?? input.input ?? input.toolCall?.args ?? {};
  const taskName = toolInput.task_name ?? toolInput.taskName;
  const forkTurns = toolInput.fork_turns ?? toolInput.forkTurns;
  const sessionId = input.session_id ?? input.sessionId;
  const toolUseId = input.tool_use_id ?? input.toolUseId;
  const turnId = input.turn_id ?? input.turnId;
  const suppliedAgentType =
    toolInput.subagent_type ?? toolInput.subagentType ?? toolInput.agent_type ?? toolInput.agentType;
  // Multi-Agent V2's collaboration.spawn_agent schema does not expose an
  // agent_type field. Its SubagentStart event reports the host-effective
  // `default` role, so persist that separately from the probe's logical
  // explorer role. A launch shape that does supply a type must still match the
  // logical role exactly.
  if (
    !isBindingProbeTaskName(taskName) ||
    !bounded(sessionId) ||
    !bounded(toolUseId) ||
    !bounded(turnId) ||
    (suppliedAgentType !== undefined && suppliedAgentType !== null && !bounded(suppliedAgentType))
  ) {
    return { valid: false, reason: 'APE binding probe launch denied: malformed or missing probe capability' };
  }
  if (forkTurns !== 'none') {
    return {
      valid: false,
      reason: "APE binding probe launch denied: fork_turns must be exactly 'none'; pass dispatch.spawn_args unchanged",
    };
  }
  return withProbeLock(paths, async () => {
    const record = await readPersistedProbeRecord(paths);
    if (!record || record.launch_name_hash !== digest(taskName)) {
      return { valid: false, reason: 'APE binding probe launch denied: probe capability mismatch' };
    }
    if (expired(record.expires_at)) {
      return { valid: false, reason: 'APE binding probe launch denied: probe expired' };
    }
    if (!['prepared', 'launched'].includes(record.status)) {
      return { valid: false, reason: `APE binding probe launch denied: probe is ${record.status}` };
    }
    const ticket = await readProbeTicket(paths, record);
    if (!ticket) {
      return { valid: false, reason: 'APE binding probe launch denied: authoritative probe ticket unavailable' };
    }
    // Deliberately delegate to the production launcher. The task-name nonce,
    // model/effort match, unique intent lookup, pending-ticket check, replay
    // protection, and launch deadline are therefore the same checks a real
    // StageTicket receives rather than a probe-only approximation.
    let launch;
    try {
      launch = await launchCodexIntent(paths, probeBindingState(record, ticket), input);
    } catch {
      return {
        valid: false,
        reason: 'APE binding probe launch denied: production launch validation failed',
      };
    }
    if (!launch.valid) return launch;
    const launchedAt = Date.now();
    if (expired(record.expires_at, launchedAt)) {
      return { valid: false, reason: 'APE binding probe launch denied: probe expired during validation' };
    }
    if (record.status === 'launched') return launch;
    const launchedAtIso = iso(launchedAt);
    await atomicWriteJson(paths.bindingProbe, {
      ...record,
      status: 'launched',
      binding_agent_type: suppliedAgentType ?? CODEX_V2_DEFAULT_AGENT_TYPE,
      parent_session_id: sessionId,
      tool_use_id: toolUseId,
      launched_at: launchedAtIso,
      launch_expires_at: iso(Math.min(Date.parse(record.expires_at), launchedAt + LAUNCH_TTL_MS)),
      launch_turn_id_hash: digest(turnId),
      launch_observations: (record.launch_observations ?? 0) + 1,
      transitions: [...(record.transitions ?? []), { status: 'launched', at: launchedAtIso }],
    });
    return launch;
  });
}

export async function bindBindingProbe(paths, input) {
  // Ordinary projects with no APE runtime are neutral and remain untouched.
  // Unsafe ancestors throw before the directory lock can follow their link.
  if (!(await validateGovernedRuntimeAncestor(paths))) return { matched: false };
  return withProbeLock(paths, async () => {
    const sessionId = input.session_id ?? input.sessionId;
    const agentId = input.agent_id ?? input.agentId ?? input.subagent_id ?? input.subagentId;
    const turnId = input.turn_id ?? input.turnId;
    let quarantineMatch = false;
    try {
      quarantineMatch = bounded(sessionId) && bounded(agentId) &&
        await quarantinedIdentityMatches(paths, sessionId, agentId);
    } catch {
      // A lookup outage must not run ahead of the authoritative probe-state
      // read. If this start belongs to the probe, the paths below first publish
      // the exact observed pair to every usable quarantine ledger, then deny.
    }
    let rawRecord;
    try {
      rawRecord = await readRawProbeRecord(paths);
    } catch (error) {
      // A corrupt projection may be the only surviving evidence that this
      // SubagentStart belongs to a launched canary. Codex cannot cancel the
      // child at this boundary, so fence the exact observed pair before
      // surfacing the validation error.
      if (bounded(sessionId) && bounded(agentId)) {
        await quarantineProbeIdentity(paths, sessionId, agentId);
      }
      throw error;
    }
    // Protocol 1 assigns authority only at the child's exact bootstrap call.
    // SubagentStart provides provisional identity evidence, not a launch name
    // or parent-tool correlation. In particular, a shared parent turn cannot
    // identify either a current canary or a retired physical launch.
    if (rawRecord?.version >= 3 || rawRecord?.bootstrap_protocol !== undefined) {
      if (quarantineMatch) {
        return { matched: true, valid: false, reason: 'APE binding probe binding denied: canary identity is retired' };
      }
      if (!validPersistedProbeRecord(rawRecord)) return { matched: false };
      if (expired(rawRecord.expires_at) || !PROBE_RESERVATION_STATUSES.has(rawRecord.status)) {
        return { matched: false };
      }
      const observed = await recordCodexBootstrapCandidate(paths, input);
      return {
        matched: true,
        valid: observed.recorded === true,
        bootstrap_required: true,
        ...(observed.recorded === true ? { additional_context: codexBootstrapOrientation() } : {}),
        reason: observed.recorded
          ? 'APE native probe child observed; ape_bind is required before acknowledgement'
          : 'APE native probe bootstrap denied: complete native child identity and model evidence is required',
      };
    }
    let retiredTurnMatch = false;
    try {
      retiredTurnMatch = await retiredProbeTurnMatches(paths, turnId);
    } catch {
      // Legacy turn evidence never acquires directory-wide authority.
    }
    if (retiredTurnMatch) {
      if (bounded(sessionId) && bounded(agentId)) {
        await quarantineProbeIdentity(paths, sessionId, agentId);
      }
      return {
        matched: true,
        valid: false,
        reason: 'APE binding probe binding denied: native child belongs to a retired probe launch turn',
      };
    }
    const upgradeIdentity = legacyBoundIdentity(rawRecord);
    if (
      upgradeIdentity?.session_id === sessionId &&
      upgradeIdentity.agent_id === agentId
    ) {
      await quarantineLegacyBoundIdentity(paths, rawRecord);
      return {
        matched: true,
        valid: false,
        reason: 'APE binding probe binding denied: legacy canary identity is retired',
      };
    }
    if (
      rawRecord !== MISSING_PROBE_RECORD &&
      !validLegacyProbeRecord(rawRecord) &&
      !validPersistedProbeRecord(rawRecord) &&
      bounded(sessionId) &&
      bounded(agentId)
    ) {
      await quarantineProbeIdentity(paths, sessionId, agentId);
    }
    if (validLegacyProbeRecord(rawRecord)) {
      const identity = legacyBoundIdentity(rawRecord);
      const exactLegacyIdentity = Boolean(
        identity &&
        identity.session_id === sessionId &&
        identity.agent_id === agentId
      );
      if (exactLegacyIdentity) await quarantineLegacyBoundIdentity(paths, rawRecord);
      if (
        !exactLegacyIdentity &&
        bounded(sessionId) &&
        bounded(agentId) &&
        !expired(rawRecord.expires_at) &&
        PROBE_RESERVATION_STATUSES.has(rawRecord.status)
      ) {
        await quarantineProbeIdentity(paths, sessionId, agentId);
      }
      if (
        exactLegacyIdentity ||
        (
          !expired(rawRecord.expires_at) &&
          PROBE_RESERVATION_STATUSES.has(rawRecord.status)
        )
      ) {
        return {
          matched: true,
          valid: false,
          reason: exactLegacyIdentity
            ? 'APE binding probe binding denied: legacy canary identity is retired'
            : 'APE binding probe binding denied: legacy probe must be replaced with a fresh production-path proof',
        };
      }
      return quarantineMatch
        ? {
            matched: true,
            valid: false,
            reason: 'APE binding probe binding denied: canary identity is retired',
          }
        : { matched: false };
    }
    const record = rawRecord === MISSING_PROBE_RECORD
      ? null
      : assertValidPersistedProbeRecord(rawRecord);
    if (!record) {
      return quarantineMatch
        ? {
            matched: true,
            valid: false,
            reason: 'APE binding probe binding denied: canary identity is retired',
          }
        : { matched: false };
    }
    // Codex cannot cancel a child from SubagentStart, so every bounded native
    // identity observed while the probe owns the pre-run child window must be
    // fenced durably before any correlation or production-binder decision.
    // Otherwise a rejected wrong-turn/stray child can resume after this probe
    // is consumed or replaced, when the monolithic record no longer names it.
    if (
      bounded(sessionId) &&
      bounded(agentId) &&
      !expired(record.expires_at) &&
      PROBE_RESERVATION_STATUSES.has(record.status)
    ) {
      await quarantineProbeIdentity(paths, sessionId, agentId);
    }
    const retiredMatch =
      bounded(sessionId) && bounded(agentId) &&
      retiredIdentityMatches(record, sessionId, agentId);
    const currentMatch =
      bounded(sessionId) && bounded(agentId) &&
      currentIdentityPairMatches(record, sessionId, agentId);
    if (currentMatch || retiredMatch) {
      const retiredIdentity = retiredMatch
        ? record.retired_identities.find(
            (identity) => identity.session_id === sessionId && identity.agent_id === agentId,
          )
        : null;
      await quarantineProbeIdentity(
        paths,
        sessionId,
        agentId,
        retiredIdentity?.retired_at ?? record.bound_at ?? iso(),
      );
    }
    const liveCurrentResume =
      currentMatch &&
      record.status === 'bound' &&
      !record.canary_stopped_at &&
      !expired(record.expires_at);
    if (quarantineMatch && !liveCurrentResume) {
      return {
        matched: true,
        valid: false,
        reason: 'APE binding probe binding denied: canary identity is retired',
      };
    }
    if (currentMatch && record.status === 'consumed') {
      return {
        matched: true,
        valid: false,
        reason: 'APE binding probe binding denied: probe is consumed',
      };
    }
    if (
      retiredMatch ||
      (currentMatch && (record.status !== 'bound' || expired(record.expires_at)))
    ) {
      return {
        matched: true,
        valid: false,
        reason: 'APE binding probe binding denied: canary identity is retired',
      };
    }
    if (expired(record.expires_at)) {
      if (record.status !== 'launched') return { matched: false };
      const agentType = input.agent_type ?? input.agentType;
      const correlated =
        bounded(sessionId) &&
        bounded(agentId) &&
        bounded(turnId) &&
        record.launch_turn_id_hash === digest(turnId) &&
        bindingAgentTypeMatches(record, agentType);
      if (!correlated) return { matched: false };
      const retiredAt = iso();
      await quarantineProbeIdentity(paths, sessionId, agentId, retiredAt);
      return {
        matched: true,
        valid: false,
        reason: 'APE binding probe binding denied: launched probe expired before native identity binding',
      };
    }
    if (record.status === 'consumed') {
      return { matched: false };
    }
    // While an explicit pre-run probe owns a live reservation, every Codex
    // SubagentStart belongs to that diagnostic window. Falling through here
    // would let an older/replayed canary evade the identity fence after state
    // replacement or let an unrelated child masquerade as "no probe".
    if (!['launched', 'bound'].includes(record.status)) {
      return {
        matched: true,
        valid: false,
        reason: `APE binding probe binding denied: probe is ${record.status}`,
      };
    }
    if (record.status === 'launched') {
      if (!bounded(turnId) || record.launch_turn_id_hash !== digest(turnId)) {
        const observation = {
          observed_at: iso(),
          outcome: 'rejected',
          code: 'turn_id_mismatch',
        };
        await atomicWriteJson(paths.bindingProbe, {
          ...record,
          last_binding_observation: observation,
        });
        return {
          matched: true,
          valid: false,
          reason: 'APE binding probe binding denied: native child turn does not match the authorized launch',
        };
      }
    }
    const ticket = await readProbeTicket(paths, record);
    if (!ticket) {
      return {
        matched: true,
        valid: false,
        reason: 'APE binding probe binding denied: authoritative probe ticket unavailable',
      };
    }
    // This is the production binder, operating over the same persisted intent
    // and hash-bound ticket shape as a real worker. The probe-specific work
    // below only projects its result and tells the canary how to acknowledge it.
    let binding;
    try {
      binding = await bindCodexSubagent(paths, probeBindingState(record, ticket), input);
    } catch {
      const observation = {
        observed_at: iso(),
        outcome: 'error',
        code: 'production_binding_exception',
      };
      if (record.status !== 'bound') {
        await atomicWriteJson(paths.bindingProbe, {
          ...record,
          last_binding_observation: observation,
        }).catch(() => {});
      }
      return {
        matched: true,
        valid: false,
        reason: 'APE binding probe binding denied: production binding validation failed',
      };
    }
    if (!binding.valid) {
      // Once the production binder has accepted an exact identity, that
      // observation is durable proof and the canary fence depends on the
      // record remaining structurally readable. A stray/mismatched resume is
      // denied, but must not replace the accepted observation with a rejection
      // and corrupt the already-bound state machine.
      if (record.status !== 'bound') {
        const rejected = {
          ...record,
          last_binding_observation: binding.binding_observation ?? null,
        };
        await atomicWriteJson(paths.bindingProbe, rejected);
      }
      return { matched: true, ...binding };
    }
    const capability = binding.additional_context
      ?.match(/(?:^|\n)APE_RECEIPT_CAPABILITY=([A-Za-z0-9_-]{32,256})(?:\n|$)/)?.[1];
    if (!CAPABILITY_PATTERN.test(capability ?? '')) {
      return {
        matched: true,
        valid: false,
        reason: 'APE binding probe binding denied: production binder returned no bounded capability',
      };
    }
    const alreadyBound = record.status === 'bound';
    const bindingDecidedAt = Date.now();
    if (expired(record.expires_at, bindingDecidedAt)) {
      const retiredAt = iso(bindingDecidedAt);
      await quarantineProbeIdentity(paths, sessionId, agentId, retiredAt);
      await atomicWriteJson(paths.bindingProbe, {
        ...record,
        last_binding_observation: binding.binding_observation ?? null,
      });
      return {
        matched: true,
        valid: false,
        reason: 'APE binding probe binding denied: probe expired during production binding validation',
      };
    }
    const boundAt = alreadyBound ? record.bound_at : iso(bindingDecidedAt);
    // Publish the one-way identity tombstone before the readable bound record.
    // If binding-probe.json later tears, the wildcard canary hook can still
    // deny this exact resumable task without failing closed on unrelated tools.
    await quarantineProbeIdentity(paths, sessionId, agentId, boundAt);
    const { canary_stopped_at: _stoppedAt, ...activeRecord } = record;
    await atomicWriteJson(paths.bindingProbe, {
      ...activeRecord,
      status: 'bound',
      bound_session_id: sessionId,
      bound_agent_id: agentId,
      capability_hash: digest(capability),
      bound_at: boundAt,
      last_binding_observation: binding.binding_observation ?? null,
      transitions: alreadyBound
        ? record.transitions
        : [...(record.transitions ?? []), { status: 'bound', at: boundAt }],
    });
    return {
      matched: true,
      valid: true,
      reason: 'APE native identity bound through the production ticket-context path',
      additional_context: [
        binding.additional_context,
        '',
        'APE native binding infrastructure probe (authoritative)',
        'This synthetic ticket verifies delivery only. Do not call tools or perform project work.',
        `APE_BINDING_PROBE_ID=${record.probe_id}`,
        `APE_PROBE_CAPABILITY=${capability}`,
        `Return only {"probe_id":"${record.probe_id}","probe_capability":"${capability}"} as your final response. Do not call tools.`,
      ].join('\n'),
    };
  });
}

function bootstrapToolInput(input) {
  const toolName = input.tool_name ?? input.toolName;
  const toolInput = input.tool_input ?? input.toolInput ?? {};
  return typeof toolName === 'string' && BOOTSTRAP_TOOL_PATTERN.test(toolName) &&
    plainObject(toolInput) && CAPABILITY_PATTERN.test(toolInput.bootstrap_capability ?? '')
    ? toolInput
    : null;
}

function currentProbeBootstrapIntent(record, intent, capability) {
  return Boolean(record?.bootstrap_protocol === 1 &&
    intent?.codex_task_namespace === 'probe' &&
    validProbeTicketId(intent.run_id, intent.ticket_id) &&
    record.probe_id === intent.run_id && record.ticket_id === intent.ticket_id &&
    record.bootstrap_capability_hash === digest(capability) && intent.bootstrap_current);
}

// Caller owns the probe lock. A presented immutable launch token can name
// this diagnostic attempt; provisional native identity alone cannot. Never
// let stale launches or rejected resumes overwrite another generation or
// accepted bound proof. This only records bounded failure, never authority.
async function persistProbeBootstrapRejection(paths, intent, capability, observation) {
  const projected = projectedBindingObservation(observation);
  if (!projected || !['rejected', 'error'].includes(projected.outcome)) return false;
  let currentRecord;
  try {
    currentRecord = await readPersistedProbeRecord(paths);
  } catch {
    return false;
  }
  if (!currentProbeBootstrapIntent(currentRecord, intent, capability) ||
      currentRecord.status !== 'launched') return false;
  return atomicWriteJson(paths.bindingProbe, {
    ...currentRecord,
    last_binding_observation: projected,
  }).then(() => true, () => false);
}

// An early hook identity failure cannot call the binder merely to obtain a
// diagnostic: native evidence could recover between the two checks. This
// path never resolves a candidate, binds a child, fences it, or emits context.
export async function recordBindingProbeBootstrapRejection(paths, input, code) {
  const toolInput = bootstrapToolInput(input);
  if (!['bootstrap_candidate_invalid', 'bootstrap_candidate_unavailable'].includes(code) ||
      !toolInput || !(await validateGovernedRuntimeAncestor(paths))) return { recorded: false };
  return withProbeLock(paths, async () => {
    const intent = await readCodexBootstrapIntent(paths, toolInput.bootstrap_capability);
    const observation = { observed_at: iso(), outcome: 'rejected', code };
    const recorded = await persistProbeBootstrapRejection(
      paths, intent, toolInput.bootstrap_capability, observation,
    );
    return recorded ? { recorded: true, binding_observation: observation } : { recorded: false };
  });
}

// This narrow exception survives the ordinary hook publishing a canary
// tombstone before the wildcard hook observes the SAME first tool call. The
// production intent's persisted invocation is authority, not the MCP body.
export async function isBindingProbeBootstrapInvocation(paths, input) {
  const toolInput = bootstrapToolInput(input);
  if (!toolInput) return false;
  const intent = await readCodexBootstrapIntent(paths, toolInput.bootstrap_capability);
  if (intent?.codex_task_namespace !== 'probe' || !intent.bootstrap_current) return false;
  return isCodexBootstrapReplay(paths, input);
}

export async function bootstrapBindingProbe(paths, input) {
  const toolInput = bootstrapToolInput(input);
  if (!toolInput || !(await validateGovernedRuntimeAncestor(paths))) return { matched: false };
  return withProbeLock(paths, async () => {
    const intent = await readCodexBootstrapIntent(paths, toolInput.bootstrap_capability);
    if (!intent || intent.codex_task_namespace !== 'probe' ||
        !validProbeTicketId(intent.run_id, intent.ticket_id)) return { matched: false };
    const persistRejection = (observation) => persistProbeBootstrapRejection(
      paths, intent, toolInput.bootstrap_capability, observation,
    );
    const deny = async (reason, code, outcome = 'rejected') => {
      const observation = { observed_at: iso(), outcome, code };
      await persistRejection(observation);
      return {
        matched: true,
        valid: false,
        reason: `APE binding probe bootstrap denied: ${reason}`,
        binding_observation: observation,
      };
    };
    let candidate;
    try {
      candidate = await resolveCodexBootstrapCandidate(paths, input);
    } catch {
      return deny('native child identity evidence is unreadable or conflicting', 'bootstrap_candidate_invalid');
    }
    if (!candidate) return deny('native child identity evidence unavailable', 'bootstrap_candidate_unavailable');
    const normalized = {
      ...input,
      session_id: candidate.parent_session_id,
      agent_id: candidate.agent_id,
      agent_type: candidate.agent_type,
      turn_id: candidate.turn_id,
      model: candidate.model,
      is_subagent: true,
    };
    const fenceAuthenticatedCandidate = async () => {
      const generation = intent.matched_generation;
      if (generation && ['authorized', 'launched', 'bound', 'expired', 'orphaned'].includes(generation.status) &&
          validTimestamp(generation.launched_at) &&
          generation.parent_session_id === candidate.parent_session_id) {
        await quarantineProbeIdentity(paths, candidate.parent_session_id, candidate.agent_id);
        await quarantineNativeProbeAliases(paths, candidate);
      }
    };
    let record;
    try {
      record = await readPersistedProbeRecord(paths);
    } catch (error) {
      await fenceAuthenticatedCandidate();
      throw error;
    }
    const current = currentProbeBootstrapIntent(record, intent, toolInput.bootstrap_capability);
    if (!current) {
      // The retained exact token identifies physical launch A even after B
      // replaces the mutable probe projection. Parent-turn coincidence never
      // participates. Only the observed native child itself is retired.
      await fenceAuthenticatedCandidate();
      return deny('bootstrap belongs to a retired probe generation', 'bootstrap_generation_retired');
    }
    if (expired(record.expires_at) || !['launched', 'bound'].includes(record.status) || record.canary_stopped_at) {
      if (record.parent_session_id === candidate.parent_session_id && record.status !== 'prepared') {
        await quarantineProbeIdentity(paths, candidate.parent_session_id, candidate.agent_id);
        await quarantineNativeProbeAliases(paths, candidate);
      }
      return deny('probe is not awaiting an authenticated bootstrap', 'bootstrap_not_awaiting');
    }
    if (await quarantinedIdentityMatches(paths, candidate.parent_session_id, candidate.agent_id) &&
        !(await isCodexBootstrapReplay(paths, normalized))) {
      return deny('canary identity is retired', 'canary_retired');
    }
    const ticket = await readProbeTicket(paths, record);
    if (!ticket) {
      await fenceAuthenticatedCandidate();
      return deny('authoritative probe ticket unavailable', 'probe_ticket_unavailable');
    }
    let binding;
    try {
      binding = await bootstrapCodexSubagent(paths, probeBindingState(record, ticket), normalized);
    } catch {
      await fenceAuthenticatedCandidate();
      return deny('production bootstrap validation failed', 'production_bootstrap_exception', 'error');
    }
    if (!binding.valid) {
      await fenceAuthenticatedCandidate();
      const observation = projectedBindingObservation(binding.binding_observation) ??
        { observed_at: iso(), outcome: 'rejected', code: 'bootstrap_rejected' };
      await persistRejection(observation);
      return { matched: true, ...binding, binding_observation: observation };
    }
    const capability = binding.additional_context
      ?.match(/(?:^|\n)APE_RECEIPT_CAPABILITY=([A-Za-z0-9_-]{32,256})(?:\n|$)/)?.[1];
    if (!CAPABILITY_PATTERN.test(capability ?? '') || capability === toolInput.bootstrap_capability ||
        !validProbeBootstrapInvocation(binding.bootstrap_invocation)) {
      await fenceAuthenticatedCandidate();
      return deny('production bootstrap returned incomplete authoritative context', 'production_context_unavailable');
    }
    const bindingDecidedAt = Date.now();
    await quarantineProbeIdentity(paths, candidate.parent_session_id, candidate.agent_id, iso(bindingDecidedAt));
    await quarantineNativeProbeAliases(paths, candidate, iso(bindingDecidedAt));
    if (expired(record.expires_at, bindingDecidedAt)) {
      return deny('probe expired during production bootstrap validation', 'ticket_deadline_elapsed');
    }
    const alreadyBound = record.status === 'bound';
    const boundAt = alreadyBound ? record.bound_at : iso(bindingDecidedAt);
    await atomicWriteJson(paths.bindingProbe, {
      ...record,
      status: 'bound',
      bound_session_id: candidate.parent_session_id,
      bound_agent_id: candidate.agent_id,
      capability_hash: digest(capability),
      bootstrap_invocation: binding.bootstrap_invocation,
      bound_at: boundAt,
      last_binding_observation: binding.binding_observation,
      transitions: alreadyBound ? record.transitions : [...record.transitions, { status: 'bound', at: boundAt }],
    });
    return {
      matched: true,
      ...binding,
      reason: 'APE native identity bound through the production bootstrap ticket-context path',
      additional_context: [
        binding.additional_context,
        '',
        'APE native binding infrastructure probe (authoritative)',
        'For this synthetic probe only, the following instructions replace the preceding stage-work, ticket-reading, and receipt-validation obligations.',
        'Do not call any tools after ape_bind. Do not load the synthetic ticket and do not call ape_validate_receipt.',
        'This synthetic ticket verifies delivery only. Do not call tools or perform project work.',
        `APE_BINDING_PROBE_ID=${record.probe_id}`,
        `APE_PROBE_CAPABILITY=${capability}`,
        `Return only {"probe_id":"${record.probe_id}","probe_capability":"${capability}"} as your final response. Do not call tools.`,
      ].join('\n'),
    };
  });
}

export async function resolvesBindingProbeIdentity(paths, input) {
  const sessionId = input.session_id ?? input.sessionId;
  const agentId = input.agent_id ?? input.agentId ?? input.subagent_id ?? input.subagentId;
  const agentType = input.agent_type ?? input.agentType;
  const rawChildIdentity =
    input.agent_id ??
    input.agentId ??
    input.subagent_id ??
    input.subagentId ??
    input.agent_type ??
    input.agentType ??
    null;
  const childContext = Boolean(rawChildIdentity || input.is_subagent || input.isSubagent);
  // Main-session tool calls have no normalized child signal and are outside
  // this identity fence. Once any child identity/type/flag is present,
  // however, a live probe reservation must be read and validated before
  // malformed/nonmatching input can fall through.
  if (!childContext) return false;
  const exactIdentityBounded = bounded(sessionId) && bounded(agentId);
  if (exactIdentityBounded) {
    try {
      if (await quarantinedIdentityMatches(paths, sessionId, agentId)) return true;
    } catch {
      // Continue to the monolithic record: it can still prove this exact pair,
      // and a quarantine lookup failure must not turn that proof into a grant.
    }
  }
  const rawRecord = await readRawProbeRecord(paths);
  if (rawRecord === MISSING_PROBE_RECORD) return false;
  const upgradeIdentity = legacyBoundIdentity(rawRecord);
  if (
    exactIdentityBounded &&
    upgradeIdentity?.session_id === sessionId &&
    upgradeIdentity.agent_id === agentId
  ) {
    await quarantineLegacyBoundIdentity(paths, rawRecord).catch(() => {});
    return true;
  }
  if (validLegacyProbeRecord(rawRecord)) {
    if (!exactIdentityBounded) {
      if (
        !expired(rawRecord.expires_at) &&
        PROBE_RESERVATION_STATUSES.has(rawRecord.status)
      ) throw new Error('native binding probe child identity is malformed');
      return false;
    }
    const identity = legacyBoundIdentity(rawRecord);
    if (
      identity?.session_id === sessionId &&
      identity.agent_id === agentId
    ) {
      await quarantineLegacyBoundIdentity(paths, rawRecord).catch(() => {});
      return true;
    }
    if (
      !expired(rawRecord.expires_at) &&
      PROBE_RESERVATION_STATUSES.has(rawRecord.status)
    ) {
      throw new Error('legacy native binding probe owns the pre-run child identity window');
    }
    return false;
  }
  const record = assertValidPersistedProbeRecord(rawRecord);
  if (!exactIdentityBounded) {
    if (
      !expired(record.expires_at) &&
      PROBE_RESERVATION_STATUSES.has(record.status)
    ) throw new Error('native binding probe child identity is malformed');
    return false;
  }
  // Expiry and type drift end proof readiness, never the deny-only fence around
  // an identity already established by the production binder. Retained pairs
  // keep older canaries quarantined across consecutive diagnostic runs.
  if (
    currentIdentityMatches(record, sessionId, agentId) ||
    retiredIdentityMatches(record, sessionId, agentId)
  ) {
    const identity = (record.retired_identities ?? []).find(
      (candidate) => candidate.session_id === sessionId && candidate.agent_id === agentId,
    );
    await quarantineProbeIdentity(
      paths,
      sessionId,
      agentId,
      identity?.retired_at ?? record.bound_at ?? iso(),
    ).catch(() => {});
    return true;
  }
  if (expired(record.expires_at)) return false;
  if (agentType !== undefined && agentType !== null && !bounded(agentType)) {
    throw new Error('native binding probe child identity is malformed');
  }
  if (PROBE_RESERVATION_STATUSES.has(record.status)) {
    throw new Error('native binding probe owns the pre-run child identity window');
  }
  return false;
}

// External MCP tools normally bypass APE before any runtime-state read. The
// sole exception is an exact canary identity already established by the
// production binder. This helper intentionally performs no blanket
// reservation check: callers can catch corrupt/unreadable state and remain
// neutral for unrelated integrations without granting a known canary tools.
export async function resolvesExactBindingProbeIdentity(paths, input) {
  const sessionId = input.session_id ?? input.sessionId;
  const agentId = input.agent_id ?? input.agentId ?? input.subagent_id ?? input.subagentId;
  try {
    if (await nativeProbeAliasMatches(paths, input)) return true;
  } catch {
    // An independent pair tombstone or the current bound projection can still
    // establish this exact canary when alias-ledger ancestors are damaged.
  }
  if (![input.session_id, input.sessionId, input.agent_id, input.agentId, input.subagent_id, input.subagentId]
    .some((value) => bounded(value))) return false;
  try {
    if (await quarantinedIdentityMatches(paths, sessionId, agentId)) return true;
  } catch {
    // Continue to exact identity evidence in the current probe record. External
    // wildcard callers deliberately stay neutral only when no exact proof can
    // be recovered, not merely because one quarantine directory is unreadable.
  }
  const rawRecord = await readRawProbeRecord(paths);
  if (rawRecord === MISSING_PROBE_RECORD) return false;
  const upgradeIdentity = legacyBoundIdentity(rawRecord);
  if (
    upgradeIdentity?.session_id === sessionId &&
    upgradeIdentity.agent_id === agentId
  ) {
    await quarantineLegacyBoundIdentity(paths, rawRecord).catch(() => {});
    return true;
  }
  if (validLegacyProbeRecord(rawRecord)) {
    const identity = legacyBoundIdentity(rawRecord);
    if (identity?.session_id !== sessionId || identity.agent_id !== agentId) return false;
    await quarantineLegacyBoundIdentity(paths, rawRecord).catch(() => {});
    return true;
  }
  const record = assertValidPersistedProbeRecord(rawRecord);
  const nativeAlias = currentNativeProbeAlias(record, input);
  if (nativeAlias) {
    // Compatibility for pre-alias protocol-1 snapshots: a fully validated
    // bound record seals the child UUID and exact child-turn hash. Ignore
    // contradictory caller fields only for this conservative denial, never
    // to supply bootstrap or stage authority.
    await quarantineNativeProbeAliases(paths, nativeAlias, record.bound_at).catch(() => {});
    return true;
  }
  const currentMatch = currentIdentityMatches(record, sessionId, agentId);
  const retiredIdentity = (record.retired_identities ?? []).find(
    (candidate) => candidate.session_id === sessionId && candidate.agent_id === agentId,
  );
  if (!currentMatch && !retiredIdentity) return false;
  await quarantineProbeIdentity(
    paths,
    sessionId,
    agentId,
    retiredIdentity?.retired_at ?? record.bound_at ?? iso(),
  ).catch(() => {});
  return true;
}

// SubagentStop proves that one native turn ended, not that the Codex task
// identity can never be resumed. Preserve the deny-only quarantine in the
// content-addressed ledger and record the current identity's latest stop only
// as lifecycle evidence. Retired identities become one-way immutable
// tombstones; no in-memory or monolithic-record ceiling silently evicts them.
export async function observeBindingProbeStop(paths, input) {
  const sessionId = input.session_id ?? input.sessionId;
  const agentId = input.agent_id ?? input.agentId ?? input.subagent_id ?? input.subagentId;
  if (!bounded(sessionId) || !bounded(agentId)) return { matched: false };
  if (!(await validateGovernedRuntimeAncestor(paths))) return { matched: false };
  return withProbeLock(paths, async () => {
    let quarantineMatch = false;
    try {
      quarantineMatch = await quarantinedIdentityMatches(paths, sessionId, agentId);
    } catch {
      // The current record may still name the exact resumable canary. Consult
      // it before classifying an unreadable quarantine lookup as unrelated.
    }
    let record;
    try {
      record = await readPersistedProbeRecord(paths);
    } catch (error) {
      if (quarantineMatch) return { matched: true };
      throw error;
    }
    if (!record) return { matched: quarantineMatch };
    if (currentIdentityPairMatches(record, sessionId, agentId)) {
      await quarantineProbeIdentity(
        paths,
        sessionId,
        agentId,
        record.bound_at ?? iso(),
      );
      if (record.canary_stopped_at) return { matched: true };
      await atomicWriteJson(paths.bindingProbe, {
        ...record,
        canary_stopped_at: iso(),
      });
      return { matched: true };
    }
    if (retiredIdentityMatches(record, sessionId, agentId)) {
      const identity = record.retired_identities.find(
        (candidate) =>
          candidate.session_id === sessionId && candidate.agent_id === agentId,
      );
      await quarantineProbeIdentity(paths, sessionId, agentId, identity.retired_at);
      await atomicWriteJson(paths.bindingProbe, {
        ...record,
        retired_identities: record.retired_identities.filter(
          (candidate) =>
            candidate.session_id !== sessionId || candidate.agent_id !== agentId,
        ),
      });
      return { matched: true };
    }
    if (quarantineMatch) return { matched: true };
    return { matched: false };
  });
}

export async function acknowledgeBindingProbe(paths, input = {}) {
  const { probe_id, probe_capability } = input;
  if (!PROBE_ID_PATTERN.test(probe_id ?? '') || !CAPABILITY_PATTERN.test(probe_capability ?? '')) {
    throw new Error('probe acknowledgement requires a valid probe_id and probe_capability');
  }
  return withProbeLock(paths, async () => {
    const record = await readPersistedProbeRecord(paths);
    if (!record || record.probe_id !== probe_id) {
      throw new Error('native binding probe acknowledgement does not match the current probe');
    }
    if (expired(record.expires_at)) throw new Error('native binding probe expired before acknowledgement');
    if (!['bound', 'completed'].includes(record.status)) {
      throw new Error(`native binding probe cannot be acknowledged while ${record.status}`);
    }
    if (record.capability_hash !== digest(probe_capability)) {
      throw new Error('native binding probe capability mismatch');
    }
    if (!(await readProbeTicket(paths, record))) {
      throw new Error('native binding probe authoritative ticket is unavailable');
    }
    if (!(await corroboratesCodexProbeBinding(paths, record))) {
      throw new Error('native binding probe lacks corroborating production binding evidence');
    }
    const completedAt = Date.now();
    if (expired(record.expires_at, completedAt)) {
      throw new Error('native binding probe expired during acknowledgement validation');
    }
    if (record.status === 'completed') return projectBindingProbe(record);
    const completedAtIso = iso(completedAt);
    const completed = {
      ...record,
      status: 'completed',
      completed_at: completedAtIso,
      transitions: [...(record.transitions ?? []), { status: 'completed', at: completedAtIso }],
    };
    await atomicWriteJson(paths.bindingProbe, completed);
    return projectBindingProbe(completed);
  });
}

// A completed probe is a short-lived, single-use proof that this Codex host
// actually delivered the launch and child-binding lifecycle events APE needs.
// Consuming under the probe lock prevents two concurrent starts from reusing
// one proof; callers still hold the run lock before calling this so a failed
// consumption cannot race ahead of any Git mutation.
export async function consumeBindingProbe(paths, host) {
  return withProbeLock(paths, async () => {
    // Re-read and validate under the consumption lock. The earlier readiness
    // projection is not authority: a parseable torn record could otherwise be
    // substituted between that read and this single-use admission boundary.
    const record = await readPersistedProbeRecord(paths);
    if (!record || record.host !== host || record.status !== 'completed' || expired(record.expires_at)) {
      return { ok: false, probe: projectBindingProbe(record) };
    }
    // Revalidate the exact authoritative ticket before changing state. In
    // particular, never derive a deletion path from a mutable persisted id.
    const ticket = await readProbeTicket(paths, record);
    if (!ticket) {
      return {
        ok: false,
        probe: {
          ...projectBindingProbe(record),
          infrastructure_status: 'failed',
          reason: 'authoritative native binding probe ticket unavailable; prepare a fresh probe',
        },
      };
    }
    if (!(await corroboratesCodexProbeBinding(paths, record))) {
      return {
        ok: false,
        probe: {
          ...projectBindingProbe(record),
          infrastructure_status: 'failed',
          reason: 'production binding intent does not corroborate the completed native probe',
        },
      };
    }
    const consumedAt = Date.now();
    if (expired(record.expires_at, consumedAt)) {
      return { ok: false, probe: projectBindingProbe(record, consumedAt) };
    }
    const consumedAtIso = iso(consumedAt);
    const consumed = {
      ...record,
      status: 'consumed',
      consumed_at: consumedAtIso,
      transitions: [...(record.transitions ?? []), { status: 'consumed', at: consumedAtIso }],
    };
    await atomicWriteJson(paths.bindingProbe, consumed);
    await rm(
      probeTicketPath(paths, record.probe_id, record.ticket_id),
      { force: true },
    ).catch(() => {});
    return { ok: true, probe: projectBindingProbe(consumed) };
  });
}
