import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { evaluateLifecyclePolicy, evaluateTreePolicy } from '../lib/runtime/hooks.js';
import { validateStageReceipt } from '../lib/runtime/receipt-validator.js';
import { finalizeReceipt, finalizeTicket } from '../lib/runtime/schemas.js';
import { SCHEMA_VERSION } from '../lib/runtime/constants.js';
import { currentTreeSha, diffFiles } from '../lib/runtime/git.js';
import { startRun } from '../lib/runtime/service.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { atomicWriteJson } from '../lib/runtime/storage.js';
import { looksLikeTest, normalizeClaimPath, withinClaims } from '../lib/runtime/path-scope.js';

// Claim/test-path matching used to live in five divergent copies: the
// write-time hook did NOT posix-normalize claims while the receipt validator
// and the service admission checks did, so a claim like `src//utils` was
// accepted at start and at receipt time but the hook denied every bound write
// under it — the subagent could never produce the claimed change and the run
// burned its attempts. These cases pin the layers to ONE answer through the
// shared path-scope module, driven through each public surface.

const cleanups = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function project() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-path-scope-'));
  cleanups.push(dir);
  await mkdir(path.join(dir, 'src', 'utils'), { recursive: true });
  await mkdir(path.join(dir, 'src', 'spec'), { recursive: true });
  await mkdir(path.join(dir, 'lib'));
  await mkdir(path.join(dir, 'checks'));
  await mkdir(path.join(dir, 'tests'));
  await writeFile(path.join(dir, 'src', 'utils', 'helper.js'), 'export const helper = 1;\n');
  await writeFile(path.join(dir, 'src', 'spec', 'helper.js'), 'export const spec = 1;\n');
  await writeFile(path.join(dir, 'lib', 'data.js'), 'export const data = 1;\n');
  await writeFile(path.join(dir, 'checks', 'rules.js'), 'export const rules = 1;\n');
  await writeFile(path.join(dir, 'tests', 'value.test.js'), 'process.exit(0);\n');
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'ape@example.test');
  git(dir, 'config', 'user.name', 'APE Test');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'baseline');
  return dir;
}

function ticketFor(baseTreeSha, overrides = {}) {
  const issuedAt = new Date(Date.now() - 60_000).toISOString();
  return finalizeTicket({
    schema_version: SCHEMA_VERSION,
    ticket_id: 'run-1:build:ticket-1',
    run_id: 'run-1',
    stage_id: 'build',
    parallel_group: null,
    role: 'implementer',
    objective: 'Exercise claim normalization agreement',
    claimed_paths: ['src'],
    test_paths: [],
    model_tier: 'balanced',
    model: { model: 'opus' },
    deadline_at: new Date(Date.now() + 60_000).toISOString(),
    output_schema: {},
    required_checks: [],
    parent_hash: null,
    base_tree_sha: baseTreeSha,
    attempt: 1,
    writable: true,
    issued_at: issuedAt,
    ...overrides,
  });
}

function receiptFor(ticket, headTreeSha, changedFiles) {
  return finalizeReceipt({
    schema_version: SCHEMA_VERSION,
    receipt_id: 'receipt-1',
    run_id: ticket.run_id,
    ticket_id: ticket.ticket_id,
    ticket_hash: ticket.ticket_hash,
    agent: { host: 'claude', role: ticket.role, identity: `agent-${ticket.role}`, model: 'opus' },
    status: 'passed',
    base_tree_sha: ticket.base_tree_sha,
    head_tree_sha: headTreeSha,
    changed_files: changedFiles,
    tests: [],
    findings: [],
    evidence: { verdict: 'pass' },
    timing: {
      started_at: ticket.issued_at,
      completed_at: new Date().toISOString(),
      duration_ms: 1000,
    },
    previous_receipt_hash: null,
  });
}

const runningState = { status: 'running' };

function editEvent(file) {
  return {
    host: 'claude',
    is_subagent: true,
    ape_managed: true,
    event: 'PreToolUse',
    tool_name: 'Edit',
    file,
  };
}

describe('write-time hook and receipt-time validator agree on normalized claims', () => {
  it('admits interior-normalized claims (src//utils, src/../lib) at BOTH layers', async () => {
    // Deliberate semantic delta from the pre-consolidation hook: these claims
    // were fail-closed-denied by the raw string-prefix check even though the
    // hook's own realpath precheck (path_safe) and the validator admitted
    // them. Normalizing at match time is an availability fix; an escaping
    // claim still matches nothing (next case).
    const dir = await project();
    const base = await currentTreeSha(dir);
    const ticket = ticketFor(base, { claimed_paths: ['src//utils', 'src/../lib'] });

    for (const file of ['src/utils/helper.js', 'lib/data.js']) {
      const write = evaluateLifecyclePolicy(editEvent(file), { state: runningState, ticket });
      expect(write.decision, `hook write to ${file}`).toBe('allow');
    }
    const tree = evaluateTreePolicy(
      { is_subagent: true, event: 'SubagentStop' },
      { state: runningState, ticket },
      ['src/utils/helper.js', 'lib/data.js'],
    );
    expect(tree.decision).toBe('allow');

    await writeFile(path.join(dir, 'src', 'utils', 'helper.js'), 'export const helper = 2;\n');
    await writeFile(path.join(dir, 'lib', 'data.js'), 'export const data = 2;\n');
    const head = await currentTreeSha(dir);
    const changed = await diffFiles(dir, base, head);
    const result = await validateStageReceipt({
      project_dir: dir,
      state: { run_id: 'run-1', receipts: [] },
      ticket,
      receipt: receiptFor(ticket, head, changed),
    });
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('a root-escaping claim (../evil) matches nothing at either layer', async () => {
    const dir = await project();
    const base = await currentTreeSha(dir);
    const ticket = ticketFor(base, { claimed_paths: ['../evil'] });

    const write = evaluateLifecyclePolicy(editEvent('evil/x.js'), { state: runningState, ticket });
    expect(write.decision).toBe('deny');
    expect(write.reason).toMatch(/outside the ticket claims/);

    await writeFile(path.join(dir, 'src', 'utils', 'helper.js'), 'export const helper = 2;\n');
    const head = await currentTreeSha(dir);
    const changed = await diffFiles(dir, base, head);
    const result = await validateStageReceipt({
      project_dir: dir,
      state: { run_id: 'run-1', receipts: [] },
      ticket,
      receipt: receiptFor(ticket, head, changed),
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('unclaimed write: src/utils/helper.js');
  });

  it('trailing-slash and dot-segment claim spellings behave identically across layers', async () => {
    const dir = await project();
    const base = await currentTreeSha(dir);
    for (const spelling of ['src/utils/', './src/utils', 'src/./utils']) {
      const ticket = ticketFor(base, { claimed_paths: [spelling] });
      const write = evaluateLifecyclePolicy(
        editEvent('src/utils/helper.js'),
        { state: runningState, ticket },
      );
      expect(write.decision, `hook with claim ${spelling}`).toBe('allow');
    }

    await writeFile(path.join(dir, 'src', 'utils', 'helper.js'), 'export const helper = 2;\n');
    const head = await currentTreeSha(dir);
    const changed = await diffFiles(dir, base, head);
    for (const spelling of ['src/utils/', './src/utils', 'src/./utils']) {
      const ticket = ticketFor(base, { claimed_paths: [spelling] });
      const result = await validateStageReceipt({
        project_dir: dir,
        state: { run_id: 'run-1', receipts: [] },
        ticket,
        receipt: receiptFor(ticket, head, changed),
      });
      expect(result.errors, `validator with claim ${spelling}`).toEqual([]);
    }
  });

  it('mode land admits a working-tree diff claimed with a non-canonical spelling', async () => {
    // Third consumer of the shared matcher: startRun's land-mode scope-truth
    // check. Before consolidation this layer normalized while the hook did
    // not; now all three agree by construction.
    const dir = await project();
    await atomicWriteJson(runtimePaths(dir).config, {
      shipping: { auto_merge: false, provider: 'github', required_remote_checks: false },
      test_commands: { full: 'node -e "process.exit(0)"', targeted: 'node -e "process.exit(0)"' },
    });
    await writeFile(path.join(dir, 'src', 'utils', 'helper.js'), 'export const helper = 2;\n');
    const started = await startRun(dir, {
      objective: 'Land the finished diff under a non-canonical claim',
      mode: 'land',
      lane: 'auto',
      host: 'codex',
      claimed_paths: ['src//utils'],
      test_paths: [],
      requirements: [],
      risk_triggers: [],
      behavioral: true,
      hooks_trusted: true,
      subagents_available: true,
      explicit_invocation: true,
    });
    expect(started.ok).toBe(true);
  });

  it('admits a test writer authoring inside a configured non-test-named claim at BOTH layers', async () => {
    // Deliberate semantic delta: the validator's default production-path
    // predicate was the bare name pattern, so a `checks/` suite the hook
    // admitted (claims-first looksLikeTest) was rejected at receipt time as a
    // production write. The claims bypass makes the layers agree.
    const dir = await project();
    const base = await currentTreeSha(dir);
    const ticket = ticketFor(base, {
      ticket_id: 'run-1:test:ticket-1',
      stage_id: 'test',
      role: 'test_writer',
      claimed_paths: ['checks'],
      test_paths: ['checks'],
    });

    const write = evaluateLifecyclePolicy(
      editEvent('checks/rules.js'),
      { state: runningState, ticket },
    );
    expect(write.decision).toBe('allow');

    await writeFile(path.join(dir, 'checks', 'rules.js'), 'export const rules = 2;\n');
    const head = await currentTreeSha(dir);
    const changed = await diffFiles(dir, base, head);
    const result = await validateStageReceipt({
      project_dir: dir,
      state: { run_id: 'run-1', receipts: [] },
      ticket,
      receipt: receiptFor(ticket, head, changed),
    });
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('rejects an implementer edit to a test-shaped path at receipt time exactly as at write time', async () => {
    // Deliberate semantic delta: the validator only rejected exact
    // test_paths file matches, so an implementer write the hook denied
    // (src/spec/ is test-shaped by name) was admitted at receipt time
    // whenever the hook was absent. Both layers now use looksLikeTest.
    const dir = await project();
    const base = await currentTreeSha(dir);
    const ticket = ticketFor(base, {
      claimed_paths: ['src'],
      test_paths: ['tests/value.test.js'],
    });

    const write = evaluateLifecyclePolicy(
      editEvent('src/spec/helper.js'),
      { state: runningState, ticket },
    );
    expect(write.decision).toBe('deny');
    expect(write.reason).toMatch(/may not modify authored tests/);

    await writeFile(path.join(dir, 'src', 'spec', 'helper.js'), 'export const spec = 2;\n');
    const head = await currentTreeSha(dir);
    const changed = await diffFiles(dir, base, head);
    const result = await validateStageReceipt({
      project_dir: dir,
      state: { run_id: 'run-1', receipts: [] },
      ticket,
      receipt: receiptFor(ticket, head, changed),
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('implementer modified an authored test: src/spec/helper.js');
  });

  it('normalizes Windows drive letters and backslashes in claim paths cleanly', () => {
    expect(normalizeClaimPath('C:\\repo\\tests\\foo.test.js')).toBe('repo/tests/foo.test.js');
    expect(normalizeClaimPath('d:/tests/unit/')).toBe('tests/unit');
    expect(normalizeClaimPath('E:\\src\\..\\lib\\index.js')).toBe('lib/index.js');
  });

  it('keeps a POSIX-legal relative path whose first segment carries a colon inside its own scope', () => {
    // The drive-letter strip must fire only on a genuine Windows absolute
    // prefix — <letter>:<separator>. A relative path like 'x:secret/evil.js'
    // is a legal POSIX file name (a first segment that merely contains a
    // colon), NOT a drive path. Stripping the leading 'x:' rewrites it to
    // 'secret/evil.js', which then falls INSIDE a ['secret'] claim and lets a
    // bound writer escape write-scope confinement (invariant 2). The path must
    // survive normalization unchanged and stay outside the claim.
    expect(normalizeClaimPath('x:secret/evil.js')).toBe('x:secret/evil.js');
    expect(withinClaims('x:secret/evil.js', ['secret'])).toBe(false);
  });
});

// Windows trailing-dot/space aliasing bypass of looksLikeTest (invariant 3).
// normalizeClaimPath strips backslashes, a drive-letter prefix, leading './',
// and trailing '/', but NOT trailing dots/spaces. So an implementer's host
// Write/Edit (or rm) to the Windows-aliased spelling 'src/foo.test.js.' makes
// looksLikeTest('src/foo.test.js.') return false — BOTH the file arm
// (\.(test|spec)\. broken by the trailing dot) and the tests(/|$) directory arm
// break — while withinClaim('src/foo.test.js.','src') stays true, so the
// PreToolUse write-guard ALLOWS the write; on Windows the OS then resolves the
// trailing dot away and physically overwrites the authored test, defeating the
// write-time guard. The fix strips trailing dots/spaces per path segment in the
// fail-closed direction (a path that could alias to a test classifies AS a
// test), with an empty-segment guard preserving '..'/'.'.
describe('normalizeClaimPath closes the Windows trailing-dot/space test-alias bypass (invariant 3)', () => {
  it('classifies a trailing-dot alias of a *.test.js path as a test (file arm)', () => {
    // Currently false: the trailing dot survives normalization and the file arm
    // (\.(test|spec)\.[^.]+$) no longer matches 'src/foo.test.js.'.
    expect(looksLikeTest('src/foo.test.js.')).toBe(true);
  });

  it('strips a trailing dot from a directory segment and classifies it as a test (directory arm)', () => {
    // Currently 'tests./x.js' (unchanged) so the tests(/|$) arm cannot match.
    expect(normalizeClaimPath('tests./x.js')).toBe('tests/x.js');
    expect(looksLikeTest('tests./x.js')).toBe(true);
  });

  it('treats a trailing-dot alias of a claimed test file as that same test (deletion-equivalent)', () => {
    // The rm/deletion channel resolves targets against test_paths; the alias
    // must collapse onto the claimed authored test so the delete is caught.
    // Currently withinClaims fails (bytes differ) AND the name pattern misses.
    expect(looksLikeTest('src/foo.test.js.', ['src/foo.test.js'])).toBe(true);
  });

  it('DENIES an implementer host-edit to a trailing-dot alias of an authored test at write time', () => {
    // Same shape as the existing implementer/test-shaped hook case above: the
    // run claims 'src' (which co-locates the authored test) and test_paths
    // names 'src/foo.test.js'. The alias 'src/foo.test.js.' is inside the 'src'
    // claim, so the guard reaches the authored-test check — which today reads
    // false and ALLOWS the aliased overwrite. Post-fix it must DENY.
    const ticket = ticketFor('0'.repeat(40), {
      claimed_paths: ['src'],
      test_paths: ['src/foo.test.js'],
    });
    const write = evaluateLifecyclePolicy(
      editEvent('src/foo.test.js.'),
      { state: runningState, ticket },
    );
    expect(write.decision).toBe('deny');
    expect(write.reason).toMatch(/may not modify authored tests/);
  });
});

// Green regression guards: these must hold under BOTH the current code and any
// correct fix, so they are kept in a SEPARATE describe from the red anchors
// (their passing must never let the red block go green).
describe('trailing-dot stripping stays fail-closed on traversal and ordinary production paths', () => {
  it('preserves a root-escaping ".." segment so an alias cannot become an in-claim path', () => {
    // The empty-segment guard is load-bearing: naive per-segment trailing-dot
    // stripping would blank the '..' segment and could let '../evil' collapse
    // into a claimed directory. '..' must survive and match no claim.
    expect(normalizeClaimPath('../evil')).toBe('../evil');
    expect(withinClaims('../evil', ['evil'])).toBe(false);
  });

  it('leaves an ordinary production path non-test (no trailing dot to alias)', () => {
    expect(looksLikeTest('src/index.js')).toBe(false);
  });

  it('still denies a write whose realpath gate (path_safe=false) fails, independent of name shape', () => {
    // Independent backstop: the realpath/path_safe deny fires before the
    // name-shape checks, so a target that resolves outside the claims is
    // refused regardless of the trailing-dot classification fix.
    const ticket = ticketFor('0'.repeat(40), { claimed_paths: ['src'], test_paths: [] });
    const write = evaluateLifecyclePolicy(
      { ...editEvent('src/other.js'), path_safe: false },
      { state: runningState, ticket },
    );
    expect(write.decision).toBe('deny');
    expect(write.reason).toMatch(/outside the ticket claims/);
  });
});
