import path from 'node:path';
import { RISK_TRIGGERS } from './constants.js';
import { sha256 } from './canonical.js';
import { projectedPipeline } from './pipeline.js';
import { normalizeClaimPath } from './path-scope.js';
import { templateInvocation } from './runner.js';
import { CapabilityManifestSchema } from './schemas.js';
import { currentTreeSha, diffFiles } from './git.js';
import { escalateLane } from './lane-policy.js';
import { extractScopeExpansion } from './receipt-validator.js';
import { runContractByteBudgets, runContractFieldBounds } from './run-contract.js';
import {
  CAPABILITY_MANIFEST_GROWTH_CONTRACT_VERSION,
  capabilityTestPathBoundErrors,
} from './capability-contract.js';

export function capabilityManifestGrowthEnabled(state) {
  return state?.capability_snapshot?.manifest_growth_contract_version ===
    CAPABILITY_MANIFEST_GROWTH_CONTRACT_VERSION;
}

export function ticketCapabilityManifest(state, stage, testPaths) {
  const snapshot = state.capability_snapshot;
  if (
    snapshot?.version !== 1 ||
    state.binding_protocol !== 'native-v1' ||
    typeof snapshot.config_hash !== 'string'
  ) return null;

  const commandProfiles = (snapshot.command_profiles ?? []).filter((profile) =>
    Array.isArray(profile?.roles) && profile.roles.includes(stage.role));
  const requiredVerification = new Set(
    (snapshot.required_capabilities ?? [])
      .filter((capability) => capability?.kind === 'verification_profile')
      .map((capability) => capability.id),
  );
  for (const profile of state.preflight?.artifact?.verification_profiles ?? []) {
    if (profile?.disposition === 'required') requiredVerification.add(profile.id);
  }
  const verificationProfiles = (snapshot.verification_profiles ?? []).map((profile) => ({
    ...structuredClone(profile),
    required: requiredVerification.has(profile.id),
  }));
  const commandProfileById = new Map(
    (snapshot.command_profiles ?? []).map((profile) => [profile?.id, profile]),
  );
  const requiredCapabilities = (snapshot.required_capabilities ?? []).filter((capability) => {
    if (capability?.kind !== 'command_profile') return true;
    if (capability.role !== undefined) return capability.role === stage.role;
    const profile = commandProfileById.get(capability.id);
    return Array.isArray(profile?.roles) && profile.roles.includes(stage.role);
  });

  const commands = new Set();
  const addCommand = (command, commandTestPaths = testPaths) => {
    if (typeof command !== 'string' || command.trim().length === 0) return;
    if (!command.includes('{paths}')) {
      commands.add(command);
      return;
    }
    if (!Array.isArray(commandTestPaths) || commandTestPaths.length === 0) return;
    const invocation = templateInvocation(command, commandTestPaths);
    if (!invocation) return;
    commands.add([invocation.command, ...invocation.args].join(' '));
  };
  for (const profile of commandProfiles) addCommand(profile.command);
  for (const profile of verificationProfiles) addCommand(profile.command);
  for (const command of Object.values(snapshot.test_commands ?? {})) addCommand(command);
  for (const runner of snapshot.runners ?? []) {
    const runnerRoot = normalizeClaimPath(runner?.root ?? '.');
    const relativeTestPaths = (testPaths ?? [])
      .map(normalizeClaimPath)
      .filter((entry) => runnerRoot === '.' || entry === runnerRoot || entry.startsWith(`${runnerRoot}/`))
      .map((entry) => runnerRoot === '.' ? entry : path.posix.relative(runnerRoot, entry));
    for (const command of Object.values(runner?.profile ?? {})) {
      addCommand(command, relativeTestPaths);
    }
  }
  for (const script of snapshot.evidence_scripts ?? []) {
    if (typeof script !== 'string' || script.length === 0) continue;
    for (const command of [
      `npm run ${script}`,
      `pnpm run ${script}`,
      `yarn run ${script}`,
      `bun run ${script}`,
    ]) addCommand(command);
    if (script === 'test') {
      for (const command of ['npm test', 'pnpm test', 'yarn test', 'bun test']) addCommand(command);
    }
  }

  return {
    version: 1,
    config_hash: snapshot.config_hash,
    required_capabilities: structuredClone(requiredCapabilities),
    allowed_evidence_commands: [...commands].sort(),
    command_profiles: structuredClone(commandProfiles),
    verification_profiles: verificationProfiles,
    objective_hash: sha256(state.objective),
    preflight_hash: state.preflight?.artifact_hash ?? null,
    risk_triggers: [...(state.risk_triggers ?? [])],
    design_assurance_required: state.policy?.design_assurance_required === true,
  };
}

export function validateCapabilityManifestGrowth(state, patch = {}) {
  if (!capabilityManifestGrowthEnabled(state)) {
    return {
      valid: true,
      legacy: true,
      errors: [],
      test_path_bounds_valid: true,
      test_path_usage: null,
    };
  }
  const candidate = { ...state, ...patch };
  const testPaths = [...new Set(candidate.test_paths ?? [])];
  const pathBounds = capabilityTestPathBoundErrors(testPaths);
  const errors = [...pathBounds.errors];
  const snapshottedRoles = candidate.capability_snapshot?.manifest_roles;
  const roles = Array.isArray(snapshottedRoles) && snapshottedRoles.length > 0
    ? [...new Set(snapshottedRoles)]
    : [...new Set(
        projectedPipeline(candidate).stages.map((stage) => stage?.role).filter(Boolean),
      )];
  for (const role of roles) {
    let base;
    try {
      base = ticketCapabilityManifest(candidate, { role }, testPaths);
    } catch (error) {
      errors.push(
        `future ${role} capability manifest command derivation failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    if (!base) {
      errors.push(`future ${role} capability manifest is unavailable for the active receipt contract`);
      continue;
    }
    const manifest = {
      ...base,
      receipt_schema: { ref: 'ticket.output_schema', hash: '0'.repeat(64) },
      field_bounds: runContractFieldBounds(),
      byte_budgets: runContractByteBudgets(),
      ...(candidate.run_contract ? { run_contract: structuredClone(candidate.run_contract) } : {}),
    };
    const parsed = CapabilityManifestSchema.safeParse(manifest);
    if (parsed.success) continue;
    for (const issue of parsed.error.issues) {
      const field = issue.path.length > 0 ? issue.path.join('.') : 'capability_manifest';
      errors.push(`future ${role} ${field}: ${issue.message}`);
    }
  }
  return {
    valid: errors.length === 0,
    legacy: false,
    errors: [...new Set(errors)],
    test_path_bounds_valid: pathBounds.valid,
    test_path_usage: pathBounds.usage,
  };
}

export function prospectiveReceiptCapabilityGrowth(state, ticket, draft, changedFiles) {
  const evidence = draft?.evidence && typeof draft.evidence === 'object'
    ? draft.evidence
    : {};
  const receiptRiskTriggers = (Array.isArray(evidence.risk_triggers) ? evidence.risk_triggers : [])
    .filter((value) => typeof value === 'string')
    .map((value) => value.toLowerCase())
    .filter((value) => RISK_TRIGGERS.includes(value));
  const futureRiskTriggers = [...new Set([
    ...(state.risk_triggers ?? []),
    ...receiptRiskTriggers,
  ])];
  const futureTestPaths = ticket.role === 'test_writer'
    ? [...new Set([...(state.test_paths ?? []), ...(changedFiles ?? [])])]
    : [...(state.test_paths ?? [])];
  const scopeExpansion = extractScopeExpansion(ticket, draft);
  const futureClaimedPaths = scopeExpansion.errors.length === 0
    ? [...new Set([...(state.claimed_paths ?? []), ...scopeExpansion.claimed_paths])]
    : [...(state.claimed_paths ?? [])];
  const futureClassification = escalateLane(state.lane, {
    claimed_paths: futureClaimedPaths,
    behavioral: state.behavioral ?? state.mode !== 'spike',
    risk_triggers: futureRiskTriggers,
  }, state.capability_snapshot?.lane_policy ?? {});
  const preflightArtifact =
    ticket.role === 'preflight_analyst' &&
    draft?.status === 'passed' &&
    evidence.preflight_artifact &&
    typeof evidence.preflight_artifact === 'object'
      ? evidence.preflight_artifact
      : null;
  // Scope expansion is normalized by the same receipt extractor and its lane
  // consequence is included in the prospective state. Claimed paths/lane are
  // not serialized in the manifest and roles were frozen from readiness's
  // worst-case graph, but carrying them here keeps validate/stop/record on one
  // complete growth model instead of relying on a record-only reclassification.
  return validateCapabilityManifestGrowth(state, {
    claimed_paths: futureClaimedPaths,
    test_paths: futureTestPaths,
    risk_triggers: futureRiskTriggers,
    high_risk: state.high_risk === true || futureRiskTriggers.length > 0,
    lane: futureClassification.lane,
    ...(preflightArtifact
      ? {
          preflight: {
            version: preflightArtifact.version,
            artifact_hash: sha256(preflightArtifact),
            artifact: preflightArtifact,
          },
        }
      : {}),
  });
}

export async function prospectiveReceiptCapabilityGrowthFromTree(
  projectDir,
  state,
  ticket,
  draft,
) {
  if (!capabilityManifestGrowthEnabled(state)) {
    return validateCapabilityManifestGrowth(state);
  }
  const headTreeSha = await currentTreeSha(projectDir);
  const changedFiles = await diffFiles(projectDir, ticket.base_tree_sha, headTreeSha);
  return prospectiveReceiptCapabilityGrowth(state, ticket, draft, changedFiles);
}

export function mergeReceiptCapabilityGrowthResult(draftResult, growth) {
  if (draftResult?.valid !== true || growth?.valid !== false) return draftResult;
  const pathGrowthFailure = growth.test_path_bounds_valid === false;
  return {
    ...draftResult,
    valid: false,
    corrections: growth.errors.slice(0, 20).map((issue) => ({
      field: pathGrowthFailure ? 'runtime.test_paths' : 'capability_manifest',
      issue,
      correction: pathGrowthFailure
        ? 'reduce or revert authored test files until the runtime-derived test path set fits the ticket-published item and UTF-8 byte bounds, then validate this exact final draft again'
        : 'ask the operator to correct the frozen capability configuration; this worker must not submit or stop against an unrepresentable successor contract',
    })),
    capability_growth: {
      failure_domain: pathGrowthFailure ? 'orchestration' : 'configuration',
      next_action: pathGrowthFailure
        ? { kind: 'continue_same_agent', failure_domain: 'orchestration' }
        : { kind: 'blocked', failure_domain: 'configuration' },
      dynamic_test_paths: growth.test_path_usage,
    },
  };
}
