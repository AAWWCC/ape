import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
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
