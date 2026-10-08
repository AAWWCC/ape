import { localExecutionIdentity, isLocalExecution } from './host-identity.js';
import { spawn } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { createServer, createConnection } from 'node:net';
import path from 'node:path';
import { constants, realpathSync } from 'node:fs';
import { open, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { lstatFile, statFileHandle } from './file-stats.js';

// Kept in this builtins-only leaf so the independently packaged suite runner
// can inspect manifests without acquiring the runtime's storage dependency graph.
export async function readBoundedRegularFileUtf8(file, { maxBytes = 256 * 1024 } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new RangeError('invalid file byte limit');
  const regular = (metadata) => metadata.isFile() && !metadata.isSymbolicLink() && metadata.nlink === 1 && metadata.size <= maxBytes;
  const same = (left, right) => ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs']
    .every((key) => left[key] === right[key]);
  const unsafe = () => Object.assign(new Error('file must be a stable bounded regular file'), {
    code: 'APE_UNSAFE_FILE',
  });
  const before = await lstatFile(file);
  if (!regular(before)) throw unsafe();
  const handle = await open(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) |
    (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await statFileHandle(handle);
    if (!regular(opened) || !same(before, opened)) throw unsafe();
    const buffer = Buffer.alloc(opened.size + 1);
    let used = 0;
    while (used < buffer.length) {
      const { bytesRead } = await handle.read(buffer, used, buffer.length - used, used);
      if (!bytesRead) break;
      used += bytesRead;
    }
    const after = await statFileHandle(handle);
    const current = await lstatFile(file);
    if (used !== opened.size || !regular(after) || !regular(current) ||
        !same(opened, after) || !same(opened, current)) throw unsafe();
    return buffer.subarray(0, used).toString('utf8');
  } finally { await handle.close(); }
}

const DEFAULT_KILL_GRACE_MS = 10_000;
const DEFAULT_DRAIN_MS = 5_000;
const SUITE_SUPERVISOR_SENTINEL = '--ape-suite-supervisor';

// The proof broker is outside the suite's kill domain and outlives its
// launching host. Disk PIDs are diagnostic only; a fresh private challenge
// authenticates recovery. Every execution is fenced by a durable reservation.
const GATE_BROKER_SENTINEL = '--ape-gate-proof-broker';
const ownershipMac = (secret, value) => createHmac('sha256', secret).update(JSON.stringify(value)).digest('hex');

async function writeOwnershipFile(file, value) {
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); }
  finally { await handle.close(); }
  await rename(temporary, file);
  if (process.platform !== 'win32') {
    const dir = await open(path.dirname(file), 'r');
    try { await dir.sync(); } finally { await dir.close(); }
  }
}

export async function readGateOwnership(file) {
  return JSON.parse(await readBoundedRegularFileUtf8(file, { maxBytes: 1024 * 1024 }));
}

// The caller has validated the project/run and derived paths before invoking
// this transport. A recycled TCP port cannot answer the generation challenge.
export function queryGateBroker(record, action = 'inspect') {
  if (!isLocalExecution(record?.host) || record.watch?.host !== record.host) return Promise.resolve(null);
  return new Promise((resolve) => {
    const challenge = randomUUID();
    const request = { challenge, generation: record.generation, action };
    let socket, text = '', done = false;
    const finish = (value) => { if (done) return; done = true; clearTimeout(timer); socket?.destroy(); resolve(value); };
    const timer = setTimeout(() => finish(null), 1000);
    if (!Number.isInteger(record.port) || record.port < 1 || record.port > 65535 || typeof record.secret !== 'string') return finish(null);
    socket = createConnection({ host: '127.0.0.1', port: record.port });
    socket.on('error', () => finish(null));
    socket.on('connect', () => socket.write(JSON.stringify({ ...request, mac: ownershipMac(record.secret, request) }) + '\n'));
    socket.on('data', (chunk) => {
      text += chunk;
      if (text.length > 1024 * 1024) return finish(null);
      if (!text.includes('\n')) return;
      try {
        const message = JSON.parse(text.trim());
        const expected = ownershipMac(record.secret, { challenge, generation: record.generation, payload: message.payload });
        finish(message.mac === expected ? message.payload : null);
      } catch { finish(null); }
    });
  });
}

export async function readGateProof(record) {
  try {
    if (!isLocalExecution(record?.host) || record.watch?.host !== record.host) return null;
    const proof = await readGateOwnership(record.proof_file);
    if (proof.generation !== record.generation || proof.mac !== ownershipMac(record.secret, proof.payload)) return null;
    // The broker's proof is immutable after exit. Its runner acknowledges
    // heartbeat drain separately, bound to these exact authenticated bytes.
    if (proof.payload?.producers?.result_published === true && proof.payload.producers.heartbeat_drained !== true) {
      try {
        const completion = await readGateOwnership(`${record.proof_file}.producers.json`);
        if (completion.generation === record.generation &&
            completion.mac === ownershipMac(record.secret, completion.payload) &&
            completion.payload?.proof_mac === proof.mac && completion.payload.heartbeat_drained === true) {
          return { ...proof.payload, producers: { ...proof.payload.producers, heartbeat_drained: true } };
        }
      } catch { /* Missing or incomplete producer evidence never grants cleanup. */ }
    }
    return proof.payload;
  } catch { return null; }
}

// Spawned only by the registered runner, with an IPC lifeline. The launch
// owner can disappear after permission without destroying recoverable work;
// loss of the runner instead stops the suite and publishes a separate proof.
async function runGateProofBroker() {
  let accepted = false;
  process.once('message', async (input) => {
    const message = /** @type {any} */ (input);
    if (accepted || message?.type !== 'reserve' || typeof message.job_file !== 'string') return process.exit(1);
    accepted = true;
    let server;
    const cancellation = new AbortController();
    process.on('disconnect', () => cancellation.abort());
    process.on('message', (m) => { if ((/** @type {any} */ (m))?.type === 'stop') cancellation.abort(); });
    try {
      const job = await readGateOwnership(message.job_file);
      const record = await readGateOwnership(job.ownership_file);
      if (record.phase !== 'reserved' || record.generation !== job.nonce || record.secret !== message.secret ||
          record.host !== localExecutionIdentity() || job.host !== record.host || record.watch.host !== record.host || record.project_dir !== job.project_dir ||
          record.watch.job_file !== message.job_file || record.run_id !== job.run_id ||
          job.artifact_file !== record.watch.artifact_file || job.heartbeat_file !== record.watch.heartbeat_file ||
          JSON.stringify(job.plan) !== JSON.stringify(record.watch.plan)) throw new Error('ownership reservation mismatch');
      record.watch.pid = message.runner_pid;
      record.broker_pid = process.pid;
      record.phase = 'registered';
      let proof = null;
      server = createServer((socket) => {
        let input = '';
        socket.setTimeout(1000, () => socket.destroy());
        socket.on('error', () => {});
        socket.on('data', (chunk) => {
          input += chunk;
          if (input.length > 4096) return socket.destroy();
          if (!input.includes('\n')) return;
          try {
            const m = JSON.parse(input.trim());
            const request = { challenge: m.challenge, generation: m.generation, action: m.action };
            if (typeof m.challenge !== 'string' || m.challenge.length > 100 || m.generation !== record.generation ||
                m.mac !== ownershipMac(record.secret, request)) return socket.destroy();
            if (m.action === 'stop') cancellation.abort();
            const payload = { watch: record.watch, generation: record.generation, proof };
            socket.end(JSON.stringify({ payload, mac: ownershipMac(record.secret, { challenge: m.challenge, generation: record.generation, payload }) }) + '\n');
          } catch { socket.destroy(); }
        });
      });
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('invalid broker endpoint');
      record.port = address.port;
      await writeOwnershipFile(job.ownership_file, record);
      const permitted = new Promise((resolve) => {
        process.once('message', (input) => {
          const m = /** @type {any} */ (input);
          resolve(m?.type === 'execute' && m.generation === record.generation);
        });
        process.once('disconnect', () => resolve(false));
      });
      process.send?.({ type: 'registered', generation: record.generation });
      const permission = await permitted;
      const latest = await readGateOwnership(job.ownership_file);
      if (latest.generation !== record.generation || latest.secret !== record.secret || latest.broker_pid !== process.pid) throw new Error('ownership changed before execution');
      const started = Date.now();
      const result = permission && !cancellation.signal.aborted
        ? await spawnWithTimeout(job.plan.command, job.plan.args ?? [], {
          cwd: job.suite_cwd ?? job.project_dir, shell: job.plan.shell === true,
          supervise: true, signal: cancellation.signal, timeout_ms: job.timeout_ms,
          collect: 'combined', max_output: 200_000,
          env: { APE_GATE_RUNNER_JOB: undefined },
        })
        : { exit_code: null, timed_out: false, aborted: true, combined: '', spawn_error: null,
          cleanup: { status: 'confirmed', cause: 'execution permission was not issued' } };
      const duration = Date.now() - started;
      const passed = result.cleanup?.status === 'confirmed' && !result.spawn_error && result.exit_code === 0 && !result.timed_out && !result.aborted;
      const verification = { passed, exit_code: result.exit_code, duration_ms: duration,
        output: result.spawn_error ? result.spawn_error.message : result.combined,
        tooling_failure: Boolean(result.spawn_error),
        ...(result.timed_out ? { timed_out: true } : {}), ...(result.aborted ? { aborted: true } : {}) };
      proof = { cleanup: result.cleanup ?? { status: 'unknown', cause: 'missing containment proof' },
        artifact: { version: 1, run_id: job.run_id, nonce: job.nonce, cache_key: job.cache_key,
          passed, duration_ms: duration, verification, recorded_at: new Date().toISOString() },
        retry: result.aborted === true };
      await writeOwnershipFile(record.proof_file, { generation: record.generation, payload: proof, mac: ownershipMac(record.secret, proof) });
      await writeOwnershipFile(job.artifact_file, proof.artifact);
      if (proof.cleanup.status === 'confirmed') {
        proof = { ...proof, producers: { result_published: true, heartbeat_drained: false } };
        await writeOwnershipFile(record.proof_file, { generation: record.generation, payload: proof, mac: ownershipMac(record.secret, proof) });
      }
      process.send?.({ type: 'finished', generation: record.generation }, () => {});
    } catch (error) {
      process.send?.({ type: 'broker-error', cause: String(error?.message ?? error).slice(0, 1024) }, () => {});
    } finally {
      server?.close();
      if (process.connected) process.disconnect();
    }
  });
}

export async function runOwnedGateJob(jobFile, job) {
  const record = await readGateOwnership(job.ownership_file);
  if (!isLocalExecution(record.host) || job.host !== record.host || record.watch?.host !== record.host) return;
  if (record.phase !== 'reserved' || record.generation !== job.nonce || record.watch.job_file !== jobFile) return;
  const broker = spawn(process.execPath, [resolveSuiteSupervisorEntry(), GATE_BROKER_SENTINEL], {
    cwd: job.project_dir, detached: true, windowsHide: true,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    env: { ...process.env, APE_GATE_RUNNER_JOB: undefined },
  });
  let beatRunning = null;
  let beatFailed = false;
  const beat = () => {
    if (!beatRunning) beatRunning = writeOwnershipFile(job.heartbeat_file, { pid: process.pid, beat_at: Date.now() })
      .catch(() => { beatFailed = true; }).finally(() => { beatRunning = null; });
  };
  beat();
  const heartbeat = setInterval(beat, job.heartbeat_ms ?? 5000);
  const stop = () => { if (broker.connected) broker.send({ type: 'stop' }, () => {}); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  await new Promise((resolve) => {
    let permitted = false;
    const timer = setTimeout(() => { if (!permitted && broker.connected) broker.disconnect(); }, 30_000);
    broker.once('error', () => { clearTimeout(timer); resolve(); });
    broker.once('exit', () => { clearTimeout(timer); resolve(); });
    process.once('disconnect', () => { if (!permitted && broker.connected) broker.disconnect(); });
    broker.on('message', (input) => {
      const m = /** @type {any} */ (input);
      if (m?.generation !== job.nonce) return;
      if (m.type === 'registered') {
        if (!process.connected) { broker.disconnect(); return; }
        process.once('message', (input) => {
          const permission = /** @type {any} */ (input);
          if (permission?.type !== 'execute' || permission.generation !== job.nonce) { broker.disconnect(); return; }
          permitted = true;
          clearTimeout(timer);
          broker.send(permission);
          process.disconnect();
        });
        process.send?.(m);
      }
    });
    broker.once('spawn', () => broker.send({ type: 'reserve', job_file: jobFile, secret: record.secret, runner_pid: process.pid }));
  });
  clearInterval(heartbeat);
  if (beatRunning) await beatRunning;
  // Broker exit hands completion authority to its runner. The broker has
  // finished every result/proof write, and no heartbeat can start after the
  // interval is stopped. Never infer this boundary from PID disappearance.
  const proof = await readGateProof(record);
  if (!beatFailed && proof?.producers?.result_published === true) {
    const published = await readGateOwnership(record.proof_file);
    const completed = { proof_mac: published.mac, heartbeat_drained: true };
    await writeOwnershipFile(`${record.proof_file}.producers.json`, { generation: record.generation,
      payload: completed, mac: ownershipMac(record.secret, completed) });
  }
  process.off('SIGTERM', stop);
  process.off('SIGINT', stop);
}

if (process.argv[2] === GATE_BROKER_SENTINEL && process.send) {
  try { if (realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) runGateProofBroker(); }
  catch { /* only the unbundled broker entry may execute */ }
}

// Source callers live in lib/runtime; bundled callers live in dist. Always
// launch the packaged unbundled helper: import.meta.url itself names the MCP
// bundle after bundling and would otherwise launch another server as a suite.
function resolveSuiteSupervisorEntry() {
  for (const relative of ['./spawn.js', '../lib/runtime/spawn.js']) {
    try { return realpathSync(fileURLToPath(new URL(relative, import.meta.url))); }
    catch { /* try the other supported runtime layout */ }
  }
  throw new Error('Suite supervisor entry is unavailable; restore lib/runtime/spawn.js');
}

/** @typedef {{ type: 'ape-suite-start', version: 1, command: string, args: string[], shell: boolean }} SupervisorStart */
/** @typedef {{ type: 'ape-suite-completion', version: 1, exit_code: number | null, signal: string | null, spawn_error: { message: string, code?: string } | null }} SupervisorCompletion */

/** @returns {message is SupervisorStart} */
function validSupervisorStart(message) {
  return message && typeof message === 'object' && !Array.isArray(message) &&
    message.type === 'ape-suite-start' && message.version === 1 &&
    typeof message.command === 'string' && Array.isArray(message.args) &&
    message.args.every((arg) => typeof arg === 'string') && typeof message.shell === 'boolean';
}

// This unbundled entry ships beside runner.js. The calling process's owned IPC
// channel is a lifeline, not a durable numeric PID that can later be recycled.
// The supervisor remains the POSIX group leader even after the real command
// exits, so cleanup can still reach ordinary grandchildren safely. The real
// command gets no IPC channel. On runner death, the supervisor kills its OWN
// group; on completion, the runner kills that still-live group before settling.
function runSuiteSupervisor() {
  if (!process.send || !process.connected || process.platform === 'win32') { process.exitCode = 1; return; }
  const stopGroup = () => {
    try { process.kill(-process.pid, 'SIGKILL'); }
    catch { process.exit(1); }
  };
  process.on('disconnect', stopGroup);
  process.on('SIGTERM', stopGroup);
  process.on('SIGINT', stopGroup);
  let launched = false;
  const complete = (exit_code, signal, error = null) => {
    const spawn_error = error ? { message: String(error.message).slice(0, 4096),
      ...(typeof error.code === 'string' ? { code: error.code.slice(0, 64) } : {}) } : null;
    process.send?.({ type: 'ape-suite-completion', version: 1, exit_code, signal, spawn_error }, (sendError) => {
      if (sendError) stopGroup();
    });
  };
  process.on('message', (message) => {
    if (launched || !validSupervisorStart(message)) {
      stopGroup();
      return;
    }
    launched = true;
    let command;
    try {
      command = spawn(message.command, message.args, {
        shell: message.shell, detached: false, windowsHide: true,
        stdio: ['ignore', 'inherit', 'inherit'],
        env: { ...process.env, NODE_CHANNEL_FD: undefined, NODE_CHANNEL_SERIALIZATION_MODE: undefined },
      });
    } catch (error) { complete(null, null, error); return; }
    command.once('error', (error) => complete(null, null, error));
    command.once('exit', (code, signal) => complete(code, signal));
  });
}

/** @returns {message is SupervisorCompletion} */
function validSupervisorCompletion(message) {
  return message && typeof message === 'object' && !Array.isArray(message) &&
    message.type === 'ape-suite-completion' && message.version === 1 &&
    (message.exit_code === null || (Number.isInteger(message.exit_code) && message.exit_code >= 0 && message.exit_code <= 255)) &&
    (message.signal === null || (typeof message.signal === 'string' && /^SIG[A-Z0-9]+$/.test(message.signal))) &&
    (message.spawn_error === null || (message.spawn_error && typeof message.spawn_error.message === 'string' &&
      message.spawn_error.message.length <= 4096 && (message.spawn_error.code === undefined ||
      (typeof message.spawn_error.code === 'string' && message.spawn_error.code.length <= 64))));
}

// Force-kill the child's entire process tree. A bare child.kill() reaches only
// the direct child: test suites and remote-check watchers routinely fan out
// grandchildren (npm -> vitest -> dev server) that survive it and keep running.
// POSIX children are spawned detached — each is its own process-group leader —
// so signalling -pid reaches every descendant that has not re-detached itself.
// win32 has no signal-able process groups: taskkill /T /F walks the tree by
// pid and force-terminates it (D1); if taskkill itself cannot run, the direct
// child is terminated so its 'exit' event still fires.
function killTree(child, signal) {
  if (process.platform !== 'win32') {
    try {
      process.kill(-child.pid, signal);
    } catch {
      // Group already reaped (or never became signalable): fall back to the
      // direct child handle so a lone straggler still dies.
      try { child.kill(signal); } catch { /* already gone */ }
    }
    return;
  }
  let killer = null;
  try {
    killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
  } catch { /* fall through to the direct kill below */ }
  if (killer) {
    killer.on('error', () => { try { child.kill(); } catch { /* gone */ } });
  } else {
    try { child.kill(); } catch { /* gone */ }
  }
}

// Bounded process execution shared by every runtime spawn site (test suites,
// merge-gate commands, git plumbing). The per-site pattern it replaces — one
// SIGTERM on timeout, resolve only on 'close' — had two liveness holes, both
// fatal inside the receipt-effects lock where a parked promise starves abort,
// override, and next until the host process dies:
//   1. a child that traps SIGTERM (or a win32 tree whose grandchildren never
//      receive it) simply keeps running;
//   2. 'close' waits for the stdio pipes to drain, so a grandchild that
//      inherited them keeps the promise pending even after the child exited.
// This helper always settles and never rejects — every failure mode is a
// field on the resolved result.
//
// Options: cwd, shell, env (merged over process.env only when provided),
// timeout_ms (callers own their defaults; no timer is armed without one),
// kill_grace_ms (SIGTERM -> SIGKILL escalation window), drain_ms (post-exit
// stdio wait), collect ('combined' default | 'separate'), max_output
// (strict per-stream string-length limit in separate mode; combined mode keeps
// its historical before-append cap), stdout_bytes (separate mode only: collect
// stdout as a Buffer in stdout_bytes without decoding), signal, supervise
// (POSIX suites: keep an owned group leader until tree cleanup).
//
// Result: { exit_code, signal, timed_out, stdout, stderr, combined,
// spawn_error }. timed_out is true only when the timeout fired and initiated
// the kill. Callers whose results feed sha256 hashes must translate it to an
// absent-when-false field so every non-timeout hash stays byte-identical.
export function spawnWithTimeout(command, args, options = {}) {
  if (options.supervise === true && process.platform === 'win32') return spawnWindowsOwned(command, args ?? [], options);
  const killGraceMs = options.kill_grace_ms ?? DEFAULT_KILL_GRACE_MS;
  const drainMs = options.drain_ms ?? DEFAULT_DRAIN_MS;
  const combinedMode = options.collect !== 'separate';
  const binaryStdout = !combinedMode && options.stdout_bytes === true;
  const maxOutput = options.max_output;
  // Windows retains the existing live parent chain and taskkill /T behavior.
  const supervised = options.supervise === true && process.platform !== 'win32';
  return new Promise((resolve) => {
    if (options.signal?.aborted) {
      resolve({ exit_code: null, signal: null, timed_out: false, aborted: true,
        stdout: '', stderr: '', combined: '', spawn_error: null });
      return;
    }
    let child;
    try {
      child = spawn(supervised ? process.execPath : command,
        supervised ? [resolveSuiteSupervisorEntry(), SUITE_SUPERVISOR_SENTINEL] : args ?? [], {
        cwd: options.cwd,
        shell: supervised ? false : options.shell ?? false,
        windowsHide: true,
        stdio: supervised ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'],
        // POSIX: make the child a process-group leader so the timeout can
        // signal the whole tree at once. Never detach on win32 — taskkill
        // walks the tree by pid there instead. Nested runners relay cancellation
        // through options.signal so the suite retains its own timeout group.
        detached: supervised || (options.detached ?? process.platform !== 'win32'),
        ...(options.env ? { env: { ...process.env, ...options.env } } : {}),
      });
    } catch (error) {
      resolve({
        exit_code: null, signal: null, timed_out: false,
        stdout: '', stderr: '', combined: '', spawn_error: error,
      });
      return;
    }
    let stdout = '';
    const stdoutChunks = [];
    let stdoutBytes = 0;
    let stderr = '';
    let combined = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let aborted = false;
    // Whether the timeout's force-kill has already been delivered to the tree.
    // Exactly one of the escalate callback and the 'exit' handler below may
    // deliver it; a second one would double-signal the group.
    let escalated = false;
    let exitInfo = null;
    let completion = null;
    let supervisorError = null;
    let settled = false;
    let timeoutTimer = null;
    let escalateTimer = null;
    let failsafeTimer = null;
    let drainTimer = null;

    const settle = async (spawnError = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(escalateTimer);
      clearTimeout(failsafeTimer);
      clearTimeout(drainTimer);
      options.signal?.removeEventListener('abort', abort);
      if (supervised && child.connected) {
        try { child.disconnect(); } catch { /* already disconnected */ }
      }
      let cleanup;
      if (supervised) {
        cleanup = { status: 'unknown', cause: 'process-group retirement was not observed' };
        if (!child.pid) cleanup = { status: 'confirmed', cause: 'no process was created' };
        else {
          const deadline = Date.now() + Math.max(1000, killGraceMs);
          do {
            try { process.kill(-child.pid, 0); }
            catch (error) {
              cleanup = error?.code === 'ESRCH'
                ? { status: 'confirmed', cause: 'owned process group is empty' }
                : { status: 'unknown', cause: `process-group query failed (${error?.code ?? 'unknown'})` };
              if (error?.code === 'ESRCH') break;
              // A denied probe supplies no retirement evidence. Keep probing
              // within the same bounded retirement window: only ESRCH can
              // confirm emptiness, and a persistent denial stays unknown.
            }
            await sleep(10);
          } while (Date.now() < deadline);
        }
      }
      resolve({
        exit_code: completion ? completion.exit_code : exitInfo?.code ?? null,
        signal: completion ? completion.signal : exitInfo?.signal ?? null,
        timed_out: timedOut,
        ...(aborted ? { aborted: true } : {}),
        stdout,
        ...(binaryStdout ? { stdout_bytes: Buffer.concat(stdoutChunks, stdoutBytes) } : {}),
        stderr,
        combined,
        ...(!combinedMode ? { stdout_truncated: stdoutTruncated, stderr_truncated: stderrTruncated } : {}),
        spawn_error: spawnError ?? supervisorError,
        ...(cleanup ? { cleanup } : {}),
      });
    };
    const collect = (chunk, stream) => {
      if (combinedMode) {
        // The cap is checked before the append (never mid-chunk), preserving
        // the historical overshoot-by-at-most-one-chunk cap semantics.
        if (maxOutput === undefined || combined.length < maxOutput) combined += chunk;
      } else if (stream === 'stdout') {
        if (binaryStdout) {
          const part = maxOutput === undefined ? chunk : chunk.subarray(0, Math.max(0, maxOutput - stdoutBytes));
          stdoutTruncated ||= part.length < chunk.length;
          stdoutChunks.push(part);
          stdoutBytes += part.length;
          return;
        }
        const part = maxOutput === undefined ? chunk : chunk.slice(0, Math.max(0, maxOutput - stdout.length));
        stdoutTruncated ||= part.length < chunk.length;
        stdout += part;
      } else {
        const part = maxOutput === undefined ? chunk : chunk.slice(0, Math.max(0, maxOutput - stderr.length));
        stderrTruncated ||= part.length < chunk.length;
        stderr += part;
      }
    };
    if (!binaryStdout) child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => collect(chunk, 'stdout'));
    child.stderr.on('data', (chunk) => collect(chunk, 'stderr'));

    // The owner may itself be about to exit. Cancel the live, owned process
    // group immediately rather than relying on a later timer in that owner.
    const abort = () => {
      if (settled) return;
      aborted = true;
      clearTimeout(timeoutTimer);
      clearTimeout(escalateTimer);
      clearTimeout(failsafeTimer);
      escalated = true;
      // Do not signal a recycled numeric group after losing the live child.
      if (child.exitCode === null && child.signalCode === null) killTree(child, 'SIGKILL');
      failsafeTimer = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.unref?.();
        settle();
      }, killGraceMs);
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();

    // Arm the deadline for any finite number a caller provided (setTimeout
    // clamps degenerate values to "immediately", which fails closed: a
    // nonsense deadline must never mean "no deadline"). Only an absent
    // timeout_ms leaves the timer unarmed — setTimeout with an undefined
    // delay would fire on the next tick and brand everything timed_out.
    if (!aborted && Number.isFinite(options.timeout_ms)) {
      timeoutTimer = setTimeout(() => {
        // The child can exit in the same tick the timer fires; a verdict that
        // beat the deadline must not be branded timed_out.
        if (child.exitCode !== null || child.signalCode !== null) return;
        timedOut = true;
        killTree(child, 'SIGTERM');
        escalateTimer = setTimeout(() => {
          // Both branches below force-kill, so the escalation is spent either
          // way and the 'exit' handler must not repeat it.
          escalated = true;
          if (process.platform !== 'win32') {
            killTree(child, 'SIGKILL');
          } else {
            // taskkill /F already force-killed; this only matters when
            // taskkill itself failed to act.
            try { child.kill(); } catch { /* gone */ }
          }
          // Last-resort liveness: if even the forced kill produces no 'exit'
          // (win32 taskkill denied, or a child stuck in uninterruptible
          // sleep), settle anyway with what we have — a timed-out result must
          // never park the receipt lock behind an unkillable process. unref
          // so the zombie handle cannot pin the host process either.
          failsafeTimer = setTimeout(() => {
            child.stdout?.destroy();
            child.stderr?.destroy();
            child.unref?.();
            settle();
          }, killGraceMs);
        }, killGraceMs);
      }, options.timeout_ms);
    }

    child.on('error', (error) => {
      // Spawn failures (ENOENT and friends) may never emit 'exit'.
      if (supervised && child.pid && child.exitCode === null && child.signalCode === null) killTree(child, 'SIGKILL');
      settle(error);
    });
    child.on('exit', (code, signal) => {
      exitInfo = { code, signal };
      if (supervised && !completion && !timedOut && !aborted) {
        supervisorError = new Error('Suite supervisor exited without reporting the command result');
      }
      // An OWED escalation is DELIVERED here rather than dropped. A supervised
      // group is also cleaned at the exact owned leader-exit event if that
      // leader died unexpectedly before reporting completion. The direct
      // child routinely dies on the polite group SIGTERM (sh, npm and vitest
      // all do) while a DESCENDANT ignores or slow-walks it; settle() then
      // clears escalateTimer — on the shipped defaults the drain deadline
      // lands 5s BEFORE the escalate deadline — so the only force-kill that
      // ever reaches that descendant would be LOST, not merely late, and it
      // would survive to keep writing the project tree. Delivering it at the
      // exit instant is safe because POSIX keeps a pid NUMBER allocated while
      // it is still in use as an active process-group id: kill(-pid) can
      // only miss the original group once that group is EMPTY, exactly when
      // there is nothing left to kill and the ESRCH is harmless.
      if ((timedOut || supervised) && !escalated) {
        escalated = true;
        // win32 is never owed one: killTree's polite step there is ALREADY
        // `taskkill /T /F` on the whole tree, and node closes the process
        // handle before emitting 'exit', so a second taskkill here would
        // target a pid Windows may have already reused.
        if (process.platform !== 'win32') killTree(child, 'SIGKILL');
      }
      // The process is dead; the deadline, the escalation and the forced-kill
      // failsafe no longer apply. drainTimer is deliberately left armed — it
      // is what settles this promise.
      clearTimeout(timeoutTimer);
      clearTimeout(escalateTimer);
      clearTimeout(failsafeTimer);
      // 'close' can lag 'exit' indefinitely: a grandchild that inherited the
      // stdio pipes holds them for its whole lifetime. Wait a bounded drain
      // window for trailing output, then destroy our read ends and settle —
      // a pipe-holding grandchild must never park this promise.
      drainTimer = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        settle();
      }, drainMs);
    });
    child.on('close', (code, signal) => {
      exitInfo = { code, signal };
      settle();
    });
    if (supervised) {
      child.on('message', (message) => {
        if (settled || completion) return;
        if (!validSupervisorCompletion(message)) {
          supervisorError = new Error('Suite supervisor returned an invalid command result');
        } else {
          completion = message;
          // A result observed before the deadline must not be reclassified
          // while the already-finished command's owned group is cleaned up.
          clearTimeout(timeoutTimer);
          if (completion.spawn_error) supervisorError = Object.assign(new Error(completion.spawn_error.message), {
            ...(completion.spawn_error.code ? { code: completion.spawn_error.code } : {}),
          });
        }
        // This exact ChildProcess owns the IPC channel, and the supervisor
        // deliberately stays live until this kill. The command cannot spoof
        // completion through stdout or inherit the channel to its descendants.
        escalated = true;
        if (child.exitCode === null && child.signalCode === null) killTree(child, 'SIGKILL');
        clearTimeout(failsafeTimer);
        failsafeTimer = setTimeout(() => {
          supervisorError ??= new Error('Suite process-group cleanup did not finish');
          child.stdout?.destroy();
          child.stderr?.destroy();
          child.unref?.();
          settle();
        }, killGraceMs);
      });
      child.once('spawn', () => {
        if (settled || aborted) return;
        const failed = (error) => {
          if (!error || settled) return;
          supervisorError = error;
          if (child.exitCode === null && child.signalCode === null) killTree(child, 'SIGKILL');
        };
        try {
          child.send({ type: 'ape-suite-start', version: 1, command, args: args ?? [], shell: options.shell === true }, failed);
        } catch (error) { failed(error); }
      });
    }
  });
}

// Fixed interop program, compiled in memory by the built-in Windows
// PowerShell. Command data arrives as JSON on private stdin, never as code.
// JOB_LIST places the process in its job atomically at creation; HANDLE_LIST
// prevents the job and control handles from reaching ordinary descendants.
const WINDOWS_JOB_SOURCE = String.raw`
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Threading;
using System.Diagnostics;
public static class ApeOwnedJob {
  [StructLayout(LayoutKind.Sequential)] struct IO { public ulong a,b,c,d,e,f; }
  [StructLayout(LayoutKind.Sequential)] struct BasicLimit {
    public long processTime,jobTime; public uint flags; public UIntPtr minWS,maxWS;
    public uint active; public UIntPtr affinity; public uint priority,scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct Limit {
    public BasicLimit basic; public IO io; public UIntPtr processMemory,jobMemory,peakProcess,peakJob;
  }
  [StructLayout(LayoutKind.Sequential)] struct Accounting {
    public long user,kernel,periodUser,periodKernel; public uint faults,total,active,terminated;
  }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Startup {
    public int cb; public string reserved,desktop,title; public uint x,y,xsize,ysize,xchars,ychars,fill,flags;
    public ushort show,reservedSize; public IntPtr reservedData,input,output,error;
  }
  [StructLayout(LayoutKind.Sequential)] struct StartupEx { public Startup start; public IntPtr attributes; }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr process,thread; public uint pid,tid; }
  [StructLayout(LayoutKind.Sequential)] struct Security { public int length; public IntPtr descriptor; public int inherit; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObjectW(IntPtr security,string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int info,ref Limit value,int size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int info,out Accounting value,int size,IntPtr returned);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,uint flags,ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr attribute,IntPtr value,IntPtr size,IntPtr previous,IntPtr returned);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcessW(string app,StringBuilder command,IntPtr processSecurity,IntPtr threadSecurity,bool inherit,uint flags,IntPtr env,string cwd,ref StartupEx startup,out ProcessInfo info);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int kind);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool DuplicateHandle(IntPtr process,IntPtr source,IntPtr target,out IntPtr copy,uint access,bool inherit,uint options);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateFileW(string name,uint access,uint share,ref Security security,uint creation,uint flags,IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,uint ms);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  static Exception Failure(string operation) { return new Exception(operation + " failed (" + Marshal.GetLastWin32Error() + ")"); }
  static string Quote(string value) {
    if (value.Length>0 && value.IndexOfAny(new char[]{' ','\t','\n','\v','"'})<0) return value;
    var b = new StringBuilder("\""); int slashes=0;
    foreach(char c in value) { if(c=='\\') { slashes++; continue; }
      if(c=='"') { b.Append('\\',slashes*2+1); b.Append(c); }
      else { b.Append('\\',slashes); b.Append(c); } slashes=0;
    }
    b.Append('\\',slashes*2); return b.Append('"').ToString();
  }
  public sealed class Result {
    public object exit_code=null; public bool timed_out=false,aborted=false;
    public string status="unknown",cause="completion proof unavailable",error=null;
  }
  static volatile bool disconnected;
  public static Result Run(string command,string[] args,bool shell,string cwd,int timeout,int cleanupMs) {
    var r=new Result(); IntPtr job=IntPtr.Zero,list=IntPtr.Zero,jobValue=IntPtr.Zero,handles=IntPtr.Zero;
    IntPtr input=IntPtr.Zero,output=IntPtr.Zero,error=IntPtr.Zero; var pi=new ProcessInfo(); bool started=false;
    try {
      job=CreateJobObjectW(IntPtr.Zero,null); if(job==IntPtr.Zero) throw Failure("CreateJobObject");
      var limit=new Limit(); limit.basic.flags=0x2000; // KILL_ON_JOB_CLOSE, no breakaway
      if(!SetInformationJobObject(job,9,ref limit,Marshal.SizeOf(typeof(Limit)))) throw Failure("SetInformationJobObject");
      var security=new Security(); security.length=Marshal.SizeOf(typeof(Security)); security.inherit=1;
      input=CreateFileW("NUL",0x80000000,3,ref security,3,0,IntPtr.Zero);
      if(input==new IntPtr(-1)) throw Failure("open NUL");
      var self=GetCurrentProcess();
      if(!DuplicateHandle(self,GetStdHandle(-11),self,out output,0,true,2) ||
         !DuplicateHandle(self,GetStdHandle(-12),self,out error,0,true,2)) throw Failure("DuplicateHandle");
      IntPtr bytes=IntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero,2,0,ref bytes);
      list=Marshal.AllocHGlobal(bytes);
      if(!InitializeProcThreadAttributeList(list,2,0,ref bytes)) throw Failure("InitializeProcThreadAttributeList");
      jobValue=Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(jobValue,job);
      handles=Marshal.AllocHGlobal(IntPtr.Size*3); Marshal.WriteIntPtr(handles,0,input); Marshal.WriteIntPtr(handles,IntPtr.Size,output); Marshal.WriteIntPtr(handles,IntPtr.Size*2,error);
      if(!UpdateProcThreadAttribute(list,0,new IntPtr(0x2000D),jobValue,new IntPtr(IntPtr.Size),IntPtr.Zero,IntPtr.Zero) ||
         !UpdateProcThreadAttribute(list,0,new IntPtr(0x20002),handles,new IntPtr(IntPtr.Size*3),IntPtr.Zero,IntPtr.Zero)) throw Failure("UpdateProcThreadAttribute");
      var si=new StartupEx(); si.start.cb=Marshal.SizeOf(typeof(StartupEx)); si.start.flags=0x100;
      si.start.input=input; si.start.output=output; si.start.error=error; si.attributes=list;
      string executable=null; string line;
      if(shell) { executable=Environment.GetEnvironmentVariable("ComSpec") ?? "C:\\Windows\\System32\\cmd.exe";
        line=Quote(executable)+" /d /s /c \""+command;
        foreach(string arg in args) line+=" "+arg; line+="\"";
      } else { line=Quote(command); foreach(string arg in args) line+=" "+Quote(arg); }
      // No suspended-create/assign gap: membership exists before any code runs.
      if(!CreateProcessW(executable,new StringBuilder(line),IntPtr.Zero,IntPtr.Zero,true,0x08080000,IntPtr.Zero,cwd,ref si,out pi)) throw Failure("CreateProcessW with job list");
      started=true; CloseHandle(pi.thread); pi.thread=IntPtr.Zero;
      var lifeline=new Thread(()=>{ try { Console.In.ReadLine(); } catch {} disconnected=true; }); lifeline.IsBackground=true; lifeline.Start();
      var clock=Stopwatch.StartNew();
      for(;;) {
        uint wait=WaitForSingleObject(pi.process,20);
        if(wait==0) { uint code; if(!GetExitCodeProcess(pi.process,out code)) throw Failure("GetExitCodeProcess"); r.exit_code=(long)code; break; }
        if(wait==0xFFFFFFFF) throw Failure("WaitForSingleObject");
        if(disconnected) { r.aborted=true; break; }
        if(timeout>=0 && clock.ElapsedMilliseconds>=timeout) { r.timed_out=true; break; }
      }
      // Release process references before accounting: only the broker retains
      // the job handle, and no new admissions are possible after CreateProcess.
      CloseHandle(pi.process); pi.process=IntPtr.Zero;
      if(!TerminateJobObject(job,1)) throw Failure("TerminateJobObject");
      clock.Restart();
      do { Accounting account;
        if(!QueryInformationJobObject(job,1,out account,Marshal.SizeOf(typeof(Accounting)),IntPtr.Zero)) throw Failure("QueryInformationJobObject");
        if(account.active==0) { r.status="confirmed"; r.cause="owned job ActiveProcesses is zero"; break; }
        Thread.Sleep(10);
      } while(clock.ElapsedMilliseconds<cleanupMs);
    } catch(Exception e) { r.error=e.Message; r.cause=e.Message;
      if(!started) { r.status="confirmed"; r.cause="process creation did not succeed"; }
    } finally {
      if(pi.thread!=IntPtr.Zero) CloseHandle(pi.thread); if(pi.process!=IntPtr.Zero) CloseHandle(pi.process);
      if(job!=IntPtr.Zero) CloseHandle(job);
      if(list!=IntPtr.Zero) { DeleteProcThreadAttributeList(list); Marshal.FreeHGlobal(list); }
      if(jobValue!=IntPtr.Zero) Marshal.FreeHGlobal(jobValue); if(handles!=IntPtr.Zero) Marshal.FreeHGlobal(handles);
      if(input!=IntPtr.Zero && input!=new IntPtr(-1)) CloseHandle(input);
      if(output!=IntPtr.Zero) CloseHandle(output); if(error!=IntPtr.Zero) CloseHandle(error);
    }
    return r;
  }
}
`;

function spawnWindowsOwned(command, args, options) {
  return new Promise((resolve) => {
    const secret = randomUUID();
    const pipeName = `ape-owned-${randomUUID()}`;
    const pipe = `\\\\.\\pipe\\${pipeName}`;
    let child, stdout = '', stderr = '', combined = '', settled = false;
    let stdoutTruncated = false, stderrTruncated = false;
    let timer, drainTimer, completion;
    let brokerClosed = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(drainTimer);
      options.signal?.removeEventListener('abort', stop);
      server.close();
      child?.stdin?.end();
      child?.unref();
      resolve({ signal: null, stdout, stderr, combined,
        ...(options.collect === 'separate' ? { stdout_truncated: stdoutTruncated, stderr_truncated: stderrTruncated } : {}), ...result });
    };
    const unknown = (cause) => finish({ exit_code: null, timed_out: false,
      spawn_error: new Error(cause), cleanup: { status: 'unknown', cause } });
    const stop = () => { child?.stdin?.end('stop\n'); };
    // Job retirement and broker handle release are separate boundaries. Keep
    // the authenticated result until close drains stdout/stderr and releases
    // PowerShell's cwd. Neither close nor killing the broker supplies proof.
    const awaitCompletion = () => {
      if (settled) return;
      if (brokerClosed && completion) return finish(completion);
      if (drainTimer) return;
      drainTimer = setTimeout(() => {
        if (!brokerClosed) { stop(); child?.kill(); }
        unknown(brokerClosed
          ? 'Windows ownership broker closed without completion proof'
          : 'Windows ownership broker did not close after completion proof');
      }, options.drain_ms ?? DEFAULT_DRAIN_MS);
    };
    const server = createServer((socket) => {
      let data = '';
      socket.setTimeout(5000, () => socket.destroy());
      socket.on('error', () => {});
      socket.on('data', (chunk) => {
        data += chunk;
        if (data.length > 16384) return socket.destroy();
        if (!data.includes('\n')) return;
        try {
          const message = JSON.parse(data.trim());
          if (message.secret !== secret || !['confirmed', 'unknown'].includes(message.result?.status)) return socket.destroy();
          const r = message.result;
          socket.end();
          if (completion || settled) return;
          completion = { exit_code: r.exit_code, timed_out: r.timed_out === true,
            ...(r.aborted ? { aborted: true } : {}), spawn_error: r.error ? new Error(r.error) : null,
            cleanup: { status: r.status, cause: r.cause } };
          awaitCompletion();
        } catch { socket.destroy(); }
      });
    });
    server.once('error', (e) => unknown(`Windows proof channel failed: ${e.message}`));
    server.listen(pipe, () => {
      if (options.signal?.aborted) {
        finish({ exit_code: null, timed_out: false, aborted: true, spawn_error: null,
          cleanup: { status: 'confirmed', cause: 'cancelled before process creation' } });
        return;
      }
      const script = `$ProgressPreference='SilentlyContinue'\n$ErrorActionPreference='Stop'\nAdd-Type -TypeDefinition @'\n${WINDOWS_JOB_SOURCE}\n'@\n` +
        `$c=ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadLine())))\n` +
        `$r=[ApeOwnedJob]::Run([string]$c.command,[string[]]$c.args,[bool]$c.shell,[string]$c.cwd,[int]$c.timeout,[int]$c.cleanup)\n` +
        `$p=New-Object System.IO.Pipes.NamedPipeClientStream('.', [string]$c.pipe, [System.IO.Pipes.PipeDirection]::Out)\n` +
        `$p.Connect(5000)\n$w=New-Object System.IO.StreamWriter($p)\n` +
        `$w.WriteLine((ConvertTo-Json -Compress -Depth 5 @{secret=$c.secret;result=$r}))\n$w.Flush()\n$w.Dispose()\n$p.Dispose()\n`;
      const executable = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      try {
        child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
          cwd: options.cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
          ...(options.env ? { env: { ...process.env, ...options.env } } : {}),
        });
      } catch (e) { unknown(`Windows ownership broker could not start: ${e.message}`); return; }
      const collect = (chunk, kind) => {
        if (options.collect === 'separate') {
          const length = kind === 'out' ? stdout.length : stderr.length;
          const part = options.max_output === undefined ? chunk : chunk.slice(0, Math.max(0, options.max_output - length));
          if (kind === 'out') { stdoutTruncated ||= part.length < chunk.length; stdout += part; }
          else { stderrTruncated ||= part.length < chunk.length; stderr += part; }
        }
        else if (options.max_output === undefined || combined.length < options.max_output) combined += chunk;
      };
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      child.stdout.on('data', (s) => collect(s, 'out')); child.stderr.on('data', (s) => collect(s, 'err'));
      child.stdin.on('error', () => {});
      child.once('error', (e) => unknown(`Windows ownership broker failed: ${e.message}`));
      child.once('close', () => { brokerClosed = true; awaitCompletion(); });
      options.signal?.addEventListener('abort', stop, { once: true });
      const timeout = Number.isFinite(options.timeout_ms) ? Math.max(0, Math.min(2147483647, options.timeout_ms)) : -1;
      const cleanup = Math.max(1000, options.kill_grace_ms ?? DEFAULT_KILL_GRACE_MS);
      // ASCII transport avoids Windows PowerShell's host code page changing
      // Unicode command arguments or working directories before CreateProcessW.
      child.stdin.write(Buffer.from(JSON.stringify({ command, args, shell: options.shell === true, cwd: options.cwd ?? process.cwd(),
        timeout, cleanup, pipe: pipeName, secret }), 'utf8').toString('base64') + '\n');
      if (timeout >= 0) timer = setTimeout(() => { stop(); unknown('Windows ownership proof deadline expired'); }, Math.min(2147483647, timeout + cleanup + 30000));
    });
  });
}

// Source and bundled runtime callers launch this unbundled module. A matching main
// module, the private sentinel and an IPC endpoint are required; ordinary
// imports do not start a supervisor.
if (process.argv[2] === SUITE_SUPERVISOR_SENTINEL && process.send) {
  try {
    if (realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) runSuiteSupervisor();
  } catch { /* not the unbundled supervisor entry */ }
}

// Spawn a fire-and-forget detached child that OUTLIVES the parent MCP call: the
// gate-suite runner keeps executing after `ape_run` returns, and a later poll
// reads its artifact. detached:true makes it a new session/process-group leader
// on POSIX (so it survives the parent exiting AND an ABORT can signal its whole
// group by -pid); stdio:'ignore' means no inherited pipe keeps either process
// alive; unref() lets the parent event loop exit without waiting on it. On win32
// the recorded pid is walked by `taskkill /T` for the same tree kill. env, when
// provided, is merged over process.env exactly like spawnWithTimeout. Returns the
// child handle so the caller can record child.pid for the respawn fence and the
// abort kill; a spawn fault surfaces asynchronously on the ignored child and is
// tolerated (the poll's respawn fence recovers a runner that never started).
export function spawnDetached(command, args, options = {}) {
  const child = spawn(command, args ?? [], {
    cwd: options.cwd,
    detached: true,
    stdio: options.ipc ? ['ignore', 'ignore', 'ignore', 'ipc'] : 'ignore',
    windowsHide: true,
    ...(options.env ? { env: { ...process.env, ...options.env } } : {}),
  });
  retainDetachedChild(child);
  child.unref();
  return child;
}

// `unref()` removes the detached runner from the event-loop liveness decision,
// but it must not also make its ChildProcess handle collectible while this MCP
// process is still alive. On Linux containers in particular, dropping that
// handle can leave a killed runner visible as an unreaped zombie until pid 1
// eventually collects it. A cancellation could then publish `cancelled` while
// `kill(pid, 0)` still reported the exact attributed runner as present.
//
// Retain only runners spawned by this module, keyed by their exact pid, and
// release each handle as soon as Node observes its exit. This registry is NOT
// kill authorization: the persisted heartbeat/host/age checks below remain the
// sole authority to signal. It only lets an already-authorized kill wait for
// the launcher's own waitpid/exit observation before returning.
const detachedChildren = new Map();

function retainDetachedChild(child) {
  if (!Number.isInteger(child?.pid) || child.pid <= 1) {
    // Failed asynchronous spawns have no pid, but still emit error on the
    // returned ChildProcess. They must never crash the hosting MCP process.
    child.once('error', () => {});
    return;
  }
  const pid = child.pid;
  let settle;
  const exited = new Promise((resolve) => { settle = resolve; });
  const record = { child, exited };
  detachedChildren.set(pid, record);
  const release = () => {
    if (detachedChildren.get(pid) === record) detachedChildren.delete(pid);
    settle();
  };
  child.once('exit', release);
  // A spawn error has no process left for this handle to reap. Listening also
  // keeps the fire-and-forget helper's asynchronous error path non-fatal.
  child.once('error', release);
}

// A heartbeat older than this no longer attests that the recorded pid is still
// OUR gate runner. DELIBERATE DUPLICATE of GATE_RUNNER_STALE_MS in
// ./constants.js, kept as a CONVENTION and NOT as a technical necessity —
// importing it would not in fact break the unbundled runner, because gates.js
// resolveRunnerEntry always spawns the SOURCE lib/runtime/runner.js and
// constants.js is an import-free leaf that is always a resolvable sibling of the
// entry that actually runs. What the duplication buys is the posture runner.js
// states for itself: its runtime-module imports are pinned to ./spawn.js alone,
// so keeping spawn.js to node BUILTINS ONLY (the one non-builtin-free addition
// here is node:fs/promises) holds the detached runner's whole dependency surface
// to one file that can be audited by inspection.
// __tests__/runtime-v2-kill-process-tree-stale-pid.test.js arm A7 pins the two
// values equal, so the duplicate cannot drift silently.
export const KILL_IDENTITY_STALE_MS = 30_000;

// How much longer than its own armed deadline a runner could still plausibly be
// alive. spawnWithTimeout's bounded shutdown is 2 * DEFAULT_KILL_GRACE_MS +
// DEFAULT_DRAIN_MS = 25s; the rest is margin for the artifact write and host
// scheduling.
const RUNNER_LIFETIME_SLACK_MS = 60_000;

// The escalation's poll delay. Deliberately NOT unref'd — that is the exact
// reversal of the unref'd `setTimeout(() => signalGroup('SIGKILL'), ...)` this
// replaced, which was wrong in both directions at once: a short-lived process
// that returned before the grace elapsed DROPPED the force-kill entirely (a
// SIGTERM-ignoring suite then survived the abort), and when it did fire it fired
// blind at a group that may have emptied and been recycled meanwhile. The caller
// awaits this sleep, so the escalation is owed AND delivered inside the call,
// and no timer can outlive it.
function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

// Wait only for a runner this exact module instance launched. The bound keeps
// abort/cancellation from parking forever on an uninterruptible kernel task;
// ordinary SIGTERM/SIGKILL exits resolve through ChildProcess's waitpid-backed
// `exit` event and clear the timer immediately.
async function awaitOwnedDetachedExit(pid, maxWaitMs = DEFAULT_DRAIN_MS) {
  const record = detachedChildren.get(pid);
  if (!record) return;
  const waitMs = Math.max(1, Number.isFinite(maxWaitMs) ? maxWaitMs : DEFAULT_DRAIN_MS);
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, waitMs);
    record.exited.then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

// Liveness probes. process.kill(target, 0) delivers NOTHING; it only asks the
// kernel whether the target exists and is signalable by us. Any error answers
// "do not signal": ESRCH means gone, and EPERM means the number exists but is
// not ours.
//
// THE EPERM POLARITY IS DELIBERATELY OPPOSITE to gates.js's processExists()
// (gates.js:24-32, which returns `error?.code === 'EPERM'`), and both are right
// for their own question. There EPERM means "alive, so VETO the respawn"; here
// it means "not ours, so VETO the kill". Same principle — fail toward NOT
// acting — opposite conclusion, because there the dangerous act is launching a
// second runner and here it is signalling a stranger's process.
function groupExists(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

function pidExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// The runner's own attestation, read back. runner.js writes
// JSON.stringify({ pid: process.pid, beat_at: Date.now() }) at startup and every
// heartbeat_ms, and rm's the file when it finishes — so this is an IDENTITY
// witness, not a mere touch file. Missing or unparseable => no witness.
//
// A missing witness provides no authority to signal a numeric process group.
// Current POSIX gate suites have their own supervisor cleanup; historical or
// other runner-group members may still exist. Atomic heartbeat replacement
// prevents torn reads. The remaining limits are recorded below.
async function readRunnerWitness(file) {
  try {
    // Cancellation runs inside the receipt-effects lock. A damaged witness
    // must neither wait for a FIFO writer nor allocate an unbounded read.
    const beat = JSON.parse(await readBoundedRegularFileUtf8(file, { maxBytes: 4096 }));
    return beat && typeof beat === 'object' ? beat : null;
  } catch {
    return null;
  }
}

// Could this watch's runner still plausibly be alive AT ALL? It is bounded by
// its own armed deadline (runner.js falls back to 30 minutes for a non-finite
// job timeout_ms — mirrored here) plus its bounded shutdown. An unparseable
// created_at FAILS CLOSED: no age evidence, no kill. This fence gates only the
// STALE branch; a fresh witness is self-bounding through beat_at.
//
// ANCHORED TO THE ORIGINAL created_at ACROSS AN A2 RESPAWN — A RECORDED
// DISAGREEMENT BETWEEN THE CODE AND SECURITY REVIEWS, LEFT AS-IS. The code
// review observed that gates.js re-passes `created_at: watch.created_at` on a
// respawn and re-arms only { pid, host, spawn_attempts } (gates.js:1496, :1501),
// so a SECOND runner launched at T1 is fenced from T0, and proposed measuring
// the age from Math.max(Date.parse(watch.created_at), beat.beat_at). The
// SECURITY review forbade exactly that construction: beat_at is FILE-supplied,
// and using it to WIDEN the authorization to signal re-introduces a
// file-controlled widener. Both cannot be honoured, so the fence is UNCHANGED
// and the residual is recorded instead: for a RESPAWNED runner this may veto a
// kill up to one armed deadline early. Bounded by GATE_RUNNER_MAX_SPAWNS = 2 (at
// most one respawn), and it can only ever cost a FALSE NEGATIVE — never a stray
// signal. Resolving it properly needs a runtime-recorded spawned_at on the watch
// (a gates.js change, outside the claims of the run that landed this).
function withinArmedLifetime(watch) {
  const started = Date.parse(watch.created_at);
  if (!Number.isFinite(started)) return false;
  const timeoutMs = Number.isFinite(watch.timeout_ms) ? watch.timeout_ms : 30 * 60_000;
  const age = Date.now() - started;
  // NON-NEGATIVE CLAMP: unclamped, `age <= bound` reads every FUTURE created_at
  // as inside the lifetime, so a timestamp that is not evidence of youth would
  // widen the authorization to signal. Fail closed.
  return age >= 0 && age <= timeoutMs + RUNNER_LIFETIME_SLACK_MS;
}

// Best-effort signaling of the verified detached runner group. Current POSIX
// suites stop through runner cancellation forwarding or their supervisor's IPC
// disconnect handler. Windows taskkill walks the live runner's process tree.
// This caller holds a persisted watch rather than the original child handle.
//
// THE HAZARD THIS GUARDS. watch.pid is read off durable run state, and a run can
// rest in 'gating' for an arbitrary wall-clock interval, so the number may name a
// process that exited long ago and one the OS has since RECYCLED. The
// pgid-reservation argument that makes spawnWithTimeout's escalation safe (a pid
// NUMBER stays allocated while it is in use as an active process-group id, so
// kill(-pid) can only mis-target once the group is already EMPTY) does NOT
// transfer here: "already empty" is the expected steady state for an old watch,
// not the harmless corner it is for a live child handle.
//
// AUTHORIZATION, IN ORDER: same host (EXACT match, mirroring the A2 respawn fence
// at gates.js:1471); an integer pid above 1; the runner's own heartbeat file
// parses AND names THIS pid — the identity witness, where beat.pid is never
// trusted alone or a parseable file could redirect a SIGKILL; then either that
// witness is FRESH, or the watch is still inside its armed lifetime. That last
// branch is deliberate: a stalled runner or legacy group members may still
// be active, and skipping there would trade the
// stray-signal hazard for a false NEGATIVE against the A6 contract (invariant 4).
// Only then is the group probed and signalled. Nothing is EVER signalled through
// the bare positive pid: the old catch-fallback fired precisely on the strongest
// available evidence that the number had been recycled, so the only thing a
// positive pid reaches now is the probe (signal 0), which delivers nothing.
//
// TOCTOU, STATED RATHER THAN PAPERED OVER. The window is opened by the awaited
// heartbeat read, which yields the event loop, so the witness is already at least
// one turn stale before any signal lands. The probe and the SIGTERM below are ONE
// synchronous turn, and the escalation re-probes immediately before the SIGKILL,
// which NARROWS the window ahead of the most destructive signal without closing
// it. Closing it needs a live handle — exactly what an aborting process does not
// have.
//
// ===========================================================================
// Remaining limits and historical cases for the persisted-watch guard.
//
//  (a) ABSENT WITNESS AFTER NORMAL COMPLETION — CLOSED for supervised POSIX
//      gate suites. Their retained supervisor leads the suite group until the
//      command exits; ordinary descendants are killed before the runner writes
//      its result artifact. Runner death instead closes the supervisor's IPC
//      lifeline and triggers the same cleanup. The missing-witness veto stays:
//      a bare pgid may belong to an unrelated, recycled group. Windows, legacy
//      or unsupervised jobs, and deliberately detached descendants are outside
//      this supervised POSIX guarantee.
//
//  (b) TORN HEARTBEAT READ AGAINST A FULLY LIVE RUNNER — CLOSED, and kept here
//      because closing it bought a smaller cost that is now the live residual.
//      IT USED TO READ: runner.js wrote the heartbeat with a plain NON-ATOMIC
//      writeFile (open-truncate-then-write), unlike the atomicWriteFile600
//      temp+rename it used for the artifact in the same file, so a read landing
//      inside a beat saw a truncated file, JSON.parse threw, readRunnerWitness
//      returned null, and the kill was vetoed against a runner that was alive,
//      healthy and heartbeating. That was OBSERVED rather than postulated: the
//      heartbeat observer in __tests__/runtime-v2-runner.test.js counted 1
//      unparseable read against 34 parsed ones while sampling a real gate runner
//      on the pre-swap tree, and it still counts both (its `reads:` diagnostic),
//      so the claim stays checkable. runner.js now routes every beat through
//      atomicWriteFile600, so the reader above sees whole beats only.
//      WHAT THE SWAP TRADED, IN ITS OWN UNITS — not "the same race, rarer". A
//      beat can now fail to LAND where it used to fail half-written. runner.js's
//      helper deliberately does not import storage.js (that import limit is what
//      lets the parent spawn the runner unbundled), so its rename carries NONE
//      of replaceFile's bounded EPERM/EACCES/EBUSY retry — the transient
//      antivirus/indexer locks docs/configuration.md documents atomic state
//      replacement surviving. Failed beats do not tear the witness; they AGE it,
//      and an aged witness is a veto here just the same. The margin on shipped
//      defaults is SIX consecutive dropped beats from failed renames ALONE
//      (GATE_RUNNER_HEARTBEAT_MS 5s against GATE_RUNNER_STALE_MS 30s,
//      constants.js), but both are operator knobs — config.gates.heartbeat_ms
//      and gates.stale_ms — and raising the beat toward stale shrinks that
//      margin to one. THAT MARGIN NOW HAS A SECOND SOURCE, RECORD DRIFT
//      OTHERWISE: runGateJob (runner.js) serializes its beat writes by
//      SKIPPING a tick while the previous write is still in flight, so a write
//      slow enough to still be running at the next heartbeat_ms tick costs a
//      beat the same as a failed rename does — the six-consecutive-drops
//      figure above is a floor against renames alone, not the whole margin.
//      The platform where those rename locks actually occur is also the one
//      with the least slack: win32 takes the FRESH-WITNESS-ONLY branch below
//      (`if (!fresh) return;`) and has no orphan arm, so an aged witness there
//      leaves NO second authorization path, while POSIX still falls through to
//      the armed-lifetime fence. NOT AN ESCALATION IN EITHER DIRECTION:
//      killProcessTree signals as the same uid that writes these files, so the
//      0600 half closed an exposure, not a privilege boundary. THE
//      ORPHANED-TEMP RESIDUAL THE SWAP WIDENED IS NOW BOUNDED, NOT LIVE: a
//      bounded sweep closes the ordinary producer's residue at every
//      gate-runner launch. The full record — what closed, what remains, and
//      why — is recorded once, at atomicWriteFile600 in runner.js, and
//      deliberately not restated here so the two records cannot drift.
//
//  (c) PAST-LIFETIME + STALE. A stale witness whose watch is older than
//      created_at + timeout_ms + RUNNER_LIFETIME_SLACK_MS is vetoed by the age
//      fence below. Argued there; see also the recorded respawn-anchoring
//      disagreement on withinArmedLifetime.
//
//  (d) WIN32 + STALE. The win32 branch has no orphan arm at all: taskkill /T
//      walks a LIVE parent-pid chain that a dead runner has already broken, so
//      the kill would be both useless against the orphaned tree and dangerous
//      against whatever now holds the number. Argued at the branch below.
//
//  (e) BEAT.PID DISAGREEMENT. A heartbeat that parses but names a different pid
//      vetoes. This one is the guard working as designed rather than a debt: it
//      is exactly the case where the persisted pid is provably NOT the process
//      that is attesting.
//
//  (f) PRE-FIRST-BEAT. A runner spawned but not yet through its first beat has
//      written no heartbeat, so an abort in that window skips. Bounded by the
//      spawn-to-first-write interval, and the suite grandchild has not been
//      spawned yet at that point, so there is nothing to leak.
// ===========================================================================
//
// ABORT LATENCY IS NOW BOUNDED-BUT-NONZERO, RECORDED AS A COST. The awaited
// escalation can hold the receipt-effects critical section for up to
// kill_grace_ms (10s on the shipped default) where the old unref'd timer
// returned instantly — and routinely DROPPED the kill outright. The same lock
// already tolerates a 5-minute inline gate grace (GATE_INLINE_GRACE_MS), so 10s
// is comfortably inside its budget.
//
// RESIDUAL MUTANTS THIS CHANGE DOES NOT ARM — NAMED, NOT OMITTED (invariant 8).
// __tests__/runtime-v2-kill-process-tree-stale-pid.test.js arms every
// authorization check, the escalation and the never-throws contract below. Three
// mutations of the service.js WIRING survive it, by construction rather than by
// oversight, and a reviewer mutating this diff should expect them:
//   1. Deleting the SECOND call site outright (the OVERRIDE-abort mirror in
//      overrideRun). The only honest arm is a real-process e2e that drives
//      overrideRun('abort') from gating and observes a real suite grandchild
//      die, in a file that run did not claim. The FIRST call site's ORDERING
//      (this call BEFORE cleanupGateSuite) is NOT a residual — it is already
//      armed by a real-process test, __tests__/runtime-v2-gating-watch.test.js's
//      "abort from gating kills the recorded runner and seals aborted without
//      invoking gh (f, A6)": cleanupGateSuite rm's the heartbeat file, so
//      reordering deletes the witness, every guard below vetoes, and the real
//      suite pid survives the abort.
//   2. Dropping `{ stale_ms: config.gates?.stale_ms }` at either call site. Its
//      whole BEHAVIORAL content is armed at this unit boundary by arm A16, which
//      pins that an operator-supplied stale_ms and the built-in default reach
//      OPPOSITE verdicts on the identical watch; what survives is only the
//      wiring of config to the parameter.
//   3. Dropping the `await` at either abort/override call site remains outside
//      this unit boundary. The task-cancellation call is now armed separately:
//      runtime-v2-mcp-tasks-cancellation asserts that its locally spawned
//      runner has been reaped when cancellation becomes terminal. Retaining
//      that exact child handle makes awaited and un-awaited cleanup observably
//      different there; the old unreaped-zombie rationale no longer applies.
// Every line below is load-bearing AND witnessed; those three are the only known
// survivors, and they are debts against the CALL SITES, not against this guard.
//
// Never throws and never rejects: both call sites await this INSIDE the
// receipt-effects critical section, where a rejection would break the abort
// itself and the run would never seal.
// Options: stale_ms, kill_grace_ms, platform (injected by tests; defaults to
// process.platform).
//
// stale_ms IS WIRED FROM CONFIG, not left on the default. Both service.js call
// sites pass `{ stale_ms: config.gates?.stale_ms }` from the `config` already
// loaded in their own critical section, so the operator knob gates.stale_ms means
// the same thing here as it does at the A2 respawn fence in gates.js, which reads
// `config.gates?.stale_ms ?? GATE_RUNNER_STALE_MS`. The consequence of NOT wiring
// it is concrete and win32-specific: an operator who raised gates.stale_ms would
// make every win32 abort veto its taskkill (the fresh-witness-only branch below)
// against a runner the runtime's own poll path still considered alive. An absent
// or non-finite value falls back to KILL_IDENTITY_STALE_MS through the
// Number.isFinite guard, so an unconfigured project is byte-for-byte unchanged.
export async function killProcessTree(watch, options = {}) {
  try {
    if (!watch || typeof watch !== 'object') return;
    if (watch.ownership_file || watch.generation) {
      const unknown = { status: 'unknown', cause: 'gate broker retirement could not be confirmed' };
      if (watch.host !== localExecutionIdentity() || !watch.ownership_file || !watch.generation) return unknown;
      const record = await readGateOwnership(watch.ownership_file);
      if (record.host !== watch.host || record.generation !== watch.generation || record.watch.nonce !== watch.nonce ||
          record.watch.ownership_file !== watch.ownership_file || record.watch.job_file !== watch.job_file) return unknown;
      const existing = await readGateProof(record);
      if (existing?.cleanup?.status === 'confirmed') return existing.cleanup;
      if (!await queryGateBroker(record, 'stop')) return unknown;
      const deadline = Date.now() + (options.kill_grace_ms ?? DEFAULT_KILL_GRACE_MS) + DEFAULT_DRAIN_MS;
      do {
        const proof = await readGateProof(record);
        if (proof?.cleanup?.status === 'confirmed') {
          await awaitOwnedDetachedExit(watch.pid);
          return proof.cleanup;
        }
        await sleep(20);
      } while (Date.now() < deadline);
      return unknown;
    }
    // Exact host match, mirroring the A2 respawn fence's `watch.host ===
    // localExecutionIdentity()`. The old `typeof host === 'string' && host && host !==
    // localExecutionIdentity()` form skipped only a non-empty MISMATCH, so a watch carrying
    // no host at all was signalled on whatever machine happened to read it.
    if (watch.host !== localExecutionIdentity()) return;
    const pid = watch.pid;
    // `pid <= 1`, NOT `pid <= 0`. POSIX kill(-1, sig) is a BROADCAST to every
    // process the caller may signal, so a watch that somehow persisted pid 1
    // would turn an abort into a machine-wide SIGTERM and then SIGKILL. No gate
    // runner is ever pid 1 (init/launchd owns that number), so excluding it
    // forfeits nothing real.
    if (!Number.isInteger(pid) || pid <= 1) return;
    const staleMs = Number.isFinite(options.stale_ms) ? options.stale_ms : KILL_IDENTITY_STALE_MS;
    // POSITIVE FLOOR on the grace. A finite kill_grace_ms <= 0 defeats the
    // default and makes `deadline <= Date.now()`, so the poll loop below never
    // executes its body at all and the SIGKILL fires with NO re-probe — the
    // blind escalation this function exists to replace. The floor makes
    // `deadline > Date.now()` hold, so the loop runs. STATED EXACTLY, not
    // over-claimed: the floor does not make a re-probe unconditional for every
    // input. `deadline` and the loop's first `left` read Date.now() in adjacent
    // statements, so a 1ms tick landing between them still skips the body. That
    // residual is materially different from the defect: at graceMs=1 the SIGKILL
    // follows a SIGTERM issued microseconds earlier, itself immediately preceded
    // by the groupExists probe, so nothing fires across a stale gap. Only a test
    // can inject a non-positive grace — service.js passes none — so the shipped
    // path always takes the default.
    const graceMs = Math.max(
      1,
      Number.isFinite(options.kill_grace_ms) ? options.kill_grace_ms : DEFAULT_KILL_GRACE_MS,
    );
    const platform = options.platform ?? process.platform;

    const beat = await readRunnerWitness(watch.heartbeat_file);
    if (!beat || beat.pid !== pid) return;
    // The beat age is clamped NON-NEGATIVE. beat_at is FILE-supplied, and an
    // unclamped `Date.now() - beat_at <= staleMs` reads any FUTURE timestamp as
    // maximally fresh — a file-controlled widener of the authorization to
    // signal. A beat stamped in the future is not evidence of liveness, so it
    // reads as NOT fresh: on POSIX the age fence below then decides, and on
    // win32 it vetoes. Fail-closed either way.
    //
    // ALL THREE CONJUNCTS BELOW ARE LOAD-BEARING, and `beatAge !== null` is the
    // least obvious of them: with the "there is no age at all" sentinel folded
    // away, ToNumber(null) is +0, so `null >= 0` and `null <= staleMs` are BOTH
    // true and a TIMESTAMPLESS heartbeat would read as MAXIMALLY fresh — the
    // most permissive verdict, from the least evidence.
    const beatAge = Number.isFinite(beat.beat_at) ? Date.now() - beat.beat_at : null;
    const fresh = beatAge !== null && beatAge >= 0 && beatAge <= staleMs;

    if (platform === 'win32') {
      // FRESH WITNESS ONLY — no orphan branch here. Windows recycles pids
      // aggressively and `taskkill /T` walks a LIVE parent-pid chain, which is
      // already broken the moment the runner died: a kill keyed on a dead
      // runner's pid is both useless against the orphaned tree and dangerous
      // against whatever now holds the number. Knowing false negative (ledger
      // (d)), bounded by the fact that taskkill could not have reached that tree
      // anyway.
      if (!fresh) return;
      // A PROBE, not a signal: process.kill(pid, 0) delivers nothing.
      if (!pidExists(pid)) return;
      try {
        const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        });
        killer.on('error', () => {});
        killer.unref?.();
      } catch { /* nothing more we can do */ }
      await awaitOwnedDetachedExit(pid);
      return;
    }

    // AGE FENCE (POSIX only): a stale witness authorizes signaling only within
    // the watch's armed lifetime. This may skip a stalled runner or legacy
    // group members, including the respawn case recorded above. A fresh
    // heartbeat remains direct evidence even after the original deadline.
    if (!fresh && !withinArmedLifetime(watch)) return;
    // The probe and the signal are one synchronous turn: no await may separate
    // them, or the window this narrows re-opens between them.
    if (!groupExists(pid)) {
      await awaitOwnedDetachedExit(pid);
      return;
    }
    try {
      process.kill(-pid, 'SIGTERM');
    } catch { /* the group emptied between the probe and here; NO bare-pid fallback */ }

    // Bounded, AWAITED, group-observing escalation. Poll instead of firing
    // blind: the moment the group is gone we stop, so a group that died of the
    // polite signal is never SIGKILLed, and the caller cannot return with a
    // force-kill still owed to it.
    const pollMs = Math.max(10, Math.min(100, Math.floor(graceMs / 4)));
    const deadline = Date.now() + graceMs;
    for (let left = deadline - Date.now(); left > 0; left = deadline - Date.now()) {
      await sleep(Math.min(pollMs, left));
      // The final iteration's probe IS the re-probe: nothing but synchronous
      // loop bookkeeping separates it from the SIGKILL below.
      if (!groupExists(pid)) {
        await awaitOwnedDetachedExit(pid);
        return;
      }
    }
    try {
      process.kill(-pid, 'SIGKILL');
    } catch { /* the group emptied in the last microseconds; NO bare-pid fallback */ }
    await awaitOwnedDetachedExit(pid);
  } catch { /* best-effort: an abort must never fail because a kill did */ }
}
