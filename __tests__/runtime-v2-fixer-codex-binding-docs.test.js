import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

// Codex uses a visible task-name capability -> host identity -> receipt
// capability chain. Pin the documented native hook path so an ambient environment
// binding cannot return as a shortcut.

async function read(relative) {
  return readFile(new URL(`../${relative}`, import.meta.url), 'utf8');
}

describe('APE v2 Codex ticket-binding docs', () => {
  it('the shared run/resume protocol requires native generated-name binding, never ambient env', async () => {
    const protocol = await read('plugin-src/skills/references/run-resume-protocol.md');
    expect(protocol).not.toContain('dispatch.env');
    expect(protocol).not.toMatch(/launch the\s+subagent with that environment/i);
    expect(protocol).toMatch(/host-native tool[\s\S]*generated\s+name[\s\S]*dispatch intent/i);
    expect(protocol).toMatch(/binding probe[\s\S]*probe-status[\s\S]*probe-ack/i);
    expect(protocol).toMatch(/fresh, single-use proof/i);
    expect(protocol).toMatch(
      /ape_run probe[\s\S]*host: "codex"[\s\S]*explicit_invocation: true[\s\S]*hooks_trusted: true[\s\S]*subagents_available: true/i,
    );
    expect(protocol).toMatch(/mandatory on the probe call itself[\s\S]*do not make a partial probe call and retry/i);
    expect(protocol).toMatch(/receipt_capability[\s\S]*action: "record"/i);
  });

  it('the workflow doc describes the live Codex binding channel', async () => {
    const workflows = await read('docs/workflows.md');
    expect(workflows).toContain('dispatch.agent_name');
    expect(workflows).toContain('spawn_agent.message');
    expect(workflows).toContain('collaborationspawn_agent');
    expect(workflows).toContain('SubagentStart');
    expect(workflows).toMatch(/shipped hook manifest alone is not treated as operational proof/i);
    expect(workflows).toMatch(/child `session_id`/i);
    expect(workflows).toMatch(/host-issued child `session_id`, `agent_id`/i);
    expect(workflows).toMatch(/No ambient environment\s+binding/i);
  });

  it('the adapter descriptor does not advertise an env channel the host cannot transmit', async () => {
    const adapters = await read('lib/runtime/adapters.js');
    expect(adapters).not.toMatch(/env:\s*\{\s*APE_TICKET_ID/);
  });
});
