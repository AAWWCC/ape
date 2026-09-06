import { GENERAL_INPUT_MAX_BYTES, INPUT_LIMITS, RECEIPT_INPUT_MAX_BYTES } from './input-guard.js';

const LEGACY_RECEIPT_LIMITS = Object.freeze({
  tests: 256,
  findings: 64,
  paths: 64,
  assurances: 16,
  assurance_text: 500,
  assurance_anchor: 600,
  finding_title: 200,
  finding_detail: 4_000,
  finding_line: 10_000_000,
  scope_reason: 4_000,
  contradiction_text: 2_000,
});

const RESOURCE_RECEIPT_LIMITS = Object.freeze({
  tests: INPUT_LIMITS.maxArrayLength,
  findings: INPUT_LIMITS.maxArrayLength,
  paths: INPUT_LIMITS.maxArrayLength,
  assurances: INPUT_LIMITS.maxArrayLength,
  assurance_text: RECEIPT_INPUT_MAX_BYTES,
  assurance_anchor: RECEIPT_INPUT_MAX_BYTES,
  finding_title: RECEIPT_INPUT_MAX_BYTES,
  finding_detail: RECEIPT_INPUT_MAX_BYTES,
  finding_line: Number.MAX_SAFE_INTEGER,
  scope_reason: RECEIPT_INPUT_MAX_BYTES,
  contradiction_text: RECEIPT_INPUT_MAX_BYTES,
});

// The exact immutable ticket distinguishes older, already-published field
// promises from the resource-envelope contract. No persisted ticket is edited
// or silently reinterpreted when a new default is introduced.
export function receiptLimitsForTicket(ticket) {
  return ticket?.capability_manifest?.byte_budgets?.candidate_plan_utf8_bytes === GENERAL_INPUT_MAX_BYTES
    ? RESOURCE_RECEIPT_LIMITS
    : LEGACY_RECEIPT_LIMITS;
}
