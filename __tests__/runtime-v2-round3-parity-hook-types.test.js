import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validateClaudePlugin } from '../lib/runtime/plugin-validation.js';

// Round-3 F13 parity: the official hook schema accepts FIVE handler types
// (command, prompt, agent, http, mcp_tool), each with type-specific required
// fields, across the full current lifecycle-event set. Every fixture below
// was calibrated against the installed `claude` CLI 2.1.201
// (`claude plugin validate [--strict]` on scratch plugins) and the official
// docs (https://code.claude.com/docs/en/hooks); where they could disagree,
// the CLI verdict wins and is noted inline. The CLI runs only from this test
// file — lib/runtime/ stays host-agnostic (invariant 6) — and the comparison
// block skips gracefully when the binary is absent.

const COMPLETE = { name: 'my-plugin', version: '1.0.0', description: 'd', author: { name: 'a' } };
const inline = (entry, event = 'PreToolUse') => ({
  manifest: { ...COMPLETE, hooks: { [event]: [{ hooks: [entry] }] } },
});
const hooksFile = (entry, event = 'PreToolUse') => ({
  manifest: { ...COMPLETE, hooks: './hooks/hooks.json' },
  files: { 'hooks/hooks.json': JSON.stringify({ hooks: { [event]: [{ hooks: [entry] }] } }) },
});
const ok = { pass: true, strictPass: true };
const bad = { pass: false, strictPass: false };

// Current official lifecycle events. All 30 passed the CLI 2.1.201 probe with
// a valid command entry; the docs list the same set.
const EVENTS = [
  'SessionStart', 'Setup', 'UserPromptSubmit', 'UserPromptExpansion', 'PreToolUse',
  'PermissionRequest', 'PermissionDenied', 'PostToolUse', 'PostToolUseFailure', 'PostToolBatch',
  'Notification', 'MessageDisplay', 'SubagentStart', 'SubagentStop', 'TaskCreated', 'TaskCompleted',
  'Stop', 'StopFailure', 'TeammateIdle', 'InstructionsLoaded', 'ConfigChange', 'CwdChanged',
  'FileChanged', 'WorktreeCreate', 'WorktreeRemove', 'PreCompact', 'PostCompact', 'Elicitation',
  'ElicitationResult', 'SessionEnd',
];

const FIXTURES = [
  // --- the verification memo's exact reproduction: an inline Stop prompt
  // hook. The official validator passes it in both modes.
  {
    id: 'memo-probe-inline-stop-prompt-hook',
    manifest: {
      ...COMPLETE,
      hooks: { Stop: [{ hooks: [{ type: 'prompt', prompt: 'Check completion: $ARGUMENTS' }] }] },
    },
    ...ok,
  },
  // --- command hooks ---
  { id: 'command-valid', ...inline({ type: 'command', command: 'node x.js' }), ...ok },
  { id: 'command-missing-command', ...inline({ type: 'command' }), ...bad },
  { id: 'command-nonstring-command', ...inline({ type: 'command', command: 5 }), ...bad },
  // CLI calibration: required fields only need to BE strings — an empty
  // command string passes the official validator in both modes.
  { id: 'command-empty-string', ...inline({ type: 'command', command: '' }), ...ok },
  {
    id: 'command-optional-fields',
    ...inline({
      type: 'command', command: 'node x.js', timeout: 5, async: true,
      statusMessage: 's', if: 'Bash(*)', shell: 'bash', once: true,
    }),
    ...ok,
  },
  // --- prompt hooks ---
  { id: 'prompt-valid', ...inline({ type: 'prompt', prompt: 'Review: $ARGUMENTS' }, 'Stop'), ...ok },
  { id: 'prompt-missing-prompt', ...inline({ type: 'prompt' }, 'Stop'), ...bad },
  { id: 'prompt-nonstring-prompt', ...inline({ type: 'prompt', prompt: 7 }, 'Stop'), ...bad },
  { id: 'prompt-with-model', ...inline({ type: 'prompt', prompt: 'p', model: 'claude-fable-5', timeout: 5 }, 'Stop'), ...ok },
  { id: 'prompt-in-hooks-file', ...hooksFile({ type: 'prompt', prompt: 'Check: $ARGUMENTS' }, 'Stop'), ...ok },
  // --- agent hooks (same required field as prompt) ---
  { id: 'agent-valid', ...inline({ type: 'agent', prompt: 'Verify the diff' }, 'Stop'), ...ok },
  { id: 'agent-missing-prompt', ...inline({ type: 'agent' }, 'Stop'), ...bad },
  { id: 'agent-in-hooks-file', ...hooksFile({ type: 'agent', prompt: 'Verify' }, 'Stop'), ...ok },
  // --- http hooks ---
  { id: 'http-valid', ...inline({ type: 'http', url: 'https://example.com/hook' }), ...ok },
  { id: 'http-missing-url', ...inline({ type: 'http' }), ...bad },
  { id: 'http-nonstring-url', ...inline({ type: 'http', url: 9 }), ...bad },
  // CLI calibration: unlike the other string fields, `url` must also PARSE as
  // a URL — "not a url" and "" fail, while any parseable scheme passes.
  { id: 'http-unparseable-url', ...inline({ type: 'http', url: 'not a url' }), ...bad },
  { id: 'http-empty-url', ...inline({ type: 'http', url: '' }), ...bad },
  { id: 'http-custom-scheme', ...inline({ type: 'http', url: 'myapp://do-thing' }), ...ok },
  { id: 'http-env-interpolation', ...inline({ type: 'http', url: 'https://${HOST}/hook' }), ...ok },
  { id: 'http-with-headers', ...inline({ type: 'http', url: 'https://example.com', headers: { 'X-A': 'b' }, allowedEnvVars: ['HOME'] }), ...ok },
  { id: 'http-in-hooks-file', ...hooksFile({ type: 'http', url: 'https://example.com/hook' }), ...ok },
  // --- mcp_tool hooks ---
  { id: 'mcp-tool-valid', ...inline({ type: 'mcp_tool', server: 'srv', tool: 'run' }), ...ok },
  { id: 'mcp-tool-missing-server', ...inline({ type: 'mcp_tool', tool: 'run' }), ...bad },
  { id: 'mcp-tool-missing-tool', ...inline({ type: 'mcp_tool', server: 'srv' }), ...bad },
  { id: 'mcp-tool-with-input', ...inline({ type: 'mcp_tool', server: 'srv', tool: 'run', input: { a: 1 } }), ...ok },
  { id: 'mcp-tool-in-hooks-file', ...hooksFile({ type: 'mcp_tool', server: 'srv', tool: 'run' }), ...ok },
  // --- type discrimination ---
  { id: 'unknown-type', ...inline({ type: 'weird', command: 'node x.js' }), ...bad },
  { id: 'missing-type', ...inline({ command: 'node x.js' }), ...bad },
  { id: 'missing-type-with-prompt', ...inline({ prompt: 'p' }, 'Stop'), ...bad },
  // --- lifecycle events: every current official event with a valid entry ---
  ...EVENTS.map((event) => ({
    id: `event-${event}`,
    ...inline({ type: 'command', command: 'node x.js' }, event),
    ...ok,
  })),
  { id: 'event-unknown', ...inline({ type: 'command', command: 'node x.js' }, 'NotAnEvent'), ...bad },
];

const dirs = new Map();
let root;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'ape-plugin-parity-r3-'));
  for (const fixture of FIXTURES) {
    const dir = path.join(root, fixture.id);
    await mkdir(path.join(dir, '.claude-plugin'), { recursive: true });
    await writeFile(path.join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify(fixture.manifest));
    for (const [file, content] of Object.entries(fixture.files ?? {})) {
      await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
      await writeFile(path.join(dir, file), content);
    }
    dirs.set(fixture.id, dir);
  }
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('in-process hook handler-type/event parity fixtures (F13 round 3)', () => {
  it.each(FIXTURES)('$id → pass=$pass strict=$strictPass', async (fixture) => {
    const relaxed = await validateClaudePlugin(dirs.get(fixture.id));
    expect(relaxed.passed, `errors: ${JSON.stringify(relaxed.errors)}`).toBe(fixture.pass);
    const strict = await validateClaudePlugin(dirs.get(fixture.id), { strict: true });
    expect(strict.passed, `errors: ${JSON.stringify(strict.errors)} warnings: ${JSON.stringify(strict.warnings)}`)
      .toBe(fixture.strictPass);
    // Strict mode only ever promotes warnings — it never flips a failure back.
    if (!fixture.pass) expect(fixture.strictPass).toBe(false);
  });
});

function officialValidatorAvailable() {
  try {
    execFileSync('claude', ['--version'], { stdio: 'ignore', timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
}

function officialVerdict(dir, { strict }) {
  try {
    execFileSync('claude', ['plugin', 'validate', '.', ...(strict ? ['--strict'] : [])], {
      cwd: dir,
      stdio: 'ignore',
      timeout: 60_000,
    });
    return true;
  } catch (error) {
    // A non-zero exit is the CLI's fail verdict; anything else (missing
    // binary mid-suite, timeout) must surface, not masquerade as a verdict.
    if (typeof error.status === 'number' && error.status !== 0) return false;
    throw error;
  }
}

// Keep the large vendor-process corpus out of ordinary developer/PR runs. The
// in-process fixtures above remain always-on; scheduled/manual calibration CI
// opts in and compares every case against the currently installed Claude CLI.
const CALIBRATE_OFFICIAL_CLAUDE = process.env.APE_CLAUDE_SCHEMA_CALIBRATION === '1';
describe.skipIf(!CALIBRATE_OFFICIAL_CLAUDE || !officialValidatorAvailable())('official `claude plugin validate` agrees (F13 round 3)', () => {
  it.concurrent.each(FIXTURES)('$id matches the official verdicts', async (fixture) => {
    const dir = dirs.get(fixture.id);
    expect(officialVerdict(dir, { strict: false }), 'official non-strict verdict').toBe(fixture.pass);
    expect(officialVerdict(dir, { strict: true }), 'official --strict verdict').toBe(fixture.strictPass);
  }, 120_000);
});
