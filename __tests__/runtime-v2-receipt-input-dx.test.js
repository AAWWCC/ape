import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { recordReceipt, startRun } from '../lib/runtime/service.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { atomicWriteJson, readJson } from '../lib/runtime/storage.js';
import { canonicalJson, sha256 } from '../lib/runtime/canonical.js';
import { normalizeReceiptInput, RECEIPT_INPUT_SCHEMA } from '../lib/runtime/receipt-input.js';
import { StageReceiptSchema } from '../lib/runtime/schemas.js';
import { initialStages } from '../lib/runtime/pipeline.js';

const HEX64 = 'a'.repeat(64);

const cleanups = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function project() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-receipt-dx-'));
  cleanups.push(dir);
  await mkdir(path.join(dir, 'src'));
  await mkdir(path.join(dir, 'tests'));
  await writeFile(path.join(dir, 'src', 'value.js'), 'export const value = 1;\n');
  await writeFile(path.join(dir, 'tests', 'value.test.js'), 'throw new Error("red");\n');
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'ape@example.test');
  git(dir, 'config', 'user.name', 'APE Test');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'test: baseline');
  const paths = runtimePaths(dir);
  await atomicWriteJson(paths.config, {
    shipping: { auto_merge: false, provider: 'github', required_remote_checks: false },
    test_commands: { full: 'node --test' },
  });
  return dir;
}

async function startFastRun(dir) {
  const started = await startRun(dir, {
    objective: 'Change behavior',
    mode: 'phase',
    lane: 'fast',
    host: 'codex',
    claimed_paths: ['src/value.js'],
    test_paths: ['tests/value.test.js'],
    requirements: [],
    risk_triggers: [],
    behavioral: true,
    hooks_trusted: true,
    subagents_available: true,
    explicit_invocation: true,
  });
  expect(started.ok).toBe(true);
  return started;
}

function receipt(ticket, overrides = {}) {
  return {
    ticket_id: ticket.ticket_id,
    status: 'passed',
    agent_identity: `agent-${ticket.role}`,
    tests: [],
    findings: [],
    evidence: { verdict: 'pass' },
    timing: {
      started_at: ticket.issued_at,
      completed_at: new Date(Date.parse(ticket.issued_at) + 10).toISOString(),
      duration_ms: 10,
    },
    ...overrides,
  };
}

function sloppyTestWriterReceipt(ticket) {
  return receipt(ticket, {
    status: 'completed',
    tests: { command: 'node tests/value.test.js', passed: false, exit_code: 1, duration_ms: 1, output_hash: null },
    findings: ['red observed'],
  });
}

describe('receipt input normalization', () => {
  it('maps exactly the five status synonyms, case-insensitively, with a note each', () => {
    const cases = [
      ['success', 'passed'],
      ['Success', 'passed'],
      ['complete', 'passed'],
      ['completed', 'passed'],
      ['COMPLETED', 'passed'],
      ['failure', 'failed'],
      ['error', 'failed'],
    ];
    for (const [from, to] of cases) {
      const { input, normalized_fields } = normalizeReceiptInput({ status: from });
      expect(input.status).toBe(to);
      expect(normalized_fields).toEqual([`status: "${from}" -> "${to}"`]);
    }
  });

  it('leaves off-list statuses untouched so they still reject loudly', () => {
    for (const status of ['ok', 'done', 'pass', 'Passed', 'canceled']) {
      const { input, normalized_fields } = normalizeReceiptInput({ status });
      expect(input.status).toBe(status);
      expect(normalized_fields).toEqual([]);
    }
  });

  it('coerces string findings to { note } and leaves other entries alone', () => {
    const { input, normalized_fields } = normalizeReceiptInput({
      findings: ['a', { note: 'b' }],
    });
    expect(input.findings).toEqual([{ note: 'a' }, { note: 'b' }]);
    expect(normalized_fields).toEqual(['findings[0]: string -> { note }']);
    const untouched = normalizeReceiptInput({ findings: [42, null, { note: 'b' }] });
    expect(untouched.input.findings).toEqual([42, null, { note: 'b' }]);
    expect(untouched.normalized_fields).toEqual([]);
  });

  it('wraps non-array findings: a bare string becomes [{ note }], a bare object becomes [object]', () => {
    const fromString = normalizeReceiptInput({ findings: 'no issues' });
    expect(fromString.input.findings).toEqual([{ note: 'no issues' }]);
    expect(fromString.normalized_fields).toEqual(['findings: string wrapped in array as { note }']);
    const single = { note: 'one finding' };
    const fromObject = normalizeReceiptInput({ findings: single });
    expect(fromObject.input.findings).toEqual([single]);
    expect(fromObject.normalized_fields).toEqual(['findings: single object wrapped in array']);
  });

  it('unwraps only a single-element evidence array of one object', () => {
    const { input, normalized_fields } = normalizeReceiptInput({ evidence: [{ verdict: 'pass' }] });
    expect(input.evidence).toEqual({ verdict: 'pass' });
    expect(normalized_fields).toEqual(['evidence: single-element array unwrapped']);
    for (const evidence of [[{ a: 1 }, { b: 2 }], [], ['pass'], [[{ a: 1 }]]]) {
      const untouched = normalizeReceiptInput({ evidence });
      expect(untouched.input.evidence).toEqual(evidence);
      expect(untouched.normalized_fields).toEqual([]);
    }
  });

  it('wraps a single tests object in a one-element array', () => {
    const entry = { command: 'node --test', passed: true, exit_code: 0, duration_ms: 1 };
    const { input, normalized_fields } = normalizeReceiptInput({ tests: entry });
    expect(input.tests).toEqual([entry]);
    expect(normalized_fields).toEqual(['tests: single object wrapped in array']);
  });

  it('removes only a null output_hash from test entries', () => {
    const { input, normalized_fields } = normalizeReceiptInput({
      tests: [
        { command: 'a', passed: true, exit_code: 0, duration_ms: 1, output_hash: null },
        { command: 'b', passed: true, exit_code: 0, duration_ms: 1, output_hash: HEX64 },
        { command: 'c', passed: true, exit_code: 0, duration_ms: 1 },
      ],
    });
    expect('output_hash' in input.tests[0]).toBe(false);
    expect(input.tests[1].output_hash).toBe(HEX64);
    expect('output_hash' in input.tests[2]).toBe(false);
    expect(normalized_fields).toEqual(['tests[0].output_hash: null removed']);
  });

  it('is a canonical-hash identity for already-valid input, pinning input_hash compatibility', () => {
    const raw = {
      ticket_id: 'run:stage:ticket',
      status: 'passed',
      agent_identity: 'agent-test_writer',
      tests: [
        { command: 'node tests/value.test.js', passed: false, exit_code: 1, duration_ms: 1, output_hash: HEX64 },
      ],
      findings: [{ note: 'red observed' }],
      evidence: { verdict: 'pass' },
      timing: { started_at: '2026-01-01T00:00:00.000Z', completed_at: '2026-01-01T00:00:00.010Z', duration_ms: 10 },
    };
    const { input, normalized_fields } = normalizeReceiptInput(raw);
    expect(normalized_fields).toEqual([]);
    expect(sha256(canonicalJson(input))).toBe(sha256(canonicalJson(raw)));
  });
});

describe('record-edge coercion end-to-end', () => {
  it('records a sloppy payload with sealed coercion notes and replays it idempotently', async () => {
    const dir = await project();
    const started = await startFastRun(dir);
    const testTicket = started.run.tickets[0];
    expect(testTicket.role).toBe('test_writer');
    await writeFile(path.join(dir, 'tests', 'value.test.js'), 'throw new Error("still red");\n');

    const result = await recordReceipt(dir, sloppyTestWriterReceipt(testTicket));
    expect(result.ok).toBe(true);
    expect(result.receipt.status).toBe('passed');
    expect(result.receipt.tests).toHaveLength(1);
    expect('output_hash' in result.receipt.tests[0]).toBe(false);
    expect(result.receipt.findings).toEqual([{ note: 'red observed' }]);
    const expectedNotes = [
      'status: "completed" -> "passed"',
      'tests: single object wrapped in array',
      'tests[0].output_hash: null removed',
      'findings[0]: string -> { note }',
    ];
    expect(result.normalized_fields).toEqual(expectedNotes);
    expect(result.receipt.evidence.normalized_fields).toEqual(expectedNotes);

    const replay = await recordReceipt(dir, sloppyTestWriterReceipt(testTicket));
    expect(replay).toMatchObject({ ok: true, idempotent: true });
    expect(replay.receipt.receipt_id).toBe(result.receipt.receipt_id);
    expect(replay.run.receipts).toHaveLength(1);
  });

  it('rejects an off-list status loudly with no durable side effect', async () => {
    const dir = await project();
    const started = await startFastRun(dir);
    const testTicket = started.run.tickets[0];
    await writeFile(path.join(dir, 'tests', 'value.test.js'), 'throw new Error("still red");\n');
    await expect(recordReceipt(dir, receipt(testTicket, {
      status: 'done',
      tests: [{ command: 'node tests/value.test.js', passed: false, exit_code: 1, duration_ms: 1 }],
    }))).rejects.toThrow();
    const paths = runtimePaths(dir);
    const state = await readJson(paths.active);
    expect(state.receipts).toHaveLength(0);
    expect(await readdir(paths.receipts).catch(() => [])).toHaveLength(0);
    expect(await readdir(paths.receiptTransactions).catch(() => [])).toHaveLength(0);
  });

  it('routes a coerced failed status into the retry machinery', async () => {
    const dir = await project();
    const started = await startFastRun(dir);
    const testTicket = started.run.tickets[0];
    await writeFile(path.join(dir, 'tests', 'value.test.js'), 'throw new Error("still red");\n');
    const testResult = await recordReceipt(dir, receipt(testTicket, {
      tests: [{ command: 'node tests/value.test.js', passed: false, exit_code: 1, duration_ms: 1 }],
    }));
    expect(testResult.ok).toBe(true);
    const implementer = testResult.run.tickets.at(-1);
    expect(implementer.role).toBe('implementer');

    const failed = await recordReceipt(dir, receipt(implementer, { status: 'error' }));
    expect(failed.ok).toBe(true);
    expect(failed.receipt.status).toBe('failed');
    expect(failed.normalized_fields).toEqual(['status: "error" -> "failed"']);
    expect(failed.run.attempts[implementer.stage_id]).toBe(2);
    const retry = failed.run.tickets.at(-1);
    expect(retry.role).toBe('implementer');
    expect(retry.attempt).toBe(2);
    expect(retry.ticket_id).not.toBe(implementer.ticket_id);
  });
});

describe('shipped output_schema stays in sync with zod', () => {
  it('agrees with StageReceiptSchema on the status enum', () => {
    expect(new Set(RECEIPT_INPUT_SCHEMA.properties.status.enum))
      .toEqual(new Set(StageReceiptSchema.shape.status.options));
  });

  it('every shipped required key (except ticket_id) is zod-required', () => {
    for (const key of RECEIPT_INPUT_SCHEMA.required) {
      if (key === 'ticket_id') continue;
      const field = StageReceiptSchema.shape[key];
      expect(field, `StageReceiptSchema.shape.${key}`).toBeDefined();
      expect(field.safeParse(undefined).success).toBe(false);
    }
  });

  it('the tests item contract matches the zod element shape', () => {
    const element = StageReceiptSchema.shape.tests.element;
    const items = RECEIPT_INPUT_SCHEMA.properties.tests.items;
    const shapeKeys = Object.keys(element.shape);
    const requiredKeys = shapeKeys.filter((key) => !element.shape[key].safeParse(undefined).success);
    expect(new Set(items.required)).toEqual(new Set(requiredKeys));
    expect(new Set(Object.keys(items.properties))).toEqual(new Set(shapeKeys));
    expect(items.required).not.toContain('output_hash');
    expect(element.shape.output_hash.safeParse(undefined).success).toBe(true);
  });

  it('the output_hash pattern and the zod digest field agree', () => {
    const pattern = new RegExp(RECEIPT_INPUT_SCHEMA.properties.tests.items.properties.output_hash.pattern);
    const hex64 = HEX64;
    const hex40 = 'a'.repeat(40);
    const zodField = StageReceiptSchema.shape.tests.element.shape.output_hash;
    expect(pattern.test(hex64)).toBe(true);
    expect(zodField.safeParse(hex64).success).toBe(true);
    expect(pattern.test(hex40)).toBe(false);
    expect(zodField.safeParse(hex40).success).toBe(false);
  });

  it('documents capability required_claims as the exact additive object the runtime accepts', () => {
    const field = RECEIPT_INPUT_SCHEMA.properties.evidence.properties.required_claims;
    expect(field.type).toBe('object');
    expect(field.additionalProperties).toBe(false);
    expect(Object.keys(field.properties).sort()).toEqual([
      'claimed_paths', 'required_role', 'test_paths', 'tool_claims',
    ]);
    for (const key of ['claimed_paths', 'test_paths', 'tool_claims']) {
      expect(field.properties[key]).toMatchObject({
        type: 'array',
        maxItems: 64,
        items: { type: 'string', minLength: 1, maxLength: 512 },
      });
    }
    expect(field.properties.required_role).toMatchObject({
      type: 'string', minLength: 1, maxLength: 64,
    });
    expect(field.description).toMatch(/object, never an array/iu);
  });

  it('ships the full contract on issued stages by identity', () => {
    expect(initialStages({ mode: 'phase', lane: 'fast' })[0].output_schema).toBe(RECEIPT_INPUT_SCHEMA);
  });
});
