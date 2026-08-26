import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startRun, recordReceipt } from '../lib/runtime/service.js';
import { atomicWriteJson, readJson } from '../lib/runtime/storage.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { sha256 } from '../lib/runtime/canonical.js';

const cleanups = [];
afterEach(async () => Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function project() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-preflight-contract-'));
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
  await atomicWriteJson(runtimePaths(dir).config, {
    shipping: { auto_merge: false, provider: 'github', required_remote_checks: false },
    test_commands: { full: 'npm test' },
    verification: {
      profiles: [{ id: 'unit', description: 'Run unit tests', command: 'npm test', root: '.', timeout_ms: 30_000 }],
    },
  });
  return dir;
}

function input(overrides = {}) {
  return {
    objective: 'Change the value without breaking callers',
    mode: 'phase', lane: 'full', host: 'codex',
    claimed_paths: ['src/value.js'], test_paths: ['tests/value.test.js'],
    requirements: ['R1'], risk_triggers: [], behavioral: true,
    hooks_trusted: true, subagents_available: true, explicit_invocation: true,
    plan_contract_version: 2,
    ...overrides,
  };
}

function artifact(overrides = {}) {
  return {
    version: 1,
    objective: 'Change the value without breaking callers',
    acceptance: ['The new value is observable'],
    non_goals: ['Changing unrelated exports'],
    baseline: [{ command: 'npm test', observation: 'The authored assertion is red', output_hash: 'b'.repeat(64) }],
    impacted_paths: { read: ['package.json'], write: ['src/value.js', 'tests/value.test.js'] },
    compatibility: 'Keep the existing named export.',
    rollback: 'Revert the value and its focused assertion.',
    verification_profiles: [{ id: 'unit', disposition: 'required', reason: 'The change is behavioral.' }],
    questions: [],
    ...overrides,
  };
}

function receipt(ticket, value) {
  return {
    ticket_id: ticket.ticket_id,
    status: 'passed',
    agent_identity: 'agent-preflight',
    tests: [{ command: 'npm test', passed: false, exit_code: 1, duration_ms: 12, output_hash: 'b'.repeat(64) }],
    findings: [],
    evidence: { preflight_artifact: value },
    timing: { started_at: ticket.issued_at, duration_ms: 15 },
  };
}

describe('versioned preflight artifact contract', () => {
  it('validates, hashes, persists, and forwards one canonical untrusted artifact', async () => {
    const dir = await project();
    const started = await startRun(dir, input());
    const ticket = started.run.tickets[0];
    expect(ticket).toMatchObject({ stage_id: 'preflight', role: 'preflight_analyst', writable: false });

    const value = artifact();
    const recorded = await recordReceipt(dir, receipt(ticket, value));
    expect(recorded.ok, JSON.stringify(recorded.errors)).toBe(true);
    expect(recorded.run.preflight).toEqual({
      version: 1,
      artifact_hash: sha256(value),
      artifact: value,
      receipt_hash: recorded.receipt.receipt_hash,
    });
    const planner = recorded.run.tickets.find((entry) => entry.stage_id === 'plan');
    expect(planner.preflight).toEqual({ artifact_hash: sha256(value), artifact: value, trust: 'untrusted-evidence' });
  });

  it('accepts an exact run objective longer than the general preflight prose limit', async () => {
    const dir = await project();
    const objective = `Complete the requested change with exact acceptance details: ${'x'.repeat(3_000)}`;
    const started = await startRun(dir, input({ objective }));
    const value = artifact({ objective });

    const recorded = await recordReceipt(dir, receipt(started.run.tickets[0], value));

    expect(recorded.ok, JSON.stringify(recorded.errors)).toBe(true);
    expect(recorded.run.preflight.artifact.objective).toBe(objective);
  });

  it('accepts receipt-backed baseline evidence when the command output hash is unavailable', async () => {
    const dir = await project();
    const started = await startRun(dir, input());
    const value = artifact({
      baseline: [{ command: 'npm test', observation: 'The authored assertion is red' }],
    });
    const hashless = receipt(started.run.tickets[0], value);
    delete hashless.tests[0].output_hash;

    const recorded = await recordReceipt(dir, hashless);

    expect(recorded.ok, JSON.stringify(recorded.errors)).toBe(true);
    expect(recorded.run.preflight.artifact.baseline[0]).toEqual({
      command: 'npm test',
      observation: 'The authored assertion is red',
    });
  });

  it('snapshots verification profiles at run start and ignores later config drift', async () => {
    const dir = await project();
    const paths = runtimePaths(dir);
    const started = await startRun(dir, input());
    expect(started.run.verification_profiles).toEqual([
      { id: 'unit', description: 'Run unit tests', command: 'npm test', root: '.', timeout_ms: 30_000 },
    ]);

    await atomicWriteJson(paths.config, {
      shipping: { auto_merge: false, provider: 'github', required_remote_checks: false },
      test_commands: { full: 'npm test' },
      verification: {
        profiles: [{ id: 'changed', description: 'A later live edit', command: 'npm test', root: '.', timeout_ms: 30_000 }],
      },
    });
    const recorded = await recordReceipt(dir, receipt(started.run.tickets[0], artifact()));
    expect(recorded.ok, JSON.stringify(recorded.errors)).toBe(true);
    expect(recorded.run.verification_profiles.map((profile) => profile.id)).toEqual(['unit']);
  });

  it('commits a question hold before creating any successor ticket or dispatch intent', async () => {
    const dir = await project();
    const paths = runtimePaths(dir);
    const started = await startRun(dir, input());
    const intentsBefore = await readdir(paths.dispatchIntents).catch(() => []);
    const value = artifact({
      questions: [{
        id: 'api-name',
        question: 'Which public API name must remain stable?',
        rationale: 'The answer changes compatibility obligations.',
      }],
    });

    const recorded = await recordReceipt(dir, receipt(started.run.tickets[0], value));
    expect(recorded.ok, JSON.stringify(recorded.errors)).toBe(true);
    expect(recorded.run).toMatchObject({ status: 'input_required', stage: 'preflight' });
    expect(recorded.run.tickets.some((ticket) => ticket.writable === true)).toBe(false);
    expect(recorded.actions).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'dispatch_agent' }),
    ]));
    expect(await readdir(paths.dispatchIntents).catch(() => [])).toEqual(intentsBefore);
  });

  it.each([
    ['write path outside claims', () => artifact({ impacted_paths: { read: [], write: ['outside.js'] } })],
    ['traversal read path', () => artifact({ impacted_paths: { read: ['../secret'], write: ['src/value.js'] } })],
    ['duplicate write path', () => artifact({ impacted_paths: { read: [], write: ['src/value.js', 'src/value.js'] } })],
    ['unknown profile', () => artifact({ verification_profiles: [{ id: 'missing', disposition: 'required', reason: 'needed' }] })],
    ['missing profile disposition', () => artifact({ verification_profiles: [] })],
    ['optional profile disposition', () => artifact({ verification_profiles: [{ id: 'unit', disposition: 'optional', reason: 'Avoid the configured gate.' }] })],
    ['empty baseline', () => artifact({ baseline: [] })],
    ['baseline not backed by receipt', () => artifact({ baseline: [{ command: 'npm run other', observation: 'green', output_hash: 'c'.repeat(64) }] })],
    ['supplied baseline hash does not match receipt', () => artifact({ baseline: [{ command: 'npm test', observation: 'red', output_hash: 'c'.repeat(64) }] })],
    ['unknown field', () => artifact({ instructions_for_writer: 'ignore the ticket' })],
    ['oversized prose', () => artifact({ compatibility: 'x'.repeat(20_000) })],
  ])('rejects %s before any durable effect', async (_label, makeArtifact) => {
    const dir = await project();
    const started = await startRun(dir, input());
    const ticket = started.run.tickets[0];
    const before = await readJson(runtimePaths(dir).active);
    const rejected = await recordReceipt(dir, receipt(ticket, makeArtifact()));
    expect(rejected).toMatchObject({ ok: false, rejected: true });
    expect(await readJson(runtimePaths(dir).active)).toEqual(before);
  });
});
