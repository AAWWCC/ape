import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startRun, recordReceipt, validateReceiptForDispatch, expireDispatch } from '../lib/runtime/service.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { atomicWriteJson, readJson } from '../lib/runtime/storage.js';
import { currentTreeSha } from '../lib/runtime/git.js';
import { finalizeReceipt, finalizeTicket } from '../lib/runtime/schemas.js';
import { receiptOutputSchemaForTicket, validateStageReceipt } from '../lib/runtime/receipt-validator.js';
import { receiptDraftSchemaForTicket } from '../lib/runtime/receipt-draft-schema.js';
import { sha256 } from '../lib/runtime/canonical.js';
import { readRunContractManifest } from '../lib/runtime/run-contract.js';
import { bindCodexDispatchContext, invokeCodexHook } from './codex-native-test-helper.js';

const authoringFault = vi.hoisted(() => ({ crashTicket: null, fired: 0, runs: null, calls: 0 }));
vi.mock('../lib/runtime/storage.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, atomicWriteJson: async (file, value) => {
    await actual.atomicWriteJson(file, value);
    if (authoringFault.crashTicket && value?.ticket_id === authoringFault.crashTicket &&
        value?.status === 'prepared' && String(file).replaceAll('\\', '/').includes('/receipt-transactions/')) {
      authoringFault.crashTicket = null;
      authoringFault.fired += 1;
      throw new Error('synthetic crash after authoring transaction preparation');
    }
  } };
});
vi.mock('../lib/runtime/runner.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, runTestSuite: async (...args) => {
    if (!authoringFault.runs) return actual.runTestSuite(...args);
    authoringFault.calls += 1;
    const result = authoringFault.runs.shift();
    if (!result) throw new Error('unexpected third authoring observation');
    return result;
  } };
});

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cleanups = [];
const V1 = 'module.exports = { value: 1 };\n';
const V2 = 'module.exports = { value: 22 };\n';
const TEST = "const assert = require('node:assert/strict');\nassert.equal(require('../src/value.js').value, 22);\n";
afterEach(async () => {
  Object.assign(authoringFault, { crashTicket: null, fired: 0, runs: null, calls: 0 });
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const ADMITTED_PRODUCTION = ['src/value.js', 'scripts/native-test-process.mjs', '.github/test-durations.json'];
const ADMITTED_TESTS = ['tests/value.test.js', 'tests/sibling.test.js'];

async function fixture({ fullLane = false, productionPaths = ADMITTED_PRODUCTION,
  testPaths = ADMITTED_TESTS, physicalTestPaths = testPaths, fullTestCommand = 'node --test' } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-tree-handoff-'));
  cleanups.push(dir);
  await mkdir(path.join(dir, 'src'));
  await mkdir(path.join(dir, 'tests'));
  await writeFile(path.join(dir, 'src/value.js'), V1);
  if (fullLane) {
    await mkdir(path.join(dir, 'scripts'));
    await mkdir(path.join(dir, '.github'));
    await writeFile(path.join(dir, 'scripts/native-test-process.mjs'), 'export const value = 1;\n');
    await writeFile(path.join(dir, '.github/test-durations.json'), '{}\n');
    for (const file of physicalTestPaths) {
      await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
      const modulePath = path.relative(path.dirname(file), 'src/value.js').replaceAll('\\', '/');
      await writeFile(path.join(dir, file), TEST.replace('../src/value.js', modulePath));
    }
  }
  for (const args of [['init', '-q'], ['config', 'user.email', 'ape@example.test'],
    ['config', 'user.name', 'APE Test'], ['add', '.'], ['commit', '-qm', 'fixture']]) {
    execFileSync('git', args, { cwd: dir });
  }
  const paths = runtimePaths(dir);
  await atomicWriteJson(paths.config, {
    shipping: { auto_merge: false, provider: 'github', required_remote_checks: false },
    test_commands: { full: fullTestCommand, targeted_template: 'node --test {paths}' },
  });
  const started = await startRun(dir, {
    objective: 'Preserve production work while recovering exact test authority',
    mode: 'phase', lane: 'fast', host: 'codex', behavioral: false,
    claimed_paths: ['src/value.js'], test_paths: [], requirements: [], risk_triggers: [],
    hooks_trusted: true, subagents_available: true, explicit_invocation: true,
    binding_protocol: 'native-v1', capability_contract_required: true,
    ...(fullLane ? { lane: 'full', behavioral: true, plan_contract_version: 1,
      claimed_paths: productionPaths, test_paths: testPaths } : {}),
  });
  expect(started.ok, JSON.stringify(started)).toBe(true);
  let action = started.actions.find((entry) => entry.type === 'dispatch_agent');
  if (fullLane) {
    expect(started.run.lane).toBe('full');
    expect(action.ticket.role).toBe('planner');
    const planning = { dir, paths, action, ticket: action.ticket,
      binding: await bindCodexDispatchContext(root, dir, action) };
    const commands = planning.ticket.capability_manifest.plannable_evidence_commands ??
      planning.ticket.capability_manifest.allowed_evidence_commands;
    const command = commands.find((entry) => entry.startsWith('node --test'));
    expect(command).toBeTruthy();
    const candidate = { version: 1,
      requirements: [{ id: 'R1', requirement: 'Keep recovery authority role-separated', workstreams: ['recovery'] }],
      workstreams: [{ id: 'recovery', outcome: 'Admitted writers can complete their work',
        paths: [...productionPaths, ...testPaths].map((file) => ({ path: file, action: 'modify' })),
        steps: ['Exercise production and test work through authorized recovery'],
        acceptance: ['Role switches preserve admitted scope and exact tests'], evidence_commands: [command] }],
      risks: [], non_goals: ['Changing unadmitted files'] };
    const planned = await seal(planning, { ...draft(planning), evidence: { candidate_plan: candidate } });
    const reviews = planned.actions.filter((entry) => entry.type === 'dispatch_agent');
    expect(reviews.map((entry) => entry.ticket.role).sort()).toEqual(['plan_checker', 'plan_critic']);
    let reviewed;
    for (const [index, review] of reviews.entries()) {
      const value = { dir, paths, action: review, ticket: review.ticket,
        binding: await bindCodexDispatchContext(root, dir, review, index + 2) };
      reviewed = await seal(value, { ...draft(value), evidence: { verdict: 'agree' } });
    }
    action = reviewed.actions.find((entry) => entry.type === 'dispatch_agent');
    expect(action.ticket).toMatchObject({ role: 'test_writer', stage_id: 'test',
      claimed_paths: testPaths, test_paths: testPaths });
    const binding = await bindCodexDispatchContext(root, dir, action, 4);
    return { dir, paths, action, ticket: action.ticket, binding };
  }
  expect(action.ticket.role).toBe('implementer');
  const binding = await bindCodexDispatchContext(root, dir, action);
  return { dir, paths, action, ticket: action.ticket, binding };
}

function draft(value, requiredClaims = null) {
  return {
    ticket_id: value.ticket.ticket_id, status: requiredClaims ? 'failed' : 'passed',
    tests: [], findings: [], receipt_capability: value.binding.capability,
    evidence: requiredClaims ? {
      summary: 'An additional immutable capability is needed to finish the fixture.',
      failure_kind: 'capability', required_claims: requiredClaims,
    } : { summary: 'Authorized successor work is complete.' },
  };
}

function event(value, fields) {
  return {
    project_dir: value.dir, session_id: value.binding.sessionId,
    turn_id: value.binding.turnId, agent_id: value.binding.agentId,
    agent_type: 'default', model: value.ticket.model.model, is_subagent: true,
    ...fields,
  };
}

async function hook(value, fields) {
  return invokeCodexHook(root, event(value, fields));
}

async function writeThroughHooks(value, file, content) {
  const fields = { tool_name: 'Write', tool_use_id: `write-${file}`,
    tool_input: { file_path: path.join(value.dir, file), content } };
  expect(await hook(value, { hook_event_name: 'PreToolUse', ...fields })).toEqual({});
  await writeFile(path.join(value.dir, file), content);
  expect(await hook(value, { hook_event_name: 'PostToolUse', ...fields, tool_response: 'written' })).toEqual({});
}

async function seal(value, payload) {
  expect(await validateReceiptForDispatch(value.dir, payload, value.ticket.ticket_id))
    .toMatchObject({ ok: true, valid: true });
  expect(await hook(value, { hook_event_name: 'SubagentStop', last_assistant_message: JSON.stringify(payload) }))
    .toEqual({});
  const result = await recordReceipt(value.dir, payload);
  expect(result.ok, JSON.stringify(result)).toBe(true);
  return result;
}

async function handoff(role = 'test_writer', { productionChange = true } = {}) {
  const source = await fixture();
  if (productionChange) await writeThroughHooks(source, 'src/value.js', V2);
  const claims = role === 'test_writer'
    ? { required_role: role, test_paths: ['tests/value.test.js'] }
    : role === 'implementer' ? { claimed_paths: ['src/extra.js'] } : { required_role: role };
  const payload = draft(source, claims);
  const result = await seal(source, payload);
  const sourceReceipt = result.run.receipts.find((entry) => entry.ticket_id === source.ticket.ticket_id);
  expect(sourceReceipt.changed_files).toEqual(productionChange ? ['src/value.js'] : []);
  const sourceFile = path.join(source.paths.receipts, `${sourceReceipt.receipt_id}.json`);
  const sourceBytes = await readFile(sourceFile, 'utf8');
  const action = result.actions.find((entry) => entry.type === 'dispatch_agent');
  expect(action.ticket.role).toBe(role);
  expect(action.ticket.base_tree_sha).toBe(source.ticket.base_tree_sha);
  const binding = await bindCodexDispatchContext(root, source.dir, action, 2);
  return { ...source, action, ticket: action.ticket, binding,
    source, sourceReceipt, sourceFile, sourceBytes, payload };
}

async function prospective(value, changedFiles, tests = []) {
  const state = await readJson(value.paths.active);
  const receipt = finalizeReceipt({
    ...value.sourceReceipt, receipt_id: randomUUID(), ticket_id: value.ticket.ticket_id,
    ticket_hash: value.ticket.ticket_hash, status: 'passed',
    agent: { ...value.sourceReceipt.agent, role: value.ticket.role, identity: value.binding.agentId },
    base_tree_sha: value.ticket.base_tree_sha, head_tree_sha: await currentTreeSha(value.dir),
    changed_files: changedFiles, tests, findings: [], evidence: { summary: 'Successor work' },
    timing: { started_at: value.ticket.issued_at, completed_at: value.ticket.issued_at, duration_ms: 0 },
    previous_receipt_hash: state.receipts.at(-1).receipt_hash,
  });
  return { project_dir: value.dir, state, ticket: value.ticket, receipt };
}

async function recover(value, claims, ordinal) {
  const payload = draft(value, claims);
  const result = await seal(value, payload);
  const action = result.actions.find((entry) => entry.type === 'dispatch_agent');
  expect(action, JSON.stringify(result)).toBeTruthy();
  const sourceReceipt = result.run.receipts.find((entry) => entry.ticket_id === value.ticket.ticket_id);
  return { ...value, action, ticket: action.ticket, sourceReceipt, result, payload,
    binding: await bindCodexDispatchContext(root, value.dir, action, ordinal) };
}

async function expectWritePermission(value, file, allowed) {
  const result = await hook(value, { hook_event_name: 'PreToolUse', tool_name: 'Write',
    tool_input: { file_path: path.join(value.dir, file), content: 'fixture edit\n' } });
  if (allowed) expect(result, file).toEqual({});
  else expect(result, file).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
}

async function expectBoundScope(value, production, tests, writableClaims) {
  expect(value.ticket.claimed_paths).toEqual(writableClaims);
  expect(value.ticket.test_paths).toEqual(tests);
  expect(value.ticket.output_schema).toEqual(receiptOutputSchemaForTicket(value.ticket));
  expect(value.ticket.capability_manifest.receipt_schema.hash).toBe(sha256(value.ticket.output_schema));
  const { ticket_hash: hash, ...body } = value.ticket;
  expect(hash).toBe(sha256(body));
  const state = await readJson(value.paths.active);
  expect(state.claimed_paths).toEqual(production);
  expect(state.test_paths).toEqual(tests);
  const manifest = await readRunContractManifest(value.paths, value.ticket.capability_manifest.run_contract);
  expect(manifest.capability_catalog.frozen_recovery_authority.run_scope)
    .toMatchObject({ claimed_paths: production, test_paths: tests });
  expect(manifest.receipt_contract.ticket_contracts.find((entry) => entry.ticket_id === value.ticket.ticket_id)
    .recovery_authority).toMatchObject({ claimed_paths: writableClaims, test_paths: tests });
}

async function exactRemediationFixture({ productionPaths = ADMITTED_PRODUCTION,
  testPaths = ADMITTED_TESTS, authoredSibling = null, physicalTestPaths = testPaths,
  productionExpansion = null } = {}) {
  // Freeze concrete executable files separately from directory-level authority.
  // Include a sibling authored later so the build's evidence runs it as well.
  const executableTests = [...new Set([...physicalTestPaths, ...(authoredSibling ? [authoredSibling] : [])])].sort();
  const testArgs = ['--test', ...executableTests];
  const fullTestCommand = `node ${testArgs.join(' ')}`;
  const source = await fixture({ fullLane: true, productionPaths, testPaths, physicalTestPaths, fullTestCommand });
  for (const file of physicalTestPaths) {
    const content = await readFile(path.join(source.dir, file), 'utf8');
    await writeThroughHooks(source, file, `${content}// authored fixture\n`);
  }
  if (authoredSibling) await writeThroughHooks(source, authoredSibling, TEST);
  const authoredPaths = [...physicalTestPaths, ...(authoredSibling ? [authoredSibling] : [])];
  const admittedTests = [...testPaths, ...authoredPaths.filter((file) => !testPaths.includes(file)).sort()];
  const tested = await seal(source, draft(source));
  const buildAction = tested.actions.find((entry) => entry.type === 'dispatch_agent');
  expect(buildAction.ticket.role).toBe('implementer');
  expect(buildAction.ticket.test_paths).toEqual(admittedTests);
  const build = { ...source, action: buildAction, ticket: buildAction.ticket,
    binding: await bindCodexDispatchContext(root, source.dir, buildAction, 5) };
  await writeThroughHooks(build, 'src/value.js', V2);
  const command = build.ticket.capability_manifest.allowed_evidence_commands.find((entry) =>
    entry === fullTestCommand);
  expect(command).toBe(fullTestCommand);
  const startedAt = performance.now();
  execFileSync(process.execPath, testArgs, { cwd: source.dir });
  const duration = performance.now() - startedAt;
  const built = await seal(build, { ...draft(build),
    tests: [{ command, passed: true, exit_code: 0, duration_ms: duration }] });
  let reviewed;
  for (const [index, action] of built.actions.filter((entry) => entry.type === 'dispatch_agent').entries()) {
    const reviewer = { ...source, action, ticket: action.ticket,
      binding: await bindCodexDispatchContext(root, source.dir, action, 6 + index) };
    const payload = { ...draft(reviewer), evidence: { verdict: 'pass' } };
    if (action.ticket.role === 'reviewer') {
      payload.evidence.verdict = 'fail';
      payload.findings = [{ id: 'fixture.test-correction', file: 'tests/value.test.js', line: 2,
        title: 'Add assertion context', detail: 'The assertion needs a diagnostic message.', blocking: true,
        remediation: { owner: 'test', test_paths: ['tests/value.test.js'] } }];
      if (productionExpansion) {
        payload.evidence.scope_expansion = { claimed_paths: [productionExpansion],
          reason: 'The production correction requires an independently admitted helper.' };
        payload.findings = [{ id: 'fixture.production-correction', file: productionExpansion, line: 1,
          title: 'Extract the helper', detail: 'The fix requires this additional production module.',
          blocking: true, remediation: { owner: 'production' } }];
      }
    }
    reviewed = await seal(reviewer, payload);
  }
  const action = reviewed.actions.find((entry) => entry.type === 'dispatch_agent');
  if (productionExpansion) {
    expect(action.ticket).toMatchObject({ stage_id: 'remediation-build', role: 'implementer',
      claimed_paths: [...productionPaths, productionExpansion], test_paths: admittedTests });
  } else {
    expect(action.ticket).toMatchObject({ stage_id: 'remediation-test', role: 'test_writer',
      test_scope: 'exact', test_paths: ['tests/value.test.js'], claimed_paths: ['tests/value.test.js'] });
  }
  return { ...source, action, ticket: action.ticket,
    binding: await bindCodexDispatchContext(root, source.dir, action, 8) };
}

async function buildAuthor(stageId) {
  let source;
  if (stageId === 'remediation-build') {
    source = await exactRemediationFixture({ productionExpansion: 'src/helper.js' });
  } else {
    const initial = await fixture({ fullLane: true });
    await writeThroughHooks(initial, 'tests/value.test.js', `${TEST}// initial independent coverage\n`);
    const tested = await seal(initial, draft(initial));
    const action = tested.actions.find((entry) => entry.type === 'dispatch_agent');
    source = { ...initial, action, ticket: action.ticket,
      binding: await bindCodexDispatchContext(root, initial.dir, action, 5) };
    await writeThroughHooks(source, 'src/value.js', V2);
  }
  const author = await recover(source, { required_role: 'test_writer' }, 9);
  return { source, author };
}

async function resumeAfterAuthor(value, ordinal) {
  const result = await seal(value, draft(value));
  const action = result.actions.find((entry) => entry.type === 'dispatch_agent');
  return { ...value, action, ticket: action.ticket, result,
    sourceReceipt: result.run.receipts.find((entry) => entry.ticket_id === value.ticket.ticket_id),
    binding: await bindCodexDispatchContext(root, value.dir, action, ordinal) };
}

describe('pending authoring survives a diagnostic role detour', () => {
  it.each([
    ['build', 'unchanged'], ['build', 'red'], ['build', 'green'],
    ['remediation-build', 'unchanged'], ['remediation-build', 'red'], ['remediation-build', 'green'],
  ])('requires independently authored stable coverage after %s debugger success (%s)', async (stageId, outcome) => {
    const green = outcome === 'green';
    const { source, author } = await buildAuthor(stageId);
    const diagnostic = await recover(author, { required_role: 'debugger' }, 10);
    expect(diagnostic.ticket.test_authoring_handoff).toEqual(author.ticket.test_authoring_handoff);
    expect(diagnostic.ticket.writable).toBe(false);
    await expectWritePermission(diagnostic, 'tests/value.test.js', false);
    await expectWritePermission(diagnostic, 'src/value.js', false);
    // A diagnostic receipt is allowed to finish, but cannot claim the pending
    // writer's runtime observation or skip its independent changed-file check.
    const payload = draft(diagnostic);
    payload.evidence.test_correction = { observed: true, passed: true,
      test_paths: ADMITTED_TESTS, runs: [{ exit_code: 0 }, { exit_code: 0 }] };
    const diagnosed = await seal(diagnostic, payload);
    const dispatches = diagnosed.actions.filter((entry) => entry.type === 'dispatch_agent');
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0].ticket).toMatchObject({ stage_id: stageId, role: 'test_writer',
      required_checks: ['test-correction'], claimed_paths: ADMITTED_TESTS, test_paths: ADMITTED_TESTS,
      test_authoring_handoff: author.ticket.test_authoring_handoff });
    const returned = { ...author, action: dispatches[0], ticket: dispatches[0].ticket,
      binding: await bindCodexDispatchContext(root, source.dir, dispatches[0], 11) };
    if (outcome === 'unchanged') {
      const unchanged = draft(returned);
      unchanged.evidence.test_correction = payload.evidence.test_correction;
      expect(await validateReceiptForDispatch(source.dir, unchanged, returned.ticket.ticket_id)).toMatchObject({ valid: true });
      expect(await hook(returned, { hook_event_name: 'SubagentStop', last_assistant_message: JSON.stringify(unchanged) })).toEqual({});
      const refused = await recordReceipt(source.dir, unchanged);
      expect(refused).toMatchObject({ ok: false, rejected: true });
      expect(refused.errors.join(' ')).toMatch(/no runtime-verifiable authored test files/);
      const state = await readJson(source.paths.active);
      expect(state.tickets.at(-1).ticket_id).toBe(returned.ticket.ticket_id);
      expect(state.receipts.some((entry) => entry.ticket_id === returned.ticket.ticket_id)).toBe(false);
      await expectWritePermission(returned, 'tests/value.test.js', false);
      return;
    }

    // Successful authoring uses its own live worker, independent of the
    // unchanged receipt scenario whose SubagentStop revokes tool authority.
    await writeThroughHooks(returned, 'tests/value.test.js', green
      ? `${TEST}assert.equal(typeof require('../src/value.js').value, 'number');\n`
      : `${TEST}assert.equal(require('../src/value.js').ready, true);\n`);
    const authoredPayload = draft(returned);
    expect(await validateReceiptForDispatch(source.dir, authoredPayload, returned.ticket.ticket_id)).toMatchObject({ valid: true });
    expect(await hook(returned, { hook_event_name: 'SubagentStop', last_assistant_message: JSON.stringify(authoredPayload) })).toEqual({});
    // Simultaneous parent retries must publish a single logical continuation.
    const results = await Promise.all([recordReceipt(source.dir, authoredPayload), recordReceipt(source.dir, authoredPayload)]);
    for (const result of results) expect(result.ok, JSON.stringify(result)).toBe(true);
    const state = await readJson(source.paths.active);
    const receipt = state.receipts.find((entry) => entry.ticket_id === returned.ticket.ticket_id);
    expect(receipt.changed_files).toEqual(['tests/value.test.js']);
    expect(receipt.evidence.test_correction).toMatchObject({ observed: true, passed: green,
      test_paths: ['tests/value.test.js'], tree_sha: receipt.head_tree_sha });
    expect(receipt.evidence.test_correction.runs).toHaveLength(2);
    expect(receipt.evidence.test_correction.runs.every((run) => (run.exit_code === 0) === green)).toBe(true);
    expect(state.receipts.filter((entry) => entry.ticket_id === returned.ticket.ticket_id)).toHaveLength(1);
    const afterWriter = state.tickets.slice(state.tickets.findIndex((entry) => entry.ticket_id === returned.ticket.ticket_id) + 1);
    expect(afterWriter).toHaveLength(1);
    expect(afterWriter[0]).toMatchObject({ stage_id: stageId, role: 'implementer',
      claimed_paths: source.ticket.claimed_paths, test_paths: source.ticket.test_paths,
      required_checks: source.ticket.required_checks, test_authoring_handoff: author.ticket.test_authoring_handoff });
    const action = results.flatMap((result) => result.actions).find((entry) =>
      entry.type === 'dispatch_agent' && entry.ticket.ticket_id === afterWriter[0].ticket_id);
    const implementation = { ...source, action, ticket: action.ticket,
      binding: await bindCodexDispatchContext(root, source.dir, action, 12) };
    await expectWritePermission(implementation, 'tests/value.test.js', false);
    expect((await validateReceiptForDispatch(source.dir, draft(implementation), implementation.ticket.ticket_id)).valid).toBe(false);
    await writeThroughHooks(implementation, 'src/value.js', 'module.exports = { value: 22, ready: true };\n');
    const command = implementation.ticket.capability_manifest.allowed_evidence_commands.find((entry) =>
      entry.startsWith('node --test ') && ADMITTED_TESTS.every((file) => entry.includes(file)));
    const startedAt = performance.now();
    execFileSync(process.execPath, ['--test', ...ADMITTED_TESTS], { cwd: source.dir });
    const built = await seal(implementation, { ...draft(implementation),
      tests: [{ command, passed: true, exit_code: 0, duration_ms: performance.now() - startedAt }] });
    const reviews = built.actions.filter((entry) => entry.type === 'dispatch_agent');
    expect(reviews.length).toBeGreaterThan(0);
    expect(reviews.every((entry) => ['reviewer', 'security_reviewer'].includes(entry.ticket.role))).toBe(true);
    const later = await readJson(source.paths.active);
    for (const prior of [author.payload, diagnostic.payload, payload, authoredPayload]) {
      expect((await recordReceipt(source.dir, prior)).ok).toBe(true);
      expect(await readJson(source.paths.active)).toEqual(later);
    }
  }, 120_000);

  it('cannot discharge pending authoring by requesting implementation directly', async () => {
    const { author } = await buildAuthor('build');
    await writeThroughHooks(author, 'tests/value.test.js', `${TEST}// unobserved capability-failure output\n`);
    const result = await seal(author, draft(author, { required_role: 'implementer' }));
    const dispatches = result.actions.filter((entry) => entry.type === 'dispatch_agent');
    expect(dispatches.length).toBeGreaterThan(0);
    expect(dispatches.every((entry) => entry.ticket.role === 'test_writer' &&
      entry.ticket.required_checks.includes('test-correction'))).toBe(true);
    expect(dispatches[0].ticket.test_authoring_handoff).toEqual(author.ticket.test_authoring_handoff);
  }, 60_000);

  it.each(['unstable', 'no verdict'])('refuses %s runtime observations even with forged worker success', async (fault) => {
    const author = await handoff();
    await writeThroughHooks(author, 'tests/value.test.js', TEST);
    const payload = draft(author);
    payload.evidence.test_correction = { observed: true, passed: true, runs: [{ exit_code: 0 }, { exit_code: 0 }] };
    expect(await validateReceiptForDispatch(author.dir, payload, author.ticket.ticket_id)).toMatchObject({ valid: true });
    expect(await hook(author, { hook_event_name: 'SubagentStop', last_assistant_message: JSON.stringify(payload) })).toEqual({});
    const run = (exit_code) => ({ command: 'node --test tests/value.test.js', passed: exit_code === 0,
      exit_code, duration_ms: 1, output: 'synthetic runner verdict', timed_out: false });
    authoringFault.runs = fault === 'unstable' ? [run(1), run(0)]
      : [{ ...run(null), tooling_failure: true }];
    const result = await recordReceipt(author.dir, payload);
    expect(result).toMatchObject({ ok: false, rejected: true });
    expect(result.errors.join(' ')).toMatch(fault === 'unstable' ? /stable|flak|inconsisten/i : /verdict|runner/i);
    expect(authoringFault.calls).toBe(fault === 'unstable' ? 2 : 1);
    const state = await readJson(author.paths.active);
    expect(state.receipts.some((entry) => entry.ticket_id === author.ticket.ticket_id)).toBe(false);
    expect(state.tickets.at(-1).ticket_id).toBe(author.ticket.ticket_id);
  }, 30_000);

  it.each([
    ['test_writer', false], ['test_writer', true], ['debugger', false], ['debugger', true],
  ])('retains independent authoring after %s expiry and rejects the late receipt (authored: %s)', async (role, authored) => {
    const author = await handoff();
    await writeThroughHooks(author, 'tests/value.test.js', TEST);
    const expiredWorker = role === 'debugger'
      ? await recover(author, { required_role: 'debugger' }, 3) : author;
    const latePayload = draft(expiredWorker);
    const expired = await expireDispatch(author.dir, expiredWorker.ticket.ticket_id, 'Synthetic disconnected authoring worker');
    expect(expired.ok, JSON.stringify(expired)).toBe(true);
    const action = expired.actions.find((entry) => entry.type === 'dispatch_agent');
    expect(action.ticket.test_authoring_handoff).toEqual(author.ticket.test_authoring_handoff);
    let retry = { ...expiredWorker, action, ticket: action.ticket,
      binding: await bindCodexDispatchContext(root, author.dir, action, 4) };
    expect((await recordReceipt(author.dir, latePayload)).ok).toBe(false);
    if (role === 'debugger') retry = await resumeAfterAuthor(retry, 5);
    expect(retry.ticket).toMatchObject({ role: 'test_writer', required_checks: ['test-correction'],
      test_authoring_handoff: author.ticket.test_authoring_handoff });
    if (!authored) {
      const payload = draft(retry);
      expect(await validateReceiptForDispatch(author.dir, payload, retry.ticket.ticket_id)).toMatchObject({ valid: true });
      expect(await hook(retry, { hook_event_name: 'SubagentStop', last_assistant_message: JSON.stringify(payload) })).toEqual({});
      const unchanged = await recordReceipt(author.dir, payload);
      expect(unchanged).toMatchObject({ ok: false, rejected: true });
      expect(unchanged.errors.join(' ')).toMatch(/no runtime-verifiable authored test files/);
      const state = await readJson(author.paths.active);
      expect(state.tickets.at(-1).ticket_id).toBe(retry.ticket.ticket_id);
      expect(state.receipts.some((entry) => entry.ticket_id === retry.ticket.ticket_id)).toBe(false);
      await expectWritePermission(retry, 'tests/value.test.js', false);
      return;
    }
    await writeThroughHooks(retry, 'tests/value.test.js', `${TEST}assert.equal(typeof require('../src/value.js').value, 'number');\n`);
    const resumed = await resumeAfterAuthor(retry, 6);
    expect(resumed.ticket).toMatchObject({ role: 'implementer', required_checks: ['targeted-tests'],
      test_authoring_handoff: author.ticket.test_authoring_handoff });
  }, 60_000);

  it.each(['missing continuation', 'forged continuation'])('rejects %s introduced after authoring validation', async (fault) => {
    const author = await handoff();
    await writeThroughHooks(author, 'tests/value.test.js', TEST);
    const payload = draft(author);
    expect(await validateReceiptForDispatch(author.dir, payload, author.ticket.ticket_id)).toMatchObject({ valid: true });
    expect(await hook(author, { hook_event_name: 'SubagentStop', last_assistant_message: JSON.stringify(payload) })).toEqual({});
    // Substitute the worker's ticket after all worker-side checks, immediately
    // before the parent receipt sink. Its original bound hash remains authority.
    const state = await readJson(author.paths.active);
    const substituted = { ...author.ticket };
    if (fault === 'missing continuation') delete substituted.test_authoring_handoff;
    else substituted.test_authoring_handoff = { ...substituted.test_authoring_handoff,
      source_receipt_hash: '0'.repeat(64) };
    const forged = finalizeTicket(substituted);
    state.tickets = state.tickets.map((entry) => entry.ticket_id === author.ticket.ticket_id ? forged : entry);
    await atomicWriteJson(path.join(author.paths.tickets, `${author.ticket.ticket_id.replaceAll(':', '_')}.json`), forged);
    await atomicWriteJson(author.paths.active, state);
    const before = await readJson(author.paths.active);
    const rejected = await recordReceipt(author.dir, payload).catch((error) => ({ ok: false, errors: [error.message] }));
    expect(rejected.ok).toBe(false);
    const after = await readJson(author.paths.active);
    expect(after.tickets).toEqual(before.tickets);
    expect(after.receipts).toEqual(before.receipts);
  }, 30_000);

  it('preserves the completed authoring continuation across independent contradiction reconciliation', async () => {
    const { source, author } = await buildAuthor('build');
    await writeThroughHooks(author, 'tests/value.test.js', `${TEST}assert.equal(typeof require('../src/value.js').value, 'number');\n`);
    const implementation = await resumeAfterAuthor(author, 10);
    const report = draft(implementation);
    report.status = 'failed';
    report.evidence = { failure_kind: 'test-contradiction', summary: 'Synthetic request to check an assertion',
      test_contradiction: { summary: 'Verify the value assertion against the objective', test_paths: ['tests/value.test.js'] } };
    const reported = await seal(implementation, report);
    const action = reported.actions.find((entry) => entry.type === 'dispatch_agent');
    expect(action.ticket).toMatchObject({ stage_id: 'test-reconcile', role: 'reviewer', writable: false });
    const reviewer = { ...source, action, ticket: action.ticket,
      binding: await bindCodexDispatchContext(root, source.dir, action, 11) };
    const reviewed = await seal(reviewer, { ...draft(reviewer), evidence: { verdict: 'pass' } });
    const retryAction = reviewed.actions.find((entry) => entry.type === 'dispatch_agent');
    expect(retryAction.ticket).toMatchObject({ role: 'implementer', stage_id: 'build',
      claimed_paths: source.ticket.claimed_paths, test_paths: source.ticket.test_paths,
      required_checks: implementation.ticket.required_checks,
      test_authoring_handoff: author.ticket.test_authoring_handoff });
    const retry = { ...implementation, action: retryAction, ticket: retryAction.ticket,
      binding: await bindCodexDispatchContext(root, source.dir, retryAction, 12) };
    await expectWritePermission(retry, 'tests/value.test.js', false);
    expect((await validateReceiptForDispatch(source.dir, draft(retry), retry.ticket.ticket_id)).valid).toBe(false);
  }, 90_000);

  it.each(['handoff', 'authored result'])('replays a prepared %s transaction exactly once after a crash', async (boundary) => {
    const author = await handoff();
    if (boundary === 'authored result') await writeThroughHooks(author, 'tests/value.test.js', TEST);
    const payload = boundary === 'handoff' ? draft(author, { required_role: 'debugger' }) : draft(author);
    expect(await validateReceiptForDispatch(author.dir, payload, author.ticket.ticket_id)).toMatchObject({ valid: true });
    expect(await hook(author, { hook_event_name: 'SubagentStop', last_assistant_message: JSON.stringify(payload) })).toEqual({});
    authoringFault.crashTicket = author.ticket.ticket_id;
    const interrupted = await recordReceipt(author.dir, payload).catch((error) => ({ ok: false, errors: [error.message] }));
    expect(authoringFault.fired).toBe(1);
    expect(interrupted.ok).not.toBe(true);
    const replay = await recordReceipt(author.dir, payload);
    expect(replay.ok, JSON.stringify(replay)).toBe(true);
    const state = await readJson(author.paths.active);
    expect(state.receipts.filter((entry) => entry.ticket_id === author.ticket.ticket_id)).toHaveLength(1);
    const following = state.tickets.slice(state.tickets.findIndex((entry) => entry.ticket_id === author.ticket.ticket_id) + 1);
    expect(following).toHaveLength(1);
    expect(following[0]).toMatchObject({ role: boundary === 'handoff' ? 'debugger' : 'implementer',
      test_authoring_handoff: author.ticket.test_authoring_handoff });
    expect((await recordReceipt(author.dir, payload)).ok).toBe(true);
    expect(await readJson(author.paths.active)).toEqual(state);
  }, 45_000);
});

describe('test authoring recovery returns to implementation', () => {
  it.each(['build', 'remediation-build'])('admits independently authored failures before resuming %s', async (stageId) => {
    let source;
    if (stageId === 'remediation-build') {
      source = await exactRemediationFixture({ productionExpansion: 'src/helper.js' });
    } else {
      const initial = await fixture({ fullLane: true });
      await writeThroughHooks(initial, 'tests/value.test.js', `${TEST}// initial coverage\n`);
      const tested = await seal(initial, draft(initial));
      const action = tested.actions.find((entry) => entry.type === 'dispatch_agent');
      source = { ...initial, action, ticket: action.ticket,
        binding: await bindCodexDispatchContext(root, initial.dir, action, 5) };
      await writeThroughHooks(source, 'src/value.js', V2);
    }
    expect(source.ticket).toMatchObject({ stage_id: stageId, role: 'implementer',
      required_checks: ['targeted-tests'] });
    const payload = draft(source, { required_role: 'test_writer' });
    payload.evidence.needed_independent_coverage = 'Add a fixture asserting that ready is true.';
    const handedOff = await seal(source, payload);
    const action = handedOff.actions.find((entry) => entry.type === 'dispatch_agent');
    const author = { ...source, action, ticket: action.ticket,
      binding: await bindCodexDispatchContext(root, source.dir, action, 9) };
    expect(author.ticket.required_checks).toEqual(['test-correction']);
    expect(author.ticket.test_authoring_handoff).toMatchObject({
      version: 1, source_ticket_id: source.ticket.ticket_id, source_ticket_hash: source.ticket.ticket_hash,
    });
    expect(author.ticket.test_authoring_handoff.report).toContain(payload.evidence.needed_independent_coverage);
    await expectWritePermission(author, 'src/value.js', false);
    await writeThroughHooks(author, 'tests/value.test.js',
      `${TEST}assert.equal(require('../src/value.js').ready, true);\n`);
    const authorPayload = draft(author);
    const authored = await seal(author, authorPayload);
    const receipt = authored.run.receipts.find((entry) => entry.ticket_id === author.ticket.ticket_id);
    expect(receipt.changed_files).toEqual(['tests/value.test.js']);
    expect(receipt.evidence.test_correction).toMatchObject({ observed: true, passed: false,
      test_paths: ['tests/value.test.js'], tree_sha: receipt.head_tree_sha });
    expect(receipt.evidence.test_correction.runs).toHaveLength(2);
    expect(receipt.evidence.test_correction.runs.every((test) => test.exit_code !== 0)).toBe(true);
    const builds = authored.actions.filter((entry) => entry.type === 'dispatch_agent');
    expect(builds).toHaveLength(1);
    expect(builds[0].ticket).toMatchObject({ stage_id: stageId, role: 'implementer',
      claimed_paths: source.ticket.claimed_paths, test_paths: ADMITTED_TESTS,
      required_checks: ['targeted-tests'] });
    expect(builds[0].ticket.test_authoring_handoff).toEqual(author.ticket.test_authoring_handoff);
    const resumed = { ...source, action: builds[0], ticket: builds[0].ticket,
      binding: await bindCodexDispatchContext(root, source.dir, builds[0], 10) };
    if (source.ticket.review_findings) expect(resumed.ticket.review_findings).toEqual(source.ticket.review_findings);
    await expectWritePermission(resumed, 'tests/value.test.js', false);
    const invalid = await validateReceiptForDispatch(source.dir, draft(resumed), resumed.ticket.ticket_id);
    expect(invalid.valid).toBe(false);
    await writeThroughHooks(resumed, 'src/value.js', 'module.exports = { value: 22, ready: true };\n');
    const command = resumed.ticket.capability_manifest.allowed_evidence_commands.find((entry) =>
      entry.startsWith('node --test ') && ADMITTED_TESTS.every((file) => entry.includes(file)));
    execFileSync(process.execPath, ['--test', ...ADMITTED_TESTS], { cwd: source.dir });
    const built = await seal(resumed, { ...draft(resumed),
      tests: [{ command, passed: true, exit_code: 0, duration_ms: 1 }] });
    expect(built.actions.filter((entry) => entry.type === 'dispatch_agent')
      .every((entry) => ['reviewer', 'security_reviewer'].includes(entry.ticket.role))).toBe(true);
    const beforeReplay = await readJson(source.paths.active);
    expect((await recordReceipt(source.dir, payload)).ok).toBe(true);
    expect(await readJson(source.paths.active)).toEqual(beforeReplay);
    const replay = await recordReceipt(source.dir, authorPayload);
    expect(replay.ok, JSON.stringify(replay)).toBe(true);
    const afterReplay = await readJson(source.paths.active);
    expect(afterReplay.tickets).toEqual(beforeReplay.tickets);
    expect(afterReplay.receipts).toEqual(beforeReplay.receipts);
  }, 90_000);

  it('accepts newly authored green coverage but still requires implementation checks', async () => {
    const author = await handoff();
    expect(author.ticket.required_checks).toEqual(['test-correction']);
    await writeThroughHooks(author, 'tests/value.test.js', TEST);
    const authored = await seal(author, draft(author));
    const receipt = authored.run.receipts.find((entry) => entry.ticket_id === author.ticket.ticket_id);
    expect(receipt.evidence.test_correction).toMatchObject({ observed: true, passed: true,
      runs: [{ exit_code: 0 }, { exit_code: 0 }] });
    const builds = authored.actions.filter((entry) => entry.type === 'dispatch_agent');
    expect(builds).toHaveLength(1);
    expect(builds[0].ticket).toMatchObject({ role: 'implementer', stage_id: 'build',
      claimed_paths: ['src/value.js'], required_checks: ['targeted-tests'] });
  }, 30_000);

  it('rejects a passed authoring receipt without any test changes', async () => {
    const author = await handoff();
    const payload = draft(author);
    expect(await validateReceiptForDispatch(author.dir, payload, author.ticket.ticket_id))
      .toMatchObject({ ok: true, valid: true });
    expect(await hook(author, { hook_event_name: 'SubagentStop', last_assistant_message: JSON.stringify(payload) }))
      .toEqual({});
    const result = await recordReceipt(author.dir, payload);
    expect(result).toMatchObject({ ok: false, rejected: true });
    expect(result.errors.join(' ')).toContain('no runtime-verifiable authored test files');
    const state = await readJson(author.paths.active);
    expect(state.receipts.some((entry) => entry.ticket_id === author.ticket.ticket_id)).toBe(false);
    expect(state.tickets.at(-1).ticket_id).toBe(author.ticket.ticket_id);
  }, 30_000);

  it('requires durable receipt evidence before preserving a claimed continuation on replay', async () => {
    const author = await handoff();
    await writeThroughHooks(author, 'tests/value.test.js', TEST);
    await seal(author, draft(author));
    const state = await readJson(author.paths.active);
    const index = state.receipts.findIndex((entry) => entry.ticket_id === author.ticket.ticket_id);
    state.receipts[index] = finalizeReceipt({ ...state.receipts[index],
      evidence: { summary: 'Forged completion with a self-consistent receipt hash' } });
    await atomicWriteJson(author.paths.active, state);
    const replay = await recordReceipt(author.dir, author.payload).catch((error) => ({ ok: false, errors: [error.message] }));
    expect(replay.ok).toBe(false);
    expect(replay.errors.join(' ')).toContain('committed receipt evidence');
    expect(await readJson(author.paths.active)).toEqual(state);
  }, 30_000);
});

describe('role recovery preserves independently admitted authority', () => {
  it.each(['retry', 'concurrent retry'])('retains an ordinary review production grant through role recovery and %s', async (boundary) => {
    const helper = 'lib/helper.js';
    const production = [...ADMITTED_PRODUCTION, helper];
    const source = await exactRemediationFixture({ productionExpansion: helper });
    const ticketFile = path.join(source.paths.tickets, `${source.ticket.ticket_id.replaceAll(':', '_')}.json`);
    const ticketBytes = await readFile(ticketFile, 'utf8');
    const manifestFile = path.join(source.dir, source.ticket.capability_manifest.run_contract.ref);
    const manifestBytes = await readFile(manifestFile, 'utf8');
    const manifest = await readRunContractManifest(source.paths, source.ticket.capability_manifest.run_contract);
    // A real blocking review admitted the helper. The original run inventory
    // deliberately remains older than the hashed remediation ticket contract.
    expect(manifest.capability_catalog.frozen_recovery_authority.run_scope.claimed_paths)
      .toEqual(ADMITTED_PRODUCTION);
    expect(manifest.receipt_contract.ticket_contracts.find((entry) => entry.ticket_id === source.ticket.ticket_id)
      .recovery_authority.claimed_paths).toEqual(production);
    const admitted = await readJson(source.paths.active);
    expect(admitted.claimed_paths).toEqual(production);
    expect(admitted.receipts.some((receipt) => receipt.agent.role === 'reviewer' &&
      receipt.evidence.scope_expansion?.claimed_paths.includes(helper))).toBe(true);
    await expectWritePermission(source, helper, true);
    // Neither dropping the mutable inventory nor adding an ambient grant can
    // alter the authority authenticated by that ordinary review/ticket pair.
    await atomicWriteJson(source.paths.active, { ...admitted,
      claimed_paths: [...ADMITTED_PRODUCTION, 'lib/ambient.js'] });
    const payload = draft(source, { required_role: 'test_writer' });
    expect(await validateReceiptForDispatch(source.dir, payload, source.ticket.ticket_id))
      .toMatchObject({ ok: true, valid: true });
    expect(await hook(source, { hook_event_name: 'SubagentStop', last_assistant_message: JSON.stringify(payload) }))
      .toEqual({});
    const results = boundary === 'concurrent retry'
      ? await Promise.all([recordReceipt(source.dir, payload), recordReceipt(source.dir, payload)])
      : [await recordReceipt(source.dir, payload)];
    for (const result of results) expect(result.ok, JSON.stringify(result)).toBe(true);
    const action = results.flatMap((result) => result.actions).find((entry) => entry.type === 'dispatch_agent');
    expect(action).toBeTruthy();
    const testWriter = { ...source, action, ticket: action.ticket,
      sourceReceipt: results[0].run.receipts.find((receipt) => receipt.ticket_id === source.ticket.ticket_id),
      binding: await bindCodexDispatchContext(root, source.dir, action, 9) };
    expect((await readJson(source.paths.active)).tickets.filter((ticket) =>
      ticket.recovery_lineage?.source_ticket_id === source.ticket.ticket_id)).toHaveLength(1);
    await expectBoundScope(testWriter, production, ADMITTED_TESTS, ADMITTED_TESTS);
    await expectWritePermission(testWriter, helper, false);
    await writeThroughHooks(testWriter, 'tests/value.test.js', `${TEST}// productive correction\n`);
    const returned = await resumeAfterAuthor(testWriter, 10);
    await expectBoundScope(returned, production, ADMITTED_TESTS, production);
    await expectWritePermission(returned, helper, true);
    await expectWritePermission(returned, 'lib/ambient.js', false);
    await expectWritePermission(returned, 'tests/value.test.js', false);
    await mkdir(path.join(source.dir, 'lib'));
    await writeThroughHooks(returned, helper, 'module.exports = { helper: true };\n');
    const command = returned.ticket.capability_manifest.allowed_evidence_commands.find((entry) =>
      entry.startsWith('node --test ') && ADMITTED_TESTS.every((file) => entry.includes(file)));
    expect(command).toBeTruthy();
    const startedAt = performance.now();
    execFileSync(process.execPath, ['--test', ...ADMITTED_TESTS], { cwd: source.dir });
    const tests = [{ command, passed: true, exit_code: 0, duration_ms: performance.now() - startedAt }];
    expect(await validateStageReceipt(await prospective(returned, [helper], tests)))
      .toMatchObject({ valid: true, actual_files: [helper] });
    const beforeReplay = await readJson(source.paths.active);
    expect((await recordReceipt(source.dir, payload)).ok).toBe(true);
    const afterReplay = await readJson(source.paths.active);
    expect(afterReplay.claimed_paths).toEqual(production);
    expect(afterReplay.tickets).toEqual(beforeReplay.tickets);
    expect(afterReplay.receipts).toEqual(beforeReplay.receipts);
    expect(afterReplay.recovery_generation).toEqual(beforeReplay.recovery_generation);
    expect(await readFile(ticketFile, 'utf8')).toBe(ticketBytes);
    expect(await readFile(manifestFile, 'utf8')).toBe(manifestBytes);
  }, 90_000);

  it.each(['tests/sibling.test.js', 'tests/uncreated.test.js', 'TESTS/case-sibling.test.js'])(
    'rejects an already-admitted directory descendant as an exact test expansion: %s', async (requested) => {
      const exact = await exactRemediationFixture({ testPaths: ['tests'], physicalTestPaths: ADMITTED_TESTS });
      expect(exact.ticket).toMatchObject({ test_scope: 'exact', test_paths: ['tests/value.test.js'] });
      const manifest = await readRunContractManifest(exact.paths, exact.ticket.capability_manifest.run_contract);
      expect(manifest.capability_catalog.frozen_recovery_authority.run_scope.test_paths).toEqual(['tests']);
      await expectWritePermission(exact, requested, false);
      const payload = draft(exact, { test_paths: [requested] });
      // Local ticket specialization alone cannot see the broad admitted run
      // directory. The authenticated aggregate must reject this at the sink.
      expect(receiptDraftSchemaForTicket(exact.ticket).safeParse(payload).success).toBe(true);
      await validateReceiptForDispatch(exact.dir, payload, exact.ticket.ticket_id);
      async function snapshot(directory) {
        const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
          if (error.code === 'ENOENT') return [];
          throw error;
        });
        return Object.fromEntries(await Promise.all(entries.map(async (entry) => {
          const file = path.join(directory, entry.name);
          return [entry.name, entry.isDirectory() ? await snapshot(file) : await readFile(file, 'utf8')];
        })));
      }
      async function durableAuthority() {
        return Object.fromEntries(await Promise.all([
          'tickets', 'contracts', 'receipts', 'receiptTransactions', 'recoveryGenerations', 'recoverySelectors',
        ].map(async (key) => [key, await snapshot(exact.paths[key])])));
      }
      const before = await durableAuthority();
      const activeBefore = await readJson(exact.paths.active);
      for (const results of [
        await Promise.all([recordReceipt(exact.dir, payload), recordReceipt(exact.dir, payload)]),
        [await recordReceipt(exact.dir, payload)],
      ]) {
        for (const result of results) {
          expect(result).toMatchObject({ ok: false, rejected: true });
          expect(result.errors.join(' ')).toMatch(/test_paths.*(?:already|colli|overlap|additive|admitted)/i);
          expect(result.actions ?? []).toEqual([]);
        }
      }
      expect(await durableAuthority()).toEqual(before);
      const after = await readJson(exact.paths.active);
      expect(after.tickets).toEqual(activeBefore.tickets);
      expect(after.receipts).toEqual(activeBefore.receipts);
      expect(after.recovery_generation).toEqual(activeBefore.recovery_generation);
      await expectWritePermission(exact, requested, false);
      // A disjoint path is still genuinely additive: the directory protection
      // cannot become a blanket ban on exact-scope recovery.
      const added = 'other-tests/new.test.js';
      const successor = await recover(exact, { test_paths: [added] }, 9);
      expect(successor.ticket).toMatchObject({ test_scope: 'exact',
        claimed_paths: ['tests/value.test.js', added], test_paths: ['tests/value.test.js', added] });
      await expectWritePermission(successor, added, true);
      await expectWritePermission(successor, requested, false);
    }, 90_000);

  it.each([
    ['exact sibling', 'tests/ordinary-admitted.test.js'],
    ['case-folded sibling', 'tests/ORDINARY-ADMITTED.test.js'],
  ])('rejects regranting an ordinary admitted %s despite a stale active inventory', async (_label, requested) => {
    const sibling = 'tests/ordinary-admitted.test.js';
    const exact = await exactRemediationFixture({ authoredSibling: sibling });
    const admitted = await readJson(exact.paths.active);
    expect(admitted.test_paths).toEqual([...ADMITTED_TESTS, sibling]);
    expect(admitted.receipts.some((receipt) => receipt.status === 'passed' &&
      receipt.agent.role === 'test_writer' && receipt.changed_files.includes(sibling))).toBe(true);
    const manifest = await readRunContractManifest(exact.paths, exact.ticket.capability_manifest.run_contract);
    expect(manifest.capability_catalog.frozen_recovery_authority.run_scope.test_paths).toEqual(ADMITTED_TESTS);
    expect(manifest.receipt_contract.ticket_contracts.some((entry) =>
      entry.recovery_authority?.test_paths.includes(sibling))).toBe(true);
    expect(exact.ticket).toMatchObject({ test_scope: 'exact', test_paths: ['tests/value.test.js'] });
    await expectWritePermission(exact, sibling, false);

    // Remove only the mutable projection. The ordinary receipt and hashed
    // ticket contracts still authenticate the sibling as already admitted.
    await atomicWriteJson(exact.paths.active, { ...admitted, test_paths: ADMITTED_TESTS });
    const payload = draft(exact, { test_paths: [requested] });
    expect(receiptDraftSchemaForTicket(exact.ticket).safeParse(payload).success).toBe(true);
    const validation = await validateReceiptForDispatch(exact.dir, payload, exact.ticket.ticket_id);
    expect(validation.ok).toBe(true);

    async function snapshot(directory) {
      const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      });
      const result = {};
      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        const file = path.join(directory, entry.name);
        result[entry.name] = entry.isDirectory() ? await snapshot(file) : await readFile(file, 'utf8');
      }
      return result;
    }
    async function durableAuthority() {
      return Object.fromEntries(await Promise.all([
        'tickets', 'contracts', 'receipts', 'receiptTransactions', 'recoveryGenerations', 'recoverySelectors',
      ].map(async (key) => [key, await snapshot(exact.paths[key])])));
    }
    const before = await durableAuthority();
    const activeBefore = await readJson(exact.paths.active);
    const siblingBytes = await readFile(path.join(exact.dir, sibling), 'utf8');
    // Both concurrent callers and a later retry must reject before preparing
    // a successor. Validation may reject earlier, but record remains a sink.
    for (const results of [
      await Promise.all([recordReceipt(exact.dir, payload), recordReceipt(exact.dir, payload)]),
      [await recordReceipt(exact.dir, payload)],
    ]) {
      for (const result of results) {
        expect(result).toMatchObject({ ok: false, rejected: true });
        expect(result.errors.join(' ')).toMatch(/test_paths.*(?:already|colli|overlap|additive)/i);
        expect(result.actions ?? []).toEqual([]);
      }
    }
    expect(await durableAuthority()).toEqual(before);
    const after = await readJson(exact.paths.active);
    expect(after.tickets).toEqual(activeBefore.tickets);
    expect(after.receipts).toEqual(activeBefore.receipts);
    expect(after.recovery_generation).toEqual(activeBefore.recovery_generation);
    expect(await readFile(path.join(exact.dir, sibling), 'utf8')).toBe(siblingBytes);
    await expectWritePermission(exact, sibling, false);
  }, 90_000);

  it('allows a genuinely new exact test grant while retaining ordinary admitted siblings', async () => {
    const sibling = 'tests/ordinary-admitted.test.js';
    const added = 'tests/genuinely-new.test.js';
    const exact = await exactRemediationFixture({ authoredSibling: sibling });
    const admitted = await readJson(exact.paths.active);
    await atomicWriteJson(exact.paths.active, { ...admitted, test_paths: ADMITTED_TESTS });
    const successor = await recover(exact, { test_paths: [added] }, 9);
    expect(successor.ticket).toMatchObject({ role: 'test_writer', test_scope: 'exact',
      claimed_paths: ['tests/value.test.js', added], test_paths: ['tests/value.test.js', added] });
    expect((await readJson(exact.paths.active)).test_paths).toEqual([...ADMITTED_TESTS, sibling, added]);
    await expectWritePermission(successor, added, true);
    await expectWritePermission(successor, sibling, false);
    await expectWritePermission(successor, 'src/value.js', false);
  }, 90_000);

  it.each(['retry', 'concurrent retry'])(
    'retains an ordinary admitted sibling across exact remediation and %s', async (boundary) => {
      const sibling = 'tests/ordinary-admitted.test.js';
      const tests = [...ADMITTED_TESTS, sibling];
      const exact = await exactRemediationFixture({ authoredSibling: sibling });
      const ticketFile = path.join(exact.paths.tickets, `${exact.ticket.ticket_id.replaceAll(':', '_')}.json`);
      const ticketBytes = await readFile(ticketFile, 'utf8');
      const manifestFile = path.join(exact.dir, exact.ticket.capability_manifest.run_contract.ref);
      const manifestBytes = await readFile(manifestFile, 'utf8');
      const manifest = await readRunContractManifest(exact.paths, exact.ticket.capability_manifest.run_contract);
      // The sibling has genuine ordinary receipt authority, but neither the
      // original run inventory nor this exact ticket names it.
      expect(manifest.capability_catalog.frozen_recovery_authority.run_scope.test_paths).toEqual(ADMITTED_TESTS);
      expect(exact.ticket.test_paths).toEqual(['tests/value.test.js']);
      const admitted = await readJson(exact.paths.active);
      expect(admitted.test_paths).toEqual(tests);
      expect(admitted.receipts.some((receipt) => receipt.agent.role === 'test_writer' &&
        receipt.status === 'passed' && receipt.changed_files.includes(sibling))).toBe(true);
      const siblingBytes = await readFile(path.join(exact.dir, sibling), 'utf8');
      const payload = draft(exact, { required_role: 'implementer' });
      expect(await validateReceiptForDispatch(exact.dir, payload, exact.ticket.ticket_id))
        .toMatchObject({ ok: true, valid: true });
      expect(await hook(exact, { hook_event_name: 'SubagentStop', last_assistant_message: JSON.stringify(payload) }))
        .toEqual({});
      const results = boundary === 'concurrent retry'
        ? await Promise.all([recordReceipt(exact.dir, payload), recordReceipt(exact.dir, payload)])
        : [await recordReceipt(exact.dir, payload)];
      for (const result of results) expect(result.ok, JSON.stringify(result)).toBe(true);
      const action = results.flatMap((result) => result.actions).find((entry) => entry.type === 'dispatch_agent');
      expect(action).toBeTruthy();
      const production = { ...exact, action, ticket: action.ticket,
        binding: await bindCodexDispatchContext(root, exact.dir, action, 9) };
      expect((await readJson(exact.paths.active)).tickets.filter((ticket) =>
        ticket.recovery_lineage?.source_ticket_id === exact.ticket.ticket_id)).toHaveLength(1);
      await expectBoundScope(production, ADMITTED_PRODUCTION, tests, ADMITTED_PRODUCTION);
      const command = 'node --test tests/ordinary-admitted.test.js tests/sibling.test.js tests/value.test.js';
      expect(production.ticket.capability_manifest.allowed_evidence_commands).toContain(command);
      await expectWritePermission(production, sibling, false);
      await writeThroughHooks(production, 'src/value.js', `${V2}// productive exact recovery\n`);
      execFileSync(process.execPath, ['--test', ...tests], { cwd: exact.dir });
      const returned = await recover(production, { required_role: 'test_writer' }, 10);
      expect(returned.ticket).toMatchObject({ test_scope: 'exact',
        claimed_paths: ['tests/value.test.js'], test_paths: ['tests/value.test.js'] });
      await expectWritePermission(returned, 'tests/value.test.js', true);
      await expectWritePermission(returned, sibling, false);
      const beforeReplay = await readJson(exact.paths.active);
      expect(beforeReplay.test_paths).toEqual(tests);
      expect((await recordReceipt(exact.dir, payload)).ok).toBe(true);
      const afterReplay = await readJson(exact.paths.active);
      expect(afterReplay.test_paths).toEqual(tests);
      expect(afterReplay.tickets).toEqual(beforeReplay.tickets);
      expect(afterReplay.receipts).toEqual(beforeReplay.receipts);
      expect(afterReplay.recovery_generation).toEqual(beforeReplay.recovery_generation);
      expect(await readFile(path.join(exact.dir, sibling), 'utf8')).toBe(siblingBytes);
      expect(await readFile(ticketFile, 'utf8')).toBe(ticketBytes);
      expect(await readFile(manifestFile, 'utf8')).toBe(manifestBytes);
    }, 90_000);

  it('retains a sibling first authored in the capability-failed receipt and executes it in successor evidence', async () => {
    const source = await fixture({ fullLane: true });
    const sibling = 'tests/new.test.js';
    const tests = [...ADMITTED_TESTS, sibling];
    const command = 'node --test tests/new.test.js tests/sibling.test.js tests/value.test.js';
    const ticketFile = path.join(source.paths.tickets, `${source.ticket.ticket_id.replaceAll(':', '_')}.json`);
    const ticketBytes = await readFile(ticketFile, 'utf8');
    const manifestFile = path.join(source.dir, source.ticket.capability_manifest.run_contract.ref);
    const manifestBytes = await readFile(manifestFile, 'utf8');
    expect(source.ticket.test_paths).not.toContain(sibling);
    // No preceding successful test receipt or explicit path expansion admits
    // this sibling. Only the runtime-sealed diff of this failed receipt does.
    await writeThroughHooks(source, sibling, TEST);
    const build = await recover(source, { required_role: 'implementer' }, 5);
    expect(build.sourceReceipt.changed_files).toEqual([sibling]);
    expect(build.sourceReceipt.head_tree_sha).not.toBe(build.sourceReceipt.base_tree_sha);
    expect(await readFile(path.join(source.dir, sibling), 'utf8')).toBe(TEST);
    await expectBoundScope(build, ADMITTED_PRODUCTION, tests, ADMITTED_PRODUCTION);
    expect(build.ticket.capability_manifest.allowed_evidence_commands).toContain(command);
    await expectWritePermission(build, sibling, false);
    await expectWritePermission(build, 'src/value.js', true);
    await writeThroughHooks(build, 'src/value.js', V2);
    // The generated path-based evidence command must actually run the newly
    // authored test; a correct production implementation satisfies all three.
    execFileSync(process.execPath, ['--test', ...tests], { cwd: source.dir });
    const returned = await recover(build, { required_role: 'test_writer' }, 6);
    await expectBoundScope(returned, ADMITTED_PRODUCTION, tests, tests);
    await expectWritePermission(returned, sibling, true);
    await expectWritePermission(returned, 'src/value.js', false);
    const beforeReplay = await readJson(source.paths.active);
    expect((await recordReceipt(source.dir, build.payload)).ok).toBe(true);
    const afterReplay = await readJson(source.paths.active);
    expect(afterReplay.test_paths).toEqual(tests);
    expect(afterReplay.tickets).toEqual(beforeReplay.tickets);
    expect(afterReplay.receipts).toEqual(beforeReplay.receipts);
    expect(afterReplay.recovery_generation).toEqual(beforeReplay.recovery_generation);
    expect(await readFile(ticketFile, 'utf8')).toBe(ticketBytes);
    expect(await readFile(manifestFile, 'utf8')).toBe(manifestBytes);
  }, 90_000);

  it('retains a sibling admitted by an ordinary test receipt across role recovery and replay', async () => {
    const source = await fixture({ fullLane: true });
    const sibling = 'tests/authored-sibling.test.js';
    const tests = [...ADMITTED_TESTS, sibling];
    const command = 'node --test tests/authored-sibling.test.js tests/sibling.test.js tests/value.test.js';
    // This is a normal test-writer admission, not a required_claims expansion.
    // The runtime must discover the sibling from its independently sealed diff.
    await writeThroughHooks(source, sibling, TEST);
    const tested = await seal(source, draft(source));
    expect(tested.run.receipts.find((entry) => entry.ticket_id === source.ticket.ticket_id)
      .changed_files).toEqual([sibling]);
    const action = tested.actions.find((entry) => entry.type === 'dispatch_agent');
    expect(action.ticket).toMatchObject({ role: 'implementer', test_paths: tests });
    const build = { ...source, action, ticket: action.ticket,
      binding: await bindCodexDispatchContext(root, source.dir, action, 5) };
    const ticketFile = path.join(source.paths.tickets, `${build.ticket.ticket_id.replaceAll(':', '_')}.json`);
    const ticketBytes = await readFile(ticketFile, 'utf8');
    const manifestFile = path.join(source.dir, build.ticket.capability_manifest.run_contract.ref);
    const manifestBytes = await readFile(manifestFile, 'utf8');
    const manifest = await readRunContractManifest(source.paths, build.ticket.capability_manifest.run_contract);
    expect(manifest.capability_catalog.frozen_recovery_authority.run_scope.test_paths).toEqual(ADMITTED_TESTS);
    expect(manifest.receipt_contract.ticket_contracts.find((entry) => entry.ticket_id === build.ticket.ticket_id)
      .recovery_authority.test_paths).toEqual(tests);

    const tester = await recover(build, { required_role: 'test_writer' }, 6);
    await expectBoundScope(tester, ADMITTED_PRODUCTION, tests, tests);
    expect(tester.ticket.capability_manifest.allowed_evidence_commands)
      .toContain(command);
    await expectWritePermission(tester, sibling, true);
    await expectWritePermission(tester, 'src/value.js', false);
    await writeThroughHooks(tester, sibling, `${TEST}// productive sibling correction\n`);

    const returned = await resumeAfterAuthor(tester, 7);
    expect(returned.sourceReceipt.changed_files).toEqual([sibling]);
    await expectBoundScope(returned, ADMITTED_PRODUCTION, tests, ADMITTED_PRODUCTION);
    expect(returned.ticket.capability_manifest.allowed_evidence_commands)
      .toContain(command);
    await expectWritePermission(returned, sibling, false);
    await expectWritePermission(returned, 'src/value.js', true);
    const beforeReplay = await readJson(source.paths.active);
    expect((await recordReceipt(source.dir, tester.payload)).ok).toBe(true);
    const afterReplay = await readJson(source.paths.active);
    expect(afterReplay.test_paths).toEqual(tests);
    expect(afterReplay.tickets).toEqual(beforeReplay.tickets);
    expect(afterReplay.receipts).toEqual(beforeReplay.receipts);
    expect(afterReplay.recovery_generation).toEqual(beforeReplay.recovery_generation);
    expect(await readFile(ticketFile, 'utf8')).toBe(ticketBytes);
    expect(await readFile(manifestFile, 'utf8')).toBe(manifestBytes);
  }, 90_000);

  it('recovers the reported full-lane test-only ticket with a role-only request through validation, stop and record', async () => {
    const source = await fixture({ fullLane: true });
    const sourceFile = path.join(source.paths.tickets, `${source.ticket.ticket_id.replaceAll(':', '_')}.json`);
    const sourceBytes = await readFile(sourceFile, 'utf8');
    const manifestFile = path.join(source.dir, source.ticket.capability_manifest.run_contract.ref);
    const manifestBytes = await readFile(manifestFile, 'utf8');
    const successor = await recover(source, { required_role: 'implementer' }, 5);
    expect(successor.ticket.role).toBe('implementer');
    await expectBoundScope(successor, ADMITTED_PRODUCTION, ADMITTED_TESTS, ADMITTED_PRODUCTION);
    for (const file of ADMITTED_PRODUCTION) await expectWritePermission(successor, file, true);
    for (const file of [...ADMITTED_TESTS, 'src/unadmitted.js', '.ape/runtime/forged.json']) {
      await expectWritePermission(successor, file, false);
    }
    // Real writes and independent receipt attribution prove useful authority,
    // rather than merely inspecting the successor's path arrays.
    await writeThroughHooks(successor, 'scripts/native-test-process.mjs', 'export const value = 2;\n');
    await writeThroughHooks(successor, '.github/test-durations.json', '{"fixture":2}\n');
    expect(await validateStageReceipt(await prospective(successor,
      ['.github/test-durations.json', 'scripts/native-test-process.mjs'])))
      .toMatchObject({ valid: true });
    expect(await readFile(sourceFile, 'utf8')).toBe(sourceBytes);
    expect(await readFile(manifestFile, 'utf8')).toBe(manifestBytes);
  }, 60_000);

  it('retains both inventories and prior additions across productive role round trips', async () => {
    const source = await fixture({ fullLane: true });
    const implementation = await recover(source, {
      required_role: 'implementer', claimed_paths: ['src/added.js'], test_paths: ['tests/added.test.js'],
    }, 5);
    const production = [...ADMITTED_PRODUCTION, 'src/added.js'];
    const tests = [...ADMITTED_TESTS, 'tests/added.test.js'];
    await expectBoundScope(implementation, production, tests, production);
    await writeThroughHooks(implementation, 'src/added.js', 'module.exports = 42;\n');
    const tester = await recover(implementation, { required_role: 'test_writer' }, 6);
    expect(tester.ticket.role).toBe('test_writer');
    await expectBoundScope(tester, production, tests, tests);
    await expectWritePermission(tester, 'tests/added.test.js', true);
    for (const file of production) await expectWritePermission(tester, file, false);
    await writeThroughHooks(tester, 'tests/added.test.js', "require('node:assert/strict').equal(42, 42);\n");
    // A new canonical grant is material progress even when returning to an
    // already-issued role. The original production paths must remain usable.
    const returned = await recover(tester, {
      required_role: 'implementer', claimed_paths: ['src/second.js'],
    }, 7);
    await expectBoundScope(returned, [...production, 'src/second.js'], tests, [...production, 'src/second.js']);
    await expectWritePermission(returned, 'scripts/native-test-process.mjs', true);
    await expectWritePermission(returned, 'tests/added.test.js', false);
    expect((await recordReceipt(source.dir, implementation.payload)).ok).toBe(true);
    expect((await readJson(source.paths.active)).tickets.at(-1)).toEqual(returned.ticket);
  }, 60_000);

  it('blocks an unchanged v4 role cycle without publishing another successor or generation', async () => {
    const source = await fixture({ fullLane: true });
    expect((await readJson(source.paths.active)).execution_policy.version).toBe(4);
    const implementation = await recover(source, { required_role: 'implementer' }, 5);
    const before = await readJson(source.paths.active);
    const ticketFiles = (await readdir(source.paths.tickets)).sort();
    const generations = (await readdir(source.paths.recoveryGenerations)).sort();
    const payload = draft(implementation, { required_role: 'test_writer' });
    const result = await seal(implementation, payload);
    expect(result.actions.some((entry) => entry.type === 'dispatch_agent')).toBe(false);
    expect(result.run).toMatchObject({ status: 'blocked', terminal_reason_code: 'capability_blocked' });
    expect(result.run.block_reason).toMatch(/capability|progress|cycl/i);
    expect(result.run.tickets).toEqual(before.tickets);
    expect(result.run.recovery_generation).toEqual(before.recovery_generation);
    expect((await readdir(source.paths.tickets)).sort()).toEqual(ticketFiles);
    expect((await readdir(source.paths.recoveryGenerations)).sort()).toEqual(generations);
    const replay = await recordReceipt(source.dir, payload);
    expect(replay.ok).toBe(true);
    expect(replay.run.tickets).toEqual(before.tickets);
  }, 60_000);

  it.each(['tests/value.test.js', 'src/unadmitted.js'])('rejects post-validation implementer drift in %s at the receipt and stop sinks', async (file) => {
    const source = await fixture({ fullLane: true });
    const value = await recover(source, { required_role: 'implementer' }, 5);
    const payload = draft(value, { claimed_paths: ['src/new-authority.js'] });
    expect(await validateReceiptForDispatch(value.dir, payload)).toMatchObject({ valid: true });
    await expectWritePermission(value, file, false);
    await writeFile(path.join(value.dir, file), 'module.exports = 99;\n');
    expect((await validateStageReceipt(await prospective(value, [file]))).valid).toBe(false);
    expect(await hook(value, { hook_event_name: 'SubagentStop', last_assistant_message: JSON.stringify(payload) }))
      .toMatchObject({ decision: 'block' });
  }, 60_000);

  it('keeps successor schema semantics additive and role-specific', async () => {
    const source = await fixture({ fullLane: true });
    const value = await recover(source, { required_role: 'implementer' }, 5);
    const roleEnum = value.ticket.output_schema.properties.evidence.properties.required_claims.properties.required_role.enum;
    expect(roleEnum).toContain('test_writer');
    expect(roleEnum).not.toContain('implementer');
    for (const claims of [{ claimed_paths: ['src/new.js'] }, { required_role: 'test_writer' }]) {
      expect(receiptDraftSchemaForTicket(value.ticket).safeParse(draft(value, claims)).success).toBe(true);
    }
    for (const claims of [{ claimed_paths: ['scripts/native-test-process.mjs'] },
      { claimed_paths: ['.ape/runtime/forged.js'] }, { required_role: 'implementer' }]) {
      expect(receiptDraftSchemaForTicket(value.ticket).safeParse(draft(value, claims)).success).toBe(false);
    }
  }, 60_000);

  it('preserves an exact remediation subset through production recovery and a productive return', async () => {
    const exact = await exactRemediationFixture();
    const production = await recover(exact, { required_role: 'implementer' }, 9);
    expect(production.ticket.claimed_paths).toEqual(ADMITTED_PRODUCTION);
    await writeThroughHooks(production, 'src/value.js', `${V2}// productive correction\n`);
    const returned = await recover(production, { required_role: 'test_writer' }, 10);
    expect(returned.ticket).toMatchObject({ test_scope: 'exact',
      test_paths: ['tests/value.test.js'], claimed_paths: ['tests/value.test.js'] });
    expect((await readJson(exact.paths.active)).test_paths).toEqual(ADMITTED_TESTS);
    await expectWritePermission(returned, 'tests/value.test.js', true);
    await expectWritePermission(returned, 'tests/sibling.test.js', false);
    await expectWritePermission(returned, 'src/value.js', false);
    await writeFile(path.join(exact.dir, 'tests/sibling.test.js'), `${TEST}// unauthorized sibling\n`);
    expect((await validateStageReceipt(await prospective(returned, ['tests/sibling.test.js']))).valid).toBe(false);
    expect(await hook(returned, { hook_event_name: 'SubagentStop', last_assistant_message: JSON.stringify(draft(returned)) }))
      .toMatchObject({ decision: 'block' });
  }, 90_000);

  it.each(['edit', 'delete', 'productive return'])
  ('protects a configured nonstandard sibling test during exact implementation recovery: %s', async (operation) => {
    // The broad production claim deliberately contains a configured test whose
    // name cannot trigger conventional test-name heuristics. Its protection
    // must survive narrowing the remediation writer to a different test.
    const sibling = 'src/checks/rules.js';
    const productionPaths = ['src', 'scripts/native-test-process.mjs', '.github/test-durations.json'];
    const testPaths = [...ADMITTED_TESTS, sibling];
    const exact = await exactRemediationFixture({ productionPaths, testPaths });
    const ticketFile = path.join(exact.paths.tickets, `${exact.ticket.ticket_id.replaceAll(':', '_')}.json`);
    const ticketBytes = await readFile(ticketFile, 'utf8');
    const siblingBytes = await readFile(path.join(exact.dir, sibling), 'utf8');
    const production = await recover(exact, { required_role: 'implementer' }, 9);
    expect(production.ticket.claimed_paths).toEqual(productionPaths);
    expect((await readJson(exact.paths.active)).test_paths).toEqual(testPaths);
    await writeThroughHooks(production, 'src/value.js', `${V2}// productive correction\n`);
    const payload = draft(production, { required_role: 'test_writer' });
    expect(await validateReceiptForDispatch(exact.dir, payload)).toMatchObject({ valid: true });

    // Soft assertions let each independent sink observe the defect even when
    // the initial pre-write check has already admitted the forbidden action.
    expect.soft(await hook(production, { hook_event_name: 'PreToolUse', tool_name: 'Write',
      tool_input: { file_path: path.join(exact.dir, sibling), content: '// changed configured test\n' } }))
      .toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
    expect.soft(await hook(production, { hook_event_name: 'PreToolUse', tool_name: 'Bash',
      cwd: exact.dir, tool_input: { command: `rm ${sibling}` } }))
      .toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });

    if (operation === 'productive return') {
      const returned = await recover(production, { required_role: 'test_writer' }, 10);
      expect(returned.ticket).toMatchObject({ role: 'test_writer', test_scope: 'exact',
        claimed_paths: ['tests/value.test.js'], test_paths: ['tests/value.test.js'] });
      await expectWritePermission(returned, 'tests/value.test.js', true);
      for (const file of [sibling, 'tests/sibling.test.js', 'src/value.js']) {
        await expectWritePermission(returned, file, false);
      }
      await writeThroughHooks(returned, 'tests/value.test.js', `${TEST}// exact correction\n`);
      expect(returned.ticket.required_checks).toContain('targeted-tests');
      const missingEvidence = await validateStageReceipt(await prospective(returned, ['tests/value.test.js']));
      expect(missingEvidence.valid).toBe(false);
      expect(missingEvidence.errors).toContain('required targeted-tests evidence is missing');
      const command = 'node --test tests/value.test.js';
      expect(returned.ticket.capability_manifest.allowed_evidence_commands).toContain(command);
      const startedAt = performance.now();
      execFileSync(process.execPath, ['--test', 'tests/value.test.js'], { cwd: returned.dir });
      const tests = [{ command, passed: true, exit_code: 0, duration_ms: performance.now() - startedAt }];
      expect(await validateStageReceipt(await prospective(returned, ['tests/value.test.js'], tests)))
        .toMatchObject({ valid: true, actual_files: ['tests/value.test.js'] });
      expect(await readFile(path.join(exact.dir, sibling), 'utf8')).toBe(siblingBytes);
      expect((await readJson(exact.paths.active)).test_paths).toEqual(testPaths);
    } else {
      // Inject the mutation after successful draft validation and immediately
      // before the receipt/result sinks; an earlier permission check is not
      // evidence that the tree still respects role separation at adoption.
      if (operation === 'delete') await rm(path.join(exact.dir, sibling));
      else await writeFile(path.join(exact.dir, sibling), '// changed configured test\n');
      expect.soft((await validateStageReceipt(await prospective(production,
        [sibling, 'src/value.js']))).valid).toBe(false);
      expect.soft(await hook(production, { hook_event_name: 'SubagentStop',
        last_assistant_message: JSON.stringify(payload) })).toMatchObject({ decision: 'block' });
    }
    expect(await readFile(ticketFile, 'utf8')).toBe(ticketBytes);
  }, 90_000);
});

describe('capability recovery source-tree handoff', () => {
  it.each([true, false])('allows an unchanged read-only successor to finish (production handoff: %s)', async (productionChange) => {
    const value = await handoff('debugger', { productionChange });
    expect(value.ticket.writable).toBe(false);
    expect(await validateStageReceipt(await prospective(value, [])))
      .toMatchObject({ valid: true, actual_files: [] });
    const payload = draft(value);
    expect(await validateReceiptForDispatch(value.dir, payload)).toMatchObject({ valid: true });
    expect(await hook(value, { hook_event_name: 'SubagentStop', last_assistant_message: JSON.stringify(payload) }))
      .toEqual({});
    expect(await invokeCodexHook(root, {
      hook_event_name: 'PostToolUse', project_dir: value.dir,
      session_id: `wire-2-${value.ticket.ticket_id}`, turn_id: 'turn-1',
      tool_name: 'collaborationspawn_agent', tool_use_id: 'spawn-2',
      tool_response: { agent_id: value.binding.agentId, output: JSON.stringify(payload) },
    })).toEqual({});
    const result = await recordReceipt(value.dir, payload);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.run.receipts.find((entry) => entry.ticket_id === value.ticket.ticket_id).changed_files).toEqual([]);
    expect(await readFile(value.sourceFile, 'utf8')).toBe(value.sourceBytes);
  }, 30_000);

  it('allows unchanged same-role read-only recovery through consecutive receipt boundaries', async () => {
    const first = await handoff('debugger');
    const result = await seal(first, draft(first, { claimed_paths: ['src/extra.js'] }));
    const sourceReceipt = result.run.receipts.find((entry) => entry.ticket_id === first.ticket.ticket_id);
    expect(sourceReceipt.changed_files).toEqual([]);
    const action = result.actions.find((entry) => entry.type === 'dispatch_agent');
    expect(action.ticket).toMatchObject({ role: 'debugger', writable: false });
    const next = { ...first, action, ticket: action.ticket,
      binding: await bindCodexDispatchContext(root, first.dir, action, 3) };
    const completed = await seal(next, draft(next));
    expect(completed.run.receipts.find((entry) => entry.ticket_id === next.ticket.ticket_id).changed_files).toEqual([]);
    expect(await readFile(first.sourceFile, 'utf8')).toBe(first.sourceBytes);
  }, 30_000);

  it.each(['unauthorized drift', 'invalid source evidence'])('rejects a read-only successor result after %s', async (fault) => {
    const value = await handoff('debugger');
    const payload = draft(value);
    expect(await validateReceiptForDispatch(value.dir, payload)).toMatchObject({ valid: true });
    // Inject faults after exact draft validation, immediately before result adoption.
    // Even inherited claimed production paths confer no read-only write authority.
    if (fault === 'unauthorized drift') {
      await writeFile(path.join(value.dir, 'src/value.js'), V1);
    } else {
      const state = await readJson(value.paths.active);
      state.receipts.find((entry) => entry.receipt_id === value.sourceReceipt.receipt_id).receipt_hash = '0'.repeat(64);
      state.tree_sha = await currentTreeSha(value.dir);
      await atomicWriteJson(value.paths.active, state);
    }
    const checked = await validateStageReceipt(await prospective(value,
      fault === 'unauthorized drift' ? ['src/value.js'] : []))
      .catch((error) => ({ valid: false, errors: [error.message] }));
    expect(checked.valid, JSON.stringify(checked)).toBe(false);
    expect(await hook(value, { hook_event_name: 'SubagentStop', last_assistant_message: JSON.stringify(payload) }))
      .toMatchObject({ decision: 'block' });
    expect(await readFile(value.sourceFile, 'utf8')).toBe(value.sourceBytes);
  }, 30_000);

  it.each(['test_writer', 'implementer'])('attributes only the %s successor diff through hooks and receipts', async (role) => {
    const value = await handoff(role);
    const file = role === 'test_writer' ? 'tests/value.test.js' : 'src/extra.js';
    await writeThroughHooks(value, file, role === 'test_writer' ? TEST : 'module.exports = 42;\n');
    expect(await validateStageReceipt(await prospective(value, [file])))
      .toMatchObject({ valid: true, actual_files: [file] });
    const payload = draft(value);
    expect(await validateReceiptForDispatch(value.dir, payload)).toMatchObject({ valid: true });
    expect(await hook(value, { hook_event_name: 'SubagentStop', last_assistant_message: JSON.stringify(payload) })).toEqual({});
    expect(await invokeCodexHook(root, {
      hook_event_name: 'PostToolUse', project_dir: value.dir,
      session_id: `wire-2-${value.ticket.ticket_id}`, turn_id: 'turn-1',
      tool_name: 'collaborationspawn_agent', tool_use_id: 'spawn-2',
      tool_response: { agent_id: value.binding.agentId, output: JSON.stringify(payload) },
    })).toEqual({});
    const result = await recordReceipt(value.dir, payload);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.run.receipts.find((entry) => entry.ticket_id === value.ticket.ticket_id).changed_files).toEqual([file]);
    expect(await readFile(value.sourceFile, 'utf8')).toBe(value.sourceBytes);
    expect(createHash('sha256').update(await readFile(value.sourceFile)).digest('hex'))
      .toBe(createHash('sha256').update(value.sourceBytes).digest('hex'));
  }, 30_000);

  it.each([
    ['edit inherited production', 'src/value.js', 'module.exports = { value: 333 };\n'],
    ['revert inherited production', 'src/value.js', V1],
    ['unclaimed production', 'src/foreign.js', 'module.exports = true;\n'],
    ['unauthorized tests', 'elsewhere/foreign.test.js', TEST],
  ])('rejects %s after a valid handoff at both boundaries', async (_label, file, content) => {
    const value = await handoff();
    expect(await hook(value, { hook_event_name: 'PreToolUse', tool_name: 'Write',
      tool_input: { file_path: path.join(value.dir, file), content } }))
      .toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
    // Out-of-protocol mutation is injected after the write check and before
    // the result/receipt sinks; attribution must recheck complete contents.
    await mkdir(path.dirname(path.join(value.dir, file)), { recursive: true });
    await writeFile(path.join(value.dir, file), content);
    const checked = await validateStageReceipt(await prospective(value, [file]));
    expect(checked.valid, JSON.stringify(checked)).toBe(false);
    expect(await hook(value, { hook_event_name: 'SubagentStop', last_assistant_message: JSON.stringify(draft(value)) }))
      .toMatchObject({ decision: 'block' });
    expect(await readFile(value.sourceFile, 'utf8')).toBe(value.sourceBytes);
  }, 30_000);

  it('does not exempt inherited file names from a same-role successor scope', async () => {
    const value = await handoff('implementer');
    await writeFile(path.join(value.dir, 'src/foreign.js'), 'module.exports = 7;\n');
    expect((await validateStageReceipt(await prospective(value, ['src/foreign.js']))).valid).toBe(false);
    expect(await hook(value, { hook_event_name: 'SubagentStop', last_assistant_message: JSON.stringify(draft(value)) }))
      .toMatchObject({ decision: 'block' });
  }, 30_000);

  it('rejects an ambiguous pending writer at the parent result boundary', async () => {
    const value = await handoff();
    await writeFile(path.join(value.dir, 'tests/value.test.js'), TEST);
    const state = await readJson(value.paths.active);
    const rival = finalizeTicket({ ...value.ticket,
      ticket_id: `${state.run_id}:build:${randomUUID()}` });
    state.tickets.push(rival);
    await atomicWriteJson(value.paths.active, state);
    expect(await invokeCodexHook(root, {
      hook_event_name: 'PostToolUse', project_dir: value.dir,
      session_id: 'unbound-result-parent', tool_use_id: 'ambiguous-result',
      tool_name: 'collaborationspawn_agent', tool_response: { output: 'complete' },
    })).toMatchObject({ decision: 'block' });
    expect(await readFile(value.sourceFile, 'utf8')).toBe(value.sourceBytes);
  }, 30_000);

  it('carries independently sealed production changes through two recovery hops without replay rollback', async () => {
    const first = await handoff('implementer');
    await writeThroughHooks(first, 'src/extra.js', 'module.exports = 42;\n');
    const secondPayload = draft(first, { required_role: 'test_writer', test_paths: ['tests/value.test.js'] });
    const second = await seal(first, secondPayload);
    const middleReceipt = second.run.receipts.find((entry) => entry.ticket_id === first.ticket.ticket_id);
    expect(middleReceipt.changed_files).toEqual(['src/extra.js']);
    const action = second.actions.find((entry) => entry.type === 'dispatch_agent');
    const value = { ...first, action, ticket: action.ticket,
      binding: await bindCodexDispatchContext(root, first.dir, action, 3) };
    const beforeReplay = await readJson(value.paths.active);
    expect((await recordReceipt(value.dir, first.payload)).ok).toBe(true);
    const afterReplay = await readJson(value.paths.active);
    expect(afterReplay.tickets).toEqual(beforeReplay.tickets);
    expect(afterReplay.receipts).toEqual(beforeReplay.receipts);
    expect(afterReplay.recovery_generation).toEqual(beforeReplay.recovery_generation);
    await writeThroughHooks(value, 'tests/value.test.js', TEST);
    expect(await validateStageReceipt(await prospective(value, ['tests/value.test.js'])))
      .toMatchObject({ valid: true, actual_files: ['tests/value.test.js'] });
    const result = await seal(value, draft(value));
    expect(result.run.receipts.find((entry) => entry.ticket_id === value.ticket.ticket_id).changed_files)
      .toEqual(['tests/value.test.js']);
    expect(await readFile(first.sourceFile, 'utf8')).toBe(first.sourceBytes);
  }, 30_000);

  it.each(['missing source', 'receipt hash', 'source run', 'source role', 'source diff', 'unresolved tree',
    'ticket hash', 'parent link', 'input binding', 'lineage cycle'])
  ('independently rejects %s even with an empty successor diff and a current mutable tree', async (fault) => {
    const value = await handoff();
    const args = await prospective(value, []);
    args.state.tree_sha = args.receipt.head_tree_sha;
    const index = args.state.receipts.findIndex((entry) => entry.receipt_id === value.sourceReceipt.receipt_id);
    const corrupted = structuredClone(args.state.receipts[index]);
    if (fault === 'missing source') args.state.receipts.splice(index, 1);
    else if (fault === 'receipt hash') args.state.receipts[index].receipt_hash = '0'.repeat(64);
    else if (fault === 'source run') corrupted.run_id = 'run-foreign';
    else if (fault === 'source role') corrupted.agent.role = 'test_writer';
    else if (fault === 'source diff') corrupted.changed_files = [];
    else if (fault === 'unresolved tree') corrupted.head_tree_sha = '0'.repeat(40);
    else {
      const ticket = structuredClone(value.ticket);
      if (fault === 'ticket hash') ticket.recovery_provenance.source_ticket_hash = '0'.repeat(64);
      if (fault === 'parent link') ticket.parent_hash = '0'.repeat(64);
      if (fault === 'input binding') ticket.recovery_provenance.receipt_input_hash = '0'.repeat(64);
      if (fault === 'lineage cycle') ticket.recovery_lineage.source_ticket_id = ticket.ticket_id;
      args.ticket = finalizeTicket(ticket);
      args.state.tickets = args.state.tickets.map((entry) => entry.ticket_id === ticket.ticket_id ? args.ticket : entry);
      args.receipt = finalizeReceipt({ ...args.receipt, ticket_hash: args.ticket.ticket_hash });
    }
    if (['source run', 'source role', 'source diff', 'unresolved tree'].includes(fault)) {
      args.state.receipts[index] = finalizeReceipt(corrupted);
    }
    const checked = await validateStageReceipt(args).catch((error) => ({ valid: false, errors: [error.message] }));
    expect(checked.valid, JSON.stringify(checked)).toBe(false);
    // Hook reads its own evidence; no receipt-service baseline is supplied.
    await atomicWriteJson(value.paths.active, args.state);
    expect(await hook(value, { hook_event_name: 'PreToolUse', tool_name: 'Write',
      tool_input: { file_path: path.join(value.dir, 'tests/value.test.js'), content: TEST } }))
      .toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
    expect(await readFile(value.sourceFile, 'utf8')).toBe(value.sourceBytes);
  }, 30_000);
});
