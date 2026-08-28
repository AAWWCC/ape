import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createToolCallQueue } from '../bin/ape-mcp.mjs';
import { runtimePaths } from '../lib/runtime/paths.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// test-support/temp-fixtures.js is imported dynamically, inside the two
// tests that use it, rather than statically at the top of the file: a
// static import that cannot resolve fails the WHOLE file at collection,
// which would also (transiently, until the module lands) take down the
// unrelated createToolCallQueue tests below that never touch it.
const loadFixtures = () => import('../test-support/temp-fixtures.js');

// Incremental stdio session: unlike the batch helper in runtime-v2-mcp.test.js
// this one keeps stdin open, exposes responses as they arrive, and lets the
// test act (release a lock) between frames — the whole point under test is
// WHICH responses arrive while a tool call is still running.
function openSession() {
  const env = { ...process.env };
  delete env.CLAUDE_PROJECT_DIR;
  delete env.CODEX_CWD;
  const child = spawn(process.execPath, [path.join(root, 'bin', 'ape-mcp.mjs')], {
    cwd: root,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const responses = [];
  let buffered = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdout.on('data', (chunk) => {
    buffered += chunk;
    let index = buffered.indexOf('\n');
    while (index >= 0) {
      const line = buffered.slice(0, index).trim();
      buffered = buffered.slice(index + 1);
      if (line) responses.push(JSON.parse(line));
      index = buffered.indexOf('\n');
    }
  });
  const closed = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(responses) : reject(new Error(stderr))));
  });
  return {
    child,
    responses,
    closed,
    send: (message) => child.stdin.write(`${JSON.stringify(message)}\n`),
    end: () => child.stdin.end(),
    async waitFor(predicate, timeoutMs = 10_000) {
      const startedAt = Date.now();
      while (!predicate(responses)) {
        if (Date.now() - startedAt > timeoutMs) {
          throw new Error(`timed out waiting; saw: ${JSON.stringify(responses)}\n${stderr}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      return responses;
    },
  };
}

// Pre-hold the receipt-effects lock exactly the way withDirLock creates it:
// a lock DIRECTORY with an owner token file and a fresh mtime, so the
// server's writer spins (not steals) until the test releases it.
function holdReceiptLock(projectDir) {
  const lock = runtimePaths(projectDir).receiptLock;
  mkdirSync(lock, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(lock, 'owner'), 'external-test-holder', { mode: 0o600 });
  // Full-suite load can suspend this worker beyond the runtime's 10-second
  // stale window. Model a genuinely live external holder by maintaining the
  // same directory-mtime heartbeat as withDirLock; otherwise the child may
  // lawfully steal the fixture and race this teardown into ENOTEMPTY.
  const heartbeat = setInterval(() => {
    const timestamp = new Date();
    try {
      utimesSync(lock, timestamp, timestamp);
    } catch {
      // The explicit release may have removed the fixture between ticks.
    }
  }, 250);
  heartbeat.unref?.();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    clearInterval(heartbeat);
    rmSync(lock, { recursive: true, force: true });
  };
}

const callRecord = (id, projectDir) => ({
  jsonrpc: '2.0',
  id,
  method: 'tools/call',
  params: { name: 'ape_run', arguments: { action: 'record', receipt: {}, project_dir: projectDir } },
});
const callStatus = (id, projectDir) => ({
  jsonrpc: '2.0',
  id,
  method: 'tools/call',
  params: { name: 'ape_run', arguments: { action: 'status', project_dir: projectDir } },
});

describe('APE v2 MCP protocol/tool-call interleaving', () => {
  it('answers ping and tools/list while a record blocks, then settles tool calls in FIFO order', async () => {
    const { killAndWait, removeTreeWithRetry } = await loadFixtures();
    const scratch = await mkdtemp(path.join(os.tmpdir(), 'ape-mcp-interleave-'));
    const release = holdReceiptLock(scratch);
    const session = openSession();
    try {
      session.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
      session.send(callRecord(2, scratch));
      session.send({ jsonrpc: '2.0', id: 3, method: 'ping' });
      session.send({ jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} });
      session.send(callStatus(5, scratch));

      // The protocol plane must answer while the record still holds the loop's
      // former position: 1, 3, 4 arrive with BOTH tool calls unresolved.
      await session.waitFor((r) => [1, 3, 4].every((id) => r.some((entry) => entry.id === id)));
      expect(session.responses.some((entry) => entry.id === 2)).toBe(false);
      // status takes no receipt lock, so its silence here is the FIFO queue —
      // not a shared resource — holding it behind the record.
      expect(session.responses.some((entry) => entry.id === 5)).toBe(false);
      expect(session.responses.find((entry) => entry.id === 3).result).toEqual({});

      release();
      await session.waitFor((r) => r.some((entry) => entry.id === 5));
      const ids = session.responses.map((entry) => entry.id);
      // Strict FIFO among tool calls: the record settles (and writes) before
      // the status ever executes.
      expect(ids.indexOf(2)).toBeLessThan(ids.indexOf(5));
      const record = session.responses.find((entry) => entry.id === 2);
      expect(record.result.isError).toBe(true);
      expect(record.result.content[0].text).toMatch(/no active run/);
      const status = session.responses.find((entry) => entry.id === 5);
      expect(JSON.parse(status.result.content[0].text)).toMatchObject({ ok: true, active: false });

      session.end();
      await session.closed;
    } finally {
      // Kill the child and AWAIT its exit FIRST, then release the lock
      // directory, then remove the scratch tree — never the reverse. The
      // server's writer spins on withDirLock (re-mkdir-ing the lock
      // directory in a retry loop) until the child is actually dead; a
      // release() or rmSync() that runs while the child can still recreate
      // an entry inside the tree races the tree removal into ENOTEMPTY.
      await killAndWait(session.child, 'SIGKILL');
      release();
      await removeTreeWithRetry(scratch);
    }
  }, 20_000);

  it('drains in-flight tool calls after stdin EOF instead of dropping their responses', async () => {
    const { killAndWait, removeTreeWithRetry } = await loadFixtures();
    const scratch = await mkdtemp(path.join(os.tmpdir(), 'ape-mcp-drain-'));
    const release = holdReceiptLock(scratch);
    const session = openSession();
    try {
      session.send({ jsonrpc: '2.0', id: 1, method: 'ping' });
      session.send(callRecord(2, scratch));
      // EOF while the record is still blocked on the lock: the read loop ends
      // but the server must stay alive until the queued call settles and its
      // response is written (truthful completion at EOF).
      session.end();
      await session.waitFor((r) => r.some((entry) => entry.id === 1));
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(session.responses.some((entry) => entry.id === 2)).toBe(false);
      release();
      const responses = await session.closed;
      const record = responses.find((entry) => entry.id === 2);
      expect(record.result.isError).toBe(true);
      expect(record.result.content[0].text).toMatch(/no active run/);
    } finally {
      // Same ordering fix as above: await the real exit before releasing
      // the lock or removing the scratch tree.
      await killAndWait(session.child, 'SIGKILL');
      release();
      await removeTreeWithRetry(scratch);
    }
  }, 20_000);
});

describe('createToolCallQueue', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts a queued call\'s progress heartbeat at enqueue, not at dequeue', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    const lines = [];
    const executed = [];
    let releaseFirst;
    const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
    const queue = createToolCallQueue({
      execute: async (message) => {
        executed.push(message.id);
        if (message.id === 1) await firstGate;
        return { jsonrpc: '2.0', id: message.id, result: { ok: true } };
      },
      writeLine: (payload) => lines.push(payload),
    });
    queue.enqueue({ id: 1, method: 'tools/call', params: { name: 'ape_run', arguments: { action: 'record' } } });
    queue.enqueue({
      id: 2,
      method: 'tools/call',
      params: { name: 'ape_run', arguments: { action: 'status' }, _meta: { progressToken: 'tok-q' } },
    });

    await vi.advanceTimersByTimeAsync(25_000);
    // The first call is mid-flight and the second has NOT executed — yet the
    // second already emits liveness frames (the audit's zero-frame starvation).
    expect(executed).toEqual([1]);
    const progress = lines.filter((line) => line.method === 'notifications/progress');
    expect(progress).toHaveLength(2);
    expect(progress[0].params).toMatchObject({
      progressToken: 'tok-q',
      message: 'ape_run status in progress (10s)',
    });

    releaseFirst();
    await queue.drain();
    const responses = lines.filter((line) => line.id !== undefined);
    expect(responses.map((line) => line.id)).toEqual([1, 2]);
    // Heartbeat cleared on settle: no frame may trail the response.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(lines.filter((line) => line.method === 'notifications/progress')).toHaveLength(2);
  });

  it('isolates a rejecting execution: -32603 for that id, later calls still run', async () => {
    const lines = [];
    const queue = createToolCallQueue({
      execute: async (message) => {
        if (message.id === 1) throw new Error('executor exploded');
        return { jsonrpc: '2.0', id: message.id, result: { ok: true } };
      },
      writeLine: (payload) => lines.push(payload),
    });
    queue.enqueue({ id: 1, method: 'tools/call', params: { name: 'ape_run', arguments: {} } });
    queue.enqueue({ id: 2, method: 'tools/call', params: { name: 'ape_run', arguments: {} } });
    await queue.drain();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ id: 1, error: { code: -32603, message: 'executor exploded' } });
    expect(lines[1]).toMatchObject({ id: 2, result: { ok: true } });
  });
});
