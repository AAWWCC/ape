import path from 'node:path';
import { z } from 'zod';
import {
  RECEIPT_MAX_SUBMISSIONS_PER_WORKER,
  RECEIPT_STATUSES,
  RISK_TRIGGERS,
  ROLE_POLICIES,
} from './constants.js';
import { normalizeClaimPath, withinClaims } from './path-scope.js';
import {
  PLAN_CONTRACT_MAX_BYTES,
  PREFLIGHT_ARTIFACT_MAX_BYTES,
  PlanDeviationSchema,
  PreflightArtifactSchema,
  candidatePlanForScope,
  planContractSchemaForVersion,
  validatePreflightArtifact,
} from './plan-contract.js';
import {
  REVIEW_CONTRACT_VERSION,
  ReceiptEvidenceSchema,
  StructuredReviewFindingSchema,
  validateStructuredReviewReceipt,
} from './schemas.js';
import { RECEIPT_FAILURE_KINDS } from './orchestration-telemetry.js';

export const RECEIPT_DRAFT_TEST_LIMIT = 256;
export const RECEIPT_DRAFT_FINDING_LIMIT = 64;

const receiptCapability = z.string().regex(/^[A-Za-z0-9_-]{32,256}$/);
const boundedClaim = z.string().min(1).max(512);

export const ReceiptDraftTestSchema = z.object({
  command: z.string().min(1).max(8_192),
  passed: z.boolean(),
  exit_code: z.number().int(),
  duration_ms: z.number().nonnegative(),
  output_hash: z.string().regex(/^[0-9a-f]{64}$/i).optional(),
}).strict();

export const ReceiptDraftRequiredClaimsSchema = z.object({
  claimed_paths: z.array(boundedClaim).max(64).optional(),
  test_paths: z.array(boundedClaim).max(64).optional(),
  required_role: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/).optional(),
}).strict().superRefine((claims, context) => {
  if (
    (claims.claimed_paths?.length ?? 0) === 0 &&
    (claims.test_paths?.length ?? 0) === 0 &&
    claims.required_role === undefined
  ) {
    context.addIssue({
      code: 'custom',
      message: 'must contain at least one additive claim or required_role',
    });
  }
});

function canonicalRecoveryClaimPath(value) {
  if (
    typeof value !== 'string' || value.length === 0 || value.length > 512 ||
    /[\0-\x1f\x7f]/.test(value) || value.includes('\\') ||
    path.posix.isAbsolute(value) || /^[A-Za-z]:\//.test(value) ||
    value === '.' || value.endsWith('/') || value === '..' || value.startsWith('../') ||
    value === '.ape' || value.startsWith('.ape/') || path.posix.normalize(value) !== value
  ) return null;
  return value;
}

function additivePathSchema(existing, field) {
  return boundedClaim.superRefine((value, context) => {
    const canonical = canonicalRecoveryClaimPath(value);
    if (canonical === null) {
      context.addIssue({
        code: 'custom',
        message: `${field} must be a canonical contained project-relative path`,
      });
      return;
    }
    if (withinClaims(normalizeClaimPath(canonical), existing)) {
      context.addIssue({
        code: 'custom',
        message: `${field} is already on the immutable ticket and is not additive`,
      });
    }
  });
}

function uniqueAdditions(values, context, field) {
  const seen = new Set();
  for (const [index, value] of (values ?? []).entries()) {
    const identity = normalizeClaimPath(value);
    if (seen.has(identity)) {
      context.addIssue({
        code: 'custom',
        path: [field, index],
        message: 'is a duplicate addition',
      });
    }
    seen.add(identity);
  }
}

function requiredClaimsSchemaForTicket(ticket) {
  const roles = Object.keys(ROLE_POLICIES).filter((role) => role !== ticket?.role);
  return z.object({
    claimed_paths: z.array(additivePathSchema(ticket?.claimed_paths ?? [], 'claimed path'))
      .max(64).optional(),
    test_paths: z.array(additivePathSchema(ticket?.test_paths ?? [], 'test path'))
      .max(64).optional(),
    required_role: z.enum(roles).optional(),
  }).strict().superRefine((claims, context) => {
    uniqueAdditions(claims.claimed_paths, context, 'claimed_paths');
    uniqueAdditions(claims.test_paths, context, 'test_paths');
    if (
      (claims.claimed_paths?.length ?? 0) === 0 &&
      (claims.test_paths?.length ?? 0) === 0 &&
      claims.required_role === undefined
    ) {
      context.addIssue({
        code: 'custom',
        message: 'must contain at least one genuinely additive claim or required_role',
      });
    }
  });
}

const MissingAssuranceSchema = z.union([
  z.string().min(1).max(500),
  z.object({
    summary: z.string().min(1).max(500).optional(),
    assurance: z.string().min(1).max(500).optional(),
    reason: z.string().min(1).max(500).optional(),
    detail: z.string().min(1).max(500).optional(),
    title: z.string().min(1).max(500).optional(),
    evidence_anchor: z.string().min(1).max(600).optional(),
    risk_trigger: z.enum(RISK_TRIGGERS).optional(),
  }).catchall(z.unknown()).superRefine((entry, context) => {
    if (![entry.summary, entry.assurance, entry.reason, entry.detail, entry.title]
      .some((value) => typeof value === 'string' && value.trim() !== '')) {
      context.addIssue({ code: 'custom', message: 'requires non-empty summary text' });
    }
  }),
]);

function testContradictionSchemaForTicket(ticket) {
  // A contradiction can only concern an authored test named by this exact
  // immutable ticket. Publishing that set as an enum keeps the worker-facing
  // schema as strict as the canonical recovery validator instead of waiting
  // until record time to discover an invented or stale path.
  const authorizedTestPath = z.enum([
    ...new Set((ticket?.test_paths ?? []).filter((entry) => typeof entry === 'string')),
  ]);
  return z.object({
    test_paths: z.array(authorizedTestPath).max(64).optional(),
    summary: z.string().min(1).max(2_000).optional(),
    incompatible_expectations: z.string().min(1).max(2_000).optional(),
  }).catchall(z.unknown());
}

const ScopeExpansionSchema = z.object({
  claimed_paths: z.array(boundedClaim).min(1).max(64),
  reason: z.string().min(1).max(4_000),
}).strict();

const NewContractStructuredReviewFindingSchema = StructuredReviewFindingSchema.safeExtend({
  id: z.string().regex(/^[A-Za-z][A-Za-z0-9._:-]{0,127}$/),
});

function planningTicket(ticket) {
  return ['plan', 'plan-replan'].includes(ticket?.stage_id) || ticket?.role === 'planner';
}

function reviewTicket(ticket) {
  return [
    'reviewer',
    'security_reviewer',
    'plan_checker',
    'plan_critic',
    'plan_judge',
  ].includes(ticket?.role);
}

function exactReviewVerdicts(ticket) {
  return ['plan_checker', 'plan_critic', 'plan_judge'].includes(ticket?.role)
    ? ['agree', 'disagree']
    : ['pass', 'fail'];
}

function planValidationContext(ticket) {
  const manifest = ticket?.capability_manifest ?? {};
  const immutableReceiptContract = ticket?.receipt_contract_version === 1;
  return {
    preflight_hash: manifest.preflight_hash ?? ticket?.preflight?.artifact_hash ?? null,
    verification_profiles: (manifest.verification_profiles ?? []).map((profile) => ({
      id: profile.id,
      required: profile.required === true || profile.disposition === 'required',
    })),
    require_design_assurance: manifest.design_assurance_required === true,
    risk_triggers: manifest.risk_triggers ?? ticket?.risk_triggers ?? [],
    plannable_evidence_commands: immutableReceiptContract &&
      Array.isArray(manifest.plannable_evidence_commands)
      ? manifest.plannable_evidence_commands
      : null,
    allowed_evidence_commands: immutableReceiptContract &&
      Array.isArray(manifest.allowed_evidence_commands)
      ? manifest.allowed_evidence_commands
      : null,
  };
}

const NON_PRODUCT_FAILURE_KINDS = RECEIPT_FAILURE_KINDS.filter(
  (kind) => kind !== 'test-contradiction',
);

function evidenceSchemaForTicket(ticket) {
  const shape = {
    failure_kind: z.enum(RECEIPT_FAILURE_KINDS).optional(),
    required_claims: requiredClaimsSchemaForTicket(ticket).optional(),
    missing_assurances: z.array(MissingAssuranceSchema).min(1).max(16).optional(),
    test_contradiction: testContradictionSchemaForTicket(ticket).optional(),
    scope_expansion: ScopeExpansionSchema.optional(),
    plan_deviation: PlanDeviationSchema.optional(),
  };
  if (planningTicket(ticket)) {
    shape.candidate_plan = planContractSchemaForVersion(ticket?.plan_contract_version).optional();
  }
  if (ticket?.role === 'preflight_analyst') {
    shape.preflight_artifact = PreflightArtifactSchema.optional();
  }
  if (reviewTicket(ticket)) {
    shape.verdict = z.enum(exactReviewVerdicts(ticket)).optional();
  }
  return ReceiptEvidenceSchema.safeExtend(shape);
}

function testSchemaForTicket(ticket) {
  const allowed = ticket?.receipt_contract_version === 1 &&
    Array.isArray(ticket?.capability_manifest?.allowed_evidence_commands)
    ? ticket.capability_manifest.allowed_evidence_commands
    : null;
  if (allowed === null) return ReceiptDraftTestSchema;
  const command = allowed.length > 0
    ? z.enum(allowed)
    : z.string().min(1).refine(() => false, {
        message: 'is not an allowed evidence command for this immutable ticket',
      });
  return ReceiptDraftTestSchema.safeExtend({ command });
}

/**
 * Authoritative raw worker-input schema for receipt-contract-v1 tickets.
 * Persisted StageReceiptSchema is intentionally a different, runtime-sealed
 * record. Legacy tickets continue to publish RECEIPT_INPUT_SCHEMA unchanged.
 */
export function receiptDraftSchemaForTicket(ticket) {
  const evidence = evidenceSchemaForTicket(ticket);
  const findings = ticket?.review_contract_version === REVIEW_CONTRACT_VERSION
    ? z.array(NewContractStructuredReviewFindingSchema).max(RECEIPT_DRAFT_FINDING_LIMIT)
    : z.array(z.record(z.string(), z.unknown())).max(RECEIPT_DRAFT_FINDING_LIMIT);
  return z.object({
    ticket_id: z.string().min(1).max(2_048),
    status: z.enum(RECEIPT_STATUSES),
    tests: z.array(testSchemaForTicket(ticket)).max(RECEIPT_DRAFT_TEST_LIMIT),
    findings,
    evidence,
    timing: z.object({
      started_at: z.string().min(1).optional(),
      completed_at: z.string().min(1).optional(),
      duration_ms: z.number().nonnegative().optional(),
    }).strict().optional(),
    agent_identity: z.string().min(1).max(512).optional(),
    receipt_capability: receiptCapability,
  }).strict().superRefine((draft, context) => {
    if (draft.ticket_id !== ticket?.ticket_id) {
      context.addIssue({
        code: 'custom',
        path: ['ticket_id'],
        message: `must equal immutable ticket_id ${ticket?.ticket_id ?? ''}`,
      });
    }
    if (draft.status === 'passed' && planningTicket(ticket) && draft.evidence.candidate_plan === undefined) {
      context.addIssue({ code: 'custom', path: ['evidence', 'candidate_plan'], message: 'is required on a passed planner receipt' });
    }
    if (draft.status === 'passed' && ticket?.role === 'preflight_analyst' && draft.evidence.preflight_artifact === undefined) {
      context.addIssue({ code: 'custom', path: ['evidence', 'preflight_artifact'], message: 'is required on a passed preflight receipt' });
    }
    if (draft.status === 'passed' && reviewTicket(ticket) && draft.evidence.verdict === undefined) {
      context.addIssue({ code: 'custom', path: ['evidence', 'verdict'], message: 'is required on a passed review receipt' });
    }
    if (draft.evidence.candidate_plan !== undefined) {
      if (!planningTicket(ticket)) {
        context.addIssue({ code: 'custom', path: ['evidence', 'candidate_plan'], message: 'is accepted only on a planner ticket' });
      } else {
        const result = candidatePlanForScope(
          draft.evidence.candidate_plan,
          [...(ticket?.claimed_paths ?? []), ...(ticket?.test_paths ?? [])],
          null,
          planValidationContext(ticket),
        );
        for (const error of result.errors ?? []) {
          context.addIssue({ code: 'custom', path: ['evidence', 'candidate_plan'], message: error });
        }
      }
    }
    if (draft.evidence.preflight_artifact !== undefined) {
      if (ticket?.role !== 'preflight_analyst') {
        context.addIssue({ code: 'custom', path: ['evidence', 'preflight_artifact'], message: 'is accepted only on a preflight analyst ticket' });
      } else {
        const result = validatePreflightArtifact(draft.evidence.preflight_artifact, {
          objective: ticket?.objective,
          claims: ticket?.claimed_paths ?? [],
          test_paths: ticket?.test_paths ?? [],
          profiles: ticket?.capability_manifest?.verification_profiles ?? ticket?.verification_profiles ?? [],
          tests: draft.tests,
        });
        for (const error of result.errors ?? []) {
          context.addIssue({ code: 'custom', path: ['evidence', 'preflight_artifact'], message: error });
        }
      }
    }
    if (
      draft.evidence.missing_assurances !== undefined &&
      !['plan_checker', 'plan_critic', 'plan_judge'].includes(ticket?.role)
    ) {
      context.addIssue({ code: 'custom', path: ['evidence', 'missing_assurances'], message: 'is accepted only on a plan review or plan judge ticket' });
    }
    if (
      draft.evidence.test_contradiction !== undefined &&
      (
        ticket?.role !== 'implementer' ||
        draft.status !== 'failed' ||
        draft.evidence.failure_kind !== 'test-contradiction'
      )
    ) {
      context.addIssue({
        code: 'custom',
        path: ['evidence', 'test_contradiction'],
        message: 'is accepted only on a failed implementer receipt with failure_kind test-contradiction',
      });
    }
    if (
      draft.evidence.scope_expansion !== undefined &&
      !['reviewer', 'security_reviewer'].includes(ticket?.role)
    ) {
      context.addIssue({ code: 'custom', path: ['evidence', 'scope_expansion'], message: 'is accepted only on a reviewer or security reviewer ticket' });
    }
    if (
      draft.evidence.scope_expansion !== undefined &&
      ['reviewer', 'security_reviewer'].includes(ticket?.role) &&
      (
        draft.status !== 'passed' ||
        draft.evidence.verdict !== 'fail' ||
        !draft.findings.some((finding) => finding?.blocking === true)
      )
    ) {
      context.addIssue({
        code: 'custom',
        path: ['evidence', 'scope_expansion'],
        message: 'requires a completed negative review with verdict fail and a blocking finding',
      });
    }
    if (ticket?.review_contract_version === REVIEW_CONTRACT_VERSION) {
      for (const error of validateStructuredReviewReceipt(ticket, draft)) {
        context.addIssue({ code: 'custom', path: ['findings'], message: error });
      }
    }
    if (
      draft.status === 'passed' &&
      ticket?.required_checks?.includes('targeted-tests') &&
      !draft.tests.some((test) => test.passed === true && test.exit_code === 0)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['tests'],
        message: 'requires at least one passing targeted test with exit_code 0',
      });
    }
    const capabilityFailure = draft.status === 'failed' && draft.evidence.failure_kind === 'capability';
    if (draft.status === 'passed' && draft.evidence.failure_kind !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['evidence', 'failure_kind'],
        message: 'must be omitted on a passed receipt',
      });
    }
    if (
      draft.status === 'failed' && reviewTicket(ticket) &&
      !NON_PRODUCT_FAILURE_KINDS.includes(draft.evidence.failure_kind)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['evidence', 'failure_kind'],
        message: 'a failed review receipt requires an explicit non-product failure kind',
      });
    }
    if (capabilityFailure && draft.evidence.required_claims === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['evidence', 'required_claims'],
        message: 'is required on a failed capability receipt',
      });
    }
    if (!capabilityFailure && draft.evidence.required_claims !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['evidence', 'required_claims'],
        message: 'is accepted only on a failed capability receipt',
      });
    }
  });
}

function withoutDialect(value) {
  const schema = structuredClone(value);
  delete schema.$schema;
  return schema;
}

function passedEvidenceRequirement(field) {
  return {
    if: { properties: { status: { const: 'passed' } }, required: ['status'] },
    then: { properties: { evidence: { required: [field] } } },
  };
}

function forbiddenEvidenceField(field) {
  return { properties: { evidence: { not: { required: [field] } } } };
}

function requiredTargetedPassingTest() {
  return {
    if: { properties: { status: { const: 'passed' } }, required: ['status'] },
    then: {
      properties: {
        tests: {
          contains: {
            type: 'object',
            properties: {
              passed: { const: true },
              exit_code: { const: 0 },
            },
            required: ['passed', 'exit_code'],
          },
        },
      },
    },
  };
}

function reviewFindingVerdictConstraints(ticket) {
  if (
    ticket?.review_contract_version !== REVIEW_CONTRACT_VERSION ||
    !reviewTicket(ticket)
  ) return [];
  const [positive, negative] = ['plan_checker', 'plan_critic', 'plan_judge'].includes(ticket?.role)
    ? [['agree'], ['disagree']]
    : [['pass'], ['fail']];
  const verdictCondition = (values) => ({
    properties: {
      status: { const: 'passed' },
      evidence: {
        properties: { verdict: { enum: values } },
        required: ['verdict'],
      },
    },
    required: ['status', 'evidence'],
  });
  const blockingFinding = {
    type: 'object',
    properties: { blocking: { const: true } },
    required: ['blocking'],
  };
  return [
    {
      if: verdictCondition(negative),
      then: { properties: { findings: { minItems: 1, contains: blockingFinding } } },
    },
    {
      if: verdictCondition(positive),
      then: { properties: { findings: { not: { contains: blockingFinding } } } },
    },
  ];
}

function exactStringMembership(values) {
  return values.length > 0 ? { enum: [...values] } : { not: {} };
}

function regexEscape(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function specializeAdditivePathItems(items, existing) {
  if (!items) return;
  const normalized = [...new Set(existing
    .filter((entry) => typeof entry === 'string')
    .map(normalizeClaimPath)
    .filter((entry) => entry !== '' && entry !== '.'))];
  items.allOf = [
    { not: { pattern: '[\\\\\\u0000-\\u001f\\u007f]' } },
    { not: { pattern: '^(?:/|[A-Za-z]:/|\\.ape(?:/|$)|\\.\\.?$|\\.\\.?/)' } },
    { not: { pattern: '(?:^|/)\\.\\.(?:/|$)|//|/$' } },
    ...normalized.map((claim) => ({
      not: { pattern: `^${regexEscape(claim)}(?:/|$)` },
    })),
  ];
  items['x-ape-canonical-project-relative'] = true;
  items['x-ape-additive-against-ticket-claims'] = true;
}

function specializeRequiredClaimsSchema(requiredClaims, ticket) {
  if (!requiredClaims) return;
  const properties = requiredClaims.properties ?? {};
  for (const [field, existing] of [
    ['claimed_paths', ticket?.claimed_paths ?? []],
    ['test_paths', ticket?.test_paths ?? []],
  ]) {
    const array = properties[field];
    if (!array) continue;
    array.uniqueItems = true;
    specializeAdditivePathItems(array.items, existing);
  }
  if (properties.required_role) {
    Object.assign(properties.required_role, exactStringMembership(
      Object.keys(ROLE_POLICIES).filter((role) => role !== ticket?.role),
    ));
  }
  requiredClaims.anyOf = [
    { properties: { claimed_paths: { minItems: 1 } }, required: ['claimed_paths'] },
    { properties: { test_paths: { minItems: 1 } }, required: ['test_paths'] },
    { required: ['required_role'] },
  ];
  requiredClaims['x-ape-ticket-specialized-additive-claims'] = true;
}

function specializeCandidatePlanSchema(candidate, ticket) {
  const workstream = candidate?.properties?.workstreams?.items;
  if (!workstream) return;
  const manifest = ticket?.capability_manifest;
  const commands = manifest?.plannable_evidence_commands ?? manifest?.allowed_evidence_commands;
  const profiles = ticket?.capability_manifest?.verification_profiles;
  if (Array.isArray(commands)) {
    workstream.properties.evidence_commands.items = exactStringMembership(commands);
  }
  if (
    ticket?.plan_contract_version === 2 &&
    Array.isArray(profiles) &&
    workstream.properties?.verification_profiles?.items
  ) {
    workstream.properties.verification_profiles.items = exactStringMembership(
      profiles.map((profile) => profile?.id).filter((id) => typeof id === 'string'),
    );
  }
}

function specializePreflightSchema(preflight, ticket) {
  if (!preflight) return;
  if (typeof ticket?.objective === 'string') {
    preflight.properties.objective = { const: ticket.objective };
  }
  const commands = ticket?.capability_manifest?.allowed_evidence_commands;
  const command = preflight.properties?.baseline?.items?.properties?.command;
  if (command && Array.isArray(commands)) {
    Object.assign(command, exactStringMembership(commands));
  }
  const profiles = ticket?.capability_manifest?.verification_profiles;
  const profileId = preflight.properties?.verification_profiles?.items?.properties?.id;
  if (profileId && Array.isArray(profiles)) {
    Object.assign(profileId, exactStringMembership(
      profiles.map((profile) => profile?.id).filter((id) => typeof id === 'string'),
    ));
  }
}

function filterRecoveryEvidenceSchema(schema, ticket) {
  const properties = schema.properties?.evidence?.properties;
  if (!properties) return;
  const allowed = new Set(['required_claims']);
  if (['plan_checker', 'plan_critic', 'plan_judge'].includes(ticket?.role)) {
    allowed.add('missing_assurances');
  }
  if (ticket?.role === 'implementer') allowed.add('test_contradiction');
  if (['reviewer', 'security_reviewer'].includes(ticket?.role)) allowed.add('scope_expansion');
  for (const field of ['missing_assurances', 'test_contradiction', 'scope_expansion']) {
    if (allowed.has(field)) continue;
    delete properties[field];
    schema.allOf.push(forbiddenEvidenceField(field));
  }
}

function capabilityClaimsRequirement() {
  return {
    if: {
      properties: {
        status: { const: 'failed' },
        evidence: {
          properties: { failure_kind: { const: 'capability' } },
          required: ['failure_kind'],
        },
      },
      required: ['status', 'evidence'],
    },
    then: { properties: { evidence: { required: ['required_claims'] } } },
    else: { properties: { evidence: { not: { required: ['required_claims'] } } } },
  };
}

function passedFailureKindProhibition() {
  return {
    if: { properties: { status: { const: 'passed' } }, required: ['status'] },
    then: { properties: { evidence: { not: { required: ['failure_kind'] } } } },
  };
}

function failedReviewFailureKindRequirement() {
  return {
    if: { properties: { status: { const: 'failed' } }, required: ['status'] },
    then: {
      properties: {
        evidence: {
          required: ['failure_kind'],
          properties: { failure_kind: { enum: [...NON_PRODUCT_FAILURE_KINDS] } },
        },
      },
    },
  };
}

function testContradictionRequirement() {
  return {
    if: {
      properties: {
        evidence: { required: ['test_contradiction'] },
      },
      required: ['evidence'],
    },
    then: {
      properties: {
        status: { const: 'failed' },
        evidence: {
          properties: { failure_kind: { const: 'test-contradiction' } },
          required: ['failure_kind'],
        },
      },
      required: ['status', 'evidence'],
    },
  };
}

function scopeExpansionRequirement() {
  const blockingFinding = {
    type: 'object',
    properties: { blocking: { const: true } },
    required: ['blocking'],
  };
  return {
    if: {
      properties: {
        evidence: { required: ['scope_expansion'] },
      },
      required: ['evidence'],
    },
    then: {
      properties: {
        status: { const: 'passed' },
        evidence: {
          properties: { verdict: { const: 'fail' } },
          required: ['verdict'],
        },
        findings: { minItems: 1, contains: blockingFinding },
      },
      required: ['status', 'evidence', 'findings'],
    },
  };
}

/** Generate the worker-facing schema from the exact runtime draft Zod. */
export function receiptDraftJsonSchemaForTicket(ticket) {
  const schema = withoutDialect(z.toJSONSchema(receiptDraftSchemaForTicket(ticket), {
    target: 'draft-07',
  }));
  schema.properties.ticket_id.const = ticket.ticket_id;
  schema.allOf = [capabilityClaimsRequirement(), passedFailureKindProhibition()];
  if (reviewTicket(ticket)) schema.allOf.push(failedReviewFailureKindRequirement());
  if (planningTicket(ticket)) {
    schema.allOf.push(passedEvidenceRequirement('candidate_plan'));
    const candidate = schema.properties?.evidence?.properties?.candidate_plan;
    if (candidate) {
      const commandField = Array.isArray(ticket?.capability_manifest?.plannable_evidence_commands)
        ? 'plannable_evidence_commands'
        : 'allowed_evidence_commands';
      candidate.description = `Complete candidate plan. Canonical JSON is limited to ${PLAN_CONTRACT_MAX_BYTES} UTF-8 bytes; commands must be exact members of ticket.capability_manifest.${commandField}, and profile IDs must be exact members of ticket.capability_manifest.verification_profiles.`;
      candidate['x-ape-utf8-maxBytes'] = PLAN_CONTRACT_MAX_BYTES;
      candidate['x-ape-command-enum-ref'] = `ticket.capability_manifest.${commandField}`;
      specializeCandidatePlanSchema(candidate, ticket);
    }
  } else schema.allOf.push(forbiddenEvidenceField('candidate_plan'));
  if (ticket?.role === 'preflight_analyst') {
    schema.allOf.push(passedEvidenceRequirement('preflight_artifact'));
    const preflight = schema.properties?.evidence?.properties?.preflight_artifact;
    if (preflight) {
      preflight.description = `Complete preflight artifact. Canonical JSON is limited to ${PREFLIGHT_ARTIFACT_MAX_BYTES} UTF-8 bytes and baseline commands must be backed by receipt tests.`;
      preflight['x-ape-utf8-maxBytes'] = PREFLIGHT_ARTIFACT_MAX_BYTES;
      specializePreflightSchema(preflight, ticket);
    }
  } else schema.allOf.push(forbiddenEvidenceField('preflight_artifact'));
  if (reviewTicket(ticket)) schema.allOf.push(passedEvidenceRequirement('verdict'));
  schema.allOf.push(...reviewFindingVerdictConstraints(ticket));
  if (ticket?.required_checks?.includes('targeted-tests')) {
    schema.allOf.push(requiredTargetedPassingTest());
  }
  filterRecoveryEvidenceSchema(schema, ticket);
  specializeRequiredClaimsSchema(
    schema.properties?.evidence?.properties?.required_claims,
    ticket,
  );
  if (ticket?.role === 'implementer') {
    schema.allOf.push(testContradictionRequirement());
    const testPaths = schema.properties?.evidence?.properties
      ?.test_contradiction?.properties?.test_paths?.items;
    if (testPaths) {
      Object.assign(testPaths, exactStringMembership([
        ...new Set((ticket?.test_paths ?? []).filter((entry) => typeof entry === 'string')),
      ]));
      testPaths.description = 'Exact authored test path from ticket.test_paths.';
      testPaths['x-ape-enum-ref'] = 'ticket.test_paths';
    }
  }
  if (['reviewer', 'security_reviewer'].includes(ticket?.role)) {
    schema.allOf.push(scopeExpansionRequirement());
  }
  if (schema.allOf.length === 0) delete schema.allOf;

  const allowed = ticket?.receipt_contract_version === 1 &&
    Array.isArray(ticket?.capability_manifest?.allowed_evidence_commands)
    ? ticket.capability_manifest.allowed_evidence_commands
    : null;
  const command = schema.properties?.tests?.items?.properties?.command;
  if (command && allowed !== null) Object.assign(command, exactStringMembership(allowed));
  schema['x-ape-receipt-contract'] = {
    version: 1,
    validation_tool: 'ape_validate_receipt',
    validation_attempts: RECEIPT_MAX_SUBMISSIONS_PER_WORKER,
    candidate_plan_utf8_max_bytes: PLAN_CONTRACT_MAX_BYTES,
    capability_manifest_ref: 'ticket.capability_manifest',
    exact_draft_attestation_required: true,
  };
  return schema;
}
