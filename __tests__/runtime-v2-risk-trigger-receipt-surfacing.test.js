import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { recordReceipt, startRun } from '../lib/runtime/service.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { atomicWriteJson, readJson } from '../lib/runtime/storage.js';
import { sha256 } from '../lib/runtime/canonical.js';

// Risk-trigger receipt-surfacing hardening (follow-up to #272 / T9 hygiene).
//
// The public contract under test, derived from the objective:
//
//   (1) MALFORMED (non-string) entries in receipt.evidence.risk_triggers must
//       be SURFACED LOUDLY, not silently dropped. Today service.js (~1684-1688)
//       filters non-strings via `typeof === 'string'` BEFORE the surfacing
//       block, so numbers/objects/null vanish without a trace. The hardened
//       contract: a malformed entry must be surfaced like an unrecognized
//       string token is — a returned warning AND an overrides.ndjson audit line
//       carrying a bounded serialization of the offending entries — while it
//       must NOT hard-fail the run, must NOT join the persisted risk_triggers,
//       and must NOT arm high_risk.
//
//   (2) The unrecognized/malformed risk-trigger audit append must be
//       REPLAY-SAFE. recordReceipt's prepared-transaction crash-replay
//       re-executes the surfacing block; today the overrides.ndjson append runs
//       on both the fresh and the replay path, so a crash-recovered receipt
//       duplicates the audit line. The hardened contract: exactly ONE audit
//       line per unrecognized-token event survives a prepared-transaction
//       replay, while the returned warning still fires on the replay response
//       so the response stays truthful.
//
// Everything is driven through the public service surface (startRun /
// recordReceipt); no production file is written. Fixtures run in isolated temp
// projects, so writing `.ape/` state inside a fixture (to reconstruct a
// crash-recovery on-disk shape) is test setup, exactly as the existing
// crash-simulation suites do — never a write to this repo's runtime state.

const cleanups = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

// CJS on purpose: the scratch project has no package.json, so .js files run as
// CommonJS under the configured `node tests/value.test.js` targeted command
// (the runtime's red-test observation executes it).
const VALUE_V1 = 'module.exports = { value: 1 };\n';
const VALUE_V2 = 'module.exports = { value: 2 };\n';
const AUTHORED_TEST =
  "const { value } = require('../src/value.js');\n" +
  "if (value !== 2) { throw new Error('red: value is ' + value); }\n";

async function project(config = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-risk-trigger-surfacing-'));
  cleanups.push(dir);
  await mkdir(path.join(dir, 'src'));
  await mkdir(path.join(dir, 'tests'));
  await writeFile(path.join(dir, 'src', 'value.js'), VALUE_V1);
  await writeFile(path.join(dir, 'tests', 'value.test.js'), 'throw new Error("placeholder");\n');
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'ape@example.test');
  git(dir, 'config', 'user.name', 'APE Test');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'test: baseline');
  await atomicWriteJson(runtimePaths(dir).config, {
    shipping: { auto_merge: false, provider: 'github', required_remote_checks: false },
    test_commands: {
      full: 'node -e "process.exit(0)"',
      targeted: 'node tests/value.test.js',
    },
    ...config,
  });
  return dir;
}

function startInput(overrides = {}) {
  return {
    objective: 'Exercise risk-trigger receipt surfacing hardening',
    mode: 'phase',
    lane: 'auto',
    host: 'codex',
    claimed_paths: ['src/value.js'],
    test_paths: ['tests/value.test.js'],
    requirements: [],
    risk_triggers: [],
    behavioral: true,
    hooks_trusted: true,
    subagents_available: true,
    explicit_invocation: true,
    ...overrides,
  };
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

const redTest = [{ command: 'node tests/value.test.js', passed: false, exit_code: 1, duration_ms: 1 }];
const greenTest = [{ command: 'node tests/value.test.js', passed: true, exit_code: 0, duration_ms: 1 }];

async function auditRaw(dir) {
  return readFile(runtimePaths(dir).overrideLog, 'utf8').catch(() => '');
}

// Count only the audit events of one `event` kind for one ticket, so an
// unrelated overrides.ndjson line (lock recovery, scope expansion, or the OTHER
// risk-trigger event kind) never perturbs the replay-duplication assertion.
async function countAudit(dir, event, ticketId) {
  const raw = await auditRaw(dir);
  return raw
    .split('\n')
    .filter(Boolean)
    .filter((line) => {
      try {
        const entry = JSON.parse(line);
        return entry.event === event && entry.ticket_id === ticketId;
      } catch {
        return false;
      }
    }).length;
}

// Parse the newest overrides.ndjson audit entry of one `event` kind for a ticket
// (or null). Malformed-entry surfacing carries a bounded serialization in the
// entry's own field, so the parsed object — not a substring probe of the raw
// text — is what the truncation and event-name pins assert against.
async function auditEntryFor(dir, event, ticketId) {
  const raw = await auditRaw(dir);
  return raw
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((entry) => entry && entry.event === event && entry.ticket_id === ticketId)
    .at(-1) ?? null;
}

function receiptTransactionFile(dir, ticketId) {
  return path.join(runtimePaths(dir).receiptTransactions, `${sha256(ticketId)}.json`);
}

// Drive a clean fast-lane run to its build (implementer) ticket: author the red
// test, observe red. The implementer receipt is the next receipt to record, and
// it is where a late risk trigger can ride in via receipt.evidence.risk_triggers
// on a still-running, gate-free stage (recording it advances the run to review
// and keeps it running — no merge-gate machinery in the way of the surfacing
// assertions or the crash-replay reconstruction).
async function walkToBuild(dir) {
  const started = await startRun(dir, startInput());
  expect(started.ok).toBe(true);
  expect(started.run.lane).toBe('fast');
  const testTicket = started.run.tickets[0];
  expect(testTicket.role).toBe('test_writer');
  await writeFile(path.join(dir, 'tests', 'value.test.js'), AUTHORED_TEST);
  const tested = await recordReceipt(dir, receipt(testTicket, { tests: redTest }));
  expect(tested.ok).toBe(true);
  const buildTicket = tested.run.tickets.at(-1);
  expect(buildTicket.role).toBe('implementer');
  return { buildTicket };
}

describe('malformed (non-string) receipt.evidence.risk_triggers are surfaced, not silently dropped (req 1)', () => {
  it('surfaces non-string entries (number, object, null) loudly, without hard-failing, arming high_risk, or persisting them', async () => {
    const dir = await project();
    const { buildTicket } = await walkToBuild(dir);
    await writeFile(path.join(dir, 'src', 'value.js'), VALUE_V2);

    // A distinctive string buried inside a malformed OBJECT entry: a correct
    // implementation surfaces the offending entries via bounded JSON.stringify,
    // so this marker must appear somewhere the runtime surfaced it.
    const MARKER = 'malformed-entry-marker';
    const built = await recordReceipt(dir, receipt(buildTicket, {
      tests: greenTest,
      evidence: { verdict: 'pass', risk_triggers: [7, { marker: MARKER }, null] },
    }));

    // A malformed entry must NOT hard-fail the run: the receipt records and the
    // pipeline advances past build to review.
    expect(built.ok).toBe(true);
    expect(built.run.tickets.at(-1).stage_id).toMatch(/review/);

    // ...and the malformed entries must be surfaced loudly on BOTH channels
    // independently: a returned warning AND an overrides.ndjson audit line carry
    // them. Asserting each channel separately (not `||`) means a regression that
    // drops either one fails.
    const inWarnings = [built.warnings, built.run?.warnings]
      .some((warning) => JSON.stringify(warning ?? null).includes(MARKER));
    const inAudit = (await auditRaw(dir)).includes(MARKER);
    expect(inWarnings).toBe(true);
    expect(inAudit).toBe(true);

    // The warning is a dedicated malformed_risk_triggers warning (not folded into
    // the unrecognized-string-token warning) and carries the offending marker.
    const warning = (built.warnings ?? []).find((entry) => entry.kind === 'malformed_risk_triggers');
    expect(warning).toBeTruthy();
    expect(JSON.stringify(warning.malformed_risk_triggers ?? [])).toContain(MARKER);

    // The audit line is a dedicated malformed_risk_triggers event for this ticket
    // and carries the marker in its own malformed_risk_triggers field.
    const audit = await auditEntryFor(dir, 'malformed_risk_triggers', buildTicket.ticket_id);
    expect(audit).not.toBeNull();
    expect(JSON.stringify(audit.malformed_risk_triggers ?? [])).toContain(MARKER);

    // A malformed entry is not a real risk trigger: surfacing it must not arm
    // high_risk and must not leak into the persisted canonical set.
    expect(built.run.high_risk).toBe(false);
    expect(JSON.stringify(built.run.risk_triggers ?? [])).not.toContain(MARKER);
    expect(built.run.risk_triggers ?? []).not.toContain(7);
  }, 30_000);

  it('bounds the surfaced serialization of an oversized malformed entry to 512 chars + the truncation suffix on BOTH channels, never leaking the full payload', async () => {
    const dir = await project();
    const { buildTicket } = await walkToBuild(dir);
    await writeFile(path.join(dir, 'src', 'value.js'), VALUE_V2);

    // A SINGLE-key object so JSON.stringify is order-stable regardless of any
    // receipt canonicalization; its serialization far exceeds the 512-char
    // MALFORMED_RISK_TRIGGER_MAX bound. The distinctive marker sits at the front,
    // well inside the retained prefix, so a bounded surface still names it.
    const entry = { pad: `TRUNC_MARKER${'x'.repeat(600)}` };
    const raw = JSON.stringify(entry);
    expect(raw.length).toBeGreaterThan(512);
    // boundedSerialize (lib/runtime/service.js): raw.slice(0, 512) + '...[truncated]'.
    const expectedBounded = `${raw.slice(0, 512)}...[truncated]`;

    const built = await recordReceipt(dir, receipt(buildTicket, {
      tests: greenTest,
      evidence: { verdict: 'pass', risk_triggers: [entry] },
    }));
    expect(built.ok).toBe(true);

    // Warning channel: the offending entry is carried EXACTLY as the bounded
    // serialization — one element, truncated, nothing more (so the full raw
    // payload cannot ride along in this field).
    const warning = (built.warnings ?? []).find((w) => w.kind === 'malformed_risk_triggers');
    expect(warning).toBeTruthy();
    expect(warning.malformed_risk_triggers).toEqual([expectedBounded]);
    expect(warning.malformed_risk_triggers).not.toContain(raw);

    // Audit channel: same bounded serialization in the audit line's own field.
    const audit = await auditEntryFor(dir, 'malformed_risk_triggers', buildTicket.ticket_id);
    expect(audit).not.toBeNull();
    expect(audit.malformed_risk_triggers).toEqual([expectedBounded]);
    expect(audit.malformed_risk_triggers).not.toContain(raw);
  }, 30_000);
});

describe('unrecognized risk-trigger audit append is replay-safe on prepared-transaction crash-recovery (req 2)', () => {
  it('records exactly one overrides.ndjson audit line across a prepared-transaction replay while still surfacing the warning on the replay response', async () => {
    const dir = await project();
    const { buildTicket } = await walkToBuild(dir);
    const paths = runtimePaths(dir);

    // Snapshot the pre-receipt on-disk state (build stage, running, only the
    // test_writer receipt persisted). A crash BETWEEN the audit append and the
    // state persist leaves exactly this active.json alongside a 'prepared'
    // transaction — the shape the replay path is built to recover from.
    const preReceiptState = await readFile(paths.active, 'utf8');

    await writeFile(path.join(dir, 'src', 'value.js'), VALUE_V2);
    const UNKNOWN = 'nonexistent-risk-token';
    // ONE input object, reused for both the fresh admission and the replay, so
    // the durable transaction's input_hash matches byte-for-byte on replay.
    const input = receipt(buildTicket, {
      tests: greenTest,
      evidence: { verdict: 'pass', risk_triggers: [UNKNOWN] },
    });

    // Fresh admission: an unrecognized string token appends exactly one audit
    // line and surfaces the warning (this is already the shipped behavior).
    const first = await recordReceipt(dir, input);
    expect(first.ok).toBe(true);
    expect(JSON.stringify(first.warnings ?? null)).toContain(UNKNOWN);
    expect(await countAudit(dir, 'unrecognized_risk_triggers', buildTicket.ticket_id)).toBe(1);

    // Reconstruct the crash-recovery on-disk state: the receipt never reached
    // active.json (restore the pre-receipt snapshot) and the transaction is
    // still 'prepared'. Then re-drive recordReceipt with the identical input —
    // recordReceipt's prepared-transaction replay re-executes the surfacing
    // block.
    await writeFile(paths.active, preReceiptState);
    const txFile = receiptTransactionFile(dir, buildTicket.ticket_id);
    const tx = await readJson(txFile, null);
    expect(tx).not.toBeNull();
    await atomicWriteJson(txFile, { ...tx, status: 'prepared' });

    const replay = await recordReceipt(dir, input);
    expect(replay.ok).toBe(true);

    // Truthful response: the warning still fires on the replay path so the
    // caller still learns the token was seen.
    const replayWarnings = JSON.stringify(replay.warnings ?? replay.run?.warnings ?? null);
    expect(replayWarnings).toContain(UNKNOWN);

    // Replay-safe append: still exactly ONE audit line for this ticket. The
    // ungated re-run would make this two; the `if (!transaction)` gate keeps it
    // one while the warning above still fires.
    expect(await countAudit(dir, 'unrecognized_risk_triggers', buildTicket.ticket_id)).toBe(1);
  }, 30_000);

  it('records exactly one malformed_risk_triggers audit line across a prepared-transaction replay while still surfacing the malformed warning on the replay response', async () => {
    const dir = await project();
    const { buildTicket } = await walkToBuild(dir);
    const paths = runtimePaths(dir);

    // Snapshot the pre-receipt on-disk state (build stage, running, only the
    // test_writer receipt persisted) — the shape the replay path recovers from.
    const preReceiptState = await readFile(paths.active, 'utf8');

    await writeFile(path.join(dir, 'src', 'value.js'), VALUE_V2);
    const MARKER = 'replay-malformed-marker';
    // A non-string (malformed) entry, reused verbatim for the fresh admission and
    // the replay so the durable transaction's input_hash matches byte-for-byte.
    const input = receipt(buildTicket, {
      tests: greenTest,
      evidence: { verdict: 'pass', risk_triggers: [{ marker: MARKER }] },
    });

    // Fresh admission: the malformed entry appends exactly one audit line and
    // surfaces the warning.
    const first = await recordReceipt(dir, input);
    expect(first.ok).toBe(true);
    expect(JSON.stringify(first.warnings ?? null)).toContain(MARKER);
    expect(await countAudit(dir, 'malformed_risk_triggers', buildTicket.ticket_id)).toBe(1);

    // Reconstruct the crash-recovery on-disk state: the receipt never reached
    // active.json (restore the snapshot) and the transaction is still 'prepared'.
    // Then re-drive recordReceipt with the identical input — the
    // prepared-transaction replay re-executes the surfacing block.
    await writeFile(paths.active, preReceiptState);
    const txFile = receiptTransactionFile(dir, buildTicket.ticket_id);
    const tx = await readJson(txFile, null);
    expect(tx).not.toBeNull();
    await atomicWriteJson(txFile, { ...tx, status: 'prepared' });

    const replay = await recordReceipt(dir, input);
    expect(replay.ok).toBe(true);

    // Truthful response: the malformed warning still fires on the replay path.
    const replayWarnings = JSON.stringify(replay.warnings ?? replay.run?.warnings ?? null);
    expect(replayWarnings).toContain(MARKER);

    // Replay-safe append: still exactly ONE malformed_risk_triggers audit line —
    // the `if (!transaction)` gate covers the malformed append exactly as it
    // covers the unrecognized-string append above.
    expect(await countAudit(dir, 'malformed_risk_triggers', buildTicket.ticket_id)).toBe(1);
  }, 30_000);
});

describe('green contrast: unrecognized STRING-token surfacing already works today', () => {
  it('surfaces an unrecognized string token via a returned warning or an audit line (isolating the two hardening gaps above)', async () => {
    const dir = await project();
    const { buildTicket } = await walkToBuild(dir);
    await writeFile(path.join(dir, 'src', 'value.js'), VALUE_V2);
    const UNKNOWN = 'nonexistent-risk-token';

    const built = await recordReceipt(dir, receipt(buildTicket, {
      tests: greenTest,
      evidence: { verdict: 'pass', risk_triggers: [UNKNOWN] },
    }));

    expect(built.ok).toBe(true);
    const inWarnings = JSON.stringify(built.warnings ?? null).includes(UNKNOWN);
    const inAudit = (await auditRaw(dir)).includes(UNKNOWN);
    expect(inWarnings || inAudit).toBe(true);
    expect(built.run.high_risk).toBe(false);
    expect(built.run.risk_triggers ?? []).not.toContain(UNKNOWN);
  }, 30_000);
});
