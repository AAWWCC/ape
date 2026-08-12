import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

// The dispatch prompt carries only ticket_id + nonce (claude-dispatch.js) and
// the SubagentStart injection only capability tokens, so objective delivery
// relies on the orchestrator pasting the ticket. The durable ticket file at
// .ape/runtime/tickets/ (service.js atomicWriteJson with ':' -> '_') is the
// read-only recovery channel: it must stay documented in the agent contract
// without weakening the .ape/ write prohibition.

async function read(relative) {
  return readFile(new URL(`../${relative}`, import.meta.url), 'utf8');
}

describe('APE v2 agent-contract ticket fallback', () => {
  it('common.md documents the read-only on-disk ticket fallback', async () => {
    const contract = await read('prompts/common.md');
    expect(contract).toContain('.ape/runtime/tickets/');
    expect(contract).toMatch(/ticket_id[\s\S]*':'\s+replaced by\s+'_'/);
    for (const field of ['objective', 'claimed_paths', 'test_paths', 'output_schema']) {
      expect(contract).toContain(`\`${field}\``);
    }
  });

  it('the fallback is read-only and the .ape/ write prohibition is intact', async () => {
    const contract = await read('prompts/common.md');
    expect(contract).toMatch(/only sanctioned `\.ape\/` read/i);
    expect(contract).toMatch(/every `\.ape\/` write remains forbidden/i);
    expect(contract).toMatch(/Never write `\.ape\/`/i);
  });
});
