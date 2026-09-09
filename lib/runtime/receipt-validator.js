import path from 'node:path';
import { runtimePaths } from './paths.js';
import { readBoundedJson } from './bounded-file.js';
import { diffFiles, currentTreeSha } from './git.js';
import { canonicalRecoveryClaimPath, looksLikeTest, normalizeClaimPath, withinClaims, withinTestScope } from './path-scope.js';
import {
  REVIEW_CONTRACT_VERSION,
  validateReceipt,
  validateStructuredReviewReceipt,
  validateTicket,
} from './schemas.js';
import { canonicalJson, sha256 } from './canonical.js';
import { assertSafeReceiptInput } from './input-guard.js';
import {
  RECEIPT_INPUT_SCHEMA,
  RECEIPT_CORRECTIONS_MAX,
  RECEIPT_CORRECTION_FIELD_MAX_BYTES,
  boundedReceiptCorrectionText,
} from './receipt-input.js';
import {
  RECEIPT_MAX_SUBMISSIONS_PER_WORKER,
  RISK_TRIGGERS,
  ROLE_POLICIES,
} from './constants.js';
import {
  receiptDraftJsonSchemaForTicket,
  receiptDraftSchemaForTicket,
} from './receipt-draft-schema.js';
import { receiptLimitsForTicket } from './receipt-limits.js';
import {
  planLimitsForTicket,
  candidatePlanForScope,
  validatePlanDeviation,
  validatePreflightArtifact,
} from './plan-contract.js';

// ---------------------------------------------------------------------------
// Draft receipt validation — pure, synchronous, non-mutating
// ---------------------------------------------------------------------------
// Validates a raw draft receipt against a ticket's output_schema and
// role-specific requirements. Returns bounded field-specific corrections
// without I/O, git access, or state mutation. This runs BEFORE the
// authoritative recordReceiptLocked path and never replaces it.

export const RECEIPT_CONTRACT_VERSION = 1;

// Recovery inherits tree contents, never path exemptions. Read the sealed
// source transaction independently at each admission boundary; active.json
// and a worker-supplied baseline are not sufficient evidence of the handoff.
async function recoveryRecord(file) {
  return readBoundedJson(file, 16 * 1024 * 1024);
}

export function sourceOwnsFiles(ticket, files) {
  return files.every((file) => ticket.writable && (
    ticket.role === 'test_writer'
      ? withinTestScope(file, ticket.test_paths, ticket.test_scope === 'exact')
      : withinClaims(file, ticket.claimed_paths) &&
        (ticket.role !== 'implementer' || !looksLikeTest(file, ticket.test_paths))
  ));
}

export async function resolveReceiptBaseline({ project_dir, state, ticket, tree = null }, ancestry = new Set()) {
  const provenance = ticket.recovery_provenance;
  if (!provenance && !ticket.recovery_lineage) return ticket.base_tree_sha;
  const reject = () => { throw new Error('capability recovery source tree evidence is invalid or missing'); };
  if (ancestry.has(ticket.ticket_id) || ancestry.size >= 64 || !validateTicket(ticket).valid) reject();
  const visited = new Set(ancestry).add(ticket.ticket_id);
  const sources = (state.tickets ?? []).filter((entry) => entry.ticket_id === provenance?.source_ticket_id);
  const receipts = (state.receipts ?? []).filter((entry) => entry.receipt_id === provenance?.source_receipt_id);
  if (sources.length !== 1 || receipts.length !== 1) reject();
  const source = sources[0];
  const receipt = receipts[0];
  if (!validateTicket(source).valid || !validateReceipt(receipt).valid ||
      provenance.authority !== 'runtime' || source.run_id !== state.run_id || ticket.run_id !== state.run_id ||
      receipt.run_id !== state.run_id || receipt.ticket_id !== source.ticket_id ||
      receipt.ticket_hash !== source.ticket_hash || receipt.agent.role !== source.role ||
      provenance.source_ticket_hash !== source.ticket_hash || provenance.source_receipt_hash !== receipt.receipt_hash ||
      ticket.parent_hash !== receipt.receipt_hash || ticket.recovery_lineage?.source_ticket_id !== source.ticket_id ||
      provenance.source_issued_at !== source.issued_at || provenance.source_deadline_at !== source.deadline_at ||
      provenance.derived_at !== ticket.issued_at || receipt.base_tree_sha !== source.base_tree_sha ||
      receipt.status !== 'failed' || receipt.evidence?.failure_kind !== 'capability' ||
      validateRecoveryDeclarations(source, receipt).length > 0) reject();
  const paths = runtimePaths(project_dir);
  const transaction = await recoveryRecord(path.join(paths.receiptTransactions, `${sha256(source.ticket_id)}.json`));
  const effect = transaction.prepared_effect;
  if (!['prepared', 'committed'].includes(transaction.status) || transaction.run_id !== state.run_id ||
      transaction.ticket_id !== source.ticket_id || transaction.input_hash !== provenance.receipt_input_hash ||
      canonicalJson(transaction.receipt) !== canonicalJson(receipt) || !effect ||
      transaction.prepared_effect_hash !== sha256(effect) ||
      canonicalJson(effect.successor_contract) !== canonicalJson(ticket) ||
      transaction.prepared_at !== provenance.derived_at) reject();
  const base = await resolveReceiptBaseline({ project_dir, state, ticket: source, tree }, visited);
  const diff = (from, to) => tree ? tree.diff(from, to) : diffFiles(project_dir, from, to);
  let files = await diff(base, receipt.head_tree_sha);
  const matches = (actual) => canonicalJson([...actual].sort()) === canonicalJson([...receipt.changed_files].sort());
  // Already sealed historical receipts retain their original attribution.
  // This fallback is available only for the exact transaction-bound source,
  // never for a fresh successor draft.
  if (!matches(files) && base !== source.base_tree_sha) files = await diff(source.base_tree_sha, receipt.head_tree_sha);
  if (!matches(files) || !sourceOwnsFiles(source, files)) reject();
  return receipt.head_tree_sha;
}
export const RECEIPT_VALIDATION_MAX_ATTEMPTS = RECEIPT_MAX_SUBMISSIONS_PER_WORKER;
export const RECEIPT_VALIDATION_TOOL = /^(?:mcp__(?:ape|plugin_ape_ape)__)?ape_validate_receipt$/;

export const RECEIPT_DRAFT_CORRECTIONS_MAX = RECEIPT_CORRECTIONS_MAX;

const VALID_STATUSES = new Set(['passed', 'failed']);
// Status synonyms that normalizeReceiptInput would coerce — flag them as
// correctable rather than rejecting outright.
const STATUS_SYNONYMS = { success: 'passed', complete: 'passed', completed: 'passed', failure: 'failed', error: 'failed' };

function pushCorrection(corrections, field, issue, correction) {
  if (corrections.length < RECEIPT_DRAFT_CORRECTIONS_MAX) {
    corrections.push({
      field: boundedReceiptCorrectionText(field, RECEIPT_CORRECTION_FIELD_MAX_BYTES),
      issue: boundedReceiptCorrectionText(issue),
      correction: boundedReceiptCorrectionText(correction),
    });
  }
}

function validateCommonFields(ticket, draft, corrections) {
  if (ticket.receipt_contract_version === RECEIPT_CONTRACT_VERSION) {
    const allowed = new Set(Object.keys(RECEIPT_INPUT_SCHEMA.properties));
    for (const key of Object.keys(draft)) {
      if (!allowed.has(key)) {
        pushCorrection(corrections, key, `unknown top-level receipt field "${key}" is not part of this ticket's output_schema`, `remove ${key}`);
      }
    }
  }
  // ticket_id
  if (draft.ticket_id === undefined || draft.ticket_id === null) {
    pushCorrection(corrections, 'ticket_id', 'ticket_id is missing', `set ticket_id to "${ticket.ticket_id}"`);
  } else if (typeof draft.ticket_id !== 'string' || draft.ticket_id === '') {
    pushCorrection(corrections, 'ticket_id', 'ticket_id must be a non-empty string', `set ticket_id to "${ticket.ticket_id}"`);
  } else if (draft.ticket_id !== ticket.ticket_id) {
    pushCorrection(corrections, 'ticket_id', `ticket_id "${draft.ticket_id}" does not match the ticket`, `set ticket_id to "${ticket.ticket_id}"`);
  }

  // status
  if (draft.status === undefined || draft.status === null) {
    pushCorrection(corrections, 'status', 'status is missing', 'set status to "passed" or "failed"');
  } else if (typeof draft.status !== 'string') {
    pushCorrection(corrections, 'status', 'status must be a string', 'set status to "passed" or "failed"');
  } else if (!VALID_STATUSES.has(draft.status)) {
    const synonym = STATUS_SYNONYMS[draft.status.toLowerCase()];
    if (synonym) {
      pushCorrection(corrections, 'status', `status "${draft.status}" is a synonym`, `use the canonical value "${synonym}"`);
    } else {
      pushCorrection(corrections, 'status', `status "${draft.status}" is not a valid value`, 'set status to "passed" or "failed"');
    }
  }

  // tests
  if (draft.tests === undefined || draft.tests === null) {
    pushCorrection(corrections, 'tests', 'tests is missing', 'set tests to an array of test result objects');
  } else if (!Array.isArray(draft.tests)) {
    pushCorrection(corrections, 'tests', 'tests must be an array', 'set tests to an array of test result objects');
  } else {
    const allowedCommands = ticket.receipt_contract_version === RECEIPT_CONTRACT_VERSION
      ? new Set(ticket.capability_manifest?.allowed_evidence_commands ?? [])
      : null;
    for (let i = 0; i < draft.tests.length; i++) {
      const test = draft.tests[i];
      if (!test || typeof test !== 'object' || Array.isArray(test)) {
        pushCorrection(corrections, `tests[${i}]`, 'test entry must be an object', 'provide an object with command, passed, exit_code, duration_ms');
        continue;
      }
      if (typeof test.command !== 'string' || test.command === '') {
        pushCorrection(corrections, `tests[${i}].command`, 'command must be a non-empty string', 'set command to the test command that was executed');
      } else if (allowedCommands && !allowedCommands.has(test.command)) {
        pushCorrection(
          corrections,
          `tests[${i}].command`,
          `command "${test.command}" is not an exact member of ticket.capability_manifest.allowed_evidence_commands`,
          'use one exact rendered command published by the immutable ticket capability manifest',
        );
      }
      if (typeof test.passed !== 'boolean') {
        pushCorrection(corrections, `tests[${i}].passed`, 'passed must be a boolean', 'set passed to true or false');
      }
      if (typeof test.exit_code !== 'number' || !Number.isInteger(test.exit_code)) {
        pushCorrection(corrections, `tests[${i}].exit_code`, 'exit_code must be an integer', 'set exit_code to the integer exit code');
      }
      if (typeof test.duration_ms !== 'number' || test.duration_ms < 0) {
        pushCorrection(corrections, `tests[${i}].duration_ms`, 'duration_ms must be a non-negative number', 'set duration_ms to the test duration in milliseconds');
      }
      if (test.output_hash !== undefined && !/^[0-9a-f]{64}$/i.test(test.output_hash)) {
        pushCorrection(corrections, `tests[${i}].output_hash`, 'output_hash must be a SHA-256 hex digest when supplied', 'omit output_hash when unknown, otherwise provide exactly 64 hexadecimal characters');
      }
    }
  }

  // findings
  if (draft.findings === undefined || draft.findings === null) {
    pushCorrection(corrections, 'findings', 'findings is missing', 'set findings to an array (empty array if no findings)');
  } else if (!Array.isArray(draft.findings)) {
    pushCorrection(corrections, 'findings', 'findings must be an array', 'set findings to an array of finding objects');
  } else {
    for (const [index, finding] of draft.findings.entries()) {
      if (!finding || typeof finding !== 'object' || Array.isArray(finding)) {
        pushCorrection(corrections, `findings[${index}]`, 'finding must be a plain object', 'provide a structured finding object or remove the entry');
      }
    }
  }

  // evidence
  if (draft.evidence === undefined || draft.evidence === null) {
    pushCorrection(corrections, 'evidence', 'evidence is missing', 'set evidence to an object with at least a summary field');
  } else if (typeof draft.evidence !== 'object' || Array.isArray(draft.evidence)) {
    pushCorrection(corrections, 'evidence', 'evidence must be a plain object, not an array', 'set evidence to an object with at least a summary field');
  } else if (Object.hasOwn(draft.evidence, 'operator_receipt_recovery')) {
    pushCorrection(
      corrections,
      'evidence.operator_receipt_recovery',
      'operator_receipt_recovery is runtime-owned audit evidence and cannot be supplied by a worker',
      'remove evidence.operator_receipt_recovery; the audited operator recovery action stamps it only after all ordinary receipt validations pass',
    );
  }

  if (
    ticket.receipt_contract_version === RECEIPT_CONTRACT_VERSION &&
    (typeof draft.receipt_capability !== 'string' || draft.receipt_capability.length === 0)
  ) {
    pushCorrection(corrections, 'receipt_capability', 'new receipt-contract tickets require the one-time bound receipt capability', 'set receipt_capability to the exact APE_RECEIPT_CAPABILITY injected for this physical dispatch');
  }
}

function planValidationContext(ticket) {
  const manifest = ticket.capability_manifest ?? {};
  return {
    plan_limits: planLimitsForTicket(ticket),
    preflight_hash: manifest.preflight_hash ?? ticket.preflight?.artifact_hash ?? null,
    verification_profiles: (manifest.verification_profiles ?? []).map((profile) => ({
      id: profile.id,
      required: profile.required === true || profile.disposition === 'required',
    })),
    require_design_assurance: manifest.design_assurance_required === true,
    risk_triggers: manifest.risk_triggers ?? ticket.risk_triggers ?? [],
    plannable_evidence_commands: ticket.receipt_contract_version === RECEIPT_CONTRACT_VERSION
      && Array.isArray(manifest.plannable_evidence_commands)
      ? manifest.plannable_evidence_commands
      : null,
    allowed_evidence_commands: ticket.receipt_contract_version === RECEIPT_CONTRACT_VERSION
      && Array.isArray(manifest.allowed_evidence_commands)
      ? manifest.allowed_evidence_commands
      : null,
  };
}

function fieldForPlanError(error, fallback) {
  const match = /^(evidence\.[A-Za-z0-9_.]+?)(?::| must| is| has| references| exceeds)/.exec(error);
  return match?.[1] ?? fallback;
}

function pushValidationErrors(corrections, errors, fallback, correction) {
  for (const error of errors) {
    pushCorrection(corrections, fieldForPlanError(error, fallback), error, correction);
  }
}

function renderRecoveryValue(value, max = 200) {
  return String(value)
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, String.fromCodePoint(0xfffd))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/**
 * Pure validation for receipt declarations which change how APE recovers.
 * The record path must call this same helper for new receipt-contract tickets;
 * legacy tickets retain their historical admission path.
 */
export function validateRecoveryDeclarations(ticket, receipt) {
  const errors = [];
  const limits = receiptLimitsForTicket(ticket);
  const missing = receipt.evidence?.missing_assurances;
  if (missing !== undefined) {
    if (!['plan_checker', 'plan_critic', 'plan_judge'].includes(ticket.role)) {
      errors.push('evidence.missing_assurances is accepted only from a plan review or plan judge ticket');
    } else if (!Array.isArray(missing) || missing.length < 1 || missing.length > limits.assurances) {
      errors.push(`evidence.missing_assurances must contain 1 through ${limits.assurances} bounded entries`);
    } else {
      missing.forEach((entry, index) => {
        const object = entry !== null && typeof entry === 'object' && !Array.isArray(entry)
          ? entry
          : null;
        const summary = typeof entry === 'string'
          ? entry
          : [object?.summary, object?.assurance, object?.reason, object?.detail, object?.title]
              .find((value) => typeof value === 'string' && value.trim() !== '');
        if (typeof summary !== 'string' || summary.trim() === '' || summary.length > limits.assurance_text) {
          errors.push(`evidence.missing_assurances.${index} requires non-empty summary text of at most ${limits.assurance_text} characters`);
        }
        if (object?.evidence_anchor !== undefined && (
          typeof object.evidence_anchor !== 'string' ||
          object.evidence_anchor.trim() === '' ||
          object.evidence_anchor.length > limits.assurance_anchor
        )) {
          errors.push(`evidence.missing_assurances.${index}.evidence_anchor must be non-empty text of at most ${limits.assurance_anchor} characters`);
        }
        if (object?.risk_trigger !== undefined && !RISK_TRIGGERS.includes(object.risk_trigger)) {
          errors.push(`evidence.missing_assurances.${index}.risk_trigger is not a supported risk trigger`);
        }
      });
    }
  }

  const requiredClaims = receipt.evidence?.required_claims;
  const capabilityFailure =
    receipt.status === 'failed' && receipt.evidence?.failure_kind === 'capability';
  if (capabilityFailure && requiredClaims === undefined) {
    errors.push('a failed capability receipt requires evidence.required_claims with at least one exact additive claim or required_role');
  }
  if (requiredClaims !== undefined) {
    if (!capabilityFailure) {
      errors.push('evidence.required_claims is accepted only on a failed capability receipt');
    } else if (
      requiredClaims === null ||
      typeof requiredClaims !== 'object' ||
      Array.isArray(requiredClaims)
    ) {
      errors.push('evidence.required_claims must be an object of exact additive claim arrays');
    } else {
      let additiveClaims = 0;
      const allowed = new Set(['claimed_paths', 'test_paths', 'required_role']);
      for (const key of Object.keys(requiredClaims)) {
        if (!allowed.has(key)) errors.push(`evidence.required_claims contains unsupported key: ${key}`);
      }
      for (const [key, existing] of [
        ['claimed_paths', ticket.claimed_paths ?? []],
        ['test_paths', ticket.test_paths ?? []],
      ]) {
        const values = requiredClaims[key] ?? [];
        if (!Array.isArray(values) || values.length > limits.paths) {
          errors.push(`evidence.required_claims.${key} must be an array of at most ${limits.paths} exact additions`);
          continue;
        }
        const seen = new Set();
        for (const [index, value] of values.entries()) {
          if (typeof value !== 'string' || value.trim() === '' || value.length > 512) {
            errors.push(`evidence.required_claims.${key}.${index} must be non-empty text of at most 512 characters`);
            continue;
          }
          let identity;
          const canonical = canonicalRecoveryClaimPath(value);
          if (canonical === null) {
            errors.push(`evidence.required_claims.${key}.${index} must be a canonical contained project-relative path`);
            continue;
          }
          identity = normalizeClaimPath(canonical);
          const duplicate = seen.has(identity);
          if (duplicate) errors.push(`evidence.required_claims.${key}.${index} is a duplicate addition`);
          else seen.add(identity);
          const alreadyAuthorized = existing.some((entry) => withinClaims(identity, [entry]));
          if (alreadyAuthorized) {
            errors.push(`evidence.required_claims.${key}.${index} is already on the immutable ticket and is not additive`);
          } else if (!duplicate) {
            additiveClaims += 1;
          }
        }
      }
      if (requiredClaims.required_role !== undefined) {
        if (
          typeof requiredClaims.required_role !== 'string' ||
          !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(requiredClaims.required_role)
        ) {
          errors.push('evidence.required_claims.required_role must be a bounded role identifier');
        } else if (!Object.hasOwn(ROLE_POLICIES, requiredClaims.required_role)) {
          errors.push('evidence.required_claims.required_role must name a dispatchable APE role');
        } else if (requiredClaims.required_role === ticket.role) {
          errors.push('evidence.required_claims.required_role is already the immutable ticket role and is not additive');
        } else {
          additiveClaims += 1;
        }
      }
      if (additiveClaims === 0) {
        errors.push('evidence.required_claims must contain at least one genuinely additive valid claim or required_role');
      }
    }
  }

  const contradiction = receipt.evidence?.test_contradiction;
  if (contradiction !== undefined) {
    if (
      ticket.role !== 'implementer' ||
      receipt.status !== 'failed' ||
      receipt.evidence?.failure_kind !== 'test-contradiction'
    ) {
      errors.push('evidence.test_contradiction is accepted only from a failed implementer test-contradiction receipt');
    } else if (contradiction === null || typeof contradiction !== 'object' || Array.isArray(contradiction)) {
      errors.push('evidence.test_contradiction must be a structured contradiction report');
    } else {
      const paths = contradiction.test_paths ?? [];
      if (!Array.isArray(paths) || paths.length > limits.paths) {
        errors.push(`evidence.test_contradiction.test_paths must be an array of at most ${limits.paths} authorized paths`);
      } else {
        for (const [index, testPath] of paths.entries()) {
          if (typeof testPath !== 'string' || !ticket.test_paths.includes(testPath)) {
            errors.push(`evidence.test_contradiction.test_paths.${index} is not an exact authorized ticket test path`);
          }
        }
      }
      for (const key of ['summary', 'incompatible_expectations']) {
        if (contradiction[key] !== undefined && (
          typeof contradiction[key] !== 'string' ||
          contradiction[key].trim() === '' ||
          contradiction[key].length > limits.contradiction_text
        )) {
          errors.push(`evidence.test_contradiction.${key} must be non-empty text of at most ${limits.contradiction_text} characters`);
        }
      }
    }
  }

  if (ticket.stage_id === 'test-reconcile' && receipt.status === 'passed') {
    const verdict = String(receipt.evidence?.verdict ?? '').toLowerCase();
    const negative = new Set(['disagree', 'fail', 'failed']).has(verdict);
    const positive = new Set(['agree', 'pass', 'passed']).has(verdict);
    const blocking = (receipt.findings ?? []).filter((finding) => finding?.blocking === true);
    if (negative) {
      const authorized = new Set(ticket.test_reconciliation?.test_paths ?? []);
      const confirmed = new Set();
      for (const [index, finding] of blocking.entries()) {
        const owner = finding?.remediation?.owner;
        if (!['test', 'both'].includes(owner)) {
          errors.push(`findings.${index} on a negative test-reconcile receipt must be test- or both-owned`);
          continue;
        }
        for (const testPath of finding.remediation?.test_paths ?? []) {
          if (!authorized.has(testPath)) {
            errors.push(`findings.${index}.remediation.test_paths contains a path outside ticket.test_reconciliation.test_paths: ${renderRecoveryValue(testPath)}`);
          } else {
            confirmed.add(testPath);
          }
        }
      }
      if (confirmed.size === 0) {
        errors.push('a negative test-reconcile verdict requires a blocking test- or both-owned finding that confirms at least one authorized reconciliation path');
      }
    } else if (positive && blocking.length > 0) {
      errors.push('a positive test-reconcile verdict may not carry a blocking contradiction finding');
    }
  }
  return errors;
}

function codePointRange(start, end) {
  return `${String.fromCodePoint(start)}-${String.fromCodePoint(end)}`;
}

const SCOPE_EXPANSION_CONTROL_CHARS = new RegExp(`[${[
  codePointRange(0x0000, 0x0008),
  codePointRange(0x000e, 0x001f),
  codePointRange(0x007f, 0x009f),
  codePointRange(0x00ad, 0x00ad),
  codePointRange(0x061c, 0x061c),
  codePointRange(0x200b, 0x200b),
  codePointRange(0x200e, 0x200f),
  codePointRange(0x202a, 0x202e),
  codePointRange(0x2060, 0x206f),
  codePointRange(0xfff9, 0xfffb),
].join('')}]`);

/** Pure, role-aware validation and normalization for audited scope growth. */
export function extractScopeExpansion(ticket, receipt) {
  const raw = receipt.evidence?.scope_expansion;
  if (raw === undefined || raw === null) return { errors: [], claimed_paths: [], reason: null };
  const errors = [];
  if (!['reviewer', 'security_reviewer'].includes(ticket.role)) {
    return {
      errors: [
        `evidence.scope_expansion is a review-receipt channel (reviewer or security_reviewer); a ${ticket.role} receipt may not grow the claim set`,
      ],
      claimed_paths: [],
      reason: null,
    };
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      errors: ['evidence.scope_expansion must be an object: { claimed_paths: [..], reason: ".." }'],
      claimed_paths: [],
      reason: null,
    };
  }
  const positive = new Set(['agree', 'pass', 'passed']);
  const completed = String(receipt.status).toLowerCase() === 'passed';
  const negative = !positive.has(
    String(receipt.evidence?.verdict ?? receipt.status).toLowerCase(),
  );
  // Receipt-contract workers must describe a product finding with a completed
  // negative review. A failed review is an orchestration/infrastructure signal
  // and cannot smuggle product-scope growth through that non-voting channel.
  // Preserve the historical admission rule for legacy tickets already in
  // flight; only newly issued immutable contracts opt into this stricter arm.
  const blockingFinding = (receipt.findings ?? [])
    .some((finding) => finding?.blocking === true);
  const blocking = ticket.receipt_contract_version === RECEIPT_CONTRACT_VERSION
    ? completed && negative && blockingFinding
    : !completed || negative;
  if (!blocking) {
    errors.push('scope expansion requires a blocking review verdict: record the finding with evidence.verdict fail alongside the proposed paths');
  }
  if (typeof raw.reason !== 'string' || raw.reason.trim() === '') {
    errors.push('scope expansion requires a non-empty evidence.scope_expansion.reason naming why the fix needs the added paths');
  }
  const claimed = [];
  if (!Array.isArray(raw.claimed_paths) || raw.claimed_paths.length === 0) {
    errors.push('scope expansion requires evidence.scope_expansion.claimed_paths: a non-empty array of project-relative paths');
  } else {
    for (const entry of raw.claimed_paths) {
      const shown = renderRecoveryValue(typeof entry === 'string' ? entry : JSON.stringify(entry));
      if (typeof entry !== 'string' || entry.trim() === '') {
        errors.push(`scope_expansion.claimed_paths entries must be non-empty strings, got ${shown}`);
        continue;
      }
      if (SCOPE_EXPANSION_CONTROL_CHARS.test(entry)) {
        errors.push(`scope_expansion path may not contain a control, DEL/C1, or bidi/format character: ${shown}`);
        continue;
      }
      const slashed = entry.replaceAll('\\', '/');
      if (slashed.startsWith('/') || /^[A-Za-z]:/.test(slashed)) {
        errors.push(`scope_expansion path must be relative to the project root: ${shown}`);
        continue;
      }
      if (slashed.split('/').includes('..')) {
        errors.push(`scope_expansion path may not contain '..' segments: ${shown}`);
        continue;
      }
      const normalized = normalizeClaimPath(slashed);
      if (normalized === '' || normalized === '.') {
        errors.push(`scope_expansion path is empty after normalization: ${shown}`);
        continue;
      }
      if (normalized === '.ape' || normalized.startsWith('.ape/')) {
        errors.push(`scope_expansion may not claim APE runtime state: ${shown}`);
        continue;
      }
      if (looksLikeTest(normalized, ticket.test_paths ?? [])) {
        errors.push(`scope_expansion may not claim test-shaped path ${shown}: authored tests stay implementer-read-only; propose production paths only`);
        continue;
      }
      claimed.push(normalized);
    }
  }
  return { errors, claimed_paths: [...new Set(claimed)], reason: raw.reason ?? null };
}

function validateRoleSpecific(ticket, draft, corrections) {
  const evidence = draft.evidence;
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) return;
  const passed = draft.status === 'passed';
  const planningTicket = ['plan', 'plan-replan'].includes(ticket.stage_id) || ticket.role === 'planner';
  const reviewRole = [
    'reviewer',
    'security_reviewer',
    'plan_checker',
    'plan_critic',
    'plan_judge',
  ].includes(ticket.role);

  if (planningTicket && passed && evidence.candidate_plan === undefined) {
    pushCorrection(corrections, 'evidence.candidate_plan', 'a passed planner receipt requires the complete structured candidate plan', 'set evidence.candidate_plan to the complete plan object described by output_schema');
  }
  if (evidence.candidate_plan !== undefined) {
    if (!planningTicket) {
      pushCorrection(corrections, 'evidence.candidate_plan', 'candidate_plan is accepted only on a planner ticket', 'remove evidence.candidate_plan from this receipt');
    } else {
      if (
        ticket.plan_contract_version !== undefined &&
        evidence.candidate_plan?.version !== ticket.plan_contract_version
      ) {
        pushCorrection(corrections, 'evidence.candidate_plan.version', `candidate plan version must equal ticket plan_contract_version ${ticket.plan_contract_version}`, `set evidence.candidate_plan.version to ${ticket.plan_contract_version}`);
      }
      const parsed = candidatePlanForScope(
        evidence.candidate_plan,
        [...(ticket.claimed_paths ?? []), ...(ticket.test_paths ?? [])],
        null,
        planValidationContext(ticket),
      );
      if (!parsed.valid) {
        pushValidationErrors(
          corrections,
          parsed.errors,
          'evidence.candidate_plan',
          'revise the candidate plan to satisfy the ticket-published nested schema, exact profile IDs, claims, and allowed command manifest',
        );
      }
    }
  }

  if (ticket.role === 'preflight_analyst' && passed && evidence.preflight_artifact === undefined) {
    pushCorrection(corrections, 'evidence.preflight_artifact', 'a passed preflight receipt requires the complete preflight artifact', 'set evidence.preflight_artifact to the complete artifact described by output_schema');
  }
  if (evidence.preflight_artifact !== undefined) {
    if (ticket.role !== 'preflight_analyst') {
      pushCorrection(corrections, 'evidence.preflight_artifact', 'preflight_artifact is accepted only on a preflight analyst ticket', 'remove evidence.preflight_artifact from this receipt');
    } else {
      const parsed = validatePreflightArtifact(evidence.preflight_artifact, {
        plan_limits: planLimitsForTicket(ticket),
        objective: ticket.objective,
        claims: ticket.claimed_paths ?? [],
        test_paths: ticket.test_paths ?? [],
        profiles: ticket.capability_manifest?.verification_profiles ?? ticket.verification_profiles ?? [],
        tests: Array.isArray(draft.tests) ? draft.tests : [],
      });
      if (!parsed.valid) {
        pushValidationErrors(
          corrections,
          parsed.errors,
          'evidence.preflight_artifact',
          'revise the preflight artifact to satisfy the ticket-published nested schema and exact ticket context',
        );
      }
    }
  }

  const exactVerdicts = ['plan_checker', 'plan_critic', 'plan_judge'].includes(ticket.role)
    ? ['agree', 'disagree']
    : ['pass', 'fail'];
  const verdicts = ticket.receipt_contract_version === RECEIPT_CONTRACT_VERSION
    ? exactVerdicts
    : ['agree', 'pass', 'passed', 'disagree', 'fail', 'failed'];
  if (reviewRole && passed) {
    if (typeof evidence.verdict !== 'string') {
      pushCorrection(corrections, 'evidence.verdict', `${ticket.role} receipt requires an explicit verdict`, `set evidence.verdict to one of: ${verdicts.join(', ')}`);
    } else if (!verdicts.includes(evidence.verdict.toLowerCase())) {
      pushCorrection(corrections, 'evidence.verdict', `evidence.verdict "${evidence.verdict}" is not valid for ${ticket.role}`, `set evidence.verdict to one of: ${verdicts.join(', ')}`);
    }
  }

  if (ticket.review_contract_version === REVIEW_CONTRACT_VERSION) {
    const errors = validateStructuredReviewReceipt(ticket, draft);
    pushValidationErrors(
      corrections,
      errors,
      'findings',
      'revise findings and verdict to satisfy the versioned structured-review contract',
    );
  }

  const deviation = validatePlanDeviation(
    evidence.plan_deviation,
    ticket.approved_plan,
    [...(ticket.claimed_paths ?? []), ...(ticket.test_paths ?? [])],
    planLimitsForTicket(ticket),
  );
  if (!deviation.valid) {
    pushValidationErrors(
      corrections,
      deviation.errors,
      'evidence.plan_deviation',
      'remove the deviation or make it reference the approved plan and this ticket\'s exact claims',
    );
  }

  if (
    passed &&
    ticket.required_checks?.includes('targeted-tests') &&
    (!Array.isArray(draft.tests) || !draft.tests.some((test) => test?.passed === true && test?.exit_code === 0))
  ) {
    pushCorrection(corrections, 'tests', 'passed receipt is missing successful targeted-test evidence required by this ticket', 'include at least one actually executed targeted test with passed:true and exit_code:0');
  }
}

/**
 * Complete role-specific wire schema for a new immutable receipt-contract
 * ticket. Legacy stages keep their existing shared schema untouched.
 */
export function receiptOutputSchemaForTicket(ticket) {
  return receiptDraftJsonSchemaForTicket(ticket);
}

/**
 * Validates a raw draft receipt against the ticket and role-specific
 * requirements. Pure, synchronous, and non-mutating.
 * @param {object} ticket - The immutable StageTicket
 * @param {object} draft - The raw draft receipt object
 * @returns {{
 *   valid: boolean,
 *   corrections: Array<{ field: string, issue: string, correction: string }>,
 *   budgets: { candidate_plan_utf8_bytes: { used_bytes: number, max_bytes: number, remaining_bytes: number } },
 * }}
 */
export function validateReceiptDraft(ticket, draft) {
  const corrections = [];
  const planMaxBytes = planLimitsForTicket(ticket).candidate_plan_utf8_bytes;
  let inputError = null;
  try {
    assertSafeReceiptInput(draft);
  } catch (error) {
    inputError = error.message.startsWith('unsafe prototype key:')
      ? 'receipt contains a forbidden prototype key'
      : error.message;
  }

  if (inputError || !draft || typeof draft !== 'object' || Array.isArray(draft)) {
    pushCorrection(corrections, 'receipt', inputError ?? 'draft must be a plain object',
      inputError ? 'return finite JSON within the receipt input envelope and structural limits; preserve required artifact coverage'
        : 'return a JSON object with ticket_id, status, tests, findings, and evidence');
    return {
      valid: false,
      corrections,
      budgets: {
        candidate_plan_utf8_bytes: {
          used_bytes: 0,
          max_bytes: planMaxBytes,
          remaining_bytes: planMaxBytes,
        },
      },
    };
  }

  if (ticket.receipt_contract_version === RECEIPT_CONTRACT_VERSION) {
    const parsed = receiptDraftSchemaForTicket(ticket).safeParse(draft);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        let field = '';
        for (const part of issue.path) {
          const segment = String(part);
          field = typeof part === 'number'
            ? `${field}[${segment}]`
            : field ? `${field}.${segment}` : segment;
        }
        if (field === '') field = 'receipt';
        pushCorrection(
          corrections,
          field,
          issue.message,
          `revise ${field} to satisfy the immutable ticket output_schema`,
        );
      }
    }
  }

  validateCommonFields(ticket, draft, corrections);
  validateRoleSpecific(ticket, draft, corrections);

  if (ticket.receipt_contract_version === RECEIPT_CONTRACT_VERSION) {
    pushValidationErrors(
      corrections,
      validateRecoveryDeclarations(ticket, draft),
      'evidence',
      'revise the recovery declaration to satisfy the immutable ticket role, scope, and additive-claim contract',
    );
    pushValidationErrors(
      corrections,
      extractScopeExpansion(ticket, draft).errors,
      'evidence.scope_expansion',
      'remove the scope expansion or provide a blocking review proposal containing only safe production paths',
    );
    if (ticket.capability_manifest?.version !== 1) {
      pushCorrection(corrections, 'ticket.capability_manifest', 'receipt-contract ticket is missing its immutable capability manifest', 'return control to the parent; this ticket requires recovery and must not be recorded');
    } else if (ticket.capability_manifest.objective_hash !== sha256(ticket.objective)) {
      pushCorrection(corrections, 'ticket.capability_manifest.objective_hash', 'capability manifest does not match the immutable ticket objective', 'return control to the parent; this ticket requires recovery and must not be recorded');
    } else if (
      ticket.capability_manifest.receipt_schema?.ref !== 'ticket.output_schema' ||
      ticket.capability_manifest.receipt_schema?.hash !== sha256(ticket.output_schema)
    ) {
      pushCorrection(corrections, 'ticket.capability_manifest.receipt_schema', 'capability manifest does not bind this ticket output_schema exactly', 'return control to the parent; this immutable ticket requires orchestration recovery and must not be recorded');
    }
  }

  let candidatePlanBytes = 0;
  if (draft.evidence && typeof draft.evidence === 'object' && !Array.isArray(draft.evidence)
    && draft.evidence.candidate_plan !== undefined) {
    try {
      candidatePlanBytes = Buffer.byteLength(canonicalJson(draft.evidence.candidate_plan), 'utf8');
    } catch {
      candidatePlanBytes = planMaxBytes + 1;
    }
  }

  return {
    valid: corrections.length === 0,
    corrections: corrections.slice(0, RECEIPT_DRAFT_CORRECTIONS_MAX),
    budgets: {
      candidate_plan_utf8_bytes: {
        used_bytes: candidatePlanBytes,
        max_bytes: planMaxBytes,
        remaining_bytes: Math.max(0, planMaxBytes - candidatePlanBytes),
      },
    },
  };
}

// Author-blind diff: the runtime cannot attribute a divergence to a writer,
// so it does not blame a worker or prescribe reset while the run is active.
// The service exposes bounded state-aware recovery without weakening the check.
const EXTERNAL_WRITER_HINT =
  'the writer cannot be attributed; preserve the current tree and inspect the state-aware recovery guidance before any operator-authorized lifecycle change';

// The role-boundary predicates are the shared path-scope matchers, so this
// receipt-time layer accepts exactly what the write-time hook allowed and
// rejects exactly what it denied. The default test predicate is claims-aware
// (looksLikeTest, not the bare name pattern): a test writer whose configured
// test claim is not test-named (a `checks/` suite) was admitted at write time
// and must not be rejected here as a production write.
//
// `tree` is an optional treeShaSession scoped to the caller's receipt-effects
// critical section. It does NOT weaken the independent recompute that
// enforces invariants 4/8 (docs/invariants.md names this module's recompute
// as their enforcement): a session's first read is always a real git read
// and is never seeded from receipt or ticket fields, so the comparison below
// still pits agent claims against a runtime-observed tree — the session only
// dedupes the byte-identical read the service layer performed microseconds
// earlier under the same lock, with no effect in between. Prepared-transaction
// replays keep their load-bearing live-tree check for the same reason: the
// session read IS the live tree.
//
// The result shape is declared explicitly because the admission-failure early
// return carries ONLY {valid, errors}: without a declared shape the two returns
// infer an unreduced union and every caller-side read of the analysis fields
// fails to typecheck. Every field below the first two is therefore OPTIONAL —
// that is the truth on the early-return path — and deadline_stamp_unparseable
// is additionally attached only when a stamp really is unparseable, so a
// well-formed receipt's result object is byte-identical to before.
/**
 * @returns {Promise<{
 *   valid: boolean,
 *   errors: string[],
 *   actual_files?: string[],
 *   tree_sha?: string,
 *   deadline_overrun_ms?: number,
 *   deadline_stamp_unparseable?: string,
 *   rejection_cause?: string,
 * }>}
 */
export async function validateStageReceipt({
  project_dir,
  state,
  ticket,
  receipt,
  tree = null,
  test_path_predicate = (file) => looksLikeTest(file, ticket.test_paths),
}) {
  const errors = [];
  const ticketResult = validateTicket(ticket);
  const receiptResult = validateReceipt(receipt);
  if (!ticketResult.valid) errors.push(...ticketResult.errors.map((error) => `ticket: ${error.message}`));
  if (!receiptResult.valid) errors.push(...receiptResult.errors.map((error) => `receipt: ${error.message}`));
  if (errors.length > 0) return { valid: false, errors };

  if (receipt.run_id !== state.run_id) errors.push('receipt belongs to a different run');
  if (receipt.ticket_id !== ticket.ticket_id) errors.push('receipt belongs to a different ticket');
  if (receipt.ticket_hash !== ticket.ticket_hash) errors.push('receipt ticket hash mismatch');
  if (receipt.agent.role !== ticket.role) errors.push('agent role does not match ticket role');
  if (receipt.base_tree_sha !== ticket.base_tree_sha) errors.push('receipt base tree is stale');
  if (state.receipts.some((entry) => entry.receipt_id === receipt.receipt_id)) errors.push('replayed receipt id');
  if (state.receipts.some((entry) => entry.receipt_hash === receipt.receipt_hash)) errors.push('replayed receipt hash');
  if (state.receipts.some((entry) => entry.ticket_id === ticket.ticket_id)) errors.push('ticket already has a receipt');
  const previous = state.receipts.at(-1)?.receipt_hash ?? null;
  if (receipt.previous_receipt_hash !== previous) errors.push('receipt hash chain is broken');
  // Self-reported tests[] can never carry authored-test admission (F12). The
  // service layer (recordReceiptLocked) exclusively executes the authored
  // paths and rejects the receipt unless the runtime observes the ticket's
  // red fail/fail or green pass/pass contract; requiring the worker to
  // duplicate that command creates redundant tool traffic without authority.
  if (
    receipt.status === 'passed' &&
    ticket.required_checks.includes('targeted-tests') &&
    !receipt.tests.some((test) => test.passed === true && test.exit_code === 0)
  ) {
    errors.push('required targeted-tests evidence is missing');
  }
  // A stamp that fails Date.parse must not silently DISABLE the lateness path:
  // Math.max(0, NaN) is NaN and `NaN > 0` is false, so an unparseable
  // deadline_at used to cost the state.deadline_overruns record that is its real
  // casualty. Both operands are runtime-generated (deadline_at is minted by
  // finalizeTicket and covered by ticket_hash; completed_at is re-stamped by the
  // service), so an unparseable one means tampering or state corruption: name
  // the offending field so the caller can record it loudly. Deliberately NOT a
  // new admission rejection — the ticket is immutable, so a rejection would
  // re-reject on every identical retry and burn both attempts with no operator
  // lever, guarding an error that is already verdict-redundant. When both stamps
  // parse, the overrun is byte-identical to before.
  let deadlineOverrunMs = 0;
  let deadlineStampUnparseable = null;
  if (receipt.status === 'passed') {
    const deadlineMs = Date.parse(ticket.deadline_at);
    const completedMs = Date.parse(receipt.timing.completed_at);
    const unparseable = [];
    if (Number.isNaN(deadlineMs)) unparseable.push('deadline_at');
    if (Number.isNaN(completedMs)) unparseable.push('completed_at');
    if (unparseable.length > 0) deadlineStampUnparseable = unparseable.join(',');
    else deadlineOverrunMs = Math.max(0, completedMs - deadlineMs);
  }

  const actualTree = tree ? await tree.current() : await currentTreeSha(project_dir);
  const treeConsistent = receipt.head_tree_sha === actualTree;
  if (!treeConsistent) {
    const divergent = tree
      ? await tree.diff(receipt.head_tree_sha, actualTree).catch(() => [])
      : await diffFiles(project_dir, receipt.head_tree_sha, actualTree).catch(() => []);
    errors.push(
      `receipt head tree does not match the current tree (diverged: ${divergent.join(', ') || 'unresolvable'}); ${EXTERNAL_WRITER_HINT}`,
    );
  }
  // A late receipt is admitted while it is still provably valid against the
  // live tree; once the tree has moved on, lateness is staleness and rejects.
  if (deadlineOverrunMs > 0 && !treeConsistent) errors.push('stage deadline exceeded');
  let actualFiles;
  try {
    const baseline = await resolveReceiptBaseline({ project_dir, state, ticket, tree });
    actualFiles = tree
      ? await tree.diff(baseline, receipt.head_tree_sha)
      : await diffFiles(project_dir, baseline, receipt.head_tree_sha);
  } catch (error) {
    return { valid: false, errors: [...errors, error.message], rejection_cause: 'receipt-invalid' };
  }
  const claimedFiles = [...receipt.changed_files].map(normalizeClaimPath).sort();
  if (JSON.stringify(actualFiles.map(normalizeClaimPath)) !== JSON.stringify(claimedFiles)) {
    errors.push('receipt changed_files does not match the independently recomputed diff');
  }
  const boundaryViolations = new Set();
  for (const file of actualFiles) {
    const exactTestScope = ticket.role === 'test_writer' && ticket.test_scope === 'exact';
    const testWriterScope =
      ticket.role === 'test_writer'
      && withinTestScope(file, ticket.test_paths, exactTestScope);
    // Exact remediation scope is authoritative for test writers. Check it
    // before the generic claimed-path fallback: an authorized file claim must
    // never become a directory prefix that admits an unauthorized descendant.
    if (
      (exactTestScope && !testWriterScope)
      || (!testWriterScope && !withinClaims(file, ticket.claimed_paths))
    ) {
      errors.push(`unclaimed write: ${file}`);
      boundaryViolations.add(file);
    }
    if (
      ticket.role === 'test_writer'
      && (exactTestScope ? !testWriterScope : !test_path_predicate(file))
    ) {
      errors.push(`test writer modified a production path: ${file}`);
      boundaryViolations.add(file);
    }
    // Same predicate as the write-time hook: an implementer touching anything
    // test-shaped — inside the authored test claims OR name-patterned — was
    // denied at write time, so the exact-file check here (which let a
    // hook-denied write slip through when the hook was absent) widens to match.
    if (ticket.role === 'implementer' && looksLikeTest(file, ticket.test_paths)) {
      errors.push(`implementer modified an authored test: ${file}`);
      boundaryViolations.add(file);
    }
    if (!ticket.writable) {
      errors.push(`read-only ${ticket.role} changed ${file}`);
      boundaryViolations.add(file);
    }
  }
  if (boundaryViolations.size > 0) {
    errors.push(
      `role-boundary violations (${[...boundaryViolations].join(', ')}) may not be the ticketed agent's own writes; ${EXTERNAL_WRITER_HINT}`,
    );
  }
  return {
    valid: errors.length === 0,
    errors,
    actual_files: actualFiles,
    tree_sha: actualTree,
    deadline_overrun_ms: deadlineOverrunMs,
    ...(errors.length > 0 ? {
      rejection_cause: !treeConsistent ? 'receipt-tree-diverged'
        : boundaryViolations.size > 0 ? 'receipt-role-boundary' : 'receipt-invalid',
    } : {}),
    ...(deadlineStampUnparseable ? { deadline_stamp_unparseable: deadlineStampUnparseable } : {}),
  };
}
