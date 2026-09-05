import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CODEX_DISPATCH_BOOTSTRAP_MESSAGE,
  CODEX_DISPATCH_NEXT_CONTROL,
  codexInjectedDispatchContext,
  nativeDispatch,
} from '../lib/runtime/adapters.js';
import { canonicalJson, sha256 } from '../lib/runtime/canonical.js';
import { RECEIPT_INPUT_SCHEMA } from '../lib/runtime/receipt-input.js';
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
  output_schema: RECEIPT_INPUT_SCHEMA,
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
  it('enforces each native model boundary without stripping open annotations', () => {
    const annotation = 'operator-note-'.repeat(4_000);
    const claudeModel = { model: 'c'.repeat(256), annotation };
    const claude = nativeDispatch('claude', { ...ticket, model: claudeModel });
    expect(claude.model).toBe(claudeModel);
    expect(() => nativeDispatch('claude', { ...ticket, model: { model: '' } }))
      .toThrow('Claude dispatch ticket carries an invalid model');
    expect(() => nativeDispatch('claude', { ...ticket, model: { model: 1 } }))
      .toThrow('Claude dispatch ticket carries an invalid model');
    expect(() => nativeDispatch('claude', {
      ...ticket,
      model: { model: 'c'.repeat(257) },
    })).toThrow('Claude dispatch ticket carries an invalid model');

    const codexModel = {
      model: 'g'.repeat(512),
      reasoning_effort: 'r'.repeat(64),
      annotation,
    };
    expect(nativeDispatch('codex', { ...ticket, model: codexModel }).model).toBe(codexModel);
    expect(() => nativeDispatch('codex', {
      ...ticket,
      model: { model: 'g'.repeat(513), reasoning_effort: 'high' },
    })).toThrow('Codex dispatch ticket carries an invalid model');
    expect(() => nativeDispatch('codex', {
      ...ticket,
      model: { model: 'gpt-5.5', reasoning_effort: 'r'.repeat(65) },
    })).toThrow('Codex dispatch ticket carries an invalid reasoning effort');
  });

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

  it('shares one hook-injected dispatch-envelope protocol for fresh and resumed dispatches', async () => {
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
    const common = protocol.indexOf('common prompt');
    const role = protocol.indexOf('role prompt');
    const ticket = protocol.indexOf('immutable ticket reference');
    expect([common, role, ticket].every((index) => index >= 0)).toBe(true);
    expect(common).toBeLessThan(role);
    expect(role).toBeLessThan(ticket);
    expect(protocol).toMatch(/On Codex,[\s\S]*transport-only\s+bootstrap/);
    expect(protocol).toContain('`ticket_projection: "bootstrap-hook-injected"`');
    expect(protocol).toMatch(/return that draft unchanged[\s\S]*Call `next`/);

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

  it('codex-dispatch-envelope returns a static bootstrap and canonical hook context', async () => {
    const intent = {
      agent_name: `ape_implementer_${'b'.repeat(32)}`,
      prompt: 'Execute the immutable APE StageTicket ticket-1.',
    };
    const codex = nativeDispatch('codex', ticket, intent);
    const injected = codexInjectedDispatchContext(ticket);

    expect(codex.protocol_version).toBe(CODEX_DISPATCH_PROTOCOL_VERSION);
    expect(codex.envelope_version).toBe(CODEX_DISPATCH_ENVELOPE_VERSION);
    expect(codex.ticket_id).toBe(ticket.ticket_id);
    expect(codex.ticket_projection).toBe('hook-injected');
    expect(codex.spawn_args).toStrictEqual({
      task_name: intent.agent_name,
      fork_turns: 'none',
      model: 'gpt-5.5',
      reasoning_effort: 'medium',
      message: CODEX_DISPATCH_BOOTSTRAP_MESSAGE,
    });
    expect(injected).toContain('APE trusted native binding context (authoritative)');
    expect(injected).toContain('Shell inspection permits only ls, cat, pwd, which, and these read-only git verbs:');
    expect(injected).toContain('ls-files, and ls-tree.');
    expect(injected).toContain('Keep recognized command heads unquoted.');
    expect(injected).toContain("cat 'app/[id]/page.tsx'");
    expect(injected).toContain('exact sha256sum and shasum command heads');
    expect(injected).toContain('optional output_hash, omit it');
    expect(injected).toContain('never pipe, redirect, or run a standalone checksum probe');
    expect(injected).toContain('never run git rev-parse HEAD^{tree}; braces are denied');
    expect(injected).toContain('The ticket already supplies base_tree_sha and the runtime recomputes tree hashes.');
    expect(injected).toContain('If commit evidence is needed, use git rev-parse HEAD.');
    expect(injected.indexOf('never run git rev-parse HEAD^{tree}; braces are denied'))
      .toBeLessThan(injected.indexOf('APE common contract'));
    expect(injected).toContain('Never invoke rg, grep, sed, find, awk');
    expect(injected.indexOf('Never invoke rg, grep, sed, find, awk'))
      .toBeLessThan(injected.indexOf('APE common contract'));
    expect(injected).toMatch(/first denied non-mutating read[\s\S]*retry once in this same stage/iu);
    expect(injected).toMatch(/correction is denied[\s\S]*stage failed[\s\S]*never probe further/iu);
    expect(injected).toContain('APE common contract');
    expect(injected).toContain('APE implementer contract');
    expect(injected).toContain('APE hook-enforced receipt construction (authoritative)');
    expect(injected).toContain('Receipt envelope scaffold');
    expect(injected).toContain('Role-specific output_schema excerpt');
    expect(injected).toContain('"receipt_capability":"$APE_RECEIPT_CAPABILITY"');
    expect(injected).toContain('SubagentStop hook refuses termination');
    expect(injected).toContain('Immutable StageTicket reference');
    expect(injected).toContain('"path":".ape/runtime/tickets/ticket-1.json"');
    expect(injected).toContain(`"ticket_hash":"${ticket.ticket_hash}"`);
    expect(codex.spawn_args.message).not.toContain('APE common contract');
    expect(codex.spawn_args.message).not.toContain(ticket.ticket_id);
    expect(codex.next_control).toBe(CODEX_DISPATCH_NEXT_CONTROL);
    expect(codex.next_control).toBe(
      'After native spawn returns, call ape_run action "status" with only action and project_dir; never send run_id on status. While launched, wait for that same child to call ape_bind and receive trusted ticket context; do not launch a replacement or advance early. When active-bound, wait for the worker to validate its exact final draft with ape_validate_receipt and return it unchanged. Record it unchanged. Follow the runtime next_action exactly: continue_same_agent carries exact corrections; redispatch_same_ticket alone authorizes one fresh worker on the same ticket; receipt-contract failures never authorize product remediation, replan, abort, or a successor. After the group is fully recorded, call ape_run action "next". Continue through scheduler-owned stages, reviews, replans, remediations, gates, waits, and configured auto-merge without asking the user to say continue; the explicit APE invocation already authorizes them. Yield only for completed, a genuinely terminal block, or an outcome-changing input request.',
    );

    // Compatibility and diagnostics stay available, but no installed-package
    // absolute path is exposed and no parent-side contract assembly is trusted.
    expect(codex.agent_name).toBe(intent.agent_name);
    expect(codex.model).toBe(ticket.model);
    expect(codex.prompt_paths).toEqual(['prompts/common.md', 'prompts/implementer.md']);
    expect(JSON.stringify(codex)).not.toContain(root);
  });

  it('canonicalizes the injected ticket reference and rejects path-shaped roles before prompt loading', () => {
    const reordered = {
      writable: ticket.writable,
      ticket_id: ticket.ticket_id,
      ticket_hash: ticket.ticket_hash,
      model: { reasoning_effort: 'medium', model: 'gpt-5.5' },
      role: ticket.role,
      output_schema: ticket.output_schema,
    };
    const first = codexInjectedDispatchContext(ticket);
    const second = codexInjectedDispatchContext(reordered);
    expect(first).toBe(second);

    expect(() => nativeDispatch('codex', { ...ticket, role: '../../outside' }))
      .toThrow('Codex dispatch ticket carries an invalid role');
    const bulky = nativeDispatch('codex', {
      ...ticket,
      objective: '"\\'.repeat(RESPONSE_BUDGET_CHARS),
    });
    expect(bulky.spawn_args.message).toBe(CODEX_DISPATCH_BOOTSTRAP_MESSAGE);
  });

  it('keeps every load-bearing ticket field out of the unobservable launch message', () => {
    const objective = 'z'.repeat(24_000);
    const oversizedTicket = {
      ...ticket,
      objective: `Complete stage build. Run objective: ${objective}`,
    };
    const dispatch = nativeDispatch('codex', oversizedTicket, null, {
      run_objective: objective,
    });
    const injected = codexInjectedDispatchContext(oversizedTicket);
    expect(dispatch.ticket_projection).toBe('hook-injected');
    expect(dispatch.spawn_args.message).toBe(CODEX_DISPATCH_BOOTSTRAP_MESSAGE);
    expect(injected).toContain(
      '"path":".ape/runtime/tickets/ticket-1.json"',
    );
    expect(injected).toContain(`"ticket_hash":"${ticket.ticket_hash}"`);
    expect(dispatch.spawn_args.message).not.toContain('"objective"');
    expect(dispatch.spawn_args.message).not.toContain(objective);
    expect(injected).not.toContain(objective);
  });

  it('keeps a near-limit codex-dispatch-envelope response inside the wire target', () => {
    const objective = 'x'.repeat(18_000);
    const boundaryTicket = { ...ticket, objective };
    const dispatch = nativeDispatch('codex', boundaryTicket, {
      agent_name: `ape_implementer_${'c'.repeat(32)}`,
      prompt: 'Execute the immutable APE StageTicket ticket-1.',
    }, { run_objective: objective, dispatch_group_size: 1 });
    expect(dispatch.spawn_args.message).toBe(CODEX_DISPATCH_BOOTSTRAP_MESSAGE);

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
      expect(dispatch.ticket_projection).toBe('hook-injected');
      expect(dispatch.spawn_args.fork_turns).toBe('none');
      expect(dispatch.spawn_args.message).toBe(CODEX_DISPATCH_BOOTSTRAP_MESSAGE);
      expect(dispatch.spawn_args.message).not.toContain('risk-0-');
      expect(codexInjectedDispatchContext(tickets[index])).toContain(
        `.ape/runtime/tickets/${tickets[index].ticket_id.replaceAll(':', '_')}.json`,
      );
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
