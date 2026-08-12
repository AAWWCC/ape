import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withProgressHeartbeat } from '../bin/ape-mcp.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function session(messages) {
  return new Promise((resolve, reject) => {
    // Strip the ambient host project pins so root resolution is driven by
    // the call arguments alone, not the live session env of whoever runs
    // the suite.
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

describe('APE v2 MCP progress heartbeat', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('emits well-formed heartbeats every 10s and none after the result resolves', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    const lines = [];
    let release;
    const work = new Promise((resolve) => { release = resolve; });
    const call = withProgressHeartbeat('tok-1', 'ape_run record', () => work, {
      writeLine: (payload) => lines.push(payload),
    });
    await vi.advanceTimersByTimeAsync(25_000);
    expect(lines).toEqual([
      {
        jsonrpc: '2.0',
        method: 'notifications/progress',
        params: { progressToken: 'tok-1', progress: 10, message: 'ape_run record in progress (10s)' },
      },
      {
        jsonrpc: '2.0',
        method: 'notifications/progress',
        params: { progressToken: 'tok-1', progress: 20, message: 'ape_run record in progress (20s)' },
      },
    ]);
    release('done');
    await expect(call).resolves.toBe('done');
    // The interval is cleared before the caller can write the response, so no
    // notification may trail the result.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(lines).toHaveLength(2);
  });

  it('supports integer progress tokens, including 0', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    const lines = [];
    let release;
    const work = new Promise((resolve) => { release = resolve; });
    const call = withProgressHeartbeat(0, 'ape_run regate', () => work, {
      writeLine: (payload) => lines.push(payload),
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(lines[0].params.progressToken).toBe(0);
    release(null);
    await call;
  });

  it('emits zero notifications when no progressToken is supplied', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    const lines = [];
    let release;
    const work = new Promise((resolve) => { release = resolve; });
    const call = withProgressHeartbeat(undefined, 'ape_run status', () => work, {
      writeLine: (payload) => lines.push(payload),
    });
    await vi.advanceTimersByTimeAsync(120_000);
    release('ok');
    await expect(call).resolves.toBe('ok');
    expect(lines).toEqual([]);
  });

  it('clears the interval on the error path — no notification after rejection', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    const lines = [];
    let reject;
    const work = new Promise((_resolve, rej) => { reject = rej; });
    const call = withProgressHeartbeat('tok-err', 'ape_run record', () => work, {
      writeLine: (payload) => lines.push(payload),
    });
    call.catch(() => {});
    await vi.advanceTimersByTimeAsync(10_000);
    expect(lines).toHaveLength(1);
    reject(new Error('boom'));
    await expect(call).rejects.toThrow('boom');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(lines).toHaveLength(1);
  });

  it('never fires the heartbeat when work rejects synchronously', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    const lines = [];
    const call = withProgressHeartbeat('tok-sync', 'ape_run record', () => {
      throw new Error('immediate');
    }, { writeLine: (payload) => lines.push(payload) });
    await expect(call).rejects.toThrow('immediate');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(lines).toEqual([]);
  });

  it('accepts _meta.progressToken over stdio without extra frames on fast calls', async () => {
    // The abort-with-operation guard errors before touching runtime state, so
    // this exercises the wrapped dispatch (including its error path) against
    // the real server; the call finishes well under the 10s interval, so the
    // response must be the only frame — no stray notification lines.
    // project_dir aims the mutating call at an empty scratch dir so a guard
    // regression fails against nothing instead of this repo's live .ape state.
    const scratch = await mkdtemp(path.join(os.tmpdir(), 'ape-mcp-progress-'));
    const responses = await session([
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'ape_run',
          arguments: {
            action: 'abort',
            operation: 'reset',
            reason: 'operator cleanup',
            project_dir: scratch,
          },
          _meta: { progressToken: 'tok-io' },
        },
      },
    ]);
    expect(responses).toHaveLength(1);
    expect(responses[0].id).toBe(1);
    expect(responses[0].result.isError).toBe(true);
  });
});
