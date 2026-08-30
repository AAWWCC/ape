import { RECEIPT_STATUSES } from './constants.js';
import { sha256 } from './canonical.js';

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
    evidence: {
      type: 'object',
      properties: {
        failure_kind: {
          type: 'string',
          enum: ['capability', 'command-shape', 'test-contradiction'],
          description: 'Machine-readable failed-stage classification. Use command-shape for a correctable policy syntax denial and capability only when the ticket lacks required authority.',
        },
        required_claims: {
          type: 'object',
          additionalProperties: false,
          description: 'For a failed capability receipt only: one exact additive object, never an array. Include at least one genuinely new member and omit unused members or claims already present on the ticket.',
          properties: {
            claimed_paths: {
              type: 'array',
              maxItems: 64,
              items: { type: 'string', minLength: 1, maxLength: 512 },
            },
            test_paths: {
              type: 'array',
              maxItems: 64,
              items: { type: 'string', minLength: 1, maxLength: 512 },
            },
            required_role: { type: 'string', minLength: 1, maxLength: 64 },
          },
        },
        roadmap_followups: {
          type: 'array',
          maxItems: 64,
          description: 'Bounded roadmap entry proposals. Registration remains a separate operator-approved roadmap-register action; do not include status or discovered_by.',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['id', 'title', 'description', 'acceptance'],
            properties: {
              id: { type: 'string', minLength: 1, maxLength: 128 },
              title: { type: 'string', minLength: 1, maxLength: 200 },
              description: { type: 'string', minLength: 1, maxLength: 4000 },
              acceptance: { type: 'string', minLength: 1, maxLength: 2000 },
              depends_on: {
                type: 'array',
                maxItems: 32,
                items: { type: 'string', minLength: 1, maxLength: 128 },
              },
            },
          },
        },
      },
      additionalProperties: true,
      description:
        'Free-form evidence with reserved schemas for capability required_claims and roadmap_followups. evidence.required_claims is an additive object, never an array, and is valid only on a failed capability receipt. evidence.roadmap_followups is a bounded array of normalized proposals without status or discovered_by. Review roles must set evidence.verdict to agree or pass to signal agreement. A blocking review whose fix needs files outside the run claims lists the exact project-relative paths as evidence.scope_expansion.claimed_paths with a non-empty evidence.scope_expansion.reason; the runtime audits the expansion and remediation inherits the grown claim set.',
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
  if (input.evidence && typeof input.evidence === 'object' && !Array.isArray(input.evidence)
    && Array.isArray(input.evidence.roadmap_followups)) {
    let changed = false;
    const roadmap_followups = input.evidence.roadmap_followups.map((entry, index) => {
      if (entry && typeof entry === 'object' && !Array.isArray(entry) && entry.depends_on === undefined) {
        normalized_fields.push(`evidence.roadmap_followups[${index}].depends_on: omitted -> []`);
        changed = true;
        return { ...entry, depends_on: [] };
      }
      return entry;
    });
    if (changed) input.evidence = { ...input.evidence, roadmap_followups };
  }
  return { input, normalized_fields };
}

// One hash domain for draft validation, dispatch attestation, and authoritative
// record admission. The one-time capability proves who may submit a draft but
// is deliberately not part of the attested receipt body; receipt_id is likewise
// runtime-owned. Keeping this beside normalization prevents the validation
// tool and record path from drifting onto subtly different exact-draft hashes.
export function receiptInputHash(raw) {
  const bounded = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? { ...raw }
    : raw;
  if (bounded && typeof bounded === 'object') {
    delete bounded.receipt_capability;
    delete bounded.receipt_id;
  }
  return sha256(bounded);
}

// ---------------------------------------------------------------------------
// Draft receipt extraction from agent text output
// ---------------------------------------------------------------------------

// Minimal receipt shape: an object must have at least ticket_id and status to
// be recognizable as a receipt draft. This is best-effort extraction for the
// pre-termination validation path; it never replaces the authoritative
// normalizeReceiptInput coercion.
function looksLikeReceipt(obj) {
  return (
    obj !== null &&
    typeof obj === 'object' &&
    !Array.isArray(obj) &&
    typeof obj.ticket_id === 'string' &&
    obj.ticket_id.length > 0 &&
    ('status' in obj || 'tests' in obj || 'evidence' in obj)
  );
}

// Return the end of the JSON object beginning at start. JSON punctuation inside
// a string is data, not structure, and a quote is escaped only when preceded by
// an odd run of backslashes. Keeping that state in the bounded forward scan
// prevents receipt prose such as `"expected } but saw \"{\""` from truncating
// or extending the candidate object.
function jsonObjectEnd(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
    } else if (character === '{') {
      depth += 1;
    } else if (character === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }

  return -1;
}

/**
 * Scans text for a JSON receipt object. Handles plain JSON text and
 * prose-wrapped ```json``` code blocks.
 * @param {string} text
 * @returns {object|null} The parsed receipt draft, or null if none found.
 */
export function extractReceiptDraftFromText(text) {
  if (typeof text !== 'string' || text.length === 0) return null;

  // Try code-fenced JSON blocks first (```json ... ```)
  const fencePattern = /```(?:json)?\s*\n?([\s\S]*?)```/g;
  let match;
  while ((match = fencePattern.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1].trim());
      if (looksLikeReceipt(parsed)) return parsed;
    } catch {
      // Not valid JSON in this fence, try next
    }
  }

  // Try to find a JSON object in the raw text. Each candidate scan is bounded
  // by the supplied text and ignores structural characters inside JSON strings.
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue;
    const end = jsonObjectEnd(text, i);
    if (end < 0) continue;
    try {
      const parsed = JSON.parse(text.slice(i, end + 1));
      if (looksLikeReceipt(parsed)) return parsed;
    } catch {
      // Not valid JSON at this position
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Draft correction formatting
// ---------------------------------------------------------------------------

const FORMAT_CORRECTIONS_MAX_CHARS = 2000;

/**
 * Renders draft corrections into bounded text suitable for returning to the
 * agent as a continuation prompt.
 * @param {Array<{ field: string, issue: string, correction: string }>} corrections
 * @param {object} ticket
 * @returns {string}
 */
export function formatDraftCorrections(corrections, ticket) {
  if (!Array.isArray(corrections) || corrections.length === 0) {
    return '';
  }

  const lines = [`Receipt draft corrections for ${ticket?.ticket_id ?? 'unknown'}:`];
  for (const entry of corrections) {
    const line = `- ${entry.field}: ${entry.issue} -> ${entry.correction}`;
    lines.push(line);
  }

  let output = lines.join('\n');
  if (output.length > FORMAT_CORRECTIONS_MAX_CHARS) {
    output = output.slice(0, FORMAT_CORRECTIONS_MAX_CHARS - 13) + '\n[truncated]';
  }
  return output;
}
