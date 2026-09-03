import path from 'node:path';
import { proposeTestCommands } from './config.js';
import { sha256 } from './canonical.js';
import {
  CAPABILITY_CATALOG_MAX_EVIDENCE_SCRIPTS,
  CAPABILITY_CATALOG_MAX_RUNNERS,
  CAPABILITY_MANIFEST_MAX_COMMAND_PROFILES,
  CAPABILITY_MANIFEST_MAX_VERIFICATION_PROFILES,
  RISK_TRIGGERS,
} from './constants.js';
import {
  CAPABILITY_MANIFEST_GROWTH_CONTRACT_VERSION,
  capabilityDynamicTestPathBounds,
  capabilityTestPathBoundErrors,
  worstCaseCapabilityTestPathSets,
} from './capability-contract.js';
import { normalizeClaimPath } from './path-scope.js';
import { templateInvocation } from './runner.js';
import { CapabilityManifestSchema } from './schemas.js';
import { runContractByteBudgets, runContractFieldBounds } from './run-contract.js';
import { canonicalJson } from './canonical.js';

const MANIFEST_DIGEST_SENTINEL = '0'.repeat(64);
const PLANNING_ROLES = new Set([
  'planner',
  'plan_checker',
  'plan_critic',
  'plan_judge',
]);

function unique(values) {
  return [...new Set(values)];
}

const COMPLEXITY_SCORE_THRESHOLD = 48;
const COMPLEXITY_PLANNING_INPUT_BYTE_THRESHOLD = 8_192;
const DECOMPOSITION_REQUIRED_FIELDS = Object.freeze([
  'id',
  'objective',
  'acceptance',
  'claimed_paths',
  'test_paths',
  'requirements',
  'risk_triggers',
  'verification_profile_ids',
  'depends_on',
]);
const DECOMPOSITION_CONSTRAINTS = Object.freeze([
  'acyclic-dependencies',
  'complete-requirement-and-scope-coverage',
  'non-overlapping-writable-ownership',
  'shared-compatibility-and-rollback',
  'each-slice-passes-complexity-admission',
]);

function complexityAdmission(input, classification) {
  const productionClaims = unique((input.claimed_paths ?? []).filter((entry) =>
    typeof entry === 'string'));
  const testPaths = unique((input.test_paths ?? []).filter((entry) =>
    typeof entry === 'string'));
  const requirements = unique((input.requirements ?? []).filter((entry) =>
    typeof entry === 'string'));
  const riskTriggers = unique((classification.risk_triggers ?? []).filter((entry) =>
    RISK_TRIGGERS.includes(entry))).sort();
  const verificationProfileIds = unique(
    (input.required_capabilities ?? [])
      .filter((entry) => entry?.kind === 'verification_profile' && typeof entry.id === 'string')
      .map((entry) => entry.id),
  ).sort();
  const planningInput = {
    claimed_paths: productionClaims,
    test_paths: testPaths,
    requirements,
    risk_triggers: riskTriggers,
    verification_profile_ids: verificationProfileIds,
  };
  const planningInputBytes = Buffer.byteLength(canonicalJson(planningInput), 'utf8');
  const totalScore = productionClaims.length
    + testPaths.length
    + (2 * requirements.length)
    + (4 * riskTriggers.length)
    + (2 * verificationProfileIds.length);
  return {
    admitted:
      totalScore <= COMPLEXITY_SCORE_THRESHOLD &&
      planningInputBytes <= COMPLEXITY_PLANNING_INPUT_BYTE_THRESHOLD,
    production_claims: productionClaims.length,
    test_paths: testPaths.length,
    requirements: requirements.length,
    risk_triggers: riskTriggers.length,
    required_verification_profiles: verificationProfileIds.length,
    total_score: totalScore,
    score_threshold: COMPLEXITY_SCORE_THRESHOLD,
    planning_input_bytes: planningInputBytes,
    planning_input_byte_threshold: COMPLEXITY_PLANNING_INPUT_BYTE_THRESHOLD,
  };
}

function effectiveCommandProfiles(input, config) {
  return [
    ...(config.policy?.command_profiles ?? []),
    ...(input.run_command_profiles ?? []),
  ];
}

function availableCapabilityCatalog(input, config) {
  const material = {
    evidence_scripts: [...(config.policy?.evidence_scripts ?? [])],
    command_profiles: structuredClone(effectiveCommandProfiles(input, config)),
    verification_profiles: structuredClone(config.verification?.profiles ?? []),
    runners: structuredClone(config.runners ?? []),
    test_commands: structuredClone(config.test_commands ?? {}),
  };
  return {
    version: 1,
    config_hash: sha256(config),
    catalog_hash: sha256(material),
    ...material,
  };
}

function capabilitySnapshot(
  input,
  config,
  catalog = availableCapabilityCatalog(input, config),
  projection = null,
) {
  const required = structuredClone(input.required_capabilities ?? []);
  return {
    version: 1,
    manifest_growth_contract_version: CAPABILITY_MANIFEST_GROWTH_CONTRACT_VERSION,
    manifest_roles: unique(
      (projection?.stages ?? []).map((stage) => stage?.role).filter(Boolean),
    ),
    lane_policy: {
      fast_max_files: config.policy?.fast_max_files,
    },
    config_hash: catalog.config_hash,
    required_capabilities: required,
    evidence_scripts: structuredClone(catalog.evidence_scripts),
    command_profiles: structuredClone(catalog.command_profiles),
    verification_profiles: structuredClone(catalog.verification_profiles),
    runners: structuredClone(catalog.runners),
    test_commands: structuredClone(catalog.test_commands),
  };
}

function derivedCapabilityRequirements(input, classification, projection) {
  const stages = Array.isArray(projection?.stages) ? projection.stages : [];
  const behavioralLane =
    input.behavioral !== false && ['fast', 'full'].includes(classification.lane);
  return {
    stage_roles: unique(stages.map((stage) => stage?.role).filter(Boolean)),
    stage_checks: unique(stages.flatMap((stage) => stage?.required_checks ?? [])),
    test_runner_profiles: behavioralLane ? ['targeted', 'full'] : [],
  };
}

function capabilityContractRequested(input) {
  return input.capability_contract_required === true ||
    (input.required_capabilities?.length ?? 0) > 0 ||
    (input.run_command_profiles?.length ?? 0) > 0;
}

function addCommand(commands, derivationErrors, command, testPaths) {
  if (typeof command !== 'string' || command.trim().length === 0) return;
  if (!command.includes('{paths}')) {
    commands.add(command);
    return;
  }
  if (!Array.isArray(testPaths) || testPaths.length === 0) return;
  try {
    const invocation = templateInvocation(command, testPaths);
    if (invocation) commands.add([invocation.command, ...invocation.args].join(' '));
  } catch (error) {
    derivationErrors.push(error instanceof Error ? error.message : String(error));
  }
}

// Mirror ticketCapabilityManifest's deterministic command derivation before a
// run exists. projectedPipeline includes every role the run can reach, so the
// check covers late review/remediation tickets as well as the first ticket.
function prospectiveRoleCapabilityManifest(
  input,
  config,
  classification,
  role,
  configHash,
  {
    test_paths = input.test_paths ?? [],
    all_verification_profiles_required = false,
    risk_triggers = classification.risk_triggers,
    reachable_roles = [],
  } = {},
) {
  const allCommandProfiles = effectiveCommandProfiles(input, config);
  const commandProfiles = allCommandProfiles.filter((profile) =>
    Array.isArray(profile?.roles) && profile.roles.includes(role));
  const reachableRoles = new Set(reachable_roles);
  const planningCommandProfiles = PLANNING_ROLES.has(role)
    ? allCommandProfiles.filter((profile) =>
        Array.isArray(profile?.roles) && profile.roles.some((entry) => reachableRoles.has(entry)))
    : null;
  const requiredVerification = new Set(
    (input.required_capabilities ?? [])
      .filter((capability) => capability?.kind === 'verification_profile')
      .map((capability) => capability.id),
  );
  if (all_verification_profiles_required) {
    for (const profile of config.verification?.profiles ?? []) {
      if (typeof profile?.id === 'string') requiredVerification.add(profile.id);
    }
  }
  const verificationProfiles = (config.verification?.profiles ?? []).map((profile) => ({
    ...structuredClone(profile),
    required: requiredVerification.has(profile.id),
  }));
  const commandProfileById = new Map(
    allCommandProfiles.map((profile) => [profile?.id, profile]),
  );
  const requiredCapabilities = (input.required_capabilities ?? []).filter((capability) => {
    if (capability?.kind !== 'command_profile') return true;
    if (capability.role !== undefined) return capability.role === role;
    const profile = commandProfileById.get(capability.id);
    return Array.isArray(profile?.roles) && profile.roles.includes(role);
  });

  const commands = new Set();
  const plannableCommands = planningCommandProfiles ? new Set() : null;
  const derivationErrors = [];
  const testPaths = test_paths;
  for (const profile of commandProfiles) {
    addCommand(commands, derivationErrors, profile.command, testPaths);
  }
  for (const profile of planningCommandProfiles ?? []) {
    addCommand(plannableCommands, derivationErrors, profile.command, testPaths);
  }
  for (const profile of verificationProfiles) {
    addCommand(commands, derivationErrors, profile.command, testPaths);
    if (plannableCommands) {
      addCommand(plannableCommands, derivationErrors, profile.command, testPaths);
    }
  }
  for (const command of Object.values(config.test_commands ?? {})) {
    addCommand(commands, derivationErrors, command, testPaths);
    if (plannableCommands) {
      addCommand(plannableCommands, derivationErrors, command, testPaths);
    }
  }
  for (const runner of config.runners ?? []) {
    const runnerRoot = normalizeClaimPath(runner?.root ?? '.');
    const relativeTestPaths = testPaths
      .map(normalizeClaimPath)
      .filter((entry) => runnerRoot === '.' || entry === runnerRoot || entry.startsWith(`${runnerRoot}/`))
      .map((entry) => runnerRoot === '.' ? entry : path.posix.relative(runnerRoot, entry));
    for (const command of Object.values(runner?.profile ?? {})) {
      addCommand(commands, derivationErrors, command, relativeTestPaths);
      if (plannableCommands) {
        addCommand(plannableCommands, derivationErrors, command, relativeTestPaths);
      }
    }
  }
  for (const script of config.policy?.evidence_scripts ?? []) {
    if (typeof script !== 'string' || script.length === 0) continue;
    for (const command of [
      `npm run ${script}`,
      `pnpm run ${script}`,
      `yarn run ${script}`,
      `bun run ${script}`,
    ]) {
      addCommand(commands, derivationErrors, command, testPaths);
      if (plannableCommands) {
        addCommand(plannableCommands, derivationErrors, command, testPaths);
      }
    }
    if (script === 'test') {
      for (const command of ['npm test', 'pnpm test', 'yarn test', 'bun test']) {
        addCommand(commands, derivationErrors, command, testPaths);
        if (plannableCommands) {
          addCommand(plannableCommands, derivationErrors, command, testPaths);
        }
      }
    }
  }

  return {
    derivationErrors,
    manifest: {
      version: 1,
      config_hash: configHash,
      required_capabilities: structuredClone(requiredCapabilities),
      allowed_evidence_commands: [...commands].sort(),
      command_profiles: structuredClone(commandProfiles),
      ...(planningCommandProfiles
        ? {
            planning_required_capabilities: structuredClone(
              input.required_capabilities ?? [],
            ),
            plannable_evidence_commands: [...plannableCommands].sort(),
            planning_command_profiles: structuredClone(planningCommandProfiles),
          }
        : {}),
      verification_profiles: verificationProfiles,
      objective_hash: sha256(input.objective),
      // A later ticket may carry the accepted preflight hash. Validating the
      // larger representation up front prevents a boundary-only late failure.
      preflight_hash: MANIFEST_DIGEST_SENTINEL,
      risk_triggers: [...risk_triggers],
      design_assurance_required: config.policy?.design_assurance_required !== false,
      receipt_schema: {
        ref: 'ticket.output_schema',
        hash: MANIFEST_DIGEST_SENTINEL,
      },
      field_bounds: runContractFieldBounds(),
      byte_budgets: runContractByteBudgets(),
      // New tickets carry this fixed-shape pointer after their contract
      // revision is appended. Include its largest reachable revision width in
      // the admission material rather than validating the smaller base form.
      run_contract: {
        version: 1,
        revision: 10_002,
        ref: `.ape/runtime/contracts/${MANIFEST_DIGEST_SENTINEL}.json`,
        hash: MANIFEST_DIGEST_SENTINEL,
      },
    },
  };
}

function addCollectionLimit(blocking, code, provided, limit) {
  if (provided <= limit) return;
  blocking.push({ code, provided, limit });
}

function capabilityManifestReadiness(input, config, classification, projection, configHash) {
  const blocking = [];
  addCollectionLimit(
    blocking,
    'capability-command-profiles-over-limit',
    effectiveCommandProfiles(input, config).length,
    CAPABILITY_MANIFEST_MAX_COMMAND_PROFILES,
  );
  addCollectionLimit(
    blocking,
    'capability-verification-profiles-over-limit',
    (config.verification?.profiles ?? []).length,
    CAPABILITY_MANIFEST_MAX_VERIFICATION_PROFILES,
  );
  addCollectionLimit(
    blocking,
    'capability-evidence-scripts-over-limit',
    (config.policy?.evidence_scripts ?? []).length,
    CAPABILITY_CATALOG_MAX_EVIDENCE_SCRIPTS,
  );
  addCollectionLimit(
    blocking,
    'capability-runners-over-limit',
    (config.runners ?? []).length,
    CAPABILITY_CATALOG_MAX_RUNNERS,
  );

  const roles = unique((projection?.stages ?? []).map((stage) => stage?.role).filter(Boolean));
  const initialPathBounds = capabilityTestPathBoundErrors(input.test_paths ?? []);
  if (!initialPathBounds.valid) {
    if (initialPathBounds.usage.used_items > initialPathBounds.usage.max_items) {
      blocking.push({
        code: 'capability-test-path-items-over-limit',
        provided: initialPathBounds.usage.used_items,
        limit: initialPathBounds.usage.max_items,
      });
    }
    if (initialPathBounds.usage.used_bytes > initialPathBounds.usage.max_bytes) {
      blocking.push({
        code: 'capability-test-path-bytes-over-limit',
        provided: initialPathBounds.usage.used_bytes,
        limit: initialPathBounds.usage.max_bytes,
      });
    }
  }
  const scenarios = [{
    source: 'initial',
    test_paths: initialPathBounds.usage.paths,
    all_verification_profiles_required: false,
    risk_triggers: classification.risk_triggers,
  }, {
    // Even a read-only/debug/land pipeline can surface a late canonical risk,
    // and a preflight-bearing run can require every configured profile. Keep
    // this scenario independent of test-writer reachability.
    source: 'future-monotone-fields',
    test_paths: initialPathBounds.usage.paths,
    all_verification_profiles_required: true,
    risk_triggers: RISK_TRIGGERS,
  }];
  if (roles.includes('test_writer')) {
    for (const scenario of worstCaseCapabilityTestPathSets(config.runners ?? [])) {
      if (scenario.error) {
        blocking.push({
          code: 'capability-dynamic-test-path-derivation-failed',
          runner_root: scenario.root,
          message: scenario.error,
        });
        continue;
      }
      scenarios.push({
        source: `dynamic-worst-case:${scenario.root}`,
        test_paths: scenario.paths,
        // A valid preflight may require every configured profile, and any
        // later receipt may surface every canonical risk trigger. Both facts
        // are monotone for the run, so readiness sizes the future manifest
        // with their complete reachable representation rather than today's
        // smaller values.
        all_verification_profiles_required: true,
        risk_triggers: RISK_TRIGGERS,
      });
    }
  }
  for (const role of roles) {
    for (const scenario of scenarios) {
      const prospective = prospectiveRoleCapabilityManifest(
        input,
        config,
        classification,
        role,
        configHash,
        { ...scenario, reachable_roles: roles },
      );
      for (const message of unique(prospective.derivationErrors)) {
        blocking.push({
          code: 'capability-evidence-command-derivation-failed',
          role,
          source: scenario.source,
          message,
        });
      }
      const parsed = CapabilityManifestSchema.safeParse(prospective.manifest);
      if (parsed.success) continue;
      for (const issue of parsed.error.issues) {
        const field = issue.path.join('.');
        const evidenceCommandsField = field === 'allowed_evidence_commands' ||
          field === 'plannable_evidence_commands';
        const code = evidenceCommandsField && issue.code === 'too_big'
          ? 'capability-evidence-commands-over-limit'
          : field.startsWith('allowed_evidence_commands.') ||
              field.startsWith('plannable_evidence_commands.')
            ? 'capability-evidence-command-invalid'
            : (field === 'command_profiles' || field === 'planning_command_profiles') &&
                issue.code === 'too_big'
              ? 'capability-command-profiles-over-limit'
              : field === 'verification_profiles' && issue.code === 'too_big'
                ? 'capability-verification-profiles-over-limit'
                : field.length === 0 && /serialized UTF-8 bytes/.test(issue.message)
                  ? 'capability-manifest-bytes-over-limit'
                  : 'capability-manifest-schema-invalid';
        blocking.push({
          code,
          role,
          source: scenario.source,
          field: field || null,
          message: issue.message,
          ...(evidenceCommandsField
            ? { provided: prospective.manifest[field].length }
            : {}),
        });
      }
    }
  }
  const seen = new Set();
  return blocking.filter((entry) => {
    // One representative failing scenario is actionable; repeating the same
    // role/field error for every runner root can itself overflow preview's
    // response budget on a 64-runner configuration.
    const { source: _source, runner_root: _runnerRoot, ...stable } = entry;
    const key = JSON.stringify(stable);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Pure admission evaluator. Every I/O-derived fact is supplied by the caller;
 * this function can therefore be shared by preview, start, and doctor without
 * making readiness depend on which surface asked the question.
 */
export function evaluateRunReadiness({ input, config, classification, projection, discovered = { targeted: false, full: false } }) {
  const blocking = [];
  const warnings = [];
  const requestedCapabilities = structuredClone(input.required_capabilities ?? []);
  const derivedRequirements = derivedCapabilityRequirements(input, classification, projection);
  const verificationProfiles = config.verification?.profiles ?? [];
  derivedRequirements.dynamic_test_paths = capabilityDynamicTestPathBounds();
  derivedRequirements.future_manifest_conditions = {
    required_verification_profile_ids: verificationProfiles
      .map((profile) => profile?.id)
      .filter((id) => typeof id === 'string'),
    risk_triggers: [...RISK_TRIGGERS],
  };
  const availableCatalog = availableCapabilityCatalog(input, config);
  const commandProfiles = effectiveCommandProfiles(input, config);
  const evidenceScripts = new Set(config.policy?.evidence_scripts ?? []);
  const complexity = complexityAdmission(input, classification);
  if (!complexity.admitted) {
    blocking.push({
      code: 'complexity-decomposition-required',
      complexity: { ...complexity, admitted: undefined },
      decomposition_contract: {
        required_fields: [...DECOMPOSITION_REQUIRED_FIELDS],
        constraints: [...DECOMPOSITION_CONSTRAINTS],
      },
    });
    delete blocking.at(-1).complexity.admitted;
  }

  const configuredProfileIds = new Set(
    (config.policy?.command_profiles ?? []).map((profile) => profile?.id).filter(Boolean),
  );
  for (const profile of input.run_command_profiles ?? []) {
    if (configuredProfileIds.has(profile.id)) {
      blocking.push({
        code: 'run-command-profile-id-conflict',
        profile_id: profile.id,
      });
    }
  }

  if (capabilityContractRequested(input)) {
    blocking.push(...capabilityManifestReadiness(
      input,
      config,
      classification,
      projection,
      availableCatalog.config_hash,
    ));
  }

  for (const requirement of input.required_capabilities ?? []) {
    if (requirement.kind === 'command_profile') {
      const profile = commandProfiles.find((entry) => entry.id === requirement.id);
      if (!profile) {
        blocking.push({ code: 'missing-command-profile', capability: requirement });
      } else if (requirement.role && !profile.roles?.includes(requirement.role)) {
        blocking.push({ code: 'command-profile-role-mismatch', capability: requirement });
      }
    } else if (requirement.kind === 'verification_profile') {
      if (!verificationProfiles.some((entry) => entry.id === requirement.id)) {
        blocking.push({ code: 'missing-verification-profile', capability: requirement });
      }
    } else if (requirement.kind === 'evidence_command') {
      if (!evidenceScripts.has(requirement.id)) {
        blocking.push({ code: 'missing-evidence-script', capability: requirement });
      }
    }
  }

  const behavioralLane = input.behavioral !== false && ['fast', 'full'].includes(classification.lane);
  if (behavioralLane) {
    const runners = Array.isArray(config.runners) ? config.runners : [];
    const configuredTargeted = Boolean(
      config.test_commands?.targeted ||
      config.test_commands?.targeted_template ||
      (runners.length > 0 && runners.every(
        (runner) => runner.profile?.targeted || runner.profile?.targeted_template,
      )),
    );
    const configuredFull = Boolean(
      config.test_commands?.full || (runners.length > 0 && runners.every((runner) => runner.profile?.full)),
    );
    if (!configuredTargeted) {
      blocking.push({ code: 'missing-targeted-test-runner' });
    }
    if (!configuredFull) {
      blocking.push({ code: 'missing-full-test-runner' });
    }
    if ((!configuredTargeted && discovered.targeted) || (!configuredFull && discovered.full)) {
      warnings.push({
        code: 'unapplied-runner-proposal',
        targeted: discovered.targeted === true,
        full: discovered.full === true,
      });
    }
  }

  return {
    ready: blocking.length === 0,
    blocking,
    warnings,
    requested_capabilities: requestedCapabilities,
    derived_capability_requirements: derivedRequirements,
    available_capability_catalog: availableCatalog,
    compiled_surface: {
      version: 1,
      roles: derivedRequirements.stage_roles,
      transition_scenarios: ['initial', 'future-monotone-fields'],
      includes: [
        'command_profiles',
        'evidence_commands',
        'path_claims',
        'test_claims',
        'verification_profiles',
        'receipt_schemas',
        'field_bounds',
        'byte_budgets',
      ],
    },
    complexity_admission: complexity,
    // Compatibility snapshot consumed by startRun/ticket issuance. Keep this
    // flat persisted shape while preview exposes the three concepts above
    // separately so requested requirements are never mistaken for availability.
    capabilities: capabilitySnapshot(input, config, availableCatalog, projection),
  };
}

export async function discoverRunReadiness(projectDir) {
  const proposal = (await proposeTestCommands(projectDir)).proposal;
  return {
    targeted: Boolean(
      proposal.test_commands?.targeted ||
      proposal.test_commands?.targeted_template ||
      proposal.runners?.some((runner) => runner.profile?.targeted || runner.profile?.targeted_template),
    ),
    full: Boolean(
      proposal.test_commands?.full || proposal.runners?.some((runner) => runner.profile?.full),
    ),
  };
}

export function snapshotRunCapabilities(readiness) {
  return structuredClone(readiness.capabilities);
}

export function uniqueReadinessCodes(readiness) {
  return unique((readiness?.blocking ?? []).map((entry) => entry.code));
}
