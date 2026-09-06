import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { inspectAdmissionRepository } from '../lib/runtime/admission.js';
import { admittedStartIdentityHash } from '../lib/runtime/admitted-start-identity.js';
import { hashRecord, sha256 } from '../lib/runtime/canonical.js';
import { projectRunDiagnostic, validatedArchiveSnapshot } from '../lib/runtime/diagnostics.js';
import { archiveRun, explainRun } from '../lib/runtime/history.js';
import { RECEIPT_INPUT_MAX_BYTES, TASK_REQUEST_MAX_BYTES } from '../lib/runtime/input-guard.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { RUNTIME_STATE_MAX_BYTES } from '../lib/runtime/resource-limits.js';
import {
  acknowledgeTaskUpdate,
  appendTaskGeneration,
  collectExpiredTasks,
  createOperationId,
  createTask,
  getTask,
  requestTaskCancellation,
} from '../lib/runtime/task-store.js';

const scratches = [];
const owner = {
  processId: process.pid,
  processStartedAt: '2026-09-06T00:00:00.000Z',
  instanceId: 'storage-boundary-fixture',
};

async function scratch() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ape-storage-boundary-'));
  scratches.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(scratches.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function completedState(repository) {
  const state = {
    schema_version: '2.0.0',
    run_id: 'run-admission-archive-boundary',
    objective: 'Review an admitted repository change',
    mode: 'land',
    lane: 'full',
    host: 'codex',
    status: 'completed',
    stage: 'completed',
    dispatch_state: 'none',
    created_at: '2026-09-06T00:00:00.000Z',
    completed_at: '2026-09-06T00:01:00.000Z',
    requirements: [],
    tickets: [],
    receipts: [],
    admission: { version: 1, digest: sha256(repository), manifest: { repository } },
    admitted_start_identity_version: 1,
    start_request_hash: 'a'.repeat(64),
  };
  state.admitted_start_identity_hash = admittedStartIdentityHash(state);
  return state;
}

function hashedRecord(repository) {
  const state = completedState(repository);
  return { ...state, record_hash: hashRecord(state, ['record_hash', 'completed_at', 'timing']) };
}

describe('archive validation follows admitted repository capacity', () => {
  it('archives and explains an actual admitted 257-file diff without calling it incomplete', async () => {
    const root = await scratch();
    const git = (args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
    git(['init', '-b', 'main']);
    git(['-c', 'user.name=Audit Fixture', '-c', 'user.email=audit@example.invalid',
      'commit', '--allow-empty', '--no-gpg-sign', '-m', 'fixture baseline']);
    await mkdir(path.join(root, 'src'));
    await Promise.all(Array.from({ length: 257 }, (_, index) =>
      writeFile(path.join(root, 'src', `${index}.js`), 'fixture\n')));
    const repository = await inspectAdmissionRepository(root, { mode: 'land' });
    expect(repository.changed_paths).toHaveLength(257);

    const archived = await archiveRun(runtimePaths(root), completedState(repository));
    expect(archived.admission.manifest.repository.changed_content).toHaveLength(257);
    expect(validatedArchiveSnapshot(archived)?.hashVerified).toBe(true);
    expect(projectRunDiagnostic(archived, { archived: true }).reason_code).toBe('completed');
    expect(explainRun(archived)).not.toContain('Reason code: incomplete_record');

    // The larger reader must still verify every retained byte, including the
    // tail that the old observer limit would never reach.
    archived.admission.manifest.repository.changed_content[256].sha256 = '0'.repeat(64);
    expect(validatedArchiveSnapshot(archived)).toBeNull();
  }, 60_000);

  it.each([256, 257, 2048])('preserves hash-valid admission collections at %i paths', (count) => {
    const paths = Array.from({ length: count }, (_, index) => `src/${index}.js`);
    const record = hashedRecord({
      staged_paths: [], runtime_paths_staged: [], unstaged_paths: paths,
      conflict_paths: [], dirty_paths: paths, changed_paths: paths,
      changed_content: paths.map((file) => ({ path: file, kind: 'file', size: 1, sha256: 'a'.repeat(64) })),
    });
    const validated = validatedArchiveSnapshot(record);
    expect(validated?.hashVerified).toBe(true);
    expect(validated?.snapshot.admission.manifest.repository.changed_paths).toHaveLength(count);
    expect(projectRunDiagnostic(record, { archived: true }).reason_code).toBe('completed');
  });

  it('refuses oversized admission arrays without reading accessor-backed tails', () => {
    const paths = Array.from({ length: 2049 }, (_, index) => `src/${index}.js`);
    let reads = 0;
    Object.defineProperty(paths, 2048, { get() { reads += 1; throw new Error('unexpected tail read'); } });
    expect(validatedArchiveSnapshot({ admission: { manifest: { repository: { changed_paths: paths } } } })).toBeNull();
    expect(reads).toBe(0);
  });

  it('validates complete hash-bearing collections within the shared byte budget', () => {
    const excessive = Array.from({ length: 257 }, () => ({}));
    for (const record of [
      { tickets: excessive },
      { admission: { manifest: { repository: { unknown_paths: excessive } } } },
      { 'admission.manifest.repository.changed_paths': excessive },
      { admission: { manifest: { repository: { changed_content: [{ nested: excessive }] } } } },
    ]) expect(validatedArchiveSnapshot(record)?.snapshot).toEqual(record);
  });
  it('accepts an exactly 8 MiB archive, rejects one extra byte, and preserves hash validation', () => {
    const record = hashedRecord({ changed_paths: [] });
    record.extra = '';
    record.extra = 'x'.repeat(RUNTIME_STATE_MAX_BYTES - Buffer.byteLength(JSON.stringify(record)));
    record.record_hash = hashRecord(record, ['record_hash', 'completed_at', 'timing']);
    expect(Buffer.byteLength(JSON.stringify(record))).toBe(RUNTIME_STATE_MAX_BYTES);
    expect(validatedArchiveSnapshot(record)?.hashVerified).toBe(true);
    expect(projectRunDiagnostic(record, { archived: true }).reason_code).toBe('completed');
    record.extra += 'x';
    record.record_hash = hashRecord(record, ['record_hash', 'completed_at', 'timing']);
    expect(validatedArchiveSnapshot(record)).toBeNull();
  });

  it('validates lifecycle collections after 256 and rejects a malformed tail', () => {
    const record = completedState({});
    record.tickets = Array.from({ length: 257 }, (_, i) => ({ ticket_id: `ticket-${i}`, stage_id: 'build', role: 'implementer' }));
    expect(projectRunDiagnostic(record).reason_code).toBe('completed');
    record.tickets[256].role = 'not-a-role';
    expect(projectRunDiagnostic(record).reason_code).toBe('corrupt_state');
    let reads = 0;
    Object.defineProperty(record.tickets[256], 'role', { get() { reads += 1; return 'implementer'; } });
    expect(projectRunDiagnostic(record).reason_code).toBe('corrupt_state');
    expect(reads).toBe(0);
  });

});

async function seedLegacyTask(root, generation = 1024) {
  const task = await createTask(root, {
    operationId: createOperationId(), action: 'next', request: { action: 'next' }, owner,
  });
  const directory = path.join(root, '.ape', 'runtime', 'tasks', task.taskId);
  const records = [];
  let previous = task;
  // Seed an existing immutable chain, rather than making a thousand API calls
  // that re-read all previous generations. This also exercises compatibility
  // with the exact ordinary-generation ceiling of the previous release.
  for (let index = 1; index <= generation; index += 1) {
    const material = { ...previous, generation: index, previousHash: previous.hash };
    previous = { ...material, hash: hashRecord(material, ['hash']) };
    records.push(previous);
  }
  for (let offset = 0; offset < records.length; offset += 32) {
    await Promise.all(records.slice(offset, offset + 32).map((record) =>
      writeFile(path.join(directory, `${String(record.generation).padStart(6, '0')}.json`),
        `${JSON.stringify(record)}\n`, { mode: 0o600 })));
  }
  return previous;
}

describe('task journals retain room for termination', () => {
  it('retains a bounded receipt request with its task wrapper beyond the former 128 KiB ceiling', async () => {
    const root = await scratch();
    const receipt = { preflight: { description: 'p'.repeat(64 * 1024 - 256) }, summary: 's'.repeat(64 * 1024 - 256) };
    expect(Buffer.byteLength(JSON.stringify(receipt))).toBeLessThan(RECEIPT_INPUT_MAX_BYTES);
    const request = { name: 'ape_run', arguments: { action: 'record', receipt }, metadata: 'm'.repeat(1024) };
    expect(Buffer.byteLength(JSON.stringify(request))).toBeGreaterThan(128 * 1024);
    expect(Buffer.byteLength(JSON.stringify(request))).toBeLessThan(TASK_REQUEST_MAX_BYTES);
    const task = await createTask(root, { operationId: createOperationId(), action: 'record', request, owner });
    expect((await getTask(root, task.taskId)).request).toEqual(request);
    await expect(createTask(root, {
      operationId: createOperationId(), action: 'record', owner,
      request: { oversized: 'x'.repeat(TASK_REQUEST_MAX_BYTES) },
    })).rejects.toThrow(/task request/);
  });

  it.each(['completed', 'failed'])('can publish %s after the legacy update ceiling', async (status) => {
    const root = await scratch();
    const task = await seedLegacyTask(root);
    expect((await getTask(root, task.taskId)).generation).toBe(1024);
    await expect(acknowledgeTaskUpdate(root, task.taskId, { inputResponses: {} }))
      .rejects.toMatchObject({ code: 'task_update_capacity' });
    const terminal = await appendTaskGeneration(root, task.taskId, {
      expectedGeneration: 1024, status,
      ...(status === 'completed'
        ? { result: { resultType: 'complete', content: [{ type: 'text', text: 'done' }] } }
        : { error: { code: -32603, message: 'fixture execution failed' } }),
    });
    expect(terminal).toMatchObject({ generation: 1025, status, previousHash: task.hash });
    expect(await getTask(root, task.taskId)).toEqual(terminal);
    const collected = await collectExpiredTasks(root, { now: Date.parse(task.expiresAt) + 1 });
    expect(collected[0]).toMatchObject({ generations: 1026, status, terminalHash: terminal.hash });
  }, 60_000);

  it('reserves cancellation and its terminal result after the last accepted ordinary update', async () => {
    const root = await scratch();
    const task = await seedLegacyTask(root, 1023);
    const updated = await acknowledgeTaskUpdate(root, task.taskId, { inputResponses: { ready: true } });
    expect(updated.generation).toBe(1024);
    const requested = await requestTaskCancellation(root, task.taskId, { requester: owner, reason: 'stop safely' });
    expect(requested).toMatchObject({ generation: 1025, cancellation: { reason: 'stop safely' } });
    expect(await requestTaskCancellation(root, task.taskId, { requester: owner })).toEqual(requested);
    await expect(acknowledgeTaskUpdate(root, task.taskId, { inputResponses: {} }))
      .rejects.toMatchObject({ code: 'task_update_capacity' });
    await expect(appendTaskGeneration(root, task.taskId, { status: 'completed', result: { done: true } }))
      .rejects.toMatchObject({ code: 'cancellation_pending' });
    const cancelled = await appendTaskGeneration(root, task.taskId, { expectedGeneration: 1025, status: 'cancelled' });
    expect(cancelled).toMatchObject({ generation: 1026, status: 'cancelled', previousHash: requested.hash });
    expect(await getTask(root, task.taskId)).toEqual(cancelled);
    const collected = await collectExpiredTasks(root, { now: Date.parse(task.expiresAt) + 1 });
    expect(collected[0]).toMatchObject({ generations: 1027, status: 'cancelled', terminalHash: cancelled.hash });
    const auditFile = path.join(root, '.ape', 'runtime', 'tasks', '.gc', `${task.taskId}.json`);
    expect(JSON.parse(await readFile(auditFile, 'utf8'))).toEqual(collected[0]);
  }, 60_000);

  it('rejects a journal that uses a reserved generation for another ordinary update', async () => {
    const root = await scratch();
    const task = await seedLegacyTask(root);
    const material = { ...task, generation: 1025, previousHash: task.hash };
    const invalid = { ...material, hash: hashRecord(material, ['hash']) };
    await writeFile(path.join(root, '.ape', 'runtime', 'tasks', task.taskId, '001025.json'),
      `${JSON.stringify(invalid)}\n`, { mode: 0o600 });
    await expect(getTask(root, task.taskId)).rejects.toMatchObject({ code: 'corrupt_task' });
  }, 60_000);
});
