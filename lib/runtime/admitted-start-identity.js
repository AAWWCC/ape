import { sha256 } from './canonical.js';

const SHA256_HEX = /^[0-9a-f]{64}$/;
export const ADMITTED_START_IDENTITY_VERSION = 1;

// This projection contains every immutable start-time authority value used by
// the runtime. The complete normalized RunStartInput is bound through
// start_request_hash, while derived policy/capability authority is bound
// directly. Mutable lifecycle state (status, tickets, receipts, expanded
// claims, lane escalation, gates, shipping, and timing) is deliberately absent.
export function admittedStartIdentityHash(state) {
  return sha256({
    version: ADMITTED_START_IDENTITY_VERSION,
    version_provenance: {
      version: state.version,
      schema_version: state.schema_version,
      ape_version: state.ape_version,
      runtime_version: state.runtime_version,
      host_plugin_version: state.host_plugin_version,
      protocol_version: state.protocol_version,
      envelope_version: state.envelope_version,
    },
    run_id: state.run_id,
    start_request_hash: state.start_request_hash,
    objective: state.objective,
    mode: state.mode,
    requested_lane: state.requested_lane,
    behavioral: state.behavioral,
    test_intent: state.test_intent,
    policy: state.policy,
    start_config_hash: state.start_config_hash,
    ...(state.admission ? { admission: state.admission } : {}),
    ...(state.shipping_target ? { shipping_target: state.shipping_target } : {}),
    capability_snapshot: state.capability_snapshot,
    admitted_run_contract: state.admitted_run_contract,
    host: state.host,
    binding_protocol: state.binding_protocol,
    auto_merge_authorized: state.auto_merge_authorized === true,
    plan_contract_version: state.plan_contract_version,
    verification_profiles: state.verification_profiles,
    verification_profile_roots: state.verification_profile_roots,
    requirements: state.requirements,
    completes: state.completes,
    supersedes_run: state.supersedes_run,
    carry_forward: state.carry_forward,
    successor_request_hash: state.successor_request_hash,
    successor_attestation: state.successor_attestation,
    branch: state.branch,
    base_branch: state.base_branch,
    base_commit_sha: state.base_commit_sha,
    created_at: state.created_at,
  });
}

export function validatedAdmittedStartIdentity(state) {
  if (
    state?.admitted_start_identity_version !== ADMITTED_START_IDENTITY_VERSION
    || typeof state.start_request_hash !== 'string'
    || !SHA256_HEX.test(state.start_request_hash)
    || typeof state.admitted_start_identity_hash !== 'string'
    || !SHA256_HEX.test(state.admitted_start_identity_hash)
  ) return null;
  const computed = admittedStartIdentityHash(state);
  if (computed !== state.admitted_start_identity_hash) return null;
  return {
    version: ADMITTED_START_IDENTITY_VERSION,
    start_request_hash: state.start_request_hash,
    // The archive commitment is structurally complete for every run. A run
    // admitted without a plan contract carries an explicit null pointer rather
    // than omitting the commitment field and becoming indistinguishable from a
    // legacy archive.
    admitted_run_contract: state.admitted_run_contract ?? null,
    hash: computed,
  };
}
