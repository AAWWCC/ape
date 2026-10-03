import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
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

export async function inspectGateOwnership(projectDir, paths, state, suppliedWatch = null) {
  const file = gateOwnershipPath(paths, state.run_id);
  let record;
  try { record = await readGateOwnership(file); }
  catch (e) { return e?.code === 'ENOENT' ? { absent: true } : { blocked: 'gate ownership is unreadable; retirement is unknown' }; }
  try {
    const watch = record.watch;
    const files = gateGenerationFiles(paths, record.generation);
    if (record.version !== 1 || record.project_dir !== realpathSync(projectDir) || record.host !== hostname() ||
        record.run_id !== state.run_id || typeof record.generation !== 'string' || !/^[a-f0-9-]{36}$/.test(record.generation) ||
        typeof record.secret !== 'string' || record.secret.length !== 36 || !watch || watch.host !== hostname() ||
        watch.nonce !== record.generation || watch.generation !== record.generation || watch.ownership_file !== file ||
        watch.job_file !== files.job || watch.artifact_file !== files.artifact || watch.heartbeat_file !== files.heartbeat ||
        record.proof_file !== files.proof || sha256(watch.plan) !== record.plan_hash ||
        (suppliedWatch && (suppliedWatch.host !== record.host || suppliedWatch.nonce !== record.generation ||
          suppliedWatch.generation !== record.generation || suppliedWatch.ownership_file !== file))) {
      return { blocked: 'gate ownership identity is invalid; retirement is unknown' };
    }
    if (record.phase === 'consumed' || record.phase === 'no-start') return { record, retired: true };
    const job = await readGateOwnership(files.job);
    if (job.nonce !== record.generation || job.run_id !== record.run_id || job.ownership_file !== file ||
        job.project_dir !== record.project_dir || sha256(job.plan) !== record.plan_hash || job.cache_key !== watch.cache_key) {
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
  const files = gateGenerationFiles(paths, watch.nonce);
  const record = { version: 1, project_dir: realpathSync(projectDir), run_id: state.run_id,
    host: hostname(), generation: watch.nonce, secret: randomUUID(), phase: 'reserved',
    plan_hash: sha256(watch.plan), proof_file: files.proof, watch,
    state_fields: { regate_attempts: state.regate_attempts ?? 0, ship_requested: state.ship_requested === true } };
  await atomicWriteJson(watch.ownership_file, record);
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
  if (record.phase === 'consumed' || record.run_id !== state.run_id || record.host !== hostname()) return;
  if (record.invalidation) {
    if (state.status !== 'blocked' || state.block_reason !== record.invalidation.reason ||
        state.gates_watch?.nonce !== record.generation) return;
    const owned = await inspectGateOwnership(paths.root, paths, state, state.gates_watch);
    if (owned.proof?.cleanup?.status !== 'confirmed') return;
    await atomicWriteJson(file, { ...record, phase: 'consumed' });
    const files = gateGenerationFiles(paths, record.generation);
    for (const artifact of [files.job, files.artifact, files.heartbeat]) {
      await rm(artifact, { force: true }).catch(() => {});
    }
    return;
  }
  if (state.gates_watch || !state.gates) return;
  const proof = await readGateProof(record);
  if (proof?.cleanup?.status !== 'confirmed' || state.gates.tree_sha !== record.watch.tree_sha) return;
  await atomicWriteJson(file, { ...record, phase: 'consumed' });
}

export async function recoverGateWatch(paths, state) {
  // Durable launch evidence cannot revoke an explicit seal. In particular an
  // unpublished generation may outlive ABORT when retirement is unknown.
  if (SEALED_STATUSES.has(state.status)) return false;
  const ownership = await inspectGateOwnership(paths.root, paths, state);
  if (!ownership.watch || ownership.retired) return false;
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
