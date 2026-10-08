import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runGit, currentTreeSha, remoteBranchTip, workingTreeStatus } from '../lib/runtime/git.js';
import { spawnWithTimeout } from '../lib/runtime/spawn.js';
import { pollRemoteChecksAndMerge } from '../lib/runtime/github-shipping.js';
import { nextRun, resumeRun, compactStatus } from '../lib/runtime/service.js';
import { projectRunResponse } from '../lib/runtime/projection.js';
import { explainRun } from '../lib/runtime/history.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { atomicWriteJson } from '../lib/runtime/storage.js';
import { sha256 } from '../lib/runtime/canonical.js';
import { admittedStartIdentityHash } from '../lib/runtime/admitted-start-identity.js';

vi.mock('../lib/runtime/git.js', async importOriginal => ({
  ...await importOriginal(), runGit: vi.fn(), currentTreeSha: vi.fn(),
  currentBranch: vi.fn(async () => 'feature/tested'),
  treeShaSession: () => ({ current: async () => 'c'.repeat(40), invalidate() {}, diff: async () => [] }),
  remoteBranchTip: vi.fn(), workingTreeStatus: vi.fn(),
}));
vi.mock('../lib/runtime/spawn.js', async importOriginal => ({
  ...await importOriginal(), spawnWithTimeout: vi.fn(),
}));
// This suite models remote check observations with a fake Git implementation.
// Checkpoint object/ref durability is exercised against real Git separately.
vi.mock('../lib/runtime/work-checkpoints.js', async importOriginal => ({
  ...await importOriginal(), saveWorkCheckpoint: vi.fn(async () => null),
}));

const BASE = 'a'.repeat(40), HEAD = 'b'.repeat(40), TREE = 'c'.repeat(40);
const URL = 'https://github.com/acme/repo/pull/7';
const target = { version: 1, provider: 'github', origin: 'https://github.com/acme/repo.git', repository: 'acme/repo', base: 'main', required_remote_checks: true };
const config = { shipping: { provider: 'github', auto_merge: true, required_remote_checks: true, target, checks_registration_window_ms: 60000 } };
const rows = (...buckets) => JSON.stringify(buckets.map((bucket, i) => ({ name: `check-${i}`, bucket })));
const processResult = (code, stdout = '', extra = {}) => ({
  exit_code: code, timed_out: false, spawn_error: null, stdout, stderr: '', combined: stdout, ...extra,
});
const PASS = rows('pass');
const NO_CHECKS_DIAGNOSTIC = "no checks reported on the 'feature/tested' branch";
const ambiguous = [
  ['generic exit 1', processResult(1, 'HTTP 502: service unavailable')],
  ['no-checks phrase in malformed failed rows', processResult(1, '[{"name":"no checks reported","bucket":"fail"},{}]')],
  ['no-checks phrase in malformed passing rows', processResult(1, '[{"name":"no checks reported","bucket":"pass"},null]')],
  ['no-checks phrase in generic stdout error', processResult(1, 'HTTP 502: no checks reported because the service is unavailable')],
  ['no-checks phrase in generic stderr error', processResult(1, '', { stderr: 'HTTP 502: no checks reported because the service is unavailable' })],
  ['standalone no-checks stderr cannot override malformed stdout', processResult(1, '[{"bucket":"fail"},{}]', { stderr: NO_CHECKS_DIAGNOSTIC })],
  ['standalone no-checks stdout cannot override transport stderr', processResult(1, NO_CHECKS_DIAGNOSTIC, { stderr: 'HTTP 502: service unavailable' })],
  ['no-checks phrase in valid passing rows with exit 1', processResult(1, JSON.stringify([{ name: NO_CHECKS_DIAGNOSTIC, bucket: 'pass' }]))],
  ['exit 1 with only passing rows', processResult(1, PASS)],
  ['empty success', processResult(0)],
  ['empty array', processResult(0, '[]')],
  ['malformed JSON', processResult(0, '[{')],
  ['object instead of array', processResult(0, '{"bucket":"pass"}')],
  ['null response', processResult(0, 'null')],
  ['missing bucket', processResult(0, '[{}]')],
  ['unknown bucket', processResult(0, rows('invented'))],
  ['non-string bucket', processResult(0, '[{"bucket":true}]')],
  ['null row after pass', processResult(0, '[{"bucket":"pass"},null]')],
  ['bad row after fail', processResult(1, '[{"name":"build","bucket":"fail"},{}]')],
  ['unknown row after pass', processResult(0, rows('pass', 'invented'))],
  ['cancelled check', processResult(0, rows('cancel'))],
  ['skipped check', processResult(0, rows('skipping'))],
  ['null exit with passing stdout', processResult(null, PASS)],
  ['transport error with passing stdout', processResult(2, PASS)],
  ['spawn fault with passing stdout', processResult(null, PASS, { spawn_error: { message: 'EAGAIN' } })],
  ['timeout after passing stdout', processResult(0, PASS, { timed_out: true })],
  ['timeout overrides incidental no-check text', processResult(1, 'no checks reported', { timed_out: true })],
  ['transport overrides incidental no-check text', processResult(2, 'no checks reported')],
  ['stderr cannot provide passing records', processResult(0, '', { stderr: PASS, combined: PASS })],
  ['stderr cannot prove CI failure', processResult(1, '', { stderr: rows('fail'), combined: rows('fail') })],
  ['abort after passing stdout', processResult(0, PASS, { aborted: true })],
  ['signal after passing stdout', processResult(0, PASS, { signal: 'SIGTERM' })],
  ['missing exit status', processResult(undefined, PASS)],
  ['oversized valid passing JSON', processResult(0, JSON.stringify([{ name: 'x'.repeat(262144), bucket: 'pass' }]))],
  ['oversized valid failed JSON', processResult(1, JSON.stringify([{ name: 'x'.repeat(262144), bucket: 'fail' }]))],
  ['truncated passing prefix', processResult(0, PASS, { stdout_truncated: true })],
  ['truncated failed prefix', processResult(1, rows('fail'), { stdout_truncated: true })],
  ['stderr truncation with passing stdout', processResult(0, PASS, { stderr: 'warning', stderr_truncated: true })],
  ['stderr overflow with passing stdout', processResult(0, PASS, { stderr: 'w'.repeat(262145) })],
  ['truncation overrides incidental no-check text', processResult(1, 'no checks reported', { stdout_truncated: true })],
];
let dir, checks, calls, gitCalls, viewHead, afterChecks;
function stateFor() {
  const state = {
    schema_version: '2.0.0', run_id: 'run-check-observation', objective: 'Observe checks safely',
    mode: 'phase', lane: 'fast', host: 'codex', status: 'shipping', stage: 'merge', dispatch_state: 'none',
    created_at: '2026-09-01T10:00:00.000Z', updated_at: '2026-09-01T10:00:00.000Z',
    branch: 'feature/tested', base_branch: 'main', base_commit_sha: BASE,
    auto_merge_authorized: true, shipping_target: structuredClone(target),
    tickets: [], receipts: [], expired_tickets: [], claimed_paths: [], test_paths: [], risk_triggers: [],
    gates: { passed: true, tree_sha: TREE }, tree_sha: TREE,
    shipping_watch: {
      provider: 'github', shipping_target: structuredClone(target), pr_url: URL,
      branch: 'feature/tested', base: 'main', head_oid: HEAD,
      created_at: '2026-09-01T10:00:00.000Z', poll_count: 3,
      last_poll_at: null, last_checks_summary: null, merge_request_submitted: false,
    },
  };
  const manifest = { version: 1, ready: true, shipping_target: structuredClone(target), repository: { base_branch: 'main', base_commit: BASE } };
  state.admission = { version: 1, manifest, digest: sha256(manifest) };
  state.start_request_hash = 'a'.repeat(64);
  state.admitted_start_identity_version = 1;
  state.admitted_start_identity_hash = admittedStartIdentityHash(state);
  return state;
}
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ape-check-observation-'));
  checks = processResult(0, PASS); calls = []; gitCalls = []; viewHead = HEAD; afterChecks = null;
  currentTreeSha.mockReset().mockResolvedValue(TREE);
  workingTreeStatus.mockReset().mockResolvedValue([]);
  remoteBranchTip.mockReset().mockResolvedValue(BASE);
  runGit.mockReset().mockImplementation(async (_dir, args) => {
    gitCalls.push([...args]);
    if (args[0] === 'remote') return target.origin;
    if (args[0] === 'ls-remote' && args[1] === '--get-url') return args[2];
    if (args[0] === 'rev-parse') return args[1].includes('tree') ? TREE : HEAD;
    if (args[0] === 'branch') return 'feature/tested';
    if (['status', 'check-ref-format', 'fetch', 'diff', 'ls-files', 'config'].includes(args[0])) return '';
    throw new Error(`Unexpected Git effect: ${args.join(' ')}`);
  });
  spawnWithTimeout.mockReset().mockImplementation(async (command, args) => {
    if (command === 'git' && args[0] === 'config') return processResult(1);
    expect(command).toBe('gh');
    expect(args[args.indexOf('--repo') + 1]).toBe('github.com/acme/repo');
    expect(args[2]).toBe(URL);
    calls.push([...args]);
    if (args[1] === 'view') return processResult(0, `OPEN ${URL} - ${viewHead} - main`);
    if (args[1] === 'checks') { const result = structuredClone(checks); afterChecks?.(); return result; }
    if (args[1] === 'merge') return processResult(0);
    throw new Error(`Unexpected GitHub effect: ${args.join(' ')}`);
  });
});
afterEach(async () => { vi.restoreAllMocks(); await rm(dir, { recursive: true, force: true }); });
const poll = (state = stateFor()) => pollRemoteChecksAndMerge(dir, state, config);
function noEffects() {
  expect(calls.filter(args => ['merge', 'create'].includes(args[1]))).toEqual([]);
  expect(gitCalls.filter(args => ['add', 'commit', 'push', 'switch', 'pull', 'update-ref'].includes(args[0]))).toEqual([]);
}
function identity(state) {
  const w = state.shipping_watch;
  return { gates: state.gates, admission: state.admission, target: state.shipping_target,
    cursor: Object.fromEntries(['provider', 'shipping_target', 'pr_url', 'branch', 'base', 'head_oid', 'created_at', 'merge_request_submitted'].map(k => [k, w[k]])) };
}
async function seed(state = stateFor()) {
  await atomicWriteJson(runtimePaths(dir).config, config);
  await atomicWriteJson(runtimePaths(dir).active, state);
  return state;
}
const reload = async () => JSON.parse(await readFile(runtimePaths(dir).active, 'utf8'));

describe('structured check evidence at the merge boundary', () => {
  it.each(['stdout', 'stderr'])('preserves the registration window for the standalone diagnostic on %s', async stream => {
    checks = processResult(1, '', { [stream]: `${NO_CHECKS_DIAGNOSTIC}\n` });
    const state = stateFor();
    const now = Date.parse('2026-09-01T10:00:30.000Z');
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const waiting = await poll(state);
    expect(waiting.failed).toBeUndefined();
    expect(waiting.pending.reason).toBe('checks not yet registered');
    state.shipping_watch.created_at = new Date(now - 60001).toISOString();
    const expired = await poll(state);
    expect(expired.pending).toBeUndefined();
    expect(expired.failed).toMatch(/no remote checks registered within/);
    noEffects();
  });
  it('treats a validated failed check named after the diagnostic as failed CI', async () => {
    checks = processResult(1, JSON.stringify([{ name: NO_CHECKS_DIAGNOSTIC, bucket: 'fail' }]));
    const state = stateFor();
    state.shipping_watch.created_at = new Date().toISOString();
    const result = await poll(state);
    expect(result.pending).toBeUndefined();
    expect(result.failed).toMatch(/required remote checks failed/i);
    noEffects();
  });
  it.each(ambiguous)('%s is not a CI verdict and never authorizes a merge', async (_name, response) => {
    checks = response;
    const result = await poll();
    expect(result.failed).toBeUndefined();
    expect(result.merged).toBeUndefined();
    expect(result.pending).toBeDefined();
    expect(result.pending.reason).not.toBe('checks running');
    noEffects();
  });
  it.each([0, 1])('validated failure buckets prove CI failure with compatible exit %s', async code => {
    checks = processResult(code, rows('pass', 'pending', 'fail'));
    const result = await poll();
    expect(result.failed).toMatch(/fail|check-2/i);
    expect(result.pending).toBeUndefined();
    noEffects();
  });
  it.each([processResult(8), processResult(8, PASS), processResult(8, rows('fail')), processResult(0, rows('pass', 'pending'))])('pending evidence remains fail closed: %j', async response => {
    checks = response;
    const result = await poll();
    expect(result.failed).toBeUndefined();
    expect(result.pending.reason).toBe('checks running');
    noEffects();
  });
  it.each(['', PASS, rows('fail'), 'no checks reported'])('authentication exit takes precedence over stdout %j', async stdout => {
    checks = processResult(4, stdout);
    const result = await poll();
    expect(result.failed).toBeUndefined();
    expect(JSON.stringify(result.pending)).toMatch(/auth/i);
    expect(result.pending.reason).not.toBe('checks running');
    noEffects();
  });
  it('requires JSON buckets and retains the exact-head merge guard for all-passing checks', async () => {
    checks = processResult(0, rows('pass', 'pass'), { stderr: 'gh warning', combined: `${rows('pass', 'pass')}\ngh warning` });
    const result = await poll();
    const query = calls.find(args => args[1] === 'checks');
    expect(query).toContain('--json');
    expect(query[query.indexOf('--json') + 1].split(',')).toContain('bucket');
    const queryOptions = spawnWithTimeout.mock.calls.find(([, args]) => args[1] === 'checks')[2];
    expect(queryOptions.collect).toBe('separate');
    expect(queryOptions.max_output).toBeGreaterThan(0);
    expect(queryOptions.max_output).toBeLessThanOrEqual(262144);
    expect(calls.filter(args => args[1] === 'merge')).toEqual([
      ['pr', 'merge', URL, '--squash', '--match-head-commit', HEAD, '--repo', 'github.com/acme/repo'],
    ]);
    expect(result.pending.merge_request_submitted).toBe(true);
  });
  it('rejects head drift injected after the final checks observation and before merge', async () => {
    afterChecks = () => { viewHead = 'd'.repeat(40); };
    expect((await poll()).failed).toMatch(/head/);
    noEffects();
  });
});

describe('durable observation recovery', () => {
  it('retains the established blocked transition for proven failed CI', async () => {
    await seed();
    const defaultGit = runGit.getMockImplementation();
    runGit.mockImplementation(async (projectDir, args) => {
      if (JSON.stringify(args) === JSON.stringify(['show-ref', '--verify', '--quiet', 'refs/heads/main'])
        || JSON.stringify(args) === JSON.stringify(['switch', 'main'])) {
        gitCalls.push([...args]);
        return '';
      }
      return defaultGit(projectDir, args);
    });
    checks = processResult(1, rows('pass', 'fail'));
    const result = await nextRun(dir);
    const saved = await reload();
    expect(result.ok).toBe(true);
    expect(saved.status).toBe('blocked');
    expect(saved.shipping_watch).toBeNull();
    expect(saved.block_reason).toMatch(/shipping failed/i);
    expect(saved.shipping_recovery).toMatchObject({ status: 'needs-reconciliation', watch: { pr_url: expect.any(String) } });
    expect((await compactStatus(dir)).diagnostic.next_safe_action).toMatch(/regate/);
    expect((await compactStatus(dir)).recovery_plan).toBeDefined();
    expect(saved.checkout_cleanup).toMatchObject({
      status: 'returned', base_branch: 'main', run_branch: 'feature/tested',
      retained: true, deleted: false,
    });
    expect(gitCalls.filter(args => args[0] === 'switch')).toEqual([['switch', 'main']]);
    expect(calls.filter(args => ['merge', 'create'].includes(args[1]))).toEqual([]);
    expect(gitCalls.filter(args => ['add', 'commit', 'push', 'pull', 'update-ref', 'reset', 'clean', 'checkout'].includes(args[0]))).toEqual([]);
    expect(gitCalls.filter(args => args[0] === 'branch' && args.some(arg => ['-d', '-D', '--delete'].includes(arg)))).toEqual([]);
  });

  it.each([...ambiguous, ['authentication', processResult(4, '')]])('persists %s, reloads the cursor, and recovers without regating', async (kind, response) => {
    const original = await seed();
    checks = response;
    const first = await nextRun(dir);
    const saved = await reload();
    expect(first.ok).toBe(true);
    expect(saved.status).toBe('shipping');
    expect(identity(saved)).toEqual(identity(original));
    expect(saved.shipping_watch.poll_count).toBe(4);
    expect(saved.shipping_watch.last_poll_at).toEqual(expect.any(String));
    expect(saved.shipping_watch.last_checks_summary).toEqual(expect.any(String));
    noEffects();
    const status = await compactStatus(dir);
    const resumed = await resumeRun(dir);
    const surfaces = [first.actions, resumed.actions, status.diagnostic, projectRunResponse(first).next_action, explainRun(saved)];
    for (const surface of surfaces) {
      const text = JSON.stringify(surface);
      expect(text).toMatch(/ape_run[ _]next|retry/i);
      expect(text).not.toMatch(/regate|checks (?:still )?(?:running|in progress)/i);
      if (kind === 'authentication') expect(text).toMatch(/auth/i);
    }
    checks = processResult(0, PASS);
    await nextRun(dir);
    const submitted = await reload();
    expect(submitted.status).toBe('shipping');
    expect(submitted.gates).toEqual(original.gates);
    expect(submitted.shipping_watch.merge_request_submitted).toBe(true);
    expect(submitted.shipping_watch.poll_count).toBe(5);
    expect(submitted.shipping_watch.last_checks_summary).not.toMatch(/HTTP 502|authentication required/i);
    expect(JSON.stringify((await compactStatus(dir)).diagnostic)).not.toMatch(/authentication|observation.error/i);
    // A restart after submission must never submit the merge again, even if checks fail.
    checks = processResult(1, rows('fail'));
    await nextRun(dir);
    expect(calls.filter(args => args[1] === 'merge')).toHaveLength(1);
    expect((await reload()).shipping_watch.merge_request_submitted).toBe(true);
    expect(gitCalls.some(args => ['add', 'commit', 'push', 'switch', 'pull', 'update-ref'].includes(args[0]))).toBe(false);
  });
  it('serializes concurrent next writers without losing poll increments or gate evidence', async () => {
    const original = await seed();
    checks = processResult(1, 'HTTP 502');
    await Promise.all([nextRun(dir), nextRun(dir)]);
    const saved = await reload();
    expect(saved.status).toBe('shipping');
    expect(saved.shipping_watch.poll_count).toBe(5);
    expect(identity(saved)).toEqual(identity(original));
    noEffects();
  });
  it('clears authentication guidance when a later valid observation finds pending CI', async () => {
    const original = await seed();
    checks = processResult(4);
    await nextRun(dir);
    expect(JSON.stringify((await compactStatus(dir)).diagnostic)).toMatch(/auth/i);
    checks = processResult(0, rows('pass', 'pending'));
    const result = await nextRun(dir);
    const saved = await reload();
    expect(saved.status).toBe('shipping');
    expect(saved.shipping_watch.poll_count).toBe(5);
    expect(identity(saved)).toEqual(identity(original));
    const surfaces = [result.actions, (await resumeRun(dir)).actions,
      (await compactStatus(dir)).diagnostic, projectRunResponse(result).next_action, explainRun(saved)];
    for (const surface of surfaces) {
      expect(JSON.stringify(surface)).not.toMatch(/authentication|observation.error|regate/i);
    }
    noEffects();
  });
  it('never persists raw credentials or control bytes from observation diagnostics', async () => {
    await seed();
    const secret = 'ghp_SYNTHETIC_SECRET_DO_NOT_RETAIN';
    const stderr = `\u001b[31mAuthorization: Bearer ${secret}\u0007\n${'x'.repeat(10000)}`;
    checks = processResult(4, '', { stderr, combined: stderr });
    const result = await nextRun(dir);
    const saved = await reload();
    const summary = saved.shipping_watch.last_checks_summary;
    expect(summary.length).toBeLessThanOrEqual(400);
    expect([...summary].some(ch => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127)).toBe(false);
    expect(JSON.stringify([saved, result, await compactStatus(dir)])).not.toContain(secret);
    noEffects();
  });
});
