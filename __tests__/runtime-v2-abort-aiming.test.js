import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { bindClaudeSubagent, launchClaudeIntent } from '../lib/runtime/claude-dispatch.js';
import { acquireRunLock, inspectRunLock } from '../lib/runtime/lock.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { abortRun, overrideRun, startRun } from '../lib/runtime/service.js';
import { atomicWriteJson, readJson } from '../lib/runtime/storage.js';

// Roadmap id abort-cannot-be-aimed. `ape_run abort` and `ape_run override`
// (both operations) accept an OPTIONAL run_id confirmation: key-absent stays
// byte-identical to today (requirement a), a matching id proceeds exactly as
// today (b), and a NON-matching id — including an explicit `null`, which is
// distinct from omission — refuses fail-closed BEFORE any effect, changing
// nothing on disk (c/d). Every arm proves the guard by an OBSERVABLE effect
// (state bytes, run status, a bound intent, an overrides.ndjson line, a
// detached gate suite's scratch files) and never by a whole-directory hash
// (a mismatch refusal still opens and releases the receipt-effects lock, so
// hashing `.ape/runtime` wholesale would be a flaky assertion). Several arms
// below are pinning arms — green today and expected to stay green — because
// they pin the SAME observable outcome the fix must preserve (requirement a,
// and the C3 unaimed-refusal shape); the guard's own defect only shows up in
// the mismatch, null-aim, gating and misroute arms, which are genuinely red
// on this tree today (a third positional arg is silently ignored by
// abortRun/overrideRun, and run_id is silently ignored by the MCP dispatch).

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const WRONG_RUN_ID = 'run-not-the-active-run-00000000';

const cleanups = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

// Modeled on runtime-v2-abort-quarantine.test.js's project(): a real temp git
// repo with one commit plus a runtime config, so startRun has a committed
// tree and a loadable config to work against.
async function project() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-abort-aiming-'));
  cleanups.push(dir);
  await mkdir(path.join(dir, 'src'));
  await mkdir(path.join(dir, 'tests'));
  await writeFile(path.join(dir, 'src', 'value.js'), 'export const value = 1;\n');
  await writeFile(path.join(dir, 'tests', 'value.test.js'), 'throw new Error("red");\n');
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'ape@example.test');
  git(dir, 'config', 'user.name', 'APE Test');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'baseline');
  await atomicWriteJson(runtimePaths(dir).config, {
    shipping: { auto_merge: false, provider: 'github', required_remote_checks: false },
    test_commands: { full: 'node --test' },
  });
  return dir;
}

function startInput(overrides = {}) {
  return {
    objective: 'Exercise aimable abort/override',
    mode: 'phase',
    lane: 'fast',
    host: 'claude',
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

// A hand-crafted BLOCKED run: reset is valid only for a terminal/blocked run
// (scheduler.js OVERRIDE arm), so the override aim arms below write this
// shape directly to active.json instead of driving a real gate failure.
function blockedState(runId) {
  return {
    version: 2,
    schema_version: '2.0.0',
    run_id: runId,
    status: 'blocked',
    stage: 'gates',
    block_reason: 'one or more deterministic merge gates failed',
    objective: 'Exercise the override aim guard',
    mode: 'phase',
    lane: 'mechanical',
    host: 'codex',
    claimed_paths: ['src/value.js'],
    test_paths: [],
    requirements: [],
    risk_triggers: [],
    base_commit_sha: 'a'.repeat(40),
    tree_sha: 'b'.repeat(40),
    tickets: [],
    receipts: [],
    attempts: {},
    remediation_cycles: 0,
    regate_attempts: 0,
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
    terminal_at: '2026-07-01T00:00:00.000Z',
  };
}

// A hand-crafted GATING run with a detached-suite watch pointed at real
// scratch files but no pid: killProcessTree no-ops on a watch with no host
// match, so this is assertable cheaply without a live process (the GATING
// ARM evidence expectation) — only cleanupGateSuite's unconditional rm would
// remove these files, so their survival proves the kill/cleanup effect chain
// never ran.
function gatingState(runId, watchFiles) {
  return {
    version: 2,
    schema_version: '2.0.0',
    run_id: runId,
    status: 'gating',
    stage: 'gates',
    objective: 'Exercise the gating aim guard',
    mode: 'phase',
    lane: 'mechanical',
    behavioral: false,
    high_risk: false,
    host: 'codex',
    claimed_paths: ['src/value.js'],
    test_paths: [],
    requirements: [],
    risk_triggers: [],
    base_commit_sha: 'a'.repeat(40),
    tree_sha: 'b'.repeat(40),
    tickets: [],
    receipts: [],
    attempts: {},
    remediation_cycles: 0,
    regate_attempts: 0,
    gates_watch: {
      artifact_file: watchFiles.artifact,
      job_file: watchFiles.job,
      heartbeat_file: watchFiles.heartbeat,
      created_at: new Date().toISOString(),
    },
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
  };
}

// Wedge the run exactly like runtime-v2-abort-quarantine.test.js's
// bindWedgedFlight: launch and bind the intent through the runtime, then
// never record a receipt, so a mismatch refusal's "bound intent NOT expired"
// artifact is directly observable.
async function bindWedgedFlight(dir, dispatchAction) {
  const paths = runtimePaths(dir);
  const state = await readJson(paths.active, null);
  const launch = await launchClaudeIntent(paths, state, {
    session_id: 'wedged-parent',
    tool_use_id: 'wedged-agent-call',
    tool_input: {
      subagent_type: dispatchAction.dispatch.agent_type,
      prompt: dispatchAction.dispatch.dispatch_intent.prompt,
      model: dispatchAction.dispatch.model.model,
    },
  });
  expect(launch.valid).toBe(true);
  const bound = await bindClaudeSubagent(paths, state, {
    session_id: 'wedged-parent',
    agent_id: 'wedged-agent',
    agent_type: dispatchAction.dispatch.agent_type,
  });
  expect(bound.valid).toBe(true);
}

async function intentForTicket(dir, ticketId) {
  const paths = runtimePaths(dir);
  const names = (await readdir(paths.dispatchIntents)).filter((name) => name.endsWith('.json'));
  for (const name of names) {
    const record = await readJson(path.join(paths.dispatchIntents, name), null);
    if (record?.ticket_id === ticketId) return record;
  }
  return null;
}

function overrideLines(paths) {
  try {
    return readFileSync(paths.overrideLog, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

// Same session() shape as runtime-v2-mcp.test.js: a real stdio round trip
// through bin/ape-mcp.mjs, because the misroute guard (C4) lives in the
// dispatch layer (bin/ape-mcp.mjs), not in service.js.
function session(messages) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.CLAUDE_PROJECT_DIR;
    delete env.CODEX_CWD;
    const child = spawn(process.execPath, [path.join(root, 'bin', 'ape-mcp.mjs')], {
      cwd: root,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(stderr));
      else resolve(stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line)));
    });
    child.stdin.end(messages.map((message) => JSON.stringify(message)).join('\n') + '\n');
  });
}

describe('APE v2 aimable abort (running run)', () => {
  it('unaimed abort seals a running run exactly as today (requirement a)', async () => {
    const dir = await project();
    const started = await startRun(dir, startInput());
    expect(started.ok).toBe(true);
    const runId = started.run.run_id;

    const result = await abortRun(dir, 'operator cleanup, no aim supplied');
    expect(result.ok).toBe(true);

    const state = await readJson(runtimePaths(dir).active, null);
    expect(state.run_id).toBe(runId);
    expect(state.status).toBe('aborted');
  });

  it('a matching aimed abort seals exactly as an unaimed abort does', async () => {
    const dir = await project();
    const started = await startRun(dir, startInput());
    const runId = started.run.run_id;

    const result = await abortRun(dir, 'operator confirms the aim', runId);
    expect(result.ok).toBe(true);

    const state = await readJson(runtimePaths(dir).active, null);
    expect(state.run_id).toBe(runId);
    expect(state.status).toBe('aborted');
  });

  it('a mismatched aimed abort refuses fail-closed and leaves the running run untouched', async () => {
    const dir = await project();
    const started = await startRun(dir, startInput());
    const runId = started.run.run_id;
    const dispatchAction = started.actions.find((action) => action.type === 'dispatch_agent');
    await bindWedgedFlight(dir, dispatchAction);

    const paths = runtimePaths(dir);
    const before = readFileSync(paths.active, 'utf8');

    const result = await abortRun(dir, 'operator believes a different run is active', WRONG_RUN_ID);
    expect(result.ok).toBe(false);
    // MISMATCH names both ids, so the refusal itself corrects the caller.
    expect(result.reason).toContain(WRONG_RUN_ID);
    expect(result.reason).toContain(runId);

    // NAMED artifacts, never a whole-directory hash (test trap): active.json
    // bytes, run status, and the bound intent record.
    expect(readFileSync(paths.active, 'utf8')).toBe(before);
    const state = await readJson(paths.active, null);
    expect(state.status).toBe('running');
    const intent = await intentForTicket(dir, dispatchAction.ticket.ticket_id);
    expect(intent).not.toBeNull();
    expect(intent.status).not.toBe('expired');
  });

  it('an explicit run_id: null on abort is refused as an invalid aim, not treated as omitted', async () => {
    const dir = await project();
    const started = await startRun(dir, startInput());
    const runId = started.run.run_id;
    const paths = runtimePaths(dir);
    const before = readFileSync(paths.active, 'utf8');

    const result = await abortRun(dir, 'operator abort attempt with a null aim', null);
    expect(result.ok).toBe(false);
    expect(result.reason.toLowerCase()).toMatch(/null|invalid/);

    expect(readFileSync(paths.active, 'utf8')).toBe(before);
    const state = await readJson(paths.active, null);
    expect(state.run_id).toBe(runId);
    expect(state.status).toBe('running');
  });

  it('THE GATING ARM: a mismatched aimed abort never kills or cleans up a detached gate suite', async () => {
    const dir = await project();
    const paths = runtimePaths(dir);
    const scratch = await mkdtemp(path.join(tmpdir(), 'ape-gate-scratch-'));
    cleanups.push(scratch);
    const watchFiles = {
      artifact: path.join(scratch, 'artifact.json'),
      job: path.join(scratch, 'job.json'),
      heartbeat: path.join(scratch, 'heartbeat.json'),
    };
    await writeFile(watchFiles.artifact, 'artifact\n');
    await writeFile(watchFiles.job, 'job\n');
    await writeFile(watchFiles.heartbeat, 'heartbeat\n');

    const runId = 'run-gating-aim-check';
    await atomicWriteJson(paths.active, gatingState(runId, watchFiles));

    const result = await abortRun(dir, 'operator believes a different run is gating', WRONG_RUN_ID);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain(WRONG_RUN_ID);
    expect(result.reason).toContain(runId);

    // requirement (d): the kill/cleanup effect fires only for a gating state
    // with a gates_watch — a refused aim must reach neither.
    await expect(access(watchFiles.artifact)).resolves.toBeUndefined();
    await expect(access(watchFiles.job)).resolves.toBeUndefined();
    await expect(access(watchFiles.heartbeat)).resolves.toBeUndefined();

    const state = await readJson(paths.active, null);
    expect(state.status).toBe('gating');
  });
});

describe('APE v2 aimable override reset (blocked run)', () => {
  it('unaimed override reset clears a blocked run exactly as today (requirement a)', async () => {
    const dir = await project();
    const paths = runtimePaths(dir);
    const runId = 'run-blocked-unaimed';
    await atomicWriteJson(paths.active, blockedState(runId));

    const result = await overrideRun(dir, 'reset', 'operator cleanup, no aim supplied');
    expect(result.ok).toBe(true);
    await expect(access(paths.active)).rejects.toThrow();
  });

  it('a matching aimed override reset clears the blocked run exactly as an unaimed reset does', async () => {
    const dir = await project();
    const paths = runtimePaths(dir);
    const runId = 'run-blocked-match';
    await atomicWriteJson(paths.active, blockedState(runId));

    const result = await overrideRun(dir, 'reset', 'operator confirms the aim', runId);
    expect(result.ok).toBe(true);
    await expect(access(paths.active)).rejects.toThrow();
  });

  it('a mismatched aimed override reset refuses fail-closed and leaves the blocked run untouched', async () => {
    const dir = await project();
    const paths = runtimePaths(dir);
    const runId = 'run-blocked-mismatch';
    await atomicWriteJson(paths.active, blockedState(runId));
    const before = readFileSync(paths.active, 'utf8');

    const result = await overrideRun(dir, 'reset', 'operator believes a different run is blocked', WRONG_RUN_ID);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain(WRONG_RUN_ID);
    expect(result.reason).toContain(runId);

    // NAMED artifacts: active.json bytes unchanged and no overrides.ndjson
    // line — the check runs before the audited effect, not after it.
    expect(readFileSync(paths.active, 'utf8')).toBe(before);
    expect(overrideLines(paths)).toHaveLength(0);
  });

  it('C3: unaimed override reset with no active run at all pins the exact refusal shape', async () => {
    const dir = await project();
    const paths = runtimePaths(dir);
    await mkdir(paths.runtime, { recursive: true });

    // WHOLE-OBJECT equality: the unaimed no-active-run refusal may gain no
    // new DEFINED key (a sibling suite pins this same shape with toEqual).
    const result = await overrideRun(dir, 'reset', 'nothing to clear');
    expect(result).toEqual({ ok: false, reason: 'no active run' });
  });

  it('C2: overrideRun still throws (never returns ok:false) on a genuine non-corrupt read fault, even when aimed', async () => {
    const dir = await project();
    const paths = runtimePaths(dir);
    // A directory where active.json should be: readJson raises a plain
    // EISDIR, which activeState propagates WITHOUT the APE_CORRUPT_ACTIVE_STATE
    // tag (only a JSON.parse SyntaxError earns that tag) — a genuine I/O
    // fault, not a diagnosable corrupt-state condition. An aim check placed
    // ahead of this rethrow would wrongly convert it into an untruthful
    // ok:false.
    await mkdir(paths.active, { recursive: true });

    await expect(
      overrideRun(dir, 'reset', 'aimed at a real I/O fault', 'run-aimed-at-a-fault'),
    ).rejects.toThrow();
  });

  it('C1: an aimed reset against an orphaned lock (no active run) refuses and names the aimed id and the unaimed retry', async () => {
    const dir = await project();
    const paths = runtimePaths(dir);
    await mkdir(paths.runtime, { recursive: true });
    const orphanLockRunId = 'run-orphaned-lock-source';
    await acquireRunLock(paths.lock, orphanLockRunId);

    const aimedId = 'run-aimed-at-the-orphan-9999';
    const result = await overrideRun(dir, 'reset', 'operator follows the doctor hint', aimedId);
    expect(result.ok).toBe(false);
    // NO-ACTIVE-RUN names the aimed id (there is no active state to confirm
    // against), and the reason must name the unaimed retry — doctor.js
    // tells the operator to run override reset naming the lock's run_id, so
    // the refusal that follows must not be a dead end (C1).
    expect(result.reason).toContain(aimedId);
    expect(result.reason).toMatch(/run_id/i);
    expect(result.reason).toMatch(/(without|omit|unaimed|no run_id)/i);

    // CHOSEN, NOT FORCED: the orphaned-lock recovery (steal the lock, drop
    // status.md, append an audit line) must not have run.
    const lockInfo = await inspectRunLock(paths.lock);
    expect(lockInfo.present).toBe(true);
    expect(lockInfo.run_id).toBe(orphanLockRunId);
    expect(overrideLines(paths)).toHaveLength(0);
  });
});

describe('APE v2 run_id misroute guard', () => {
  it('rejects run_id on a non-abort/override action before the action takes effect', async () => {
    const scratch = await mkdtemp(path.join(tmpdir(), 'ape-mcp-misroute-'));
    cleanups.push(scratch);
    const responses = await session([
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'ape_run',
          arguments: {
            action: 'status',
            run_id: 'run-should-never-reach-status',
            project_dir: scratch,
          },
        },
      },
    ]);
    // Today status ignores run_id and answers normally (isError absent); the
    // guard must refuse before dispatching to statusRun at all.
    expect(responses[0].result.isError).toBe(true);
    const text = responses[0].result.content[0].text;
    expect(text).toMatch(/run_id/i);
    expect(text).toMatch(/status/);
  });
});
