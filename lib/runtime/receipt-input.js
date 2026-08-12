import { RECEIPT_STATUSES } from './constants.js';

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

// The full record-input contract, shipped on every StageTicket as
// output_schema so agents see the real requirements (and the tolerated
// synonyms) at dispatch instead of discovering them at record time. Advisory
// documentation only: zod (StageReceiptSchema) stays authoritative, and a sync
// test pins the two together. changed_files is deliberately absent from
// required — the record path ignores it and recomputes the diff from git, so
// instructing agents to compute a discarded field is the DX failure this
// contract fixes.
export const RECEIPT_INPUT_SCHEMA = deepFreeze({
  type: 'object',
  required: ['ticket_id', 'status', 'tests', 'findings', 'evidence'],
  properties: {
    ticket_id: {
      type: 'string',
      minLength: 1,
      description: 'The StageTicket ticket_id this receipt answers.',
    },
    status: {
      type: 'string',
      enum: [...RECEIPT_STATUSES],
      description:
        'Stage outcome. success/complete/completed normalize to passed; failure/error normalize to failed; any other value is rejected.',
    },
    tests: {
      type: 'array',
      description:
        'One entry per test command executed; a single object is normalized to a one-element array.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['command', 'passed', 'exit_code', 'duration_ms'],
        properties: {
          command: { type: 'string', minLength: 1 },
          passed: { type: 'boolean' },
          exit_code: { type: 'integer' },
          duration_ms: { type: 'number', minimum: 0 },
          output_hash: {
            type: 'string',
            pattern: '^[0-9a-fA-F]{64}$',
            description:
              'sha256 hex of the test output; omit when unknown (null is normalized to omitted).',
          },
        },
      },
    },
    findings: {
      type: 'array',
      items: { type: 'object' },
      description:
        'Structured finding objects; a bare string entry is normalized to {note: <string>}.',
    },
    tool_effects: {
      type: 'array',
      readOnly: true,
      description: 'Runtime-sealed external MCP/editor operations observed by APE hooks. Any caller-supplied value is ignored.',
      items: { type: 'object' },
    },
    evidence: {
      type: 'object',
      description:
        'Free-form evidence; review roles must set evidence.verdict to agree or pass to signal agreement. A blocking review whose fix needs files outside the run claims lists the exact project-relative paths as evidence.scope_expansion.claimed_paths with a non-empty evidence.scope_expansion.reason; the runtime audits the expansion and remediation inherits the grown claim set.',
    },
    timing: {
      type: 'object',
      properties: {
        started_at: { type: 'string' },
        completed_at: { type: 'string' },
        duration_ms: { type: 'number', minimum: 0 },
      },
      description: 'ISO-8601 timing. started_at defaults from the ticket when omitted; completed_at is server-stamped at record time and any wire-supplied value is discarded (T5).',
    },
    agent_identity: { type: 'string' },
    receipt_capability: {
      type: 'string',
      description: 'One-time receipt capability token for native host binding.',
    },
  },
});

// Exactly these five literals: a mis-coerced status silently consumes the
// stage's single retry, so canonical enum values are not case-folded
// ('Passed' still rejects loudly) and anything ambiguous
// ('canceled'/'cancel'/'pass'/'ok'/'done') stays off-list.
const STATUS_SYNONYMS = Object.freeze({
  success: 'passed',
  complete: 'passed',
  completed: 'passed',
  failure: 'failed',
  error: 'failed',
});

// Closed-allowlist coercion of the record input. For already-valid input this
// is a canonical-hash identity (shallow copies only, no defaults injected, no
// unknown keys stripped) — load-bearing: receiptInputHash is computed over the
// normalized input, so pre-upgrade committed/prepared transactions (whose
// stored input was necessarily zod-valid and normalizes to itself) keep
// hashing identically (F15 idempotent recovery), a retry with either the
// sloppy or corrected payload maps to the same input_hash, and the Claude
// capability binding — keyed on the same inputHash — stays consistent because
// normalization is deterministic.
export function normalizeReceiptInput(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { input: raw, normalized_fields: [] };
  }
  const input = { ...raw };
  const normalized_fields = [];
  if (typeof input.status === 'string') {
    const lowered = input.status.toLowerCase();
    const mapped = Object.hasOwn(STATUS_SYNONYMS, lowered) ? STATUS_SYNONYMS[lowered] : undefined;
    if (mapped) {
      normalized_fields.push(`status: "${input.status}" -> "${mapped}"`);
      input.status = mapped;
    }
  }
  if (input.tests && typeof input.tests === 'object' && !Array.isArray(input.tests)) {
    normalized_fields.push('tests: single object wrapped in array');
    input.tests = [input.tests];
  }
  if (Array.isArray(input.tests)) {
    input.tests = input.tests.map((entry, index) => {
      if (entry && typeof entry === 'object' && !Array.isArray(entry) && entry.output_hash === null) {
        normalized_fields.push(`tests[${index}].output_hash: null removed`);
        const { output_hash: _null, ...rest } = entry;
        return rest;
      }
      return entry;
    });
  }
  if (typeof input.findings === 'string') {
    normalized_fields.push('findings: string wrapped in array as { note }');
    input.findings = [{ note: input.findings }];
  } else if (input.findings && typeof input.findings === 'object' && !Array.isArray(input.findings)) {
    normalized_fields.push('findings: single object wrapped in array');
    input.findings = [input.findings];
  }
  if (Array.isArray(input.findings)) {
    input.findings = input.findings.map((entry, index) => {
      if (typeof entry === 'string') {
        normalized_fields.push(`findings[${index}]: string -> { note }`);
        return { note: entry };
      }
      return entry;
    });
  }
  if (Array.isArray(input.evidence) && input.evidence.length === 1
    && input.evidence[0] && typeof input.evidence[0] === 'object' && !Array.isArray(input.evidence[0])) {
    // Only the unambiguous single-element case: a multi-element evidence array
    // has no canonical merge and must keep failing loudly.
    normalized_fields.push('evidence: single-element array unwrapped');
    input.evidence = input.evidence[0];
  }
  return { input, normalized_fields };
}
