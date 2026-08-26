import { z } from 'zod';
import { LANES, MAX_STAGE_ATTEMPTS, MODEL_TIERS, RECEIPT_STATUSES, RISK_TRIGGERS, RUN_MODES, SCHEMA_VERSION } from './constants.js';
import { canonicalJson, hashRecord } from './canonical.js';
import { parseToolClaim } from './external-tools.js';
import { ApprovedPlanSchema, CandidatePlanSchema, PLAN_CONTRACT_VERSION } from './plan-contract.js';
import { markExactTestScope } from './path-scope.js';
import { RECEIPT_INPUT_SCHEMA } from './receipt-input.js';

// Modes an operator may request at start. `land` — gate-and-land a finished,
// already-green working-tree diff (friction #32) — is requestable-only: it
// lives here rather than in RUN_MODES so nothing that classifies or infers a
// pipeline can ever produce it; a host must ask for it explicitly.
export const START_MODES = Object.freeze([...RUN_MODES, 'land']);

const nonEmpty = z.string().min(1);
const sha = z.string().regex(/^[0-9a-f]{40}$/i);
const digest = z.string().regex(/^[0-9a-f]{64}$/i);
const toolClaim = nonEmpty.refine((value) => parseToolClaim(value) !== null, {
  message: 'tool claim must be provider:resource:read|write|execute',
});

// Durable MCP task records are deliberately narrower than general APE state.
// IDs are fixed-width, high-entropy base64url tokens so they are safe as path
// components and cannot be confused with a caller-supplied path.  The JSON
// bounds are applied to the serialized representation because that is the
// resource the local journal ultimately has to retain and replay.
export const TASK_STATUSES = Object.freeze([
  'working',
  'input_required',
  'completed',
  'failed',
  'cancelled',
]);
export const TASK_TERMINAL_STATUSES = Object.freeze(['completed', 'failed', 'cancelled']);
export const TASK_ACTIONS = Object.freeze(['record', 'next', 'regate', 'ship']);

export const TaskIdSchema = z.string().regex(/^task-[A-Za-z0-9_-]{43}$/);
export const TaskOperationIdSchema = z.string().regex(/^op-[A-Za-z0-9_-]{43}$/);

const isoTimestamp = z.string().datetime({ offset: true });
const boundedText = (max) => z.string().min(1).max(max);
const boundedJson = (maxBytes, label) => z.json().superRefine((value, context) => {
  const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
  if (bytes > maxBytes) {
    context.addIssue({
      code: 'custom',
      message: `${label} exceeds ${maxBytes} serialized UTF-8 bytes`,
    });
  }
});

export const REVIEW_CONTRACT_VERSION = 1;
const REVIEW_FINDING_LIMIT = 64;
const REVIEW_FILE_MAX = 512;
const REVIEW_TITLE_MAX = 200;
const REVIEW_DETAIL_MAX = 4_000;
const REVIEW_TEST_PATH_LIMIT = 64;

function hasUnpairedSurrogate(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        index += 1;
        continue;
      }
      return true;
    }
    if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

function structuredReviewString(maxLength) {
  return z.string().min(1).max(maxLength).superRefine((value, context) => {
    if (STRUCTURED_REVIEW_CONTROL_CHARS.test(value) || hasUnpairedSurrogate(value)) {
      context.addIssue({
        code: 'custom',
        message: 'must not contain a control, DEL/C1, bidi/format, or unpaired surrogate character',
      });
    }
  });
}

const ReviewRemediationSchema = z.object({
  owner: z.enum(['production', 'test', 'both']),
  test_paths: z.array(structuredReviewString(REVIEW_FILE_MAX))
    .min(1).max(REVIEW_TEST_PATH_LIMIT).optional(),
}).strict();

const StructuredReviewFindingSchema = z.object({
  file: structuredReviewString(REVIEW_FILE_MAX),
  line: z.number().int().positive().max(10_000_000),
  title: structuredReviewString(REVIEW_TITLE_MAX),
  detail: structuredReviewString(REVIEW_DETAIL_MAX),
  blocking: z.boolean(),
  remediation: ReviewRemediationSchema.optional(),
}).strict().superRefine((finding, context) => {
  if (finding.blocking && !finding.remediation) {
    context.addIssue({
      code: 'custom',
      path: ['remediation'],
      message: 'blocking findings require remediation ownership',
    });
    return;
  }
  if (!finding.blocking && finding.remediation) {
    context.addIssue({
      code: 'custom',
      path: ['remediation'],
      message: 'advisory findings must omit remediation',
    });
    return;
  }
  const remediation = finding.remediation;
  if (!remediation) return;
  if (remediation.owner === 'production' && remediation.test_paths !== undefined) {
    context.addIssue({
      code: 'custom',
      path: ['remediation', 'test_paths'],
      message: 'production-owned findings must omit test_paths',
    });
  }
  if (
    (remediation.owner === 'test' || remediation.owner === 'both')
    && !remediation.test_paths?.length
  ) {
    context.addIssue({
      code: 'custom',
      path: ['remediation', 'test_paths'],
      message: `${remediation.owner}-owned findings require non-empty test_paths`,
    });
  }
});

const structuredFindingOutputSchema = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['file', 'line', 'title', 'detail', 'blocking'],
  properties: {
    file: { type: 'string', minLength: 1, maxLength: REVIEW_FILE_MAX },
    line: { type: 'integer', minimum: 1, maximum: 10_000_000 },
    title: { type: 'string', minLength: 1, maxLength: REVIEW_TITLE_MAX },
    detail: { type: 'string', minLength: 1, maxLength: REVIEW_DETAIL_MAX },
    blocking: { type: 'boolean' },
    remediation: {
      type: 'object',
      additionalProperties: false,
      required: ['owner'],
      properties: {
        owner: { type: 'string', enum: ['production', 'test', 'both'] },
        test_paths: {
          type: 'array',
          minItems: 1,
          maxItems: REVIEW_TEST_PATH_LIMIT,
          uniqueItems: true,
          items: { type: 'string', minLength: 1, maxLength: REVIEW_FILE_MAX },
        },
      },
    },
  },
});

export const STRUCTURED_REVIEW_OUTPUT_SCHEMA = Object.freeze({
  ...RECEIPT_INPUT_SCHEMA,
  properties: Object.freeze({
    ...RECEIPT_INPUT_SCHEMA.properties,
    findings: Object.freeze({
      type: 'array',
      maxItems: REVIEW_FINDING_LIMIT,
      items: structuredFindingOutputSchema,
      description:
        'Versioned review findings. Blocking findings require remediation.owner; test/both owners also require exact authorized test_paths. Advisory findings omit remediation.',
    }),
    evidence: Object.freeze({
      ...RECEIPT_INPUT_SCHEMA.properties.evidence,
      properties: Object.freeze({
        ...RECEIPT_INPUT_SCHEMA.properties.evidence.properties,
        verdict: Object.freeze({
          type: 'string',
          enum: ['agree', 'pass', 'passed', 'disagree', 'fail', 'failed'],
          description:
            'Required when status is passed; completed reviews never infer a verdict from status.',
        }),
      }),
    }),
  }),
});

const POSITIVE_REVIEW_VERDICTS = new Set(['agree', 'pass', 'passed']);
const NEGATIVE_REVIEW_VERDICTS = new Set(['disagree', 'fail', 'failed']);
const REVIEW_VERDICTS = new Set([
  ...POSITIVE_REVIEW_VERDICTS,
  ...NEGATIVE_REVIEW_VERDICTS,
]);

const STRUCTURED_REVIEW_CONTROL_CHARS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const STRUCTURED_REVIEW_RENDER_CHARS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

function renderStructuredReviewPath(value) {
  return String(value)
    .replace(STRUCTURED_REVIEW_RENDER_CHARS, String.fromCharCode(0xfffd))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, REVIEW_FILE_MAX);
}

const STRUCTURED_REVIEW_DIAGNOSTIC_LIMIT = 32;
const STRUCTURED_REVIEW_DIAGNOSTIC_MAX = 480;
const STRUCTURED_REVIEW_DIAGNOSTIC_SERIALIZED_LIMIT = 16_000;

function neutralizeUnpairedSurrogates(value) {
  let neutralized = '';
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        neutralized += value[index] + value[index + 1];
        index += 1;
      } else {
        neutralized += String.fromCharCode(0xfffd);
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      neutralized += String.fromCharCode(0xfffd);
    } else {
      neutralized += value[index];
    }
  }
  return neutralized;
}

function structuredReviewLossDisclosure(omitted) {
  return omitted > 0
    ? `${omitted} diagnostics omitted; diagnostic output shortened/truncated`
    : 'diagnostic output shortened/truncated';
}

function boundStructuredReviewDiagnostics(errors) {
  let shortened = false;
  const rendered = errors.map((error) => {
    const neutralized = neutralizeUnpairedSurrogates(String(error))
      .replace(STRUCTURED_REVIEW_RENDER_CHARS, String.fromCharCode(0xfffd))
      .replace(/::code-comment/gi, '[directive]')
      .replace(/\s+/g, ' ')
      .trim();
    if (neutralized.length <= STRUCTURED_REVIEW_DIAGNOSTIC_MAX) return neutralized;
    shortened = true;
    return `${neutralizeUnpairedSurrogates(
      neutralized.slice(0, STRUCTURED_REVIEW_DIAGNOSTIC_MAX - 1),
    )}…`;
  });
  const requiresDisclosure = shortened
    || rendered.length > STRUCTURED_REVIEW_DIAGNOSTIC_LIMIT
    || JSON.stringify(rendered).length > STRUCTURED_REVIEW_DIAGNOSTIC_SERIALIZED_LIMIT;
  if (!requiresDisclosure) return rendered;

  const retained = [];
  const retainedLimit = STRUCTURED_REVIEW_DIAGNOSTIC_LIMIT - 1;
  for (const diagnostic of rendered) {
    if (retained.length >= retainedLimit) break;
    const proposed = [...retained, diagnostic];
    const disclosure = structuredReviewLossDisclosure(rendered.length - proposed.length);
    if (
      JSON.stringify([...proposed, disclosure]).length
      > STRUCTURED_REVIEW_DIAGNOSTIC_SERIALIZED_LIMIT
    ) break;
    retained.push(diagnostic);
  }
  retained.push(structuredReviewLossDisclosure(rendered.length - retained.length));
  return retained;
}

function structuredReviewFindingIdentity(finding) {
  const testPaths = finding.remediation?.test_paths;
  return canonicalJson({
    ...finding,
    ...(finding.remediation
      ? {
          remediation: {
            ...finding.remediation,
            ...(testPaths ? { test_paths: [...testPaths].sort() } : {}),
          },
        }
      : {}),
  });
}

export function validateStructuredReviewReceipt(ticket, receipt) {
  if (ticket?.review_contract_version !== REVIEW_CONTRACT_VERSION) return [];
  const parsed = z.array(StructuredReviewFindingSchema)
    .max(REVIEW_FINDING_LIMIT)
    .safeParse(receipt?.findings);
  if (!parsed.success) {
    return boundStructuredReviewDiagnostics(parsed.error.issues.map((issue) =>
      `findings${issue.path.length ? `.${issue.path.join('.')}` : ''}: ${issue.message}`,
    ));
  }
  const errors = [];
  const findingIdentities = new Map();
  for (const [findingIndex, finding] of parsed.data.entries()) {
    const identity = structuredReviewFindingIdentity(finding);
    const firstIndex = findingIdentities.get(identity);
    if (firstIndex !== undefined) {
      errors.push(`findings.${findingIndex} duplicates findings.${firstIndex}`);
    } else {
      findingIdentities.set(identity, findingIndex);
    }
  }
  const blocking = parsed.data.filter((finding) => finding.blocking);
  const reviewCompleted = String(receipt?.status).toLowerCase() === 'passed';
  const verdict = typeof receipt?.evidence?.verdict === 'string'
    ? receipt.evidence.verdict.toLowerCase()
    : null;
  if (reviewCompleted && !REVIEW_VERDICTS.has(verdict)) {
    errors.push(
      'a completed versioned review requires an explicit evidence.verdict from the supported allowlist',
    );
  }
  if (reviewCompleted && NEGATIVE_REVIEW_VERDICTS.has(verdict) && blocking.length === 0) {
    errors.push('a failing versioned review verdict requires at least one blocking finding');
  }
  if (reviewCompleted && POSITIVE_REVIEW_VERDICTS.has(verdict) && blocking.length > 0) {
    errors.push('an agreeing versioned review verdict may not include blocking findings');
  }
  if (receipt?.evidence?.test_remediation !== undefined) {
    errors.push(
      'evidence.test_remediation is not valid on a versioned review ticket; use finding.remediation',
    );
  }
  const authorized = new Set(ticket?.test_paths ?? []);
  for (const [findingIndex, finding] of parsed.data.entries()) {
    const testPaths = finding.remediation?.test_paths ?? [];
    if (new Set(testPaths).size !== testPaths.length) {
      errors.push(`findings.${findingIndex}.remediation.test_paths must not contain duplicates`);
    }
    for (const testPath of testPaths) {
      if (STRUCTURED_REVIEW_CONTROL_CHARS.test(testPath)) {
        errors.push(
          `findings.${findingIndex}.remediation.test_paths may not contain a control, DEL/C1, or bidi/format character: ${renderStructuredReviewPath(testPath)}`,
        );
        continue;
      }
      if (!authorized.has(testPath)) {
        errors.push(
          `findings.${findingIndex}.remediation.test_paths contains unauthorized path: ${renderStructuredReviewPath(testPath)}`,
        );
      }
    }
  }
  return boundStructuredReviewDiagnostics(errors);
}

export function structuredRemediationRoute(state, receipts) {
  const findings = [];
  for (const receipt of receipts) {
    const ticket = (state?.tickets ?? []).find((entry) => entry.ticket_id === receipt.ticket_id);
    if (ticket?.review_contract_version !== REVIEW_CONTRACT_VERSION) return null;
    for (const finding of receipt.findings ?? []) {
      if (finding?.blocking === true && finding.remediation) findings.push(finding);
    }
  }
  if (findings.length === 0) return null;
  const ownershipCounts = { production: 0, test: 0, both: 0 };
  const testPaths = new Set();
  for (const finding of findings) {
    const owner = finding.remediation.owner;
    ownershipCounts[owner] += 1;
    for (const testPath of finding.remediation.test_paths ?? []) testPaths.add(testPath);
  }
  const route = ownershipCounts.both > 0
    || (ownershipCounts.production > 0 && ownershipCounts.test > 0)
    ? 'test-production'
    : ownershipCounts.test > 0
      ? 'test'
      : 'production';
  return {
    route,
    cycle: (state?.remediation_cycles ?? 0) + 1,
    ownership_counts: ownershipCounts,
    test_paths: [...testPaths].sort(),
  };
}

export const TaskOwnerSchema = z.object({
  processId: z.number().int().positive(),
  processStartedAt: isoTimestamp,
  instanceId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
}).strict();

export const TaskCancellationRequestSchema = z.object({
  requester: TaskOwnerSchema,
  reason: boundedText(2_048).optional(),
}).strict();

export const TaskCancellationSchema = z.object({
  requestedAt: isoTimestamp,
  requester: TaskOwnerSchema,
  reason: boundedText(2_048).nullable(),
}).strict();

export const TaskErrorSchema = z.object({
  code: z.number().int(),
  message: boundedText(8_192),
  data: boundedJson(128 * 1_024, 'task error data').optional(),
}).strict();

export const TaskGenerationSchema = z.object({
  schemaVersion: z.literal(1),
  rootBinding: digest,
  taskId: TaskIdSchema,
  operationId: TaskOperationIdSchema,
  action: z.enum(TASK_ACTIONS),
  generation: z.number().int().min(0).max(1_024),
  status: z.enum(TASK_STATUSES),
  statusMessage: z.string().max(2_048).nullable(),
  createdAt: isoTimestamp,
  lastUpdatedAt: isoTimestamp,
  expiresAt: isoTimestamp,
  ttlMs: z.number().int().min(60_000).max(7 * 24 * 60 * 60_000),
  pollIntervalMs: z.number().int().min(100).max(60_000),
  request: boundedJson(128 * 1_024, 'task request'),
  owner: TaskOwnerSchema,
  inputRequests: z.array(boundedJson(64 * 1_024, 'task input request')).max(16),
  result: boundedJson(2 * 1_024 * 1_024, 'task result').nullable(),
  error: TaskErrorSchema.nullable(),
  cancellation: TaskCancellationSchema.nullable(),
  lastAcknowledgedInput: boundedJson(128 * 1_024, 'task update input').nullable(),
  previousHash: digest.nullable(),
  hash: digest,
}).strict();

export const TaskGenerationPatchSchema = z.object({
  expectedGeneration: z.number().int().min(0).max(1_024).optional(),
  allowedStatuses: z.array(z.enum(TASK_STATUSES)).min(1).max(TASK_STATUSES.length).optional(),
  status: z.enum(TASK_STATUSES).optional(),
  statusMessage: z.string().max(2_048).nullable().optional(),
  inputRequests: z.array(boundedJson(64 * 1_024, 'task input request')).max(16).optional(),
  result: boundedJson(2 * 1_024 * 1_024, 'task result').nullable().optional(),
  error: TaskErrorSchema.nullable().optional(),
  lastAcknowledgedInput: boundedJson(128 * 1_024, 'task update input').nullable().optional(),
}).strict();

export const TaskGcRecordSchema = z.object({
  schemaVersion: z.literal(1),
  rootBinding: digest,
  taskId: TaskIdSchema,
  operationId: TaskOperationIdSchema,
  status: z.enum(TASK_STATUSES),
  generations: z.number().int().min(1).max(1_025),
  createdAt: isoTimestamp,
  expiredAt: isoTimestamp,
  collectedAt: isoTimestamp,
  terminalHash: digest,
  hash: digest,
}).strict();

export const TaskOperationTransactionSchema = z.object({
  version: z.literal(1),
  root_binding: digest,
  operation_id: TaskOperationIdSchema,
  action: z.enum(TASK_ACTIONS),
  input_hash: digest,
  expected_run_id: z.string().min(1).max(256).nullable(),
  status: z.enum(['prepared', 'effect-committed']),
  prepared_at: isoTimestamp,
  expires_at: isoTimestamp,
  poll_state: z.enum(['ready', 'polling']).optional(),
  deadline_at: isoTimestamp.optional(),
  poll_started_at: isoTimestamp.optional(),
  last_poll_result: boundedJson(2 * 1_024 * 1_024, 'task operation poll result').optional(),
  last_poll_committed_at: isoTimestamp.optional(),
  result: boundedJson(2 * 1_024 * 1_024, 'task operation result').optional(),
  effect_committed_at: isoTimestamp.optional(),
  record_hash: digest,
}).strict();

export const TaskOperationGcRecordSchema = z.object({
  version: z.literal(1),
  root_binding: digest,
  operation_id: TaskOperationIdSchema,
  action: z.enum(TASK_ACTIONS),
  status: z.enum(['prepared', 'effect-committed']),
  transaction_hash: digest,
  expired_at: isoTimestamp,
  collected_at: isoTimestamp,
  record_hash: digest,
}).strict();

const StageTicketSchema = z.object({
  schema_version: z.literal(SCHEMA_VERSION),
  ticket_id: nonEmpty,
  run_id: nonEmpty,
  stage_id: nonEmpty,
  parallel_group: nonEmpty.nullable().default(null),
  role: nonEmpty,
  objective: nonEmpty,
  claimed_paths: z.array(nonEmpty),
  tool_claims: z.array(toolClaim).optional(),
  test_paths: z.array(nonEmpty).default([]),
  // Structured planning roles must know the exact canonical risks their plan
  // assurances are validated against. Optional with no default preserves the
  // bytes and hashes of legacy and non-planning tickets.
  risk_triggers: z.array(z.enum(RISK_TRIGGERS)).max(RISK_TRIGGERS.length).optional(),
  model_tier: z.enum(MODEL_TIERS),
  model: z.record(z.string(), z.unknown()),
  deadline_at: nonEmpty,
  output_schema: z.record(z.string(), z.unknown()),
  required_checks: z.array(nonEmpty),
  parent_hash: digest.nullable(),
  base_tree_sha: sha,
  attempt: z.number().int().min(1).max(MAX_STAGE_ATTEMPTS),
  writable: z.boolean(),
  issued_at: nonEmpty,
  // Optional, receipt-derived failure evidence the scheduler threads onto a
  // reissued or remediation ticket: prior_attempts (bounded per-attempt failure
  // summaries) and review_findings (the review group's bounded, stage-labeled
  // file:line findings). Optional with NO default so a first-issue ticket omits
  // them entirely and every pre-change persisted ticket_hash still validates.
  // plan_artifact joins them on exactly the same terms (roadmap entry
  // plan-artifact-not-forwarded-to-plan-review): the planner receipt's own
  // recorded plan, one bounded entry per evidence key, carried onto the
  // plan-check, plan-critic and plan-judge tickets so a plan reviewer verifies
  // the PLAN the planner recorded rather than the operator's run objective.
  // Like the two above it is receipt-derived agent-authored text — evidence to
  // act on, never instructions — and optional with no default, so every ticket
  // that carries no artifact stays byte-identical and hash-stable.
  prior_attempts: z.array(nonEmpty).optional(),
  review_findings: z.array(nonEmpty).optional(),
  plan_artifact: z.array(nonEmpty).optional(),
  // Versioned structured planning is opt-in at the run boundary. These fields
  // intentionally have no defaults: tickets from legacy runs parse and hash
  // exactly as they did before the contract existed.
  candidate_plan: CandidatePlanSchema.optional(),
  approved_plan: ApprovedPlanSchema.optional(),
  plan_contract_version: z.union([z.literal(PLAN_CONTRACT_VERSION), z.literal(2)]).optional(),
  // Optional with no default so legacy tickets keep their historical bytes.
  review_contract_version: z.literal(REVIEW_CONTRACT_VERSION).optional(),
  test_scope: z.literal('exact').optional(),
  verification_profiles: z.array(z.object({
    id: z.string().regex(/^[A-Za-z][A-Za-z0-9._-]{0,63}$/),
    description: z.string().min(1).max(500)
      .refine((value) => value.trim().length > 0, {
        message: 'verification profile description must be non-blank text',
      }),
    command: z.string().min(1).max(8_192)
      .refine((value) => value.trim().length > 0 && !/[\r\n\0;&|<>`$]/.test(value), {
        message: 'verification profile command must be shell-free exact argv',
      }),
    root: z.string().min(1).max(512).refine((value) => {
      if (value === '.') return true;
      if (value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:\//.test(value)) return false;
      if (value.endsWith('/') || value.includes('//')) return false;
      const segments = value.split('/');
      return segments.every((segment) => segment !== '' && segment !== '..' && segment !== '.');
    }, {
      message: 'verification profile root must be a canonical contained project-relative path',
    }).optional(),
    timeout_ms: z.number().int().min(1).max(86_400_000),
  }).strict()).max(64).superRefine((profiles, context) => {
    const ids = new Set();
    for (const [index, profile] of profiles.entries()) {
      if (ids.has(profile.id)) {
        context.addIssue({
          code: 'custom',
          path: [index, 'id'],
          message: `duplicate verification profile id: ${profile.id}`,
        });
      }
      ids.add(profile.id);
    }
  }).optional(),
  preflight: z.object({
    artifact_hash: digest,
    artifact: z.record(z.string(), z.unknown()),
    trust: z.literal('untrusted-evidence'),
    operator_evidence: z.object({
      trust: z.literal('untrusted-evidence'),
      answers: z.array(z.object({
        id: z.string().min(1).max(128),
        answer: z.string().min(1).max(16_384),
      }).strict()).max(32),
    }).strict().optional(),
  }).strict().optional(),
  expired_predecessor: z.object({
    ticket_id: nonEmpty,
    ticket_hash: digest,
    base_tree_sha: sha,
    inherited_paths: z.array(z.string().min(1).max(200)).max(20),
    omitted_path_count: z.number().int().nonnegative(),
  }).strict().optional(),
  // scope_expansion joins the three above on the identical terms: optional
  // with no default, so a ticket this channel never touches omits the key
  // entirely and stays byte-identical and hash-stable. Unlike its siblings
  // (each a flat array of already-rendered strings) it carries the
  // structured {claimed_paths, reason} pair a remediation ticket's own
  // scope-expansion notice is built from and a retry forwards unchanged —
  // both fields already bounded (lib/runtime/service.js boundedScopeExpansion)
  // before this ever reaches a ticket a bound subagent reads whole.
  scope_expansion: z.object({
    claimed_paths: z.array(nonEmpty),
    reason: nonEmpty,
  }).strict().optional(),
  ticket_hash: digest,
}).strict();

const RoadmapFollowupSchema = z.object({
  id: z.string().min(1).max(128),
  title: z.string().min(1).max(200),
  description: z.string().min(1).max(4_000),
  acceptance: z.string().min(1).max(2_000),
  depends_on: z.array(z.string().min(1).max(128)).max(32).default([]),
}).strict();

const ReceiptEvidenceSchema = z.object({
  roadmap_followups: z.array(RoadmapFollowupSchema).max(64).optional(),
}).catchall(z.unknown()).superRefine((value, context) => {
  if (value.roadmap_followups === undefined) return;
  const bytes = Buffer.byteLength(JSON.stringify(value.roadmap_followups), 'utf8');
  if (bytes > 64 * 1_024) {
    context.addIssue({
      code: 'custom',
      path: ['roadmap_followups'],
      message: 'roadmap_followups exceeds 65536 serialized UTF-8 bytes',
    });
  }
  const ids = new Set();
  for (const [index, entry] of value.roadmap_followups.entries()) {
    if (ids.has(entry.id)) {
      context.addIssue({
        code: 'custom',
        path: ['roadmap_followups', index, 'id'],
        message: `duplicate roadmap follow-up id: ${entry.id}`,
      });
    }
    ids.add(entry.id);
    const dependencies = new Set();
    for (const [dependencyIndex, dependency] of entry.depends_on.entries()) {
      if (dependency === entry.id) {
        context.addIssue({
          code: 'custom',
          path: ['roadmap_followups', index, 'depends_on', dependencyIndex],
          message: `roadmap follow-up ${entry.id} must not depend on itself`,
        });
      }
      if (dependencies.has(dependency)) {
        context.addIssue({
          code: 'custom',
          path: ['roadmap_followups', index, 'depends_on', dependencyIndex],
          message: `roadmap follow-up ${entry.id} has duplicate dependency: ${dependency}`,
        });
      }
      dependencies.add(dependency);
    }
  }
});

export const StageReceiptSchema = z.object({
  schema_version: z.literal(SCHEMA_VERSION),
  receipt_id: nonEmpty,
  run_id: nonEmpty,
  ticket_id: nonEmpty,
  ticket_hash: digest,
  agent: z.object({
    host: z.enum(['claude', 'codex']),
    role: nonEmpty,
    identity: nonEmpty,
    // Provenance is truthful only when the model was actually observed (F11).
    // `model` is the *effective* executed model, recorded only when a host
    // lifecycle result reports one (none does today, so it is null on new
    // receipts). `requested_model` is the host-attested Agent `model` request
    // parameter, validated against the ticket's resolved model at launch. All
    // attestation fields are optional without defaults so pre-rename
    // hash-chained receipts keep validating byte-identically.
    model: nonEmpty.nullable(),
    model_attested: z.boolean().optional(),
    requested_model: nonEmpty.nullable().optional(),
    requested_model_attested: z.boolean().optional(),
  }).strict(),
  status: z.enum(RECEIPT_STATUSES),
  base_tree_sha: sha,
  head_tree_sha: sha,
  changed_files: z.array(nonEmpty),
  tests: z.array(z.object({
    command: nonEmpty,
    passed: z.boolean(),
    exit_code: z.number().int(),
    duration_ms: z.number().nonnegative(),
    output_hash: digest.optional(),
  }).strict()),
  findings: z.array(z.record(z.string(), z.unknown())),
  tool_effects: z.array(z.object({
    provider: nonEmpty,
    operation: nonEmpty,
    effect: z.enum(['read', 'write', 'execute', 'unknown']),
    resources: z.array(nonEmpty),
    tool_use_id: nonEmpty.nullable(),
    status: z.enum(['completed', 'failed']),
    response_hash: digest.nullable(),
    occurred_at: nonEmpty,
  }).strict()).optional(),
  evidence: ReceiptEvidenceSchema,
  timing: z.object({
    started_at: nonEmpty,
    completed_at: nonEmpty,
    duration_ms: z.number().nonnegative(),
  }).strict(),
  previous_receipt_hash: digest.nullable(),
  receipt_hash: digest,
}).strict();

export const RunStartInputSchema = z.object({
  objective: nonEmpty,
  mode: z.enum(START_MODES),
  lane: z.enum(LANES).default('auto'),
  host: z.enum(['claude', 'codex']),
  claimed_paths: z.array(nonEmpty).default([]),
  tool_claims: z.array(toolClaim).default([]),
  test_paths: z.array(nonEmpty).default([]),
  requirements: z.array(nonEmpty).default([]),
  risk_triggers: z.array(nonEmpty).default([]),
  behavioral: z.boolean().default(true),
  hooks_trusted: z.boolean(),
  subagents_available: z.boolean(),
  explicit_invocation: z.boolean(),
  // Adapter-attested native launch protocol. The MCP entrypoint sets this;
  // direct service/reducer callers may omit it for host-neutral simulation.
  binding_protocol: z.literal('native-v1').optional(),
  // Persistent shipping config is not operator consent for this particular
  // run. Public/native starts must carry an explicit, auditable authorization
  // before an auto-merge-enabled run may begin.
  auto_merge_authorized: z.boolean().default(false),
  // Public MCP starts also require a one-time preflight canary. Kept separate
  // from binding_protocol so direct service tests can simulate ticket binding
  // without having to simulate the adapter's preceding native tool call.
  binding_probe: z.literal('required-v1').optional(),
  // Advances vs completes (RM2): `requirements` means "this run advances these";
  // `completes` is the subset the run FINISHES. Auto-satisfy fires only when a
  // run that declared completion reaches archived `completed`. Defaults empty so
  // a run that declares nothing complete stays byte-identical (state omits the
  // key entirely). The subset check lives in startRun (a loud reject).
  completes: z.array(nonEmpty).default([]),
  // Cross-run supersession (friction #10): optional id of an abandoned run
  // this start supersedes, recorded in the run's immutable history record.
  // Same shape history enforces for run ids (SAFE_RUN_ID).
  supersedes_run: z.string().regex(/^run-[A-Za-z0-9_-]{1,128}$/).optional(),
  // Omission is the legacy planning path. Public MCP starts select v1, while
  // persisted/pre-upgrade direct callers can still omit it without a rewrite.
  plan_contract_version: z.union([z.literal(PLAN_CONTRACT_VERSION), z.literal(2)]).optional(),
}).strict();

// Audit 1.11: finalize* must hash the MATERIALIZED record — the object as Zod
// persists it after defaults fill in — not the raw caller input, or a caller
// omitting a defaulted field (parallel_group, test_paths) mints a record whose
// stored hash ignores keys the persisted object carries and validate* (which
// recomputes over parsed data) reports a permanent hash mismatch. The hash
// field is required by the schema, so parse first with a syntactically valid
// placeholder, hash the parsed data excluding that field, then re-validate
// with the real hash attached. Fully-populated inputs parse to the same
// canonical data they arrived as, so existing hashes are unchanged.
const HASH_PLACEHOLDER = '0'.repeat(64);

export function finalizeTicket(ticket) {
  const materialized = StageTicketSchema.parse({ ...ticket, ticket_hash: HASH_PLACEHOLDER });
  const finalized = StageTicketSchema.parse({
    ...materialized,
    ticket_hash: hashRecord(materialized, ['ticket_hash']),
  });
  if (finalized.test_scope === 'exact') markExactTestScope(finalized.test_paths);
  return finalized;
}

export function finalizeReceipt(receipt) {
  const materialized = StageReceiptSchema.parse({ ...receipt, receipt_hash: HASH_PLACEHOLDER });
  return StageReceiptSchema.parse({
    ...materialized,
    receipt_hash: hashRecord(materialized, ['receipt_hash']),
  });
}

export function validateTicket(ticket) {
  const parsed = StageTicketSchema.safeParse(ticket);
  if (!parsed.success) return { valid: false, errors: parsed.error.issues };
  const expected = hashRecord(parsed.data, ['ticket_hash']);
  if (expected !== parsed.data.ticket_hash) {
    return { valid: false, errors: [{ path: ['ticket_hash'], message: 'ticket hash mismatch' }] };
  }
  if (parsed.data.test_scope === 'exact') markExactTestScope(ticket.test_paths);
  return { valid: true, value: parsed.data };
}

// Draft receipt validation schemas — used by the pre-termination validation
// path to structure bounded field-specific corrections. These never touch the
// authoritative receipt recording path (recordReceiptLocked).
export const ReceiptDraftCorrectionSchema = z.object({
  field: z.string().min(1),
  issue: z.string().min(1),
  correction: z.string().min(1),
}).strict();

export const ReceiptValidationResultSchema = z.object({
  valid: z.boolean(),
  corrections: z.array(ReceiptDraftCorrectionSchema),
}).strict();

export function validateReceipt(receipt) {
  const parsed = StageReceiptSchema.safeParse(receipt);
  if (!parsed.success) return { valid: false, errors: parsed.error.issues };
  const expected = hashRecord(parsed.data, ['receipt_hash']);
  if (expected !== parsed.data.receipt_hash) {
    return { valid: false, errors: [{ path: ['receipt_hash'], message: 'receipt hash mismatch' }] };
  }
  return { valid: true, value: parsed.data };
}
