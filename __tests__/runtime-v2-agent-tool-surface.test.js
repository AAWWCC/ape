import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SAFE_CLAUDE_SUBAGENT_TOOLS } from '../lib/runtime/hooks.js';

// Layer 2 (defense in depth) of control-plane ownership: the agents/*.md
// manifests declare a tools: allowlist so an APE subagent can never reach Agent,
// Task, or the ape_* control-plane MCP tools even when the policy hook is not
// installed or trusted (the sole protection whenever the host omits agent
// identity on MCP payloads). Single source of truth: the runtime's exported
// SAFE_CLAUDE_SUBAGENT_TOOLS.
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const agentsDir = path.join(root, 'agents');

const SAFE = [...SAFE_CLAUDE_SUBAGENT_TOOLS];
const WRITER_EXTRA = ['Edit', 'Write', 'MultiEdit'];
const WRITERS = new Set(['implementer', 'test-writer']);
const CONTROL_PLANE = /(?:^|__)ape_(run|config|history)$/;

function parseTools(file) {
  const source = readFileSync(path.join(agentsDir, file), 'utf8');
  const match = source.match(/^---\n([\s\S]*?)\n---/);
  expect(match, `${file} has frontmatter`).toBeTruthy();
  const name = match[1].match(/^name:\s*(.+)$/m)?.[1]?.trim();
  const toolsLine = match[1].match(/^tools:\s*(.+)$/m)?.[1];
  expect(toolsLine, `${file} declares a tools: line`).toBeTruthy();
  const tools = toolsLine.split(',').map((token) => token.trim()).filter(Boolean);
  return { name, tools };
}

describe('APE v2 agent tool-surface allowlists', () => {
  const files = readdirSync(agentsDir).filter((file) => file.endsWith('.md'));

  it('covers all ten agent manifests', () => {
    expect(files.length).toBe(10);
  });

  it.each(readdirSync(agentsDir).filter((file) => file.endsWith('.md')))(
    '%s declares a tools: allowlist that omits Agent/Task and every ape_* MCP tool',
    (file) => {
      const { tools } = parseTools(file);
      expect(tools).not.toContain('Agent');
      expect(tools).not.toContain('Task');
      for (const tool of tools) {
        expect(tool.startsWith('mcp__'), `${file}: ${tool} is an MCP tool`).toBe(false);
        expect(CONTROL_PLANE.test(tool), `${file}: ${tool} is a control-plane tool`).toBe(false);
      }
    },
  );

  it.each(readdirSync(agentsDir).filter((file) => file.endsWith('.md')))(
    '%s grants exactly the role-appropriate tool set',
    (file) => {
      const { name, tools } = parseTools(file);
      const expected = WRITERS.has(name) ? [...SAFE, ...WRITER_EXTRA] : SAFE;
      expect(new Set(tools)).toEqual(new Set(expected));
      // No duplicates and no tool outside the expected set.
      expect(tools.length).toBe(expected.length);
    },
  );
});
