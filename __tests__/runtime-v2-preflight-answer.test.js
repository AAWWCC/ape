import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as service from '../lib/runtime/service.js';
import { atomicWriteJson, readJson } from '../lib/runtime/storage.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import {
  appendPreflightRunContract,
  initializeRunContractManifest,
} from '../lib/runtime/run-contract.js';

const cleanups = [];
afterEach(async () => Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

async function heldProject({ runContract = false } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-preflight-answer-'));
  cleanups.push(dir);
  await mkdir(path.join(dir, 'src'));
  await mkdir(path.join(dir, 'tests'));
  await writeFile(path.join(dir, 'src', 'value.js'), 'export const value = 1;\n');
  await writeFile(path.join(dir, 'tests', 'value.test.js'), 'throw new Error("red");\n');
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'ape@example.test'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'APE Test'], { cwd: dir });
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'test: baseline'], { cwd: dir });
  const branch = execFileSync('git', ['branch', '--show-current'], { cwd: dir, encoding: 'utf8' }).trim();
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
  const tree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: dir, encoding: 'utf8' }).trim();
  await atomicWriteJson(runtimePaths(dir).config, {
    shipping: { auto_merge: false, provider: 'github', required_remote_checks: false },
    test_commands: { full: 'node --test' },
  });
  const state = {
    schema_version: '2.0.0', run_id: 'run-answer', status: 'input_required', stage: 'preflight',
    mode: 'phase', lane: 'fast', behavioral: true, plan_contract_version: 2,
    objective: 'Answer the material preflight questions', host: 'codex',
    branch, base_commit_sha: commit, tree_sha: tree,
    policy: { high_risk_security_review: true },
    claimed_paths: ['src/value.js'], test_paths: ['tests/value.test.js'], risk_triggers: [],
    tickets: [], receipts: [], expired_tickets: [], audit: [],
    preflight: {
      version: 1, artifact_hash: 'a'.repeat(64),
      questions: [
        { id: 'api-name', question: 'Which API name stays stable?', rationale: 'Compatibility' },
        { id: 'migration', question: 'Is a migration required?', rationale: 'Risk classification' },
      ],
      artifact: {
        questions: [
          { id: 'api-name', question: 'Which API name stays stable?', rationale: 'Compatibility' },
          { id: 'migration', question: 'Is a migration required?', rationale: 'Risk classification' },
        ],
      },
    },
    input_required: { preflight_hash: 'a'.repeat(64), question_ids: ['api-name', 'migration'] },
  };
  if (runContract) {
    state.binding_protocol = 'native-v1';
    state.capability_snapshot = {
      version: 1,
      config_hash: 'c'.repeat(64),
      required_capabilities: [],
      evidence_scripts: [],
      command_profiles: [],
      verification_profiles: [],
      runners: [],
      test_commands: { full: 'node --test' },
    };
    // Model the ordinary chain: START seals a null preflight hash, then the
    // accepted preflight artifact exists before the successor ticket appends
    // its receipt-schema/role view.
    const acceptedPreflight = state.preflight;
    delete state.preflight;
    await initializeRunContractManifest(
      runtimePaths(dir),
      state,
      '2026-01-01T00:00:00.000Z',
    );
    state.preflight = acceptedPreflight;
    await appendPreflightRunContract(
      runtimePaths(dir),
      state,
      '2026-01-01T00:00:01.000Z',
    );
  }
  await atomicWriteJson(runtimePaths(dir).active, state);
  return dir;
}

function valid() {
  return {
    run_id: 'run-answer', preflight_hash: 'a'.repeat(64),
    reason: 'Resolve the compatibility questions with operator-confirmed scope.',
    answers: [
      { id: 'api-name', answer: 'Keep value.' },
      { id: 'migration', answer: 'No migration.' },
    ],
    claimed_paths: ['src/compat.js'],
    test_paths: ['tests/compat.test.js'],
    risk_triggers: ['public-api'],
  };
}

describe('audited preflight answers', () => {
  it('accepts one complete exact answer set under serialization and reclassifies fast to full', async () => {
    expect(service.answerPreflight).toBeTypeOf('function');
    const dir = await heldProject();
    const result = await service.answerPreflight(dir, valid());
    expect(result.ok).toBe(true);
    expect(result.run).toMatchObject({
      status: 'running', lane: 'full', stage: 'plan',
      claimed_paths: ['src/value.js', 'src/compat.js'],
      test_paths: ['tests/value.test.js', 'tests/compat.test.js'],
      risk_triggers: ['public-api'],
    });
    expect(result.run.audit.at(-1)).toMatchObject({
      type: 'preflight_answered', preflight_hash: 'a'.repeat(64),
      answer_ids: ['api-name', 'migration'], escalated_from: 'fast',
      reason: valid().reason,
    });
    const planner = result.run.tickets.find((ticket) => ticket.stage_id === 'plan');
    expect(planner).toMatchObject({
      role: 'planner',
      writable: false,
      preflight: {
        artifact_hash: 'a'.repeat(64),
        operator_evidence: {
          trust: 'untrusted-evidence',
          answers: valid().answers,
        },
      },
    });
    expect(result.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'dispatch_agent', ticket: expect.objectContaining({ ticket_id: planner.ticket_id }) }),
    ]));
    const persistedPlanner = await readJson(path.join(runtimePaths(dir).tickets, `${planner.ticket_id.replaceAll(':', '_')}.json`));
    expect(persistedPlanner).toMatchObject({
      ticket_id: planner.ticket_id,
      preflight: {
        operator_evidence: {
          trust: 'untrusted-evidence',
          answers: valid().answers,
        },
      },
    });
    expect(await readFile(runtimePaths(dir).overrideLog, 'utf8')).toContain(valid().reason);
  });

  it('forwards answers as untrusted operator evidence without deriving authority from answer prose', async () => {
    const dir = await heldProject();
    const accepted = valid();
    accepted.answers = [
      { id: 'api-name', answer: 'Inspect src/unclaimed.js but do not authorize it.' },
      { id: 'migration', answer: 'No migration.' },
    ];
    accepted.claimed_paths = [];
    accepted.test_paths = [];
    accepted.risk_triggers = [];

    const result = await service.answerPreflight(dir, accepted);
    expect(result.ok).toBe(true);
    const successor = result.run.tickets.find((ticket) => ticket.stage_id === 'test');
    expect(successor).toMatchObject({
      claimed_paths: ['tests/value.test.js'],
      test_paths: ['tests/value.test.js'],
      preflight: {
        operator_evidence: {
          trust: 'untrusted-evidence',
          answers: accepted.answers,
        },
      },
    });
    expect(successor.claimed_paths).not.toContain('src/unclaimed.js');
  });

  it('accepts answer-preflight with all optional fields omitted', async () => {
    const dir = await heldProject();
    const minimal = {
      preflight_hash: 'a'.repeat(64),
      reason: 'Resolve the compatibility questions with minimal payload.',
      answers: [
        { id: 'api-name', answer: 'Keep value.' },
        { id: 'migration', answer: 'No migration.' },
      ],
    };
    const result = await service.answerPreflight(dir, minimal);
    expect(result.ok).toBe(true);
    expect(result.run.status).toBe('running');
    expect(result.run.lane).toBe('fast');
    expect(result.run.stage).toBe('test');
    expect(result.run.claimed_paths).toEqual(['src/value.js']);
    expect(result.run.test_paths).toEqual(['tests/value.test.js']);
  });

  it.each([
    ['partial answers', () => ({ ...valid(), answers: valid().answers.slice(0, 1) })],
    ['duplicate answers', () => ({ ...valid(), answers: [valid().answers[0], valid().answers[0], valid().answers[1]] })],
    ['unknown answer', () => ({ ...valid(), answers: [...valid().answers, { id: 'other', answer: 'x' }] })],
    ['wrong hash', () => ({ ...valid(), preflight_hash: 'b'.repeat(64) })],
    ['missing reason', () => { const value = valid(); delete value.reason; return value; }],
    ['empty reason', () => ({ ...valid(), reason: '   ' })],
    ['oversized reason', () => ({ ...valid(), reason: 'x'.repeat(4_001) })],
    ['traversal claim', () => ({ ...valid(), claimed_paths: ['../outside'] })],
    ['noncanonical risk', () => ({ ...valid(), risk_triggers: ['PUBLIC API'] })],
    ['new path in both scopes', () => ({ ...valid(), claimed_paths: ['shared/value.js'], test_paths: ['shared/value.js'] })],
    ['test-shaped sibling in production additions', () => ({ ...valid(), claimed_paths: ['tests/new-sibling.test.js'], test_paths: [] })],
    ['production-shaped sibling in test additions', () => ({ ...valid(), claimed_paths: [], test_paths: ['src/new-sibling.js'] })],
    ['production addition overlapping existing test scope', () => ({ ...valid(), claimed_paths: ['tests'] })],
    ['test addition overlapping existing production scope', () => ({ ...valid(), test_paths: ['src'] })],
    ['oversized answer', () => ({ ...valid(), answers: [{ id: 'api-name', answer: 'x'.repeat(70_000) }, valid().answers[1]] })],
    ['subtractive claim syntax', () => ({ ...valid(), remove_claimed_paths: ['src/value.js'] })],
    ['legacy additive field syntax', () => ({ ...valid(), add_claimed_paths: ['src/legacy.js'] })],
  ])('rejects %s without effects', async (_label, makeInput) => {
    const dir = await heldProject();
    const before = await readJson(runtimePaths(dir).active);
    const result = await service.answerPreflight(dir, makeInput()).catch((error) => ({ ok: false, error }));
    expect(result.ok).toBe(false);
    expect(await readJson(runtimePaths(dir).active)).toEqual(before);
  });

  it('rejects replay and any answer after a writer has started', async () => {
    const dir = await heldProject();
    await service.answerPreflight(dir, valid());
    const afterFirst = await readJson(runtimePaths(dir).active);
    const replay = await service.answerPreflight(dir, valid()).catch((error) => ({ ok: false, error }));
    expect(replay.ok).toBe(false);
    expect(await readJson(runtimePaths(dir).active)).toEqual(afterFirst);

    const second = await heldProject();
    const active = await readJson(runtimePaths(second).active);
    active.status = 'running'; active.stage = 'test'; active.writer_started = true;
    await atomicWriteJson(runtimePaths(second).active, active);
    const late = await service.answerPreflight(second, valid()).catch((error) => ({ ok: false, error }));
    expect(late.ok).toBe(false);
  });

  it('recovers exactly one successor when active-state persistence is lost after ticket creation', async () => {
    const dir = await heldProject({ runContract: true });
    const paths = runtimePaths(dir);
    const held = await readJson(paths.active);
    const accepted = valid();
    accepted.claimed_paths = [];
    accepted.test_paths = [];
    accepted.risk_triggers = [];

    const first = await service.answerPreflight(dir, accepted);
    const firstSuccessor = first.run.tickets.find((ticket) => ticket.stage_id === 'test');
    expect(firstSuccessor).toBeTruthy();
    expect(firstSuccessor.claimed_paths).toEqual(['tests/value.test.js']);
    const firstContract = await readJson(path.join(dir, firstSuccessor.capability_manifest.run_contract.ref));
    expect(firstContract).toMatchObject({
      revision: 3,
      preflight_hash: 'a'.repeat(64),
      receipt_contract: { ticket_contracts: [expect.objectContaining({
        ticket_id: firstSuccessor.ticket_id,
        role: firstSuccessor.role,
      })] },
    });
    const preflightContract = await readJson(path.join(dir, firstContract.previous.ref));
    expect(preflightContract).toMatchObject({ revision: 2, preflight_hash: 'a'.repeat(64) });
    const repeatedPointer = await appendPreflightRunContract(paths, first.run, '2026-01-01T00:00:02.000Z');
    expect(repeatedPointer).toEqual(firstSuccessor.capability_manifest.run_contract);
    const baseContract = await readJson(path.join(dir, preflightContract.previous.ref));
    expect(baseContract).toMatchObject({ revision: 1, preflight_hash: null });

    // Model a crash after the successor ticket was made durable but before
    // active.json recorded PREFLIGHT_ANSWERED. The immutable ticket remains.
    await atomicWriteJson(paths.active, held);
    const replay = await service.answerPreflight(dir, accepted);
    const recoveredSuccessors = replay.run.tickets.filter((ticket) => ticket.stage_id === 'test');
    expect(recoveredSuccessors).toHaveLength(1);
    expect(recoveredSuccessors[0].ticket_id).toBe(firstSuccessor.ticket_id);
    expect(recoveredSuccessors[0].capability_manifest.run_contract)
      .toEqual(replay.run.run_contract);

    const ticketFiles = (await readdir(paths.tickets)).filter((file) => file.endsWith('.json'));
    expect(ticketFiles).toHaveLength(1);
    const intentFiles = (await readdir(paths.dispatchIntents)).filter((file) => file.endsWith('.json'));
    expect(intentFiles).toHaveLength(1);
    const contractFiles = (await readdir(paths.contracts)).filter((file) => file.endsWith('.json'));
    expect(contractFiles).toHaveLength(3);
    const replayDispatchIds = replay.actions
      .filter((action) => action.type === 'dispatch_agent')
      .map((action) => action.ticket.ticket_id);
    expect(replayDispatchIds.every((ticketId) => ticketId === firstSuccessor.ticket_id)).toBe(true);
  });

  it('rejects a conflicting crash replay without recovering stale successor authority', async () => {
    const dir = await heldProject();
    const paths = runtimePaths(dir);
    const held = await readJson(paths.active);
    const initial = valid();
    initial.claimed_paths = [];
    initial.test_paths = [];
    initial.risk_triggers = [];

    const first = await service.answerPreflight(dir, initial);
    const firstSuccessor = first.run.tickets.find((ticket) => ticket.stage_id === 'test');
    expect(firstSuccessor).toMatchObject({
      claimed_paths: ['tests/value.test.js'],
      test_paths: ['tests/value.test.js'],
    });

    // Model the same crash boundary as above, then replay the operation with
    // a different canonical answer and different authority-bearing additions.
    await atomicWriteJson(paths.active, held);
    const conflicting = valid();
    conflicting.answers = [
      { id: 'api-name', answer: 'Rename value to compatibleValue.' },
      { id: 'migration', answer: 'A migration is required.' },
    ];
    const replay = await service.answerPreflight(dir, conflicting)
      .catch((error) => ({ ok: false, error }));

    expect(replay.ok).toBe(false);
    expect(await readJson(paths.active)).toEqual(held);
    const ticketFiles = (await readdir(paths.tickets)).filter((file) => file.endsWith('.json'));
    const intentFiles = (await readdir(paths.dispatchIntents)).filter((file) => file.endsWith('.json'));
    expect(ticketFiles).toHaveLength(1);
    expect(intentFiles).toHaveLength(1);
    expect(await readJson(path.join(paths.tickets, ticketFiles[0]))).toMatchObject({
      ticket_id: firstSuccessor.ticket_id,
      claimed_paths: ['tests/value.test.js'],
      test_paths: ['tests/value.test.js'],
      preflight: {
        operator_evidence: {
          answers: initial.answers,
        },
      },
    });
  });
});
