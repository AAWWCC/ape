import { canonicalJson, sha256 } from './canonical.js';
import { resolveModel } from './config.js';
import { ROLE_POLICIES } from './constants.js';
import { normalizeClaimPath } from './path-scope.js';
import { pipelineLimits } from './pipeline-limits.js';
import { pipelineRunSpec, projectedPipeline } from './pipeline.js';
import { candidatePlanForScope, PLAN_CONTRACT_LIMITS } from './plan-contract.js';

const PREFLIGHT_PLACEHOLDER = '0'.repeat(64);
const TEMPLATE_INSTRUCTIONS = Object.freeze([
  'This is a schema-valid planning template, not an approved plan or write authority.',
  'Replace descriptive placeholders with grounded project evidence; preserve every required field and all authorized requirement coverage.',
  'Materialize directory or pattern claims as concrete in-scope paths; never treat this template as permission to add claims.',
  'Use the exact authoritative preflight hash and exact plannable commands from the issued ticket; do not submit the placeholder hash.',
]);

function distinct(values) {
  return [...new Set(values)];
}

function plannerTemplate({ input, config, classification, planning_commands }) {
  const blocking = [];
  const requirements = distinct(input.requirements ?? []);
  const claims = distinct([...(input.claimed_paths ?? []), ...(input.test_paths ?? [])]);
  const paths = distinct(claims.map(normalizeClaimPath));
  const workstreamCount = Math.ceil(paths.length / PLAN_CONTRACT_LIMITS.paths_per_workstream);
  for (const [field, provided, limit] of [
    ['requirements', requirements.length, PLAN_CONTRACT_LIMITS.requirements],
    ['workstreams', workstreamCount, PLAN_CONTRACT_LIMITS.workstreams],
    ['requirement_chars', requirements.reduce((max, entry) => Math.max(max, entry.length), 0), PLAN_CONTRACT_LIMITS.text_chars],
    ['path_chars', paths.reduce((max, entry) => Math.max(max, entry.length), 0), PLAN_CONTRACT_LIMITS.path_chars],
  ]) {
    if (provided > limit) blocking.push({ code: 'planner-decomposition-required', field, provided, limit });
  }
  const command = distinct(planning_commands)
    .filter((entry) => typeof entry === 'string' && entry.trim() && entry.length <= PLAN_CONTRACT_LIMITS.text_chars)
    .sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0))[0];
  if (!command) blocking.push({ code: 'planner-evidence-command-unavailable' });
  if (paths.length === 0) blocking.push({ code: 'planner-concrete-paths-required' });
  const base = {
    applicable: true,
    authority: 'template-only',
    bounds: PLAN_CONTRACT_LIMITS,
    preflight_hash_required: input.plan_contract_version === 2,
    // Admission has authority envelopes, not a filesystem inventory. Even a
    // file-shaped claim may be a directory; only the planner can resolve it.
    concrete_path_resolution_needed: true,
    instructions: [...TEMPLATE_INSTRUCTIONS],
    decomposition: {
      workstream_count: workstreamCount,
      paths_per_workstream: PLAN_CONTRACT_LIMITS.paths_per_workstream,
      preserves_requirement_and_scope_coverage: true,
    },
  };
  if (blocking.length) return { blocking, planner: { ...base, representable: false } };

  // The root claim is valid authority but is not a concrete plan path. Without
  // project I/O we cannot invent a child file or prove the scope impossible.
  if (paths.includes('.')) return {
    blocking,
    planner: { ...base, representable: null },
  };

  const version = input.plan_contract_version;
  const verificationProfiles = config.verification?.profiles ?? [];
  // A preflight may require any configured profile. A template covers the
  // complete reachable set, not only the caller's initial requested subset.
  const profileIds = verificationProfiles.map((profile) => profile.id);
  const workstreams = Array.from({ length: workstreamCount }, (_, index) => ({
    id: `W${index + 1}`,
    outcome: 'Specify the authorized outcome for this workstream.',
    paths: paths.slice(index * PLAN_CONTRACT_LIMITS.paths_per_workstream, (index + 1) * PLAN_CONTRACT_LIMITS.paths_per_workstream)
      .map((entry) => ({ path: entry, action: 'modify' })),
    steps: ['Specify the implementation steps.'],
    acceptance: ['Specify observable acceptance evidence.'],
    evidence_commands: [command],
    ...(version === 2 ? { verification_profiles: index === 0 ? profileIds : [] } : {}),
  }));
  const risks = distinct(classification.risk_triggers ?? []);
  const template = {
    version,
    ...(version === 2 ? { preflight_hash: PREFLIGHT_PLACEHOLDER } : {}),
    requirements: (requirements.length ? requirements : ['Specify the authorized objective.']).map((entry, index) => ({
      id: `R${index + 1}`, requirement: entry, workstreams: workstreams.map((workstream) => workstream.id),
    })),
    workstreams,
    risks: [],
    ...(version === 2 && config.policy?.design_assurance_required !== false ? {
      assurances: risks.map((trigger, index) => ({
        id: `A${index + 1}`, risk_trigger: trigger,
        threat_model: 'Specify the threat boundary.',
        feasibility: 'Specify why the design is feasible.',
        failure_modes: ['Specify the relevant failure modes.'],
        crash_recovery: 'Specify crash and recovery behavior.',
        migration: 'Specify compatibility and migration behavior.',
        determinism: 'Specify deterministic behavior.',
        executable_tests: ['Specify an executable assurance test.'],
      })),
    } : {}),
    non_goals: [],
  };
  const templateBytes = Buffer.byteLength(canonicalJson(template), 'utf8');
  if (templateBytes > PLAN_CONTRACT_LIMITS.candidate_plan_utf8_bytes) {
    blocking.push({ code: 'planner-decomposition-required', field: 'candidate_plan_utf8_bytes',
      provided: templateBytes, limit: PLAN_CONTRACT_LIMITS.candidate_plan_utf8_bytes });
  } else {
    // Pass an exact command catalog so the consumer validator remains pure;
    // it must never fall back to probing package.json or current project state.
    const accepted = candidatePlanForScope(template, claims, null, {
      preflight_hash: PREFLIGHT_PLACEHOLDER,
      verification_profiles: verificationProfiles.map((profile) => ({ id: profile.id, required: true })),
      require_design_assurance: config.policy?.design_assurance_required !== false,
      risk_triggers: risks,
      plannable_evidence_commands: planning_commands,
    });
    if (!accepted.valid) blocking.push({ code: 'planner-template-unrepresentable', diagnostic_count: accepted.errors.length });
  }
  return {
    blocking,
    planner: {
      ...base,
      representable: blocking.length === 0,
      template_utf8_bytes: templateBytes,
      ...(blocking.length === 0 ? { template, template_hash: sha256(template) } : {}),
    },
  };
}

function sameContract(left, right) {
  try { return canonicalJson(left) === canonicalJson(right); } catch { return false; }
}

function pipelineContract(input, config, classification, projection) {
  // Reuse the same projection builder as preview/scheduling, rather than
  // maintaining another hand-authored stage graph in the compiler.
  const expected = projectedPipeline(pipelineRunSpec(input, classification, config));
  const blocking = [];
  const actualStages = projection.stages ?? [];
  const expectedIds = new Set(expected.stages.map((entry) => entry.id));
  if (actualStages.some((entry) => !expectedIds.has(entry.id))) blocking.push({ code: 'pipeline-unexpected-stage' });
  for (const producer of expected.stages) {
    const actual = actualStages.filter((entry) => entry.id === producer.id);
    if (actual.length !== 1) {
      blocking.push({ code: 'pipeline-stage-missing', stage_id: producer.id });
      continue;
    }
    if (!sameContract(actual[0].output_schema, producer.output_schema)) {
      blocking.push({ code: 'pipeline-producer-schema-invalid', stage_id: producer.id });
    }
    for (const field of ['role', 'writable', 'model_tier', 'parallel_group', 'required_checks']) {
      if (!sameContract(actual[0][field], producer[field])) {
        blocking.push({ code: 'pipeline-stage-contract-mismatch', stage_id: producer.id, field });
      }
    }
    const expectedVariants = 'required_check_variants' in producer ? producer.required_check_variants : null;
    if (!sameContract(actual[0].required_check_variants ?? null, expectedVariants)) {
      blocking.push({ code: 'pipeline-stage-contract-mismatch', stage_id: producer.id, field: 'required_check_variants' });
    }
  }
  const runtime = projection.runtime_stages ?? [];
  const expectedRuntimeIds = new Set(expected.runtime_stages.map((entry) => entry.id));
  if (runtime.some((entry) => !expectedRuntimeIds.has(entry.id))) blocking.push({ code: 'pipeline-unexpected-runtime-stage' });
  for (const consumer of expected.runtime_stages) {
    const actual = runtime.filter((entry) => entry.id === consumer.id);
    if (actual.length !== 1) blocking.push({ code: 'pipeline-runtime-stage-missing', stage_id: consumer.id });
    else if (!sameContract(actual[0], consumer)) blocking.push({ code: 'pipeline-runtime-contract-mismatch', stage_id: consumer.id });
  }
  const endpoints = new Set([...actualStages, ...runtime].map((entry) => entry.id));
  const suppliedEdges = projection.artifact_edges ?? [];
  const expectedArtifacts = new Set(expected.artifact_edges.map((entry) => entry.artifact));
  if (suppliedEdges.some((entry) => !expectedArtifacts.has(entry.artifact))) blocking.push({ code: 'pipeline-unexpected-artifact' });
  for (const required of expected.artifact_edges) {
    const actual = suppliedEdges.filter((entry) => entry.artifact === required.artifact);
    if (actual.length !== 1 || !sameContract(actual[0], required)) {
      blocking.push({ code: 'pipeline-artifact-contract-mismatch', artifact: required.artifact });
    }
    if (required.producers.length === 0 || required.producers.some((id) => !endpoints.has(id))) {
      blocking.push({ code: 'pipeline-artifact-producer-unreachable', artifact: required.artifact });
    }
    if (required.consumers.some((id) => !endpoints.has(id))) {
      blocking.push({ code: 'pipeline-artifact-consumer-unreachable', artifact: required.artifact });
    }
  }
  if (!sameContract(projection.dispatch_bounds, expected.dispatch_bounds)) blocking.push({ code: 'pipeline-forecast-mismatch' });
  return { blocking, runtime_stages: expected.runtime_stages, artifact_edges: expected.artifact_edges };
}

/** Pure, non-authoritative compilation; every external fact comes from admission. */
export function compileRunAdmissionContract({ input, config, classification, projection, planning_commands = [] }) {
  const contract = pipelineContract(input, config, classification, projection);
  /** @type {Array<Record<string, unknown>>} */
  const blocking = [...contract.blocking];
  const stages = projection?.stages ?? [];
  const roles = distinct(stages.map((stage) => stage.role));
  for (const role of roles) {
    const roleStages = stages.filter((stage) => stage.role === role);
    if (!Object.hasOwn(ROLE_POLICIES, role)) {
      blocking.push({ code: 'reachable-role-unknown', role });
      continue;
    }
    for (const tier of distinct(roleStages.map((stage) => stage.model_tier))) {
      try {
        resolveModel(config, input.host, tier, role);
      } catch {
        blocking.push({ code: 'reachable-role-model-invalid', role, model_tier: tier });
      }
    }
  }
  const applicable = roles.includes('planner') && [1, 2].includes(input.plan_contract_version);
  const compiled = applicable
    ? plannerTemplate({ input, config, classification, planning_commands })
    : { blocking: [], planner: { applicable: false } };
  blocking.push(...compiled.blocking);
  return {
    version: 1,
    valid: blocking.length === 0,
    blocking,
    limits: pipelineLimits({ policy: config.policy }),
    reachable_roles: roles,
    dispatch_bounds: structuredClone(projection.dispatch_bounds),
    planner: compiled.planner,
    runtime_stages: contract.runtime_stages,
    artifact_edges: contract.artifact_edges,
  };
}
