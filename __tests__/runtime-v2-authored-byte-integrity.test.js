import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { runtimePaths } from '../lib/runtime/paths.js';
import { currentTreeSha } from '../lib/runtime/git.js';
import { atomicWriteJson } from '../lib/runtime/storage.js';
// Two imports here, for two separate, deliberate exceptions to this file's
// own "drive the real binary" rule below (stated in full ahead of the first
// describe block).
//
// WRITE_CONTENT_UNREACHABLE_TOOLS: reading one exported, structural residual
// Set (never calling into evaluateWriteContentPolicy or any other behavioral
// export through THIS import alone) does not conflict with the binary-driving
// rule: that rule is about PROVING the gate's decision, and the enumeration
// arm beneath the over-block guards proves only that the population is
// derived from source, never a tool's actual allow/deny.
//
// evaluateWriteContentPolicy: called directly, at unit level, by exactly the
// two apply_patch arms below (the bare-string and bounded-command-array
// coverage a blocking review found missing for this run's F and G fixes).
// Those two arms stay unit-level for isolation, never because the binary
// cannot reach either shape: bin/ape-hook.mjs's write-content precompute
// runs for EVERY bound-ticket event regardless of whether a path field is
// present (content is orthogonal to path -- see that precompute's own
// comment in bin/ape-hook.mjs). G's own shape (a `command` array or string)
// carries its path opinion on the SAME tool_input object the route also
// scans for a hazard, so a caller that adds a recognized path field there
// reaches this route and is judged on it. F's own shape is a tool_input that
// IS ITSELF a bare string, which carries no fields of its own at all, so its
// only path opinion can come from extractPath's separate, top-level
// `input.file_path` fallback riding beside the string, never paired
// "alongside" inside it. The "bin/ape-hook.mjs actually reaches the
// apply_patch route" describe block below drives the real binary end to end
// for G's combined-shape proof and for F's top-level-fallback proof, so
// reach is SHOWN there rather than merely asserted here. What actually dies
// earlier, for want of a path, is only a call with NO recognized path field
// anywhere (denied at hooks.js's `if (!event.file) return deny`) or one
// whose target resolves outside the project (allowed before the verdict is
// ever consumed) -- neither is F or G's own shape, which carries no path
// opinion at all until a caller adds one. These two unit arms remain useful
// beyond that binary coverage: they isolate evaluateWriteContentPolicy's
// pure decision directly, with no ticket, project fixture, or child process
// needed, and stay the most direct regression fixture for the function's own
// hazard-detection (F) and array-bounding (G) behavior.
import { WRITE_CONTENT_UNREACHABLE_TOOLS, evaluateWriteContentPolicy } from '../lib/runtime/hooks.js';

// ===========================================================================
// CONTRACT SUITE for roadmap entry authored-and-agent-facing-byte-integrity,
// WRITE-SIDE half (absorbing hook-enforcement-and-authored-byte-integrity /
// escape-decoded-control-bytes-in-authored-source). The READ side of the
// combined entry -- extractTestRemediation's TEST_REMEDIATION_CONTROL_CHARS/
// TEST_REMEDIATION_RENDER_CHARS (pipeline.js), the test_writer changed_files
// route recorded as runtime-derived, shipping_watch.last_checks_summary
// bounded at assignment, boundedSerialize's neutralization, and the
// scope-expansion refusal's bounded `shown` -- is ALREADY CLOSED on this tree
// (PRs #397-#400) and is deliberately NOT re-tested here: this file covers
// only what remained open, the WRITE side.
//
// THE GAP. bin/ape-hook.mjs (normalizeLifecycleEvent, extractPath) inspects
// only `event.file` (a path) and `event.command` (a Bash string) for the
// write-tool gate; it never reads the CONTENT a Write/Edit/MultiEdit/
// NotebookEdit call carries, so a decoded control/bidi/format code point in
// that content reaches tracked source untouched by any gate that "believes it
// is inspecting a safe operation" (the hook epic's own framing). The four
// content-bearing routes named by the run objective:
//   Write.content            Edit.new_string
//   MultiEdit.edits[].new_string   NotebookEdit.new_source
// A fifth, Bash heredoc content, is a route this channel structurally cannot
// see (bin/ape-hook.mjs never reads a Bash payload's stdin/heredoc body) and
// is recorded as such rather than silently unguarded -- the implementer
// records the reason at its own site per the run objective; there is nothing
// for a black-box test of the hook's JSON contract to assert about a channel
// it never receives.
//
// EACH ARM DRIVES THE REAL bin/ape-hook.mjs BINARY end to end (never a unit
// call into evaluateLifecyclePolicy in isolation), because the shape under
// test is bin/ape-hook.mjs's own JSON stdin/stdout contract: whether a
// specific tool_input FIELD reaches the policy at all. A bound identity is
// established through the host-neutral ticket_id binding channel (the same
// one a Codex write uses, and the one lib/runtime/hooks.js documents as
// "stateless... binds on the event ticket_id alone") rather than the fuller
// Claude SubagentStart handshake, since the byte-content gate is orthogonal
// to which handshake bound the ticket.
//
// AUTHORING HAZARD (run objective, stated three times over this task): this
// file's own bytes must never carry a literal control/bidi/format code
// point. Every hazard byte below is built with
// String.fromCharCode/String.fromCodePoint (never fromCharCode for an astral
// member -- the TAGS block sits above U+FFFF and needs fromCodePoint to
// synthesize correctly), never a literal character or a `\u` escape in the
// source text.
// ===========================================================================

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const hookBinary = path.join(root, 'bin', 'ape-hook.mjs');
const cleanups = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

// A running project with exactly one bound, writable implementer ticket
// claiming src/allowed.js, bound through the host-neutral ticket_id channel
// (event.host !== 'claude', so bin/ape-hook.mjs resolves the ticket straight
// from state.tickets by ticket_id -- no SubagentStart handshake needed).
async function boundProject() {
  const base = await mkdtemp(path.join(tmpdir(), 'ape-byte-integrity-'));
  cleanups.push(base);
  const dir = path.join(base, 'proj');
  await mkdir(path.join(dir, 'src'), { recursive: true });
  await writeFile(path.join(dir, 'src', 'allowed.js'), 'export const value = 1;\n');
  await mkdir(path.join(dir, 'notebooks'), { recursive: true });
  await writeFile(path.join(dir, 'notebooks', 'nb.ipynb'), '{}\n');
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'ape@example.test');
  git(dir, 'config', 'user.name', 'APE Test');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'test: baseline');
  const baseline = await currentTreeSha(dir);
  const ticket = {
    ticket_id: 'run-byte-integrity-1:build:t1',
    stage_id: 'build',
    role: 'implementer',
    writable: true,
    claimed_paths: ['src/allowed.js', 'notebooks/nb.ipynb'],
    test_paths: [],
    base_tree_sha: baseline,
  };
  await atomicWriteJson(runtimePaths(dir).active, {
    run_id: 'run-byte-integrity-1',
    status: 'running',
    tree_sha: baseline,
    tickets: [ticket],
    receipts: [],
  });
  return { dir, ticket };
}

// Force the codex host shape (no CLAUDECODE) so bin/ape-hook.mjs resolves the
// bound ticket via the host-neutral `event.ticket_id` channel rather than a
// Claude SubagentStart binding record.
function codexEnv() {
  const env = { ...process.env };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE;
  delete env.CLAUDE_PROJECT_DIR;
  delete env.CODEX_CWD;
  return env;
}

function decision(resp) {
  return resp.decision ?? (resp.hookSpecificOutput?.permissionDecision === 'allow' ? 'allow'
    : resp.hookSpecificOutput?.permissionDecision === 'deny' ? 'deny'
      : 'allow');
}
function denyReason(resp) {
  return resp.reason ?? resp.hookSpecificOutput?.permissionDecisionReason ?? '';
}

async function runHook(input, dir) {
  const child = spawn(process.execPath, [hookBinary], {
    cwd: dir,
    env: codexEnv(),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin.end(Buffer.from(`${JSON.stringify(input)}\n`, 'utf8'));
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (c) => { stdout += c; });
  child.stderr.on('data', (c) => { stderr += c; });
  const code = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  if (code !== 0) throw new Error(stderr || `hook exited ${code}`);
  return JSON.parse(stdout);
}

// U+202E RIGHT-TO-LEFT OVERRIDE, built numerically per the authoring hazard.
const RLO = String.fromCharCode(0x202e);

// `project_dir` is set EXPLICITLY (never left to the hook's own process.cwd()
// walk) so this event's resolved project root is textually identical to the
// literal `dir` string `boundProject()` used to build the target path: on
// macOS `os.tmpdir()`'s `/var/folders/...` spelling and the child's own
// `process.cwd()` after chdir can resolve through the `/var` -> `/private/var`
// symlink differently, which would make an otherwise-correct in-claims write
// look like it escapes the project. Pinning the explicit dir removes that
// variable so every assertion below is about the byte-content gate alone.
function preToolUse(ticket, toolName, toolInput, dir) {
  return {
    hook_event_name: 'PreToolUse',
    session_id: 's1',
    project_dir: dir,
    ticket_id: ticket.ticket_id,
    is_subagent: true,
    tool_name: toolName,
    tool_input: toolInput,
  };
}

describe('bin/ape-hook.mjs refuses decoded control/bidi bytes in write-tool CONTENT (write side of authored-and-agent-facing-byte-integrity)', () => {
  it('denies a Write whose content decodes to a bidi override, naming the decoded code point', async () => {
    const { dir, ticket } = await boundProject();
    const input = preToolUse(ticket, 'Write', {
      file_path: path.join(dir, 'src', 'allowed.js'),
      content: `export const value = '${RLO}evil';\n`,
    }, dir);
    const response = await runHook(input, dir);
    expect(decision(response)).toBe('deny');
    expect(denyReason(response)).toMatch(/U\+202E/);
  });

  it('denies an Edit whose new_string decodes to a bidi override', async () => {
    const { dir, ticket } = await boundProject();
    const input = preToolUse(ticket, 'Edit', {
      file_path: path.join(dir, 'src', 'allowed.js'),
      old_string: 'export const value = 1;\n',
      new_string: `export const value = '${RLO}1';\n`,
    }, dir);
    const response = await runHook(input, dir);
    expect(decision(response)).toBe('deny');
    expect(denyReason(response)).toMatch(/U\+202E/);
  });

  it('denies a MultiEdit whose SECOND edits[].new_string decodes to a bidi override (every edit is checked, not only the first)', async () => {
    const { dir, ticket } = await boundProject();
    const input = preToolUse(ticket, 'MultiEdit', {
      file_path: path.join(dir, 'src', 'allowed.js'),
      edits: [
        { old_string: 'export const value = 1;\n', new_string: 'export const value = 2;\n' },
        { old_string: 'value', new_string: `va${RLO}lue` },
      ],
    }, dir);
    const response = await runHook(input, dir);
    expect(decision(response)).toBe('deny');
    expect(denyReason(response)).toMatch(/U\+202E/);
  });

  it('denies a NotebookEdit whose new_source decodes to a bidi override', async () => {
    const { dir, ticket } = await boundProject();
    const input = preToolUse(ticket, 'NotebookEdit', {
      file_path: path.join(dir, 'notebooks', 'nb.ipynb'),
      cell_id: 'c1',
      new_source: `print('${RLO}evil')`,
    }, dir);
    const response = await runHook(input, dir);
    expect(decision(response)).toBe('deny');
    expect(denyReason(response)).toMatch(/U\+202E/);
  });

  // This run's own restore made the write-content gate itself refuse
  // U+2028: lib/runtime/hooks.js's WRITE_CONTENT_HAZARD_CHARS now includes
  // 0x2028-0x2029 alongside U+FEFF and the TAGS block, and bin/ape-hook.mjs
  // (which this arm spawns as a real subprocess) imports evaluateWriteContentPolicy
  // straight from that source module, so this is no longer a proof of a
  // future change -- it is a proof of what the SHIPPED gate does today. This
  // arm drives the real bin/ape-hook.mjs binary end to end, the same idiom
  // every other arm in this describe uses, so the denial is SHOWN rather
  // than assumed. A RED here is not an expected, forward-looking state: it
  // is a real regression in the write-content gate, and must be
  // root-caused and fixed, never dismissed.
  it('denies a Write whose content decodes to U+2028 LINE SEPARATOR, an ECMAScript LineTerminator the byte gate must also refuse', async () => {
    const { dir, ticket } = await boundProject();
    const lineSeparator = String.fromCharCode(0x2028);
    const input = preToolUse(ticket, 'Write', {
      file_path: path.join(dir, 'src', 'allowed.js'),
      content: `// ordinary comment${lineSeparator}maliciousCall();\n`,
    }, dir);
    const response = await runHook(input, dir);
    expect(decision(response)).toBe('deny');
    expect(denyReason(response)).toMatch(/U\+2028/);
  });
});

describe('the write-content gate over-block guards: ordinary content stays admitted', () => {
  it('admits an ordinary ASCII Write with no hazard byte', async () => {
    const { dir, ticket } = await boundProject();
    const input = preToolUse(ticket, 'Write', {
      file_path: path.join(dir, 'src', 'allowed.js'),
      content: 'export const value = 2;\n',
    }, dir);
    const response = await runHook(input, dir);
    expect(decision(response)).toBe('allow');
  });

  it('admits accented and CJK content, which this project deliberately keeps writable everywhere else', async () => {
    const { dir, ticket } = await boundProject();
    const input = preToolUse(ticket, 'Write', {
      file_path: path.join(dir, 'src', 'allowed.js'),
      content: "export const label = 'café 日本語';\n",
    }, dir);
    const response = await runHook(input, dir);
    expect(decision(response)).toBe('allow');
  });

  it('admits the U+200C/U+200D (ZWNJ/ZWJ) pair, which the read-side character policy also deliberately exempts', async () => {
    const { dir, ticket } = await boundProject();
    const zwnj = String.fromCharCode(0x200c);
    const zwj = String.fromCharCode(0x200d);
    const input = preToolUse(ticket, 'Edit', {
      file_path: path.join(dir, 'src', 'allowed.js'),
      old_string: 'export const value = 1;\n',
      new_string: `export const value = 'jo${zwnj}in${zwj}ed';\n`,
    }, dir);
    const response = await runHook(input, dir);
    expect(decision(response)).toBe('allow');
  });

  it('admits an ordinary multi-line Edit shaped like a real production edit (comments, punctuation, a regex literal)', async () => {
    const { dir, ticket } = await boundProject();
    const input = preToolUse(ticket, 'Edit', {
      file_path: path.join(dir, 'src', 'allowed.js'),
      old_string: 'export const value = 1;\n',
      new_string: [
        '// A realistic production edit: a comment, a regex, and punctuation.',
        "const PATTERN = /[a-z]+-\\d+/;",
        'export const value = PATTERN.test("x-1") ? 1 : 0;',
        '',
      ].join('\n'),
    }, dir);
    const response = await runHook(input, dir);
    expect(decision(response)).toBe('allow');
  });

  it('a bound subagent reading its own ticket file is unaffected (Read is not a write tool and carries no content field)', async () => {
    const { dir, ticket } = await boundProject();
    const ticketPath = path.join(
      runtimePaths(dir).tickets,
      `${ticket.ticket_id.replaceAll(':', '_')}.json`,
    );
    await mkdir(runtimePaths(dir).tickets, { recursive: true });
    await writeFile(ticketPath, JSON.stringify(ticket));
    const input = preToolUse(ticket, 'Read', { file_path: ticketPath }, dir);
    const response = await runHook(input, dir);
    expect(decision(response)).toBe('allow');
  });
});

// ===========================================================================
// APPLY_PATCH UNIT-LEVEL ARMS (review findings 1 and 2; the run objective's
// defects F and G). Unlike every other arm above, these two call
// evaluateWriteContentPolicy DIRECTLY rather than driving bin/ape-hook.mjs as
// a real subprocess -- a deliberate, recorded exception to this file's own
// "drive the real binary" rule (see the import comment above), but not
// because the binary cannot reach either shape: the "bin/ape-hook.mjs
// actually reaches the apply_patch route" describe block below drives the
// real binary end to end for both shapes -- G's bounded-command-array shape
// paired with a recognized path field on the SAME tool_input the route also
// scans for a hazard, and F's bare-string shape paired with a recognized
// path field at extractPath's separate, top-level `input.file_path`
// fallback, since a bare string carries no field of its own to pair one
// alongside -- and both are SHOWN reaching and being judged by this route
// there. These two arms stay unit-level because isolating
// evaluateWriteContentPolicy directly -- no ticket, project fixture or child
// process needed -- is the most direct regression fixture for the function's
// own hazard-detection (F) and array-bounding (G) behavior, not because it
// is the only surface either fix can be observed from.
// ===========================================================================
describe('evaluateWriteContentPolicy: apply_patch shapes F and G harden (unit-level for isolation -- see the note above; the binary-driven reach proof is the describe block below)', () => {
  it('defect F: an apply_patch tool_input that is ITSELF a string (not nested under input/patch/command) is scanned and refused when it decodes to a bidi override', () => {
    const result = evaluateWriteContentPolicy('apply_patch', `a${RLO}b`);
    expect(result.safe).toBe(false);
    expect(result.reason).toMatch(/U\+202E/);
  });

  it('defect G: a caller-supplied apply_patch command array of 200,000 elements does not RangeError (bounded for-of, never Array#push(...spread))', () => {
    // 200,000 is not an arbitrary round number: verified directly against
    // this engine (Node) that `[].push(...Array.from({ length: 200_000 }))`
    // throws `RangeError: Maximum call stack size exceeded` -- the exact
    // failure the OLD `candidates.push(...input.command)` shape produced --
    // while a bounded for-of over the same array does not. Reproduced here
    // ONLY as a local demonstration that this size genuinely exercises the
    // engine's spread-argument limit; never a copy of, or import from,
    // hooks.js's own (already-fixed) implementation.
    const command = Array.from({ length: 200_000 }, () => 'x');
    expect(() => { [].push(...command); }).toThrow(RangeError);
    expect(() => evaluateWriteContentPolicy('apply_patch', { command })).not.toThrow();
  });
});

// ===========================================================================
// ENUMERATION ARM (review findings 2 and 3; the run objective's ENUMERATION
// BAR). The four hand-written arms in the "bin/ape-hook.mjs refuses decoded
// control/bidi bytes in write-tool CONTENT" describe block above (the Write,
// Edit, MultiEdit and NotebookEdit bidi-override arms; named rather than
// line-numbered here, since a numeric range drifts the moment an earlier arm
// is added, exactly the defect class review finding 6 caught in this same
// file) each hard-code ONE WRITE_TOOLS member; none of them DERIVES the
// population from source, so a fifth write tool can ship with no content
// route and no test ever notices.
// This arm follows the SAME idiom
// __tests__/runtime-v2-hook-matcher-coverage.test.js:70-74 already uses for
// the identical `const WRITE_TOOLS = new Set([...])` literal: extract the
// population out of lib/runtime/hooks.js's own source text (module-private,
// unexported — source extraction is a deliberate tripwire on a declaration
// reshape too), then require every member to be EITHER named by a `tool:`
// entry of the also-source-extracted WRITE_CONTENT_ROUTES table OR a member
// of the exported, frozen WRITE_CONTENT_UNREACHABLE_TOOLS Set — matched with
// Set#has, never a substring test against prose, so a future WRITE_TOOLS
// member that happens to be a substring of some unrelated sentence can never
// be rubber-stamped as covered — so a member with neither reddens this arm
// by NAMING ITSELF, rather than shipping silently. WRITE_TOOLS' fifth
// member, apply_patch, IS routed by this SAME diff's own WRITE_CONTENT_ROUTES
// entry — its tool_input shape is recorded DERIVED-NOT-VERIFIED, since
// apply_patch carries no first-party schema this repo can check the inferred
// field name against — so this arm is GREEN on this tree, not surfacing a
// gap. What this arm actually proves going forward: a SIXTH write tool
// shipped with neither a route nor membership in
// WRITE_CONTENT_UNREACHABLE_TOOLS reddens here by naming itself, the day it
// appears — never today's five.
// ===========================================================================
const hooksSourceText = readFileSync(path.join(root, 'lib', 'runtime', 'hooks.js'), 'utf8');

function extractQuotedNames(source, pattern) {
  const match = source.match(pattern);
  if (!match) return null;
  return [...match[1].matchAll(/['"]([^'"]+)['"]/g)].map((entry) => entry[1]);
}

const DERIVED_WRITE_TOOLS = extractQuotedNames(
  hooksSourceText,
  /const WRITE_TOOLS = new Set\(\[([\s\S]*?)\]\)/,
);
// Scoped to the WRITE_CONTENT_ROUTES declaration alone (never the whole
// 2,000+ line module) so a `tool:` key belonging to some unrelated object
// elsewhere in the file can never be mistaken for a route.
const writeContentRoutesBlock = hooksSourceText.match(
  /const WRITE_CONTENT_ROUTES = Object\.freeze\(\[([\s\S]*?)\n\]\);/,
);
const DERIVED_ROUTED_TOOLS = writeContentRoutesBlock
  ? [...writeContentRoutesBlock[1].matchAll(/tool:\s*['"]([^'"]+)['"]/g)].map((entry) => entry[1])
  : null;

describe('write-content route population is derived from WRITE_TOOLS source, with no silent gap (review findings 2 and 3)', () => {
  it('extracts a non-empty WRITE_TOOLS population from lib/runtime/hooks.js source', () => {
    expect(
      DERIVED_WRITE_TOOLS,
      'const WRITE_TOOLS = new Set([...]) literal not found in lib/runtime/hooks.js',
    ).not.toBeNull();
    expect(DERIVED_WRITE_TOOLS.length).toBeGreaterThan(0);
    expect(DERIVED_WRITE_TOOLS).toContain('Write');
    expect(DERIVED_WRITE_TOOLS).toContain('Edit');
    expect(DERIVED_WRITE_TOOLS).toContain('MultiEdit');
    expect(DERIVED_WRITE_TOOLS).toContain('NotebookEdit');
    expect(DERIVED_WRITE_TOOLS).toContain('apply_patch');
  });

  it('extracts a non-empty WRITE_CONTENT_ROUTES tool population from lib/runtime/hooks.js source', () => {
    expect(
      DERIVED_ROUTED_TOOLS,
      'const WRITE_CONTENT_ROUTES = Object.freeze([...]) literal not found in lib/runtime/hooks.js',
    ).not.toBeNull();
    expect(DERIVED_ROUTED_TOOLS.length).toBeGreaterThan(0);
  });

  it('every WRITE_TOOLS member is either routed through WRITE_CONTENT_ROUTES or a member of the exported WRITE_CONTENT_UNREACHABLE_TOOLS Set, so a NEW member reddens here instead of shipping silently', () => {
    const routed = DERIVED_ROUTED_TOOLS ?? [];
    const uncovered = (DERIVED_WRITE_TOOLS ?? []).filter(
      (tool) => !routed.includes(tool) && !WRITE_CONTENT_UNREACHABLE_TOOLS.has(tool),
    );
    expect(
      uncovered,
      `WRITE_TOOLS member(s) with neither a WRITE_CONTENT_ROUTES entry nor membership in ` +
        `WRITE_CONTENT_UNREACHABLE_TOOLS: ${uncovered.join(', ')}`,
    ).toEqual([]);
  });
});

// ===========================================================================
// APPLY_PATCH ROUTE REACH, PROVEN END TO END (residual R1, roadmap entry
// doc-and-comment-accuracy-sweep). The REACH comment on hooks.js's
// WRITE_CONTENT_ROUTES apply_patch entry, and docs/hooks.md's matching
// prose, used to claim this route was unreachable for every shape it
// enumerates, because a path-less call dies earlier for want of a path
// field. That was false: bin/ape-hook.mjs's write-content precompute runs
// for EVERY bound-ticket event regardless of whether a path field is present
// (see the import comment above). G's own shape carries its path opinion on
// the SAME tool_input object the route also scans for a hazard, so a caller
// that adds a recognized path field ALONGSIDE the hazard-bearing `command`
// field reaches this route and is judged on it, exactly like every other
// routed tool above. F's own shape is a tool_input that IS ITSELF a bare
// string, which has no fields of its own to carry a path opinion alongside;
// extractPath's separate, top-level `input.file_path` fallback is the ONLY
// way a caller supplies one for that shape. The three arms below drive the
// real bin/ape-hook.mjs binary end to end: once for the pre-existing
// object-shaped `input?.patch` candidate, once for F's genuine bare-string
// tool_input paired with that top-level fallback, and once for G's bounded
// command array, so reach is SHOWN here rather than merely asserted in a
// comment.
// ===========================================================================
describe('bin/ape-hook.mjs actually reaches the apply_patch WRITE_CONTENT_ROUTES entry end to end for every tool_input shape that supplies a recognized path, alongside or at the top-level fallback', () => {
  it('denies an apply_patch call whose tool_input carries a recognized file_path beside a hazard-bearing patch field (the pre-existing object-shaped `input?.patch` candidate, reached and judged, never denied earlier for want of a path)', async () => {
    const { dir, ticket } = await boundProject();
    const input = preToolUse(ticket, 'apply_patch', {
      file_path: path.join(dir, 'src', 'allowed.js'),
      patch: `a${RLO}b`,
    }, dir);
    const response = await runHook(input, dir);
    expect(decision(response)).toBe('deny');
    expect(denyReason(response)).toMatch(/U\+202E/);
  });

  it("denies an apply_patch call whose tool_input is ITSELF a hazard-bearing bare string, with the recognized path riding at the top-level input.file_path fallback beside it rather than nested inside the string (defect F's actual bare-string shape, reached through extractPath's fourth candidate and judged, never denied earlier for want of a path)", async () => {
    const { dir, ticket } = await boundProject();
    const input = {
      ...preToolUse(ticket, 'apply_patch', `a${RLO}b`, dir),
      file_path: path.join(dir, 'src', 'allowed.js'),
    };
    const response = await runHook(input, dir);
    expect(decision(response)).toBe('deny');
    expect(denyReason(response)).toMatch(/U\+202E/);
  });

  it("admits, without throwing, an apply_patch call whose tool_input carries a recognized file_path beside a 200,000-element command array (defect G's shape, reached end to end through the real binary)", async () => {
    const { dir, ticket } = await boundProject();
    const command = Array.from({ length: 200_000 }, () => 'x');
    const input = preToolUse(ticket, 'apply_patch', {
      file_path: path.join(dir, 'src', 'allowed.js'),
      command,
    }, dir);
    const response = await runHook(input, dir);
    expect(decision(response)).toBe('allow');
  });
});

// ===========================================================================
// R1 SOURCE TEXT, THE OTHER HALF OF THE SAME TWO-DIRECTIONAL PROOF (the live
// binary-driven half is the describe block directly above -- the same shape
// __tests__/runtime-v2-character-policy-divergence.test.js already uses).
// hooks.js's REACH comment and docs/hooks.md's matching prose must no longer
// claim this route is unreachable/dead. This WAS genuinely red when this
// suite was first authored -- unlike every GREEN-on-arrival arm elsewhere in
// this file, because this run changed no production BEHAVIOR, only text, and
// the false text had not yet been corrected at that point. hooks.js and
// docs/hooks.md are corrected on this tree, so both checks below pass now.
// Both checks below are scoped to the specific comment block/doc paragraph
// the false claim lived in, never the whole file or document, so an
// unrelated, legitimate use of `input.file_path` elsewhere in the same file
// (extractPath's own implementation) can never be mistaken for this section
// recording the fallback.
// ===========================================================================
function flattenProse(text) {
  return text
    .split('\n')
    .map((line) => line.replace(/^\s*\/\/[ \t]?/, ''))
    .join(' ')
    .replace(/\s+/g, ' ');
}

function extractBetween(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker);
  if (start === -1) return null;
  const end = text.indexOf(endMarker, start);
  if (end === -1) return null;
  return text.slice(start, end);
}

describe('hooks.js and docs/hooks.md no longer claim the apply_patch route is unreachable/dead (R1 source text)', () => {
  it('hooks.js\'s REACH comment on the apply_patch route no longer claims it is denied earlier, before the extractor ever runs, for want of a recognized path field', () => {
    const reachComment = extractBetween(
      hooksSourceText,
      '// REACH, recorded rather than implied:',
      'Object.freeze({',
    );
    expect(reachComment, "hooks.js's REACH comment on the apply_patch route was not found").not.toBeNull();
    const text = flattenProse(reachComment);
    expect(text).not.toMatch(/before this extractor ever runs/);
    expect(text).not.toMatch(/for want of a recognized path field/);
    expect(
      text,
      'must record the top-level input.file_path fallback extractPath also reads',
    ).toMatch(/input\.file_path/);
  });

  it('docs/hooks.md\'s Routed tools section no longer claims the apply_patch route is currently unreachable or "not a defect to fix"', () => {
    const docsText = readFileSync(path.join(root, 'docs', 'hooks.md'), 'utf8');
    const routedToolsSection = extractBetween(
      docsText,
      '**Routed tools.**',
      '**Residual: Bash heredoc content is not covered.**',
    );
    expect(routedToolsSection, "docs/hooks.md's Routed tools section was not found").not.toBeNull();
    const text = flattenProse(routedToolsSection);
    expect(text).not.toMatch(/currently UNREACHABLE/i);
    expect(text).not.toMatch(/not treated as a defect to fix/i);
    expect(
      text,
      'must record the top-level input.file_path fallback extractPath also reads',
    ).toMatch(/input\.file_path/);
  });
});

// ===========================================================================
// TRACKED-SOURCE SCAN GUARD for roadmap entry
// escape-decoded-control-bytes-in-authored-source: a behavioral guard that
// fails LOUDLY when tracked source under lib/, bin/, scripts/ or __tests__/
// carries a decoded C0 control character (other than tab/newline/CR),
// DEL/C1, or bidi/format code point. Per the red-phase-arms lesson (roadmap
// entry red-phase-arms-that-invert-when-the-defect-is-fixed), the DETECTOR is
// asserted against a STAGED SYNTHETIC tree with the byte deliberately planted
// -- SHOWN, not merely asserted -- and only the post-fix INVARIANT (no such
// byte survives) is asserted against the live tree. A scan of tracked source
// for decoded control bytes is GREEN today (no such byte is currently
// tracked), so asserting that it is RED would be the exact self-contradiction
// that has twice terminally blocked a run in this task; the genuine red this
// file provides is the write-side hook gate above.
// ===========================================================================
const SCAN_DIRS = ['lib', 'bin', 'scripts', '__tests__'];

// Never tab (0x09), newline (0x0a) or CR (0x0d): every other C0 control
// character, DEL/C1 (0x7f-0x9f), and the bidi/format ranges this task's other
// suites already recognize (soft hyphen, arabic letter mark, the zero-width
// run minus the ZWNJ/ZWJ exemption is NOT applied here -- this guard is about
// SOURCE BYTES, not agent-facing prose, so U+200C/U+200D are flagged too: a
// legitimately-named joining sequence has no reason to appear inside this
// project's own .js source text).
//
// WIDENED, by this run's restore: the ranges above used to mirror the
// write-content gate's own class exactly, which meant this scanner shared
// the gate's blind spot rather than backstopping it. This run widened BOTH
// registries together: the write-content gate (the hook-driven arm above, in
// the first describe block) now refuses U+2028/U+2029 (both ECMAScript
// LineTerminators: a payload placed after one terminates a `//` comment and
// EXECUTES, while `git diff` and a terminal still render one comment line)
// and the invisible-text smuggling channels U+FEFF and the whole TAGS block
// (U+E0001, U+E0020-U+E007F), AND this scanner flags the same four so a byte
// that somehow evaded the gate is still caught here, tracked in lib/. The
// scanner remains the tracked-source BACKSTOP rather than a redundant copy of
// the gate: it additionally flags U+200C/U+200D and the vertical-tab/form-feed
// pair (0x0b, 0x0c), which the write-content gate deliberately admits as
// ordinary formatting bytes in authored prose. Both registries moved
// together in this run; neither is left narrower than the other by design.
function isHazardCodePoint(code) {
  if (code === 0x09 || code === 0x0a || code === 0x0d) return false;
  if (code <= 0x1f) return true;
  if (code >= 0x7f && code <= 0x9f) return true;
  if (code === 0xad) return true;
  if (code === 0x61c) return true;
  if (code >= 0x200b && code <= 0x200f) return true;
  if (code >= 0x2028 && code <= 0x2029) return true;
  if (code >= 0x202a && code <= 0x202e) return true;
  if (code >= 0x2060 && code <= 0x206f) return true;
  if (code === 0xfeff) return true;
  if (code >= 0xfff9 && code <= 0xfffb) return true;
  if (code === 0xe0001) return true;
  if (code >= 0xe0020 && code <= 0xe007f) return true;
  return false;
}

function scanTextForHazards(file, text) {
  const flagged = [];
  for (let index = 0; index < text.length; index += 1) {
    const code = text.codePointAt(index);
    if (isHazardCodePoint(code)) flagged.push({ file, index, code: code.toString(16) });
  }
  return flagged;
}

// KNOWN, NAMED EXEMPTION -- never a silent narrowing of what counts as a
// hazard byte. __tests__/runtime-v2-execution-config-case-folding.test.js
// legitimately embeds literal soft-hyphen/zero-width/bidi code points as its
// own FIXTURE DATA: its entire purpose is proving this runtime's case-folding
// execution-config guard (lib/runtime/hooks.js) against exactly such bytes in
// a filesystem PATH SEGMENT, independently verified by its own suite. It is
// not a file this ticket claims or may edit (per its acceptance's own rule,
// "if any tracked file already trips it, that is a finding to report and fix
// deliberately, not to silence by narrowing the scan" -- reported as a
// residual, unfixed, rather than reformatted or silently dropped from scope
// by widening the scan pattern itself).
const SCAN_FILE_EXEMPTIONS = new Set([
  '__tests__/runtime-v2-execution-config-case-folding.test.js',
]);

function trackedSourceFiles(rootDir) {
  const listing = execFileSync('git', ['ls-files', ...SCAN_DIRS], { cwd: rootDir, encoding: 'utf8' });
  return listing
    .split('\n')
    .filter((entry) => /\.(js|mjs|cjs)$/.test(entry) && !SCAN_FILE_EXEMPTIONS.has(entry));
}

function describeFlagged(flagged) {
  return flagged.map((entry) => `${entry.file}[${entry.index}] U+${entry.code.toUpperCase()}`).join('\n');
}

describe('tracked-source control/bidi byte guard', () => {
  it('flags a deliberately planted decoded control/bidi byte in a staged synthetic tree (SHOWN, never merely asserted)', () => {
    const staged = mkdtempSync(path.join(tmpdir(), 'ape-byte-integrity-staged-'));
    try {
      const plantedDir = path.join(staged, 'lib', 'runtime');
      mkdirSync(plantedDir, { recursive: true });
      const plantedFile = path.join(plantedDir, 'planted.js');
      writeFileSync(plantedFile, `export const evil = '${RLO}payload';\n`);
      const flagged = scanTextForHazards('lib/runtime/planted.js', readFileSync(plantedFile, 'utf8'));
      expect(flagged.length, 'the synthetic planted byte must be detected').toBeGreaterThan(0);
      expect(flagged[0].code).toBe('202e');
    } finally {
      rmSync(staged, { recursive: true, force: true });
    }
  });

  it('flags U+2028, U+2029, U+FEFF, and a TAGS-block code point -- the class this scanner\'s isHazardCodePoint widened to', () => {
    const lineSeparator = String.fromCharCode(0x2028);
    const paragraphSeparator = String.fromCharCode(0x2029);
    const byteOrderMark = String.fromCharCode(0xfeff);
    // U+E0021 TAG EXCLAMATION MARK sits inside the TAGS block and, like every
    // TAGS member, is outside the BMP, so it needs fromCodePoint rather than
    // fromCharCode to synthesize numerically (never a literal character or a
    // `\u` escape in this file's own bytes, per the authoring hazard above).
    const tagChar = String.fromCodePoint(0xe0021);
    const flagged = scanTextForHazards(
      'fixture.js',
      `a${lineSeparator}b${paragraphSeparator}c${byteOrderMark}d${tagChar}e`,
    );
    expect(flagged.map((entry) => entry.code)).toEqual(['2028', '2029', 'feff', 'e0021']);
  });

  it('does not flag ordinary printable ASCII, accented, or CJK source text (over-block guard on the detector itself)', () => {
    const clean = "export const label = 'café 日本語 — em dash, curly ‘quotes’';\n";
    expect(scanTextForHazards('fixture.js', clean)).toEqual([]);
  });

  it('finds no decoded control/bidi/format byte in this project\'s own tracked lib/, bin/, scripts/, __tests__/ source (post-fix invariant, GREEN on the live tree)', () => {
    const files = trackedSourceFiles(root);
    expect(files.length).toBeGreaterThan(50);
    const flagged = files.flatMap((file) => scanTextForHazards(file, readFileSync(path.join(root, file), 'utf8')));
    expect(flagged, describeFlagged(flagged)).toEqual([]);
  });
});

// ===========================================================================
// PENDING-STATE PROSE TRIPWIRE. This is the DURABLE fix for a defect class
// that burned two prior runs on this exact ticket: a stage writes a
// forward-looking comment ("left to the remediation build", "NOT widened by
// this ticket", "may legitimately be RED", "that is expected, not a
// defect"), a LATER STAGE IN THE SAME RUN lands the described work, and
// nobody updates the comment -- so the tree ships a false statement about
// its own surface. Both prior instances lived in THIS file (the two blocks
// above, now corrected); this arm makes a THIRD occurrence of those same
// four spellings, anywhere under __tests__/, fail loudly by name and line
// rather than ship silently again.
//
// WHAT THIS ARM DOES NOT CLAIM. It is a phrase-list scan over one directory,
// not a semantic understanding of "pending work" -- it cannot see a
// differently-worded instance of the same defect, and it structurally cannot
// see one in lib/, bin/, docs/, or prompts/ (the class ALSO occurred as a
// production-comment defect in this very run: service.js and pipeline.js
// falsely described the write-content-gate character policy as "identical"
// to their own and ordered a hand re-sync -- see the divergence guard in
// __tests__/runtime-v2-character-policy-divergence.test.js, which is this
// class's SEPARATE, non-prose, PRODUCTION-facing fix). This arm's bound is
// exactly these four spellings, in this one directory; it does not, and
// cannot, make the defect class impossible to reintroduce under different
// words or in a different tree location. Recording that limit here, rather
// than overclaiming resolution, is itself required by the run's own
// truthfulness rule.
//
// SCOPE POLICY (deliberate, recorded rather than left implicit). readdirSync
// over __tests__/ admits every entry on disk, tracked or not, so the filter
// below keeps only *.test.js. This run claims 7 of the ~182 files that glob
// will find; a phrase hit inside a file OUTSIDE those 7 has exactly two
// sanctioned exits, per the precedent SCAN_FILE_EXEMPTIONS above already
// sets for this file: a NAMED exemption carrying a recorded reason, or
// narrowing the phrase set. SCAN_FILE_EXEMPTIONS' own comment forbids
// "silencing by narrowing the scan", so narrowing the phrase set is the
// forbidden exit here too -- an out-of-claim hit must be named, not
// papered over. As of this run's tree, PENDING_STATE_EXEMPTIONS is empty:
// no unclaimed file carries any of the four phrases.
//
// SELF-EXCLUSION (a real hole, stated plainly rather than left implicit).
// The four phrases must be held as literal strings for this scan to work,
// so THIS FILE necessarily contains its own trigger text and is excluded by
// name below. A hypothetical fifth instance of the defect class landing
// inside this file's own future prose would not be caught by this arm; nothing
// else in the suite covers that gap.
//
// GREEN ON ARRIVAL, DELIBERATELY. By the time this arm's own file lands, the
// two real instances it targets have already been corrected (the blocks
// above), so this test passes today. That is the point, not an accident: a
// tripwire that is red until someone fixes it by hand is not durable across
// future runs the way a green invariant, checked every run from now on, is.
// ===========================================================================
const PENDING_STATE_PHRASES = Object.freeze([
  'left to the remediation build',
  'NOT widened by this ticket',
  'may legitimately be RED',
  'that is expected, not a defect',
]);

// Recorded, named exemptions for a phrase hit in a file OUTSIDE this run's
// claimed_paths (see SCOPE POLICY above). Empty on this tree: nothing to
// exempt today.
const PENDING_STATE_EXEMPTIONS = new Set([]);

const SELF_TEST_FILE_BASENAME = 'runtime-v2-authored-byte-integrity.test.js';

// Returns { hits, scanned } rather than a bare array: `scanned` is the count
// of *.test.js files actually walked (excluding the self-exclusion above),
// so a caller can assert a population floor the same way the tracked-source
// guard above asserts one on `files.length` -- a future filter regression
// that quietly scans almost nothing must fail loudly here instead of passing
// by scanning zero files. This function has exactly one caller in this file,
// so the reshape is safe.
function scanForPendingStateProse(testsDir) {
  const entries = readdirSync(testsDir).filter((entry) => entry.endsWith('.test.js'));
  const hits = [];
  let scanned = 0;
  for (const entry of entries) {
    if (entry === SELF_TEST_FILE_BASENAME) continue; // see SELF-EXCLUSION above
    scanned += 1;
    // Reported as `__tests__/${entry}` regardless of the directory this
    // function is actually handed -- deliberate, not derived from testsDir,
    // so the live arm's own hit label always reads as a real project-relative
    // __tests__/ path. A positive control run against a synthetic temp
    // directory (below) therefore reports its planted file under this same
    // `__tests__/` prefix too, which is intentional: changing that would
    // alter the live arm's own failure text for no gain.
    const relPath = `__tests__/${entry}`;
    const text = readFileSync(path.join(testsDir, entry), 'utf8');
    const lines = text.split('\n');
    lines.forEach((line, index) => {
      for (const phrase of PENDING_STATE_PHRASES) {
        if (line.includes(phrase) && !PENDING_STATE_EXEMPTIONS.has(relPath)) {
          hits.push(`${relPath}:${index + 1}: contains pending-state phrase "${phrase}"`);
        }
      }
    });
  }
  return { hits, scanned };
}

describe('pending-state prose tripwire: no authored test file describes work as pending, deferred, or expected-to-be-red', () => {
  it('finds none of the four named pending-state phrases in any *.test.js file under __tests__/, globbed from disk (self-excluded; see SCOPE POLICY and SELF-EXCLUSION above)', () => {
    const { hits, scanned } = scanForPendingStateProse(path.join(root, '__tests__'));
    expect(hits, hits.join('\n')).toEqual([]);
    // Population floor (the identical idiom the tracked-source guard above
    // pins on files.length): a future filter regression that scans almost
    // nothing must redden here rather than pass by scanning too few files to
    // ever find a hit -- the invariant this floor pins, independent of any
    // one run's own claim count.
    expect(scanned).toBeGreaterThan(50);
  });

  it('detector proof: a planted *.test.js file carrying a banned phrase in a synthetic temp directory is flagged by file and line, never merely asserted against the live tree (mirrors the tracked-source guard\'s own planted-byte proof above)', () => {
    const staged = mkdtempSync(path.join(tmpdir(), 'ape-pending-state-'));
    try {
      writeFileSync(
        path.join(staged, 'planted.test.js'),
        ['// an ordinary leading comment line', '// left to the remediation build', ''].join('\n'),
      );
      const { hits, scanned } = scanForPendingStateProse(staged);
      expect(scanned).toBe(1);
      expect(hits).toEqual([
        '__tests__/planted.test.js:2: contains pending-state phrase "left to the remediation build"',
      ]);
    } finally {
      rmSync(staged, { recursive: true, force: true });
    }
  });
});
