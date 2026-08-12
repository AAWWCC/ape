/**
 * Audit 1.11 (docs/research/2026-07-19-runtime-audit.md): finalizeTicket and
 * finalizeReceipt must hash the MATERIALIZED record — the object as Zod
 * persists it after defaults fill in — not the raw caller input. Otherwise a
 * caller that omits a defaulted field (parallel_group, test_paths) mints a
 * ticket whose stored hash ignores keys the persisted object carries, and
 * validateTicket/validateReceipt (which recompute over the parsed data)
 * report a permanent hash mismatch.
 *
 * Public contract exercised here, implementation-agnostically:
 *  - finalize* returns the persisted shape: defaults materialized, hash field
 *    attached.
 *  - The stored hash equals hashRecord(<persisted record>, [<hash field>]).
 *  - validate* accepts every record finalize* returns, including after a JSON
 *    persistence round-trip.
 *  - Inputs that spell defaults out explicitly hash identically to inputs
 *    that omit them, so existing fully-populated callers keep their hashes.
 */
import { describe, expect, it } from 'vitest';
import { hashRecord } from '../lib/runtime/canonical.js';
import { SCHEMA_VERSION } from '../lib/runtime/constants.js';
import {
  finalizeReceipt,
  finalizeTicket,
  validateReceipt,
  validateTicket,
} from '../lib/runtime/schemas.js';

const BASE_TREE_SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const HEAD_TREE_SHA = 'f9e8d7c6b5a40312d4c5b6a7980123456789abcd';

// Every REQUIRED (non-defaulted) StageTicket field, fixed timestamps so two
// finalize calls over equivalent inputs are byte-comparable. Defaulted fields
// (parallel_group, test_paths) are deliberately absent; tests opt in via
// overrides.
function ticketInput(overrides = {}) {
  return {
    schema_version: SCHEMA_VERSION,
    ticket_id: 'run-hash-after-parse:build:t1',
    run_id: 'run-hash-after-parse',
    stage_id: 'build',
    role: 'implementer',
    objective: 'Exercise finalize/validate hashing over materialized defaults',
    claimed_paths: ['src/value.js'],
    model_tier: 'balanced',
    model: { model: 'sonnet' },
    deadline_at: '2026-07-21T01:00:00.000Z',
    output_schema: {},
    required_checks: [],
    parent_hash: null,
    base_tree_sha: BASE_TREE_SHA,
    attempt: 1,
    writable: true,
    issued_at: '2026-07-20T23:00:00.000Z',
    ...overrides,
  };
}

function receiptInput(ticket) {
  return {
    schema_version: SCHEMA_VERSION,
    receipt_id: 'receipt-hash-after-parse-1',
    run_id: ticket.run_id,
    ticket_id: ticket.ticket_id,
    ticket_hash: ticket.ticket_hash,
    agent: {
      host: 'claude',
      role: 'implementer',
      identity: 'agent-implementer',
      model: 'sonnet',
    },
    status: 'passed',
    base_tree_sha: ticket.base_tree_sha,
    head_tree_sha: HEAD_TREE_SHA,
    changed_files: ['src/value.js'],
    tests: [
      { command: 'npx vitest run src/value.test.js', passed: true, exit_code: 0, duration_ms: 12 },
    ],
    findings: [],
    evidence: { verdict: 'pass' },
    timing: {
      started_at: '2026-07-20T23:00:00.000Z',
      completed_at: '2026-07-20T23:05:00.000Z',
      duration_ms: 300_000,
    },
    previous_receipt_hash: null,
  };
}

describe('finalizeTicket hashes the materialized record (audit 1.11)', () => {
  it('validateTicket accepts a finalized ticket whose input omitted defaulted fields', () => {
    const input = ticketInput();
    expect(input).not.toHaveProperty('parallel_group');
    expect(input).not.toHaveProperty('test_paths');

    const finalized = finalizeTicket(input);

    // The persisted object carries the materialized defaults...
    expect(finalized.parallel_group).toBeNull();
    expect(finalized.test_paths).toEqual([]);

    // ...and the stored hash must cover exactly that persisted object.
    expect(finalized.ticket_hash).toBe(hashRecord(finalized, ['ticket_hash']));

    const verdict = validateTicket(finalized);
    expect(verdict.errors ?? null).toBeNull();
    expect(verdict.valid).toBe(true);
  });

  it('validateTicket accepts the same ticket after a JSON persistence round-trip', () => {
    const finalized = finalizeTicket(ticketInput());
    const persisted = JSON.parse(JSON.stringify(finalized));

    // The on-disk record keeps the materialized defaults the hash must bind.
    expect(persisted.parallel_group).toBeNull();
    expect(persisted.test_paths).toEqual([]);

    const verdict = validateTicket(persisted);
    expect(verdict.errors ?? null).toBeNull();
    expect(verdict.valid).toBe(true);
    expect(verdict.value.ticket_hash).toBe(hashRecord(verdict.value, ['ticket_hash']));
  });

  it('omitting a defaulted field and spelling it out explicitly hash identically', () => {
    // Existing callers populate every field; their hashes must not move when
    // hashing shifts to the materialized object. Equivalently: an input that
    // omits a defaulted field must finalize to the very same hash as one that
    // states the default explicitly, because both persist the same object.
    const omitted = finalizeTicket(ticketInput());
    const explicit = finalizeTicket(ticketInput({ parallel_group: null, test_paths: [] }));

    expect(omitted.ticket_hash).toBe(explicit.ticket_hash);

    // The fully-populated path (today's callers) must validate too.
    const verdict = validateTicket(explicit);
    expect(verdict.errors ?? null).toBeNull();
    expect(verdict.valid).toBe(true);
  });
});

describe('finalizeReceipt hashes the materialized record (audit 1.11)', () => {
  it('stored receipt_hash matches a recompute over the persisted record and validateReceipt accepts it', () => {
    const ticket = finalizeTicket(ticketInput({ parallel_group: null, test_paths: [] }));
    const receipt = finalizeReceipt(receiptInput(ticket));

    expect(receipt.receipt_hash).toBe(hashRecord(receipt, ['receipt_hash']));

    const direct = validateReceipt(receipt);
    expect(direct.errors ?? null).toBeNull();
    expect(direct.valid).toBe(true);

    const persisted = JSON.parse(JSON.stringify(receipt));
    const roundTrip = validateReceipt(persisted);
    expect(roundTrip.errors ?? null).toBeNull();
    expect(roundTrip.valid).toBe(true);
    expect(roundTrip.value.receipt_hash).toBe(hashRecord(roundTrip.value, ['receipt_hash']));
  });
});
