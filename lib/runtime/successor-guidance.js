import { sha256 } from './canonical.js';
import { terminalFailureDomain, terminalReasonCode } from './terminal-telemetry.js';

const SUCCESSOR_ELIGIBLE_TERMINAL_CODES = Object.freeze({
  configuration: new Set(['capability_blocked']),
  orchestration: new Set(['worker_protocol_failure', 'dispatch_expired']),
  infrastructure: new Set(['worker_protocol_failure', 'dispatch_expired']),
  product: new Set([
    'preflight_failed',
    'planning_rejected',
    'test_contradiction',
    'test_failed',
    'implementation_failed',
    'land_review_disagreement',
    'review_remediation_exhausted',
    'stage_failed',
  ]),
});

export const STRUCTURED_SUCCESSOR_UNAVAILABLE_ERROR =
  'structured successor start is unavailable because current host hooks do not provide authenticated user provenance; after explicit operator direction use audited override reset and start an ordinary fresh run';

export function structuredSuccessorRefusal(rawInput) {
  if (!rawInput || typeof rawInput !== 'object' || !Object.hasOwn(rawInput, 'successor')) return null;
  return {
    ok: false,
    blocked: true,
    attempts_consumed: 0,
    errors: [STRUCTURED_SUCCESSOR_UNAVAILABLE_ERROR],
  };
}

export function successorGuidanceForState(state, config = null) {
  if (!state || state.status !== 'blocked') return null;
  const terminalCode = terminalReasonCode(state);
  const failureDomain = terminalFailureDomain(state);
  const retainedTree = state.tree_sha ?? state.final_tree_sha;
  const startConfigHash = state.start_config_hash;
  if (
    !SUCCESSOR_ELIGIBLE_TERMINAL_CODES[failureDomain]?.has(terminalCode) ||
    typeof state.run_id !== 'string' ||
    typeof retainedTree !== 'string' ||
    !/^[0-9a-f]{40,64}$/i.test(retainedTree) ||
    typeof startConfigHash !== 'string' ||
    !/^[0-9a-f]{64}$/i.test(startConfigHash) ||
    !config
  ) return null;
  const currentConfigHash = sha256(config);
  return {
    version: 2,
    eligible: true,
    predecessor_run_id: state.run_id,
    retained_tree_sha: retainedTree,
    config_hash: currentConfigHash,
    eligibility_reason: terminalCode,
    structured_successor_supported: false,
    unavailable_reason: 'authenticated-host-approval-unavailable',
    recovery_action: 'override-reset',
    required_authorization: 'explicit-operator-override',
    automatic_start: false,
    automatic_ship: false,
    configuration_drift: {
      changed: currentConfigHash !== startConfigHash,
    },
  };
}
