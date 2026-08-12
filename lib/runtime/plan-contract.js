import path from 'node:path';
import { z } from 'zod';
import { canonicalJson, sha256 } from './canonical.js';
import { evaluateLifecyclePolicy } from './hooks.js';
import { withinClaims } from './path-scope.js';

export const PLAN_CONTRACT_VERSION = 1;
export const PLAN_CONTRACT_MAX_BYTES = 16_384;

const digest = z.string().regex(/^[0-9a-f]{64}$/i);
const boundedText = z.string().min(1).max(500).refine((value) => value.trim().length > 0, {
  message: 'must contain non-whitespace text',
});
const contractId = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/);
const contractPath = z.string().min(1).max(512).superRefine((value, context) => {
  const normalized = path.posix.normalize(value);
  if (
    value.includes('\0') ||
    value.includes('\\') ||
    path.posix.isAbsolute(value) ||
    /^[A-Za-z]:\//.test(value) ||
    value === '.' ||
    value.endsWith('/') ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized !== value
  ) {
    context.addIssue({
      code: 'custom',
      message: 'must be a canonical POSIX project-relative path without dot segments or redundant separators',
    });
  }
});

const PlanRequirementSchema = z.object({
  id: contractId,
  requirement: boundedText,
  workstreams: z.array(contractId).min(1).max(16),
}).strict();

const PlanPathSchema = z.object({
  path: contractPath,
  action: z.enum(['create', 'modify', 'delete']),
}).strict();

const PlanWorkstreamSchema = z.object({
  id: contractId,
  outcome: boundedText,
  paths: z.array(PlanPathSchema).min(1).max(16),
  steps: z.array(boundedText).min(1).max(16),
  acceptance: z.array(boundedText).min(1).max(16),
  evidence_commands: z.array(boundedText).min(1).max(16),
}).strict();

const PlanRiskSchema = z.object({
  risk: boundedText,
  mitigation: boundedText,
}).strict();

function addDuplicateIssues(values, field, context) {
  const seen = new Set();
  for (const [index, value] of values.entries()) {
    if (seen.has(value)) {
      context.addIssue({
        code: 'custom',
        path: [field, index, 'id'],
        message: `duplicate ${field} id: ${value}`,
      });
    }
    seen.add(value);
  }
}

export const PlanContractSchema = z.object({
  version: z.literal(PLAN_CONTRACT_VERSION),
  requirements: z.array(PlanRequirementSchema).min(1).max(32),
  workstreams: z.array(PlanWorkstreamSchema).min(1).max(16),
  risks: z.array(PlanRiskSchema).max(16),
  non_goals: z.array(boundedText).max(16),
}).strict().superRefine((plan, context) => {
  addDuplicateIssues(plan.requirements.map((entry) => entry.id), 'requirements', context);
  addDuplicateIssues(plan.workstreams.map((entry) => entry.id), 'workstreams', context);

  const workstreamIds = new Set(plan.workstreams.map((entry) => entry.id));
  for (const [requirementIndex, requirement] of plan.requirements.entries()) {
    const seen = new Set();
    for (const [referenceIndex, workstreamId] of requirement.workstreams.entries()) {
      if (seen.has(workstreamId)) {
        context.addIssue({
          code: 'custom',
          path: ['requirements', requirementIndex, 'workstreams', referenceIndex],
          message: `duplicate workstream reference: ${workstreamId}`,
        });
      } else if (!workstreamIds.has(workstreamId)) {
        context.addIssue({
          code: 'custom',
          path: ['requirements', requirementIndex, 'workstreams', referenceIndex],
          message: `unknown workstream reference: ${workstreamId}`,
        });
      }
      seen.add(workstreamId);
    }
  }

  const bytes = Buffer.byteLength(canonicalJson(plan), 'utf8');
  if (bytes > PLAN_CONTRACT_MAX_BYTES) {
    context.addIssue({
      code: 'custom',
      message: `canonical candidate plan exceeds ${PLAN_CONTRACT_MAX_BYTES} UTF-8 bytes`,
    });
  }
});

export const CandidatePlanSchema = z.object({
  plan_hash: digest,
  plan: PlanContractSchema,
}).strict().superRefine((candidate, context) => {
  if (candidate.plan_hash !== sha256(candidate.plan)) {
    context.addIssue({ code: 'custom', path: ['plan_hash'], message: 'candidate plan hash mismatch' });
  }
});

export const ApprovedPlanSchema = z.object({
  version: z.literal(PLAN_CONTRACT_VERSION),
  plan_hash: digest,
  approval_route: z.enum(['unanimous', 'judge']),
  reviewer_receipt_hashes: z.array(digest).min(2).max(3),
  plan: PlanContractSchema,
}).strict().superRefine((approved, context) => {
  if (approved.plan_hash !== sha256(approved.plan)) {
    context.addIssue({ code: 'custom', path: ['plan_hash'], message: 'approved plan hash mismatch' });
  }
  const expected = approved.approval_route === 'unanimous' ? 2 : 3;
  if (approved.reviewer_receipt_hashes.length !== expected) {
    context.addIssue({
      code: 'custom',
      path: ['reviewer_receipt_hashes'],
      message: `${approved.approval_route} approval requires exactly ${expected} reviewer receipt hashes`,
    });
  }
  if (new Set(approved.reviewer_receipt_hashes).size !== approved.reviewer_receipt_hashes.length) {
    context.addIssue({
      code: 'custom',
      path: ['reviewer_receipt_hashes'],
      message: 'reviewer receipt hashes must be unique',
    });
  }
});

export const PlanDeviationSchema = z.object({
  workstream_id: contractId,
  reason: boundedText,
  replacement: boundedText,
  affected_paths: z.array(contractPath).min(1).max(16),
  acceptance_impact: boundedText,
}).strict();

function recognizedEvidenceCommand(command, projectDir) {
  const result = evaluateLifecyclePolicy(
    {
      event: 'PreToolUse',
      tool_name: 'Bash',
      command,
      is_subagent: true,
      host: 'codex',
      project_dir: projectDir,
    },
    {
      state: { status: 'running' },
      ticket: {
        ticket_id: 'plan-contract-validation',
        role: 'planner',
        writable: false,
      },
    },
  );
  return result.decision === 'allow' && (
    result.reason === 'recognized non-mutating evidence command' ||
    result.reason.startsWith('exact command profile ')
  );
}

function issues(error, prefix) {
  return error.issues.map((issue) => {
    const location = issue.path.length > 0 ? `.${issue.path.join('.')}` : '';
    return `${prefix}${location}: ${issue.message}`;
  });
}

export function candidatePlanForScope(value, claims, projectDir = null) {
  const parsed = PlanContractSchema.safeParse(value);
  if (!parsed.success) return { valid: false, errors: issues(parsed.error, 'evidence.candidate_plan') };
  const errors = [];
  for (const [workstreamIndex, workstream] of parsed.data.workstreams.entries()) {
    for (const [pathIndex, entry] of workstream.paths.entries()) {
      if (!withinClaims(entry.path, claims)) {
        errors.push(
          `evidence.candidate_plan.workstreams.${workstreamIndex}.paths.${pathIndex}.path is outside the run claimed_paths/test_paths: ${entry.path}`,
        );
      }
    }
    for (const [commandIndex, command] of workstream.evidence_commands.entries()) {
      if (!recognizedEvidenceCommand(command, projectDir)) {
        errors.push(
          `evidence.candidate_plan.workstreams.${workstreamIndex}.evidence_commands.${commandIndex} is not a recognized non-mutating evidence command: ${command}`,
        );
      }
    }
  }
  if (errors.length > 0) return { valid: false, errors };
  return {
    valid: true,
    value: Object.freeze({ plan_hash: sha256(parsed.data), plan: parsed.data }),
  };
}

export function approvedPlan(candidate, approvalRoute, reviewerReceiptHashes) {
  return ApprovedPlanSchema.parse({
    version: PLAN_CONTRACT_VERSION,
    plan_hash: candidate.plan_hash,
    approval_route: approvalRoute,
    reviewer_receipt_hashes: reviewerReceiptHashes,
    plan: candidate.plan,
  });
}

export function validatePlanDeviation(value, approved, ticketClaims) {
  if (value === undefined || value === null) return { valid: true, value: null, errors: [] };
  const parsedApproved = ApprovedPlanSchema.safeParse(approved);
  if (!parsedApproved.success) {
    return {
      valid: false,
      errors: ['evidence.plan_deviation is not allowed without a valid approved_plan on the ticket'],
    };
  }
  const parsed = PlanDeviationSchema.safeParse(value);
  if (!parsed.success) {
    return { valid: false, errors: issues(parsed.error, 'evidence.plan_deviation') };
  }
  const workstreamIds = new Set(parsedApproved.data.plan.workstreams.map((entry) => entry.id));
  const errors = [];
  if (!workstreamIds.has(parsed.data.workstream_id)) {
    errors.push(`evidence.plan_deviation.workstream_id references unknown workstream: ${parsed.data.workstream_id}`);
  }
  for (const [index, affectedPath] of parsed.data.affected_paths.entries()) {
    if (!withinClaims(affectedPath, ticketClaims)) {
      errors.push(
        `evidence.plan_deviation.affected_paths.${index} is outside this ticket's claimed_paths/test_paths: ${affectedPath}`,
      );
    }
  }
  return errors.length > 0
    ? { valid: false, errors }
    : { valid: true, value: parsed.data, errors: [] };
}
