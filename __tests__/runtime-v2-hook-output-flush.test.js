import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const hook = fileURLToPath(new URL('../bin/ape-hook.mjs', import.meta.url));
const roots = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'ape-hook-output-'));
  roots.push(root);
  await mkdir(path.join(root, '.ape', 'runtime'), { recursive: true });
  const preload = path.join(root, 'slow-stdout.mjs');
  // Model a backpressured pipe in the real hook subprocess. The first bytes
  // reach the OS immediately; the remaining bytes and write callback are held.
  // An unconditional process.exit truncates the response without an error.
  await writeFile(preload, `
    import { Writable } from 'node:stream';
    const destination = process.stdout;
    const delayed = new Writable({ highWaterMark: 1, write(chunk, encoding, callback) {
      const middle = Math.max(1, Math.floor(chunk.length / 2));
      destination.write(chunk.subarray(0, middle));
      setTimeout(() => destination.write(chunk.subarray(middle), callback), 40);
    } });
    Object.defineProperty(process, 'stdout', { value: delayed });
  `);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(?:APE_|CLAUDE|CODEX|PLUGIN_ROOT|NODE_OPTIONS)/i.test(key)));
  return { root, preload, env };
}

function invoke(f, input, slow, args = []) {
  return spawnSync(process.execPath, [...(slow ? ['--import', f.preload] : []), hook, ...args], {
    cwd: f.root, env: f.env, input: `${JSON.stringify({ project_dir: f.root, cwd: f.root, ...input })}\n`,
    encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024,
  });
}

describe('hook output drains before explicit exit', () => {
  it.each([
    ['session guidance', { hook_event_name: 'SessionStart', source: 'startup' }, []],
    ['control-plane allowance', { hook_event_name: 'PreToolUse', tool_name: 'mcp__ape__ape_status' }, []],
    ['bootstrap denial', { hook_event_name: 'PreToolUse', tool_name: 'mcp__ape__ape_bind', tool_input: {} }, []],
    ['external integration neutrality', { hook_event_name: 'PreToolUse', tool_name: 'mcp__synthetic__inspect' }, []],
    ['wildcard canary neutrality', { hook_event_name: 'PreToolUse', tool_name: 'mcp__synthetic__inspect' }, ['--ape-canary-only']],
  ])('preserves complete JSON for %s under backpressure', async (_name, input, args) => {
    const f = await fixture();
    const control = invoke(f, input, false, args);
    expect(control.error).toBeUndefined();
    expect(control.status, control.stderr).toBe(0);
    const expected = JSON.parse(control.stdout);
    const slow = invoke(f, input, true, args);
    expect(slow.error).toBeUndefined();
    expect(slow.status, slow.stderr).toBe(0);
    expect(slow.stdout).toBe(control.stdout);
    expect(JSON.parse(slow.stdout)).toEqual(expected);
    if (_name === 'bootstrap denial') expect(expected.hookSpecificOutput.permissionDecision).toBe('deny');
  });
});
