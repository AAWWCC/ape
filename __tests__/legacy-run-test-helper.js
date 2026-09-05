import { execFileSync } from 'node:child_process';
import { runtimePaths } from '../lib/runtime/paths.js';
import { loadRuntimeConfig } from '../lib/runtime/config.js';
import { sha256 } from '../lib/runtime/canonical.js';
import { applyActions } from '../lib/runtime/receipt-service.js';
import { reduceRun } from '../lib/runtime/reducer.js';
import { projectedPipeline } from '../lib/runtime/pipeline.js';
import { evaluateRunReadiness, snapshotRunCapabilities } from '../lib/runtime/readiness.js';
import { initializeRunContractManifest } from '../lib/runtime/run-contract.js';

// Compatibility fixtures only: materialize historical state that may no
// longer satisfy new-run admission. This does not call or bypass public START,
// forge an admission certificate, or claim native host/probe evidence. Ticket
// issuance and all later recovery/binding/receipt checks use production code.
export async function seedLegacyRun(dir, input, { nativeReceiptContract = false } = {}) {
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  const paths = runtimePaths(dir);
  const config = await loadRuntimeConfig(paths.config);
  const at = new Date().toISOString();
  const state = {
    ...input,
    schema_version: '2.0.0',
    run_id: `run-fixture-${sha256(dir).slice(0, 12)}`,
    status: 'starting', stage: 'start',
    requirements: input.requirements ?? [], risk_triggers: input.risk_triggers ?? [],
    claimed_paths: input.claimed_paths ?? [], test_paths: input.test_paths ?? [],
    high_risk: (input.risk_triggers ?? []).length > 0,
    policy: config.policy,
    branch: git('branch', '--show-current'),
    base_branch: git('branch', '--show-current'),
    base_commit_sha: git('rev-parse', 'HEAD'),
    tree_sha: git('rev-parse', 'HEAD^{tree}'),
    tickets: [], receipts: [], attempts: {}, remediation_cycles: 0,
    created_at: at, updated_at: at,
  };
  for (const field of [
    'action', 'project_dir', 'hooks_trusted', 'subagents_available',
    'explicit_invocation', 'binding_probe', 'expected_admission_digest',
    'admission', 'admitted_start_identity_version', 'admitted_start_identity_hash',
    'admitted_run_contract',
  ]) delete state[field];
  if (nativeReceiptContract) {
    if (state.binding_protocol !== 'native-v1') throw new Error('native receipt fixture requires native-v1 binding');
    // Reconstruct the historical frozen capability catalog, not a successful
    // admission result. New admission may correctly reject its long objective.
    const readiness = evaluateRunReadiness({
      input: state, config,
      classification: { lane: state.lane, risk_triggers: state.risk_triggers },
      projection: projectedPipeline(state),
    });
    state.capability_snapshot = snapshotRunCapabilities(readiness);
    await initializeRunContractManifest(paths, state, at);
  }
  const actions = await applyActions(paths, state, reduceRun(null, { type: 'START', run: state }), config);
  return { ok: true, run: state, actions };
}
