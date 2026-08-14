import { z } from 'zod';
import { LANES, MAX_STAGE_ATTEMPTS, MODEL_TIERS, RECEIPT_STATUSES, RUN_MODES, SCHEMA_VERSION } from './constants.js';
import { hashRecord } from './canonical.js';
import { parseToolClaim } from './external-tools.js';
import { ApprovedPlanSchema, CandidatePlanSchema, PLAN_CONTRACT_VERSION } from './plan-contract.js';

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
  plan_contract_version: z.literal(PLAN_CONTRACT_VERSION).optional(),
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
  return StageTicketSchema.parse({
    ...materialized,
    ticket_hash: hashRecord(materialized, ['ticket_hash']),
  });
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
  return { valid: true, value: parsed.data };
}

export function validateReceipt(receipt) {
  const parsed = StageReceiptSchema.safeParse(receipt);
  if (!parsed.success) return { valid: false, errors: parsed.error.issues };
  const expected = hashRecord(parsed.data, ['receipt_hash']);
  if (expected !== parsed.data.receipt_hash) {
    return { valid: false, errors: [{ path: ['receipt_hash'], message: 'receipt hash mismatch' }] };
  }
  return { valid: true, value: parsed.data };
}
