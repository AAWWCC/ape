import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { startRun, recordReceipt, validateReceiptForDispatch } from '../lib/runtime/service.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { atomicWriteJson, readJson } from '../lib/runtime/storage.js';
import { currentTreeSha } from '../lib/runtime/git.js';
import { finalizeReceipt, finalizeTicket } from '../lib/runtime/schemas.js';
import { validateStageReceipt } from '../lib/runtime/receipt-validator.js';
import { bindCodexDispatchContext, invokeCodexHook } from './codex-native-test-helper.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cleanups = [];
const V1 = 'module.exports = { value: 1 };\n';
const V2 = 'module.exports = { value: 22 };\n';
const TEST = "const assert = require('node:assert/strict');\nassert.equal(require('../src/value.js').value, 22);\n";
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-tree-handoff-'));
  cleanups.push(dir);
  await mkdir(path.join(dir, 'src'));
  await mkdir(path.join(dir, 'tests'));
  await writeFile(path.join(dir, 'src/value.js'), V1);
  for (const args of [['init', '-q'], ['config', 'user.email', 'ape@example.test'],
    ['config', 'user.name', 'APE Test'], ['add', '.'], ['commit', '-qm', 'fixture']]) {
    execFileSync('git', args, { cwd: dir });
  }
  const paths = runtimePaths(dir);
  await atomicWriteJson(paths.config, {
    shipping: { auto_merge: false, provider: 'github', required_remote_checks: false },
    test_commands: { full: 'node --test', targeted_template: 'node --test {paths}' },
  });
  const started = await startRun(dir, {
    objective: 'Preserve production work while recovering exact test authority',
    mode: 'phase', lane: 'fast', host: 'codex', behavioral: false,
    claimed_paths: ['src/value.js'], test_paths: [], requirements: [], risk_triggers: [],
    hooks_trusted: true, subagents_available: true, explicit_invocation: true,
    binding_protocol: 'native-v1', capability_contract_required: true,
  });
  expect(started.ok, JSON.stringify(started)).toBe(true);
  const action = started.actions.find((entry) => entry.type === 'dispatch_agent');
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

async function prospective(value, changedFiles) {
  const state = await readJson(value.paths.active);
  const receipt = finalizeReceipt({
    ...value.sourceReceipt, receipt_id: randomUUID(), ticket_id: value.ticket.ticket_id,
    ticket_hash: value.ticket.ticket_hash, status: 'passed',
    agent: { ...value.sourceReceipt.agent, role: value.ticket.role, identity: value.binding.agentId },
    base_tree_sha: value.ticket.base_tree_sha, head_tree_sha: await currentTreeSha(value.dir),
    changed_files: changedFiles, tests: [], findings: [], evidence: { summary: 'Successor work' },
    timing: { started_at: value.ticket.issued_at, completed_at: value.ticket.issued_at, duration_ms: 0 },
    previous_receipt_hash: state.receipts.at(-1).receipt_hash,
  });
  return { project_dir: value.dir, state, ticket: value.ticket, receipt };
}

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
