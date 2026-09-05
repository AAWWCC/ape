import { createHash, createHmac, randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { atomicReplaceText, atomicWriteJson, ensureDir } from './storage.js';
import { withDirLock } from './lock.js';
import { renderStatusDoc } from './status-doc.js';
import { activeState } from './active-state.js';
import { codexInjectedDispatchContext, receiptContractContext } from './adapters.js';
import {
  BOOTSTRAP_TOOL_PATTERN,
  codexBootstrapOrientation,
  recordCodexBootstrapCandidate,
  resolveCodexBootstrapCandidate,
} from './codex-bootstrap.js';
import {
  CODEX_REASONING_EFFORT_MAX_CHARS,
  NATIVE_MODEL_MAX_CHARS,
  RECEIPT_MAX_PHYSICAL_WORKERS_PER_TICKET,
  RECEIPT_MAX_SUBMISSIONS_PER_WORKER,
} from './constants.js';

const NONCE_PATTERN = /^[A-Za-z0-9_-]{32,256}$/;
const CODEX_TASK_NAME_PATTERN = /^ape_[a-z0-9_]+_[a-f0-9]{32}$/;
const MAX_PROMPT_BYTES = 256 * 1024;
const LAUNCH_TTL_MS = 60_000;
const LOCK_STALE_MS = 10_000;
const LOCK_HEARTBEAT_MS = 2_500;
const LOCK_WAIT_MS = 2_000;
const CODEX_V2_DEFAULT_AGENT_TYPE = 'default';
const LAUNCH_SEED_PATTERN = /^[a-f0-9]{64}$/;
const LAUNCH_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MAX_LAUNCH_KEY_FILE_BYTES = 44;
const MAX_DISPATCH_INTENT_FILE_BYTES = 1024 * 1024;
const MAX_SUBAGENT_START_DIAGNOSTIC_FILE_BYTES = 64 * 1024;
const SUBAGENT_START_DIAGNOSTIC_VERSION = 1;
const SUBAGENT_START_OBSERVATION_LIMIT = 8;
const DISPATCH_INTENT_STATUSES = new Set([
  'prepared',
  'authorized',
  'launched',
  'bound',
  'completed',
  'expired',
]);
const DISPATCH_DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const DISPATCH_LAUNCH_GENERATION_LIMIT = 64;
const DISPATCH_LAUNCH_GENERATION_STATUSES = new Set([
  'prepared',
  'authorized',
  'bound',
  'completed',
  'expired',
  'orphaned',
]);
const SUBAGENT_START_OUTCOMES = new Set(['accepted', 'rejected', 'error']);
const SUBAGENT_START_CODES = new Set([
  'bound',
  'resumed',
  'malformed_session_identity',
  'malformed_agent_identity',
  'malformed_agent_type',
  'native_model_unavailable',
  'native_model_mismatch',
  'bootstrap_rejected',
  'bootstrap_capability_unavailable',
  'bootstrap_parent_mismatch',
  'bootstrap_already_claimed',
  'agent_type_mismatch',
  'no_unique_active_launched_intent',
  'native_identity_already_bound',
  'ticket_not_pending',
  'ticket_deadline_elapsed',
  'ticket_hash_mismatch',
  'context_unavailable',
  'context_hash_mismatch',
  'compatibility_ticket_accepted',
  'compatibility_ticket_rejected',
  'unexpected_exception',
]);
export const RECEIPT_VALIDATION_MAX_ATTEMPTS = RECEIPT_MAX_SUBMISSIONS_PER_WORKER;

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function intentPath(paths, ticketId) {
  return path.join(paths.dispatchIntents, `${digest(ticketId)}.json`);
}

function ordinaryDispatchIntentFile(metadata) {
  return metadata.isFile() &&
    !metadata.isSymbolicLink() &&
    metadata.nlink === 1 &&
    metadata.size <= MAX_DISPATCH_INTENT_FILE_BYTES;
}

async function ensurePlainDirectory(directory, { create = false } = {}) {
  let metadata;
  try {
    metadata = await lstat(directory);
  } catch (error) {
    if (error?.code !== 'ENOENT' || !create) throw error;
    try {
      await mkdir(directory, { mode: 0o700 });
    } catch (mkdirError) {
      if (mkdirError?.code !== 'EEXIST') throw mkdirError;
    }
    metadata = await lstat(directory);
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw dispatchIntentEvidenceError('directory');
  }
  return metadata;
}

async function governedDispatchRuntime(paths, { create = false } = {}) {
  const canonicalRoot = await realpath(paths.root);
  const expectedApe = path.join(canonicalRoot, '.ape');
  await ensurePlainDirectory(paths.ape, { create });
  if (await realpath(paths.ape) !== expectedApe) {
    throw dispatchIntentEvidenceError('directory');
  }
  const expectedRuntime = path.join(expectedApe, 'runtime');
  await ensurePlainDirectory(paths.runtime, { create });
  if (await realpath(paths.runtime) !== expectedRuntime) {
    throw dispatchIntentEvidenceError('directory');
  }
}

async function dispatchIntentContainer(paths, { create = false } = {}) {
  await governedDispatchRuntime(paths, { create });
  let metadata;
  try {
    metadata = await lstat(paths.dispatchIntents);
  } catch (error) {
    if (error?.code !== 'ENOENT' || !create) throw error;
    await ensureDir(paths.dispatchIntents);
    metadata = await lstat(paths.dispatchIntents);
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw dispatchIntentEvidenceError('directory');
  }
  return metadata;
}

// Dispatch intents are bearer-authority evidence. Never follow an individual
// symlink or open a FIFO/device/socket while reading that evidence: aside from
// crossing the project boundary, a FIFO can wedge status and the audited abort
// path forever. The bounded descriptor read plus before/opened/after identity
// checks also turns replacement and unbounded-growth races into a closed error.
async function readDispatchIntentArtifact(file, { allowMissing = false } = {}) {
  let before;
  try {
    before = await lstat(file);
  } catch (error) {
    if (allowMissing && error?.code === 'ENOENT') return null;
    throw error;
  }
  if (!ordinaryDispatchIntentFile(before)) {
    throw dispatchIntentEvidenceError('artifact');
  }
  const flags = fsConstants.O_RDONLY |
    (fsConstants.O_NONBLOCK ?? 0) |
    (fsConstants.O_NOFOLLOW ?? 0);
  const handle = await open(file, flags);
  let encoded;
  try {
    const opened = await handle.stat();
    if (!ordinaryDispatchIntentFile(opened) || !sameFileIdentity(opened, before)) {
      throw dispatchIntentEvidenceError('artifact');
    }
    const buffer = Buffer.alloc(MAX_DISPATCH_INTENT_FILE_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const result = await handle.read(
        buffer,
        bytesRead,
        buffer.length - bytesRead,
        bytesRead,
      );
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    if (bytesRead > MAX_DISPATCH_INTENT_FILE_BYTES) {
      throw dispatchIntentEvidenceError('artifact');
    }
    const openedAfterRead = await handle.stat();
    const after = await lstat(file);
    if (
      !ordinaryDispatchIntentFile(openedAfterRead) ||
      !ordinaryDispatchIntentFile(after) ||
      !sameFileIdentity(openedAfterRead, opened) ||
      !sameFileIdentity(after, opened)
    ) {
      throw dispatchIntentEvidenceError('artifact');
    }
    encoded = buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
  return JSON.parse(encoded);
}

function privateLaunchKeyFile(metadata) {
  return metadata.isFile() &&
    !metadata.isSymbolicLink() &&
    metadata.nlink === 1 &&
    metadata.size <= MAX_LAUNCH_KEY_FILE_BYTES &&
    (process.platform === 'win32' || (metadata.mode & 0o077) === 0);
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

async function dispatchLaunchKey(paths) {
  await ensureDir(paths.runtime);
  try {
    const before = await lstat(paths.dispatchLaunchKey);
    if (!privateLaunchKeyFile(before)) {
      throw new Error('dispatch launch derivation key is not a private regular file');
    }
    // The entry can change after lstat. A replacement FIFO must not block
    // before fstat can reject it, and a replacement symlink must not be read.
    const flags = fsConstants.O_RDONLY |
      (fsConstants.O_NONBLOCK ?? 0) |
      (fsConstants.O_NOFOLLOW ?? 0);
    const handle = await open(paths.dispatchLaunchKey, flags);
    let encoded;
    try {
      const opened = await handle.stat();
      if (!privateLaunchKeyFile(opened) || !sameFileIdentity(opened, before)) {
        throw new Error('dispatch launch derivation key changed while opening');
      }
      const buffer = Buffer.alloc(MAX_LAUNCH_KEY_FILE_BYTES + 1);
      let bytesRead = 0;
      while (bytesRead < buffer.length) {
        const read = await handle.read(
          buffer,
          bytesRead,
          buffer.length - bytesRead,
          bytesRead,
        );
        if (read.bytesRead === 0) break;
        bytesRead += read.bytesRead;
      }
      if (bytesRead > MAX_LAUNCH_KEY_FILE_BYTES) {
        throw new Error('dispatch launch derivation key is oversized');
      }
      encoded = buffer.subarray(0, bytesRead).toString('utf8').trim();
      const openedAfterRead = await handle.stat();
      const after = await lstat(paths.dispatchLaunchKey);
      if (
        !privateLaunchKeyFile(openedAfterRead) ||
        !privateLaunchKeyFile(after) ||
        !sameFileIdentity(openedAfterRead, opened) ||
        !sameFileIdentity(after, opened)
      ) {
        throw new Error('dispatch launch derivation key changed while reading');
      }
    } finally {
      await handle.close();
    }
    if (!LAUNCH_KEY_PATTERN.test(encoded)) {
      throw new Error('dispatch launch derivation key is invalid');
    }
    return Buffer.from(encoded, 'base64url');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  // Callers hold dispatchLock, so no other cooperative APE initializer can
  // race this publication. Atomic replacement also leaves the canonical path
  // absent after a pre-rename crash rather than stranding a partial key.
  const encoded = randomBytes(32).toString('base64url');
  await atomicReplaceText(paths.dispatchLaunchKey, `${encoded}\n`, { mode: 0o600 });
  return Buffer.from(encoded, 'base64url');
}

function derivedLaunchCapability(key, host, ticket, seed, codexTaskNamespace = null) {
  if (!LAUNCH_SEED_PATTERN.test(seed ?? '')) {
    throw new Error(`${hostLabel(host)} prepared dispatch has an invalid launch seed`);
  }
  if (
    codexTaskNamespace !== null &&
    (host !== 'codex' || codexTaskNamespace !== 'probe')
  ) {
    throw new Error(`${hostLabel(host)} prepared dispatch has an invalid task namespace`);
  }
  const taskNamespace = host === 'codex'
    ? (codexTaskNamespace ?? ticket.role)
    : ticket.role;
  const material = [
    'ape-native-launch-v1',
    host,
    ticket.run_id,
    ticket.ticket_id,
    ticket.ticket_hash,
    ticket.role,
    ...(codexTaskNamespace === null ? [] : [codexTaskNamespace]),
    seed,
  ].join('\0');
  const hmac = createHmac('sha256', key).update(material);
  return host === 'codex'
    ? `ape_${taskNamespace}_${hmac.digest('hex').slice(0, 32)}`
    : hmac.digest('base64url');
}

function derivedBootstrapCapability(key, ticket, seed) {
  if (!LAUNCH_SEED_PATTERN.test(seed ?? '')) throw new Error('Codex bootstrap launch seed is invalid');
  return createHmac('sha256', key).update([
    'ape-codex-bootstrap-v1', ticket.run_id, ticket.ticket_id, ticket.ticket_hash, seed,
  ].join('\0')).digest('base64url');
}

function derivedBootstrapReceiptCapability(key, record, sessionId, agentId) {
  return createHmac('sha256', key).update([
    'ape-codex-bootstrap-receipt-v1', record.run_id, record.ticket_id, record.ticket_hash,
    record.launch_seed, String(record.launch_generation), sessionId, agentId,
  ].join('\0')).digest('base64url');
}

function currentLaunchGeneration(record) {
  if (Number.isSafeInteger(record?.launch_generation) && record.launch_generation > 0) {
    return record.launch_generation;
  }
  const generations = Array.isArray(record?.launch_generations)
    ? record.launch_generations
    : [];
  return generations.reduce(
    (maximum, entry) => Number.isSafeInteger(entry?.generation)
      ? Math.max(maximum, entry.generation)
      : maximum,
    record ? 1 : 0,
  );
}

function launchGenerationStatus(status) {
  return status === 'launched' ? 'authorized' : status;
}

function launchGenerationEntry(record, generation, status, patch = {}) {
  return {
    version: 1,
    run_id: record.run_id,
    ticket_id: record.ticket_id,
    ticket_hash: record.ticket_hash,
    ...(record.prepared_at ? { prepared_at: record.prepared_at } : {}),
    ...(record.expires_at ? { expires_at: record.expires_at } : {}),
    ...(record.nonce_hash ? { nonce_hash: record.nonce_hash } : {}),
    ...(record.launch_name_hash ? { launch_name_hash: record.launch_name_hash } : {}),
    ...(record.codex_task_namespace ? { codex_task_namespace: record.codex_task_namespace } : {}),
    ...(record.bootstrap_protocol === 1 ? {
      bootstrap_protocol: 1,
      bootstrap_capability_hash: record.bootstrap_capability_hash,
      ...(record.parent_session_id ? { parent_session_id: record.parent_session_id } : {}),
      ...(record.tool_use_id ? { tool_use_id: record.tool_use_id } : {}),
      ...(record.launched_at ? { launched_at: record.launched_at } : {}),
      ...(record.binding_agent_type ? { binding_agent_type: record.binding_agent_type } : {}),
      ...(record.requested_model ? { requested_model: record.requested_model } : {}),
    } : {}),
    ...patch,
    generation,
    status: launchGenerationStatus(status),
  };
}

function launchGenerationHistory(record) {
  if (!record) return [];
  if (Array.isArray(record.launch_generations) && record.launch_generations.length > 0) {
    return structuredClone(record.launch_generations);
  }
  const generation = currentLaunchGeneration(record);
  return [launchGenerationEntry(record, generation, record.status ?? 'prepared')];
}

function withLaunchGenerationStatus(record, status, patch = {}) {
  const generation = currentLaunchGeneration(record);
  const generations = launchGenerationHistory(record);
  const index = generations.findIndex((entry) => entry.generation === generation);
  const prior = index >= 0 ? generations[index] : {};
  const next = launchGenerationEntry(record, generation, status, { ...prior, ...patch });
  if (index >= 0) generations[index] = next;
  else generations.push(next);
  return {
    ...record,
    ...patch,
    launch_generation: generation,
    launch_generations: generations,
  };
}

function subagentStartDiagnosticPath(paths) {
  return path.join(paths.runtime, 'subagent-start-diagnostics.json');
}

function ordinarySubagentStartDiagnosticFile(metadata) {
  return metadata.isFile() &&
    !metadata.isSymbolicLink() &&
    metadata.nlink === 1 &&
    metadata.size <= MAX_SUBAGENT_START_DIAGNOSTIC_FILE_BYTES;
}

// This file is bounded, identity-free telemetry rather than authority. Treat
// every missing, malformed, replaced, non-regular, linked, or oversized leaf
// as an empty diagnostic history. In particular, never follow a symlink or
// wait for a FIFO merely to enrich a status projection or rejection message.
async function readSubagentStartDiagnostics(paths) {
  const file = subagentStartDiagnosticPath(paths);
  let handle = null;
  try {
    const before = await lstat(file);
    if (!ordinarySubagentStartDiagnosticFile(before)) return null;
    const flags = fsConstants.O_RDONLY |
      (fsConstants.O_NONBLOCK ?? 0) |
      (fsConstants.O_NOFOLLOW ?? 0);
    handle = await open(file, flags);
    const opened = await handle.stat();
    if (
      !ordinarySubagentStartDiagnosticFile(opened) ||
      !sameFileIdentity(opened, before)
    ) return null;

    const buffer = Buffer.alloc(MAX_SUBAGENT_START_DIAGNOSTIC_FILE_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const result = await handle.read(
        buffer,
        bytesRead,
        buffer.length - bytesRead,
        bytesRead,
      );
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    if (bytesRead > MAX_SUBAGENT_START_DIAGNOSTIC_FILE_BYTES) return null;

    const openedAfterRead = await handle.stat();
    const after = await lstat(file);
    if (
      !ordinarySubagentStartDiagnosticFile(openedAfterRead) ||
      !ordinarySubagentStartDiagnosticFile(after) ||
      !sameFileIdentity(openedAfterRead, opened) ||
      !sameFileIdentity(after, opened)
    ) return null;
    return JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

// Read-only authority lookup for public receipt edges. The capability remains
// one-way at rest; callers compare only the canonical draft field and switch to
// non-reflective refusals when it does not authenticate.
export async function readDispatchReceiptCapabilityHash(paths, ticketId) {
  if (typeof ticketId !== 'string' || ticketId.length === 0) return null;
  const current = await readCanonicalIntent(paths, ticketId);
  return current?.ticket_id === ticketId &&
    typeof current.capability_hash === 'string' &&
    /^[0-9a-f]{64}$/iu.test(current.capability_hash)
    ? current.capability_hash.toLowerCase()
    : null;
}

// Internal corroboration for the pre-run Codex canary. The probe state file
// describes its lifecycle, but the production dispatch intent is independent
// evidence that the ordinary binder actually reached `bound` for the same
// immutable ticket, native identity, and one-way receipt capability.
export async function corroboratesCodexProbeBinding(paths, expected) {
  if (
    !boundedIdentity(expected?.probe_id, 160) ||
    !boundedIdentity(expected?.ticket_id, 256) ||
    !/^[a-f0-9]{64}$/u.test(expected?.ticket_hash ?? '') ||
    !/^[a-f0-9]{64}$/u.test(expected?.capability_hash ?? '') ||
    !boundedIdentity(expected?.bound_session_id) ||
    !boundedIdentity(expected?.bound_agent_id) ||
    !boundedIdentity(expected?.binding_agent_type)
  ) return false;
  const current = await readCanonicalIntent(paths, expected.ticket_id).catch(() => null);
  return Boolean(
    current &&
    current.version === 2 &&
    current.host === 'codex' &&
    current.codex_task_namespace === 'probe' &&
    current.run_id === expected.probe_id &&
    current.ticket_id === expected.ticket_id &&
    current.ticket_hash === expected.ticket_hash &&
    (current.bootstrap_protocol ?? null) === (expected.bootstrap_protocol ?? null) &&
    (current.bootstrap_capability_hash ?? null) === (expected.bootstrap_capability_hash ?? null) &&
    current.launch_name_hash === expected.launch_name_hash &&
    current.expires_at === expected.expires_at &&
    current.agent_type === 'explorer' &&
    current.status === 'bound' &&
    current.bound_session_id === expected.bound_session_id &&
    current.bound_agent_id === expected.bound_agent_id &&
    current.binding_agent_type === expected.binding_agent_type &&
    current.capability_hash === expected.capability_hash
  );
}

// Lifecycle-wide counterpart used by pre-run diagnostics and lost-response
// recovery. The probe file is only a projection; this independent production
// intent must still describe the same immutable probe and the exact lifecycle
// state that APE is about to advertise or replay.
export async function corroboratesCodexProbeLifecycle(paths, expected) {
  if (
    !boundedIdentity(expected?.probe_id, 160) ||
    !boundedIdentity(expected?.ticket_id, 256) ||
    !/^[a-f0-9]{64}$/u.test(expected?.ticket_hash ?? '') ||
    !/^[a-f0-9]{64}$/u.test(expected?.launch_name_hash ?? '') ||
    expected?.host !== 'codex' ||
    expected?.agent_type !== 'explorer'
  ) return false;
  const current = await readCanonicalIntent(paths, expected.ticket_id).catch(() => null);
  const immutableMatch = Boolean(
    current &&
    current.version === 2 &&
    current.host === 'codex' &&
    current.codex_task_namespace === 'probe' &&
    current.run_id === expected.probe_id &&
    current.ticket_id === expected.ticket_id &&
    current.ticket_hash === expected.ticket_hash &&
    (current.bootstrap_protocol ?? null) === (expected.bootstrap_protocol ?? null) &&
    (current.bootstrap_capability_hash ?? null) === (expected.bootstrap_capability_hash ?? null) &&
    current.launch_name_hash === expected.launch_name_hash &&
    current.expires_at === expected.expires_at &&
    current.agent_type === expected.agent_type
  );
  if (!immutableMatch) return false;
  if (expected.status === 'prepared') {
    return exactPreparedLaunchReplay(current, {
      run_id: expected.probe_id,
      ticket_id: expected.ticket_id,
      ticket_hash: expected.ticket_hash,
    }, 'codex');
  }
  if (expected.status === 'launched') {
    return Boolean(
      current.status === 'launched' &&
      current.parent_session_id === expected.parent_session_id &&
      current.tool_use_id === expected.tool_use_id &&
      current.binding_agent_type === expected.binding_agent_type &&
      current.turn_id_hash === expected.launch_turn_id_hash
    );
  }
  if (['bound', 'completed', 'consumed'].includes(expected.status)) {
    return Boolean(
      current.status === 'bound' &&
      current.parent_session_id === expected.parent_session_id &&
      current.tool_use_id === expected.tool_use_id &&
      current.binding_agent_type === expected.binding_agent_type &&
      current.bound_session_id === expected.bound_session_id &&
      current.bound_agent_id === expected.bound_agent_id &&
      current.capability_hash === expected.capability_hash
    );
  }
  return false;
}

// A lost tool response can leave an authoritative dispatch intent prepared
// even though no native worker launch was ever authorized. If active.json
// already contains the same immutable ticket, its dispatch reservation crossed
// the state persistence boundary. A later NEXT must therefore re-emit that
// exact physical-worker opportunity. Keep this read-only classifier next to the intent
// format so receipt-service does not grow a second, looser interpretation.
export async function isPreparedUnlaunchedDispatchReplay(paths, state, ticket) {
  if (!state || !ticket) return false;
  const current = await readCanonicalIntent(paths, ticket.ticket_id);
  return exactPreparedLaunchReplay(current, ticket, state.host);
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

function boundedDispatchTimestamp(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 32) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function timestampNotBefore(value, earlier) {
  return boundedDispatchTimestamp(value) &&
    boundedDispatchTimestamp(earlier) &&
    Date.parse(value) >= Date.parse(earlier);
}

function dispatchIntentHost(record) {
  return record.host ?? 'claude';
}

function launchCapabilityHash(record, host = dispatchIntentHost(record)) {
  return host === 'codex' ? record.launch_name_hash : record.nonce_hash;
}

function generationAwareIntent(record) {
  return record.launch_seed !== undefined ||
    record.launch_generation !== undefined ||
    record.launch_generations !== undefined ||
    record.authorized_at !== undefined ||
    record.codex_task_namespace !== undefined ||
    record.status === 'authorized';
}

function upgradedLegacyGenerationRecord(record) {
  // A current runtime can transition a generation-less record written by an
  // older public release. withLaunchGenerationStatus necessarily publishes a
  // one-entry generation envelope around those already-authoritative bytes,
  // but it cannot invent the HMAC seed or generation-only ancestry that the
  // older record never carried. Keep that compatibility exact: one seedless
  // generation, no probe namespace (the probe did not exist in that format),
  // and never a merely prepared record.
  return record.launch_seed === undefined &&
    record.codex_task_namespace === undefined &&
    record.status !== 'prepared' &&
    record.launch_generation === 1 &&
    Array.isArray(record.launch_generations) &&
    record.launch_generations.length === 1 &&
    record.launch_generations[0]?.generation === 1;
}

function validLaunchGenerationEntry(entry, record, host, upgradedLegacy) {
  if (
    !entry ||
    typeof entry !== 'object' ||
    Array.isArray(entry) ||
    Object.getPrototypeOf(entry) !== Object.prototype ||
    entry.version !== 1 ||
    entry.run_id !== record.run_id ||
    entry.ticket_id !== record.ticket_id ||
    entry.ticket_hash !== record.ticket_hash ||
    !Number.isSafeInteger(entry.generation) ||
    entry.generation < 1 ||
    entry.generation > 1_000_000 ||
    !DISPATCH_LAUNCH_GENERATION_STATUSES.has(entry.status) ||
    !boundedDispatchTimestamp(entry.prepared_at) ||
    !boundedDispatchTimestamp(entry.expires_at) ||
    Date.parse(entry.expires_at) < Date.parse(entry.prepared_at) ||
    !DISPATCH_DIGEST_PATTERN.test(launchCapabilityHash(entry, host) ?? '') ||
    (host === 'codex'
      ? entry.nonce_hash !== undefined
      : entry.launch_name_hash !== undefined) ||
    (entry.codex_task_namespace ?? null) !== (record.codex_task_namespace ?? null)
  ) return false;
  if ((entry.bootstrap_protocol !== undefined || entry.bootstrap_capability_hash !== undefined) && (
    host !== 'codex' || entry.bootstrap_protocol !== 1 ||
    !DISPATCH_DIGEST_PATTERN.test(entry.bootstrap_capability_hash ?? '')
  )) return false;

  const hasAuthorizedAncestry = entry.authorized_at !== undefined ||
    entry.launch_expires_at !== undefined || entry.turn_id_hash !== undefined;
  if (entry.bootstrap_protocol === 1 && hasAuthorizedAncestry && (
    !boundedIdentity(entry.parent_session_id) || !boundedIdentity(entry.tool_use_id) ||
    !boundedIdentity(entry.binding_agent_type) ||
    !boundedIdentity(entry.requested_model, NATIVE_MODEL_MAX_CHARS.codex) ||
    entry.launched_at !== entry.authorized_at
  )) return false;
  if (hasAuthorizedAncestry && (
    !timestampNotBefore(entry.authorized_at, entry.prepared_at) ||
    !timestampNotBefore(entry.launch_expires_at, entry.authorized_at) ||
    Date.parse(entry.launch_expires_at) > Date.parse(entry.expires_at) ||
    (entry.turn_id_hash !== undefined &&
      !DISPATCH_DIGEST_PATTERN.test(entry.turn_id_hash ?? ''))
  )) return false;
  if (
    ['authorized', 'bound', 'completed', 'orphaned'].includes(entry.status) &&
    !hasAuthorizedAncestry &&
    !upgradedLegacy
  ) return false;

  const boundPredecessor = hasAuthorizedAncestry
    ? entry.authorized_at
    : upgradedLegacy
      ? record.launched_at
      : null;
  if (entry.bound_at !== undefined && !timestampNotBefore(entry.bound_at, boundPredecessor)) {
    return false;
  }
  if (
    ['bound', 'completed'].includes(entry.status) &&
    entry.bound_at === undefined &&
    !upgradedLegacy
  ) return false;
  const completionPredecessor = entry.bound_at ?? (upgradedLegacy ? record.bound_at : null);
  if (
    entry.completed_at !== undefined &&
    !timestampNotBefore(entry.completed_at, completionPredecessor)
  ) {
    return false;
  }
  if (entry.status === 'completed' && entry.completed_at === undefined) return false;
  if (entry.expired_at !== undefined && !timestampNotBefore(entry.expired_at, entry.prepared_at)) {
    return false;
  }
  if (entry.status === 'expired' && entry.expired_at === undefined) return false;
  const orphanPredecessor = hasAuthorizedAncestry
    ? entry.authorized_at
    : upgradedLegacy
      ? record.launched_at
      : null;
  if (
    entry.orphaned_at !== undefined &&
    !timestampNotBefore(entry.orphaned_at, orphanPredecessor)
  ) {
    return false;
  }
  if (entry.status === 'orphaned' && entry.orphaned_at === undefined) return false;
  const carriesAuthorized = hasAuthorizedAncestry;
  const carriesBound = entry.bound_at !== undefined;
  const carriesCompleted = entry.completed_at !== undefined;
  const carriesExpired = entry.expired_at !== undefined;
  const carriesOrphaned = entry.orphaned_at !== undefined;
  if (
    (entry.status === 'prepared' && (
      carriesAuthorized || carriesBound || carriesCompleted || carriesExpired || carriesOrphaned
    )) ||
    (entry.status === 'authorized' && (
      carriesBound || carriesCompleted || carriesExpired || carriesOrphaned
    )) ||
    (entry.status === 'bound' && (
      carriesCompleted || carriesExpired || carriesOrphaned
    )) ||
    (entry.status === 'completed' && (carriesExpired || carriesOrphaned)) ||
    (entry.status === 'expired' && (carriesCompleted || carriesOrphaned)) ||
    (entry.status === 'orphaned' && (carriesBound || carriesCompleted || carriesExpired))
  ) return false;
  return true;
}

function validLaunchGenerationEnvelope(record, host) {
  if (!generationAwareIntent(record)) return true;
  // 2.24.10 can transition an in-flight generation-less record written by an
  // older release. The writer necessarily adds a generation timeline, but it
  // cannot add the old record's absent HMAC seed (or generation-only ancestry).
  // That one-generation hybrid is the only seedless generation shape accepted;
  // every intent prepared by the HMAC implementation itself carries a seed.
  const upgradedLegacyLaunch = upgradedLegacyGenerationRecord(record);
  if (
    (!LAUNCH_SEED_PATTERN.test(record.launch_seed ?? '') && !upgradedLegacyLaunch) ||
    !Number.isSafeInteger(record.launch_generation) ||
    record.launch_generation < 1 ||
    record.launch_generation > 1_000_000 ||
    !Array.isArray(record.launch_generations) ||
    record.launch_generations.length < 1 ||
    record.launch_generations.length > DISPATCH_LAUNCH_GENERATION_LIMIT ||
    record.launch_generations.some((entry) =>
      !validLaunchGenerationEntry(entry, record, host, upgradedLegacyLaunch)) ||
    new Set(record.launch_generations.map((entry) => entry.generation)).size !==
      record.launch_generations.length ||
    Math.max(...record.launch_generations.map((entry) => entry.generation)) !==
      record.launch_generation
  ) return false;

  const current = record.launch_generations.filter(
    (entry) => entry.generation === record.launch_generation,
  );
  if (current.length !== 1) return false;
  const generation = current[0];
  const expectedStatuses = record.status === 'launched'
    ? ['authorized']
    : record.status === 'expired'
      ? ['expired', 'orphaned']
      : [record.status];
  if (
    !expectedStatuses.includes(generation.status) ||
    generation.prepared_at !== record.prepared_at ||
    generation.expires_at !== record.expires_at ||
    launchCapabilityHash(generation, host) !== launchCapabilityHash(record, host) ||
    (generation.turn_id_hash ?? null) !== (record.turn_id_hash ?? null)
  ) return false;
  if ((generation.bootstrap_protocol ?? null) !== (record.bootstrap_protocol ?? null) ||
      (generation.bootstrap_capability_hash ?? null) !== (record.bootstrap_capability_hash ?? null)) return false;
  if (record.bootstrap_protocol === 1 && ['authorized', 'launched', 'bound', 'completed'].includes(record.status) &&
      ['parent_session_id', 'tool_use_id', 'launched_at', 'binding_agent_type', 'requested_model']
        .some((key) => generation[key] !== record[key])) return false;
  if (['authorized', 'launched', 'bound', 'completed'].includes(record.status) && (
    (!upgradedLegacyLaunch && generation.authorized_at !== record.authorized_at) ||
    (!upgradedLegacyLaunch && generation.launch_expires_at !== record.launch_expires_at) ||
    (upgradedLegacyLaunch && generation.authorized_at !== undefined &&
      generation.authorized_at !== record.authorized_at) ||
    (upgradedLegacyLaunch && generation.launch_expires_at !== undefined &&
      generation.launch_expires_at !== record.launch_expires_at)
  )) return false;
  if (
    ['bound', 'completed'].includes(record.status) &&
    (!upgradedLegacyLaunch || generation.bound_at !== undefined) &&
    generation.bound_at !== record.bound_at
  ) {
    return false;
  }
  if (record.status === 'completed' && generation.completed_at !== record.completed_at) return false;
  if (record.status === 'expired') {
    const terminalAt = generation.status === 'orphaned'
      ? generation.orphaned_at
      : generation.expired_at;
    if (
      terminalAt !== record.expired_at ||
      (generation.status === 'orphaned' && record.orphaned_at !== terminalAt) ||
      (generation.status !== 'orphaned' && record.orphaned_at !== undefined)
    ) return false;
  }
  return true;
}

function validLaunchIntentAncestry(record, host, generationAware) {
  if (
    record.launch_attempts < 1 ||
    !boundedIdentity(record.requested_model, NATIVE_MODEL_MAX_CHARS[host]) ||
    !boundedIdentity(record.parent_session_id) ||
    !boundedIdentity(record.tool_use_id) ||
    !timestampNotBefore(record.launched_at, record.prepared_at) ||
    !timestampNotBefore(record.launch_expires_at, record.launched_at) ||
    Date.parse(record.launch_expires_at) > Date.parse(record.expires_at) ||
    (record.turn_id_hash !== undefined &&
      !DISPATCH_DIGEST_PATTERN.test(record.turn_id_hash ?? '')) ||
    (record.requested_reasoning_effort !== undefined &&
      !boundedIdentity(record.requested_reasoning_effort, CODEX_REASONING_EFFORT_MAX_CHARS))
  ) return false;
  if (generationAware && (
    !boundedDispatchTimestamp(record.authorized_at) ||
    record.authorized_at !== record.launched_at
  )) return false;
  if (host === 'codex' && generationAware && !boundedIdentity(record.binding_agent_type)) {
    return false;
  }
  if (host !== 'codex' && record.binding_agent_type !== undefined) return false;
  return true;
}

function validBoundIntentIdentity(record, generationAware) {
  const host = dispatchIntentHost(record);
  const boundSessionId = host === 'codex'
    ? (record.bound_session_id ?? record.parent_session_id)
    : record.parent_session_id;
  return boundedIdentity(boundSessionId) &&
    (!generationAware || host !== 'codex' || boundedIdentity(record.bound_session_id)) &&
    boundedIdentity(record.bound_agent_id) &&
    DISPATCH_DIGEST_PATTERN.test(record.capability_hash ?? '') &&
    timestampNotBefore(record.bound_at, record.launched_at);
}

// Intent JSON is durable authorization state, not an advisory cache. A
// parseable-but-partial object must never be treated as a missing intent: on
// an elapsed ticket that would let NEXT conclude the old physical worker was
// gone and prepare a replacement over the same file. Keep this discriminator
// deliberately compatible with every shipped v2 lifecycle shape: early
// Claude records may omit `host`, early Codex bound records may use the parent
// session as their bound session, and launch-generation/validation telemetry
// remains optional. The fields that identify the immutable ticket and the
// authority carried by each lifecycle state are never optional.
function validDispatchIntentRecord(record) {
  if (
    !record ||
    typeof record !== 'object' ||
    Array.isArray(record) ||
    Object.getPrototypeOf(record) !== Object.prototype ||
    record.version !== 2 ||
    !['claude', 'codex', undefined, null].includes(record.host) ||
    !boundedIdentity(record.run_id) ||
    !boundedIdentity(record.ticket_id, 2048) ||
    !DISPATCH_DIGEST_PATTERN.test(record.ticket_hash ?? '') ||
    !boundedIdentity(record.agent_type) ||
    !DISPATCH_INTENT_STATUSES.has(record.status) ||
    !boundedDispatchTimestamp(record.prepared_at) ||
    !boundedDispatchTimestamp(record.expires_at) ||
    Date.parse(record.expires_at) < Date.parse(record.prepared_at) ||
    !Number.isSafeInteger(record.launch_attempts) ||
    record.launch_attempts < 0
  ) return false;

  const host = dispatchIntentHost(record);
  const generationAware = generationAwareIntent(record);
  const modernGeneration = generationAware && !upgradedLegacyGenerationRecord(record);
  const capabilityHash = launchCapabilityHash(record, host);
  if ((record.bootstrap_protocol !== undefined || record.bootstrap_capability_hash !== undefined) && (
    host !== 'codex' || record.bootstrap_protocol !== 1 || !modernGeneration ||
    !DISPATCH_DIGEST_PATTERN.test(record.bootstrap_capability_hash ?? '')
  )) return false;
  if (record.bootstrap_invocation !== undefined) {
    const invocation = record.bootstrap_invocation;
    if (record.bootstrap_protocol !== 1 || !invocation || typeof invocation !== 'object' ||
        Array.isArray(invocation) || invocation.version !== 1 ||
        invocation.session_id !== record.bound_session_id ||
        invocation.agent_id !== record.bound_agent_id ||
        invocation.launch_generation !== record.launch_generation ||
        !DISPATCH_DIGEST_PATTERN.test(invocation.turn_id_hash ?? '') ||
        !boundedIdentity(invocation.tool_use_id) ||
        !timestampNotBefore(invocation.admitted_at, record.bound_at) ||
        !boundedIdentity(record.bootstrap_model, NATIVE_MODEL_MAX_CHARS.codex)) return false;
  }
  if (record.bootstrap_protocol === 1 && ['bound', 'completed'].includes(record.status) &&
      record.bootstrap_invocation === undefined) return false;
  if (
    !DISPATCH_DIGEST_PATTERN.test(capabilityHash ?? '') ||
    (host === 'codex' ? record.nonce_hash !== undefined : record.launch_name_hash !== undefined) ||
    (record.launch_seed !== undefined && !LAUNCH_SEED_PATTERN.test(record.launch_seed ?? '')) ||
    (record.prepared_launch_capability !== undefined && (
      !NONCE_PATTERN.test(record.prepared_launch_capability ?? '') ||
      digest(record.prepared_launch_capability) !== capabilityHash
    )) ||
    (record.codex_task_namespace !== undefined &&
      (host !== 'codex' || record.codex_task_namespace !== 'probe')) ||
    (record.injected_context_hash !== undefined &&
      (host !== 'codex' || !DISPATCH_DIGEST_PATTERN.test(record.injected_context_hash ?? ''))) ||
    (host === 'codex' && modernGeneration &&
      !DISPATCH_DIGEST_PATTERN.test(record.injected_context_hash ?? '')) ||
    !validLaunchGenerationEnvelope(record, host)
  ) return false;

  const launchFields = [
    record.parent_session_id,
    record.tool_use_id,
    record.requested_model,
    record.requested_reasoning_effort,
    record.launched_at,
    record.authorized_at,
    record.launch_expires_at,
    record.turn_id_hash,
    record.binding_agent_type,
  ];
  const boundFields = [
    record.bound_session_id,
    record.bound_agent_id,
    record.capability_hash,
    record.bound_at,
    record.agent_stopped_at,
    record.resumed_at,
    record.resume_count,
  ];
  const completionFields = [
    record.completed_at,
    record.receipt_input_hash,
    record.receipt_id,
    record.receipt_hash,
    record.receipt_recording,
  ];
  const hasLaunchAncestry = launchFields.some((value) => value !== undefined);
  const carriesBoundIdentity = boundFields.some((value) => value !== undefined);
  const carriesCompletion = completionFields.some((value) => value !== undefined);
  const carriesExpiration = record.expired_at !== undefined || record.orphaned_at !== undefined;

  if (record.status !== 'expired' && carriesExpiration) return false;

  if (record.status === 'prepared') {
    if (
      record.launch_attempts !== 0 ||
      hasLaunchAncestry ||
      carriesBoundIdentity ||
      carriesCompletion
    ) return false;
  } else if (['authorized', 'launched'].includes(record.status)) {
    if (
      !validLaunchIntentAncestry(record, host, modernGeneration) ||
      carriesBoundIdentity ||
      carriesCompletion
    ) {
      return false;
    }
  } else if (record.status === 'bound') {
    if (
      !validLaunchIntentAncestry(record, host, modernGeneration) ||
      !validBoundIntentIdentity(record, modernGeneration) ||
      carriesCompletion
    ) return false;
  } else if (record.status === 'completed') {
    if (
      !validLaunchIntentAncestry(record, host, modernGeneration) ||
      !validBoundIntentIdentity(record, modernGeneration) ||
      !carriesCompletion
    ) return false;
  }

  if (record.status === 'completed' && (
    !timestampNotBefore(record.completed_at, record.bound_at) ||
    !DISPATCH_DIGEST_PATTERN.test(record.receipt_input_hash ?? '') ||
    !boundedIdentity(record.receipt_id) ||
    !DISPATCH_DIGEST_PATTERN.test(record.receipt_hash ?? '')
  )) return false;

  // Expired records can originate from prepared, launched, or bound. When a
  // bound identity survives for the sealed orphan fence, require the complete
  // identity tuple; a never-bound expired record legitimately has none.
  if (record.status === 'expired') {
    if (
      !timestampNotBefore(record.expired_at, record.prepared_at) ||
      carriesCompletion
    ) return false;
    if (carriesBoundIdentity) {
      if (
        !validLaunchIntentAncestry(record, host, modernGeneration) ||
        !validBoundIntentIdentity(record, modernGeneration)
      ) return false;
    } else if (hasLaunchAncestry || record.launch_attempts > 0) {
      if (!validLaunchIntentAncestry(record, host, modernGeneration)) return false;
    } else if (record.launch_attempts !== 0) {
      return false;
    }
  }

  for (const key of [
    'agent_stopped_at',
    'authorized_at',
    'completed_at',
    'expired_at',
    'infrastructure_failure_at',
    'last_validation_at',
    'orphaned_at',
    'resumed_at',
  ]) {
    if (record[key] !== undefined && !boundedDispatchTimestamp(record[key])) return false;
  }
  if (
    (record.agent_stopped_at !== undefined &&
      !timestampNotBefore(record.agent_stopped_at, record.bound_at)) ||
    (record.resumed_at !== undefined &&
      !timestampNotBefore(record.resumed_at, record.bound_at)) ||
    (record.resume_count !== undefined &&
      (!Number.isSafeInteger(record.resume_count) || record.resume_count < 1)) ||
    (host !== 'codex' && record.bound_session_id !== undefined)
  ) return false;
  return true;
}

function dispatchIntentEvidenceError(kind, cause = undefined) {
  return new Error(
    `dispatch intent ${kind} is unreadable or structurally invalid; abort the active run to revoke and quarantine it`,
    cause === undefined ? undefined : { cause },
  );
}

async function readCanonicalIntent(paths, ticketId) {
  let current;
  try {
    await dispatchIntentContainer(paths);
    current = await readDispatchIntentArtifact(intentPath(paths, ticketId), {
      allowMissing: true,
    });
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw dispatchIntentEvidenceError('artifact', error);
  }
  if (
    current !== null &&
    (!validDispatchIntentRecord(current) || current.ticket_id !== ticketId)
  ) {
    throw dispatchIntentEvidenceError('artifact');
  }
  return current;
}

async function quarantineDispatchIntentContainer(paths) {
  const quarantinePath = `${paths.dispatchIntents}.corrupt-${Date.now()}-${randomBytes(8).toString('hex')}`;
  try {
    await rename(paths.dispatchIntents, quarantinePath);
    return quarantinePath;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function quarantineDispatchIntentEntry(file, ordinal = 1) {
  const quarantineFile = `${file}.corrupt-${Date.now()}-${ordinal}-${randomBytes(8).toString('hex')}`;
  try {
    await rename(file, quarantineFile);
    return quarantineFile;
  } catch (error) {
    // Disappearance is already a revocation from the canonical reader
    // namespace. Any other failure must remain loud and fail closed.
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

// An explicit pre-run probe is an audited maintenance boundary: there is no
// active worker authority to preserve, while malformed stale intent bytes can
// otherwise make the production-path probe impossible to launch. Move only
// malformed/non-canonical JSON entries (or a wrong-shaped whole container)
// out of the authoritative namespace. The bytes are retained for forensics.
export async function recoverStaleDispatchIntentEvidence(paths) {
  return withDispatchLock(paths, async () => {
    const quarantined = [];
    let metadata;
    try {
      metadata = await lstat(paths.dispatchIntents);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        await dispatchIntentContainer(paths, { create: true });
        return quarantined;
      }
      const moved = await quarantineDispatchIntentContainer(paths);
      if (moved) quarantined.push(moved);
      await dispatchIntentContainer(paths, { create: true });
      return quarantined;
    }
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      const moved = await quarantineDispatchIntentContainer(paths);
      if (moved) quarantined.push(moved);
      await dispatchIntentContainer(paths, { create: true });
      return quarantined;
    }
    let names;
    try {
      names = await readdir(paths.dispatchIntents);
    } catch {
      const moved = await quarantineDispatchIntentContainer(paths);
      if (moved) quarantined.push(moved);
      await dispatchIntentContainer(paths, { create: true });
      return quarantined;
    }
    let ordinal = 0;
    for (const name of names.sort()) {
      if (!name.endsWith('.json')) continue;
      const file = path.join(paths.dispatchIntents, name);
      let record;
      try {
        record = await readDispatchIntentArtifact(file);
      } catch {
        record = null;
      }
      if (
        validDispatchIntentRecord(record) &&
        name === `${digest(record.ticket_id)}.json`
      ) continue;
      ordinal += 1;
      const moved = await quarantineDispatchIntentEntry(file, ordinal);
      if (moved) quarantined.push(moved);
    }
    return quarantined;
  });
}

function intentMatchesHost(record, host) {
  // Records created before Codex binding support shipped had no host field
  // and were necessarily Claude records. Keep those resumable after upgrade.
  return record?.host === host || (host === 'claude' && record?.host == null);
}

function exactPreparedLaunchReplay(record, ticket, host) {
  if (
    record?.status !== 'prepared' ||
    (record.launch_attempts ?? 0) !== 0 ||
    expired(record.expires_at) ||
    record.run_id !== ticket?.run_id ||
    record.ticket_id !== ticket?.ticket_id ||
    record.ticket_hash !== ticket?.ticket_hash ||
    !intentMatchesHost(record, host)
  ) return false;
  const capabilityHash = host === 'codex' ? record.launch_name_hash : record.nonce_hash;
  const legacyCapability = record.prepared_launch_capability;
  const hasRecoverableAuthority = LAUNCH_SEED_PATTERN.test(record.launch_seed ?? '') || (
    NONCE_PATTERN.test(legacyCapability ?? '') && capabilityHash === digest(legacyCapability)
  );
  if (!hasRecoverableAuthority || !/^[a-f0-9]{64}$/.test(capabilityHash ?? '')) return false;
  const generation = currentLaunchGeneration(record);
  const matches = launchGenerationHistory(record).filter((entry) =>
    entry.generation === generation &&
    entry.status === 'prepared' &&
    entry.run_id === record.run_id &&
    entry.ticket_id === record.ticket_id &&
    entry.ticket_hash === record.ticket_hash &&
    entry.expires_at === record.expires_at &&
    (host === 'codex'
      ? entry.launch_name_hash === record.launch_name_hash
      : entry.nonce_hash === record.nonce_hash));
  return Number.isSafeInteger(generation) && generation > 0 && matches.length === 1;
}

function boundSessionMatches(record, sessionId, host) {
  // Pre-Multi-Agent-V2 Codex records used the parent session for both sides.
  // Prefer the child session on new records while keeping an in-flight legacy
  // binding resolvable after a plugin update.
  return (host === 'codex'
    ? (record.bound_session_id ?? record.parent_session_id)
    : record.parent_session_id) === sessionId;
}

async function nativeDispatchEvidence(paths, input, host) {
  const candidate = host === 'codex' ? await resolveCodexBootstrapCandidate(paths, input) : null;
  return {
    candidate,
    input: candidate ? {
      ...input,
      session_id: candidate.parent_session_id,
      agent_id: candidate.agent_id,
      agent_type: candidate.agent_type,
      turn_id: candidate.turn_id,
      model: candidate.model,
    } : input,
  };
}

function bootstrapTurnAuthorized(record, input, host, candidate = null) {
  if (host !== 'codex' || record.bootstrap_protocol !== 1) return true;
  const turnId = input.turn_id ?? input.turnId;
  return candidate !== null && boundedIdentity(turnId) &&
    candidate.parent_session_id === record.bound_session_id && candidate.agent_id === record.bound_agent_id &&
    record.bootstrap_invocation?.turn_id_hash === digest(turnId) && candidate.model === record.bootstrap_model;
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

// The immutable ticket deadline still governs every ordinary dispatch. The
// only exception is the one physical receipt-repair worker authorized after an
// observed first-worker stop caused by validation exhaustion. Pre-upgrade
// interrupted records use the same compatibility path. Its proof is split across durable run state and
// the freshly prepared intent so neither side can widen the other: the same
// ticket remains pending and byte-identical, settlement marked that ticket for
// redispatch, the intent seals which boundary was observed, and this is
// physical worker two carrying the original deadline alongside a new bounded
// host-dispatch horizon.
function activeReceiptProtocolRecovery(state, ticket, record) {
  const validationExhaustionRecovery = Boolean(
    record?.receipt_validation_exhaustions === 1 &&
    (state?.receipt_contract_exhaustions?.[ticket?.ticket_id] ?? 0) === 1
  );
  const budgetInterruptedRecovery = record?.receipt_budget_interrupted_recovery === true;
  return Boolean(
    ticket?.receipt_contract_version === 1 &&
    record?.receipt_protocol_recovery === true &&
    record?.physical_worker_dispatches === RECEIPT_MAX_PHYSICAL_WORKERS_PER_TICKET &&
    record?.immutable_ticket_deadline_at === ticket.deadline_at &&
    Array.isArray(state?.receipt_contract_pending_redispatches) &&
    state.receipt_contract_pending_redispatches.includes(ticket.ticket_id) &&
    (validationExhaustionRecovery || budgetInterruptedRecovery)
  );
}

// Same shared dir lock as the receipt-effects writer, with dispatch-scale
// constants. The heartbeat matters here too: intent writes normally finish in
// milliseconds, but a holder suspended or I/O-stalled past LOCK_STALE_MS used
// to get stolen while alive, letting two writers race the same intent file
// (an expired capability could resurrect under last-writer-wins).
async function withDispatchLock(paths, callback) {
  // The lock itself is a write. Prove `.ape/runtime` is a real in-root
  // directory before withDirLock can create anything beneath it.
  await governedDispatchRuntime(paths, { create: true });
  return withDirLock(paths.dispatchLock, callback, {
    staleMs: LOCK_STALE_MS,
    heartbeatMs: LOCK_HEARTBEAT_MS,
    busyMs: LOCK_WAIT_MS,
    serializeLocal: true,
    busyMessage: 'Claude dispatch binding is busy; retry the native tool call',
  });
}

async function readIntents(paths, { tolerateCorrupt = false } = {}) {
  try {
    await governedDispatchRuntime(paths);
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    if (tolerateCorrupt) {
      return [{
        file: paths.dispatchIntents,
        record: null,
        evidence_unreadable: true,
      }];
    }
    throw dispatchIntentEvidenceError('directory', error);
  }
  let directoryMetadata;
  try {
    directoryMetadata = await lstat(paths.dispatchIntents);
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    if (tolerateCorrupt) {
      return [{
        file: paths.dispatchIntents,
        record: null,
        evidence_unreadable: true,
      }];
    }
    throw dispatchIntentEvidenceError('directory', error);
  }
  if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()) {
    if (tolerateCorrupt) {
      return [{
        file: paths.dispatchIntents,
        record: null,
        evidence_unreadable: true,
      }];
    }
    throw dispatchIntentEvidenceError('directory');
  }
  let names;
  try {
    names = await readdir(paths.dispatchIntents);
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    if (tolerateCorrupt) {
      return [{
        file: paths.dispatchIntents,
        record: null,
        evidence_unreadable: true,
      }];
    }
    throw dispatchIntentEvidenceError('directory', error);
  }
  const records = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(paths.dispatchIntents, name);
    let record;
    try {
      record = await readDispatchIntentArtifact(file);
    } catch (error) {
      // Status is a capability-free diagnostic projection. One damaged intent
      // must not hide the global typed observation written when the strict
      // binder encountered that damage. Security-sensitive launch, bind, and
      // receipt paths keep the strict default and still fail closed.
      if (tolerateCorrupt) {
        records.push({ file, record: null, evidence_unreadable: true });
        continue;
      }
      throw dispatchIntentEvidenceError('artifact', error);
    }
    if (
      !validDispatchIntentRecord(record) ||
      name !== `${digest(record.ticket_id)}.json`
    ) {
      // The read-only status surface may omit damaged evidence, but every
      // lifecycle path keeps the strict default and therefore stops before a
      // reducer can authorize replacement work or a writer can overwrite it.
      if (tolerateCorrupt) {
        records.push({ file, record: null, evidence_unreadable: true });
        continue;
      }
      throw dispatchIntentEvidenceError('artifact');
    }
    records.push({ file, record });
  }
  return records;
}

function makeSubagentStartObservation(outcome, code, at = Date.now()) {
  if (!SUBAGENT_START_OUTCOMES.has(outcome) || !SUBAGENT_START_CODES.has(code)) {
    throw new Error('invalid SubagentStart diagnostic outcome');
  }
  return Object.freeze({
    observed_at: iso(at),
    outcome,
    code,
  });
}

function appendSubagentStartObservation(current, observation) {
  const prior = current?.version === SUBAGENT_START_DIAGNOSTIC_VERSION &&
    Array.isArray(current.observations)
    ? current.observations.slice(-SUBAGENT_START_OBSERVATION_LIMIT)
      .filter((entry) =>
        entry &&
        typeof entry.observed_at === 'string' &&
        entry.observed_at.length <= 32 &&
        Number.isFinite(Date.parse(entry.observed_at)) &&
        SUBAGENT_START_OUTCOMES.has(entry.outcome) &&
        SUBAGENT_START_CODES.has(entry.code))
      // Retained telemetry is reconstructed, not merely validated. A damaged
      // or legacy record cannot smuggle native identities, free-form reasons,
      // or unbounded extra fields into the next otherwise-safe write.
      .map((entry) => ({
        observed_at: entry.observed_at,
        outcome: entry.outcome,
        code: entry.code,
      }))
    : [];
  const total = Number.isSafeInteger(current?.total) && current.total >= 0
    ? Math.min(Number.MAX_SAFE_INTEGER, current.total + 1)
    : 1;
  return {
    version: SUBAGENT_START_DIAGNOSTIC_VERSION,
    total,
    observations: [...prior, observation].slice(-SUBAGENT_START_OBSERVATION_LIMIT),
  };
}

function withSubagentStartObservation(record, observation) {
  return {
    ...record,
    subagent_start_diagnostics: appendSubagentStartObservation(
      record?.subagent_start_diagnostics,
      observation,
    ),
  };
}

async function recordGlobalSubagentStartObservationLocked(paths, state, host, observation) {
  const file = subagentStartDiagnosticPath(paths);
  const runHash = digest(typeof state?.run_id === 'string' ? state.run_id : 'unresolved-run');
  const current = await readSubagentStartDiagnostics(paths);
  const sameRun = current?.version === SUBAGENT_START_DIAGNOSTIC_VERSION &&
    current.run_hash === runHash &&
    current.host === host;
  await atomicWriteJson(file, {
    version: SUBAGENT_START_DIAGNOSTIC_VERSION,
    run_hash: runHash,
    host,
    ...appendSubagentStartObservation(sameRun ? current : null, observation),
  });
}

// The hook calls this only when a SubagentStart compatibility branch or an
// unexpected exception prevents the ordinary binder from recording directly
// on a unique intent. The projection is deliberately identity-free: no native
// session/agent id, ticket id, free-form reason, or exception text is written.
export async function recordCodexSubagentStartOutcome(paths, state, outcome, code) {
  const observation = makeSubagentStartObservation(outcome, code);
  return withDispatchLock(paths, async () => {
    await recordGlobalSubagentStartObservationLocked(paths, state, 'codex', observation);
    return observation;
  });
}

function projectSubagentStartDiagnostics(record, globalDiagnostics, earliestAt = null) {
  const local = record?.subagent_start_diagnostics;
  const source = local?.version === SUBAGENT_START_DIAGNOSTIC_VERSION &&
    Array.isArray(local.observations) &&
    local.observations.length > 0
    ? local
    : globalDiagnostics;
  const observation = source?.observations?.at(-1) ?? null;
  const boundedObservedAt =
    typeof observation?.observed_at === 'string' && observation.observed_at.length <= 32;
  const observedMs = boundedObservedAt ? Date.parse(observation.observed_at) : Number.NaN;
  const earliestMs = Date.parse(earliestAt ?? '');
  const usable = observation &&
    Number.isFinite(observedMs) &&
    (!Number.isFinite(earliestMs) || observedMs >= earliestMs) &&
    SUBAGENT_START_OUTCOMES.has(observation.outcome) &&
    SUBAGENT_START_CODES.has(observation.code);
  if (usable) {
    return {
      state: observation.outcome === 'accepted'
        ? 'accepted'
        : observation.outcome === 'error'
          ? 'error'
          : 'rejected',
      observed_at: observation.observed_at,
      code: observation.code,
      attempt_count: Number.isSafeInteger(source.total) ? source.total : 1,
    };
  }
  if (
    record?.status === 'bound' &&
    typeof record.bound_at === 'string' &&
    record.bound_at.length <= 32 &&
    Number.isFinite(Date.parse(record.bound_at))
  ) {
    // Compatibility for records bound before typed observations shipped.
    return {
      state: 'accepted',
      observed_at: record.bound_at,
      code: 'bound',
      attempt_count: 1,
    };
  }
  return {
    state: 'not_observed',
    observed_at: null,
    code: null,
    attempt_count: 0,
  };
}

// status.md is a bounded derived view. Dispatch intent files and active.json
// remain authoritative, so a projection/read/write failure must never change
// the result of the lifecycle transition that already persisted its truth.
async function refreshDispatchStatusDoc(paths, runId, dispatchState) {
  try {
    // Even a best-effort projection uses the bounded ownership reader so it
    // cannot block on or follow a replaced active file.
    const state = await activeState(paths);
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
export async function dispatchIntentStatuses(paths, state, { tolerateCorrupt = false } = {}) {
  if (!state || !['claude', 'codex'].includes(state.host)) return [];
  const receipted = new Set((state.receipts ?? []).map((receipt) => receipt.ticket_id));
  const expiredTickets = new Set(state.expired_tickets ?? []);
  const pendingIds = (state.tickets ?? [])
    .map((ticket) => ticket.ticket_id)
    .filter((ticketId) => !receipted.has(ticketId) && !expiredTickets.has(ticketId));
  if (pendingIds.length === 0) return [];
  // Lifecycle consumers use the strict default: a torn live intent is not
  // evidence that its native worker disappeared, so treating it as `missing`
  // could authorize an overlapping dispatch. Status is the sole tolerant
  // projection and opts in explicitly; it may omit the damaged record while
  // the authoritative paths continue to fail closed on the same bytes.
  const records = await readIntents(paths, { tolerateCorrupt });
  const globalRecord = await readSubagentStartDiagnostics(paths);
  const globalDiagnostics = globalRecord?.version === SUBAGENT_START_DIAGNOSTIC_VERSION &&
    globalRecord.run_hash === digest(state.run_id) &&
    globalRecord.host === state.host
    ? globalRecord
    : null;
  // Any unreadable JSON artifact wedges the strict lifecycle reader, even if
  // its damaged fields no longer reveal which pending ticket it belonged to.
  // Project that global evidence failure explicitly for every pending ticket;
  // calling it `missing` would falsely suggest RESUME can safely redispatch.
  if (records.some((entry) => entry.evidence_unreadable === true)) {
    return pendingIds.map((ticketId) => ({
      ticket_id: ticketId,
      status: 'corrupt',
      agent_state: 'evidence-unreadable',
      evidence_unreadable: true,
      launch_attempts: 0,
      binding_observation: projectSubagentStartDiagnostics(null, globalDiagnostics),
    }));
  }
  return pendingIds.map((ticketId) => {
    const matches = records.filter(({ record }) =>
      record.run_id === state.run_id && record.ticket_id === ticketId && intentMatchesHost(record, state.host));
    if (matches.length !== 1) {
      return {
        ticket_id: ticketId,
        status: matches.length === 0 ? 'missing' : 'ambiguous',
        launch_attempts: 0,
        binding_observation: projectSubagentStartDiagnostics(null, globalDiagnostics),
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
      receipt_validation_exhaustions: record.receipt_validation_exhaustions ?? 0,
      physical_worker_dispatches: record.physical_worker_dispatches
        ?? (record.receipt_contract_version === 1 ? 1 : null),
      receipt_validation_exhausted: record.receipt_validation?.exhausted === true,
      receipt_validation_valid: typeof record.receipt_validation?.last_result?.valid === 'boolean'
        ? record.receipt_validation.last_result.valid
        : null,
      receipt_continuation_blocked: record.receipt_validation?.continuation_blocked?.code ?? null,
      expires_at: record.expires_at ?? null,
      binding_observation: projectSubagentStartDiagnostics(
        record,
        record.status === 'bound' || record.status === 'completed' ? null : globalDiagnostics,
        record.launched_at ?? record.prepared_at ?? null,
      ),
    };
  });
}

// SubagentStop is the one host lifecycle event that proves the physical
// native agent ended. Persist only that non-secret observation on the unique
// bound/completed intent; never copy transcript paths, result prose, or host
// identities beyond the fields already sealed by binding. Status and NEXT use
// this stamp to avoid treating a deadline as proof of process termination.
async function observeDispatchSubagentStop(paths, state, input, host) {
  input = (await nativeDispatchEvidence(paths, input, host)).input;
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

// Read-only twin of observeDispatchSubagentStop. The hook uses this before it
// decides whether an invalid final draft should keep the worker alive; only an
// allowed stop advances to the stamping function above.
export async function inspectDispatchSubagentStop(paths, state, input, host) {
  const evidence = await nativeDispatchEvidence(paths, input, host);
  input = evidence.input;
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
      bootstrapTurnAuthorized(record, input, host, evidence.candidate) &&
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
    return { observed: true, record: matches[0].record, reason: 'native agent stop identity resolved' };
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

async function prepareDispatchIntent(paths, ticket, agentType, host, options = {}) {
  const ticketModel = ticket?.model?.model;
  const modelMax = NATIVE_MODEL_MAX_CHARS[host];
  if (
    (
      typeof ticketModel !== 'string' ||
      ticketModel.length === 0 ||
      ticketModel.length > modelMax
    )
  ) {
    throw new Error(`${hostLabel(host)} dispatch ticket carries an invalid model`);
  }
  const reasoningEffort = ticket?.model?.reasoning_effort;
  if (
    host === 'codex' &&
    reasoningEffort !== undefined &&
    (
      typeof reasoningEffort !== 'string' ||
      reasoningEffort.length === 0 ||
      reasoningEffort.length > CODEX_REASONING_EFFORT_MAX_CHARS
    )
  ) {
    throw new Error('Codex dispatch ticket carries an invalid reasoning effort');
  }
  if (!boundedIdentity(agentType) || !boundedIdentity(ticket.ticket_id, 2048)) {
    throw new Error(`${hostLabel(host)} dispatch intent has an invalid ticket or agent type`);
  }
  const codexTaskNamespace = options.codex_task_namespace ?? null;
  const bootstrapProtocol = options.bootstrap_protocol;
  if (bootstrapProtocol !== undefined && (host !== 'codex' || bootstrapProtocol !== 1)) {
    throw new Error('unsupported native bootstrap protocol');
  }
  if (
    codexTaskNamespace !== null &&
    (host !== 'codex' || codexTaskNamespace !== 'probe')
  ) {
    throw new Error(`${hostLabel(host)} dispatch intent carries an invalid task namespace`);
  }
  const createdAt = Date.now();
  const requestedRecoveryDeadline = options.receipt_protocol_recovery_deadline_at;
  const hasRecoveryDeadline =
    ticket.receipt_contract_version === 1 &&
    typeof requestedRecoveryDeadline === 'string' &&
    Number.isFinite(Date.parse(requestedRecoveryDeadline));
  let preparedRecord = null;
  let launchKey = null;
  await withDispatchLock(paths, async () => {
    // Validate the authority container before deriving a path or writing a
    // temp file. In particular, never let a repository-controlled symlink
    // redirect an intent outside this runtime root.
    await dispatchIntentContainer(paths, { create: true });
    const file = intentPath(paths, ticket.ticket_id);
    const current = await readCanonicalIntent(paths, ticket.ticket_id);
    const currentExpiry =
      ['authorized', 'launched'].includes(current?.status) ? current.launch_expires_at :
      current?.expires_at;
    if (
      current &&
      !expired(currentExpiry) &&
      ['authorized', 'launched', 'bound'].includes(current.status)
    ) {
      const status = current.status === 'authorized' ? 'launched' : current.status;
      throw new Error(`${hostLabel(host)} dispatch for ${ticket.ticket_id} is already ${status}`);
    }
    const priorValidationExhaustions = current?.receipt_validation_exhaustions
      ?? current?.receipt_validation?.exhaustion_count
      ?? 0;
    const priorBudgetInterruptedStop = Boolean(
      current?.agent_stopped_at &&
      current?.receipt_validation?.last_result?.valid === false &&
      current?.receipt_validation?.exhausted !== true &&
      typeof current?.receipt_validation?.continuation_blocked?.code === 'string'
    );
    const priorPhysicalWorkers = ticket.receipt_contract_version === 1 && current
      ? (current.physical_worker_dispatches ?? 1)
      : 0;
    const reprepareUnlaunched =
      options.allow_prepared_replay === true &&
      exactPreparedLaunchReplay(current, ticket, host);
    if (
      current?.status === 'prepared' &&
      !expired(current.expires_at) &&
      !reprepareUnlaunched
    ) {
      throw new Error(`${hostLabel(host)} dispatch for ${ticket.ticket_id} is already prepared`);
    }
    if (reprepareUnlaunched) {
      if ((current.bootstrap_protocol ?? null) !== (bootstrapProtocol ?? null)) {
        throw new Error('prepared dispatch bootstrap protocol cannot change on replay');
      }
      // The existing bytes are the authority. Reusing them avoids replacing
      // the generation, capability, timestamps, or physical-worker charge.
      preparedRecord = current;
      launchKey = await dispatchLaunchKey(paths);
      return;
    }
    const physicalWorkerDispatches = ticket.receipt_contract_version === 1
      ? (reprepareUnlaunched ? Math.max(1, priorPhysicalWorkers) : priorPhysicalWorkers + 1)
      : null;
    if (
      ticket.receipt_contract_version === 1 &&
      physicalWorkerDispatches > RECEIPT_MAX_PHYSICAL_WORKERS_PER_TICKET
    ) {
      throw new Error(`${hostLabel(host)} dispatch for ${ticket.ticket_id} exhausted its physical receipt-validation workers`);
    }
    const priorGeneration = currentLaunchGeneration(current);
    let generations = launchGenerationHistory(current);
    if (
      current &&
      ['authorized', 'launched'].includes(current.status) &&
      expired(current.launch_expires_at ?? current.expires_at)
    ) {
      generations = withLaunchGenerationStatus(current, 'orphaned', {
        orphaned_at: iso(createdAt),
      }).launch_generations;
    }
    const generation = reprepareUnlaunched
      ? Math.max(1, priorGeneration)
      : priorGeneration + 1;
    launchKey = await dispatchLaunchKey(paths);
    const launchSeed = randomBytes(32).toString('hex');
    const launchCapability = derivedLaunchCapability(
      launchKey,
      host,
      ticket,
      launchSeed,
      codexTaskNamespace,
    );
    const baseRecord = {
      version: 2,
      host,
      run_id: ticket.run_id,
      ticket_id: ticket.ticket_id,
      ticket_hash: ticket.ticket_hash,
      ...(ticket.receipt_contract_version === 1
        ? {
            receipt_contract_version: 1,
            receipt_output_schema_hash: ticket.capability_manifest?.receipt_schema?.hash,
          }
        : {}),
      agent_type: agentType,
      ...(host === 'claude'
        ? { nonce_hash: digest(launchCapability) }
        : { launch_name_hash: digest(launchCapability) }),
      // Public random salt only. The bearer is re-derived with the separately
      // protected project key after response/process loss and is never stored
      // in this intent.
      launch_seed: launchSeed,
      ...(bootstrapProtocol === 1 ? {
        bootstrap_protocol: 1,
        bootstrap_capability_hash: digest(derivedBootstrapCapability(launchKey, ticket, launchSeed)),
      } : {}),
      ...(codexTaskNamespace ? { codex_task_namespace: codexTaskNamespace } : {}),
      ...(host === 'codex'
        ? { injected_context_hash: digest(codexInjectedDispatchContext(ticket)) }
        : {}),
      status: 'prepared',
      prepared_at: iso(createdAt),
      expires_at: hasRecoveryDeadline ? requestedRecoveryDeadline : ticket.deadline_at,
      launch_attempts: 0,
    };
    const record = {
      ...baseRecord,
      launch_generation: generation,
      launch_generations: [
        ...generations.filter((entry) => entry.generation !== generation),
        launchGenerationEntry(baseRecord, generation, 'prepared'),
      ],
      ...(physicalWorkerDispatches !== null ? { physical_worker_dispatches: physicalWorkerDispatches } : {}),
      ...(priorValidationExhaustions > 0
        ? { receipt_validation_exhaustions: priorValidationExhaustions }
        : {}),
      ...(hasRecoveryDeadline && physicalWorkerDispatches === 2 &&
          (priorValidationExhaustions === 1 || priorBudgetInterruptedStop)
        ? {
            receipt_protocol_recovery: true,
            immutable_ticket_deadline_at: ticket.deadline_at,
            ...(priorBudgetInterruptedStop
              ? { receipt_budget_interrupted_recovery: true }
              : {}),
          }
        : {}),
    };
    await atomicWriteJson(file, record);
    preparedRecord = record;
  });
  const durablePreparedRecord = preparedRecord;
  const durableLaunchKey = launchKey;
  if (durablePreparedRecord === null || durableLaunchKey === null) {
    throw new Error(`${hostLabel(host)} dispatch preparation did not produce durable launch authority`);
  }
  await refreshDispatchStatusDoc(paths, ticket.run_id, 'pending');
  const preparedLaunchCapability = durablePreparedRecord.prepared_launch_capability ??
    derivedLaunchCapability(
      durableLaunchKey,
      host,
      ticket,
      durablePreparedRecord.launch_seed,
      durablePreparedRecord.codex_task_namespace ?? null,
    );
  const expectedPreparedCapabilityHash = host === 'codex'
    ? durablePreparedRecord.launch_name_hash
    : durablePreparedRecord.nonce_hash;
  if (
    !NONCE_PATTERN.test(preparedLaunchCapability ?? '') ||
    expectedPreparedCapabilityHash !== digest(preparedLaunchCapability)
  ) {
    throw new Error(`${hostLabel(host)} prepared dispatch lacks its exact durable launch authority`);
  }
  const prompt = host === 'claude'
    ? [
        `Execute the immutable APE StageTicket ${ticket.ticket_id}.`,
        `APE_DISPATCH_NONCE=${preparedLaunchCapability}`,
      ].join('\n')
    : `Execute the immutable APE StageTicket ${ticket.ticket_id}.`;
  if (durablePreparedRecord.bootstrap_protocol === 1) {
    const bootstrapCapability = derivedBootstrapCapability(
      durableLaunchKey, ticket, durablePreparedRecord.launch_seed,
    );
    if (digest(bootstrapCapability) !== durablePreparedRecord.bootstrap_capability_hash) {
      throw new Error('Codex prepared bootstrap lacks its exact durable authority');
    }
    return {
      agent_name: preparedLaunchCapability,
      bootstrap_protocol: 1,
      bootstrap_capability: bootstrapCapability,
      bootstrap_args: { project_dir: paths.root, bootstrap_capability: bootstrapCapability },
      prompt: [
        '1. Execute this assigned bootstrap now. Before binding, authoritative ticket/receipt context is expected to be absent. Do not stop for that absence. Tool discovery and ape_bind are permitted bootstrap operations, not stage work.',
        'If that tool is not visible, you may first make at most one bounded host tool-catalog search (such as tool_search.tool_search_tool) using only the literal registered tool name ape_bind, not a host-qualified invocation alias. Never include the bootstrap capability, project path, or task data in the search.',
        'If the host exposes tools through functions.exec, that wrapper is permitted only to inspect exact-matching ALL_TOOLS metadata for ape_bind or invoke that one installed tool. This does not permit functions.exec_command, shell commands, or executing APE through a shell.',
        'Before trusted bootstrap context, do not inspect or modify the project, access files, do stage work, or call any other MCP tool. If the exact installed tool cannot be found, stop.',
        '2. Your first APE operation must be the installed ape_bind tool, called once with the exact arguments below. Invoke the returned namespace/function from the installed APE server (currently mcp__ape.ape_bind; normalized alias mcp__ape__ape_bind), never a similarly named tool from another plugin.',
        JSON.stringify({ project_dir: paths.root, bootstrap_capability: bootstrapCapability }),
        '3. Only AFTER ape_bind returns, check for complete authoritative ticket and receipt context injected by its authenticated hook. If missing then, stop without stage work. Otherwise execute only the work authorized by that injected context.',
      ].join('\n'),
    };
  }
  // Claude's established public seam exposes these convenience mirrors.
  // Codex keeps the wire minimal because the one-time launch capability rides
  // in agent_name/task_name; Multi-Agent V2 encrypts prompt/message before the
  // PreToolUse boundary. The complete record remains persisted for both hosts.
  return host === 'claude'
    ? { nonce: preparedLaunchCapability, expires_at: durablePreparedRecord.expires_at, prompt }
    : { prompt, agent_name: preparedLaunchCapability };
}

export async function prepareClaudeIntent(paths, ticket, agentType, options = {}) {
  return prepareDispatchIntent(paths, ticket, agentType, 'claude', options);
}

export async function prepareCodexIntent(paths, ticket, agentType, options = {}) {
  return prepareDispatchIntent(paths, ticket, agentType, 'codex', options);
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
    const current = await readCanonicalIntent(paths, ticketId);
    if (!current) return current;
    if (current.status === 'expired') return current;
    const expiredAt = iso();
    const voided = {
      ...withLaunchGenerationStatus(current, 'expired', { expired_at: expiredAt }),
      status: 'expired',
    };
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
    const voided = [];
    let directoryMetadata;
    try {
      directoryMetadata = await lstat(paths.dispatchIntents);
    } catch (error) {
      if (error?.code === 'ENOENT') return voided;
      await quarantineDispatchIntentContainer(paths);
      return voided;
    }
    if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()) {
      await quarantineDispatchIntentContainer(paths);
      return voided;
    }
    let names;
    try {
      names = await readdir(paths.dispatchIntents);
    } catch (error) {
      if (error?.code === 'ENOENT') return voided;
      await quarantineDispatchIntentContainer(paths);
      return voided;
    }
    let quarantineOrdinal = 0;
    for (const name of names.sort()) {
      if (!name.endsWith('.json')) continue;
      const file = path.join(paths.dispatchIntents, name);
      let record;
      try {
        record = await readDispatchIntentArtifact(file);
      } catch {
        record = null;
      }
      if (
        !validDispatchIntentRecord(record) ||
        name !== `${digest(record.ticket_id)}.json`
      ) {
        // ABORT/override-abort is the audited fail-safe for unreadable dispatch
        // evidence. We cannot trust a damaged record's run_id, status, or
        // bearer fields, so revoke it by atomically moving its canonical JSON
        // path out of the reader namespace. The inert bytes remain beside the
        // intent directory for forensics; no capability can resolve through a
        // `.corrupt-*` name after this point. Quarantine all malformed JSON
        // here because one active run owns this directory and strict readers
        // cannot prove any malformed artifact belongs elsewhere.
        quarantineOrdinal += 1;
        // Include an unpredictable component so a pre-created destination
        // cannot make POSIX rename replace unrelated forensic evidence.
        await quarantineDispatchIntentEntry(file, quarantineOrdinal);
        continue;
      }
      if (record.run_id !== runId) continue;
      if (['expired', 'completed'].includes(record.status)) continue;
      const expiredAt = iso();
      const next = {
        ...withLaunchGenerationStatus(record, 'expired', { expired_at: expiredAt }),
        status: 'expired',
      };
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
      await dispatchIntentContainer(paths);
      names = await readdir(paths.dispatchIntents);
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
    const pruned = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const file = path.join(paths.dispatchIntents, name);
      let record;
      try {
        record = await readDispatchIntentArtifact(file);
      } catch {
        record = null;
      }
      const canonical = validDispatchIntentRecord(record) &&
        name === `${digest(record.ticket_id)}.json`;
      if (canonical && record.run_id === keepRunId) continue;
      if (!canonical) {
        await quarantineDispatchIntentEntry(file, pruned.length + 1);
        pruned.push(name);
        continue;
      }
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
  const turnId = input.turn_id ?? input.turnId;
  // Third container matches bin/ape-hook.mjs's own DETECTION priority order
  // (its own `toolInput` local, feeding isApeLaunch) — without it, a launch
  // whose tool input arrives shaped {tool_name, input: {...}} is DETECTED as
  // an APE launch there (isApeLaunch reads the same third container) but
  // re-derives agentType/nonce here from only the first two, so the payload
  // that triggered this very call always reads as malformed and the launch
  // can only ever be denied.
  const toolInput =
    input.tool_input ?? input.toolInput ?? input.input ?? input.toolCall?.args ?? {};
  const subagentPrompt = Array.isArray(toolInput.Subagents) ? toolInput.Subagents[0]?.Prompt : null;
  const rawPrompt = toolInput.prompt ?? toolInput.message ?? subagentPrompt;
  const subagentType = Array.isArray(toolInput.Subagents) ? toolInput.Subagents[0]?.TypeName : null;
  const suppliedAgentType =
    toolInput.subagent_type ?? toolInput.subagentType ?? toolInput.agent_type ?? toolInput.agentType ?? subagentType;
  const nonce = host === 'claude' ? extractNonce(rawPrompt) : null;
  const taskName = toolInput.task_name ?? toolInput.taskName;
  const forkTurns = toolInput.fork_turns ?? toolInput.forkTurns;
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
  if (host === 'codex' && forkTurns !== 'none') {
    return {
      valid: false,
      reason: "APE Codex launch denied: fork_turns must be exactly 'none'; pass dispatch.spawn_args unchanged",
    };
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
    // Validate the host-observed model request before EVERY acceptance path,
    // including an authorized/launched replay after a lost tool response. A
    // retry is idempotent only when its execution parameters are unchanged;
    // it cannot omit or swap the model/effort while reusing the original
    // session + tool-call identity.
    const requestedModel =
      typeof toolInput.model === 'string' &&
      boundedIdentity(toolInput.model, NATIVE_MODEL_MAX_CHARS[host])
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
      typeof (toolInput.reasoning_effort ?? toolInput.reasoningEffort) === 'string' &&
      boundedIdentity(
        toolInput.reasoning_effort ?? toolInput.reasoningEffort,
        CODEX_REASONING_EFFORT_MAX_CHARS,
      )
        ? (toolInput.reasoning_effort ?? toolInput.reasoningEffort)
        : null;
    const ticketReasoningEffort = ticket?.model?.reasoning_effort ?? null;
    if (host === 'codex' && requestedReasoningEffort !== ticketReasoningEffort) {
      return {
        valid: false,
        reason: `APE Codex launch denied: requested reasoning effort ${requestedReasoningEffort ?? '(absent)'} does not satisfy the ticket effort ${ticketReasoningEffort ?? '(unset)'}`,
      };
    }
    const receiptProtocolRecovery = activeReceiptProtocolRecovery(state, ticket, record);
    if (expired(record.expires_at) || (expired(ticket?.deadline_at) && !receiptProtocolRecovery)) {
      const expiredAt = iso();
      await atomicWriteJson(file, {
        ...withLaunchGenerationStatus(record, 'expired', { expired_at: expiredAt }),
        status: 'expired',
      });
      return { valid: false, reason: `APE ${label} launch denied: ticket deadline elapsed` };
    }
    if (['authorized', 'launched'].includes(record.status) && expired(record.launch_expires_at)) {
      const orphanedAt = iso();
      await atomicWriteJson(file, {
        ...withLaunchGenerationStatus(record, 'orphaned', { orphaned_at: orphanedAt }),
        status: 'expired',
        expired_at: orphanedAt,
      });
      return { valid: false, reason: `APE ${label} launch denied: launched intent expired` };
    }
    if (['authorized', 'launched'].includes(record.status)) {
      const sameInvocation =
        record.parent_session_id === sessionId &&
        record.tool_use_id === toolUseId &&
        record.agent_type === agentType &&
        intentAgentTypeMatches(record, bindingAgentType, host) &&
        record.requested_model === requestedModel &&
        (host !== 'codex' ||
          (record.requested_reasoning_effort ?? null) === requestedReasoningEffort) &&
        (!record.turn_id_hash || (
          boundedIdentity(turnId) && record.turn_id_hash === digest(turnId)
        ));
      if (sameInvocation && (
        record.status === 'authorized' ||
        (host === 'codex' && !record.binding_agent_type)
      )) {
        await atomicWriteJson(file, {
          ...record,
          status: 'launched',
          ...(host === 'codex' ? { binding_agent_type: bindingAgentType } : {}),
        });
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
      ['authorized', 'launched'].includes(other.status) &&
      intentMatchesHost(other, host) &&
      (host === 'codex' || other.parent_session_id === sessionId) &&
      intentAgentTypeMatches(other, bindingAgentType, host) &&
      !expired(other.launch_expires_at ?? other.expires_at));
    if (collision) {
      return { valid: false, reason: `APE ${label} launch denied: session and agent type collision` };
    }
    const launchedAt = Date.now();
    // Persist the requested model on the intent — the bound/completed writes
    // spread the record forward — and recordReceiptLocked stamps it into
    // receipt provenance as requested_model/requested_model_attested. A
    // PreToolUse payload attests the request, not execution, so it is never
    // recorded as the effective model.
    const { prepared_launch_capability: _consumedLaunchCapability, ...consumedRecord } = record;
    const launchPatch = {
      ...consumedRecord,
      requested_model: requestedModel,
      ...(requestedReasoningEffort ? { requested_reasoning_effort: requestedReasoningEffort } : {}),
      ...(host === 'codex' ? { binding_agent_type: bindingAgentType } : {}),
      parent_session_id: sessionId,
      tool_use_id: toolUseId,
      ...(boundedIdentity(turnId) ? { turn_id_hash: digest(turnId) } : {}),
      launched_at: iso(launchedAt),
      authorized_at: iso(launchedAt),
      launch_expires_at: iso(Math.min(Date.parse(record.expires_at), launchedAt + LAUNCH_TTL_MS)),
      launch_attempts: (record.launch_attempts ?? 0) + 1,
    };
    const authorized = withLaunchGenerationStatus(launchPatch, 'authorized', {
      authorized_at: launchPatch.authorized_at,
      launch_expires_at: launchPatch.launch_expires_at,
      ...(launchPatch.turn_id_hash ? { turn_id_hash: launchPatch.turn_id_hash } : {}),
    });
    // `authorized` is the durable security state. The second write retains the
    // historical top-level `launched` projection expected by older clients;
    // the immutable generation record remains authorized until SubagentStart.
    await atomicWriteJson(file, { ...authorized, status: 'authorized' });
    await atomicWriteJson(file, { ...authorized, status: 'launched' });
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
  const turnId = input.turn_id ?? input.turnId;
  if (!boundedIdentity(sessionId) || !boundedIdentity(agentId) || !agentTypeInputValid(agentType, host)) {
    const code = !boundedIdentity(sessionId)
      ? 'malformed_session_identity'
      : !boundedIdentity(agentId)
        ? 'malformed_agent_identity'
        : 'malformed_agent_type';
    const observation = makeSubagentStartObservation('rejected', code);
    await withDispatchLock(paths, () =>
      recordGlobalSubagentStartObservationLocked(paths, state, host, observation));
    return {
      valid: false,
      reason: `APE ${label} binding denied: malformed native identity`,
      binding_observation: observation,
    };
  }

  return withDispatchLock(paths, async () => {
    const intents = await readIntents(paths);
    const rejectBinding = async (code, reason, target = null) => {
      const observation = makeSubagentStartObservation('rejected', code);
      if (target) {
        await atomicWriteJson(
          target.file,
          withSubagentStartObservation(target.record, observation),
        );
      } else {
        await recordGlobalSubagentStartObservationLocked(paths, state, host, observation);
      }
      return { valid: false, reason, binding_observation: observation };
    };

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
      record.bootstrap_protocol !== 1 &&
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
        return rejectBinding(
          'ticket_not_pending',
          `APE ${label} binding denied: ticket is not active and pending`,
          { file, record },
        );
      }
      const receiptProtocolRecovery = activeReceiptProtocolRecovery(state, ticket, record);
      if (expired(record.expires_at) || (expired(ticket?.deadline_at) && !receiptProtocolRecovery)) {
        return rejectBinding(
          'ticket_deadline_elapsed',
          `APE ${label} binding denied: ticket deadline elapsed`,
          { file, record },
        );
      }
      let injectedContext = null;
      let resumedCapability = null;
      try {
        if (host === 'codex') {
          if (record.ticket_hash !== ticket?.ticket_hash) {
            return rejectBinding(
              'ticket_hash_mismatch',
              'APE Codex binding denied: dispatch ticket hash mismatch',
              { file, record },
            );
          }
          injectedContext = codexInjectedDispatchContext(ticket);
          if (record.injected_context_hash !== digest(injectedContext)) {
            return rejectBinding(
              'context_hash_mismatch',
              'APE Codex binding denied: authoritative context hash mismatch',
              { file, record },
            );
          }
        } else {
          injectedContext = receiptContractContext(ticket);
        }
      } catch {
        return rejectBinding(
          'context_unavailable',
          `APE ${label} binding denied: authoritative context unavailable`,
          { file, record },
        );
      }
      if (host === 'codex') {
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
      const resumedObservation = makeSubagentStartObservation('accepted', 'resumed');
      // SubagentStop is a liveness observation, not a permanent identity
      // revocation. An exact, still-authorized SubagentStart proves this same
      // physical identity is active again. Remove the old stop stamp before
      // publishing the resumed state so status/NEXT cannot mistake it for a
      // retired worker and overlap it with a retry.
      const { agent_stopped_at: _priorStop, ...activeRecord } = record;
      await atomicWriteJson(file, withSubagentStartObservation({
        ...activeRecord,
        ...(resumedCapability ? { capability_hash: digest(resumedCapability) } : {}),
        resumed_at: iso(),
        resume_count: (record.resume_count ?? 0) + 1,
      }, resumedObservation));
      return {
        valid: true,
        reason: `APE ${label} native identity re-admitted to ${record.ticket_id} after the launch window closed`,
        ticket_id: record.ticket_id,
        binding_observation: resumedObservation,
        ...(injectedContext
          ? {
              additional_context: [
                ...(resumedCapability
                  ? [
                      `APE_BOUND_CAPABILITY=${resumedCapability}`,
                      `APE_RECEIPT_CAPABILITY=${resumedCapability}`,
                      '',
                    ]
                  : []),
                injectedContext,
              ].join('\n'),
            }
          : {}),
      };
    }

    const launchedForIdentity = intents.filter(({ record }) =>
      record.run_id === state?.run_id &&
      intentMatchesHost(record, host) &&
      record.bootstrap_protocol !== 1 &&
      ['authorized', 'launched'].includes(record.status) &&
      (host === 'codex' || record.parent_session_id === sessionId) &&
      intentAgentTypeMatches(record, agentType, host) &&
      (!record.turn_id_hash || (
        boundedIdentity(turnId) && record.turn_id_hash === digest(turnId)
      )));
    for (const candidate of launchedForIdentity) {
      if (expired(candidate.record.launch_expires_at ?? candidate.record.expires_at)) {
        const orphanedAt = iso();
        await atomicWriteJson(candidate.file, {
          ...withLaunchGenerationStatus(candidate.record, 'orphaned', {
            orphaned_at: orphanedAt,
          }),
          status: 'expired',
          expired_at: orphanedAt,
        });
      }
    }
    const launched = launchedForIdentity.filter(({ record }) =>
      !expired(record.launch_expires_at ?? record.expires_at));
    if (launched.length !== 1) {
      const typeAgnostic = intents.filter(({ record }) =>
        record.run_id === state?.run_id &&
        intentMatchesHost(record, host) &&
        record.bootstrap_protocol !== 1 &&
        ['authorized', 'launched'].includes(record.status) &&
        (host === 'codex' || record.parent_session_id === sessionId) &&
        (!record.turn_id_hash || (
          boundedIdentity(turnId) && record.turn_id_hash === digest(turnId)
        )) &&
        !expired(record.launch_expires_at ?? record.expires_at));
      const code = launched.length === 0 && typeAgnostic.length === 1
        ? 'agent_type_mismatch'
        : 'no_unique_active_launched_intent';
      return rejectBinding(
        code,
        `APE ${label} binding denied: no unique active launched intent`,
      );
    }
    if (intents.some(({ record }) =>
      record.run_id === state?.run_id &&
      intentMatchesHost(record, host) &&
      record.status === 'bound' &&
      record.bound_agent_id === agentId)) {
      return rejectBinding(
        'native_identity_already_bound',
        `APE ${label} binding denied: native agent identity already bound`,
        launched[0],
      );
    }
    const { file, record } = launched[0];
    if (!pendingTicket(state, record.ticket_id)) {
      return rejectBinding(
        'ticket_not_pending',
        `APE ${label} binding denied: ticket is not active and pending`,
        { file, record },
      );
    }
    const ticket = state.tickets.find((candidate) => candidate.ticket_id === record.ticket_id);
    let injectedContext = null;
    try {
      if (host === 'codex') {
        if (record.ticket_hash !== ticket?.ticket_hash) {
          return rejectBinding(
            'ticket_hash_mismatch',
            'APE Codex binding denied: dispatch ticket hash mismatch',
            { file, record },
          );
        }
        injectedContext = codexInjectedDispatchContext(ticket);
        if (record.injected_context_hash !== digest(injectedContext)) {
          return rejectBinding(
            'context_hash_mismatch',
            'APE Codex binding denied: authoritative context hash mismatch',
            { file, record },
          );
        }
      } else {
        injectedContext = receiptContractContext(ticket);
      }
    } catch {
      return rejectBinding(
        'context_unavailable',
        `APE ${label} binding denied: authoritative context unavailable`,
        { file, record },
      );
    }
    const capability = randomBytes(32).toString('base64url');
    const boundAt = iso();
    const boundObservation = makeSubagentStartObservation('accepted', 'bound');
    const bound = withLaunchGenerationStatus({
      ...record,
      ...(host === 'codex' ? { bound_session_id: sessionId } : {}),
      bound_agent_id: agentId,
      capability_hash: digest(capability),
      bound_at: boundAt,
    }, 'bound', { bound_at: boundAt });
    await atomicWriteJson(
      file,
      withSubagentStartObservation({ ...bound, status: 'bound' }, boundObservation),
    );
    await refreshDispatchStatusDoc(paths, state?.run_id, 'live');
    return {
      valid: true,
      reason: `APE ${label} native identity bound to ${record.ticket_id}`,
      ticket_id: record.ticket_id,
      binding_observation: boundObservation,
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
  const intents = await readIntents(paths);
  const sessionId = input.session_id ?? input.sessionId;
  const agentId = input.agent_id ?? input.agentId;
  const legacyResume = intents.some(({ record }) => record.run_id === state?.run_id &&
    record.host === 'codex' && record.bootstrap_protocol !== 1 && record.status === 'bound' &&
    boundSessionMatches(record, sessionId, 'codex') && record.bound_agent_id === agentId);
  if (!legacyResume && intents.some(({ record }) => record.run_id === state?.run_id &&
      record.host === 'codex' && record.bootstrap_protocol === 1 &&
      ['prepared', 'authorized', 'launched', 'bound'].includes(record.status))) {
    const observed = await recordCodexBootstrapCandidate(paths, input);
    const observation = observed.recorded ? null : await recordCodexSubagentStartOutcome(
      paths, state, 'rejected',
      !boundedIdentity(sessionId) ? 'malformed_session_identity' :
        !boundedIdentity(agentId) ? 'malformed_agent_identity' :
          !agentTypeInputValid(input.agent_type ?? input.agentType, 'codex')
            ? 'malformed_agent_type' : 'native_model_unavailable',
    );
    return {
      valid: observed.recorded === true,
      bootstrap_required: true,
      ...(observed.recorded === true ? { additional_context: codexBootstrapOrientation() } : {}),
      ...(observation ? { binding_observation: observation } : {}),
      reason: observed.recorded
        ? 'APE Codex native child observed; ape_bind is required before stage work'
        : 'APE Codex bootstrap denied: complete native child identity and model evidence is required',
    };
  }
  return bindDispatchSubagent(paths, state, input, 'codex');
}

function bootstrapToolInput(input) {
  return input.tool_input ?? input.toolInput ?? input.input ?? input.toolCall?.args ?? {};
}

function validBootstrapToolInput(paths, input) {
  const args = bootstrapToolInput(input);
  return args && typeof args === 'object' && !Array.isArray(args) &&
    Object.keys(args).length === 2 &&
    Object.keys(args).every((key) => key === 'project_dir' || key === 'bootstrap_capability') &&
    boundedIdentity(args.project_dir, 4096) && !/[\u0000-\u001f]/u.test(args.project_dir) &&
    path.resolve(args.project_dir) === path.resolve(paths.root) &&
    typeof args.bootstrap_capability === 'string' && NONCE_PATTERN.test(args.bootstrap_capability);
}

// Internal only: includes authority evidence so probe retirement can identify
// the precise old generation without consulting the newest probe reservation.
export async function readCodexBootstrapIntent(paths, capability) {
  if (typeof capability !== 'string' || !NONCE_PATTERN.test(capability)) return null;
  const hash = digest(capability);
  const matches = [];
  for (const { record } of await readIntents(paths)) {
    if (record.host !== 'codex') continue;
    for (const generation of record.launch_generations ?? []) {
      if (generation.bootstrap_protocol !== 1 || generation.bootstrap_capability_hash !== hash) continue;
      matches.push({
        ...record,
        matched_generation: generation,
        bootstrap_current: record.bootstrap_protocol === 1 &&
          record.bootstrap_capability_hash === hash &&
          generation.generation === record.launch_generation,
      });
    }
  }
  if (matches.length > 1) throw new Error('Codex bootstrap capability evidence is ambiguous');
  return matches[0] ?? null;
}

function matchesBootstrapInvocation(record, candidate, input) {
  const invocation = record.bootstrap_invocation;
  return invocation && invocation.version === 1 &&
    invocation.session_id === candidate.parent_session_id &&
    invocation.agent_id === candidate.agent_id &&
    invocation.turn_id_hash === digest(candidate.turn_id) &&
    invocation.tool_use_id === (input.tool_use_id ?? input.toolUseId) &&
    invocation.launch_generation === record.launch_generation;
}

// The generic wildcard hook may run after the specific bootstrap hook has
// already fenced this canary identity. Exempt only that exact admitted call;
// the ordinary bootstrap hook remains responsible for the live run/probe gate.
export async function isCodexBootstrapReplay(paths, input) {
  try {
    if (!BOOTSTRAP_TOOL_PATTERN.test(input.tool_name ?? input.toolName ?? '') ||
        !validBootstrapToolInput(paths, input)) return false;
    const candidate = await resolveCodexBootstrapCandidate(paths, input);
    if (!candidate) return false;
    const record = await readCodexBootstrapIntent(paths, bootstrapToolInput(input).bootstrap_capability);
    return Boolean(record?.bootstrap_current && record.status === 'bound' &&
      !expired(record.expires_at) && !record.agent_stopped_at &&
      record.parent_session_id === candidate.parent_session_id &&
      record.bound_session_id === candidate.parent_session_id &&
      record.bound_agent_id === candidate.agent_id && record.bootstrap_model === candidate.model &&
      matchesBootstrapInvocation(record, candidate, input));
  } catch {
    return false;
  }
}

export async function codexBootstrapStatus(paths, capability) {
  const record = await readCodexBootstrapIntent(paths, capability);
  if (!record?.bootstrap_current || record.status !== 'bound' || expired(record.expires_at)) {
    return { ok: false, bound: false, reason: 'native bootstrap binding is not confirmed' };
  }
  return { ok: true, bound: true, bootstrap_protocol: 1 };
}

export async function bootstrapCodexSubagent(paths, state, input) {
  const refuse = (reason, code = 'bootstrap_rejected') => ({
    valid: false,
    reason: `APE Codex bootstrap denied: ${reason}`,
    binding_observation: makeSubagentStartObservation('rejected', code),
  });
  const capability = bootstrapToolInput(input).bootstrap_capability;
  const toolUseId = input.tool_use_id ?? input.toolUseId;
  if (!BOOTSTRAP_TOOL_PATTERN.test(input.tool_name ?? input.toolName ?? '') ||
      !validBootstrapToolInput(paths, input) || !boundedIdentity(toolUseId)) {
    return refuse('malformed bootstrap request');
  }
  let candidate;
  try {
    candidate = await resolveCodexBootstrapCandidate(paths, input);
  } catch {
    return refuse('native child evidence is unreadable or conflicting');
  }
  if (!candidate) return refuse('host-observed child identity and model are required');
  return withDispatchLock(paths, async () => {
    const record = await readCodexBootstrapIntent(paths, capability);
    if (!record || !record.bootstrap_current || record.run_id !== state?.run_id ||
        !['authorized', 'launched', 'bound'].includes(record.status)) {
      return refuse('bootstrap capability has no current authorized launch');
    }
    if (record.status === 'bound' && record.agent_stopped_at && (
      record.bootstrap_invocation?.turn_id_hash === digest(candidate.turn_id) ||
      Date.parse(candidate.observed_at) <= Date.parse(record.agent_stopped_at)
    )) return refuse('stopped native child requires a newly observed child turn before bootstrap');
    const rejectKnown = async (code, reason) => {
      const result = refuse(reason, code);
      const { matched_generation: _generation, bootstrap_current: _current, ...durable } = record;
      await atomicWriteJson(intentPath(paths, record.ticket_id),
        withSubagentStartObservation(durable, result.binding_observation));
      return result;
    };
    if (record.parent_session_id !== candidate.parent_session_id ||
        Date.parse(candidate.observed_at) < Date.parse(record.launched_at)) {
      return rejectKnown('bootstrap_parent_mismatch', 'native child does not satisfy the authorized launch');
    }
    if (!intentAgentTypeMatches(record, candidate.agent_type, 'codex')) {
      return rejectKnown('agent_type_mismatch', 'native child type does not satisfy the authorized launch');
    }
    const ticket = state?.tickets?.find((entry) => entry.ticket_id === record.ticket_id);
    if (!pendingTicket(state, record.ticket_id)) {
      return rejectKnown('ticket_not_pending', 'immutable ticket is not active and pending');
    }
    if (record.ticket_hash !== ticket?.ticket_hash) {
      return rejectKnown('ticket_hash_mismatch', 'dispatch ticket hash mismatch');
    }
    if (!requestedModelSatisfiesTicket(candidate.model, ticket.model?.model) ||
        !requestedModelSatisfiesTicket(record.requested_model, ticket.model?.model) ||
        (record.requested_reasoning_effort ?? null) !== (ticket.model?.reasoning_effort ?? null)) {
      return rejectKnown('native_model_mismatch', 'host-observed child model does not satisfy the ticket');
    }
    const recovery = activeReceiptProtocolRecovery(state, ticket, record);
    if (expired(record.expires_at) || (expired(ticket.deadline_at) && !recovery) ||
        (record.status !== 'bound' && expired(record.launch_expires_at))) {
      return rejectKnown('ticket_deadline_elapsed', 'authorized bootstrap deadline elapsed');
    }
    if (record.status === 'bound' && (
      record.bound_session_id !== candidate.parent_session_id ||
      record.bound_agent_id !== candidate.agent_id || record.bootstrap_model !== candidate.model
    )) return refuse('bootstrap capability is already claimed by another native child', 'bootstrap_already_claimed');
    if (record.status === 'bound' && record.codex_task_namespace === 'probe' &&
        !matchesBootstrapInvocation(record, candidate, input)) {
      return refuse('binding probe bootstrap was already admitted for another invocation');
    }
    if ((await readIntents(paths)).some(({ record: other }) =>
      other.run_id === state.run_id && other.host === 'codex' && other.status === 'bound' &&
      other.ticket_id !== record.ticket_id && other.bound_agent_id === candidate.agent_id)) {
      return refuse('native child is already bound to another ticket');
    }
    let context;
    try {
      context = codexInjectedDispatchContext(ticket);
      if (digest(context) !== record.injected_context_hash) {
        return rejectKnown('context_hash_mismatch', 'authoritative context hash mismatch');
      }
    } catch {
      return rejectKnown('context_unavailable', 'authoritative ticket context is unavailable');
    }
    const key = await dispatchLaunchKey(paths);
    const receiptCapability = derivedBootstrapReceiptCapability(
      key, record, candidate.parent_session_id, candidate.agent_id,
    );
    if (record.status === 'bound' && record.capability_hash !== digest(receiptCapability)) {
      return refuse('bound receipt authority does not match this bootstrap');
    }
    const now = iso();
    const invocation = matchesBootstrapInvocation(record, candidate, input)
      ? record.bootstrap_invocation
      : {
          version: 1,
          session_id: candidate.parent_session_id,
          agent_id: candidate.agent_id,
          turn_id_hash: digest(candidate.turn_id),
          tool_use_id: toolUseId,
          launch_generation: record.launch_generation,
          admitted_at: now,
        };
    const boundAt = record.bound_at ?? now;
    const observation = makeSubagentStartObservation('accepted', record.status === 'bound' ? 'resumed' : 'bound');
    if (record.status !== 'bound' || record.agent_stopped_at || invocation !== record.bootstrap_invocation) {
      const { matched_generation: _generation, bootstrap_current: _current,
        agent_stopped_at: _stopped, ...durable } = record;
      const bound = withLaunchGenerationStatus({
        ...durable,
        status: 'bound',
        bound_session_id: candidate.parent_session_id,
        bound_agent_id: candidate.agent_id,
        bootstrap_model: candidate.model,
        bootstrap_invocation: invocation,
        capability_hash: digest(receiptCapability),
        bound_at: boundAt,
      }, 'bound', { bound_at: boundAt });
      await atomicWriteJson(intentPath(paths, record.ticket_id), withSubagentStartObservation(bound, observation));
    }
    await refreshDispatchStatusDoc(paths, state.run_id, 'live');
    return {
      valid: true,
      reason: 'APE Codex native child bootstrap bound to its immutable ticket',
      ticket_id: record.ticket_id,
      bootstrap_invocation: invocation,
      binding_observation: observation,
      additional_context: [
        `APE_BOUND_CAPABILITY=${receiptCapability}`,
        `APE_RECEIPT_CAPABILITY=${receiptCapability}`,
        '', context,
      ].join('\n'),
    };
  });
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
  const evidence = await nativeDispatchEvidence(paths, input, host);
  input = evidence.input;
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
    // A native stop revokes protocol-v1 live tool authority. Receipt/stop
    // reconciliation remains independently resolvable, but ordinary tools
    // require a newly observed child turn to bootstrap and clear this stamp.
    !(record.bootstrap_protocol === 1 && record.agent_stopped_at) &&
    boundSessionMatches(record, sessionId, host) &&
    record.bound_agent_id === agentId &&
    bootstrapTurnAuthorized(record, input, host, evidence.candidate) &&
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
  // Sealed lookup is deny-only. Preserve every readable exact match even when
  // an unrelated artifact is damaged, and conservatively fence a bounded
  // subagent identity when any sealed binding evidence is unreadable. A new
  // audited START will quarantine stale corruption; silently treating it as
  // proof of "unbound" would instead reopen a sealed orphan's write channel.
  const intents = await readIntents(paths, { tolerateCorrupt: true });
  const matches = intents.filter(({ record }) =>
    record &&
    record.run_id === state?.run_id &&
    intentMatchesHost(record, host) &&
    ['bound', 'completed', 'expired'].includes(record.status) &&
    boundSessionMatches(record, sessionId, host) &&
    record.bound_agent_id === agentId &&
    intentAgentTypeMatches(record, agentType, host));
  if (matches[0]?.record) return matches[0].record;
  return intents.some((entry) => entry.evidence_unreadable === true)
    ? { ticket_id: null, evidence_unreadable: true }
    : null;
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
  options = {},
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
    valid: pendingTicket(state, ticket.ticket_id) || (
      options.allow_receipted_recovery === true &&
      state?.receipts?.some((receipt) => receipt.ticket_id === ticket.ticket_id)
    ),
    retry: false,
    file,
    record,
    agent_identity: record.bound_agent_id,
  };
}

export async function completeClaudeReceiptBinding(paths, ticket, binding, inputHash, receipt) {
  if (!binding?.file || !binding?.record) return;
  const operatorRecovery = receipt?.evidence?.operator_receipt_recovery;
  const operatorRecoveryRecorded = Boolean(
    ticket?.receipt_contract_version === 1 &&
    operatorRecovery?.version === 1 &&
    operatorRecovery?.receipt_input_hash === inputHash &&
    operatorRecovery?.validation?.worker_attestation === 'operator-waived'
  );
  await withDispatchLock(paths, async () => {
    const file = intentPath(paths, ticket.ticket_id);
    const current = await readCanonicalIntent(paths, ticket.ticket_id);
    if (
      current?.ticket_id !== ticket.ticket_id ||
      current?.ticket_hash !== ticket.ticket_hash ||
      current?.status !== 'bound' ||
      current?.capability_hash !== binding.record.capability_hash
    ) {
      throw new Error('Claude receipt capability changed before completion');
    }
    const completedAt = iso();
    const completed = withLaunchGenerationStatus({
      ...current,
      receipt_input_hash: inputHash,
      receipt_id: receipt.receipt_id,
      receipt_hash: receipt.receipt_hash,
      ...(operatorRecoveryRecorded
        ? {
            receipt_recording: {
              mode: 'operator-recovery',
              recovered_at: operatorRecovery.recovered_at,
              reason: operatorRecovery.reason,
              receipt_input_hash: inputHash,
              dispatch_identity_hash: operatorRecovery.dispatch_identity_hash,
              worker_attestation: 'operator-waived',
              validation: 'runtime-revalidated',
            },
          }
        : {}),
      completed_at: completedAt,
    }, 'completed', { completed_at: completedAt });
    await atomicWriteJson(file, { ...completed, status: 'completed' });
  });
}

// ---------------------------------------------------------------------------
// Draft validation and exact-input attestation on dispatch intents
// ---------------------------------------------------------------------------
// This is deliberately separate from receipt admission: validation neither
// consumes the one-time receipt capability nor charges a stage attempt. The
// capability is only compared to the bound intent here, and a successful
// validation seals the exact normalized input hash that record later requires.
// The attempt counter belongs to the PHYSICAL dispatch intent, so a stage retry
// (fresh ticket/intent) starts a fresh correction budget without rewriting run
// history.

function validationStateHasKnownValidDraft(validationState) {
  return validationState?.last_result?.valid === true || (
    typeof validationState?.attested_input_hash === 'string' &&
    /^[0-9a-f]{64}$/iu.test(validationState.attested_input_hash) &&
    validationState?.attested_contract_version === 1 &&
    typeof validationState?.attested_ticket_hash === 'string' &&
    /^[0-9a-f]{64}$/iu.test(validationState.attested_ticket_hash) &&
    typeof validationState?.attested_output_schema_hash === 'string' &&
    /^[0-9a-f]{64}$/iu.test(validationState.attested_output_schema_hash)
  );
}

function persistedInvalidAttempts(validationState, attempts) {
  const supplied = validationState?.invalid_attempts;
  if (Number.isSafeInteger(supplied) && supplied >= 0 && supplied <= attempts) return supplied;
  // A pre-2.24.2 attestation proves at least one validation was valid even if
  // a later invalid draft became last_result. Its exact order is unknowable,
  // but counting every submission as a rejection would be provably false.
  return Math.max(0, attempts - (validationStateHasKnownValidDraft(validationState) ? 1 : 0));
}

function validationRecovery(attempts, exhausted, exhaustionCount = 0, validationState = null) {
  const permanentlyBlocked = exhausted && exhaustionCount >= 2;
  // New validation state records truth directly. The fallback preserves the
  // conservative pre-2.24.2 interpretation for an already-running intent.
  const lastWasValid = validationState?.last_result?.valid === true;
  const invalidAttempts = persistedInvalidAttempts(validationState, attempts);
  const firstValidationValid = typeof validationState?.first_validation_valid === 'boolean'
    ? validationState.first_validation_valid
    : attempts === 1 && lastWasValid;
  return {
    attempt: attempts,
    max_attempts: RECEIPT_VALIDATION_MAX_ATTEMPTS,
    invalid_attempts: invalidAttempts,
    first_validation_valid: firstValidationValid,
    corrections_remaining: Math.max(0, RECEIPT_VALIDATION_MAX_ATTEMPTS - attempts),
    exhausted,
    exhaustion_count: exhaustionCount,
    next_action: !exhausted
      ? { kind: 'continue_same_agent' }
      : permanentlyBlocked
        ? { kind: 'blocked', failure_domain: 'orchestration', automatic_successor: false }
        : {
            kind: 'redispatch_same_ticket',
            failure_domain: 'orchestration',
          },
    ...(exhausted
      ? {
          recovery_kind: 'receipt_validation_exhausted',
        }
      : {}),
  };
}

function resolveReceiptContractBinding(current, request) {
  const contractVersion = request?.contract_version ?? current?.receipt_contract_version;
  const ticketHash = request?.ticket_hash ?? current?.ticket_hash;
  const outputSchemaHash = request?.output_schema_hash ?? current?.receipt_output_schema_hash;
  if (
    contractVersion !== 1 ||
    typeof ticketHash !== 'string' || !/^[0-9a-f]{64}$/i.test(ticketHash) ||
    typeof outputSchemaHash !== 'string' || !/^[0-9a-f]{64}$/i.test(outputSchemaHash) ||
    ticketHash !== current?.ticket_hash ||
    (current?.receipt_contract_version !== undefined && current.receipt_contract_version !== contractVersion) ||
    (current?.receipt_output_schema_hash !== undefined && current.receipt_output_schema_hash !== outputSchemaHash)
  ) return null;
  return {
    contract_version: contractVersion,
    ticket_hash: ticketHash,
    output_schema_hash: outputSchemaHash,
  };
}

function receiptAttestationMatches(validation, binding, inputHash) {
  return Boolean(
    validation?.attested_input_hash === inputHash &&
    validation?.attested_contract_version === binding?.contract_version &&
    validation?.attested_ticket_hash === binding?.ticket_hash &&
    validation?.attested_output_schema_hash === binding?.output_schema_hash
  );
}

/**
 * Applies one supplied pure validation result to an already-authorized intent
 * while its caller holds the physical dispatch lock. An identical VALID draft
 * is idempotent so a lost successful response can be retried safely. Invalid
 * drafts are submissions, not content-addressed operations: each call consumes
 * the physical worker's bounded allowance even when the worker returns the
 * same malformed object again.
 *
 * @param {string} file
 * @param {object} current
 * @param {{ input_hash: string, receipt_capability: string, validate: () => { valid: boolean, corrections: object[], budgets: object } }} request
 */
async function validateAndAttestCurrent(file, current, request) {
  if (typeof request?.input_hash !== 'string' || !/^[0-9a-f]{64}$/i.test(request.input_hash)) {
    return { observed: false, reason: 'receipt validation input hash is malformed' };
  }
    const contractBinding = resolveReceiptContractBinding(current, request);
    if (!contractBinding) {
      return { observed: false, reason: 'receipt validation contract binding is malformed or stale' };
    }
    let prior = current.receipt_validation ?? null;
    if (
      prior?.last_input_hash === request.input_hash &&
      prior.last_result?.valid === true
    ) {
      // An identical successful-validation retry does not consume another
      // submission. It is already attested and cannot authorize correction
      // work.
      return {
        observed: true,
        validation_performed: false,
        idempotent: true,
        input_hash: request.input_hash,
        attested: receiptAttestationMatches(prior, contractBinding, request.input_hash),
        validation: validationRecovery(
          prior.attempts ?? 0,
          prior.exhausted === true,
          prior.exhaustion_count ?? current.receipt_validation_exhaustions ?? 0,
          prior,
        ),
        result: prior.last_result,
      };
    }
    const attempts = prior?.attempts ?? 0;
    if (prior?.exhausted === true || attempts >= RECEIPT_VALIDATION_MAX_ATTEMPTS) {
      return {
        observed: true,
        validation_performed: false,
        idempotent: false,
        input_hash: request.input_hash,
        attested: receiptAttestationMatches(prior, contractBinding, request.input_hash),
        validation: validationRecovery(
          attempts,
          true,
          prior?.exhaustion_count ?? current.receipt_validation_exhaustions ?? 1,
          prior,
        ),
        result: null,
      };
    }

    const result = request.validate();
    if (
      !result || typeof result !== 'object' || typeof result.valid !== 'boolean' ||
      !Array.isArray(result.corrections)
    ) {
      throw new Error('receipt draft validator returned an invalid result shape');
    }
    const nextAttempts = attempts + 1;
    const exhausted = result.valid !== true && nextAttempts >= RECEIPT_VALIDATION_MAX_ATTEMPTS;
    const exhaustionCount = exhausted
      ? (current.receipt_validation_exhaustions ?? 0) + 1
      : (current.receipt_validation_exhaustions ?? 0);
    const priorInvalidAttempts = persistedInvalidAttempts(prior, attempts);
    const invalidAttempts = priorInvalidAttempts + (result.valid === true ? 0 : 1);
    const firstValidationValid = typeof prior?.first_validation_valid === 'boolean'
      ? prior.first_validation_valid
      : attempts === 0
        ? result.valid === true
        : attempts === 1 && prior?.last_result?.valid === true;
    const validatedAt = iso();
    const receiptValidation = {
      version: 1,
      attempts: nextAttempts,
      max_attempts: RECEIPT_VALIDATION_MAX_ATTEMPTS,
      invalid_attempts: invalidAttempts,
      first_validation_valid: firstValidationValid,
      exhausted,
      exhaustion_count: exhaustionCount,
      last_input_hash: request.input_hash,
      last_result: result,
      ...(result.valid === true
        ? {
            attested_input_hash: request.input_hash,
            attested_contract_version: contractBinding.contract_version,
            attested_ticket_hash: contractBinding.ticket_hash,
            attested_output_schema_hash: contractBinding.output_schema_hash,
          }
        : prior?.attested_input_hash
          ? {
              attested_input_hash: prior.attested_input_hash,
              ...(prior.attested_contract_version !== undefined
                ? { attested_contract_version: prior.attested_contract_version }
                : {}),
              ...(prior.attested_ticket_hash !== undefined
                ? { attested_ticket_hash: prior.attested_ticket_hash }
                : {}),
              ...(prior.attested_output_schema_hash !== undefined
                ? { attested_output_schema_hash: prior.attested_output_schema_hash }
                : {}),
            }
          : {}),
      validated_at: validatedAt,
    };
    await atomicWriteJson(file, {
      ...current,
      receipt_validation: receiptValidation,
      receipt_validation_exhaustions: exhaustionCount,
      validation_attempts: nextAttempts,
      valid_draft_observed: result.valid === true || current.valid_draft_observed === true,
      last_validation_at: receiptValidation.validated_at,
    });
    return {
      observed: true,
      validation_performed: true,
      exhaustion_just_reached: exhausted,
      idempotent: false,
      input_hash: request.input_hash,
      attested: result.valid === true,
      validation: validationRecovery(nextAttempts, exhausted, exhaustionCount, receiptValidation),
      result,
    };
}

export async function validateAndAttestDispatchReceiptDraft(paths, ticketId, request) {
  return withDispatchLock(paths, async () => {
    const file = intentPath(paths, ticketId);
    const current = await readCanonicalIntent(paths, ticketId);
    if (!current || !['bound', 'completed'].includes(current.status)) {
      return { observed: false, reason: 'no exact bound physical dispatch for receipt validation' };
    }
    if (
      typeof request?.receipt_capability !== 'string' ||
      current.capability_hash !== digest(request.receipt_capability)
    ) {
      return { observed: false, reason: 'receipt validation capability does not match the bound physical dispatch' };
    }
    const observation = await validateAndAttestCurrent(file, current, request);
    return { ...observation, bound_at: current.bound_at ?? null };
  });
}

/**
 * Host-attested SubagentStop validation path. Identity replaces the plaintext
 * capability solely for this host lifecycle event; the pure receipt validator
 * still requires the capability field in the returned draft itself. The exact
 * bound identity is re-resolved under the same dispatch lock used to persist
 * the validation attempt and attestation.
 */
export async function validateAndAttestDispatchReceiptDraftAtStop(
  paths,
  state,
  input,
  host,
  request,
) {
  const evidence = await nativeDispatchEvidence(paths, input, host);
  input = evidence.input;
  const sessionId = input.session_id ?? input.sessionId;
  const agentId = input.agent_id ?? input.agentId;
  const agentType = input.agent_type ?? input.agentType;
  if (!boundedIdentity(sessionId) || !boundedIdentity(agentId) || !agentTypeInputValid(agentType, host)) {
    return { observed: false, reason: 'malformed native identity at SubagentStop' };
  }
  return withDispatchLock(paths, async () => {
    const matches = (await readIntents(paths)).filter(({ record }) =>
      record.run_id === state?.run_id &&
      intentMatchesHost(record, host) &&
      ['bound', 'completed', 'expired'].includes(record.status) &&
      boundSessionMatches(record, sessionId, host) &&
      record.bound_agent_id === agentId &&
      bootstrapTurnAuthorized(record, input, host, evidence.candidate) &&
      intentAgentTypeMatches(record, agentType, host));
    if (matches.length !== 1) {
      return {
        observed: false,
        reason: matches.length === 0
          ? 'no exact bound physical dispatch at SubagentStop'
          : 'ambiguous bound physical dispatch at SubagentStop',
      };
    }
    const { file, record } = matches[0];
    const ticket = state?.tickets?.find((entry) => entry.ticket_id === record.ticket_id);
    const observation = await validateAndAttestCurrent(file, record, {
      ...request,
      contract_version: ticket?.receipt_contract_version,
      ticket_hash: ticket?.ticket_hash,
      output_schema_hash: ticket?.capability_manifest?.receipt_schema?.hash,
    });
    return { ...observation, bound_at: record.bound_at ?? null };
  });
}

/**
 * Reads the exact-draft attestation used by authoritative record admission.
 */
export async function readDispatchReceiptAttestation(
  paths,
  ticketId,
  inputHash,
  receiptCapability,
  contractBinding,
) {
  const current = await readCanonicalIntent(paths, ticketId);
  const validation = current?.receipt_validation ?? null;
  const capabilityMatches = typeof receiptCapability === 'string'
    && current?.capability_hash === digest(receiptCapability);
  const resolvedBinding = resolveReceiptContractBinding(current, contractBinding);
  const attempts = validation?.attempts ?? 0;
  const recovery = validationRecovery(
    attempts,
    validation?.exhausted === true,
    validation?.exhaustion_count ?? current?.receipt_validation_exhaustions ?? 0,
    validation,
  );
  return {
    valid: capabilityMatches && resolvedBinding !== null &&
      receiptAttestationMatches(validation, resolvedBinding, inputHash),
    input_hash: inputHash,
    attested_input_hash: validation?.attested_input_hash ?? null,
    attested_contract_version: validation?.attested_contract_version ?? null,
    attested_ticket_hash: validation?.attested_ticket_hash ?? null,
    attested_output_schema_hash: validation?.attested_output_schema_hash ?? null,
    worker_stopped_at: current?.agent_stopped_at ?? null,
    physical_worker_dispatches: current?.physical_worker_dispatches ?? null,
    validation: {
      ...recovery,
      ...(validation?.continuation_blocked
        ? { continuation_blocked: structuredClone(validation.continuation_blocked) }
        : {}),
    },
  };
}

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
    const current = await readCanonicalIntent(paths, ticketId);
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
    const current = await readCanonicalIntent(paths, ticketId);
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
