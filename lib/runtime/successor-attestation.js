import { sha256 } from './canonical.js';

const RUN_ID = /^run-[A-Za-z0-9_-]{1,128}$/u;
const TREE_SHA = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const APPROVAL_ID = /^successor-approval-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ATTESTATION_V1_KEYS = [
  'attestation_hash',
  'authorization',
  'predecessor_record_hash',
  'predecessor_run_id',
  'request_hash',
  'retained_tree_sha',
  'version',
];
const ATTESTATION_V2_KEYS = [
  'approval_id',
  'attestation_hash',
  'authorization',
  'config_hash',
  'predecessor_record_hash',
  'predecessor_run_id',
  'request_hash',
  'retained_tree_sha',
  'version',
];

function successorMaterial(value) {
  return {
    version: value.version,
    predecessor_run_id: value.predecessor_run_id,
    retained_tree_sha: value.retained_tree_sha,
    ...(value.version === 2
      ? {
          config_hash: value.config_hash,
          approval_id: value.approval_id,
          authorization: 'trusted-host-approval',
        }
      : { authorization: 'explicit-operator-start' }),
  };
}

function attestationMaterial(value, successorRunId) {
  return {
    version: value.version,
    predecessor_run_id: value.predecessor_run_id,
    predecessor_record_hash: value.predecessor_record_hash,
    retained_tree_sha: value.retained_tree_sha,
    ...(value.version === 2
      ? {
          config_hash: value.config_hash,
          approval_id: value.approval_id,
          authorization: 'trusted-host-approval',
        }
      : { authorization: 'explicit-operator-start' }),
    request_hash: value.request_hash,
    successor_run_id: successorRunId,
  };
}

export function createSuccessorAttestation(
  request,
  predecessorRecordHash,
  successorRunId,
  successorRequestHash,
) {
  const base = {
    ...successorMaterial(request),
    predecessor_record_hash: predecessorRecordHash,
    request_hash: successorRequestHash,
  };
  return {
    ...base,
    attestation_hash: sha256(attestationMaterial(base, successorRunId)),
  };
}

export function validatedSuccessorAttestation(
  value,
  supersedesRun,
  successorRunId,
  successorRequestHash,
  successorStartConfigHash = null,
) {
  const attestationKeys = value?.version === 2 ? ATTESTATION_V2_KEYS : ATTESTATION_V1_KEYS;
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join('\0') !== attestationKeys.join('\0') ||
    ![1, 2].includes(value.version) ||
    value.predecessor_run_id !== supersedesRun ||
    !RUN_ID.test(value.predecessor_run_id) ||
    typeof successorRunId !== 'string' ||
    !RUN_ID.test(successorRunId) ||
    typeof value.predecessor_record_hash !== 'string' ||
    !SHA256.test(value.predecessor_record_hash) ||
    typeof value.retained_tree_sha !== 'string' ||
    !TREE_SHA.test(value.retained_tree_sha) ||
    (
      value.version === 2 &&
      (
        typeof value.config_hash !== 'string' ||
        !SHA256.test(value.config_hash) ||
        value.config_hash !== successorStartConfigHash ||
        typeof value.approval_id !== 'string' ||
        !APPROVAL_ID.test(value.approval_id)
      )
    ) ||
    value.authorization !== (
      value.version === 2 ? 'trusted-host-approval' : 'explicit-operator-start'
    ) ||
    typeof value.request_hash !== 'string' ||
    !SHA256.test(value.request_hash) ||
    value.request_hash !== successorRequestHash ||
    typeof value.attestation_hash !== 'string' ||
    value.attestation_hash !== sha256(attestationMaterial(value, successorRunId))
  ) return null;
  return Object.fromEntries(attestationKeys.map((key) => [key, value[key]]));
}

export function validateSuccessorLineageBinding(
  value,
  {
    predecessor,
    supersedesRun,
    successorRunId,
    successorRequestHash,
    successorStartConfigHash,
    successorStartRequestHash,
  },
) {
  if (value === undefined || value === null) {
    return { ok: false, reason: 'unattested-supersession' };
  }
  // Version 1 remains parseable and archive-visible, but it predates the
  // reviewed-configuration commitment and therefore cannot promote a primary
  // logical outcome. Only version 2 can form a trusted lineage edge.
  if (value.version !== 2) {
    return { ok: false, reason: 'legacy-successor-attestation' };
  }
  const attestation = validatedSuccessorAttestation(
    value,
    supersedesRun,
    successorRunId,
    successorRequestHash,
    successorStartConfigHash,
  );
  if (!attestation) return { ok: false, reason: 'invalid-successor-attestation' };
  if (typeof successorStartRequestHash !== 'string') {
    return { ok: false, reason: 'unbound-successor-start-request' };
  }
  if (successorStartRequestHash !== successorRequestHash) {
    return { ok: false, reason: 'mismatched-successor-start-request' };
  }
  if (
    !predecessor ||
    predecessor.run_id !== supersedesRun ||
    predecessor.record_hash !== attestation.predecessor_record_hash ||
    predecessor.final_tree_sha !== attestation.retained_tree_sha
  ) {
    return { ok: false, reason: 'mismatched-successor-attestation' };
  }
  return { ok: true, attestation };
}
