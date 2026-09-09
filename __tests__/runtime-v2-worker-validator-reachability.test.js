import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, cpSync, appendFileSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  WorkerValidatorReachabilityError,
  buildWorkerValidatorInvocation,
  candidateValidatorSurfaceHash,
  canonicalWorkerRoles,
  inspectWorkerValidatorTranscript,
  runWorkerValidatorReachability,
  verifyWorkerValidatorReachabilityProof,
} from '../scripts/run-worker-validator-reachability.mjs';

const scratches = [];
const roles = [
  'debugger',
  'implementer',
  'plan-checker',
  'plan-critic',
  'plan-judge',
  'planner',
  'preflight-analyst',
  'reviewer',
  'security-reviewer',
  'spike-researcher',
  'test-writer',
];

afterEach(() => {
  for (const scratch of scratches.splice(0)) {
    rmSync(scratch, { recursive: true, force: true });
  }
});

function scratch() {
  const directory = mkdtempSync(path.join(tmpdir(), 'ape-validator-reachability-test-'));
  scratches.push(directory);
  mkdirSync(path.join(directory, '.ape', 'runtime'), { recursive: true });
  return directory;
}

function transcript({ tool = 'mcp__ape__ape_validate_receipt', id = 'toolu-probe', input }) {
  return [
    JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id, name: tool, input }] },
    }),
    JSON.stringify({
      type: 'user',
      message: {
        content: [{
          type: 'tool_result',
          tool_use_id: id,
          content: [{ type: 'text', text: JSON.stringify({ ok: false, errors: ['no active run'] }) }],
        }],
      },
    }),
  ].join('\n');
}

describe('live per-role worker validator reachability canary', () => {
  it.each([
    'dist/ape-mcp.bundle.mjs',
    'dist/ape-hooks.bundle.mjs',
    'hooks/hooks.json',
    'prompts/common.md',
    'additional-file.txt',
  ])('invalidates an existing proof when packaged file %s changes or appears', (file) => {
    const pluginDir = path.join(scratch(), 'plugin');
    cpSync(path.join(process.cwd(), 'plugins/ape-claude'), pluginDir, { recursive: true });
    const original = candidateValidatorSurfaceHash({ pluginDir });
    appendFileSync(path.join(pluginDir, file), '\nsynthetic changed candidate bytes\n');
    expect(candidateValidatorSurfaceHash({ pluginDir })).not.toBe(original);
    expect(() => verifyWorkerValidatorReachabilityProof({
      version: 1,
      host: 'claude',
      checked_at: '2026-01-01T00:00:00Z',
      candidate_validator_surface_sha256: original,
    }, { pluginDir })).toThrow(/does not match this candidate/u);
  });

  it.skipIf(process.platform === 'win32')('refuses a symlinked file in the candidate inventory', () => {
    const root = scratch();
    const pluginDir = path.join(root, 'plugin');
    cpSync(path.join(process.cwd(), 'plugins/ape-claude'), pluginDir, { recursive: true });
    writeFileSync(path.join(root, 'external.txt'), 'synthetic external fixture');
    symlinkSync(path.join(root, 'external.txt'), path.join(pluginDir, 'additional-link.txt'));
    expect(() => candidateValidatorSurfaceHash({ pluginDir })).toThrow(/symlinks/u);
  });

  it('refuses to issue proof when the package changes between role calls', () => {
    const pluginDir = path.join(scratch(), 'plugin');
    cpSync(path.join(process.cwd(), 'plugins/ape-claude'), pluginDir, { recursive: true });
    let changed = false;
    expect(() => runWorkerValidatorReachability({
      pluginDir,
      spawn: (_command, args, options) => {
        if (!changed) {
          appendFileSync(path.join(pluginDir, 'prompts/common.md'), '\nsynthetic candidate change\n');
          changed = true;
        }
        const role = args[args.indexOf('--agent') + 1].slice('ape:'.length);
        const ticketId = `ape-validator-reachability:${role}`;
        return {
          status: 0,
          stderr: '',
          stdout: transcript({ input: {
            project_dir: options.cwd, ticket_id: ticketId, draft: { ticket_id: ticketId },
          } }),
        };
      },
    })).toThrow(/candidate package changed/u);
  });

  it('enumerates every canonical and packaged Claude role', () => {
    expect(canonicalWorkerRoles()).toEqual(roles);
    expect(canonicalWorkerRoles(path.join(process.cwd(), 'plugins', 'ape-claude', 'agents')))
      .toEqual(roles);
  });

  it('launches the exact packaged role without injecting an allowed-tools override', () => {
    const projectDir = scratch();
    const invocation = buildWorkerValidatorInvocation({
      role: 'spike-researcher',
      projectDir,
      pluginDir: path.join(process.cwd(), 'plugins', 'ape-claude'),
      claudeBin: '/example/claude',
      model: 'test-model',
    });
    expect(invocation.command).toBe('/example/claude');
    expect(invocation.args).toEqual(expect.arrayContaining([
      '--plugin-dir', path.join(process.cwd(), 'plugins', 'ape-claude'),
      '--agent', 'ape:spike-researcher',
      '--output-format', 'stream-json',
    ]));
    expect(invocation.args).not.toContain('--allowedTools');
    expect(invocation.args).not.toContain('--allowed-tools');
    expect(invocation.args).not.toContain('--tools');
    expect(invocation.args.at(-1)).toContain(
      `"ticket_id":"${invocation.expected.ticket_id}"`,
    );
  });

  it.each([
    'mcp__ape__ape_validate_receipt',
    'mcp__plugin_ape_ape__ape_validate_receipt',
  ])('accepts a linked live tool call and sentinel service result through %s', (tool) => {
    const expected = {
      role: 'spike-researcher',
      project_dir: '/tmp/probe',
      ticket_id: 'ape-validator-reachability:spike-researcher',
    };
    const input = {
      project_dir: expected.project_dir,
      ticket_id: expected.ticket_id,
      draft: { ticket_id: expected.ticket_id },
    };
    const raw = transcript({ tool, input });
    expect(inspectWorkerValidatorTranscript(raw, expected)).toEqual({
      role: expected.role,
      agent: 'ape:spike-researcher',
      validator_tool: tool,
      service_response: 'no-active-run',
      transcript_sha256: createHash('sha256').update(raw).digest('hex'),
    });
  });

  it('rejects prose mentions, wrong inputs, missing results, and generic MCP names', () => {
    const expected = {
      role: 'debugger',
      project_dir: '/tmp/probe',
      ticket_id: 'ape-validator-reachability:debugger',
    };
    for (const raw of [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'mcp__ape__ape_validate_receipt no active run' }] } }),
      transcript({
        tool: 'mcp__other__ape_validate_receipt',
        input: { project_dir: expected.project_dir, ticket_id: expected.ticket_id, draft: { ticket_id: expected.ticket_id } },
      }),
      JSON.stringify({
        type: 'assistant',
        message: { content: [{
          type: 'tool_use',
          id: 'toolu-only',
          name: 'mcp__ape__ape_validate_receipt',
          input: { project_dir: expected.project_dir, ticket_id: 'wrong', draft: { ticket_id: 'wrong' } },
        }] },
      }),
    ]) {
      expect(() => inspectWorkerValidatorTranscript(raw, expected))
        .toThrow(WorkerValidatorReachabilityError);
    }
  });

  it('ignores validator-shaped data outside complete assistant and user message blocks', () => {
    const expected = { role: 'reviewer', project_dir: '/tmp/probe', ticket_id: 'ape-validator-reachability:reviewer' };
    const input = { project_dir: expected.project_dir, ticket_id: expected.ticket_id, draft: { ticket_id: expected.ticket_id } };
    const [call, result] = transcript({ input }).split('\n').map((line) => JSON.parse(line));
    for (const raw of [
      JSON.stringify({ type: 'tool_result', tool_use_id: 'unrelated', content: { call, result } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'unrelated', name: 'mcp__fixture__read', input: { call, result } }] } }),
      JSON.stringify({ type: 'result', structured_output: { call, result } }),
      [JSON.stringify({ ...call, type: 'user' }), JSON.stringify(result)].join('\n'),
    ]) expect(() => inspectWorkerValidatorTranscript(raw, expected)).toThrow(WorkerValidatorReachabilityError);
  });

  it('requires the exact linked JSON sentinel and rejects duplicate or reordered events', () => {
    const expected = { role: 'reviewer', project_dir: '/tmp/probe', ticket_id: 'ape-validator-reachability:reviewer' };
    const input = { project_dir: expected.project_dir, ticket_id: expected.ticket_id, draft: { ticket_id: expected.ticket_id } };
    const [call, result] = transcript({ input }).split('\n').map((line) => JSON.parse(line));
    for (const content of [
      'transport failed before receiving no active run',
      JSON.stringify({ ok: true, errors: ['no active run'] }),
      JSON.stringify({ ok: false, errors: ['no active run', 'transport failed'] }),
      JSON.stringify({ ok: false, errors: ['no active run'], unexpected: true }),
    ]) {
      const changed = structuredClone(result);
      changed.message.content[0].content = [{ type: 'text', text: content }];
      expect(() => inspectWorkerValidatorTranscript([call, changed].map(JSON.stringify).join('\n'), expected))
        .toThrow(/sentinel/u);
    }
    for (const events of [[call, call, result], [call, result, result], [result, call]]) {
      expect(() => inspectWorkerValidatorTranscript(events.map(JSON.stringify).join('\n'), expected))
        .toThrow(WorkerValidatorReachabilityError);
    }
    const wrongCall = structuredClone(call);
    wrongCall.message.content[0].id = 'different-call';
    wrongCall.message.content[0].input.ticket_id = 'different-ticket';
    expect(() => inspectWorkerValidatorTranscript([call, result, wrongCall].map(JSON.stringify).join('\n'), expected))
      .toThrow(/exactly one/u);
    result.message.content[0].is_error = true; // The expected domain rejection is an MCP error result.
    expect(inspectWorkerValidatorTranscript([call, result].map(JSON.stringify).join('\n'), expected).service_response)
      .toBe('no-active-run');
  });

  it('fails closed unless the host transcript proves every role called the validator', () => {
    const launched = [];
    const fakeSpawn = (_command, args, options) => {
      const agent = args[args.indexOf('--agent') + 1];
      const role = agent.slice('ape:'.length);
      launched.push(role);
      const ticketId = `ape-validator-reachability:${role}`;
      return {
        status: 0,
        stdout: transcript({
          tool: role === 'spike-researcher'
            ? 'mcp__plugin_ape_ape__ape_validate_receipt'
            : 'mcp__ape__ape_validate_receipt',
          input: {
            project_dir: options.cwd,
            ticket_id: ticketId,
            draft: { ticket_id: ticketId },
          },
        }),
        stderr: '',
      };
    };
    const result = runWorkerValidatorReachability({ spawn: fakeSpawn });
    expect(launched).toEqual(roles);
    expect(result).toMatchObject({
      version: 1,
      host: 'claude',
      checked_at: expect.any(String),
      candidate_validator_surface_sha256: candidateValidatorSurfaceHash(),
      roles: roles.map((role) => expect.objectContaining({ role })),
    });
    expect(verifyWorkerValidatorReachabilityProof(result)).toEqual({
      ok: true,
      checked_at: result.checked_at,
      candidate_validator_surface_sha256: result.candidate_validator_surface_sha256,
      roles_verified: roles.length,
    });

    const forgedRole = structuredClone(result);
    forgedRole.roles[0].validator_tool = 'mcp__other__ape_validate_receipt';
    expect(() => verifyWorkerValidatorReachabilityProof(forgedRole))
      .toThrow(/observation is invalid/u);

    const staleSurface = structuredClone(result);
    staleSurface.candidate_validator_surface_sha256 = '0'.repeat(64);
    expect(() => verifyWorkerValidatorReachabilityProof(staleSurface))
      .toThrow(/does not match this candidate/u);

    let calls = 0;
    expect(() => runWorkerValidatorReachability({
      spawn: (_command, args, options) => {
        calls += 1;
        const role = args[args.indexOf('--agent') + 1].slice('ape:'.length);
        const ticketId = `ape-validator-reachability:${role}`;
        return {
          status: 0,
          stdout: calls === 3
            ? JSON.stringify({ type: 'assistant', message: { content: [] } })
            : transcript({
                input: {
                  project_dir: options.cwd,
                  ticket_id: ticketId,
                  draft: { ticket_id: ticketId },
                },
              }),
          stderr: '',
        };
      },
    })).toThrow(/did not emit exactly one exact validator call/u);
  });
});
