import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { nativeDispatch } from '../lib/runtime/adapters.js';
import { evaluateLifecyclePolicy, normalizeLifecycleEvent } from '../lib/runtime/hooks.js';
import { reduceRun } from '../lib/runtime/scheduler.js';

const ticket = {
  role: 'implementer',
  model: { model: 'gpt-5.5', reasoning_effort: 'medium' },
  ticket_id: 'ticket-1',
  writable: true,
};

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const roles = [
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

  it('shares one parent-side prompt-composition protocol for fresh and resumed dispatches', async () => {
    const [runSkill, resumeSkill, protocol] = await Promise.all([
      readFile(path.join(root, 'plugin-src', 'skills', 'run', 'body.md'), 'utf8'),
      readFile(path.join(root, 'plugin-src', 'skills', 'resume', 'body.md'), 'utf8'),
      readFile(path.join(root, 'plugin-src', 'skills', 'references', 'run-resume-protocol.md'), 'utf8'),
    ]);
    for (const skill of [runSkill, resumeSkill]) {
      expect(skill).toContain('references/run-resume-protocol.md');
    }
    const common = protocol.indexOf('complete common prompt');
    const role = protocol.indexOf('complete role prompt');
    const ticket = protocol.indexOf("action's immutable ticket");
    expect([common, role, ticket].every((index) => index >= 0)).toBe(true);
    expect(common).toBeLessThan(role);
    expect(role).toBeLessThan(ticket);
    expect(protocol).toMatch(/On Codex,[\s\S]*inline them[\s\S]*dispatch-intent prompt/);

    for (const role of roles) {
      const rolePrompt = await readFile(path.join(root, 'prompts', `${role}.md`), 'utf8');
      expect(rolePrompt).not.toMatch(/Read [`'"]common\.md[`'"]/);
    }
  });

  it('carries a Codex dispatch intent without an ambient env binding', () => {
    const intent = { nonce: 'n'.repeat(43), prompt: `APE_DISPATCH_NONCE=${'n'.repeat(43)}` };
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
