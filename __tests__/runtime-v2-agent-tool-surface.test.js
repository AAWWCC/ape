import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SAFE_CLAUDE_SUBAGENT_TOOLS } from '../lib/runtime/hooks.js';

// Layer 2 (defense in depth) of control-plane ownership: the agents/*.md
// manifests expose inherited MCP tools directly to the host but use
// disallowedTools so an APE subagent can never reach the ape_* control plane,
// even when the policy hook is not installed or trusted. Agent/Task remain absent
// from the built-in allowlist. The runtime exports the shared built-in contract;
// this test pins the Claude-specific MCP frontmatter contract.
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const agentsDir = path.join(root, 'agents');

const SAFE = [...SAFE_CLAUDE_SUBAGENT_TOOLS];
const MCP_TOOL_PATTERN = 'mcp__*';
const DENIED = [
  'mcp__plugin_ape_ape__ape_run',
  'mcp__plugin_ape_ape__ape_status',
  'mcp__plugin_ape_ape__ape_config',
  'mcp__plugin_ape_ape__ape_history',
  'mcp__ape__ape_run',
  'mcp__ape__ape_status',
  'mcp__ape__ape_config',
  'mcp__ape__ape_history',
];
const WRITER_EXTRA = ['Edit', 'Write', 'MultiEdit'];
const WRITERS = new Set(['implementer', 'test-writer']);
const CONTROL_PLANE = /^mcp__(?:ape|plugin_ape_ape)__ape_(run|status|config|history)$/;

function parseToolSurface(file) {
  const source = readFileSync(path.join(agentsDir, file), 'utf8');
  const match = source.match(/^---\n([\s\S]*?)\n---/);
  expect(match, `${file} has frontmatter`).toBeTruthy();
  const name = match[1].match(/^name:\s*(.+)$/m)?.[1]?.trim();
  const toolsLine = match[1].match(/^tools:\s*(.+)$/m)?.[1];
  const deniedLine = match[1].match(/^disallowedTools:\s*(.+)$/m)?.[1];
  expect(toolsLine, `${file} declares a tools: line`).toBeTruthy();
  expect(deniedLine, `${file} declares a disallowedTools: line`).toBeTruthy();
  const tools = toolsLine.split(',').map((token) => token.trim()).filter(Boolean);
  const disallowedTools = deniedLine.split(',').map((token) => token.trim()).filter(Boolean);
  return { name, tools, disallowedTools };
}

describe('APE v2 agent tool-surface allowlists', () => {
  const files = readdirSync(agentsDir).filter((file) => file.endsWith('.md'));

  it('covers all eleven agent manifests', () => {
    expect(files.length).toBe(11);
  });

  it.each(readdirSync(agentsDir).filter((file) => file.endsWith('.md')))(
    '%s exposes external MCP tools but denies the APE control plane and nested agents',
    (file) => {
      const { tools, disallowedTools } = parseToolSurface(file);
      expect(tools).not.toContain('Agent');
      expect(tools).not.toContain('Task');
      expect(tools).toContain(MCP_TOOL_PATTERN);
      expect(new Set(disallowedTools)).toEqual(new Set(DENIED));
      expect(disallowedTools.length).toBe(DENIED.length);
      for (const tool of disallowedTools) {
        expect(CONTROL_PLANE.test(tool), `${file}: ${tool} is not a control-plane tool`).toBe(true);
      }
    },
  );

  it.each(readdirSync(agentsDir).filter((file) => file.endsWith('.md')))(
    '%s grants exactly the role-appropriate tool set',
    (file) => {
      const { name, tools } = parseToolSurface(file);
      const expected = WRITERS.has(name)
        ? [...SAFE, ...WRITER_EXTRA, MCP_TOOL_PATTERN]
        : [...SAFE, MCP_TOOL_PATTERN];
      expect(new Set(tools)).toEqual(new Set(expected));
      // No duplicates and no tool outside the expected set.
      expect(tools.length).toBe(expected.length);
    },
  );
});
