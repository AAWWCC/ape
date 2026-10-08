import { localExecutionIdentity, isLocalExecution, executionIdentityProblem } from './host-identity.js';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { sha256 } from './canonical.js';
import { atomicWriteJson } from './storage.js';
import { SEALED_STATUSES } from './constants.js';
import { readGateOwnership, readGateProof, queryGateBroker, killProcessTree } from './spawn.js';
import { boundedGateSummary } from './bounded-summary.js';

export function gateOwnershipPath(paths, runId) {
  return path.join(paths.runtime, 'gate-suite', `${sha256(runId)}.ownership.json`);
}

export function gateGenerationFiles(paths, generation) {
  const dir = path.join(paths.runtime, 'gate-suite');
  const stem = sha256(generation);
  return { dir, job: path.join(dir, `${stem}.job.json`),
    artifact: path.join(dir, `${stem}.result.json`),
    heartbeat: path.join(dir, `${stem}.heartbeat`), proof: path.join(dir, `${stem}.proof.json`) };
}

export function gateProducersComplete(proof) {
  return proof?.cleanup?.status === 'confirmed' &&
    proof.producers?.result_published === true && proof.producers?.heartbeat_drained === true;
}

function validRecord(projectDir, paths, runId, record) {
  try {
    // The gate helpers also accept the historical { runtime } paths shape.
    projectDir ??= path.resolve(paths.runtime, '..', '..');
    const watch = record.watch;
    const files = gateGenerationFiles(paths, record.generation);
    return record.version === 1 && record.project_dir === realpathSync(projectDir) && record.host === localExecutionIdentity() &&
      record.run_id === runId && typeof record.generation === 'string' && /^[a-f0-9-]{36}$/.test(record.generation) &&
      typeof record.secret === 'string' && record.secret.length === 36 && watch?.host === localExecutionIdentity() &&
      watch.nonce === record.generation && watch.generation === record.generation &&
      watch.ownership_file === gateOwnershipPath(paths, runId) && watch.job_file === files.job &&
      watch.artifact_file === files.artifact && watch.heartbeat_file === files.heartbeat &&
      record.proof_file === files.proof && sha256(watch.plan) === record.plan_hash;
  } catch { return false; }
}

function cleanupDescriptor(record) {
  const { pending_cleanup, ...descriptor } = record;
  return { ...descriptor, phase: 'consumed' };
}

// The caller has established consumption (both state sinks, or an audited
// replacement attempt). Keep the cleanup obligation in the same atomic write.
export async function markGateConsumed(paths, state, record) {
  const pending = [...(record.pending_cleanup ?? [])];
  if (!pending.some((entry) => entry.generation === record.generation)) pending.push(cleanupDescriptor(record));
  await atomicWriteJson(gateOwnershipPath(paths, state.run_id), { ...record, phase: 'consumed', pending_cleanup: pending });
  await drainGateCleanup(paths, state);
}

// Only locked controller callers mutate this journal. A descriptor survives
// reservation replacement and every individual unlink, until all three have
// succeeded. Producers write only their generation's proof after handoff.
export async function drainGateCleanup(paths, state) {
  const file = gateOwnershipPath(paths, state.run_id);
  let record;
  try { record = await readGateOwnership(file); } catch { return; }
  if (!validRecord(paths.root, paths, state.run_id, record)) return;
  const pending = record.pending_cleanup ?? [];
  if (!Array.isArray(pending)) return;
  const remaining = [];
  for (const descriptor of pending) {
    if (descriptor?.phase !== 'consumed' ||
        (descriptor.generation === record.generation && record.phase !== 'consumed') ||
        !validRecord(paths.root, paths, state.run_id, descriptor) ||
        !gateProducersComplete(await readGateProof(descriptor))) {
      remaining.push(descriptor);
      continue;
    }
    const files = gateGenerationFiles(paths, descriptor.generation);
    try {
      for (const artifact of [files.job, files.artifact, files.heartbeat]) await rm(artifact, { force: true });
    } catch { remaining.push(descriptor); }
  }
  if (remaining.length !== pending.length) await atomicWriteJson(file, { ...record, pending_cleanup: remaining });
}

export async function inspectGateOwnership(projectDir, paths, state, suppliedWatch = null) {
  const file = gateOwnershipPath(paths, state.run_id);
  let record;
  try { record = await readGateOwnership(file); }
  catch (e) { return e?.code === 'ENOENT' ? { absent: true } : { blocked: 'gate ownership is unreadable; retirement is unknown' }; }
  try {
    const watch = record.watch;
    const identityProblem = executionIdentityProblem(record.host) ?? executionIdentityProblem(watch?.host);
    if (identityProblem) return { identity_problem: identityProblem,
      blocked: `gate execution identity ${identityProblem}; ownership is retained and retirement is unknown. Verify work is retired before explicit audited recovery; legacy ownership cannot be migrated automatically.` };
    const files = gateGenerationFiles(paths, record.generation);
    if (!validRecord(projectDir, paths, state.run_id, record) ||
        (suppliedWatch && (suppliedWatch.host !== record.host || suppliedWatch.nonce !== record.generation ||
          suppliedWatch.generation !== record.generation || suppliedWatch.ownership_file !== file))) {
      return { blocked: 'gate ownership identity is invalid; retirement is unknown' };
    }
    if (record.phase === 'consumed' || record.phase === 'no-start') return { record, retired: true };
    let job;
    try { job = await readGateOwnership(files.job); }
    catch (error) {
      // A reserved generation without a job cannot have launched: publication
      // of that exact job precedes spawn. Retain its consumed predecessor cursor.
      if (error?.code === 'ENOENT' && record.phase === 'reserved' && watch.pid === null && !record.broker_pid) {
        return { record, watch, unstarted: true };
      }
      throw error;
    }
    const jobIdentityProblem = executionIdentityProblem(job.host);
    if (jobIdentityProblem) return { identity_problem: jobIdentityProblem,
      blocked: `gate job execution identity ${jobIdentityProblem}; ownership is retained and retirement is unknown. Verify work is retired before explicit audited recovery; legacy ownership cannot be migrated automatically.` };
    if (job.nonce !== record.generation || job.run_id !== record.run_id || job.ownership_file !== file ||
        job.host !== record.host || job.project_dir !== record.project_dir || sha256(job.plan) !== record.plan_hash || job.cache_key !== watch.cache_key) {
      return { blocked: 'gate job does not match its ownership reservation' };
    }
    const proof = await readGateProof(record);
    // A signed unknown result is final evidence of uncertainty, even after
    // its producer exits. It retains ownership; it never proves retirement.
    if (proof?.cleanup?.status === 'confirmed' || proof?.cleanup?.status === 'unknown') return { record, watch, proof };
    const broker = await queryGateBroker(record);
    if (!broker || broker.generation !== record.generation || sha256(broker.watch) !== sha256(watch)) {
      // Local identity/job checks permit durable invalidation intent only.
      // Withhold watch authority until the broker can authenticate it.
      return { blocked: 'gate proof broker is unavailable; retirement is unknown', record };
    }
    return { record, watch, proof: proof ?? broker.proof };
  } catch { return { blocked: 'gate ownership could not be authenticated; retirement is unknown' }; }
}

export async function reserveGateOwnership(projectDir, paths, state, watch) {
  if (!isLocalExecution(watch.host)) throw new Error('gate execution identity is invalid');
  const files = gateGenerationFiles(paths, watch.nonce);
  let previous;
  try { previous = await readGateOwnership(watch.ownership_file); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; }
  const pending = [...(previous?.pending_cleanup ?? [])];
  if (previous) {
    if (!validRecord(projectDir, paths, state.run_id, previous)) throw new Error('invalid prior ownership');
    const proof = await readGateProof(previous);
    // An authenticated aborted suite may be retried after containment retires
    // it even when its runner died before the heartbeat acknowledgement. Keep
    // that generation's authority and scratch; retirement alone never deletes.
    if (proof?.cleanup?.status === 'confirmed' &&
        !pending.some((entry) => entry.generation === previous.generation)) pending.push(cleanupDescriptor(previous));
  }
  const record = { version: 1, project_dir: realpathSync(projectDir), run_id: state.run_id,
    host: localExecutionIdentity(), generation: watch.nonce, secret: randomUUID(), phase: 'reserved',
    plan_hash: sha256(watch.plan), proof_file: files.proof, watch,
    state_fields: { regate_attempts: state.regate_attempts ?? 0, ship_requested: state.ship_requested === true },
    pending_cleanup: pending };
  await atomicWriteJson(watch.ownership_file, record);
  await drainGateCleanup(paths, state);
  return record;
}

// Service callers hold the receipt-effects lock. Keep intent outside the
// authenticated watch: changing that payload would invalidate broker identity.
export async function retireInvalidatedGate(projectDir, paths, state, ownership, reason) {
  let record = ownership.record;
  if (!record.invalidation) {
    record = { ...record, invalidation: { reason: boundedGateSummary(reason) } };
    await atomicWriteJson(gateOwnershipPath(paths, state.run_id), record);
  }
  if (ownership.blocked || !ownership.watch) {
    return { pending: { summary: boundedGateSummary(ownership.blocked ?? 'invalidated gate cleanup is incomplete; ownership is retained') } };
  }
  if (ownership.proof?.cleanup?.status !== 'confirmed') {
    await killProcessTree(ownership.watch);
  }
  const retired = await inspectGateOwnership(projectDir, paths, state, ownership.watch);
  if (retired.proof?.cleanup?.status === 'confirmed') return { failed: record.invalidation.reason };
  const summary = boundedGateSummary(retired.blocked ?? 'invalidated gate cleanup is incomplete; descendant retirement is unknown and ownership is retained');
  return retired.proof?.cleanup?.status === 'unknown' ? { failed: summary } : { pending: { summary } };
}

// Called only after both state sinks succeeded. A crash before this marker
// replays the retained result; no proof is deleted during consumption.
export async function acknowledgeGateConsumption(paths, state) {
  const file = gateOwnershipPath(paths, state.run_id);
  let record;
  try { record = await readGateOwnership(file); } catch { return; }
  if (!validRecord(paths.root, paths, state.run_id, record)) return;
  if (record.phase === 'consumed') {
    await drainGateCleanup(paths, state);
    return;
  }
  if (record.invalidation) {
    if (state.status !== 'blocked' || state.block_reason !== record.invalidation.reason ||
        state.gates_watch?.nonce !== record.generation) return;
    const owned = await inspectGateOwnership(paths.root, paths, state, state.gates_watch);
    if (owned.proof?.cleanup?.status !== 'confirmed') return;
    if (!gateProducersComplete(owned.proof)) return;
    await markGateConsumed(paths, state, record);
    return;
  }
  if (state.gates_watch || !state.gates) return;
  const proof = await readGateProof(record);
  if (!gateProducersComplete(proof) || state.gates.tree_sha !== record.watch.tree_sha) return;
  await markGateConsumed(paths, state, record);
}

export async function recoverGateWatch(paths, state) {
  await drainGateCleanup(paths, state);
  // Durable launch evidence cannot revoke an explicit seal. In particular an
  // unpublished generation may outlive ABORT when retirement is unknown.
  if (SEALED_STATUSES.has(state.status)) return false;
  const ownership = await inspectGateOwnership(paths.root, paths, state);
  if (ownership.identity_problem) {
    const reason = boundedGateSummary(ownership.blocked);
    if (state.status === 'blocked' && state.block_reason === reason) return false;
    state.status = 'blocked';
    state.stage = 'gates';
    state.block_reason = reason;
    state.gates = { ...state.gates, passed: false };
    return true;
  }
  if (!ownership.watch || ownership.retired) return false;
  // A signed unknown result is terminal uncertainty, even when publication of
  // active.json was lost. Restoring it as `gating` would ask the next caller to
  // poll a finished generation and could obscure why replacement is forbidden.
  if (ownership.proof?.cleanup?.status === 'unknown') {
    const reason = boundedGateSummary(`gate descendant retirement is unknown: ${ownership.proof.cleanup.cause ?? 'no authenticated retirement proof'}`);
    if (state.status === 'blocked' && state.block_reason === reason && state.gates_watch?.nonce === ownership.watch.nonce) return false;
    state.gates_watch = ownership.watch;
    Object.assign(state, ownership.record.state_fields);
    state.status = 'blocked';
    state.stage = 'gates';
    state.block_reason = reason;
    state.gates = { ...state.gates, passed: false, checks: { ...state.gates?.checks, full_suite: { passed: false, cleanup_status: 'unknown' } } };
    return true;
  }
  // An existing watch can lag a durably advanced runner cursor. The journal
  // carries consumed results before allowing that next generation to start.
  if (state.gates_watch?.nonce === ownership.watch.nonce &&
      (!ownership.record.invalidation || state.status === 'gating' || ownership.proof?.cleanup?.status === 'unknown')) return false;
  state.gates_watch = ownership.watch;
  Object.assign(state, ownership.record.state_fields);
  state.status = 'gating';
  state.stage = 'gates';
  return true;
}
