import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validateClaudePlugin } from '../lib/runtime/plugin-validation.js';

// The real shipped Claude hooks file, read at module scope, routed through the
// validator as a parity fixture. This proves the narrowed matcher strings stay
// schema-valid to the host in BOTH modes (and, where the official `claude` CLI
// is installed, that the CLI agrees). Green-by-construction now and after the
// implementer narrows the two policy matchers — a matcher change never affects
// validation, which only requires the matcher to be a string.
const SHIPPED_CLAUDE_HOOKS = readFileSync(
  new URL('../hooks/claude-hooks.json', import.meta.url),
  'utf8',
);

// Parity fixtures: every fixture pins the expected verdict of the in-process
// validator in BOTH modes, and — when the official `claude` CLI is installed —
// asserts the official validator agrees fixture by fixture. The CLI runs only
// from this test file: lib/runtime/ stays host-agnostic (invariant 6) and the
// comparison suite skips gracefully on hosts without the binary.

const COMPLETE = { name: 'my-plugin', version: '1.0.0', description: 'd', author: { name: 'a' } };
const GOOD_EVENTS = { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'node x.js' }] }] };
const hooksFile = (manifestExtra, file) => ({
  manifest: { ...COMPLETE, hooks: './hooks/hooks.json', ...manifestExtra },
  files: { 'hooks/hooks.json': typeof file === 'string' ? file : JSON.stringify(file) },
});

const FIXTURES = [
  { id: 'minimal-name-only', manifest: { name: 'my-plugin' }, pass: true, strictPass: false },
  { id: 'complete-manifest', manifest: COMPLETE, pass: true, strictPass: true },
  { id: 'unknown-top-level-field', manifest: { ...COMPLETE, bogusField: true }, pass: true, strictPass: false },
  { id: 'invalid-name', manifest: { ...COMPLETE, name: 'Bad Name' }, pass: false, strictPass: false },
  { id: 'author-missing-name', manifest: { ...COMPLETE, author: {} }, pass: false, strictPass: false },
  { id: 'inline-mcp-servers', manifest: { ...COMPLETE, mcpServers: { srv: { command: 'node', args: [] } } }, pass: true, strictPass: true },
  { id: 'hooks-file-valid', ...hooksFile({}, { hooks: GOOD_EVENTS }), pass: true, strictPass: true },
  {
    id: 'shipped-claude-hooks-file',
    manifest: { ...COMPLETE, hooks: './hooks/claude-hooks.json' },
    files: { 'hooks/claude-hooks.json': SHIPPED_CLAUDE_HOOKS },
    pass: true,
    strictPass: true,
  },
  { id: 'hooks-file-unknown-event', ...hooksFile({}, { hooks: { NotAnEvent: GOOD_EVENTS.PreToolUse } }), pass: false, strictPass: false },
  {
    id: 'hooks-file-entry-missing-command',
    ...hooksFile({}, { hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command' }] }] } }),
    pass: false,
    strictPass: false,
  },
  {
    id: 'hooks-file-entry-invalid-type',
    ...hooksFile({}, { hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'weird', command: 'node x.js' }] }] } }),
    pass: false,
    strictPass: false,
  },
  {
    id: 'hooks-file-matcher-not-string',
    ...hooksFile({}, { hooks: { PreToolUse: [{ matcher: 5, hooks: GOOD_EVENTS.PreToolUse[0].hooks }] } }),
    pass: false,
    strictPass: false,
  },
  { id: 'hooks-file-event-not-array', ...hooksFile({}, { hooks: { PreToolUse: { matcher: '*' } } }), pass: false, strictPass: false },
  { id: 'hooks-file-missing-wrapper', ...hooksFile({}, GOOD_EVENTS), pass: false, strictPass: false },
  { id: 'hooks-file-invalid-json', ...hooksFile({}, 'not json'), pass: false, strictPass: false },
  { id: 'hooks-file-path-missing', manifest: { ...COMPLETE, hooks: './hooks/missing.json' }, pass: false, strictPass: false },
  // Inline manifest hooks are the BARE event map; wrapping them like a hooks
  // file does is invalid in both validators.
  { id: 'hooks-inline-event-map', manifest: { ...COMPLETE, hooks: GOOD_EVENTS }, pass: true, strictPass: true },
  { id: 'hooks-inline-wrapped', manifest: { ...COMPLETE, hooks: { hooks: GOOD_EVENTS } }, pass: false, strictPass: false },
];

const dirs = new Map();
let root;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'ape-plugin-parity-'));
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

describe('in-process Claude plugin validator parity fixtures (F13)', () => {
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

// The complete official-CLI corpus is intentionally an explicit calibration:
// it starts one vendor process per fixture/mode and added ~39s to every local
// suite whenever Claude happened to be installed. The in-process fixtures
// above remain the always-on structural contract; scheduled/manual CI sets
// this opt-in to detect upstream schema drift.
const CALIBRATE_OFFICIAL_CLAUDE = process.env.APE_CLAUDE_SCHEMA_CALIBRATION === '1';
describe.skipIf(!CALIBRATE_OFFICIAL_CLAUDE || !officialValidatorAvailable())('official `claude plugin validate` agrees (F13)', () => {
  it.concurrent.each(FIXTURES)('$id matches the official verdicts', async (fixture) => {
    const dir = dirs.get(fixture.id);
    expect(officialVerdict(dir, { strict: false }), 'official non-strict verdict').toBe(fixture.pass);
    expect(officialVerdict(dir, { strict: true }), 'official --strict verdict').toBe(fixture.strictPass);
  }, 120_000);
});
