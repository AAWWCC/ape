import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnWithTimeout } from '../lib/runtime/spawn.js';

const ENTRY = fileURLToPath(import.meta.url);
const WORKER = '--ape-native-json-worker';
const DEFAULTS = { timeoutMs: 60000, killGraceMs: 3000, cleanupMs: 3000, maxOutputBytes: 1024 * 1024 };

function readOptions(options) {
  const resolved = {};
  for (const [name, fallback] of Object.entries(DEFAULTS)) {
    const value = options[name] ?? fallback;
    // Leave headroom for the combined outer deadline without setTimeout
    // overflowing its signed 32-bit range and becoming an immediate kill.
    if (!Number.isSafeInteger(value) || value <= 0 || value > 0x0fffffff) {
      throw new TypeError(`${name} must be a positive integer no greater than ${0x0fffffff}`);
    }
    resolved[name] = value;
  }
  return resolved;
}

/** Retire one ChildProcess, preserving caller listeners and requiring an exit observation. */
export function retireChild(child, signal = 'SIGTERM', { killGraceMs = 3000, cleanupMs = 3000 } = {}) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
    let settled = false;
    let signalled = false;
    let lastError;
    let escalation;
    let deadline;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(escalation);
      clearTimeout(deadline);
      child.off('spawn', onSpawn);
      child.off('exit', onExit);
      child.off('error', onError);
      if (error) reject(error); else resolve();
    };
    const onExit = () => finish();
    const onError = (error) => {
      // A failed spawn has no process to retire. Other errors (e.g. EPERM
      // delivering a signal) do not prove the live process has exited.
      if (!Number.isInteger(child.pid) || child.pid <= 1) finish(error);
      else lastError = error;
    };
    const send = (value) => {
      // Node can retain a native process handle with PID 0 until an async
      // spawn error is emitted. Calling kill on that handle can signal our
      // own process group on macOS. Await spawn/error instead.
      if (settled || !Number.isInteger(child.pid) || child.pid <= 1) return;
      try { child.kill(value); } catch (error) { lastError = error; }
    };
    const onSpawn = () => {
      if (signalled || !Number.isInteger(child.pid) || child.pid <= 1) return;
      signalled = true;
      send(signal);
    };
    child.once('spawn', onSpawn);
    child.once('exit', onExit);
    child.on('error', onError);
    // Arm before signalling: fake and real event races must not leave a
    // timer behind if signalling itself completes retirement.
    deadline = setTimeout(() => finish(new Error(
      `Child cleanup could not confirm exit${lastError ? `: ${lastError.message}` : ''}`,
    )), (signal === 'SIGKILL' ? 0 : killGraceMs) + cleanupMs);
    if (signal !== 'SIGKILL') escalation = setTimeout(() => send('SIGKILL'), killGraceMs);
    onSpawn();
  });
}

/**
 * Execute a JSON-speaking helper inside the runtime's owned process group
 * (POSIX) or Job Object (Windows). The small worker supplies stdin, enforces
 * the combined byte limit, and allows graceful direct-child termination.
 * The outer owner retires descendants before any result reaches the caller,
 * including on worker exit or abrupt loss of the invoking test harness.
 */
export async function runNativeJson(command, args = [], options = {}) {
  const limits = readOptions(options);
  if (typeof command !== 'string' || !command || !Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) {
    throw new TypeError('runNativeJson requires a nonempty command and string arguments');
  }
  if (options.input !== undefined && typeof options.input !== 'string') throw new TypeError('input must be a string');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ape-native-json-'));
  try {
    // Stdin can exceed argv/environment limits. A private, short-lived file
    // carries the launch data without quoting, truncation, or shell parsing.
    const job = path.join(dir, 'job.json');
    await writeFile(job, JSON.stringify({ command, args, limits, cwd: options.cwd,
      env: options.env ?? process.env, input: options.input ?? '' }), { mode: 0o600 });
    const result = await spawnWithTimeout(process.execPath, [ENTRY, WORKER, job], {
      supervise: true, collect: 'separate', stdout_bytes: true,
      // JSON encoding expands control characters by at most six bytes.
      max_output: limits.maxOutputBytes * 6 + 16384,
      timeout_ms: limits.timeoutMs + limits.killGraceMs + limits.cleanupMs * 2 + 5000,
      kill_grace_ms: limits.cleanupMs, drain_ms: limits.cleanupMs,
    });
    if (result.cleanup?.status !== 'confirmed') throw new Error(`Native helper cleanup could not confirm retirement: ${result.cleanup?.cause ?? 'no proof'}`);
    if (result.spawn_error) throw new Error(`Native helper spawn failed: ${result.spawn_error.message.slice(0, 4096)}`);
    if (result.timed_out) throw new Error('Native helper supervision timed out');
    if (result.exit_code !== 0) throw new Error(`Native helper worker exited with ${result.signal ?? result.exit_code}: ${result.stderr.slice(0, 4096)}`);
    if (result.stdout_truncated) throw new Error('Native helper result exceeded its output limit');
    let envelope;
    try { envelope = JSON.parse(result.stdout_bytes?.toString('utf8') ?? result.stdout); }
    catch { throw new Error('Native helper worker returned invalid JSON'); }
    if (envelope.error) throw new Error(envelope.error);
    try { return JSON.parse(envelope.stdout); }
    catch { throw new Error(`Native helper returned invalid or empty JSON: ${String(envelope.stdout).slice(0, 4096)}`); }
  } finally { await rm(dir, { recursive: true, force: true }); }
}

async function execute(job) {
  const { command, args, cwd, env, input, limits } = job;
  return new Promise((resolve) => {
    let child;
    try { child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }); }
    catch (error) { resolve({ error: `Native helper spawn failed: ${error.message}` }); return; }
    let error;
    let timeout;
    let drain;
    let stopping;
    let settled = false;
    let exited = false;
    let closed = false;
    let bytes = 0;
    const stdout = [];
    const stderr = [];
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(drain);
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      if (!exited) child.unref();
      const detail = Buffer.concat(stderr).toString('utf8').slice(0, 4096);
      resolve(error ? { error: Buffer.from(`${error}${detail ? `: ${detail}` : ''}`).subarray(0, 6000).toString('utf8') }
        : { stdout: Buffer.concat(stdout).toString('utf8') });
    };
    const finishAfterStop = () => { if (stopping) stopping.then(finish); else finish(); };
    const stop = (reason) => {
      if (settled) return;
      error ??= reason;
      if (stopping || exited) return;
      stopping = retireChild(child, 'SIGTERM', limits).catch((fault) => {
        error = `${error}; ${fault.message}`;
      });
      // Even denied signalling must settle: the outer owner then retires
      // the whole group/job and checks its independent cleanup proof.
      stopping.then(() => { if (closed || !exited) finish(); });
    };
    const collect = (target) => (chunk) => {
      if (settled) return;
      const remaining = Math.max(0, limits.maxOutputBytes - bytes);
      if (remaining) target.push(chunk.subarray(0, remaining));
      bytes += chunk.length;
      if (bytes > limits.maxOutputBytes) stop(`Native helper output exceeded ${limits.maxOutputBytes} byte limit`);
    };
    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));
    child.stdin.on('error', (fault) => stop(`Native helper stdin failed: ${fault.code ?? fault.message}`));
    child.on('error', (fault) => {
      if (settled) return;
      error ??= `Native helper spawn failed: ${fault.code ?? ''} ${fault.message}`;
      if (!child.pid) finish(); else stop(error);
    });
    child.once('exit', (code, signal) => {
      if (settled) return;
      exited = true;
      clearTimeout(timeout);
      if (code !== 0) error ??= `Native helper exited with ${signal ?? code}`;
      // A descendant may retain these pipes after the command exits. Drain
      // for a bounded interval, then let the outer owner retire that tree.
      drain = setTimeout(finishAfterStop, limits.cleanupMs);
    });
    child.once('close', () => { closed = true; finishAfterStop(); });
    timeout = setTimeout(() => stop(`Native helper timed out after ${limits.timeoutMs}ms`), limits.timeoutMs);
    child.stdin.end(input);
  });
}

if (process.argv[1] === ENTRY && process.argv[2] === WORKER) {
  try {
    const job = JSON.parse(await readFile(process.argv[3], 'utf8'));
    await rm(process.argv[3]);
    process.stdout.write(JSON.stringify(await execute(job)));
  } catch (error) {
    process.stdout.write(JSON.stringify({ error: `Native helper worker failed: ${error.message}`.slice(0, 6000) }));
  }
}
