import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { runtimePaths } from '../lib/runtime/paths.js';
import { currentTreeSha } from '../lib/runtime/git.js';
import { atomicWriteJson } from '../lib/runtime/storage.js';

// Audit finding 1.8 (hook-stdin-multibyte-decode). bin/ape-hook.mjs reads
// stdin with `for await (const chunk of process.stdin) { ...; body += chunk }`
// and no setEncoding, so each Buffer chunk is coerced to a string
// independently. A multibyte UTF-8 codepoint whose bytes straddle a pipe-read
// boundary is therefore decoded in two halves and mangled into U+FFFD
// replacement characters. The file explicitly plans for multi-chunk payloads
// (the 8 MB cap comment cites an inline package-lock.json Edit; pipe reads
// arrive in ~64 KB chunks), so the split is a real field condition, not a
// contrivance.
//
// The observable contract under test: the hook's decision is a function of the
// JSON payload alone and MUST NOT depend on how the OS split stdin into chunks.
// A payload delivered whole and the same payload delivered with one codepoint
// split across two chunks must reach the identical decision.
//
// To make the corruption load-bearing (and the red deterministic rather than
// buffer-timing-dependent), the project root's own directory name carries a
// 4-byte emoji, and the write targets <root>/x.js. Under a correct single
// decode the target resolves inside the project, so the main-session write is
// denied; under the per-chunk decode the emoji in the root-matching prefix
// corrupts, path.relative no longer places the target under the root, and the
// hook takes its out-of-project ALLOW branch — a governed write wrongly
// permitted purely because a read boundary landed mid-codepoint. The emoji has
// no NFC/NFD decomposition, so realpath round-trips its bytes unchanged on
// every platform. (The audit predicted a fail-closed deny via a JSON.parse
// throw; in fact U+FFFD is valid inside a JSON string so the parse succeeds and
// the corruption instead flips the decision — same root cause, and the
// decision-invariance contract asserted here holds for either manifestation.)

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const hookBinary = path.join(root, 'bin', 'ape-hook.mjs');
const cleanups = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

// A running APE project whose root directory name carries a 4-byte emoji.
async function emojiProject(status = 'running') {
  const base = await mkdtemp(path.join(tmpdir(), 'ape-stdin-decode-'));
  cleanups.push(base);
  const dir = path.join(base, 'proj-\u{1F600}-root');
  await mkdir(path.join(dir, 'src'), { recursive: true });
  await writeFile(path.join(dir, 'src', 'value.js'), 'export const value = 1;\n');
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'ape@example.test');
  git(dir, 'config', 'user.name', 'APE Test');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'test: baseline');
  const baseline = await currentTreeSha(dir);
  await atomicWriteJson(runtimePaths(dir).active, {
    run_id: 'run-stdin-decode',
    status,
    tree_sha: baseline,
    tickets: [],
    receipts: [],
  });
  return dir;
}

// Force the Claude host and strip the host project hints, so the hook resolves
// the project root from the spawn cwd (process.cwd()) — the emoji never travels
// stdin via project_dir/cwd, only via file_path.
function claudeEnv() {
  const env = { ...process.env, CLAUDECODE: '1' };
  delete env.CLAUDE_PROJECT_DIR;
  delete env.CODEX_CWD;
  return env;
}

// A main-session PreToolUse Write to <dir>/x.js. `pad` is an ignored field used
// only to push the file_path's emoji far enough into the byte stream that the
// split delivery below can force pipe backpressure.
function preToolUseWrite(dir, pad = '') {
  return {
    ...(pad ? { _pad: pad } : {}),
    hook_event_name: 'PreToolUse',
    session_id: 's1',
    tool_name: 'Write',
    tool_input: { file_path: path.join(dir, 'x.js'), content: 'scratch' },
  };
}

function spawnHook(cwd) {
  const child = spawn(process.execPath, [hookBinary], {
    cwd,
    env: claudeEnv(),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const done = new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', reject);
    child.on('close', (code) => (code !== 0
      ? reject(new Error(stderr || `hook exited ${code}`))
      : resolve(JSON.parse(stdout))));
  });
  return { child, done };
}

// Single-chunk delivery: the whole (small) payload lands in one write, so the
// child reads it as a single stdin chunk and decodes it correctly.
function invokeHookSingle(input, cwd) {
  const { child, done } = spawnHook(cwd);
  child.stdin.end(Buffer.from(`${JSON.stringify(input)}\n`, 'utf8'));
  return done;
}

// Split delivery: cut the payload's UTF-8 bytes mid-emoji and write the two
// halves separately. The large pre-emoji filler forces pipe backpressure, so
// part1's write callback fires only after the child has already drained most of
// part1 (eliminating the process-start-up race) and its tail chunk ends
// mid-codepoint; the short gap lets the child consume part1's residual before
// part2 arrives, so part2 is a distinct chunk and the codepoint is decoded
// across two independent chunk reads — exactly the boundary-straddle the bug
// mangles.
function invokeHookSplit(input, cwd, cut) {
  const { child, done } = spawnHook(cwd);
  const buf = Buffer.from(`${JSON.stringify(input)}\n`, 'utf8');
  child.stdin.write(buf.subarray(0, cut), () => {
    setTimeout(() => child.stdin.end(buf.subarray(cut)), 50);
  });
  return done;
}

// Byte index between bytes 2 and 3 of the payload's only 4-byte emoji.
function midEmojiCut(input) {
  const buf = Buffer.from(`${JSON.stringify(input)}\n`, 'utf8');
  return buf.indexOf(0xf0) + 2;
}

const decision = (resp) => resp.hookSpecificOutput.permissionDecision;
const denyReason = (resp) => resp.hookSpecificOutput.permissionDecisionReason;

// >64 KB so a single write to the child cannot fit the OS pipe buffer.
const FILLER = 'A'.repeat(400 * 1024);

describe('APE v2 hook stdin multibyte decode (audit finding 1.8)', () => {
  it('denies the in-project main-session write when delivered as one stdin chunk', async () => {
    // Baseline: a correct decode resolves file_path under the emoji-bearing
    // root, so the main-session production write is denied.
    const dir = await emojiProject();
    const single = await invokeHookSingle(preToolUseWrite(dir), dir);
    expect(decision(single)).toBe('deny');
    expect(denyReason(single)).toMatch(/main-session production writes are forbidden/);
  });

  it('reaches the identical decision when a codepoint is split across stdin chunks', async () => {
    const dir = await emojiProject();
    // The decision must not depend on stdin chunking: whole-payload delivery
    // and split-codepoint delivery of the same event must agree.
    const single = await invokeHookSingle(preToolUseWrite(dir), dir);
    expect(decision(single)).toBe('deny');

    const payload = preToolUseWrite(dir, FILLER);
    const cut = midEmojiCut(payload);
    // Repeat so a rare pipe-coalescing read cannot mask the defect: on the
    // per-chunk-decode code every split delivery flips to an out-of-project
    // ALLOW, so the very first mismatch fails the test.
    for (let i = 0; i < 5; i += 1) {
      const split = await invokeHookSplit(payload, dir, cut);
      expect(decision(split), `split #${i}: ${denyReason(split)}`).toBe(decision(single));
    }
  });
});
