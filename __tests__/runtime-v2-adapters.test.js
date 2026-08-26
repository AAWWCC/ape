import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CODEX_DISPATCH_MESSAGE_WIRE_LIMIT,
  CODEX_DISPATCH_NEXT_CONTROL,
  nativeDispatch,
} from '../lib/runtime/adapters.js';
import { canonicalJson, sha256 } from '../lib/runtime/canonical.js';
import { evaluateLifecyclePolicy, normalizeLifecycleEvent } from '../lib/runtime/hooks.js';
import { projectRunResponse, RESPONSE_BUDGET_CHARS } from '../lib/runtime/projection.js';
import { reduceRun } from '../lib/runtime/scheduler.js';
import {
  CODEX_DISPATCH_ENVELOPE_VERSION,
  CODEX_DISPATCH_PROTOCOL_VERSION,
} from '../lib/runtime/versions.js';
import {
  CandidatePlanSchema,
  PLAN_CONTRACT_MAX_BYTES,
} from '../lib/runtime/plan-contract.js';

const ticket = {
  role: 'implementer',
  model: { model: 'gpt-5.5', reasoning_effort: 'medium' },
  ticket_id: 'ticket-1',
  ticket_hash: '1'.repeat(64),
  writable: true,
};

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const roles = [
  'preflight_analyst',
  'planner',
  'plan_checker',
  'plan_critic',
  'plan_judge',
  'test_writer',
  'implementer',
  'reviewer',
  'security_reviewer',
  'debugger',
  'spike_researcher',
];

describe('APE v2 adapter conformance', () => {
  it('translates the same ticket without owning policy', () => {
    const claude = nativeDispatch('claude', ticket);
    const codex = nativeDispatch('codex', ticket);
    expect(claude).toMatchObject({
      native_tool: 'Agent',
      agent_type: 'ape:implementer',
      prompt_paths: ['prompts/common.md', 'prompts/implementer.md'],
      ticket,
    });
    expect(codex).toMatchObject({
      native_tool: 'spawn_agent',
      // Portable built-in profile plus the semantic APE role name.
      agent_name: 'implementer',
      agent_type: 'worker',
      prompt_paths: ['prompts/common.md', 'prompts/implementer.md'],
      ticket,
    });
    expect(claude.ticket).toBe(codex.ticket);
  });

  it.each(roles)('declares common-before-role prompt composition for %s on both hosts', (role) => {
    const roleTicket = { ...ticket, role };
    expect(nativeDispatch('claude', roleTicket).prompt_paths).toEqual([
      'prompts/common.md',
      `prompts/${role}.md`,
    ]);
    expect(nativeDispatch('codex', roleTicket).prompt_paths).toEqual([
      'prompts/common.md',
      `prompts/${role}.md`,
    ]);
  });

  it('shares one self-contained dispatch-envelope protocol for fresh and resumed dispatches', async () => {
    const [runSkill, resumeSkill, protocol] = await Promise.all([
      readFile(path.join(root, 'plugin-src', 'skills', 'run', 'body.md'), 'utf8'),
      readFile(path.join(root, 'plugin-src', 'skills', 'resume', 'body.md'), 'utf8'),
      readFile(path.join(root, 'plugin-src', 'skills', 'references', 'run-resume-protocol.md'), 'utf8'),
    ]);
    for (const skill of [runSkill, resumeSkill]) {
      expect(skill).toContain('references/run-resume-protocol.md');
    }
    expect(protocol).toContain('pass `dispatch.spawn_args` directly');
    expect(protocol).toContain('every key and value\n   unchanged');
    expect(protocol).toContain('`fork_turns: "none"`');
    expect(protocol).toContain('Never reread `prompt_paths`');
    const common = protocol.indexOf('complete common prompt');
    const role = protocol.indexOf('complete role prompt');
    const ticket = protocol.indexOf('immutable ticket');
    expect([common, role, ticket].every((index) => index >= 0)).toBe(true);
    expect(common).toBeLessThan(role);
    expect(role).toBeLessThan(ticket);
    expect(protocol).toMatch(/On Codex,[\s\S]*self-contained launch envelope/);
    expect(protocol).toMatch(/record the returned[\s\S]*receipt unchanged[\s\S]*ape_run next/);

    for (const role of roles) {
      const rolePrompt = await readFile(path.join(root, 'prompts', `${role}.md`), 'utf8');
      expect(rolePrompt).not.toMatch(/Read [`'"]common\.md[`'"]/);
    }
  });

  it('carries a Codex dispatch intent without an ambient env binding', () => {
    const intent = {
      agent_name: `ape_implementer_${'a'.repeat(32)}`,
      nonce: 'n'.repeat(43),
      prompt: `APE_DISPATCH_NONCE=${'n'.repeat(43)}`,
    };
    const codex = nativeDispatch('codex', ticket, intent);

    expect('env' in codex).toBe(false);
    expect(codex.ticket.ticket_id).toBe('ticket-1');
    expect(codex.dispatch_intent).toBe(intent);

    // With no host-delivered binding, the normalized event carries no ticket
    // and the write policy fails closed instead of trusting the dispatch.
    const event = normalizeLifecycleEvent(
      {
        hook_event_name: 'PreToolUse',
        project_dir: '/tmp/ape-codex-project',
        tool_name: 'Write',
        tool_input: { file_path: 'src/value.js' },
        agent_id: 'codex-worker-1',
      },
      {},
    );
    expect(event.host).toBe('codex');
    expect(event.ticket_id).toBeNull();
    const decision = evaluateLifecyclePolicy(event, {
      state: { status: 'running' },
      ticket: null,
    });
    expect(decision.decision).toBe('deny');
    expect(decision.reason).toMatch(/not bound to an active ticket/);

    // The normalization seam stays ready for a real host channel: an explicit
    // host-delivered ticket_id payload field (or environment value) binds.
    const bound = normalizeLifecycleEvent(
      {
        hook_event_name: 'PreToolUse',
        project_dir: '/tmp/ape-codex-project',
        tool_name: 'Write',
        tool_input: { file_path: 'src/value.js' },
        agent_id: 'codex-worker-1',
        ticket_id: 'ticket-1',
      },
      {},
    );
    expect(bound.ticket_id).toBe('ticket-1');
  });

  it('codex-dispatch-envelope returns one exact, canonical native spawn payload', async () => {
    const intent = {
      agent_name: `ape_implementer_${'b'.repeat(32)}`,
      prompt: 'Execute the immutable APE StageTicket ticket-1.',
    };
    const [commonPrompt, rolePrompt] = await Promise.all([
      readFile(path.join(root, 'prompts', 'common.md'), 'utf8'),
      readFile(path.join(root, 'prompts', 'implementer.md'), 'utf8'),
    ]);
    const expectedMessage = [
      intent.prompt,
      'APE common contract',
      commonPrompt,
      'APE implementer contract',
      rolePrompt,
      'Immutable StageTicket',
      canonicalJson(ticket),
    ].join('\n\n');

    const codex = nativeDispatch('codex', ticket, intent);

    expect(codex.protocol_version).toBe(CODEX_DISPATCH_PROTOCOL_VERSION);
    expect(codex.envelope_version).toBe(CODEX_DISPATCH_ENVELOPE_VERSION);
    expect(codex.ticket_id).toBe(ticket.ticket_id);
    expect(codex.ticket_projection).toBe('full');
    expect(codex.spawn_args).toStrictEqual({
      task_name: intent.agent_name,
      fork_turns: 'none',
      model: 'gpt-5.5',
      reasoning_effort: 'medium',
      message: expectedMessage,
    });
    expect(codex.next_control).toBe(CODEX_DISPATCH_NEXT_CONTROL);
    expect(codex.next_control).toBe(
      'Record each returned receipt unchanged with ape_run action "record"; after the group is fully recorded, call ape_run action "next".',
    );

    // Compatibility and diagnostics stay available, but no installed-package
    // absolute path is exposed and no parent-side prompt assembly is needed.
    expect(codex.agent_name).toBe(intent.agent_name);
    expect(codex.model).toBe(ticket.model);
    expect(codex.prompt_paths).toEqual(['prompts/common.md', 'prompts/implementer.md']);
    expect(JSON.stringify(codex)).not.toContain(root);
  });

  it('canonicalizes the immutable StageTicket and rejects path-shaped roles before prompt loading', () => {
    const reordered = {
      writable: ticket.writable,
      ticket_id: ticket.ticket_id,
      ticket_hash: ticket.ticket_hash,
      model: { reasoning_effort: 'medium', model: 'gpt-5.5' },
      role: ticket.role,
    };
    const first = nativeDispatch('codex', ticket).spawn_args.message;
    const second = nativeDispatch('codex', reordered).spawn_args.message;
    expect(first).toBe(second);

    expect(() => nativeDispatch('codex', { ...ticket, role: '../../outside' }))
      .toThrow('Codex dispatch ticket carries an invalid role');
    expect(() => nativeDispatch('codex', ticket, { prompt: 'x'.repeat(4 * 1024 + 1) }))
      .toThrow('Codex dispatch intent must carry a bounded text prompt');

    expect(CODEX_DISPATCH_MESSAGE_WIRE_LIMIT).toBeLessThan(RESPONSE_BUDGET_CHARS);
    expect(() => nativeDispatch('codex', {
      ...ticket,
      objective: '"\\'.repeat(CODEX_DISPATCH_MESSAGE_WIRE_LIMIT),
    })).toThrow('Codex dispatch message exceeds the bounded launch envelope');
  });

  it('uses the existing lossless ticket references when a full message would cross the cap', () => {
    const objective = 'z'.repeat(24_000);
    const oversizedTicket = {
      ...ticket,
      objective: `Complete stage build. Run objective: ${objective}`,
    };
    const dispatch = nativeDispatch('codex', oversizedTicket, null, {
      run_objective: objective,
    });
    expect(dispatch.ticket_projection).toBe('bounded');
    expect(JSON.stringify(dispatch.spawn_args.message).length)
      .toBeLessThanOrEqual(CODEX_DISPATCH_MESSAGE_WIRE_LIMIT);
    expect(dispatch.spawn_args.message).toContain(
      '"path":".ape/runtime/tickets/ticket-1.json"',
    );
    expect(dispatch.spawn_args.message).toContain(`"ticket_hash":"${ticket.ticket_hash}"`);
    expect(dispatch.spawn_args.message).not.toContain('"objective"');
    expect(dispatch.spawn_args.message).not.toContain(objective);
  });

  it('keeps a near-limit codex-dispatch-envelope response inside the wire target', () => {
    const objective = 'x'.repeat(18_000);
    const boundaryTicket = { ...ticket, objective };
    const dispatch = nativeDispatch('codex', boundaryTicket, {
      agent_name: `ape_implementer_${'c'.repeat(32)}`,
      prompt: 'Execute the immutable APE StageTicket ticket-1.',
    }, { run_objective: objective, dispatch_group_size: 1 });
    expect(JSON.stringify(dispatch.spawn_args.message).length)
      .toBeLessThanOrEqual(CODEX_DISPATCH_MESSAGE_WIRE_LIMIT);

    const projected = projectRunResponse({
      ok: true,
      run: {
        run_id: 'run-1',
        status: 'running',
        objective,
        tickets: [boundaryTicket],
        receipts: [],
      },
      actions: [{ type: 'dispatch_agent', dispatch, ticket: boundaryTicket }],
    });

    expect(JSON.stringify(projected).length).toBeLessThan(RESPONSE_BUDGET_CHARS);
    expect(projected.actions[0].ticket).toMatchObject({
      ticket_id: ticket.ticket_id,
      role: ticket.role,
    });
    expect(projected.actions[0].dispatch.spawn_args).toEqual(dispatch.spawn_args);
  });

  it('budgets a realistic plan-check and plan-critic envelope group under the response cap', () => {
    const objective = `Review a concurrent plan group. ${'q'.repeat(18_000)}`;
    const plan = {
      version: 1,
      requirements: [{ id: 'R1', requirement: 'Keep dispatch bounded', workstreams: ['wire'] }],
      workstreams: [{
        id: 'wire',
        outcome: 'Both native launches are self-contained',
        paths: [{ path: 'lib/runtime/adapters.js', action: 'modify' }],
        steps: ['Emit exact spawn arguments'],
        acceptance: ['Response remains below the MCP target'],
        evidence_commands: ['npm test'],
      }],
      risks: Array.from({ length: 16 }, (_, index) => ({
        risk: `risk-${index}-${'r'.repeat(360)}`,
        mitigation: `mitigation-${index}-${'m'.repeat(360)}`,
      })),
      non_goals: [],
    };
    const candidatePlan = { plan_hash: sha256(plan), plan };
    expect(CandidatePlanSchema.parse(candidatePlan)).toEqual(candidatePlan);
    const planBytes = Buffer.byteLength(canonicalJson(plan), 'utf8');
    expect(planBytes).toBeGreaterThan(12_000);
    expect(planBytes).toBeLessThanOrEqual(PLAN_CONTRACT_MAX_BYTES);
    const intent = (role, fill) => ({
      agent_name: `ape_${role}_${fill.repeat(32)}`,
      prompt: `Execute the immutable APE StageTicket run-1:${role}:1.`,
    });
    const makePlanTicket = (role) => ({
      ...ticket,
      ticket_id: `run-1:${role}:1`,
      run_id: 'run-1',
      stage_id: role === 'plan_checker' ? 'plan-check' : 'plan-critic',
      role,
      writable: false,
      objective: `Review the candidate plan. Run objective: ${objective}`,
      candidate_plan: candidatePlan,
    });
    const tickets = [makePlanTicket('plan_checker'), makePlanTicket('plan_critic')];
    const dispatches = tickets.map((entry, index) => nativeDispatch(
      'codex',
      entry,
      intent(entry.role, index === 0 ? 'd' : 'e'),
      { run_objective: objective, dispatch_group_size: tickets.length },
    ));
    for (const [index, dispatch] of dispatches.entries()) {
      expect(dispatch.ticket_projection).toBe('bounded');
      expect(dispatch.spawn_args.fork_turns).toBe('none');
      expect(dispatch.spawn_args.message).not.toContain('risk-0-');
      expect(dispatch.spawn_args.message).toContain(
        `.ape/runtime/tickets/${tickets[index].ticket_id.replaceAll(':', '_')}.json`,
      );
      expect(JSON.stringify(dispatch.spawn_args.message).length)
        .toBeLessThanOrEqual(CODEX_DISPATCH_MESSAGE_WIRE_LIMIT / tickets.length);
    }

    const projected = projectRunResponse({
      ok: true,
      run: {
        run_id: 'run-1',
        status: 'running',
        objective,
        tickets,
        receipts: [],
      },
      actions: tickets.map((entry, index) => ({
        type: 'dispatch_agent',
        dispatch: dispatches[index],
        ticket: entry,
      })),
    });
    expect(JSON.stringify(projected).length).toBeLessThan(RESPONSE_BUDGET_CHARS);
    expect(projected.actions.map((action) => action.ticket.role).sort())
      .toEqual(['plan_checker', 'plan_critic']);
  });

  it('routes a failed review through the shared reducer', () => {
    const state = {
      run_id: 'run-1',
      status: 'running',
      lane: 'fast',
      tickets: [{ ticket_id: 'review-1', stage_id: 'review' }],
      receipts: [],
      attempts: { review: 2 },
      remediation_cycles: 0,
    };
    const actions = reduceRun(state, {
      type: 'RECEIPT_RECORDED',
      ticket: state.tickets[0],
      receipt: { status: 'failed' },
      stage: { id: 'review', role: 'reviewer', parallel_group: 'code-review' },
    });
    expect(actions.find((action) => action.type === 'issue_ticket')?.stage.id)
      .toBe('remediation-build');
  });
});
