import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  accessSync,
  constants as fsConstants,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { resolveGovernedRoot, runtimeHost, runtimePaths } from './paths.js';
import { SEALED_STATUSES } from './constants.js';
import { looksLikeTest, withinClaim, withinTestScope } from './path-scope.js';
import {
  classifyExternalTool,
  externalToolPolicy,
  resolveClaimedPluginRead,
} from './external-tools.js';
import { SHELL_WRITE, WRITE_TOOLS, evaluateTreePolicy, executionConfigTail, extractApplyPatchPaths, matchingCommandProfile, normalizePath, parseDeletionCommand } from './write-policy.js';
import { BARE_TEST_RUNNER, EVIDENCE_COMMAND_FAMILIES, GIT_EVIDENCE_VERB_TOKEN, INSPECTION_BUILTIN, LEADING_CD, LINT_EXEC_PREFIX, LINT_TOOL, NODE_EVIDENCE_FLAG, PACKAGE_MANAGER_HEAD, PACKAGE_MANAGER_RUNNER, PYTHON_HEAD, PYTHON_MANAGER_HEAD, PYTHON_MANAGER_TEST_HEAD, PYTHON_TEST_MODULE, RUFF_EVIDENCE_VERB, evidenceOperandCandidates, evidenceOperandEscapes, gitEvidenceArgsSafe, parseEvidenceCommand } from './evidence-policy.js';

// Claim/test-path matching is the shared path-scope module so the write-time
// policy here and the receipt-time validator agree byte-for-byte on the same
// claim. Re-exported because bin/ape-hook.mjs and the behavioral tests reach
// these predicates through the hooks surface.
export { looksLikeTest, withinTestScope } from './path-scope.js';

// Exported so bin/ape-hook.mjs (which narrows its pre-policy exemption to the
// main session) and the agent-surface tests assert against one host-neutral
// safe built-in set.
export const SAFE_CLAUDE_SUBAGENT_TOOLS = new Set([
  'Bash',
  'Glob',
  'Grep',
  'LS',
  'Read',
  'TodoWrite',
  'ToolSearch',
  'WebFetch',
  'WebSearch',
]);

export const SAFE_GEMINI_SUBAGENT_TOOLS = new Set([
  'run_command',
  'view_file',
  'list_dir',
  'grep_search',
  'read_url_content',
  'read_resource',
  'list_resources',
  'search_web',
  'ask_question',
  'manage_task',
  'schedule',
  'generate_image',
]);

export const SAFE_SUBAGENT_TOOLS = new Set([
  ...SAFE_CLAUDE_SUBAGENT_TOOLS,
  ...SAFE_GEMINI_SUBAGENT_TOOLS,
]);

// The runtime's own control-plane MCP tools, matched bare or MCP-namespaced
// (mcp__<server>__ape_run etc.). Shared with bin/ape-hook.mjs so the main-
// session stage-guard exemption and the subagent one-owner deny key off one
// pattern (friction #13).
export const CONTROL_PLANE_TOOLS = /(?:^|__)ape_(run|config|history)$/;

const NON_TOOL_LIFECYCLE_EVENTS = new Set(['Stop', 'SubagentStop']);

// Claude exposes its native subagent launcher as `Agent`. Codex exposes the
// same lifecycle boundary as `spawn_agent`. Multi-Agent V2 flattens the
// namespace for hooks to `collaborationspawn_agent`; older hosts may preserve
// it as a dotted or double-underscore prefix. Keep the accepted set explicit:
// treating every tool whose name merely ends in `spawn_agent` as a launch
// would let an unrelated MCP tool consume a dispatch capability.
export function isAgentDispatchTool(toolName) {
  return [
    'Agent',
    'spawn_agent',
    'collaborationspawn_agent',
    'collaboration.spawn_agent',
    'collaboration__spawn_agent',
    'invoke_subagent',
  ].includes(toolName);
}

// A lifecycle boundary event (Stop, SubagentStop) or any event that carries no
// tool name is not a tool call: there is no tool channel to police, so it must
// never be evaluated as one — denying it eats the agent's receipt-bearing final
// message (read-only subagents were blocked at every Stop). Tree integrity at
// these boundaries is enforced separately: bin/ape-hook.mjs runs the
// tree-reconciliation guard (evaluateTreePolicy) BEFORE this policy and still
// denies unattributed tree changes at SubagentStop.
function isToolChannelEvent(event) {
  return Boolean(event.tool_name) && !NON_TOOL_LIFECYCLE_EVENTS.has(event.event);
}

// Main-session /dev/null fail-safe. SHELL_WRITE is a fail-closed BLOCKLIST, so a
// pure read that merely routes an fd to the bit-bucket (`ls 2>/dev/null`) trips
// it and is denied — friction with no security value, since /dev/null cannot be
// written to. onlyDevNullRedirects reports whether the SOLE reason a command
// matched SHELL_WRITE is one or more redirects to EXACTLY /dev/null: strip every
// such redirect and re-test — if the residual no longer matches, the command has
// no other write channel and is safe to allow; if a real write co-occurs it
// survives the strip and stays denied. The trailing lookahead is the load-bearing
// security anchor: /dev/null must be the COMPLETE target (end-of-string,
// whitespace, `;`, `|`, `&`, or `)`), never followed by `/`, `.`, or a word char,
// so `>/dev/null/../etc/passwd`, `>/dev/nullish`, `>/dev/null.bak`, `>/dev/null2`
// are real writes left intact and denied. DEV_NULL_REDIRECT carries /g and is
// used ONLY via String.replace (never .test()/.exec(), which are lastIndex-
// stateful); SHELL_WRITE stays /i-only for the same reason — it is .test()'d
// twice in a row (the line-~475 guard, then here).
const DEV_NULL_REDIRECT = /(?:\d+|&)?>{1,2}\s*\/dev\/null(?=$|[\s;|&)])/g;

function onlyDevNullRedirects(command) {
  return SHELL_WRITE.test(command) && !SHELL_WRITE.test(command.replace(DEV_NULL_REDIRECT, ' '));
}

// Recognized non-mutating evidence commands a bound subagent may run to gather
// test/verify results. Deliberately narrow: inline interpreters (`node -e`,
// `python -c`), arbitrary binaries, and anything matching SHELL_WRITE still fail
// closed, so a subagent cannot mutate production through an unprovable shell
// channel — production edits must go through the path-checked host edit tool.
//
// Python environment managers (uv, poetry, pdm, hatch, rye, pipenv, pixi) run
// tests through a `run` wrapper — the canonical `uv run pytest`. Bare `pytest`
// is not on PATH in a managed venv, so without these a uv/poetry project could
// produce no red/targeted evidence at all. Their `run` form is admitted ONLY
// when the tail is itself a recognized test runner (pytest / python -m
// pytest|unittest); `<mgr> run python -c ...` and other arbitrary tails stay
// denied. `tox` and the `hatch test` / `rye test` subcommands are test drivers
// by definition.
//
// `env` is a process launcher, not a read-only inspection command, so only its
// BARE form (no operands) is recognized: the `env\s*$` arm sits INSIDE the
// anchored `^\s*(...)` group, so a program whose name merely ends in `env`
// (`printenv`, `make env`) is not admitted, and `env <operand>` (a command, a
// NAME=VALUE assignment, or a flag) denies like any unrecognized command.
//
// ===========================================================================
// READ THIS BEFORE YOU EDIT THE REGEX BELOW.
//
// This pattern is NO LONGER the admission boundary. It is a residual shape
// check that runs AFTER the tokenize-then-allowlist gate (parseEvidenceCommand
// + recognizeEvidenceHead + recognizeLintHead + evidence containment, all
// below). FOUR review rounds each found a DIFFERENT bypass of this one regex,
// because the bypasses are THREE LAYERS, not four instances of one class —
// which is exactly why three locally-correct patches each left the class open:
//
//   L1 SHELL TOKENIZATION. The host re-tokenizes and de-quotes before any
//      program sees argv, so one quote or backslash splits the token this
//      regex inspected: `yarn typecheck` DENIED but `yarn t"ypecheck"` ALLOWED
//      with identical argv; `yarn run test-pwn` DENIED but `yarn run
//      test"-pwn"` ALLOWED, because the greedy class stopped at the quote and
//      the gate membership-tested the PREFIX while the manager receives the
//      whole name.
//   L2 THIS REGEX'S OWN TOKEN BOUNDARY. `\b` and the `[\w:@./-]` separator
//      class are a BLOCKLIST of separators inside a pattern `.test()`ed with
//      no end anchor, so any character outside the class ends the match early:
//      `yarn test:e2e`, `pnpm test-ci`, `bun test.unit`, `yarn test+e2e`.
//   L3 THE PACKAGE MANAGER'S OWN PARSER. npm and pnpm parse with nopt, which
//      expands any unambiguous prefix of a known key and expands short-flag
//      clusters, so a refusal naming literal flag spellings is incomplete BY
//      CONSTRUCTION: `npm test --prefi /other/repo`, `yarn test -rC /tmp`.
//
// Rounds 1-4 (receipts 49b349d7, cb0109c4, 0caa5f91, 08a79879, c6fca60a) all
// asserted a NEGATIVE over an adversarial space. The replacement asserts a
// POSITIVE over the actual command: refuse the whole command if it carries any
// character outside a safe set, split on whitespace, recognize the head by
// EXACT TOKEN EQUALITY, and refuse any OPERAND that names a path outside the
// governed project. Widening THIS regex therefore widens nothing on its own —
// and NARROWING the token gate to re-add a separator class or a flag-spelling
// blocklist reopens the class. Full record, with the four bypasses, the five
// receipts, the abandoned fourth patch and the deciding spike:
// docs/research/2026-07-28-evidence-command-shape-allowlist.md.
// ===========================================================================
const EVIDENCE_COMMAND =
  /^\s*(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+[\w:@./-]+|test|t)\b|(?:npx|pnpm|yarn|bun)\s+(?:vitest|jest|mocha|ava|playwright|tap|tsc)\b|(?:vitest|jest|mocha|ava|tap|pytest|tsc)\b|node\s+--(?:test|check|version)\b|python3?\s+-m\s+(?:pytest|unittest)\b|(?:uv|poetry|pdm|hatch|rye|pipenv|pixi)\s+run\s+(?:pytest|python3?\s+-m\s+(?:pytest|unittest))\b|(?:hatch|rye)\s+test\b|tox\b|(?:go|cargo)\s+test\b|git\s+(?:status|diff|log|show|rev-parse|branch|describe|ls-files)\b|(?:ls|pwd|cat|echo|true|which)\b|env\s*$)/;

// How many leading tokens the recognized evidence head phrase consumes, or 0
// when the token vector does not begin with one. Every comparison is `===` or
// Set membership on a COMPLETE token, so `<head>-pwn`, `<head>.pwn`,
// `<head>:pwn`, `test:e2e`, `test+e2e` and `t"ypecheck"` (already dead at the
// metacharacter refusal) are all simply not the head.
function recognizeEvidenceHead(tokens) {
  const [head, second, third, fourth, fifth] = tokens;
  if (PACKAGE_MANAGER_HEAD.has(head)) {
    // The bare arm is a COMPLETE token: `tokens[1]` must be exactly `test` or
    // `t`. That single equality is round 1b's fix and round 3's `test+e2e` fix
    // with no separator class left in it. A lookahead like `(?![\w:@./-])` is
    // another separator class and is precisely the construct that produced
    // round 3.
    if (second === 'test' || second === 't') return 2;
    // `run <script>` consumes the script name; WHICH names are admitted is the
    // role-aware tier decision below, not a head-table question.
    if (second === 'run' && typeof third === 'string') return 3;
    if (head !== 'npm' && PACKAGE_MANAGER_RUNNER.has(second)) return 2;
    return 0;
  }
  if (head === 'npx') return PACKAGE_MANAGER_RUNNER.has(second) ? 2 : 0;
  if (BARE_TEST_RUNNER.has(head)) return 1;
  if (head === 'node') return NODE_EVIDENCE_FLAG.has(second) ? 2 : 0;
  if (PYTHON_HEAD.has(head)) {
    return second === '-m' && PYTHON_TEST_MODULE.has(third) ? 3 : 0;
  }
  if (PYTHON_MANAGER_HEAD.has(head)) {
    if (second === 'run') {
      if (third === 'pytest') return 3;
      if (PYTHON_HEAD.has(third) && fourth === '-m' && PYTHON_TEST_MODULE.has(fifth)) return 5;
      return 0;
    }
    return PYTHON_MANAGER_TEST_HEAD.has(head) && second === 'test' ? 2 : 0;
  }
  if (head === 'tox') return 1;
  if (head === 'go' || head === 'cargo') return second === 'test' ? 2 : 0;
  if (head === 'git') return GIT_EVIDENCE_VERB_TOKEN.has(second) ? 2 : 0;
  if (INSPECTION_BUILTIN.has(head)) return 1;
  // `env` is a process launcher, not an inspection command: only the BARE form
  // (no operands at all) is recognized, exactly as the shape regex's `env\s*$`
  // arm intends.
  if (head === 'env') return tokens.length === 1 ? 1 : 0;
  return 0;
}

// The LINT head phrase, same exact-token discipline: an optional invocation
// prefix ({uv,poetry,pdm,hatch,rye,pipenv,pixi} + `run` | `npx` |
// {pnpm,yarn,bun} + optional {exec,x}), then an EXACT linter name, and for
// `ruff` an exact subcommand. The tail vetting (lintCommandMutates,
// lintArgsSafe, LINT_SAFE_FLAG and the token sets beside them) now reads the
// SAME token vector this returns a length into — see the round-5 note there.
function recognizeLintHead(tokens) {
  const head = tokens[0];
  let index = 0;
  if (PYTHON_MANAGER_HEAD.has(head) && tokens[1] === 'run') index = 2;
  else if (head === 'npx') index = 1;
  else if (head === 'pnpm' || head === 'yarn' || head === 'bun') {
    index = LINT_EXEC_PREFIX.has(tokens[1]) ? 2 : 1;
  }
  const tool = tokens[index];
  if (!LINT_TOOL.has(tool)) return 0;
  if (tool === 'ruff') {
    return RUFF_EVIDENCE_VERB.has(tokens[index + 1]) ? index + 2 : 0;
  }
  return index + 1;
}

// Read-only lint/typecheck evidence. A stage whose gate requires lint evidence
// must be able to produce it, so the recognized linters (ruff check / ruff
// format --check, flake8, mypy, pylint, black --check, isort --check/
// --check-only, eslint, prettier --check) are admitted in check-only form —
// bare, through the Python manager `run` wrappers, or through npx / pnpm /
// yarn / bun exec — plus a bare `--version` probe for each. Admission is
// two-step so each half stays reviewable: recognizeLintHead (above) matches
// only the invocation shape — by EXACT TOKEN EQUALITY since this run, because
// the previous `^\s*(...)` regex carried the same unanchored word-boundary
// defect as the evidence shape and `yarn mypy-x` is an arbitrary declared
// script, not a typo — then lintCommandMutates denies any mutating flag
// (--fix, --unsafe-fixes, --fix-only, --write, -w, --in-place) and, for the
// formatters (black, isort, prettier, ruff format), the absence of an explicit
// check-mode flag. SHELL_WRITE is still consulted afterwards, so redirects
// stay denied.
//
// ROUND 5, SITE 2 — WHY THE TAIL IS READ FROM parsed.tokens AND NOT FROM THE
// RAW STRING. This vetting used three unanchored regexes over the command TEXT,
// so the gate and the tokenizer could disagree about what the tokens even are:
// `black . # --check` matched LINT_CHECK_MODE, cleared the formatter, and was
// ALLOWED — while the shell commented `# --check` out and ran `black .`,
// rewriting every matching file in place. That is an unproven production write
// (invariant 2) from a read-only ticket, attributed to nobody, and it is the
// ANTI-MONOTONE half of the truncation defect: admission was CONDITIONAL ON THE
// PRESENCE of a token the shell never receives. Refusing `#` closes that known
// instance; reading the tail from the SAME token vector the head recognizer
// used closes the disagreement structurally, so no future character can split
// the two views again. Membership is exact-token, which is not a widening: a
// suffixed spelling (`--fix=1`, `--check=x`) is a `-`-leading token outside
// LINT_SAFE_FLAG, and lintArgsSafe — an allowlist — refuses it anyway.
const LINT_MUTATING_TOKEN = new Set([
  '--fix', '--unsafe-fixes', '--fix-only', '--write', '-w', '--in-place',
]);

const LINT_CHECK_MODE_TOKEN = new Set(['--check', '--check-only']);

// The in-place rewriters. `ruff` is a formatter only under its `format`
// subcommand (`ruff check` is read-only), so it is decided positionally below
// rather than by name.
const LINT_FORMATTER_TOOL = new Set(['black', 'isort', 'prettier']);

// Shell control operators that turn a recognized leading evidence/lint command
// into a launcher for a second, unvetted command: chaining (; && || |),
// command/parameter substitution (`...`, $(...), ${...}), and redirects
// (< >, including the no-space `cmd>file` form SHELL_WRITE's whitespace-
// anchored pattern misses). One occurrence fails the whole line closed — the
// allowlisted head is only trustworthy when it is the ENTIRE command.
const COMMAND_CHAIN = /[\n;|&`<>]|\$[({]/;

function stripLeadingCd(command) {
  const match = LEADING_CD.exec(command);
  return match ? match[2] : command;
}

// Read-only lint admission is an allowlist, not a blocklist. After the
// recognized invocation head, the only permitted tokens are these known
// check/probe flags and non-flag path arguments; every other flag is refused.
// That refusal is load-bearing: the code-loading flags (--config, --config-file,
// --rcfile, --load-plugins, --plugin) make a linter execute attacker-authored
// JavaScript/Python as a pure side effect of "linting", and the file-writing
// flags (--output-file, --junit-xml, --output, --add-noqa, plus the mutating
// flags above) rewrite the tree with no proven path. Blocklisting these misses
// the next one; allowlisting fails closed by construction.
const LINT_SAFE_FLAG = new Set([
  '--check', '--check-only', '--version', '--quiet', '-q', '--diff', '--color', '--no-color',
]);

// `tokens` is parsed.tokens (the cd prefix is already stripped by the parser)
// and `lintHead` is how many of them recognizeLintHead consumed, so the tool
// is identified from the RECOGNIZED INVOCATION rather than from a name appearing
// anywhere in the text: `eslint black` lints a file called `black`, it does not
// invoke the formatter.
function lintCommandMutates(tokens, lintHead) {
  if (tokens.some((token) => LINT_MUTATING_TOKEN.has(token))) return true;
  const phrase = tokens.slice(0, lintHead);
  const last = phrase[phrase.length - 1];
  // recognizeLintHead consumes the TOOL as its last token for every linter
  // except `ruff`, where it also consumes the exact subcommand. `check`,
  // `format` and `--version` are not linter names, so "is the last token a
  // linter?" disambiguates the two shapes with no second parse.
  const tool = LINT_TOOL.has(last) ? last : phrase[phrase.length - 2];
  if (!LINT_FORMATTER_TOOL.has(tool) && !(tool === 'ruff' && last === 'format')) return false;
  return (
    !tokens.some((token) => LINT_CHECK_MODE_TOKEN.has(token)) && !tokens.includes('--version')
  );
}

function lintArgsSafe(tokens) {
  return tokens.every((token) => !token.startsWith('-') || LINT_SAFE_FLAG.has(token));
}

// Every operand of the command — the cd target and every token — must stay
// inside the governed project. Returns the first escaping candidate so the
// deny reason can name the PATH rather than the flag.
function evidenceContainment(parsed, projectDir) {
  const { cdTarget, tokens } = parsed;
  if (cdTarget !== null) {
    // A cd target is unconditionally a path operand, so it gets no `-`-leading
    // exemption: `cd -` (the previous directory) names a location the gate
    // cannot see and is refused with it.
    //
    // `+` IS REFUSED WITH `-`, AND THE ASYMMETRY WAS A REVIEW FINDING OF THIS
    // PHASE (raised by the review and the security review, both here). zsh's
    // `cd` has a THIRD FORM, `cd {+|-}n`, which "extracts an entry from the
    // directory stack, and changes to that directory" — `+n` counts from the
    // left of `dirs`, `-n` from the right, and PUSHD_MINUS SWAPS the two
    // spellings, so refusing one and admitting the other refuses nothing at all.
    // `+1` is relative and dotdot-free, so the lexical check passes and the
    // unconditional `cd` realpath precompute in bin/ape-hook.mjs resolves
    // `<sessionCwd>/+1`, which nearestExistingPath walks up to a directory
    // INSIDE the root — ALLOW, while the shell relocates to a stack entry the
    // gate never saw. The stack has to be non-empty for the form to resolve at
    // all (AUTO_PUSHD, or an explicit `pushd` in the operator's profile, is what
    // fills it), so this is OPERATOR-CONFIGURABLE and PRE-EXISTING — but `+` is
    // now an ENUMERATED member of the evidence alphabet, so admitting it as a
    // relocation target would be a decision rather than an oversight.
    // NAMED OVER-BLOCK COST: a directory whose name begins with `+` or `-`
    // cannot be a `cd` target here. `cd ./+build && npm test` still works.
    if (
      cdTarget.startsWith('-') ||
      cdTarget.startsWith('+') ||
      evidenceOperandEscapes(cdTarget, projectDir)
    ) {
      return { safe: false, operand: cdTarget };
    }
  }
  for (const token of tokens) {
    for (const candidate of evidenceOperandCandidates(token)) {
      if (evidenceOperandEscapes(candidate, projectDir)) return { safe: false, operand: candidate };
    }
  }
  return { safe: true, operand: null };
}

// ---------------------------------------------------------------------------
// Role-aware `<pm> run <script>` tier (roadmap entry
// evidence-command-npm-run-arbitrary-script).
//
// `<pm> run <script>` used to accept ANY package.json script name, which
// bypassed all three structural defenses at once — SHELL_WRITE, COMMAND_CHAIN
// and the inline-interpreter denial — because the script BODY is not part of
// the command line the gate reads. In this repository `npm run validate`
// executes code wholly OUTSIDE the tree, where the drift guard and
// receipt-time diff recomputation have no reach; and package.json is an
// ordinary claimable production file, so an implementer stage can DEFINE a
// script and hand every later read-only stage of the same run an
// arbitrary-command primitive. Raised by the security review of
// run-fixture-b1453c43be4d (receipt f9410f36, acme PR #367); DEMONSTRATED by
// the read-only plan checker of run-fixture-0d04382162e5, which ran
// `npm run bundle --dry-run` as a permission probe — npm ignores --dry-run for
// run-scripts, so a real build executed from a read-only ticket.
//
// Two tiers, selected FAIL-CLOSED on `ticket.writable === true`:
//   WRITABLE  keeps today's full breadth, explicitly dispositioned — the build
//             stage must be able to run `npm run bundle` to regenerate dist/
//             after any lib/runtime change, or the pipeline cannot complete.
//   READ-ONLY admits only OPERATOR-DECLARED names: the floor {'test'}, UNION
//             the names derived from the project's own configured commands,
//             UNION the explicit `policy.evidence_scripts` lever.
// Membership is EXACT STRING equality against a Set, never a composed regex
// alternation: an operator entry of `.*` or `test|validate` must admit nothing
// beyond those literal names, which no package.json defines.
//
// HOST-NEUTRAL BY CONSTRUCTION (invariant 6): a hardcoded literal list would
// bake this repository's script names into the runtime, so the allowlist
// follows what the operator already declared for THIS project.
//
// SYNCHRONY IS LOAD-BEARING. evaluateLifecyclePolicy must stay SYNCHRONOUS:
// bin/ape-hook.mjs consumes its return value with no await, so an async policy
// would yield a Promise whose `.decision` is undefined and formatHookResponse
// would emit `deny` for EVERY PreToolUse — a silent total lockout. Hence
// readFileSync, read LAZILY (only once the run-script arm matched on a
// read-only ticket) and resolved from event.project_dir, never process.cwd().
// ---------------------------------------------------------------------------
// The DERIVATION grammar, and ONLY that: it reads the script name out of an
// operator-authored CONFIG STRING, an input that never passes through a shell,
// so an anchored regex is correct there. It is deliberately NOT the matcher
// for the command being gated — that is token indexing above, because a regex
// over a shell-de-escapable string is the L1 defect.
//
// Anchoring is required on the config side: an unanchored scan mis-parses the
// real values stored in these slots (`{paths}` templates, bare flag fragments,
// `npx`/`pytest` heads), so a configured command with its own `cd` prefix, a
// `--` separator or a multi-word head yields NOTHING and silently narrows the
// operator's own allowlist (documented in docs/hooks.md).
const RUN_SCRIPT_INVOCATION = /^\s*(?:npm|pnpm|yarn|bun)\s+run\s+([\w:@./-]+)/;

// The name grammar every declared name passes through before it can join the
// admitted set. A declared entry outside it (`.*`, `test|validate`) could never
// equal a real script name, so it is dropped rather than carried into the
// deny-reason enumeration. A LEADING `-` is excluded — mirrored by
// EVIDENCE_SCRIPT_NAME in config.js — so an operator cannot declare a FLAG as a
// script name: `npm run --silent validate` has npm consume `--silent` as config
// and run a different, never-checked script.
const RUN_SCRIPT_NAME = /^[\w:@./][\w:@./-]*$/;

// Host-neutral floor: `run test` is admitted with no configuration at all, so
// failing closed never strands a role that has no config to read.
const EVIDENCE_SCRIPT_FLOOR = Object.freeze(['test']);

// Bounds on the deny-reason enumeration so a large declared list cannot blow
// up a hook response. DENY_REASON_MAX_TOKEN bounds the echoed-back operator
// tokens (the refused script name, the cd target, the refused operand) for the
// same reason: they come from the command line, which is not otherwise
// length-limited.
const DENY_REASON_MAX_SCRIPTS = 12;

const DENY_REASON_MAX_CHARS = 240;

const DENY_REASON_MAX_TOKEN = 80;

function boundedToken(value, max = DENY_REASON_MAX_TOKEN) {
  const text = typeof value === 'string' ? value : String(value ?? '');
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function collectRunScriptNames(slots, names) {
  if (!slots || typeof slots !== 'object' || Array.isArray(slots)) return;
  for (const value of Object.values(slots)) {
    if (typeof value !== 'string') continue;
    const match = RUN_SCRIPT_INVOCATION.exec(value);
    // Same name filter the explicit lever uses, so a configured `npm run
    // --silent spec` contributes a flag to nobody's allowlist.
    if (match && RUN_SCRIPT_NAME.test(match[1])) names.add(match[1]);
  }
}

// Synchronously read the governed project's OWN declared script names. Reads
// the raw `.ape/runtime/config.json` overlay rather than the merged config:
// every shipped default here is null/empty, so the overlay is the complete set
// of declarations, and this stays free of the async config loader.
//
// TOTAL try/catch, degrading restrictively to the floor: missing `.ape/`, a
// missing/unreadable/EACCES/EISDIR config, malformed JSON, a non-object root, a
// non-object `policy`, a non-array `policy.evidence_scripts`, non-string
// elements, a non-object `test_commands`, a non-array `runners`. This must
// NEVER throw — see the SYNCHRONY note above.
function declaredRunScripts(projectDir) {
  const names = new Set(EVIDENCE_SCRIPT_FLOOR);
  if (typeof projectDir !== 'string' || projectDir.length === 0) return names;
  try {
    const stored = JSON.parse(readFileSync(runtimePaths(projectDir).config, 'utf8'));
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return names;
    // One parser walks BOTH slot families: `runners[].profile` reuses the
    // identical test_commands slot shape (see RUNNERS_ELEMENT_SHAPE).
    collectRunScriptNames(stored.test_commands, names);
    if (Array.isArray(stored.runners)) {
      for (const runner of stored.runners) {
        if (runner && typeof runner === 'object' && !Array.isArray(runner)) {
          collectRunScriptNames(runner.profile, names);
        }
      }
    }
    const policy = stored.policy;
    const declared =
      policy && typeof policy === 'object' && !Array.isArray(policy) ? policy.evidence_scripts : null;
    if (Array.isArray(declared)) {
      for (const entry of declared) {
        if (typeof entry === 'string' && RUN_SCRIPT_NAME.test(entry)) names.add(entry);
      }
    }
  } catch {
    // Unreadable or malformed config is not a declaration: keep the floor.
  }
  return names;
}

function renderAdmittedScripts(names) {
  const sorted = [...names].sort();
  const shown = [];
  let used = 0;
  for (const name of sorted) {
    if (shown.length >= DENY_REASON_MAX_SCRIPTS) break;
    // The budget applies to EVERY element including the first, and each name is
    // bounded like the command-derived tokens are: nothing caps a declared
    // name's length (RUN_SCRIPT_NAME and EVIDENCE_SCRIPT_NAME are shape-only,
    // and formatHookResponse bounds no reason), so a single long entry must not
    // be able to push the reason past the budget on its own. boundedToken caps
    // each at 80 chars, so the loop always shows at least one name and the
    // remainder falls through to the `(+N more)` marker.
    const token = boundedToken(name);
    if (used + token.length > DENY_REASON_MAX_CHARS) break;
    shown.push(token);
    used += token.length + 2;
  }
  const omitted = sorted.length - shown.length;
  return omitted > 0 ? `${shown.join(', ')} (+${omitted} more)` : shown.join(', ');
}

function extractPath(input) {
  const toolInput = input.tool_input ?? input.toolInput ?? input.input ?? input.toolCall?.args ?? {};
  return (
    toolInput.file_path ??
    toolInput.filePath ??
    toolInput.path ??
    toolInput.TargetFile ??
    toolInput.target_file ??
    toolInput.targetFile ??
    toolInput.AbsolutePath ??
    toolInput.absolute_path ??
    input.file_path ??
    null
  );
}

function extractPaths(input, toolName) {
  const explicit = extractPath(input);
  if (toolName !== 'apply_patch') {
    return typeof explicit === 'string' && explicit.length > 0 ? [explicit] : [];
  }
  const toolInput = input.tool_input ?? input.toolInput ?? input.input ?? input.toolCall?.args ?? {};
  const derived = extractApplyPatchPaths(toolInput);
  // An adapter-supplied explicit path is a compatibility hint, never authority
  // to hide additional files in the freeform document. Govern their union.
  if (typeof explicit !== 'string' || explicit.length === 0) return derived;
  return [explicit, ...derived.filter((candidate) => candidate !== explicit)];
}

export function normalizeLifecycleEvent(input, env = process.env) {
  // Claude payloads carry `cwd` (the session's *current* dir, which drifts on
  // cd) and no `project_dir`; CLAUDE_PROJECT_DIR names the *launch* dir, which
  // may itself sit below the governed root. Trusting either verbatim made the
  // guard compute a wrong `.ape/runtime` root, find no active run, and fail
  // open — so every hint only seeds the shared `.ape` marker walk: the
  // explicit dir (payload field, then env pin) outranks the drifting cwd, and
  // the stable CODEX_CWD outranks the per-event payload cwd.
  const host = runtimeHost(env);
  const toolCall = input.toolCall && typeof input.toolCall === 'object'
    ? input.toolCall
    : null;
  const toolInput = input.tool_input ?? input.toolInput ?? input.input ?? toolCall?.args ?? {};
  const workspaceDir = Array.isArray(input.workspacePaths)
    ? input.workspacePaths.find((candidate) => typeof candidate === 'string' && candidate.length > 0) ?? null
    : null;
  const projectDir = resolveGovernedRoot({
    explicitDir: input.project_dir ?? toolInput.project_dir ?? workspaceDir ?? null,
    cwd: input.cwd ?? toolInput.Cwd ?? toolInput.cwd ?? workspaceDir ?? null,
    env,
    host,
  });
  const toolName = input.tool_name ?? input.toolName ?? input.tool ?? toolCall?.name ?? '';
  const rawTargets = extractPaths(input, toolName);
  const targets = rawTargets.map((raw) => ({
    raw,
    file: normalizePath(raw, projectDir),
    target_path: path.resolve(projectDir, raw),
  }));
  const primaryTarget = targets[0] ?? null;
  const agentIdentity =
    input.agent_id ??
    input.agentId ??
    input.subagent_id ??
    input.subagentId ??
    input.agent_type ??
    input.agentType ??
    null;
  return {
    host,
    event: input.hook_event_name ?? input.hookEventName ?? input.event ?? env.APE_HOOK_EVENT ?? 'unknown',
    tool_name: toolName,
    external_tool: classifyExternalTool(toolName, toolInput),
    project_dir: projectDir,
    file: primaryTarget?.file ?? null,
    files: targets.map((target) => target.file).filter((file) => file !== null),
    targets,
    // Absolute, unresolved candidate path; null only when the payload carries
    // no path at all. Disambiguates "no path" (file null, target_path null,
    // fails closed) from "path present but lexically outside the project"
    // (file null, target_path non-null, candidate for the out-of-project
    // exemption).
    target_path: primaryTarget?.target_path ?? null,
    agent_identity: agentIdentity,
    is_subagent: Boolean(agentIdentity || input.is_subagent || input.isSubagent),
    ticket_id: input.ticket_id ?? input.ticketId ?? env.APE_TICKET_ID ?? null,
    command:
      toolInput?.command ??
      toolInput?.CommandLine ??
      toolInput?.command_line ??
      toolInput?.cmd ??
      null,
    raw: input,
  };
}

// A sealed terminal run is history on display, not a live governor. Truthful
// completion keeps the completed/aborted state in active.json indefinitely,
// and startRun already treats those statuses as no obstacle — the hook must
// agree, or every main-session write in the project stays denied ("no active
// writing run") from the moment a phase completes until the next run starts.
// Blocked is deliberately NOT sealed: a blocked run holds unresolved tickets
// awaiting remediation or an audited abort/reset, and routing intervention
// through the APE surface is the point of failing closed there. A sealed run
// stands aside for the host, but a subagent still bound to it holds a voided
// capability, so its write-capable tool calls into the project fail closed;
// unbound activity is untouched.

// dispatch-deny-reason-is-non-discriminating (roadmap entry). Switches on the
// SAME plain string literals lib/runtime/claude-dispatch.js's
// resolveClaudeBindingOutcome returns (documented there) — kept as function-
// local literals rather than a shared top-level exported table on EITHER side,
// because both files are already bundled into dist/ape-mcp.bundle.mjs (via
// service.js's imports) as well as dist/ape-hooks.bundle.mjs, and a new
// top-level `Object.freeze(...)`-backed export would ship into the mcp bundle
// too even though nothing reachable from that entry point ever calls this
// function — esbuild's tree shaking removes an unused FUNCTION wholesale
// (this one, exactly like evaluateLifecyclePolicy itself, never appears
// there) but is conservative about a top-level call expression's side
// effects, so an unused frozen object is not guaranteed to be shaken out.
// Every returned sentence is a FIXED, non-interpolated string: no session id,
// agent id, or ticket id is ever named (NO IDENTITY LEAK), and each names
// only its own class of cause so an operator (or a later run copying
// evidence.summary verbatim per prompts/common.md) does not have to guess.
// The historic, non-discriminating sentence stays the FALLBACK: it is what a
// direct evaluateLifecyclePolicy call with no hook-computed cause still gets
// (__tests__/runtime-v2-stop-lifecycle.test.js,
// __tests__/runtime-v2-hook-out-of-project.test.js pin this literal on
// exactly that call shape), and it is also what the live hook path itself
// still reports when even a relaxed filter observes nothing more specific.
function claudeBindingDenialReason(cause) {
  switch (cause) {
    case 'no_session_id':
      return 'APE tool denied: Claude subagent tool call carries no usable session id';
    case 'no_agent_id':
      return 'APE tool denied: Claude subagent tool call carries no usable agent id';
    case 'no_agent_type':
      return 'APE tool denied: Claude subagent tool call carries no usable agent type';
    case 'different_agent_id':
      return 'APE tool denied: a different agent id is already bound for this run, session and agent type';
    case 'ticket_not_pending':
      return "APE tool denied: Claude subagent's bound ticket is not active and pending";
    case 'deadline_elapsed':
      return "APE tool denied: Claude subagent's ticket deadline has elapsed";
    case 'ambiguous':
      return 'APE tool denied: Claude subagent binding is ambiguous for this identity';
    default:
      return 'APE tool denied: Claude subagent has no exact active binding';
  }
}

export function evaluateLifecyclePolicy(event, context) {
  if (!context?.state) {
    return { decision: 'allow', reason: 'no active APE run; host behavior is unchanged' };
  }
  const external = resolveClaimedPluginRead(event.external_tool ?? classifyExternalTool(
    event.tool_name,
    event.raw?.tool_input ?? event.raw?.toolInput ?? event.raw?.input ?? {},
  ), context.ticket?.tool_claims);
  // Control-plane ownership (friction #13; phantom-dispatch incident). The
  // orchestrator (main session) owns ape_run/ape_config/ape_history; a
  // bound-or-identifiable APE-managed subagent of EITHER host must never call
  // them. bin/ape-hook.mjs keeps the stage-guard exemption for the MAIN
  // session only (recovery would deadlock otherwise) and lets a subagent's
  // control-plane call fall through to here. The deny is deliberately
  // status-independent — placed before the sealed branch so a sealed run's
  // orphan cannot start or advance a new run, and before the no-exact-binding
  // deny so a blocked run's formerly-bound subagent (binding unresolvable,
  // ape_managed from the ape:* agent_type) is still routed to the recovery
  // contract rather than a stale "no binding" reason. The load-bearing
  // protection is launch-capability acquisition denial: ape_run next returns
  // a live Claude prompt nonce or Codex task-name token, so denying the
  // subagent's own control-plane call is what stops it minting the capability
  // that created the phantom
  // binding — the isApeLaunch branch in bin/ape-hook.mjs routes an ape:*
  // Agent call straight to launchClaudeIntent, so the indirect-channel Agent
  // deny below is unreachable for launches and is NOT the backstop here; the
  // independent second backstop is the agents/*.md tools: allowlist (layer 2),
  // which omits Agent and every ape_* tool. All three tools are denied, not
  // just ape_run: ape_config set/wire and ape_history import are writers, and
  // even the reads couple a role's output to runtime state its ticket does
  // not grant (behavioral independence, invariant 3; the ticket file is the
  // sole sanctioned .ape read per prompts/common.md).
  //
  // A host-attested subagent identity OR a truthy host-delivered ticket binding
  // is enough to disqualify a control-plane call on both hosts. This is
  // intentionally host-neutral: an unbound Codex subagent is still a
  // subagent, not the orchestrator. `ape_managed === false` remains the escape
  // for explicitly unmanaged host activity. isToolChannelEvent is
  // load-bearing: Stop/SubagentStop must keep carrying the receipt-bearing
  // final message.
  if (
    isToolChannelEvent(event) &&
    CONTROL_PLANE_TOOLS.test(event.tool_name) &&
    (event.is_subagent || Boolean(event.ticket_id)) &&
    event.ape_managed !== false
  ) {
    return {
      decision: 'deny',
      reason: 'APE control plane denied: the orchestrator owns ape_run/ape_config/ape_history; finish the ticket and return your receipt JSON as your final message',
    };
  }
  // Execution-redirecting out-of-project configuration (table and rationale
  // above). ONE SITE, ABOVE THE SEALED BRANCH, so running, blocked, gating,
  // shipping AND sealed are governed once — a sealed run's orphan still holds a
  // live shell, and a second copy of this rule below the seal would be a second
  // thing to keep in sync.
  //
  // THE TOOL-CHANNEL AND WRITE-TOOL TERMS ARE LOAD-BEARING AT THIS HEIGHT.
  // __tests__/runtime-v2-abort-quarantine.test.js requires a sealed run's bound
  // orphan out-of-project Write to stay ALLOW and its Stop event to stay allow,
  // and denying a lifecycle boundary eats the agent's receipt-bearing final
  // message (see isToolChannelEvent). For a non-matching tail — and for every
  // non-write tool and every boundary event — this branch is a strict no-op.
  //
  // IT BINDS EVERY BOUND TICKET, writable and read-only alike: a claim set
  // governs project paths and never `$HOME`, so a writable ticket holds no
  // authority out there either, and keying on the binding rather than the role
  // also keeps this refusal from being mistaken for the read-only deny it sits
  // above. The UNBOUND MAIN SESSION is deliberately exempt, and the cost is
  // stated rather than implied: the family is closed against a mistaken or
  // misaligned STAGE, not against a compromised orchestrator, which keeps an
  // unrestricted out-of-project write at the allow branch below.
  //
  // Both the UNRESOLVED target and the hook's realpath-RESOLVED one are
  // consulted. The resolved half is absent whenever the async precompute did not
  // run (every direct unit call into this policy), and its absence degrades to
  // the unresolved tail alone rather than failing either way.
  if (
    context.ticket &&
    event.out_of_project === true &&
    isToolChannelEvent(event) &&
    WRITE_TOOLS.has(event.tool_name)
  ) {
    const targetPairs = Array.isArray(event.targets) && event.targets.length > 0
      ? event.targets.map((target) => [target.target_path, target.resolved_target_path])
      : [[event.target_path, event.resolved_target_path]];
    let tail = null;
    for (const [unresolved, resolved] of targetPairs) {
      tail = executionConfigTail(unresolved) ?? executionConfigTail(resolved);
      if (tail) break;
    }
    if (tail) {
      return {
        decision: 'deny',
        // prose-bound-exempt: tail is the bounded basename of the inspected configuration path.
        reason: `APE write denied: \`${tail}\` is execution-redirecting tool CONFIGURATION, which a bound ticket may not write outside the project — such a file changes what an already-admitted evidence command (npm test, git status, the login shell) EXECUTES with no token on the command line. Ordinary out-of-project scratchpad writes are still admitted: keep using the scratchpad, under a filename that is not tool configuration`,
      };
    }
  }
  if (SEALED_STATUSES.has(context.state.status)) {
    if (
      context.ticket &&
      isToolChannelEvent(event) &&
      event.out_of_project !== true &&
      (WRITE_TOOLS.has(event.tool_name) ||
        ((event.tool_name === 'Bash' || event.tool_name === 'run_command') && SHELL_WRITE.test(event.command ?? '')) ||
        (external && external.effect !== 'read'))
    ) {
      return {
        decision: 'deny',
        // prose-bound-exempt: status is a fixed run-state enum.
        reason: `APE write denied: run is sealed ${context.state.status} and the subagent binding is void`,
      };
    }
    // prose-bound-exempt: status is a fixed run-state enum.
    return { decision: 'allow', reason: `APE run is sealed ${context.state.status}; host behavior is unchanged` };
  }
  if (!isToolChannelEvent(event)) {
    return { decision: 'allow', reason: 'lifecycle event is not a tool call; tool policy does not apply' };
  }
  if (
    (event.host === 'claude' || event.host === 'gemini') &&
    event.is_subagent &&
    event.ape_managed !== false &&
    !context?.ticket
  ) {
    // prose-bound-exempt: the helper returns one of the runtime's fixed binding diagnostics.
    return { decision: 'deny', reason: claudeBindingDenialReason(context?.claudeBindingDenialCause) };
  }
  if (external) {
    return externalToolPolicy(external, {
      state: context.state,
      ticket: context.ticket,
      isSubagent: event.is_subagent,
    });
  }
  if (event.tool_name === 'Bash' || event.tool_name === 'run_command') {
    const command = event.command ?? '';
    // A bound subagent must be able to run its evidence commands — a test
    // writer runs the narrow tests, an implementer runs a build/verify — but a
    // shell command's write effects cannot be proven before execution, so only a
    // recognized non-mutating evidence command is allowed; everything else fails
    // closed and production edits go through the path-checked host edit tool.
    if (context?.ticket) {
      // Deletion is its own channel and never falls through to the generic
      // evidence allow/deny: the policy is synchronous, so it consumes only
      // event.deletion, the per-target claims/role verdict precomputed with
      // realpath semantics by bin/ape-hook.mjs. A parsed deletion with no
      // precomputed verdict fails closed.
      if (parseDeletionCommand(command)) {
        if (!event.is_subagent) {
          return { decision: 'deny', reason: 'APE deletion denied: main-session production writes are forbidden' };
        }
        const ticket = context.ticket;
        if (context.state.status !== 'running') {
          // A blocked run fails closed on purpose — see the sealed-status
          // comment above — but 'no active writing run' while active.json
          // plainly holds one sends the operator hunting for a phantom;
          // naming the state and the audited exits is guidance, not a guard
          // relaxation. Sealed statuses already returned earlier, so
          // 'blocked' is the only live special case here.
          if (context.state.status === 'blocked') {
            return { decision: 'deny', reason: 'APE deletion denied: the run is blocked, so recovery is audited — REGATE for a gate block, otherwise OVERRIDE reset or ABORT — not a manual deletion' };
          }
          if (context.state.status === 'gating') {
            return { decision: 'deny', reason: 'APE deletion denied: the run is gating — the detached merge-gate suite is running and the tree is frozen until it lands; poll with ape_run next, or ABORT to abandon the gating run' };
          }
          return { decision: 'deny', reason: 'APE deletion denied: no active writing run' };
        }
        if (!ticket.writable) {
          // prose-bound-exempt: role is a fixed ticket-role enum.
          return { decision: 'deny', reason: `APE deletion denied: ${ticket.role} is read-only` };
        }
        if (event.deletion?.safe !== true) {
          return {
            decision: 'deny',
            // prose-bound-exempt: deletion.reason is produced by the bounded deletion precheck.
            reason: `APE deletion denied: ${event.deletion?.reason ?? 'target path safety was not verified'}`,
          };
        }
        // prose-bound-exempt: ticket_id is runtime-issued and schema-bounded.
        return { decision: 'allow', reason: `deletion authorized by ${ticket.ticket_id}` };
      }
      const commandProfile = matchingCommandProfile(event.project_dir, command);
      if (commandProfile) {
        if (!commandProfile.roles.includes(context.ticket.role)) {
          return {
            decision: 'deny',
            // prose-bound-exempt: profile id and role are validated configuration/schema identifiers.
            reason: `APE command profile denied: ${commandProfile.id} does not authorize role ${context.ticket.role}`,
          };
        }
        if (commandProfile.effect === 'write' && context.ticket.writable !== true) {
          return {
            decision: 'deny',
            // prose-bound-exempt: profile id and role are validated configuration/schema identifiers.
            reason: `APE command profile denied: read-only ${context.ticket.role} cannot run write profile ${commandProfile.id}`,
          };
        }
        return {
          decision: 'allow',
          // prose-bound-exempt: profile id and effect are validated configuration values.
          reason: `exact command profile ${commandProfile.id} authorizes ${commandProfile.effect} execution`,
        };
      }
      const unrecognized = {
        decision: 'deny',
        // prose-bound-exempt: EVIDENCE_COMMAND_FAMILIES is a fixed runtime policy description.
        reason: `APE write denied: a bound subagent may run only recognized non-mutating evidence commands (${EVIDENCE_COMMAND_FAMILIES}); production edits must use the host edit tool`,
      };
      // (0) The precomputed realpath-grade verdict. bin/ape-hook.mjs is async
      // and computes it beside the existing deletion/path_safe precomputes;
      // this policy is synchronous and only READS it. Consulted with the
      // `event.path_safe === false` idiom, NOT `deletion?.safe !== true`: an
      // ABSENT verdict must degrade to the lexical containment below rather
      // than blanket-deny, or every event that carries no project_dir — the
      // shape ~20 pre-existing arms use — would fail closed.
      //
      // cwd_safe is its own field and is consulted for EVERY bound evidence
      // command, including path-free ones: Claude's Bash tool keeps a
      // persistent shell whose cwd drifts on `cd`, every relative operand
      // resolves against THAT, and the lexical shortcut below is only sound
      // while cwd is inside the root. The catch-written failure verdict
      // ({tokens:null, safe:false, cwd_safe:false, reason}) lands here too, and
      // its reason is surfaced rather than swallowed.
      const verdict = event.evidence;
      if (verdict?.cwd_safe === false) {
        return {
          decision: 'deny',
          // prose-bound-exempt: the interpolated diagnostic is explicitly bounded.
          reason: `APE write denied: ${boundedToken(verdict.reason ?? 'the session working directory was not verified inside the governed project', DENY_REASON_MAX_CHARS)}`,
        };
      }
      if (verdict?.safe === false) {
        return {
          decision: 'deny',
          // prose-bound-exempt: the interpolated diagnostic is explicitly bounded.
          reason: `APE write denied: ${boundedToken(verdict.reason ?? 'an evidence operand was not verified inside the governed project', DENY_REASON_MAX_CHARS)}`,
        };
      }
      if (verdict?.executable_safe === false) {
        return {
          decision: 'deny',
          // prose-bound-exempt: the interpolated diagnostic is explicitly bounded.
          reason: `APE write denied: ${boundedToken(verdict.executable_reason ?? 'the evidence executable no longer matches the trusted run-start resolution', DENY_REASON_MAX_CHARS)}`,
        };
      }
      // (1)-(2) Refuse every shell metacharacter and every whitespace that is
      // not U+0020, then split. A null parse is an unrecognized command.
      const parsed = parseEvidenceCommand(command);
      if (!parsed) return unrecognized;
      // (3) EXACT-TOKEN head recognition, evidence table then lint table.
      const evidenceHead = recognizeEvidenceHead(parsed.tokens);
      const lintHead = evidenceHead > 0 ? 0 : recognizeLintHead(parsed.tokens);
      if (evidenceHead === 0 && lintHead === 0) return unrecognized;
      // Role-aware run-script tier. Fails closed on `!== true`, so a ticket
      // shape that omits `writable`, or carries a truthy non-boolean, lands in
      // the narrow tier.
      if (
        PACKAGE_MANAGER_HEAD.has(parsed.tokens[0]) &&
        parsed.tokens[1] === 'run' &&
        context.ticket.writable !== true
      ) {
        const admitted = declaredRunScripts(event.project_dir);
        if (!admitted.has(parsed.tokens[2])) {
          return {
            decision: 'deny',
            // prose-bound-exempt: token and admitted scripts are bounded; policy text is fixed.
            reason: `APE write denied: a read-only ticket may run \`<pm> run <script>\` only for a script this project declares, and ${boundedToken(parsed.tokens[2])} is not one of them (admitted here: ${renderAdmittedScripts(admitted)}); declare it with \`ape_config set policy.evidence_scripts\`, or run one of the recognized evidence commands (${EVIDENCE_COMMAND_FAMILIES}); production edits must use the host edit tool`,
          };
        }
      }
      // (4) CONTAINMENT — refuse the OPERAND, never the flag spelling. Applies
      // to the cd target and every token, for EVERY head: `pytest`,
      // `cargo test` and `npx vitest` relocate exactly as effectively as a
      // package manager does, and a re-gate placed inside the package-manager
      // branch was round 1a's bug shape.
      const containment = evidenceContainment(parsed, event.project_dir);
      if (!containment.safe) {
        return {
          decision: 'deny',
          // prose-bound-exempt: operand is explicitly bounded and policy text is fixed.
          reason: `APE write denied: no operand of an evidence command may name a path outside the governed project, and \`${boundedToken(containment.operand)}\` is not proven inside it — the refusal is on the PATH, not on any flag spelling (recognized evidence commands: ${EVIDENCE_COMMAND_FAMILIES})`,
        };
      }
      // (5) The surviving shape/tail gate. The command is re-gated with at most
      // one leading `cd <path> &&` prefix stripped, so a nested test root can
      // run its recognized runner; the stripped remainder faces the identical
      // evidence/write/chain checks. The LINT tail is vetted against
      // parsed.tokens instead — the same vector the head recognizer read — so
      // the gate and the tokenizer can never again disagree about what the
      // tokens are (round 5, site 2: `black . # --check`). The GIT tail is
      // vetted from parsed.tokens for the same reason (site 3), and takes the
      // FULL vector so it can answer `true` for a non-git head.
      const evidenceCommand = stripLeadingCd(command);
      if (
        ((evidenceHead > 0 && EVIDENCE_COMMAND.test(evidenceCommand) && gitEvidenceArgsSafe(parsed.tokens)) ||
          (lintHead > 0 &&
            !lintCommandMutates(parsed.tokens, lintHead) &&
            lintArgsSafe(parsed.tokens))) &&
        !SHELL_WRITE.test(evidenceCommand) &&
        !COMMAND_CHAIN.test(evidenceCommand)
      ) {
        return { decision: 'allow', reason: 'recognized non-mutating evidence command' };
      }
      return unrecognized;
    }
    if (!SHELL_WRITE.test(command)) return { decision: 'allow', reason: 'non-writing shell command' };
    if (!event.is_subagent) {
      // Fail-safe carve-out: when the SOLE reason this command matched
      // SHELL_WRITE is a redirect to exactly /dev/null it has no write effect
      // under any status, so allow it (status-independent). A real write
      // co-occurring with the /dev/null sink survives the strip and still fails
      // closed below; the bound-subagent arm is unaffected — its Bash is already
      // limited to the recognized evidence allowlist.
      if (onlyDevNullRedirects(command)) {
        return { decision: 'allow', reason: 'main-session shell command redirects only to /dev/null (no write effect)' };
      }
      // Message precision (roadmap hook-denial-message-precision): SHELL_WRITE
      // also matches commands that are NOT writes but that the guard cannot
      // prove are read-only — a compound `&&`-chain, a stderr redirect (`ls
      // 2>errs`), a quoted `>`, an inline interpreter — so the reason names
      // the fail-closed classification (invariant 2: no provable absence of a
      // write effect) instead of falsely asserting the command IS a write. This
      // is reason-only: the decision stays 'deny' and the denial set is
      // unchanged. Status-aware poll hint, mirroring the deletion-channel gating
      // message (hooks.js:439-441): the resting, tree-frozen watches that advance
      // only via `ape_run next` append it — 'gating' (the detached merge-gate
      // suite) and 'shipping' (the shipping-watch; NOT in SEALED_STATUSES, so it
      // reaches this arm rather than the sealed allow) — while 'running' has
      // nothing to poll and appends no hint.
      const status = context.state.status;
      let hint = '';
      if (status === 'gating') {
        hint = '; the detached merge-gate suite is running and the tree is frozen — poll with ape_run next';
      } else if (status === 'shipping') {
        hint = '; the run is shipping and the tree is frozen — poll with ape_run next';
      }
      return {
        decision: 'deny',
        // prose-bound-exempt: hint is selected from fixed runtime-owned strings.
        reason: `APE denied: main-session shell command is not provably read-only during an active run (fail-closed: cannot verify it has no write effect; invariant 2)${hint}`,
      };
    }
    return {
      decision: 'deny',
      reason: 'APE write denied: use the host edit tool so the ticket path can be verified before write',
    };
  }
  if (!WRITE_TOOLS.has(event.tool_name)) {
    if (
      event.is_subagent &&
      event.ape_managed !== false &&
      !SAFE_SUBAGENT_TOOLS.has(event.tool_name)
    ) {
      // prose-bound-exempt: tool_name is a host-defined bounded identifier.
      return { decision: 'deny', reason: `APE tool denied: indirect channel ${event.tool_name || 'unknown'} is not authorized` };
    }
    return { decision: 'allow', reason: 'explicitly safe non-writing tool' };
  }
  // A write whose target genuinely resolves outside the project root is outside
  // APE's governance (invariant 2 protects *production* paths). The flag is
  // precomputed by the async hook entrypoint with realpath semantics — a raw
  // out-of-project path whose realpath lands inside the project never sets it,
  // and a missing flag fails closed below, mirroring event.path_safe.
  if (event.out_of_project === true) {
    return { decision: 'allow', reason: 'target resolves outside the project root; APE governs only project writes' };
  }
  if (!context?.state || context.state.status !== 'running') {
    // A blocked run fails closed on purpose — see the sealed-status comment
    // above — but 'no active writing run' while active.json plainly holds one
    // sends the operator hunting for a phantom; naming the state and the
    // audited exits is guidance, not a guard relaxation. Sealed statuses
    // already returned earlier, so 'blocked' and the resting 'gating' state are
    // the live special cases (the resting 'shipping' state — persistable since
    // #261 — keeps the generic message).
    if (context?.state?.status === 'blocked') {
      return { decision: 'deny', reason: 'APE write denied: the run is blocked, so recovery is audited — REGATE for a gate block, otherwise OVERRIDE reset or ABORT — not a manual edit' };
    }
    if (context?.state?.status === 'gating') {
      return { decision: 'deny', reason: 'APE write denied: the run is gating — the detached merge-gate suite is running and the tree is frozen until it lands; poll with ape_run next, or ABORT to abandon the gating run' };
    }
    return { decision: 'deny', reason: 'APE write denied: no active writing run' };
  }
  if (!event.is_subagent) {
    return { decision: 'deny', reason: 'APE write denied: main-session production writes are forbidden' };
  }
  const files = Array.isArray(event.files) && event.files.length > 0
    ? event.files
    : event.file
      ? [event.file]
      : [];
  // A parsed multi-file patch is one atomic authorization decision. Any target
  // that could not be normalized inside the project must not disappear merely
  // because another target did normalize successfully.
  if (
    files.length === 0 ||
    (Array.isArray(event.targets) && event.targets.some((target) => !target.file))
  ) {
    return { decision: 'deny', reason: 'APE write denied: target path is missing or aliases a path inside the project' };
  }
  if (event.path_safe === false) {
    return { decision: 'deny', reason: 'APE write denied: target resolves outside the ticket claims' };
  }

  const ticket = context.ticket;
  if (!ticket) return { decision: 'deny', reason: 'APE write denied: subagent is not bound to an active ticket' };
  if (event.ticket_id && event.ticket_id !== ticket.ticket_id) {
    return { decision: 'deny', reason: 'APE write denied: lifecycle ticket does not match the active ticket' };
  }
  // prose-bound-exempt: role is a fixed ticket-role enum.
  if (!ticket.writable) return { decision: 'deny', reason: `APE write denied: ${ticket.role} is read-only` };
  if (
    ticket.role === 'test_writer'
    && files.some((file) => !withinTestScope(
      file,
      ticket.test_paths,
      ticket.test_scope === 'exact',
    ))
  ) {
    return { decision: 'deny', reason: 'APE write denied: test writers may modify only claimed test paths' };
  }
  if (ticket.role === 'implementer' && files.some((file) => looksLikeTest(file, ticket.test_paths))) {
    return { decision: 'deny', reason: 'APE write denied: implementers may not modify authored tests' };
  }
  if (ticket.role !== 'test_writer') {
    const unclaimed = files.find(
      (file) => !ticket.claimed_paths.some((claim) => withinClaim(file, claim)),
    );
    if (unclaimed) {
      // prose-bound-exempt: unclaimed is a normalized host-derived target path.
      return { decision: 'deny', reason: `APE write denied: ${unclaimed} is outside the ticket claims` };
    }
  }
  // Write-content byte gate (roadmap entry authored-and-agent-facing-byte-
  // integrity, WRITE side; see the WRITE_CONTENT_ROUTES comment above). This
  // is the LAST check IN THIS WRITE-TOOL BRANCH, narrowing only a write every
  // earlier rule in this branch already admits: the target path, claim, role
  // and scope are all proven safe by the point this is consulted, so a
  // hazard byte in CONTENT can only turn an otherwise-allowed write into a
  // denial, never widen any deny path above. This does NOT hold for the
  // out-of-project branch above (event.out_of_project === true returns allow
  // before this branch is ever reached): that write is EXEMPT from this gate
  // entirely, never narrowed by it, so a scratchpad or other out-of-project
  // write carries no content check at all (docs/hooks.md's own byte-gate
  // section states this same limit).
  // event.write_content_hazard is precomputed synchronously by
  // bin/ape-hook.mjs (evaluateWriteContentPolicy, exported above) beside the
  // deletion and evidence precomputes; an absent verdict (every direct unit
  // call into this policy, and any event the precompute has no reason to run
  // for) degrades to safe, exactly like event.path_safe's own absence
  // convention elsewhere in this function.
  //
  // CONSEQUENCE FOR A KNOWN FIXTURE, recorded rather than left for a future
  // agent to rediscover as a mystery denial: this gate is content-blind to
  // INTENT, so it denies any write through a ROUTED tool — Write, Edit,
  // MultiEdit, NotebookEdit, apply_patch (see WRITE_CONTENT_ROUTES above) —
  // whose payload LITERALLY carries a hazard code point, even where that byte
  // is the whole point of the edit. __tests__/runtime-v2-execution-config-case-folding
  // .test.js is exactly that case — it embeds literal soft-hyphen/zero-width/
  // bidi code points directly in its own source as FIXTURE DATA proving the
  // out-of-project case-folding guard against them (its own file-level
  // exemption from the tracked-source scan in
  // __tests__/runtime-v2-authored-byte-integrity.test.js says as much) — so
  // while it keeps those bytes typed literally, no bound subagent can touch
  // it through a host edit tool again: every Write/Edit/MultiEdit call
  // carrying one in `content`/`new_string` is denied here, with no escape
  // hatch, exactly the over-block hazard the roadmap entry warns a gate like
  // this one must not become. MAINTENANCE PATH: a future edit to that file
  // must stop typing the hazard code points literally in the tool payload
  // and instead build them the way the authored suites in __tests__ do —
  // `String.fromCodePoint(0x...)` inside the test source (never
  // `String.fromCharCode`, which cannot represent the astral TAGS members
  // this gate also refuses), so the BYTES the host edit tool transmits stay
  // ordinary ASCII and the hazard code point exists only once the test
  // runs, in memory, never in the diff this gate inspects. That is a
  // rewrite of that file's own fixture construction, out of scope for this
  // ticket (the file is not in claimed_paths), recorded here at the gate's
  // own site as the run objective requires.
  if (event.write_content_hazard?.safe === false) {
    // prose-bound-exempt: reason is produced by evaluateWriteContentPolicy's bounded label.
    return { decision: 'deny', reason: `APE write denied: ${event.write_content_hazard.reason}` };
  }
  // prose-bound-exempt: ticket_id is runtime-issued and schema-bounded.
  return { decision: 'allow', reason: `write authorized by ${ticket.ticket_id}` };
}

// Bounded native identity, mirroring the boundedIdentity check in
// lib/runtime/claude-dispatch.js (reimplemented locally: the dispatch module
// carries the Claude nonce/intent machinery this policy-only seam must not
// depend on).
function boundedStartIdentity(value, max = 512) {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

// SubagentStart handshake seam, host-neutral form. Validates a start-derived
// binding payload — an explicit ticket_id field or an APE_TICKET_ID-equivalent
// value the host event delivered (already normalized onto event.ticket_id) —
// with the same POLICY checks bindClaudeSubagent applies, minus the Claude
// nonce/intent machinery: (a) bounded native identity (agent_id and agent_type
// both non-empty strings ≤512 chars), (b) a running run, (c) a pending ticket
// (named in state.tickets, not expired, no receipt — pendingTicket semantics
// reimplemented locally so this stays a pure, synchronous evaluator), and
// (d) an unelapsed ticket deadline: a finite Date.parse(deadline_at) at or
// before the injectable clock `at` denies (inclusive <=, matching the
// scheduler's deadline-timeout predicate and the Claude launch handshake's
// deadline deny in claude-dispatch.js). Absent or unparseable deadlines
// deliberately fail OPEN via the Number.isFinite guard — deadline_at is
// schema-required on real tickets, so only synthetic fixtures lack one — not
// expired()'s unparseable-means-elapsed posture. It mints
// nothing and writes nothing: it answers only whether the host-delivered
// binding is one the runtime would accept, so a real Codex binding channel can
// later land as pure host wiring with no policy rework. Callers never invoke
// it without a binding payload — a start event with no binding has nothing to
// validate and must fall through unchanged (never fabricate a binding
// out-of-band; unbound writes keep failing closed downstream).
export function evaluateStartBinding(state, event, at = Date.now()) {
  const raw = event.raw ?? {};
  const agentId = raw.agent_id ?? raw.agentId;
  const agentType = raw.agent_type ?? raw.agentType;
  if (!boundedStartIdentity(agentId) || !boundedStartIdentity(agentType)) {
    return { valid: false, reason: 'APE start binding denied: malformed native identity' };
  }
  if (state?.status !== 'running') {
    // prose-bound-exempt: status is a fixed run-state enum.
    return { valid: false, reason: `APE start binding denied: run status is ${state?.status ?? 'unknown'}, not running` };
  }
  const ticketId = event.ticket_id;
  const ticket = state.tickets?.find((entry) => entry.ticket_id === ticketId);
  const pending =
    Boolean(ticket) &&
    !(state.expired_tickets ?? []).includes(ticketId) &&
    !state.receipts?.some((receipt) => receipt.ticket_id === ticketId);
  if (!pending) {
    return { valid: false, reason: 'APE start binding denied: ticket is not active and pending' };
  }
  const deadline = Date.parse(ticket.deadline_at ?? '');
  if (Number.isFinite(deadline) && deadline <= at) {
    return { valid: false, reason: 'APE start binding denied: ticket deadline elapsed' };
  }
  // prose-bound-exempt: ticketId is runtime-issued and schema-bounded.
  return { valid: true, reason: `APE start binding validated for ${ticketId}` };
}

export function formatHookResponse(event, result) {
  // Antigravity's JSON-hook protocol is camelCase on input but deliberately
  // uses small, event-specific top-level response objects. It does not consume
  // Claude's hookSpecificOutput envelope. PostToolUse is observational only;
  // Stop uses `continue` to keep a failed run alive for recovery.
  if (event.host === 'gemini') {
    if (event.event === 'PreToolUse') {
      return {
        decision: result.decision === 'allow' ? 'allow' : 'deny',
        // prose-bound-exempt: result.reason is emitted by bounded/fixed lifecycle policy diagnostics.
        ...(result.reason ? { reason: result.reason } : {}),
      };
    }
    if (event.event === 'PreInvocation') {
      const message = result.additional_context ?? (
        result.decision === 'deny' ? result.reason : null
      );
      return message
        ? { injectSteps: [{ ephemeralMessage: message }] }
        : {};
    }
    if (event.event === 'Stop') {
      return result.decision === 'allow'
        ? { decision: 'stop' }
        : {
            decision: 'continue',
            // prose-bound-exempt: result.reason is emitted by bounded/fixed lifecycle policy diagnostics.
            reason: result.reason,
          };
    }
    return {};
  }
  if (event.event === 'SubagentStart') {
    if (result.additional_context) {
      return {
        hookSpecificOutput: {
          hookEventName: event.event,
          additionalContext: result.additional_context,
        },
      };
    }
    if (result.decision === 'allow') return {};
    // Claude can reject a subagent at this boundary. Codex 0.145 parses
    // `continue: false` for compatibility but explicitly does not stop the
    // subagent, so surface the failure and rely on the identity-bound
    // PreToolUse gate to deny every subsequent write.
    return event.host === 'claude'
      // prose-bound-exempt: result.reason is emitted by the policy's bounded/fixed diagnostic paths.
      ? { decision: 'block', reason: result.reason }
      : { systemMessage: result.reason };
  }
  // permissionDecision is honored only on PreToolUse. Post events use the
  // top-level block shape because their side effect has already occurred.
  if (event.event === 'PreToolUse') {
    // Codex accepts permissionDecision: "allow" only when the hook also
    // supplies updatedInput to rewrite the call. APE never rewrites inputs, so
    // ordinary Codex success must be neutral JSON; emitting "allow" without
    // updatedInput makes Codex report the hook run as failed. Claude supports
    // the explicit allow shape and keeps it for its existing contract.
    if (event.host === 'codex' && result.decision === 'allow') return {};
    return {
      hookSpecificOutput: {
        hookEventName: event.event,
        permissionDecision: result.decision === 'allow' ? 'allow' : 'deny',
        permissionDecisionReason: result.reason,
      },
    };
  }
  if (result.decision === 'allow') return {};
  // prose-bound-exempt: result.reason is emitted by the policy's bounded/fixed diagnostic paths.
  return { decision: 'block', reason: result.reason };
}

// ---------------------------------------------------------------------------
// Stop/SubagentStop draft receipt validation
// ---------------------------------------------------------------------------
// Schema-guided validation at the Stop/SubagentStop lifecycle boundary.
// Returns bounded corrections to the same agent on the first attempt,
// allows the stop after MAX_VALIDATION_ATTEMPTS, and marks infrastructure
// failure when no valid draft was observed at SubagentStop. Pure, synchronous,
// host-neutral (same path for Claude, Codex, and Gemini).
//
// CIRCULAR DEPENDENCY NOTE: validateReceiptDraft lives in receipt-validator.js,
// but importing it here creates a cycle:
//   lifecycle-policy.js -> receipt-validator.js -> schemas.js ->
//   plan-contract.js -> lifecycle-policy.js
// The stop-validation seam therefore inlines a self-contained draft validator
// (validateDraftForStop) that covers the same common-field checks without any
// import from receipt-validator.js. Role-specific evidence checks (verdict,
// candidate_plan, artifact) are not needed at the stop boundary — they are
// enforced by the authoritative recordReceiptLocked path.

const MAX_VALIDATION_ATTEMPTS = 2;
const STOP_VALID_STATUSES = new Set(['passed', 'failed']);
const STOP_CORRECTIONS_CAP = 20;

function pushStopCorrection(corrections, field, issue, correction) {
  if (corrections.length < STOP_CORRECTIONS_CAP) {
    corrections.push({ field, issue, correction });
  }
}

// Self-contained draft validation for the stop boundary, mirroring the
// common-field checks in receipt-validator.js's validateReceiptDraft. Pure,
// synchronous, non-mutating — never replaces the authoritative receipt
// recording validation.
function validateDraftForStop(ticket, draft) {
  const corrections = [];

  if (!draft || typeof draft !== 'object' || Array.isArray(draft)) {
    pushStopCorrection(corrections, 'receipt', 'draft must be a plain object',
      'return a JSON object with ticket_id, status, tests, findings, and evidence');
    return { valid: false, corrections };
  }

  // ticket_id
  if (draft.ticket_id === undefined || draft.ticket_id === null) {
    pushStopCorrection(corrections, 'ticket_id', 'ticket_id is missing',
      `set ticket_id to "${ticket.ticket_id}"`);
  } else if (typeof draft.ticket_id !== 'string' || draft.ticket_id === '') {
    pushStopCorrection(corrections, 'ticket_id', 'ticket_id must be a non-empty string',
      `set ticket_id to "${ticket.ticket_id}"`);
  } else if (draft.ticket_id !== ticket.ticket_id) {
    pushStopCorrection(corrections, 'ticket_id',
      `ticket_id "${draft.ticket_id}" does not match the ticket`,
      `set ticket_id to "${ticket.ticket_id}"`);
  }

  // status
  if (draft.status === undefined || draft.status === null) {
    pushStopCorrection(corrections, 'status', 'status is missing',
      'set status to "passed" or "failed"');
  } else if (typeof draft.status !== 'string') {
    pushStopCorrection(corrections, 'status', 'status must be a string',
      'set status to "passed" or "failed"');
  } else if (!STOP_VALID_STATUSES.has(draft.status)) {
    pushStopCorrection(corrections, 'status',
      `status "${draft.status}" is not a valid value`,
      'set status to "passed" or "failed"');
  }

  // tests
  if (draft.tests === undefined || draft.tests === null) {
    pushStopCorrection(corrections, 'tests', 'tests is missing',
      'set tests to an array of test result objects');
  } else if (!Array.isArray(draft.tests)) {
    pushStopCorrection(corrections, 'tests', 'tests must be an array',
      'set tests to an array of test result objects');
  } else {
    for (let i = 0; i < draft.tests.length; i++) {
      const test = draft.tests[i];
      if (!test || typeof test !== 'object' || Array.isArray(test)) {
        pushStopCorrection(corrections, `tests[${i}]`, 'test entry must be an object',
          'provide an object with command, passed, exit_code, duration_ms');
        continue;
      }
      if (typeof test.command !== 'string' || test.command === '') {
        pushStopCorrection(corrections, `tests[${i}].command`,
          'command must be a non-empty string',
          'set command to the test command that was executed');
      }
      if (typeof test.passed !== 'boolean') {
        pushStopCorrection(corrections, `tests[${i}].passed`, 'passed must be a boolean',
          'set passed to true or false');
      }
      if (typeof test.exit_code !== 'number' || !Number.isInteger(test.exit_code)) {
        pushStopCorrection(corrections, `tests[${i}].exit_code`,
          'exit_code must be an integer', 'set exit_code to the integer exit code');
      }
      if (typeof test.duration_ms !== 'number' || test.duration_ms < 0) {
        pushStopCorrection(corrections, `tests[${i}].duration_ms`,
          'duration_ms must be a non-negative number',
          'set duration_ms to the test duration in milliseconds');
      }
    }
  }

  // findings
  if (draft.findings === undefined || draft.findings === null) {
    pushStopCorrection(corrections, 'findings', 'findings is missing',
      'set findings to an array (empty array if no findings)');
  } else if (!Array.isArray(draft.findings)) {
    pushStopCorrection(corrections, 'findings', 'findings must be an array',
      'set findings to an array of finding objects');
  }

  // evidence
  if (draft.evidence === undefined || draft.evidence === null) {
    pushStopCorrection(corrections, 'evidence', 'evidence is missing',
      'set evidence to an object with at least a summary field');
  } else if (typeof draft.evidence !== 'object' || Array.isArray(draft.evidence)) {
    pushStopCorrection(corrections, 'evidence',
      'evidence must be a plain object, not an array',
      'set evidence to an object with at least a summary field');
  }

  return {
    valid: corrections.length === 0,
    corrections: corrections.slice(0, STOP_CORRECTIONS_CAP),
  };
}

/**
 * Evaluates a Stop or SubagentStop event for draft receipt validation.
 * @param {{ host: string, event: string, tool_name: string, is_subagent: boolean }} event
 * @param {{ state: object, ticket: object, draft?: object, validation_attempts?: number, valid_draft_observed?: boolean }} context
 * @returns {{ decision: string, corrections?: Array, infrastructure_failure?: boolean }}
 */
export function evaluateStopValidation(event, context) {
  const ticket = context?.ticket;
  const draft = context?.draft;
  const attempts = context?.validation_attempts ?? 0;

  // SubagentStop with no valid draft observed: mark infrastructure failure
  // so the parent can record an explicit machine-readable failure rather than
  // silently completing with a malformed or missing receipt.
  if (event.event === 'SubagentStop' && context?.valid_draft_observed === false && !draft) {
    return { decision: 'allow', infrastructure_failure: true };
  }

  // No draft to validate: allow the stop
  if (!draft || !ticket) {
    return { decision: 'allow' };
  }

  // Validate the draft against the ticket using the inlined validator
  // (avoids the circular dependency with receipt-validator.js).
  const result = validateDraftForStop(ticket, draft);

  // Valid draft: allow the stop
  if (result.valid) {
    return { decision: 'allow' };
  }

  // After MAX_VALIDATION_ATTEMPTS correction rounds, allow regardless
  // to avoid wedging the agent in an infinite correction loop.
  if (attempts >= MAX_VALIDATION_ATTEMPTS) {
    return { decision: 'allow' };
  }

  // Invalid draft on first attempts: return corrections and continue
  return {
    decision: 'continue',
    corrections: result.corrections,
  };
}
