import path from 'node:path';
import { constants } from 'node:fs';
import { mkdir, open, realpath } from 'node:fs/promises';
import { lstatFile as lstat, statFileHandle } from './file-stats.js';
import { sha256, canonicalJson } from './canonical.js';
import { readJson, atomicWriteJson } from './storage.js';
import { activeState } from './active-state.js';
import { validateGovernedRuntimeAncestor } from './paths.js';
import { withDirLock } from './lock.js';
import { readCanonicalIntent, withDispatchLock } from './claude-dispatch.js';
import { readPersistedProbeRecord, withProbeLock } from './binding-probe.js';

const NEXT = 'Inspect status, wait for the same native child, then use resume and only the runtime-authorized recovery action. A rejected launch retains its generation until runtime-authorized expiry or revocation.';

// Stable admission facts, never a live occupancy estimate or release authority.
// Neither shipped host has an installed conditional native release adapter.
export function nativeWorkerLifecycle(host = 'codex') {
  return {
    host,
    release: { support: 'unsupported', operation: null,
      reason: 'No supported conditional native close/release adapter is installed.' },
    capacity: { advertised_active_concurrency: null, retained_thread_limit: null,
      effective_launch_limit: null, physical_worker_dispatches: 'cumulative APE accounting; never host occupancy or reclaimed capacity' },
    provenance: 'shipped-adapter-contract; session tool inventory must be established separately',
    next_action: NEXT,
  };
}

function supported(adapter) {
  const c = adapter?.contract;
  return c?.support === 'supported' && typeof c.operation === 'string' && c.operation.length > 0 &&
    c.conditional_on_stopped === true && c.preserves_history === true && c.exact_identity === true &&
    typeof c.provenance === 'string' && typeof adapter.release === 'function' &&
    (c.idempotent === true || (c.query_supported === true && typeof adapter.query === 'function'));
}

const same = (a, b) => canonicalJson(a) === canonicalJson(b);
const timestamp = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value));
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;
const MAX_OPERATION_BYTES = 64 * 1024;
const ordinary = (metadata) => metadata.isFile() && !metadata.isSymbolicLink() &&
  metadata.nlink === 1 && metadata.size <= MAX_OPERATION_BYTES;
const unsafeLedger = () => new Error('Native worker retirement evidence is not in its canonical ordinary container');

async function ledgerContainer(paths) {
  if (!(await validateGovernedRuntimeAncestor(paths))) throw unsafeLedger();
  const directory = path.join(paths.runtime, 'native-worker-retirement');
  try { await mkdir(directory, { mode: 0o700 }); }
  catch (error) { if (error?.code !== 'EEXIST') throw error; }
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() ||
      await realpath(directory) !== path.join(await realpath(paths.root), '.ape', 'runtime', 'native-worker-retirement')) {
    throw unsafeLedger();
  }
  return metadata;
}

// Match the dispatch authority reader: reject links and special files, bound
// the descriptor read, and corroborate identity before and after reading.
async function readOperation(paths, file, container) {
  if (!sameFile(await ledgerContainer(paths), container)) throw unsafeLedger();
  const before = await lstat(file).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (!before) return null;
  if (!ordinary(before)) throw unsafeLedger();
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = await statFileHandle(handle);
    if (!ordinary(opened) || !sameFile(before, opened)) throw unsafeLedger();
    const buffer = Buffer.alloc(MAX_OPERATION_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    const after = await lstat(file);
    const openedAfter = await statFileHandle(handle);
    if (length > MAX_OPERATION_BYTES || !ordinary(after) || !ordinary(openedAfter) ||
        !sameFile(after, opened) || !sameFile(openedAfter, opened) ||
        !sameFile(await ledgerContainer(paths), container)) throw unsafeLedger();
    return JSON.parse(buffer.subarray(0, length).toString('utf8'));
  } finally { await handle.close(); }
}

async function writeOperation(paths, file, container, value) {
  // Revalidate after the host callback too: it may have yielded while the
  // container or leaf was redirected. Preserve the original durable intent.
  await readOperation(paths, file, container);
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_OPERATION_BYTES) throw unsafeLedger();
  await atomicWriteJson(file, value);
}

function validConfirmation(response, identity, operation_id) {
  return response && same(response.identity, identity) && response.operation_id === operation_id &&
    ['released', 'refused'].includes(response.status) &&
    (response.status !== 'released' || (response.evidence?.preserves_history === true &&
      typeof response.evidence?.source === 'string' && response.evidence.source.trim().length > 0));
}

async function eligible(paths, identity) {
  const record = await readCanonicalIntent(paths, identity.ticket_id);
  if (!record || !['codex', 'claude'].includes(identity.host) ||
      !Number.isSafeInteger(identity.launch_generation) || identity.launch_generation < 1 ||
      record.host !== identity.host || record.run_id !== identity.run_id ||
      record.ticket_hash !== identity.ticket_hash || record.bound_session_id !== identity.session_id ||
      record.bound_agent_id !== identity.agent_id || record.launch_generation !== identity.launch_generation ||
      !record.launch_generations?.some((g) => g.generation === identity.launch_generation &&
        g.ticket_hash === identity.ticket_hash && g.ticket_id === identity.ticket_id) ||
      !record.capability_hash || !timestamp(record.bound_at)) return false;
  if (identity.probe_id) {
    const probe = await readPersistedProbeRecord(paths);
    return Boolean(probe && probe.probe_id === identity.probe_id && identity.run_id === identity.probe_id &&
      probe.ticket_id === identity.ticket_id && probe.ticket_hash === identity.ticket_hash &&
      probe.bound_session_id === identity.session_id && probe.bound_agent_id === identity.agent_id &&
      (probe.status === 'completed' || (probe.status === 'consumed' && timestamp(probe.consumed_at) &&
        Date.parse(probe.consumed_at) >= Date.parse(probe.completed_at))) &&
      timestamp(probe.completed_at) && timestamp(probe.bound_at) && timestamp(probe.canary_stopped_at) &&
      Date.parse(probe.canary_stopped_at) >= Date.parse(probe.bound_at));
  }
  if (record.status !== 'completed' || !timestamp(record.agent_stopped_at) ||
      Date.parse(record.agent_stopped_at) < Date.parse(record.bound_at) ||
      !record.receipt_id || !record.receipt_hash || !record.receipt_input_hash) return false;
  const state = await activeState(paths);
  if (state?.run_id !== identity.run_id) return false;
  const accepted = state.receipts?.find((r) => r.ticket_id === identity.ticket_id &&
    r.receipt_id === record.receipt_id && r.receipt_hash === record.receipt_hash);
  if (!accepted || !/^[A-Za-z0-9_-]+$/.test(record.receipt_id)) return false;
  const durable = await readJson(path.join(paths.receipts, `${record.receipt_id}.json`), null);
  if (!durable || !same(durable, accepted)) return false;
  const { receipt_hash, ...body } = durable;
  return receipt_hash === sha256(body);
}

// Internal trusted-adapter seam only: never exposed through MCP inputs or run
// metadata. A local lock cannot serialize host resume. The adapter itself must
// atomically refuse any identity that is no longer stopped, preserve history,
// and reconcile the same operation after response loss. No production adapter
// is enabled by declarative compatibility data or by a parent's observations.
export async function retireNativeWorker(paths, identity, { adapter = undefined } = {}) {
  const result = (status, extra = {}) => ({ status, identity, next_action: NEXT, ...extra });
  if (!supported(adapter)) return result('unsupported');
  if (!identity || typeof identity.ticket_id !== 'string' || !(await validateGovernedRuntimeAncestor(paths))) {
    return result('ineligible');
  }
  const operation_id = sha256({ version: 1, identity, operation: adapter.contract.operation });
  const file = path.join(paths.runtime, 'native-worker-retirement', `${operation_id}.json`);
  const operation = async () => withDispatchLock(paths, async () => {
    let authorized;
    try { authorized = await eligible(paths, identity); } catch { return result('ineligible'); }
    if (!authorized) return result('ineligible');
    const container = await ledgerContainer(paths);
    const prior = await readOperation(paths, file, container);
    if (prior && (prior.operation_id !== operation_id || !same(prior.identity, identity))) return result('unconfirmed', { operation_id });
    if (prior?.status === 'released' || prior?.status === 'refused') {
      return validConfirmation(prior, identity, operation_id) ? prior : result('unconfirmed', { operation_id });
    }
    if (prior && prior.status !== 'unconfirmed') return result('unconfirmed', { operation_id });
    // Persist before any external side effect. Failed persistence cannot call
    // the host; an uncertain result always reuses this exact operation.
    if (!prior) await writeOperation(paths, file, container, result('unconfirmed', { operation_id }));
    let response;
    try {
      if (prior && adapter.contract.query_supported === true && typeof adapter.query === 'function') {
        response = await adapter.query({ identity, operation_id });
      }
      if (!response) {
        if (prior && adapter.contract.idempotent !== true) return result('unconfirmed', { operation_id });
        response = await adapter.release({ identity, operation_id });
      }
    } catch { return result('unconfirmed', { operation_id }); }
    if (!validConfirmation(response, identity, operation_id)) return result('unconfirmed', { operation_id });
    const confirmed = result(response.status, { operation_id,
      ...(response.status === 'released' ? { evidence: response.evidence } : {}) });
    await writeOperation(paths, file, container, confirmed);
    return confirmed;
  });
  // Established ordering: receipt effects -> probe (if any) -> dispatch.
  return withDirLock(paths.receiptLock, () => identity.probe_id ? withProbeLock(paths, operation) : operation(), {
    staleMs: 120_000, heartbeatMs: 10_000, busyMs: 30_000,
    serializeLocal: true, requireProcessIdentity: true,
  });
}
