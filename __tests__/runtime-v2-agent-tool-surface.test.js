import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SAFE_CLAUDE_SUBAGENT_TOOLS } from '../lib/runtime/hooks.js';

// Layer 2 (defense in depth) of control-plane ownership: the agents/*.md
// manifests expose inherited MCP tools directly to the host but use
// disallowedTools so an APE subagent can never reach the ape_* control plane,
// even when the policy hook is not installed or trusted. The receipt validator
// is named explicitly under both supported APE server ids: a broad `mcp__*`
// grant is not evidence that a deferred host actually provisions either exact
// schema. Agent/Task remain absent from the built-in allowlist. The runtime
// exports the shared built-in contract; this test pins both the canonical and
// packaged Claude frontmatter contracts.
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const agentsDir = path.join(root, 'agents');
const packagedAgentsDir = path.join(root, 'plugins', 'ape-claude', 'agents');

const SAFE = [...SAFE_CLAUDE_SUBAGENT_TOOLS];
const MCP_TOOL_PATTERN = 'mcp__*';
const RECEIPT_VALIDATORS = [
  'mcp__ape__ape_validate_receipt',
  'mcp__plugin_ape_ape__ape_validate_receipt',
];
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

function parseToolSurface(directory, file) {
  const source = readFileSync(path.join(directory, file), 'utf8');
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
  const packagedFiles = readdirSync(packagedAgentsDir).filter((file) => file.endsWith('.md'));

  it('covers all eleven canonical and packaged agent manifests', () => {
    expect(files.length).toBe(11);
    expect(packagedFiles.sort()).toEqual([...files].sort());
  });

  it.each([
    ...files.map((file) => ['canonical', agentsDir, file]),
    ...packagedFiles.map((file) => ['packaged', packagedAgentsDir, file]),
  ])(
    '%s %s exposes both exact receipt validators and external MCP tools while denying the APE control plane',
    (_source, directory, file) => {
      const { tools, disallowedTools } = parseToolSurface(directory, file);
      expect(tools).not.toContain('Agent');
      expect(tools).not.toContain('Task');
      expect(tools).toContain(MCP_TOOL_PATTERN);
      expect(tools).toEqual(expect.arrayContaining(RECEIPT_VALIDATORS));
      for (const validator of RECEIPT_VALIDATORS) {
        expect(disallowedTools, `${file}: ${validator} must remain worker-callable`).not.toContain(validator);
      }
      expect(new Set(disallowedTools)).toEqual(new Set(DENIED));
      expect(disallowedTools.length).toBe(DENIED.length);
      for (const tool of disallowedTools) {
        expect(CONTROL_PLANE.test(tool), `${file}: ${tool} is not a control-plane tool`).toBe(true);
      }
    },
  );

  it.each(files)(
    '%s grants exactly the role-appropriate canonical and packaged tool set',
    (file) => {
      const { name, tools } = parseToolSurface(agentsDir, file);
      const expected = WRITERS.has(name)
        ? [...SAFE, ...WRITER_EXTRA, ...RECEIPT_VALIDATORS, MCP_TOOL_PATTERN]
        : [...SAFE, ...RECEIPT_VALIDATORS, MCP_TOOL_PATTERN];
      expect(new Set(tools)).toEqual(new Set(expected));
      // No duplicates and no tool outside the expected set.
      expect(tools.length).toBe(expected.length);
      expect(parseToolSurface(packagedAgentsDir, file)).toEqual(
        parseToolSurface(agentsDir, file),
      );
    },
  );
});
