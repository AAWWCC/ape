import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { runtimePaths } from '../lib/runtime/paths.js';
import { currentTreeSha } from '../lib/runtime/git.js';
import { atomicWriteJson } from '../lib/runtime/storage.js';

// Roadmap shell-write-verb-coverage (audit finding 1.7, invariant 2: no
// main-session production writes). SHELL_WRITE is a blocklist, and the
// documented backstops (drift reconciliation, receipt-time diff recompute)
// both key off the SAME pattern for main-session Bash — so an unenumerated
// write verb (git apply / git restore / git checkout -- / git reset --hard /
// git stash pop, touch, truncate, ln -sf, install, patch) is allowed at
// PreToolUse as a "non-writing shell command" AND skips tree reconciliation
// on its Post event: the mutation lands silently, and when it lands inside a
// pending writable ticket's claims the next drift-guarded event launders it
// into that ticket (sole-candidate attribution / the bound subagent's own
// diff), so the bytes ride into an accepted receipt as attested agent work.
//
// The acceptance is DISJUNCTIVE and these anchors pin the security OUTCOME,
// not one fix arm. For a main-session shell command that mutates the tree
// while a writer ticket is pending, a correct implementation either:
//   arm 1 — extends SHELL_WRITE with the git-mutation and file-touch verb
//           families, so the command is denied at PreToolUse; or
//   arm 2 — decouples the drift guard from SHELL_WRITE for main-session
//           Bash, so the very next PostToolUse for that command runs tree
//           reconciliation and blocks the unattributed change.
// Each anchor therefore walks the real lifecycle: PreToolUse first; only if
// the host would proceed does the simulated mutation land; then PostToolUse
// for the same command. Interdiction at either event passes. Silent
// pre-allow + post-{} — today's behavior — fails.
//
// Harness follows the sibling hook-binary suites (temp git project, spawned
// bin/ape-hook.mjs, scrubbed env): runtime-v2-hook-drift-recovery.test.js,
// runtime-v2-main-session-exemption.test.js.

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const hookBinary = path.join(root, 'bin', 'ape-hook.mjs');
const cleanups = [];

const PENDING_TICKET_ID = 'run-verb-coverage:build:b1';

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

// A governed temp project with one pending writable implementer ticket
// claiming src/ — the laundering target. state.tree_sha is the stale baseline
// the drift guard diffs against.
async function project(status = 'running') {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-shell-verb-coverage-'));
  cleanups.push(dir);
  await mkdir(path.join(dir, 'src'), { recursive: true });
  await writeFile(path.join(dir, 'src', 'value.js'), 'export const value = 1;\n');
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'ape@example.test');
  git(dir, 'config', 'user.name', 'APE Test');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'test: baseline');
  const baseline = await currentTreeSha(dir);
  await atomicWriteJson(runtimePaths(dir).active, {
    run_id: 'run-verb-coverage',
    status,
    tree_sha: baseline,
    tickets: [
      {
        ticket_id: PENDING_TICKET_ID,
        role: 'implementer',
        writable: true,
        claimed_paths: ['src'],
        test_paths: ['__tests__'],
        base_tree_sha: baseline,
      },
    ],
    expired_tickets: [],
    receipts: [],
  });
  return dir;
}

// An ungoverned temp directory: no .ape state anywhere, so no run exists.
async function ungovernedProject() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-shell-verb-ungoverned-'));
  cleanups.push(dir);
  return dir;
}

// Env for the spawned binary: strip host markers, project pins, and any
// ambient APE_TICKET_ID (an exported binding would turn these main-session
// events into bound ones and dodge the exact gap under test).
function hostEnv(host) {
  const env = { ...process.env };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE;
  delete env.CLAUDE_PROJECT_DIR;
  delete env.CODEX_CWD;
  delete env.APE_TICKET_ID;
  if (host === 'claude') env.CLAUDECODE = '1';
  return env;
}

function invokeHook(input, cwd, host = 'claude') {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hookBinary], {
      cwd,
      env: hostEnv(host),
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
      else resolve(JSON.parse(stdout));
    });
    child.stdin.end(`${JSON.stringify(input)}\n`);
  });
}

// Main-session Bash lifecycle event: no agent identity, no ticket binding.
function bashEvent(eventName, dir, command) {
  return {
    hook_event_name: eventName,
    project_dir: dir,
    session_id: 's1',
    cwd: dir,
    tool_name: 'Bash',
    tool_input: { command },
  };
}

// The next drift-guarded event after a writer stage: the parent's identity-
// less Agent result (the sole-candidate attribution seam).
function agentPostEvent(dir) {
  return {
    hook_event_name: 'PostToolUse',
    project_dir: dir,
    session_id: 's1',
    cwd: dir,
    tool_name: 'Agent',
    tool_input: {},
  };
}

// Current Claude and Codex hook contracts share the PreToolUse
// hookSpecificOutput shape and the post-event top-level block shape.
function preDecision(response) {
  return response.hookSpecificOutput.permissionDecision;
}

function postSurfacedDrift(response) {
  return response?.decision === 'block';
}

// Walks the lifecycle for one main-session shell command. The mutation lands
// only if PreToolUse would let the host proceed — exactly as the host behaves.
async function mainSessionMutationOutcome(dir, command, mutate, host = 'claude') {
  const pre = await invokeHook(bashEvent('PreToolUse', dir, command), dir, host);
  if (preDecision(pre) === 'deny') {
    return { interdicted: true, stage: 'pre-deny', pre, post: null };
  }
  await mutate(dir);
  const post = await invokeHook(bashEvent('PostToolUse', dir, command), dir, host);
  return { interdicted: postSurfacedDrift(post), stage: 'post', pre, post };
}

function expectInterdicted(outcome, command, extraDetail = '') {
  expect(
    outcome.interdicted,
    `main-session \`${command}\` must be denied at PreToolUse or surfaced as an unattributed ` +
      `tree change at PostToolUse — never silently allowed with no reconciliation; observed ` +
      `pre=${JSON.stringify(outcome.pre)} post=${JSON.stringify(outcome.post)}${extraDetail}`,
  ).toBe(true);
}

// Simulated tree effects of the commands under test. The hook only ever sees
// the command string and the tree, so the simulation stands in for execution.
const rewriteClaimedFile = (dir) =>
  writeFile(path.join(dir, 'src', 'value.js'), 'export const value = 99; // main-session bytes\n');
const emptyClaimedFile = (dir) => writeFile(path.join(dir, 'src', 'value.js'), '');
const createClaimedFile = (dir) => writeFile(path.join(dir, 'src', 'new-file.js'), '');
const createUnclaimedFile = (dir) =>
  writeFile(path.join(dir, 'unclaimed.txt'), 'main-session bytes\n');

describe('APE v2 main-session shell-write verb coverage (source hook binary)', () => {
  // RED anchor R1: the laundering scenario verbatim from the audit. While the
  // writer ticket is pending, the main session runs `git apply` touching a
  // file inside the pending ticket's claims. Today: PreToolUse allows it as a
  // "non-writing shell command", the Post event runs no reconciliation, and
  // the next drift-guarded event attributes the bytes to the sole pending
  // ticket. The failure message captures that laundering attribution.
  it('interdicts a main-session git apply into a pending ticket claim instead of laundering it (R1)', async () => {
    const dir = await project();
    const command = 'git apply changes.diff';
    const outcome = await mainSessionMutationOutcome(dir, command, rewriteClaimedFile);
    let extraDetail = '';
    if (!outcome.interdicted) {
      // Demonstrate where the un-interdicted bytes go: the parent's next
      // Agent post event ({} means the host proceeds — the change was
      // attributed to the pending ticket, headed for its receipt).
      const laundered = await invokeHook(agentPostEvent(dir), dir);
      extraDetail = `; next Agent PostToolUse=${JSON.stringify(laundered)} (empty object = ` +
        'attributed to the pending ticket and laundered toward its receipt)';
    }
    expectInterdicted(outcome, command, extraDetail);
  });

  // RED anchor R2: `touch` creating a new file inside the pending claim — the
  // file-touch verb family named by the acceptance.
  it('interdicts a main-session touch creating a file inside the pending ticket claim (R2)', async () => {
    const dir = await project();
    const command = 'touch src/new-file.js';
    const outcome = await mainSessionMutationOutcome(dir, command, createClaimedFile);
    expectInterdicted(outcome, command);
  });

  // RED anchor family R3: every unenumerated verb the audit names, each
  // targeting the pending ticket's claim. All of them today pass PreToolUse
  // as "non-writing" AND skip Post reconciliation.
  const VERB_FAMILY = [
    { command: 'git restore src/value.js', mutate: rewriteClaimedFile },
    { command: 'git checkout -- src/value.js', mutate: rewriteClaimedFile },
    { command: 'git reset --hard HEAD~1', mutate: rewriteClaimedFile },
    { command: 'git stash pop', mutate: rewriteClaimedFile },
    { command: 'truncate -s 0 src/value.js', mutate: emptyClaimedFile },
    { command: 'ln -sf /tmp/elsewhere src/value.js', mutate: rewriteClaimedFile },
    { command: 'install -m 644 payload.txt src/value.js', mutate: rewriteClaimedFile },
    { command: 'patch -p1 -i changes.diff', mutate: rewriteClaimedFile },
  ];
  for (const { command, mutate } of VERB_FAMILY) {
    it(`interdicts main-session \`${command}\` targeting the pending claim (R3)`, async () => {
      const dir = await project();
      const outcome = await mainSessionMutationOutcome(dir, command, mutate);
      expectInterdicted(outcome, command);
    });
  }

  // RED anchor R4: a mutation landing OUTSIDE every claim is equally silent
  // today (no reconciliation runs at all on the unenumerated verb's events).
  // It must be denied at pre or surface as unattributed drift at post.
  it('interdicts a main-session git apply landing outside every ticket claim (R4)', async () => {
    const dir = await project();
    const command = 'git apply evil.diff';
    const outcome = await mainSessionMutationOutcome(dir, command, createUnclaimedFile);
    expectInterdicted(outcome, command);
  });

  // RED anchor R5: host neutrality (invariant 6) — the codex main session
  // takes the identical policy path, so the same interdiction must hold.
  it('interdicts the codex main-session git apply into the pending claim (R5)', async () => {
    const dir = await project();
    const command = 'git apply changes.diff';
    const outcome = await mainSessionMutationOutcome(dir, command, rewriteClaimedFile, 'codex');
    expectInterdicted(outcome, command);
  });
});

describe('APE v2 shell-write verb coverage guardrails', () => {
  // GREEN guardrail G1: read-only main-session git stays allowed at
  // PreToolUse on a clean tree — over-blocking is the stated safe direction
  // for the verb families, but the diagnostic verbs (status/diff/log) are the
  // operator's recovery channel and must not be swept into the blocklist
  // (runtime-v2-hook-drift-recovery.test.js pins `git status` even during
  // drift).
  it('keeps read-only main-session git allowed at PreToolUse on a clean tree (G1)', async () => {
    const dir = await project();
    for (const command of ['git status', 'git diff', 'git log -1']) {
      const response = await invokeHook(bashEvent('PreToolUse', dir, command), dir);
      expect(preDecision(response, 'claude'), command).toBe('allow');
    }
  });

  // GREEN guardrail G2: a clean-tree read-only main-session PostToolUse stays
  // un-blocked — reconciliation with nothing changed must not manufacture a
  // denial.
  it('keeps a clean-tree read-only main-session PostToolUse un-blocked (G2)', async () => {
    const dir = await project();
    const response = await invokeHook(bashEvent('PostToolUse', dir, 'git status'), dir);
    expect(response).toEqual({});
  });

  // GREEN guardrail G3: with no APE run anywhere, the host is ungoverned —
  // the verb coverage must not police a project with no active run.
  it('leaves an ungoverned project untouched: pre allows and post stays empty (G3)', async () => {
    const dir = await ungovernedProject();
    const command = 'touch src/new-file.js';
    const pre = await invokeHook(bashEvent('PreToolUse', dir, command), dir);
    expect(preDecision(pre, 'claude')).toBe('allow');
    await mkdir(path.join(dir, 'src'), { recursive: true });
    await createClaimedFile(dir);
    const post = await invokeHook(bashEvent('PostToolUse', dir, command), dir);
    expect(post).toEqual({});
  });

  // GREEN guardrail G4: a sealed completed run left in active.json is history
  // on display — main-session shell activity is the host's business again.
  it('stands aside for a sealed completed run: pre allows and post stays empty (G4)', async () => {
    const dir = await project('completed');
    const command = 'git apply changes.diff';
    const pre = await invokeHook(bashEvent('PreToolUse', dir, command), dir);
    expect(preDecision(pre, 'claude')).toBe('allow');
    await rewriteClaimedFile(dir);
    const post = await invokeHook(bashEvent('PostToolUse', dir, command), dir);
    expect(post).toEqual({});
  });
});
