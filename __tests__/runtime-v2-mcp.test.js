import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LANES } from '../lib/runtime/constants.js';

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

describe('APE v2 MCP public surface', () => {
  it('exposes ape_status beside the legacy control-plane tools', async () => {
    const responses = await session([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    ]);
    // The advertised version is read from package.json, never a literal a
    // release bump has to chase.
    const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
    expect(responses[0].result.serverInfo.version).toBe(pkg.version);
    expect(responses[1].result.tools.map((tool) => tool.name)).toEqual([
      'ape_run',
      'ape_status',
      'ape_history',
      'ape_config',
    ]);
    const status = responses[1].result.tools.find((tool) => tool.name === 'ape_status');
    expect(status.annotations).toMatchObject({ readOnlyHint: true });
    expect(status.inputSchema).toMatchObject({
      type: 'object',
      additionalProperties: false,
    });
  });

  it('serves ape_status as the compact channel while ape_run status remains available', async () => {
    const scratch = await mkdtemp(path.join(os.tmpdir(), 'ape-mcp-status-'));
    try {
      const responses = await session([
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'ape_status', arguments: { project_dir: scratch } },
        },
        {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'ape_run', arguments: { action: 'status', project_dir: scratch } },
        },
      ]);
      const compact = JSON.parse(responses[0].result.content[0].text);
      const legacy = JSON.parse(responses[1].result.content[0].text);
      expect(compact).toMatchObject({
        active: false,
        pending: null,
        gate: { state: 'inactive' },
        next_safe_action: 'ape_run start',
      });
      expect(legacy).toMatchObject({ active: false, run: null });
      expect(legacy).not.toHaveProperty('pending');
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  it('advertises every runtime lane — including mechanical — on the ape_run start schema (F43)', async () => {
    const responses = await session([
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
    ]);
    const run = responses[0].result.tools.find((tool) => tool.name === 'ape_run');
    // The MCP surface must mirror the runtime's LANES constant so a caller can
    // request the mechanical lane that RunStartInputSchema accepts.
    expect(run.inputSchema.properties.lane.enum).toEqual([...LANES]);
    expect(run.inputSchema.properties.lane.enum).toContain('mechanical');
    expect(run.inputSchema.properties.tool_claims).toMatchObject({
      type: 'array',
      items: { type: 'string' },
    });
    expect(run.inputSchema.properties.tool_claims.description).toMatch(/provider:resource:read\|write\|execute/);
    expect(run.inputSchema.properties.action.enum).toEqual(expect.arrayContaining([
      'probe',
      'probe-status',
      'probe-ack',
      'start',
    ]));
    expect(run.inputSchema.properties.probe_id).toMatchObject({ type: 'string' });
    expect(run.inputSchema.properties.probe_capability).toMatchObject({ type: 'string' });
  });

  it('advertises bounded audited artifact maintenance on ape_history', async () => {
    const responses = await session([
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
    ]);
    const history = responses[0].result.tools.find((tool) => tool.name === 'ape_history');
    expect(history.inputSchema.properties.action.enum).toContain('compact-artifacts');
    expect(history.inputSchema.properties.action.enum).toContain('maintenance-status');
    expect(history.inputSchema.properties.keep_recent_runs).toMatchObject({
      type: 'integer',
      minimum: 0,
      maximum: 10000,
    });
    expect(history.inputSchema.properties.max_runs).toMatchObject({
      type: 'integer',
      minimum: 1,
      maximum: 256,
    });
    expect(history.inputSchema.properties.reason.description).toMatch(/compact-artifacts/);
  });

  it('rejects abort carrying an operation instead of silently dropping it', async () => {
    // The guard throws before abortRun runs. project_dir additionally aims
    // the mutating call at an empty scratch dir so a guard regression fails
    // against nothing instead of this repo's live .ape state.
    const scratch = await mkdtemp(path.join(os.tmpdir(), 'ape-mcp-guard-'));
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
        },
      },
    ]);
    expect(responses[0].result.isError).toBe(true);
    const text = responses[0].result.content[0].text;
    expect(text).toMatch(/operation 'reset' belongs to action 'override'/);
    expect(text).toMatch(/"action":"override"/);
    expect(text).toMatch(/"operation":"reset"/);
  });

  it('keeps malformed input from killing the server loop', async () => {
    const responses = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(root, 'bin', 'ape-mcp.mjs')], {
        cwd: root,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.on('error', reject);
      child.on('close', () => resolve(stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line))));
      child.stdin.end('{bad json}\n{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}\n');
    });
    expect(responses[0].error.code).toBe(-32700);
    expect(responses[1].result.tools).toHaveLength(4);
  });

  it.each(['claude', 'codex'])('applies the correct native binding precondition for %s', async (host) => {
    const scratch = await mkdtemp(path.join(os.tmpdir(), `ape-mcp-${host}-start-`));
    try {
      await writeFile(path.join(scratch, 'README.md'), '# fixture\n');
      execFileSync('git', ['init', '-q'], { cwd: scratch });
      execFileSync('git', ['config', 'user.email', 'ape@example.test'], { cwd: scratch });
      execFileSync('git', ['config', 'user.name', 'APE Test'], { cwd: scratch });
      execFileSync('git', ['add', '.'], { cwd: scratch });
      execFileSync('git', ['commit', '-qm', 'test: baseline'], { cwd: scratch });
      const responses = await session([
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'ape_run',
            arguments: {
              action: 'start',
              project_dir: scratch,
              objective: 'Update the fixture documentation',
              mode: 'phase',
              lane: 'mechanical',
              host,
              claimed_paths: ['README.md'],
              behavioral: false,
              hooks_trusted: true,
              subagents_available: true,
              explicit_invocation: true,
            },
          },
        },
      ]);
      const started = JSON.parse(responses[0].result.content[0].text);
      if (host === 'claude') {
        expect(responses[0].result.isError).not.toBe(true);
        expect(started.run.plan_contract_version).toBe(1);
        expect(started).not.toHaveProperty('binding_probe');
      } else {
        expect(responses[0].result.isError).toBe(true);
        expect(started).toMatchObject({
          ok: false,
          blocked: true,
          infrastructure_failure: true,
          attempts_consumed: 0,
          probe: { status: 'missing', infrastructure_status: 'required' },
        });
      }
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
});
