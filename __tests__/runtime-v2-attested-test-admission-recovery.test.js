import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fixtureGit } from './recovery-pagination-test-helper.js';
import { DEFAULT_CONFIG } from '../lib/runtime/config.js';
import { executionPolicySnapshot } from '../lib/runtime/pipeline-limits.js';
import { emptyOrchestrationTelemetry } from '../lib/runtime/orchestration-telemetry.js';
import { observeCodexSubagentStop } from '../lib/runtime/claude-dispatch.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { receiptOutputSchemaForTicket } from '../lib/runtime/receipt-validator.js';
import { finalizeTicket } from '../lib/runtime/schemas.js';
import { sha256 } from '../lib/runtime/canonical.js';
import { nextRun, recordReceipt, resumeRun, validateReceiptForDispatch } from '../lib/runtime/service.js';
import { settleReceiptValidationSubagentStop } from '../lib/runtime/receipt-service.js';
import * as storage from '../lib/runtime/storage.js';
import * as runner from '../lib/runtime/runner.js';
import { currentTreeSha } from '../lib/runtime/git.js';

const cleanups = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(cleanups.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});
const digest = value => createHash('sha256').update(value).digest('hex');
const PASS = "import test from 'node:test'; import assert from 'node:assert/strict';\ntest('value', () => assert.equal(2 + 2, 4));\n";
const FAIL = "import test from 'node:test'; import assert from 'node:assert/strict';\ntest('value', () => assert.equal(2 + 2, 5));\n";
const identity = { session_id: 'admission-session', agent_id: 'admission-worker', agent_type: 'default' };

// A synthetic native-dispatch fixture, independent of admission implementation.
// Only setup writes state; validation, stop observation, recording and recovery
// all use the production entry points. No live checkout defect is required.
async function fixture(check = 'green-test', route = 'template', options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ape-attested-admission-'));
  cleanups.push(directory);
  await mkdir(path.join(directory, 'tests'));
  await writeFile(path.join(directory, 'tests/value.test.js'), options.baseline ?? '// incoming baseline\n');
  fixtureGit(directory, ['init', '-q']);
  fixtureGit(directory, ['config', 'user.email', 'ape@example.test']);
  fixtureGit(directory, ['config', 'user.name', 'APE Test']);
  fixtureGit(directory, ['add', '.']);
  fixtureGit(directory, ['commit', '-qm', 'fixture baseline']);
  const baseBranch = fixtureGit(directory, ['branch', '--show-current']);
  fixtureGit(directory, ['switch', '-qc', 'ape/admission-fixture']);
  const committedTree = fixtureGit(directory, ['rev-parse', 'HEAD^{tree}']);
  if (options.inherited) await writeFile(path.join(directory, 'tests/value.test.js'), PASS);
  const baseTree = options.inherited ? await currentTreeSha(directory) : committedTree;
  const paths = runtimePaths(directory);
  const policy = executionPolicySnapshot(DEFAULT_CONFIG);
  const commands = route === 'derived' ? { full: 'node --test' }
    : { full: 'node --test', targeted_template: 'node --test {paths}' };
  await storage.atomicWriteJson(paths.config, {
    shipping: { auto_merge: false, provider: 'github', required_remote_checks: false },
    test_commands: commands,
    ...(route === 'runners' ? { runners: [{ id: 'node', owns: ['tests/**'], root: '.',
      profile: { targeted_template: 'node --test {paths}' } }] } : {}),
    ...options.config,
  });
  const runId = 'run-attested-admission';
  const capability = 'synthetic-admission-capability-1234567890';
  const objective = 'Cover attested authored-test admission recovery';
  const testPaths = ['tests/value.test.js'];
  const base = {
    schema_version: '2.0.0', ticket_id: `${runId}:test:1`, run_id: runId,
    stage_id: 'test', parallel_group: null, role: 'test_writer', objective,
    claimed_paths: testPaths, test_paths: testPaths, risk_triggers: [],
    test_intent: check === 'green-test' ? 'green-maintenance' : 'red-first',
    model_tier: 'balanced', model: { model: 'gpt-5.4', reasoning_effort: 'medium' },
    deadline_at: null, required_checks: [check], writable: true, base_tree_sha: baseTree,
    parent_hash: null, attempt: 1, issued_at: new Date().toISOString(),
    receipt_contract_version: 1, execution_limits: policy.limits,
    capability_manifest: { allowed_evidence_commands: [], verification_profiles: [],
      preflight_hash: null, risk_triggers: [], design_assurance_required: false },
  };
  const outputSchema = receiptOutputSchemaForTicket(base);
  const ticket = finalizeTicket({ ...base, output_schema: outputSchema, capability_manifest: {
    version: 1, config_hash: 'c'.repeat(64), required_capabilities: [],
    allowed_evidence_commands: [], command_profiles: [], verification_profiles: [],
    objective_hash: sha256(objective), preflight_hash: null, risk_triggers: [],
    design_assurance_required: false,
    receipt_schema: { ref: 'ticket.output_schema', hash: sha256(outputSchema) },
    field_bounds: { corrections_per_validation: 20 },
    byte_budgets: { candidate_plan_utf8_bytes: 16384, preflight_artifact_utf8_bytes: 65536,
      mcp_projection_utf8_bytes: 48000 },
  } });
  const created = new Date(Date.now() - 1000).toISOString();
  const predecessor = options.inherited ? finalizeTicket({ ...ticket,
    ticket_id: `${runId}:test:predecessor`, base_tree_sha: committedTree }) : null;
  const state = {
    run_id: runId, status: 'running', stage: 'test', host: 'codex', binding_protocol: 'native-v1',
    objective, mode: 'phase', lane: 'fast', execution_policy: policy, test_intent: base.test_intent,
    behavioral: true, claimed_paths: testPaths, test_paths: testPaths, requirements: [], risk_triggers: [],
    tickets: predecessor ? [predecessor, ticket] : [ticket], receipts: [],
    expired_tickets: predecessor ? [predecessor.ticket_id] : [], attempts: {}, remediation_cycles: 0,
    tree_sha: baseTree, branch: 'ape/admission-fixture', base_branch: baseBranch,
    base_commit_sha: fixtureGit(directory, ['rev-parse', 'HEAD']),
    orchestration: emptyOrchestrationTelemetry(), created_at: created, updated_at: created,
  };
  await storage.atomicWriteJson(paths.active, state);
  await storage.atomicWriteJson(path.join(paths.runs, `${runId}.json`), state);
  const intentFile = path.join(paths.dispatchIntents, `${digest(ticket.ticket_id)}.json`);
  await storage.atomicWriteJson(intentFile, {
    version: 2, host: 'codex', run_id: runId, ticket_id: ticket.ticket_id, ticket_hash: ticket.ticket_hash,
    agent_type: 'test_writer', parent_session_id: identity.session_id, tool_use_id: 'spawn-admission',
    requested_model: ticket.model.model, binding_agent_type: 'default', bound_session_id: identity.session_id,
    launch_name_hash: digest('admission-launch'), status: 'bound', bound_agent_id: identity.agent_id,
    capability_hash: digest(capability), prepared_at: created, launched_at: created,
    launch_expires_at: new Date(Date.parse(created) + 60000).toISOString(), bound_at: created,
    expires_at: null, execution_policy_version: policy.version, launch_attempts: 1,
    physical_worker_dispatches: 1, receipt_limits: policy.limits,
  });
  const draft = { ticket_id: ticket.ticket_id, status: 'passed', tests: [], findings: [],
    evidence: { summary: 'Authored-test receipt' }, receipt_capability: capability };
  return { directory, paths, ticket, state, draft, intentFile };
}

async function attest(value, stop = true) {
  expect(await validateReceiptForDispatch(value.directory, value.draft, value.ticket.ticket_id))
    .toMatchObject({ valid: true, attested: true });
  if (stop) expect(await observeCodexSubagentStop(value.paths,
    await storage.readJson(value.paths.active), identity)).toMatchObject({ observed: true });
}

async function assertNoAdmission(value) {
  const state = await storage.readJson(value.paths.active);
  expect(state.receipts).toEqual([]);
  expect(state.tickets).toEqual(value.state.tickets);
  expect(state.gates ?? []).toEqual([]);
  expect(await readdir(value.paths.receipts).catch(() => [])).toEqual([]);
  expect(await readdir(value.paths.receiptTransactions).catch(() => [])).toEqual([]);
  expect((await storage.readJson(value.intentFile)).physical_worker_dispatches).toBe(1);
  return state;
}

async function assertDurableRefusal(value) {
  const state = await assertNoAdmission(value);
  expect(state.status).toBe('blocked');
  expect(state.input_required?.kind).not.toBe('receipt_retry');
  const immutableIntent = await storage.readJson(value.intentFile);
  for (const advance of [nextRun, resumeRun, nextRun, resumeRun]) {
    // Each call reloads disk state: no in-memory outcome is carried across calls.
    const response = await advance(value.directory);
    expect(response.next_action?.required_control_action).not.toBe('record_exact_attested_receipt');
    expect(response.actions ?? []).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'dispatch_agent' }),
    ]));
    expect((await assertNoAdmission(value)).status).toBe('blocked');
  }
  expect(await storage.readJson(value.intentFile)).toEqual(immutableIntent);
  return state;
}

describe('attested authored-test admission recovery', () => {
  it.each(['green-test', 'red-test', 'test-correction'].flatMap(check =>
    ['template', 'derived', 'runners'].map(route => ({ check, route }))))(
    'durably refuses unchanged $check through $route after its exact-attested worker stops',
    async ({ check, route }) => {
      const value = await fixture(check, route);
      await attest(value);
      const attestation = await readFile(value.intentFile, 'utf8');
      // Before admission is attempted, the stopped worker still owns this exact draft.
      expect(await nextRun(value.directory)).toMatchObject({ next_action: {
        required_control_action: 'record_exact_attested_receipt', ticket_id: value.ticket.ticket_id,
      } });
      const refused = await recordReceipt(value.directory, value.draft);
      expect(refused).toMatchObject({ ok: false, rejected: true });
      expect(refused.errors.join(' ')).toMatch(/no runtime-verifiable authored test files/);
      await assertDurableRefusal(value);
      for (let i = 0; i < 2; i += 1) {
        expect(await recordReceipt(value.directory, structuredClone(value.draft)))
          .toMatchObject({ ok: false, rejected: true });
        await assertDurableRefusal(value);
      }
      expect(await readFile(value.intentFile, 'utf8')).toBe(attestation);
    }, 30000);

  it('reconciles a legacy exact-receipt retry hold without rewriting its draft', async () => {
    const value = await fixture();
    await attest(value);
    const state = await storage.readJson(value.paths.active);
    await storage.atomicWriteJson(value.paths.active, { ...state, status: 'input_required', stage: 'input_required',
      input_required: { kind: 'receipt_retry', ticket_id: value.ticket.ticket_id,
        resume_status: 'running', resume_stage: 'test' } });
    expect(await recordReceipt(value.directory, value.draft)).toMatchObject({ ok: false, rejected: true });
    await assertDurableRefusal(value);
    await settleReceiptValidationSubagentStop(value.directory);
    await assertDurableRefusal(value);
  });

  it('serializes concurrent record/next/resume without admitting or replacing a refused worker', async () => {
    const value = await fixture();
    await attest(value);
    await Promise.all([recordReceipt(value.directory, value.draft), nextRun(value.directory),
      resumeRun(value.directory), recordReceipt(value.directory, structuredClone(value.draft))]);
    await assertDurableRefusal(value);
  }, 30000);

  it('does not attribute an expired predecessor\'s uncommitted tests to its replacement', async () => {
    const value = await fixture('green-test', 'template', { inherited: true });
    await attest(value);
    const before = await readFile(path.join(value.directory, 'tests/value.test.js'), 'utf8');
    const response = await recordReceipt(value.directory, value.draft);
    expect(response).toMatchObject({ ok: false, rejected: true });
    expect(response.errors.join(' ')).toMatch(/no runtime-verifiable authored test files/);
    await assertDurableRefusal(value);
    expect(await readFile(path.join(value.directory, 'tests/value.test.js'), 'utf8')).toBe(before);
  });

  it('never replaces a still-live attested writer after deterministic refusal', async () => {
    const value = await fixture();
    await attest(value, false);
    expect(await recordReceipt(value.directory, value.draft)).toMatchObject({ ok: false, rejected: true });
    await assertDurableRefusal(value);
    expect((await storage.readJson(value.intentFile)).agent_stopped_at).toBeUndefined();
  });

  it.each(['before', 'after'])('recovers a crash %s authoritative refusal publication', async position => {
    const value = await fixture();
    await attest(value);
    const write = storage.atomicWriteJson;
    let injected = false;
    vi.spyOn(storage, 'atomicWriteJson').mockImplementation(async (file, body, ...rest) => {
      if (!injected && file === value.paths.active && body.status === 'blocked') {
        injected = true;
        if (position === 'after') await write(file, body, ...rest);
        throw new Error('synthetic crash at refusal publication');
      }
      return write(file, body, ...rest);
    });
    await recordReceipt(value.directory, value.draft).catch(() => null);
    expect(injected).toBe(true);
    vi.restoreAllMocks();
    expect(await recordReceipt(value.directory, structuredClone(value.draft)))
      .toMatchObject({ ok: false, rejected: true });
    await assertDurableRefusal(value);
  });

  it.each(['timeout', 'cancelled', 'tooling'])('keeps %s execution failure retryable with the exact receipt', async fault => {
    const value = await fixture();
    await writeFile(path.join(value.directory, 'tests/value.test.js'), PASS);
    await attest(value);
    const execution = vi.spyOn(runner, 'runTestSuite').mockResolvedValueOnce({
      passed: false, exit_code: fault === 'timeout' ? 1 : null, duration_ms: 1,
      timed_out: fault === 'timeout', tooling_failure: fault === 'tooling',
      output: 'synthetic runner failure',
    });
    const response = await recordReceipt(value.directory, value.draft);
    expect(response).toMatchObject({ ok: false, rejected: true });
    expect(execution).toHaveBeenCalledTimes(1);
    execution.mockRestore();
    expect((await assertNoAdmission(value)).status).not.toBe('blocked');
    expect(await nextRun(value.directory)).toMatchObject({ next_action: {
      required_control_action: 'record_exact_attested_receipt', ticket_id: value.ticket.ticket_id,
    } });
    const admitted = await recordReceipt(value.directory, structuredClone(value.draft));
    expect(admitted.ok, JSON.stringify(admitted.errors)).toBe(true);
    expect(admitted.receipt.evidence.green_test).toMatchObject({ observed: true, passed: true });
  }, 30000);

  it.each(['green-test', 'red-test', 'test-correction'])('durably refuses nondeterministic %s', async check => {
    const value = await fixture(check);
    await writeFile(path.join(value.directory, 'tests/value.test.js'),
      "import test from 'node:test'; import assert from 'node:assert/strict';\n" +
      "import { existsSync, writeFileSync } from 'node:fs';\n" +
      "test('stable value', () => { const prior = existsSync('.admission-toggle'); writeFileSync('.admission-toggle', '1'); assert.equal(prior, false); });\n");
    await attest(value);
    const refused = await recordReceipt(value.directory, value.draft);
    expect(refused).toMatchObject({ ok: false, rejected: true });
    expect(refused.errors.join(' ')).toMatch(/nondeterministic/);
    await assertDurableRefusal(value);
  }, 30000);

  it.each(['green-test', 'red-test'].flatMap(check => ['template', 'runners'].map(route => ({ check, route }))))(
    'persists wrong stable verdict for $check via $route', async ({ check, route }) => {
      const value = await fixture(check, route);
      await writeFile(path.join(value.directory, 'tests/value.test.js'), check === 'green-test' ? FAIL : PASS);
      await attest(value);
      const refused = await recordReceipt(value.directory, value.draft);
      expect(refused).toMatchObject({ ok: false, rejected: true });
      expect(refused.errors.join(' ')).toMatch(check === 'green-test' ? /failed twice/ : /red-test passed/);
      await assertDurableRefusal(value);
    }, 30000);

  it.each(['template', 'runners'])('keeps malformed %s routing actionable without accepting evidence', async route => {
    const value = await fixture('green-test', route, { config: route === 'template'
      ? { test_commands: { full: 'node --test', targeted_template: 'node --test' } }
      : { runners: [{ id: 'orphan', owns: ['other/**'], root: '.', profile: { targeted_template: 'node --test {paths}' } }] } });
    await writeFile(path.join(value.directory, 'tests/value.test.js'), PASS);
    await attest(value);
    const refused = await recordReceipt(value.directory, value.draft);
    expect(refused).toMatchObject({ ok: false, rejected: true });
    expect(refused.errors.join(' ')).toMatch(/placeholder|owned by no configured runner/);
    await assertDurableRefusal(value);
  });

  it.each(['capability', 'draft', 'ticket', 'worker'])('does not durably refuse unauthenticated %s input', async fault => {
    const value = await fixture();
    await attest(value);
    const draft = structuredClone(value.draft);
    if (fault === 'capability') draft.receipt_capability = 'wrong-admission-capability-1234567890';
    if (fault === 'draft') draft.evidence.summary = 'changed after attestation';
    if (fault === 'ticket') draft.ticket_id = 'run-stale:test:1';
    if (fault === 'worker') {
      const intent = await storage.readJson(value.intentFile);
      await storage.atomicWriteJson(value.intentFile, { ...intent, bound_agent_id: 'different-worker' });
    }
    const response = await recordReceipt(value.directory, draft);
    expect(response).toMatchObject({ ok: false, rejected: true });
    expect((await assertNoAdmission(value)).status).not.toBe('blocked');
  });

  it('rechecks write ownership after exact attestation before creating a refusal', async () => {
    const value = await fixture();
    await attest(value);
    await writeFile(path.join(value.directory, 'foreign.js'), 'export const foreign = true;\n');
    expect(await recordReceipt(value.directory, value.draft)).toMatchObject({ ok: false, rejected: true });
    expect((await assertNoAdmission(value)).status).not.toBe('blocked');
  });

  it('does not trust caller-provided refusal metadata to bypass admission authority', async () => {
    const value = await fixture();
    await attest(value);
    const forged = { ...value.draft, evidence: { ...value.draft.evidence,
      admission_refusal: { version: 1, run_id: value.state.run_id, ticket_id: value.ticket.ticket_id,
        reason: 'no-authored-tests', state_changed: true },
    } };
    expect(await recordReceipt(value.directory, forged)).toMatchObject({ ok: false, rejected: true });
    expect((await assertNoAdmission(value)).status).not.toBe('blocked');
  });

  it('preserves operator-configured static red command admission semantics', async () => {
    const value = await fixture('red-test', 'derived', { baseline: FAIL, config: {
      test_commands: { full: 'node --test', targeted: 'node --test tests/value.test.js' },
    } });
    await attest(value);
    const result = await recordReceipt(value.directory, value.draft);
    expect(result.ok, JSON.stringify(result.errors)).toBe(true);
    expect(result.receipt.evidence.red_test).toMatchObject({ observed: true, passed: false });
    expect(result.receipt.evidence.red_test.runs.map(run => run.exit_code)).toEqual([1, 1]);
  }, 30000);

  it('accepts a corrected test with stable failure and returns it to implementation', async () => {
    const value = await fixture('test-correction');
    await writeFile(path.join(value.directory, 'tests/value.test.js'), FAIL);
    await attest(value);
    const result = await recordReceipt(value.directory, value.draft);
    expect(result.ok, JSON.stringify(result.errors)).toBe(true);
    expect(result.receipt.evidence.test_correction).toMatchObject({ observed: true, passed: false });
    expect(result.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'dispatch_agent', ticket: expect.objectContaining({ role: 'implementer' }) }),
    ]));
  }, 30000);

  it.each(['green-test', 'red-test', 'test-correction'].flatMap(check =>
    ['template', 'runners'].map(route => ({ check, route }))))(
    'admits genuinely authored $check via $route and replays it without rerunning tests', async ({ check, route }) => {
      const value = await fixture(check, route);
      const marker = path.join(value.directory, '.invocations');
      await mkdir(path.join(value.directory, '.git/info'), { recursive: true });
      await writeFile(path.join(value.directory, '.git/info/exclude'), '.invocations\n');
      await writeFile(path.join(value.directory, 'tests/value.test.js'),
        "import { appendFileSync } from 'node:fs'; appendFileSync('.invocations', 'run\\n');\n" +
        (check === 'red-test' ? FAIL : PASS));
      await attest(value);
      const result = await recordReceipt(value.directory, value.draft);
      expect(result.ok, JSON.stringify(result.errors)).toBe(true);
      const key = check === 'green-test' ? 'green_test' : check === 'red-test' ? 'red_test' : 'test_correction';
      expect(result.receipt.evidence[key]).toMatchObject({ observed: true });
      expect(await readFile(marker, 'utf8')).toBe('run\nrun\n');
      const replay = await recordReceipt(value.directory, structuredClone(value.draft));
      expect(replay.ok, JSON.stringify(replay.errors)).toBe(true);
      expect(replay.receipt.receipt_hash).toBe(result.receipt.receipt_hash);
      expect(await readFile(marker, 'utf8')).toBe('run\nrun\n');
      expect((await storage.readJson(value.paths.active)).receipts).toHaveLength(1);
    }, 30000);

  it('replays a prepared successful admission after a crash without a third test execution', async () => {
    const value = await fixture();
    await mkdir(path.join(value.directory, '.git/info'), { recursive: true });
    await writeFile(path.join(value.directory, '.git/info/exclude'), '.invocations\n');
    await writeFile(path.join(value.directory, 'tests/value.test.js'),
      "import { appendFileSync } from 'node:fs'; appendFileSync('.invocations', 'run\\n');\n" + PASS);
    await attest(value);
    const write = storage.atomicWriteJson;
    let preparedFile;
    vi.spyOn(storage, 'atomicWriteJson').mockImplementation(async (file, body, ...rest) => {
      const result = await write(file, body, ...rest);
      if (!preparedFile && path.dirname(file) === value.paths.receiptTransactions && body.status === 'prepared') {
        preparedFile = file;
        throw new Error('synthetic lost response after prepared transaction');
      }
      return result;
    });
    await expect(recordReceipt(value.directory, value.draft)).rejects.toThrow(/synthetic lost response/);
    vi.restoreAllMocks();
    expect(preparedFile).toBeTruthy();
    expect((await storage.readJson(preparedFile)).status).toBe('prepared');
    expect(await readFile(path.join(value.directory, '.invocations'), 'utf8')).toBe('run\nrun\n');
    const replay = await recordReceipt(value.directory, structuredClone(value.draft));
    expect(replay.ok, JSON.stringify(replay.errors)).toBe(true);
    expect((await storage.readJson(preparedFile)).status).toBe('committed');
    expect(await readFile(path.join(value.directory, '.invocations'), 'utf8')).toBe('run\nrun\n');
    expect((await storage.readJson(value.paths.active)).receipts).toHaveLength(1);
  }, 30000);
});
