import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { startRun, recordReceipt, recoverReceipt, validateReceiptForDispatch, executeApeRunTaskOperation } from '../lib/runtime/service.js';
import { observeCodexSubagentStop } from '../lib/runtime/claude-dispatch.js';
import { receiptInputHash } from '../lib/runtime/receipt-input.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { atomicWriteJson } from '../lib/runtime/storage.js';
import { bindCodexDispatchContext } from './codex-native-test-helper.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cleanups = [];
afterEach(async () => Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

async function nativeCapabilityFixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-task-native-recovery-'));
  cleanups.push(dir);
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  await mkdir(path.join(dir, 'src'));
  await mkdir(path.join(dir, 'tests'));
  await writeFile(path.join(dir, 'src/value.js'), 'module.exports = { value: 1 };\n');
  await writeFile(path.join(dir, 'tests/value.test.js'), 'throw new Error("placeholder");\n');
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'ape@example.test');
  git('config', 'user.name', 'APE Test');
  git('add', '.');
  git('commit', '-qm', 'fixture baseline');
  const paths = runtimePaths(dir);
  await atomicWriteJson(paths.config, {
    shipping: { auto_merge: false, provider: 'github', required_remote_checks: false },
    test_commands: { full: 'node -e "process.exit(0)"', targeted: 'node tests/value.test.js' },
  });
  const started = await startRun(dir, {
    objective: 'Recover a missing test capability', mode: 'phase', lane: 'auto', host: 'codex',
    claimed_paths: ['src/value.js'], test_paths: ['tests/value.test.js'], requirements: [], risk_triggers: [],
    behavioral: true, hooks_trusted: true, subagents_available: true, explicit_invocation: true,
    binding_protocol: 'native-v1', capability_contract_required: true,
  });
  expect(started.ok, JSON.stringify(started.errors)).toBe(true);
  const dispatch = started.actions.find((entry) => entry.type === 'dispatch_agent');
  const binding = await bindCodexDispatchContext(root, dir, dispatch);
  const receipt = {
    ticket_id: dispatch.ticket.ticket_id, status: 'failed', tests: [], findings: [],
    evidence: { failure_kind: 'capability', summary: 'Need one additional test path.', required_claims: { test_paths: ['tests/extra.test.js'] } },
    receipt_capability: binding.capability,
  };
  return { dir, paths, started, binding, receipt };
}

describe('task-backed native capability recovery', () => {
  it.each(['record', 'recover-receipt'])('preserves the held lease and replay semantics for %s', async (action) => {
    const { dir, paths, started, binding, receipt } = await nativeCapabilityFixture();
    const recovery = { reason: 'Recover this exact stopped worker draft.', receipt_input_hash: receiptInputHash(receipt) };
    if (action === 'record') {
      expect(await validateReceiptForDispatch(dir, receipt)).toMatchObject({ valid: true });
    } else {
      expect(await observeCodexSubagentStop(paths, started.run, {
        session_id: binding.sessionId, turn_id: binding.turnId, agent_id: binding.agentId, agent_type: 'default',
      })).toMatchObject({ observed: true });
    }
    const operation = {
      operationId: `op-${'L'.repeat(43)}`, action, expectedRunId: started.run.run_id,
      request: { action, receipt, ...(action === 'recover-receipt' ? recovery : {}) },
    };
    const tasked = await executeApeRunTaskOperation(dir, operation);
    expect(tasked.ok, JSON.stringify(tasked)).toBe(true);
    if (action === 'record') {
      expect(tasked.actions.some((entry) => entry.type === 'dispatch_agent')).toBe(true);
    } else {
      // Operator receipt recovery records the exact failure; it does not
      // grant automatic capability expansion on the worker's behalf.
      expect(tasked).toMatchObject({ recovered: 'operator-receipt', run: { status: 'blocked', terminal_reason_code: 'capability_blocked' } });
    }
    const after = await readFile(paths.active, 'utf8');
    expect(await executeApeRunTaskOperation(dir, operation)).toEqual(tasked);
    expect(await readFile(paths.active, 'utf8')).toBe(after);
    const ordinary = action === 'record'
      ? await recordReceipt(dir, receipt)
      : await recoverReceipt(dir, receipt, recovery);
    expect(ordinary.ok, JSON.stringify(ordinary.errors)).toBe(true);
    expect(await readFile(paths.active, 'utf8')).toBe(after);
  });
});
