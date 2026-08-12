import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { evaluateLifecyclePolicy } from '../lib/runtime/hooks.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { currentTreeSha } from '../lib/runtime/git.js';
import { atomicWriteJson } from '../lib/runtime/storage.js';

// Roadmap entry readonly-out-of-project-tool-config-write, and three of the four
// entries in the execution-config cluster that follows it
// (readonly-tool-config-suite-comment-drift,
// execution-config-table-uncovered-peers,
// execution-config-symlink-rationale-inverted). The fourth,
// execution-config-case-folding-vs-tolowercase, is the non-ASCII half of the
// same compare and lives in
// __tests__/runtime-v2-execution-config-case-folding.test.js.
//
// THE DEFECT. lib/runtime/hooks.js returns `allow` for `event.out_of_project
// === true` BEFORE `if (!ticket.writable) return deny`, so a bound READ-ONLY
// subagent may write any file outside the governed project. Writing
// `$HOME/.npmrc` with `script-shell=<binary>` changes what the admitted
// `npm test` executes with NO token anywhere on the command line — invisible to
// every command-string check, including the operand containment shipped in
// acme PR #368. Sources: spike run-fixture-e9d0b87e839d receipt c0b04edd
// finding 2-RESIDUAL R2, security receipt cb0109c4.
//
// THE SHAPE OF THE FIX THESE ARMS PIN — and, as importantly, the shape they
// REFUSE. Reordering the out-of-project allow behind the read-only deny is
// REJECTED: the Claude host injects a per-session scratchpad directive telling
// subagents — read-only roles included — to write temp files OUTSIDE the
// project, so a blanket deny breaks every role that obeys it. The refusal is
// TARGET-SHAPED: it refuses the specific out-of-project targets that REDIRECT
// EXECUTION of an already-admitted evidence command, and keeps ordinary
// out-of-project scratchpad writes admitted. Concretely:
//
//   KEYED ON FILENAME, content-blind. The lowercased final path SEGMENT (or the
//   final two segments) decides. Content is not consulted: a monotone
//   deny-on-presence rule is the only shape this gate is allowed to grow (see
//   the monotonicity constraint above gitEvidenceArgsSafe in
//   lib/runtime/hooks.js), and the rule sees exactly the tools whose payload
//   exposes a path AND that the host matcher fires on — every other write shape
//   (an apply_patch payload exposing no path, for one) is ALREADY fail-closed
//   because extractPath yields null, out_of_project is never computed, and the
//   write dies at "target path is missing or aliases a path inside the project".
//
//   ONE SITE, ABOVE THE SEALED BRANCH, so running, blocked, gating AND sealed
//   are governed once. That hoist sits on top of pins in files this run does not
//   claim (__tests__/runtime-v2-abort-quarantine.test.js requires a sealed run's
//   bound orphan out-of-project Write to stay ALLOW, and its Stop event to stay
//   allow), so the refusal MUST also carry the tool-channel and write-tool
//   terms; the guards below re-pin both locally.
//
//   A PURE NARROWING of one allow branch, gated on `out_of_project === true`.
//   No in-project verdict changes and nothing denied today becomes allowed.
//
//   SEGMENTS, NEVER A STRING SUFFIX. `endsWith('git/config')` also matches
//   every `<anything>/.git/config` and `legacy-git/config`; `endsWith(
//   '.cargo/config.toml')` matches `vendor.cargo/config.toml`. Same
//   separator-blocklist class this gate has already been bitten by; the guards
//   below discriminate it. Lowercasing is load-bearing (APFS is
//   case-insensitive, so `$HOME/.NPMRC` IS `$HOME/.npmrc`). The NON-ASCII half
//   of that same compare — a case-FOLDED spelling the filesystem resolves and
//   `toLowerCase` does not — is a family of its own and lives in
//   __tests__/runtime-v2-execution-config-case-folding.test.js.
//
//   BOTH LOOKUPS ARE REQUIRED, AND NEITHER SUBSUMES THE OTHER. The refusal
//   consults the RAW target and the hook's realpath-RESOLVED target, and the two
//   catch OPPOSITE symlink layouts — the RAW half catches a dotfile manager's
//   `$HOME/.cargo -> <store>/cargo` (resolution ERASES the match, because the
//   resolved tail is `cargo/config.toml`, which is in no table), the RESOLVED
//   half catches the mirror layout where an ordinary-named path resolves ONTO a
//   covered directory. Both directions carry an end-to-end arm at the bottom of
//   this file, and the RAW arm is paired with an ADMIT arm on the store path
//   itself so the erasure is a pinned fact rather than an assertion.
//
// WHAT THIS DOES NOT CLOSE — pinned as such at the bottom of this file so the
// closure claim cannot silently over-read its own diff: PATH shadowing, the
// BASH_ENV/ENV env-var half of the shell-startup family, and the codex R6
// fallthrough (the bound-subagent Bash allowlist lives inside
// `event.host === 'claude' && context?.ticket`, so `npm config set script-shell`
// — which names the same file with no path in any tool payload — is refused on
// the Claude arm and reaches nothing at all on the codex one). The WRITE-TOOL
// channel this file pins is host-NEUTRAL; the COMMAND channel is not. A host
// config directory relocated by CLAUDE_CONFIG_DIR/CODEX_HOME is outside it too,
// because the host-agent entries key on the directory NAME; that is guarded
// below as an ADMIT arm rather than quietly over-matched.
//
// THE TABLE IS AN ENUMERATION, NOT A CONSTRUCTION, so the one list below is the
// suite's whole statement about what is covered, and the PARITY arm makes that
// statement MECHANICAL: it re-reads the two Sets shipped in lib/runtime/hooks.js
// and the covered-tails list published in docs/hooks.md, and requires all three
// to be the same set. That is the check the previous revision of this file only
// claimed in prose while keeping a second list beside the first — six shipped
// tails sat in a list labelled "not covered yet", the exhaustiveness comment was
// false, and the writable-ticket arm iterated only the first list, so six tails
// were pinned for a read-only ticket and for no writable one.
//
// ARM CLASSIFICATION (an ADMIT arm is green before and after and can never be
// "verified red"; saying otherwise is the over-claim this surface keeps
// producing):
//   RED   — defect pins. Deny expected; ALLOW today. RE-DERIVED AT THIS TREE,
//           not left describing the tree the file was first authored against:
//           the cluster's first twenty-eight tails (pylint's two, prettier's
//           whole search list, eslint's six flat-config spellings and the two
//           CLAUDE plugin manifests) and all four prose arms of
//           execution-config-symlink-rationale-inverted have LANDED and are
//           green now. What is red here is exactly: the EIGHT tails this ticket
//           adds — `.codex-plugin/plugin.json` and mocha's seven documented
//           `.mocharc.*` spellings, each marked RED below — the two parity arms
//           that require the shipped Sets and the published docs list to carry
//           them, and the rationale arm that requires docs/hooks.md to ARGUE the
//           two heads they belong to.
//   GREEN — over-block regression guards and already-shipped coverage. Green
//           before AND after; the whole risk of this change is false blocks, and
//           a rule that refuses writes near $HOME is exactly the shape that can
//           strand a subagent's own scratchpad.
//
// HARD FIXTURE RULE. No arm writes, creates, truncates or appends to ANY file
// under $HOME, and no arm writes a tool-config file anywhere. The unit arms are
// pure calls into the synchronous decision function with literal paths that are
// never touched on disk; the end-to-end arms are PreToolUse permission checks,
// which decide and write nothing, against os.tmpdir fixtures. The symlink
// fixtures point at empty DIRECTORIES named `.cargo` / `cargo` — no
// `config.toml` is ever created — so nothing on this machine's real toolchain is
// reachable from here.

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const hookBinary = path.join(root, 'bin', 'ape-hook.mjs');
const cleanups = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

// A lexically-outside home. Never created, never written: every unit arm below
// is a pure decision-function call.
const HOME = '/outside/home';

// THE ONE LIST. Every tail this suite pins, as final path SEGMENTS, single- and
// two-segment together. The parity arm below requires this list to equal the
// union of the two Sets in lib/runtime/hooks.js AND the covered-tails list
// docs/hooks.md publishes — exactly, in both directions — so an entry cannot be
// dropped from the implementation with the suite green and the doc still
// advertising it, an entry cannot be shipped with no arm, and this list cannot
// drift into describing a tree that no longer exists. Every tail named here must
// deny for a bound ticket of EITHER kind.
//
// The host-agent entries are pinned like any other rather than left to the build
// to disclose — the Claude settings file under $HOME declares PreToolUse hook
// COMMANDS (arbitrary execution on every tool call, and the one file that can
// disable this very gate) and the codex config.toml is its peer, which makes
// them the highest-value entries in the table, not the most optional.
const COVERED_TAILS = [
  // ---- package-manager / runtime tool config: these CONFIGURE an admitted head.
  '.npmrc',
  'npmrc',
  '.yarnrc',
  '.yarnrc.yml',
  '.bunfig.toml',
  // read-only git IS an admitted evidence family, and core.pager, aliases and
  // core.hooksPath each redirect an admitted `git status`.
  '.gitconfig',
  // ---- shell startup: these REDEFINE an admitted head rather than configure it.
  // The bash trio is in bash's OWN order — it runs the first EXISTING of
  // .bash_profile, .bash_login, .profile — so the middle entry is the one that
  // actually runs on a machine without the first.
  '.bashrc',
  '.bash_profile',
  '.bash_login',
  '.profile',
  '.zshrc',
  '.zshenv',
  '.zprofile',
  '.zlogin',
  '.envrc',
  // ---- python: imported by `site` at interpreter start, the admitted
  // `python -m pytest` included. sitecustomize when it lands anywhere on
  // sys.path; usercustomize from the user site directory whenever user site is
  // enabled, which is the stronger of the two.
  'sitecustomize.py',
  'usercustomize.py',
  // ---- check-only linters that IMPORT ARBITRARY CODE from a user-level config.
  // `mypy` is an admitted head and its config's `plugins =` key imports
  // arbitrary Python; with no project config mypy falls back to
  // $XDG_CONFIG_HOME/mypy/config, ~/.config/mypy/config and ~/.mypy.ini.
  '.mypy.ini',
  // `pylint` is an admitted check-only head on exactly the same footing as
  // `mypy`, and its `load-plugins =` key imports arbitrary Python. It reads
  // ~/.pylintrc and ~/.config/pylintrc (the pair entry below) when the project
  // ships no config.
  // It was named at residual R2 in docs/hooks.md and left out on the stated
  // ground that "its tails carry no arm in the authored suite and the shipped
  // table is kept 1:1 with those arms; the tail and its arm land together" —
  // this is that arm, so the ground is spent.
  '.pylintrc',
  // `prettier` is an admitted check-only head too, and its cosmiconfig search
  // walks UP from the linted file to $HOME, so a user-level config governs a
  // project that ships none. `plugins` imports arbitrary modules in ALL of these
  // spellings, and the .js/.mjs/.cjs AND .ts/.mts/.cts forms ARE arbitrary
  // modules.
  //
  // EXHAUSTIVE OVER prettier.io/docs/configuration, WITH THE ONE OMISSION NAMED.
  // The list is every documented search place except the `prettier` KEY of a
  // package.json/package.yaml, which is deliberately not covered — refusing every
  // out-of-project package.json is an over-block this suite guards against below
  // — and that residual is published rather than implied. The previous revision
  // of this comment claimed exactly that while the six TypeScript spellings were
  // missing, so the claim was false and, because this list is the parity source
  // of truth, the omission propagated into the shipped tables and the published
  // docs list.
  '.prettierrc',
  '.prettierrc.json',
  '.prettierrc.json5',
  '.prettierrc.yml',
  '.prettierrc.yaml',
  '.prettierrc.toml',
  '.prettierrc.js',
  '.prettierrc.mjs',
  '.prettierrc.cjs',
  'prettier.config.js',
  'prettier.config.mjs',
  'prettier.config.cjs',
  // The TypeScript spellings — RED in the PREVIOUS cycle of this cluster and
  // GREEN at this tree, where the header's re-derivation already counts them
  // among the tails that have landed. They are in on exactly the ground that
  // admitted their .js/.mjs/.cjs siblings listed directly above: they are
  // arbitrary MODULES, prettier documents them as search places, and a host with
  // prettier >= 3.5 loads them. Leaving them out left a trivially equivalent
  // bypass of entries that ARE covered — the same argument this table already
  // makes for shipping `.cargo/config` beside `.cargo/config.toml`.
  '.prettierrc.ts',
  '.prettierrc.mts',
  '.prettierrc.cts',
  'prettier.config.ts',
  'prettier.config.mts',
  'prettier.config.cts',
  // `eslint` is an admitted check-only head on the identical footing to
  // `prettier` (both are named in EVIDENCE_COMMAND_FAMILIES and in every issued
  // ticket objective), and its flat config is IMPORTED as a module.
  //
  // THE SEARCH ORIGIN, RESTATED PRECISELY (the previous revision of this comment
  // had it wrong in a way that flattered the conclusion, and the revision after
  // that named a CLI option ESLint does not ship). ESLint 9 searches from the
  // CURRENT WORKING DIRECTORY by default and walks ancestors upward; starting
  // from the directory of the FILE BEING LINTED is what the
  // `v10_config_lookup_from_file` feature flag (earlier
  // `unstable_config_lookup_from_file`, renamed in 9.30) opts into — a FLAG, set
  // with `--flag v10_config_lookup_from_file` or `ESLINT_FLAGS`, not an option
  // of its own — and it is the DEFAULT only from ESLint 10, where the flag
  // itself was removed. The security conclusion is UNCHANGED, which is why the
  // entries do not move: NEITHER origin has a project-root stop, both walk to
  // the filesystem root, and the cwd of an evidence command is inside the
  // governed project, which lives under the home directory — so a config planted
  // at `$HOME` governs this project, which ships none. These six are the whole
  // flat-config search list.
  //
  // NOT in this list, named rather than left implied: the LEGACY `.eslintrc.*`
  // family. ESLint 9 does not load it unless `ESLINT_USE_FLAT_CONFIG` is set to
  // false, so it is a version-gated surface with a derivation of its own, and
  // covering it is a decision to take on that evidence rather than to smuggle in
  // behind this one.
  'eslint.config.js',
  'eslint.config.mjs',
  'eslint.config.cjs',
  'eslint.config.ts',
  'eslint.config.mts',
  'eslint.config.cts',
  // RED (this ticket). `mocha` is an admitted head in TWO positions — bare, and
  // after npx/pnpm/yarn/bun — and it resolves its rc file with exactly the
  // find-up walk that earned `eslint` and `prettier` their places: mocha looks in
  // the cwd and, failing that, "will search parent directories until one is found
  // or the filesystem root is reached" (mochajs.org/running/configuring). No
  // project-root stop, so a file at the home directory governs every project
  // below it that ships none — and this repository ships none.
  //
  // Leaving mocha out was not a judgment that it is harmless; it made the
  // STRENGTHENED completeness claim in docs/hooks.md ("every admitted head left
  // OUT of the enumeration is named in the residuals") false, because mocha was
  // in neither the table nor the residuals.
  //
  // ALL SEVEN SPELLINGS, not only the three that are JavaScript. `.mocharc.cjs`,
  // `.mocharc.js` and `.mocharc.mjs` are MODULES mocha loads. The YAML and JSON
  // spellings are data — and reach arbitrary execution anyway, because a config
  // file may set ANY command-line option and `require` names a module loaded
  // before the test files, so `{"require": "<path>"}` in `.mocharc.json` runs
  // arbitrary code exactly as `plugins` does from prettier's `.prettierrc.json`.
  // Shipping the module spellings and omitting the data ones would be the
  // trivially equivalent bypass this table already refuses for `.cargo/config`
  // beside `.cargo/config.toml` and for `.prettierrc.ts` beside `.prettierrc.js`.
  //
  // The order below is mocha's own documented PRIORITY order, so the list can be
  // diffed against its source. NOT in it, named rather than left implied: the
  // `mocha` KEY of a package.json (the same residual, for the same over-block
  // reason, as prettier's `prettier` key) and the extension-less `.mocharc`,
  // which mocha does not search for at all — the guards below keep both
  // ADMITTED.
  '.mocharc.cjs',
  '.mocharc.js',
  '.mocharc.mjs',
  '.mocharc.yaml',
  '.mocharc.yml',
  '.mocharc.jsonc',
  '.mocharc.json',
  // ---- host-agent configuration: ~/.claude.json declares MCP servers by
  // `command`.
  '.claude.json',
  // ---- two-segment (XDG, cargo, host-agent and plugin) tails. A bare `config`,
  // `config.toml`, `settings.json`, `env`, `pylintrc`, `plugin.json` or
  // `marketplace.json` is far too ordinary a scratch filename to refuse on its
  // own, so each is keyed on the directory that gives it meaning — and the
  // guards below pin that every one of those bare spellings stays ADMITTED.
  'npm/npmrc',
  'git/config',
  'mypy/config',
  '.cargo/config.toml',
  '.cargo/config',
  'go/env',
  // pylint's XDG location.
  '.config/pylintrc',
  '.claude/settings.json',
  '.claude/settings.local.json',
  '.codex/config.toml',
  // THE PLUGIN MANIFEST SURFACE, which reaches arbitrary execution through the
  // SAME mechanism that justifies covering .claude/settings.json and
  // ~/.claude.json: a plugin manifest NAMES A PROGRAM the host then runs — the
  // hook file whose contents declare PreToolUse hook COMMANDS, or an mcpServers
  // entry's `command`. This repository is itself registered exactly that way, on
  // BOTH hosts: .claude-plugin/plugin.json here carries `"hooks":
  // "./hooks/claude-hooks.json"`, .claude-plugin/marketplace.json is the
  // manifest by which it is installed, and .codex-plugin/plugin.json — shipped
  // in this very tree — declares `mcpServers.ape.command` =
  // `./dist/ape-mcp.bundle.mjs`.
  //
  // RED (this ticket) for the CODEX manifest, and it is a REGRESSION AGAINST THE
  // PLAN rather than a new idea: the plan specified covering both manifests and
  // the build shipped .claude-plugin/marketplace.json in its place. It meets the
  // host-agent entries' OWN stated criterion — "declares MCP servers by
  // `command`" — literally, so covering the Claude pair alone was a
  // host-SPECIFIC closure advertised as a host-neutral one, and the table's own
  // "trivially equivalent bypass of entries that ARE covered" argument (used for
  // .cargo/config beside .cargo/config.toml, and for .prettierrc.ts beside
  // .prettierrc.js) applies verbatim. Invariant 6 is the reason this cannot be
  // dispositioned as a residual: a rule that closes the Claude manifest and
  // leaves the codex one open is host policy in a host-neutral runtime.
  //
  // The hook FILE and the command BINARY a manifest points at are arbitrarily
  // NAMED by the manifest, so neither can be enumerated; the manifests that name
  // them can be, which is why these three entries are the manifests and not the
  // files they point at (the residual arms below assert both holes). Plugin
  // ENABLEMENT needs no new entry: it lives in the already-covered
  // .claude/settings.json and ~/.claude.json.
  //
  // WITH ONE FORM EXCEPTED, and it is a NARROWING of the sentence above rather
  // than a hole in it. lib/runtime/plugin-validation.js's validateCodexPlugin
  // normalizes a STRING mcpServers companion and errors unless it is exactly
  // .mcp.json, so for THAT one form the filename is fixed rather than arbitrary.
  // The pin binds APE's OWN validator and NOT what a host loads from a manifest
  // an attacker overwrote, and it reaches nothing else: a string mcpServers on
  // the CLAUDE side goes through validateComponentPaths with NO name pin, and
  // every INLINE mcpServers object names its own command freely — which is the
  // form this tree's .codex-plugin/plugin.json actually uses, so the name-pinned
  // string companion is a form nothing here ships. A flat "the companion is
  // name-pinned" would overstate the tree in the other direction. .mcp.json is
  // therefore RECORDED as a residual in docs/hooks.md and is deliberately not a
  // row below; the A1 arms at the bottom of this file pin that resolution and
  // state why COVER is infeasible under any claim set that does not also claim
  // dist/.
  '.claude-plugin/plugin.json',
  '.claude-plugin/marketplace.json',
  '.codex-plugin/plugin.json',
];

const readOnlyTicket = Object.freeze({
  ticket_id: 'run-1:review:r',
  role: 'reviewer',
  writable: false,
  claimed_paths: [],
  test_paths: ['__tests__'],
});

const writableTicket = Object.freeze({
  ticket_id: 'run-1:build:b',
  role: 'implementer',
  writable: true,
  claimed_paths: ['lib'],
  test_paths: ['__tests__'],
});

// The refusal must be SELF-EXPLAINING. A subagent that reads a bare "APE write
// denied" near $HOME concludes its scratchpad is gone and stops using it, so the
// reason has to name execution-redirecting CONFIGURATION as the refused thing
// and say that ordinary out-of-project scratchpad writes remain admitted.
const REFUSES_TOOL_CONFIG = /configur/i;
const OUT_OF_PROJECT_ALLOW = /outside the project root/;

function outsideWrite(tail, overrides = {}) {
  return {
    host: 'claude',
    event: 'PreToolUse',
    tool_name: 'Write',
    is_subagent: true,
    ape_managed: true,
    file: null,
    target_path: `${HOME}/${tail}`,
    out_of_project: true,
    ...overrides,
  };
}

const running = { status: 'running' };

describe('RED — an out-of-project write that redirects execution is refused for a BOUND ticket', () => {
  it('refuses every covered tool-config, shell-startup, linter and plugin-manifest tail for a bound read-only ticket', () => {
    for (const tail of COVERED_TAILS) {
      const result = evaluateLifecyclePolicy(
        outsideWrite(tail),
        { state: running, ticket: readOnlyTicket },
      );
      expect(result.decision, `${HOME}/${tail}`).toBe('deny');
      expect(result.reason, `${HOME}/${tail}`).toMatch(REFUSES_TOOL_CONFIG);
    }
  });

  it('refuses the SAME list for a bound WRITABLE ticket (the refusal binds the BINDING, not the role)', () => {
    // A claim set governs project paths and never $HOME, so a writable ticket
    // holds no authority out there either. This is also what keeps the refusal
    // from being mistaken for the read-only deny it sits above. It iterates the
    // ONE list, so no tail can be pinned for one ticket kind and not the other.
    for (const tail of COVERED_TAILS) {
      const result = evaluateLifecyclePolicy(
        outsideWrite(tail),
        { state: running, ticket: writableTicket },
      );
      expect(result.decision, `${HOME}/${tail}`).toBe('deny');
      expect(result.reason, `${HOME}/${tail}`).toMatch(REFUSES_TOOL_CONFIG);
      expect(result.reason, `${HOME}/${tail}`).not.toMatch(/is read-only/);
    }
  });

  it('matches the final segments case-insensitively (APFS is case-insensitive)', () => {
    for (const tail of [
      '.NPMRC',
      '.ZSHRC',
      '.BashRC',
      '.Cargo/Config.toml',
      'NPM/NPMRC',
      '.PylintRC',
      '.PrettierRC',
      'Prettier.Config.JS',
      '.PrettierRC.TS',
      'ESLint.Config.MJS',
      '.Claude-Plugin/Plugin.JSON',
      '.MochaRC.CJS',
      '.Codex-Plugin/Plugin.JSON',
    ]) {
      const result = evaluateLifecyclePolicy(
        outsideWrite(tail),
        { state: running, ticket: readOnlyTicket },
      );
      expect(result.decision, `${HOME}/${tail}`).toBe('deny');
      expect(result.reason, `${HOME}/${tail}`).toMatch(REFUSES_TOOL_CONFIG);
    }
  });

  it('refuses under every live status a bound ticket can hold, not only running', () => {
    for (const status of ['running', 'blocked', 'gating', 'shipping']) {
      const result = evaluateLifecyclePolicy(
        outsideWrite('.npmrc'),
        { state: { status }, ticket: readOnlyTicket },
      );
      expect(result.decision, status).toBe('deny');
      expect(result.reason, status).toMatch(REFUSES_TOOL_CONFIG);
    }
  });

  it('refuses a SEALED run bound orphan too (the refusal sits above the sealed branch)', () => {
    for (const status of ['completed', 'aborted']) {
      const result = evaluateLifecyclePolicy(
        outsideWrite('.bashrc'),
        { state: { status }, ticket: readOnlyTicket },
      );
      expect(result.decision, status).toBe('deny');
      expect(result.reason, status).toMatch(REFUSES_TOOL_CONFIG);
    }
  });

  it('refuses on every write tool the payload can expose a path through', () => {
    for (const tool of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'apply_patch']) {
      const result = evaluateLifecyclePolicy(
        outsideWrite('.npmrc', { tool_name: tool }),
        { state: running, ticket: readOnlyTicket },
      );
      expect(result.decision, tool).toBe('deny');
      expect(result.reason, tool).toMatch(REFUSES_TOOL_CONFIG);
    }
  });

  it('refuses on the codex host as well — the WRITE-TOOL channel is host-neutral', () => {
    // Host scoping matters and is stated where it is true: the bound-subagent
    // Bash allowlist is Claude-only (residual R6, pinned at the bottom of this
    // file), but nothing about the host edit channel is, so a bound codex ticket
    // must not keep the hole the Claude one loses.
    const result = evaluateLifecyclePolicy(
      outsideWrite('.npmrc', { host: 'codex' }),
      { state: running, ticket: readOnlyTicket },
    );
    expect(result.decision).toBe('deny');
    expect(result.reason).toMatch(REFUSES_TOOL_CONFIG);
  });

  it('states WHAT was refused and that the scratchpad is still open', () => {
    const result = evaluateLifecyclePolicy(
      outsideWrite('.npmrc'),
      { state: running, ticket: readOnlyTicket },
    );
    expect(result.decision).toBe('deny');
    // The APE-policy denial prefix: an agent classifies this as a capability
    // failure and stops, instead of retrying an identical ticket.
    expect(result.reason, 'policy-denial prefix').toMatch(/^APE write denied:/);
    // Names the refused THING — execution-redirecting configuration — not just
    // the fact of refusal.
    expect(result.reason, 'names configuration').toMatch(REFUSES_TOOL_CONFIG);
    expect(result.reason, 'names execution redirection').toMatch(/execut/i);
    // Names the matched tail, so the agent can see which target tripped it.
    expect(result.reason, 'names the matched tail').toMatch(/\.npmrc/i);
    // Keeps the scratchpad open, or every role that obeys the host's temp-file
    // directive concludes it has lost it.
    expect(result.reason, 'preserves the scratchpad invitation').toMatch(/scratch/i);
  });
});

// ---------------------------------------------------------------------------
// PARITY. The list above, the two Sets in lib/runtime/hooks.js and the list
// docs/hooks.md publishes are ONE statement made in three places, and this is
// the arm that makes them one. The tables are read as TEXT rather than imported:
// they are module-private in the implementation, and a suite that imported them
// would assert the implementation against itself (invariant 3) instead of
// against an independently authored expectation.
// ---------------------------------------------------------------------------

function shippedSetLiteral(source, name) {
  const marker = `const ${name} = new Set([`;
  const start = source.indexOf(marker);
  expect(start, `lib/runtime/hooks.js declares ${name}`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf(']);', start);
  expect(end, `lib/runtime/hooks.js closes ${name}`).toBeGreaterThan(start);
  return source
    .slice(start + marker.length, end)
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .flatMap((line) => [...line.matchAll(/'([^']+)'/g)].map((match) => match[1]));
}

function publishedDocTails(markdown) {
  const flat = markdown.replace(/\s+/g, ' ');
  const start = flat.indexOf('Covered tails (');
  expect(start, 'docs/hooks.md publishes a covered-tails list').toBeGreaterThanOrEqual(0);
  const end = flat.indexOf('Why the less obvious ones are in:', start);
  expect(end, 'docs/hooks.md closes the covered-tails list').toBeGreaterThan(start);
  return [...flat.slice(start, end).matchAll(/`([^`]+)`/g)].map((match) => match[1]);
}

describe('PARITY — the pinned list, the shipped tables and the published docs list are one set', () => {
  it('pins exactly the tails lib/runtime/hooks.js ships, in both directions', async () => {
    const source = await readFile(path.join(root, 'lib', 'runtime', 'hooks.js'), 'utf8');
    const shipped = [
      ...shippedSetLiteral(source, 'EXECUTION_CONFIG_TAIL'),
      ...shippedSetLiteral(source, 'EXECUTION_CONFIG_TAIL_PAIR'),
    ];
    // Sorted set equality, so ordering and grouping stay free.
    expect([...new Set(shipped)].sort()).toEqual([...new Set(COVERED_TAILS)].sort());
    // And no duplicates hide a missing entry on either side.
    expect(shipped.length, 'shipped tables carry no duplicate').toBe(new Set(shipped).size);
    expect(COVERED_TAILS.length, 'the pinned list carries no duplicate').toBe(
      new Set(COVERED_TAILS).size,
    );
  });

  it('pins exactly the tails docs/hooks.md publishes, in both directions', async () => {
    const markdown = await readFile(path.join(root, 'docs', 'hooks.md'), 'utf8');
    expect([...new Set(publishedDocTails(markdown))].sort()).toEqual(
      [...new Set(COVERED_TAILS)].sort(),
    );
  });

  it('publishes a rationale for each head the enumeration reaches for', async () => {
    // The criterion is applied HEAD BY HEAD, so a tail that appears in the list
    // with no argument attached is an entry nobody can argue with later. Every
    // head the cluster added is named in the same rationale block that already
    // argues git, go, mypy, the shells and the host-agent files — `eslint` and
    // now `mocha` included, because a head that is neither covered nor argued is
    // exactly how the published completeness claim ("the heads left out are
    // named in the residuals rather than left to the generic caveat") came to
    // over-read its own diff, twice.
    //
    // RED (this ticket) for the last two: `.codex-plugin` is the manifest the
    // published claim already advertised as host-neutral coverage while naming
    // only the Claude pair, and `mocha` is the admitted head that falsified the
    // strengthened residual claim by being in neither the table nor the
    // residuals.
    const markdown = await readFile(path.join(root, 'docs', 'hooks.md'), 'utf8');
    const flat = markdown.replace(/\s+/g, ' ');
    const start = flat.indexOf('Why the less obvious ones are in:');
    expect(start, 'docs/hooks.md argues the less obvious entries').toBeGreaterThanOrEqual(0);
    const end = flat.indexOf('Every tail above carries an arm', start);
    expect(end, 'docs/hooks.md closes the rationale block').toBeGreaterThan(start);
    const rationale = flat.slice(start, end);
    for (const head of ['pylint', 'prettier', 'eslint', '.claude-plugin', '.codex-plugin', 'mocha']) {
      expect(rationale, `rationale names ${head}`).toContain(head);
    }
  });
});

// ---------------------------------------------------------------------------
// execution-config-symlink-rationale-inverted. The refusal consults TWO tails —
// the raw target and the realpath-resolved one — and the three prose sites that
// explain why all cited the stow/chezmoi layout ($HOME/.cargo symlinked INTO a
// managed store) as the case the RESOLVED half exists to catch. It is the
// opposite: resolution ERASES that match (the resolved tail is `cargo/...`,
// which is in no table) and the RAW half is what catches it, while the RESOLVED
// half catches the mirror layout. The hazard is not cosmetic — the inverted text
// reads as an argument that the raw lookup is subsumed, and acting on it drops
// coverage of the most common dotfile-manager layout there is. The behavioural
// halves are pinned end to end below; these arms pin that each site states that
// BOTH lookups are required because neither SUBSUMES the other.
// ---------------------------------------------------------------------------

function dotfileManagerWindows(text) {
  const flat = text.replace(/\s+/g, ' ');
  const windows = [];
  for (const match of flat.matchAll(/stow|chezmoi/gi)) {
    windows.push(flat.slice(Math.max(0, match.index - 700), match.index + 700));
  }
  return windows;
}

describe('RED — every site that cites the dotfile-manager layout says both lookups are required', () => {
  for (const [label, relative] of [
    ['bin/ape-hook.mjs', ['bin', 'ape-hook.mjs']],
    ['lib/runtime/hooks.js', ['lib', 'runtime', 'hooks.js']],
    ['docs/hooks.md', ['docs', 'hooks.md']],
  ]) {
    it(`${label} states that neither the raw nor the resolved lookup subsumes the other`, async () => {
      const text = await readFile(path.join(root, ...relative), 'utf8');
      const windows = dotfileManagerWindows(text);
      expect(windows.length, `${label} cites the dotfile-manager layout`).toBeGreaterThan(0);
      for (const [index, window] of windows.entries()) {
        expect(window, `${label} site ${index}: names the RAW half`).toMatch(/\braw\b/i);
        expect(window, `${label} site ${index}: names the RESOLVED half`).toMatch(/resolv/i);
        expect(window, `${label} site ${index}: rules out subsumption`).toMatch(/subsum/i);
      }
    });
  }
});

describe('GREEN GUARD — ordinary out-of-project writes stay admitted (green before AND after)', () => {
  it('admits an ordinary scratchpad file for the SAME bound read-only ticket', () => {
    for (const tail of ['notes.md', 'scratch/plan.txt', 'ape-scratch/receipt.json']) {
      const result = evaluateLifecyclePolicy(
        outsideWrite(tail),
        { state: running, ticket: readOnlyTicket },
      );
      expect(result.decision, `${HOME}/${tail}`).toBe('allow');
      expect(result.reason, `${HOME}/${tail}`).toMatch(OUT_OF_PROJECT_ALLOW);
    }
  });

  it('admits names that merely CONTAIN a covered tail, and non-matching segment parents', () => {
    // The first two catch a sloppy substring match; the next group catches a
    // string SUFFIX match where a segment compare was required; the last group
    // catches the far more expensive mistake of promoting a PAIR entry to a
    // single segment. `config`, `config.toml`, `settings.json`, `env`,
    // `pylintrc`, `plugin.json`, `marketplace.json` and `package.json` are among
    // the most ordinary scratch filenames there are, and every one of them is
    // either the final segment of some covered pair or a file the covered
    // linters merely CONSULT — refusing them bare would strand the scratchpad
    // this refusal exists to keep open.
    for (const tail of [
      'npmrc-notes.txt',
      'report.npmrc.md',
      'notes/config',
      'repo/.git/config',
      'legacy-git/config',
      'vendor.cargo/config.toml',
      'foonpm/npmrc-old',
      'bashrc.md',
      'settings.json',
      'tmp/config.toml',
      'scratch/env',
      // A host config directory relocated by CLAUDE_CONFIG_DIR / CODEX_HOME is
      // NOT covered: the host-agent entries key on the directory NAME, and that
      // residual is published rather than quietly over-matched.
      'my-claude/settings.json',
      // pylint: the DOTTED spelling is covered and the XDG one is keyed on its
      // directory, so a bare `pylintrc` anywhere else stays a scratch file.
      'pylintrc',
      'notes/pylintrc',
      '.pylintrc.md',
      'pylintrc-draft',
      // prettier: exact segments only. A package.json is NOT covered — prettier
      // does read its `prettier` key, and refusing every out-of-project
      // package.json is an over-block far larger than the hole it closes. That
      // residual is published, not implied.
      'package.json',
      'scratch/package.json',
      'prettier.config',
      '.prettierrc-notes.md',
      'prettierrc',
      // The extension is part of the segment, so a near-miss stays a scratch
      // file: `.tsx` is not a prettier search place and `eslint.config` with no
      // extension and `eslint.config.json` are not flat-config spellings.
      'prettier.config.tsx',
      'eslint.config',
      'eslint.config.json',
      // …and the segment compare is not a suffix compare: a differently-prefixed
      // name that ENDS in a covered tail is an ordinary file.
      'my-eslint.config.js',
      'notes.prettier.config.ts',
      // mocha: the seven DOCUMENTED spellings are covered and nothing else is.
      // The extension-less `.mocharc` is not a search place at all, the `mocha`
      // KEY of a package.json is a published residual (the bare `package.json`
      // guard directly above is the same one), and the compare is over whole
      // segments, so a differently-prefixed near-miss stays a scratch file.
      '.mocharc',
      'mocharc',
      'notes/.mocharc',
      '.mocharc.md',
      '.mocharc.toml',
      'my.mocharc.js',
      'notes-.mocharc.json',
      // plugin manifests are keyed on the .claude-plugin / .codex-plugin
      // DIRECTORY name, so the bare filenames stay ordinary and a look-alike
      // parent does not match. Both hosts' manifests carry the identical guard
      // set — the codex pair here is what stops the tail this ticket adds from
      // landing as a substring or suffix match.
      'plugin.json',
      'marketplace.json',
      'my-plugin/plugin.json',
      'vendor.claude-plugin/plugin.json',
      'claude-plugin/plugin.json',
      'codex-plugin/plugin.json',
      'vendor.codex-plugin/plugin.json',
    ]) {
      const result = evaluateLifecyclePolicy(
        outsideWrite(tail),
        { state: running, ticket: readOnlyTicket },
      );
      expect(result.decision, `${HOME}/${tail}`).toBe('allow');
      expect(result.reason, `${HOME}/${tail}`).toMatch(OUT_OF_PROJECT_ALLOW);
    }
  });

  it('leaves the UNBOUND main session alone even on a covered tail', () => {
    // The cost of this exemption, stated rather than implied: the refusal binds
    // BOUND tickets only, so the family is closed against a mistaken or
    // misaligned STAGE and not against a compromised orchestrator, which keeps
    // an unrestricted out-of-project write.
    for (const status of ['running', 'blocked', 'gating']) {
      const result = evaluateLifecyclePolicy(
        outsideWrite('.npmrc', { is_subagent: false, ape_managed: undefined }),
        { state: { status }, ticket: null },
      );
      expect(result.decision, status).toBe('allow');
      expect(result.reason, status).toMatch(OUT_OF_PROJECT_ALLOW);
    }
  });

  it('leaves READS of a covered tail alone — only write tools are refused', () => {
    const result = evaluateLifecyclePolicy(
      outsideWrite('.npmrc', { tool_name: 'Read' }),
      { state: running, ticket: readOnlyTicket },
    );
    expect(result.decision).toBe('allow');
    expect(result.reason).not.toMatch(REFUSES_TOOL_CONFIG);
  });

  it('never evaluates a lifecycle boundary event as a tool call, covered tail or not', () => {
    // Denying Stop/SubagentStop eats the agent's receipt-bearing final message;
    // read-only subagents were once blocked at every Stop. The target_path here
    // is a synthetic worst case: it pins that the refusal carries the
    // tool-channel term rather than keying on the path alone.
    for (const status of ['running', 'aborted', 'completed']) {
      for (const event of ['Stop', 'SubagentStop']) {
        const result = evaluateLifecyclePolicy(
          outsideWrite('.npmrc', { event, tool_name: '' }),
          { state: { status }, ticket: readOnlyTicket },
        );
        expect(result.decision, `${event}/${status}`).toBe('allow');
        expect(result.reason, `${event}/${status}`).not.toMatch(REFUSES_TOOL_CONFIG);
      }
    }
  });

  it('keeps a sealed run bound orphan writing an ordinary scratch path allowed', () => {
    // The same pin __tests__/runtime-v2-abort-quarantine.test.js holds, restated
    // locally because the hoisted refusal sits directly on top of it and that
    // file is not claimed by this run.
    const result = evaluateLifecyclePolicy(
      outsideWrite('notes.md'),
      { state: { status: 'aborted' }, ticket: readOnlyTicket },
    );
    expect(result.decision).toBe('allow');
    expect(result.reason).toMatch(/sealed/);
  });

  it('leaves the IN-PROJECT verdicts exactly as they were', () => {
    // An in-project .npmrc is an ordinary claimable production file and keeps
    // the ordinary reason: the refusal is a narrowing of the OUT-OF-PROJECT
    // allow, not a new in-project rule (a committed .npmrc is residual R1's
    // territory, not this one's).
    const readOnlyInProject = evaluateLifecyclePolicy(
      {
        host: 'claude',
        event: 'PreToolUse',
        tool_name: 'Write',
        is_subagent: true,
        ape_managed: true,
        file: '.npmrc',
        target_path: '/proj/.npmrc',
        out_of_project: false,
      },
      { state: running, ticket: readOnlyTicket },
    );
    expect(readOnlyInProject.decision).toBe('deny');
    expect(readOnlyInProject.reason).toMatch(/reviewer is read-only/);
    expect(readOnlyInProject.reason).not.toMatch(REFUSES_TOOL_CONFIG);

    const mainSessionInProject = evaluateLifecyclePolicy(
      {
        host: 'claude',
        event: 'PreToolUse',
        tool_name: 'Write',
        is_subagent: false,
        file: '.npmrc',
        target_path: '/proj/.npmrc',
        out_of_project: false,
      },
      { state: running, ticket: null },
    );
    expect(mainSessionInProject.decision).toBe('deny');
    expect(mainSessionInProject.reason).toMatch(/main-session production writes are forbidden/);
    expect(mainSessionInProject.reason).not.toMatch(REFUSES_TOOL_CONFIG);
  });

  it('keeps the fail-closed shapes on their own reasons when the flag is not true', () => {
    // out_of_project is precomputed with realpath semantics; absent or false it
    // must keep failing closed on the EXISTING reason. The refusal is gated on
    // `=== true` precisely so it can only narrow that one allow branch.
    for (const flag of [undefined, false]) {
      const result = evaluateLifecyclePolicy(
        outsideWrite('.npmrc', { out_of_project: flag }),
        { state: running, ticket: readOnlyTicket },
      );
      expect(result.decision, String(flag)).toBe('deny');
      expect(result.reason, String(flag)).toMatch(/aliases a path inside the project/);
      expect(result.reason, String(flag)).not.toMatch(REFUSES_TOOL_CONFIG);
    }
  });
});

describe('PUBLISHED RESIDUALS — these arms ASSERT UNCLOSED HOLES so the closure claim cannot over-read', () => {
  const boundBash = (command, overrides = {}) => ({
    host: 'claude',
    event: 'PreToolUse',
    tool_name: 'Bash',
    is_subagent: true,
    ape_managed: true,
    command,
    ...overrides,
  });

  it('closes the COMMAND channel on both hosts', () => {
    // `npm config set script-shell <path>` writes $HOME/.npmrc with no path in
    // any tool payload, so a filename-keyed write rule cannot see it. On the
    // host-neutral evidence allowlist refuses it (only `test`/`t`/`run
    // <script>` follow a package-manager head).
    const claude = evaluateLifecyclePolicy(
      boundBash('npm config set script-shell /bin/sh'),
      { state: running, ticket: readOnlyTicket },
    );
    expect(claude.decision).toBe('deny');

    const codex = evaluateLifecyclePolicy(
      boundBash('npm config set script-shell /bin/sh', { host: 'codex' }),
      { state: running, ticket: readOnlyTicket },
    );
    expect(codex.decision).toBe('deny');
  });

  it('closes the ENV command half on both hosts', () => {
    // The BASH_ENV/ENV/NODE_OPTIONS half is not a file-write channel at all, so
    // no filename rule reaches it. Inline `NAME=VAL` and `env NAME=VAL` die on
    // the host-neutral bound-shell policy (no recognized head; bare `env` only).
    const claude = evaluateLifecyclePolicy(
      boundBash('NODE_OPTIONS=--require=/x/y.js npm test'),
      { state: running, ticket: readOnlyTicket },
    );
    expect(claude.decision).toBe('deny');

    const codex = evaluateLifecyclePolicy(
      boundBash('NODE_OPTIONS=--require=/x/y.js npm test', { host: 'codex' }),
      { state: running, ticket: readOnlyTicket },
    );
    expect(codex.decision).toBe('deny');
  });

  it('does not close PATH shadowing — an out-of-project bin directory stays writable', () => {
    // Placing an executable in an out-of-project `bin` ahead of the real one
    // redefines an admitted head with no covered filename anywhere, and no
    // filename ENUMERATION can close it. This arm asserts a HOLE; it is correct
    // to delete only when that family is genuinely closed.
    for (const tail of ['bin/node', 'bin/npm', '.local/bin/git']) {
      const result = evaluateLifecyclePolicy(
        outsideWrite(tail),
        { state: running, ticket: readOnlyTicket },
      );
      expect(result.decision, `${HOME}/${tail}`).toBe('allow');
    }
  });

  it('does not close the FILES a plugin manifest names, only the manifests', () => {
    // The three plugin-manifest entries cover the files that DECLARE a plugin.
    // What each manifest POINTS AT is named BY the manifest — `"hooks":
    // "./hooks/claude-hooks.json"` in this repository's own
    // .claude-plugin/plugin.json, and `mcpServers.ape.command` =
    // `./dist/ape-mcp.bundle.mjs` in its .codex-plugin/plugin.json — so those
    // filenames are attacker-chosen and no enumeration reaches them. Overwriting
    // an ALREADY-INSTALLED plugin's hook file or MCP command therefore stays
    // open, and this arm is what stops the coverage claim from reading wider than
    // the manifests. Adding the codex manifest does not narrow this hole; it adds
    // a second shape of it, which is why the arm grew a row rather than lost one.
    //
    // NARROWED, because "attacker-chosen" is not true of one of the two
    // mcpServers forms: the codex STRING companion is name-pinned to exactly
    // .mcp.json by lib/runtime/plugin-validation.js's validateCodexPlugin, which
    // normalizes and errors otherwise. That pin binds APE's OWN validator rather
    // than what a host loads from a manifest an attacker overwrote, and it
    // reaches only that form — a string mcpServers on the CLAUDE side routes
    // through validateComponentPaths with NO name pin, and every INLINE
    // mcpServers object chooses its own command, which is the form this tree's
    // .codex-plugin/plugin.json uses. So the fixed-name companion is EXCLUDED
    // from this hole and every row below is an unpinned-name target; .mcp.json is
    // recorded as a residual in docs/hooks.md rather than covered here.
    for (const tail of [
      'plugins/ape/hooks/claude-hooks.json',
      'x/hooks/hooks.json',
      'plugins/ape/dist/ape-mcp.bundle.mjs',
    ]) {
      const result = evaluateLifecyclePolicy(
        outsideWrite(tail),
        { state: running, ticket: readOnlyTicket },
      );
      expect(result.decision, `${HOME}/${tail}`).toBe('allow');
    }
  });

  it('does not close attacker-CREATED links — the enumeration is durable only while none exist', () => {
    // A bound subagent cannot create a symlink or hardlink: `ln` is not a
    // recognized evidence head on the Claude arm, it is matched by SHELL_WRITE
    // elsewhere, and no write tool creates links. So the resolved-path arm below
    // covers PRE-EXISTING links (stow/chezmoi dotfile managers), not
    // attacker-made ones — and admitting any rename- or link-capable channel
    // later silently reopens the whole family.
    const link = evaluateLifecyclePolicy(
      boundBash(`ln -s ${HOME}/.npmrc ${HOME}/alias`),
      { state: running, ticket: readOnlyTicket },
    );
    expect(link.decision).toBe('deny');
  });
});

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function project(status = 'running') {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-toolcfg-project-'));
  cleanups.push(dir);
  await mkdir(path.join(dir, 'src'), { recursive: true });
  await mkdir(path.join(dir, '__tests__'), { recursive: true });
  await writeFile(path.join(dir, 'src', 'value.js'), 'export const value = 1;\n');
  await writeFile(path.join(dir, '__tests__', 'sample.test.js'), 'test\n');
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'ape@example.test');
  git(dir, 'config', 'user.name', 'APE Test');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'test: baseline');
  const baseline = await currentTreeSha(dir);
  await atomicWriteJson(runtimePaths(dir).active, {
    run_id: 'run-toolcfg',
    status,
    tree_sha: baseline,
    tickets: [
      {
        ticket_id: 'run-toolcfg:review:r',
        role: 'reviewer',
        writable: false,
        claimed_paths: [],
        test_paths: ['__tests__'],
        base_tree_sha: baseline,
      },
    ],
    receipts: [],
  });
  return dir;
}

// The out-of-project scratch root. A throwaway os.tmpdir directory, never $HOME.
async function outsideDir() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-toolcfg-scratch-'));
  cleanups.push(dir);
  return dir;
}

// Force the Claude host and strip host-provided project hints so only the
// payload under test decides.
function claudeEnv() {
  const env = { ...process.env, CLAUDECODE: '1' };
  delete env.CLAUDE_PROJECT_DIR;
  delete env.CODEX_CWD;
  delete env.APE_TICKET_ID;
  return env;
}

function invokeHook(input, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hookBinary], {
      cwd,
      env: claudeEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(stderr));
      else resolve(JSON.parse(stdout));
    });
    child.stdin.end(`${JSON.stringify(input)}\n`);
  });
}

function writeCall(dir, filePath, binding = {}) {
  return {
    hook_event_name: 'PreToolUse',
    project_dir: dir,
    session_id: 's1',
    tool_name: 'Write',
    tool_input: { file_path: filePath, content: 'scratch' },
    ...binding,
  };
}

const boundReviewer = { is_subagent: true, ticket_id: 'run-toolcfg:review:r' };

describe('APE v2 hook binary — out-of-project tool-config writes end to end', () => {
  it('refuses a bound read-only ticket writing a tool-config tail outside the project', async () => {
    const dir = await project();
    const scratch = await outsideDir();

    const response = await invokeHook(
      writeCall(dir, path.join(scratch, '.npmrc'), boundReviewer),
      dir,
    );

    expect(response.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(response.hookSpecificOutput.permissionDecisionReason).toMatch(REFUSES_TOOL_CONFIG);
  });

  it('RESOLVED direction: refuses a target whose RESOLVED path lands on a covered tail', async () => {
    // An ordinary-named path (`link/config.toml`) that resolves ONTO a covered
    // directory. The unresolved tail matches nothing; only the resolved one
    // (`.cargo/config.toml`) does, so deleting the RESOLVED lookup turns this
    // arm red. The symlink points at an empty DIRECTORY: no tool-config file is
    // created anywhere by this suite.
    const dir = await project();
    const scratch = await outsideDir();
    await mkdir(path.join(scratch, 'store', '.cargo'), { recursive: true });
    await symlink(path.join(scratch, 'store', '.cargo'), path.join(scratch, 'link'));

    const response = await invokeHook(
      writeCall(dir, path.join(scratch, 'link', 'config.toml'), boundReviewer),
      dir,
    );

    expect(response.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(response.hookSpecificOutput.permissionDecisionReason).toMatch(REFUSES_TOOL_CONFIG);
  });

  it('RAW direction: refuses the dotfile-manager layout, which resolution ERASES', async () => {
    // The stow/chezmoi shape, and the direction the three prose sites had
    // backwards: `$HOME/.cargo` is a symlink INTO a managed store whose
    // directory is named `cargo`, so the RAW tail (`.cargo/config.toml`) matches
    // and the RESOLVED tail (`cargo/config.toml`) is in no table. Deleting the
    // RAW lookup turns this arm red — which is exactly the coverage the inverted
    // comment invited a future reader to drop.
    const dir = await project();
    const scratch = await outsideDir();
    await mkdir(path.join(scratch, 'store', 'cargo'), { recursive: true });
    await symlink(path.join(scratch, 'store', 'cargo'), path.join(scratch, '.cargo'));

    const response = await invokeHook(
      writeCall(dir, path.join(scratch, '.cargo', 'config.toml'), boundReviewer),
      dir,
    );

    expect(response.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(response.hookSpecificOutput.permissionDecisionReason).toMatch(REFUSES_TOOL_CONFIG);
  });

  it('RAW direction, the other half: the store path ITSELF is admitted, so resolution really does erase the match', async () => {
    // Without this arm the arm above proves nothing about WHICH lookup caught
    // it. `<store>/cargo/config.toml` is the exact path the resolver produces
    // for the fixture above, and it is ALLOWED — so the raw lookup is the only
    // thing that can have denied there.
    const dir = await project();
    const scratch = await outsideDir();
    await mkdir(path.join(scratch, 'store', 'cargo'), { recursive: true });

    const response = await invokeHook(
      writeCall(dir, path.join(scratch, 'store', 'cargo', 'config.toml'), boundReviewer),
      dir,
    );

    expect(response.hookSpecificOutput.permissionDecision).toBe('allow');
    expect(response.hookSpecificOutput.permissionDecisionReason).toMatch(OUT_OF_PROJECT_ALLOW);
  });

  it('RED: refuses a bound ticket writing EITHER HOST\'s plugin manifest outside the project', async () => {
    // A manifest names a program the host runs — the hook file that declares
    // PreToolUse hook COMMANDS, or an mcpServers `command` — which is the same
    // mechanism that puts .claude/settings.json in the table. The codex row is
    // this ticket's RED and the reason the arm iterates: a refusal that closes
    // one host's manifest and leaves the other's open is host policy in a
    // host-neutral runtime (invariant 6). Nothing is written: a PreToolUse
    // permission check only decides.
    for (const [directory, name] of [
      ['.claude-plugin', 'plugin.json'],
      ['.claude-plugin', 'marketplace.json'],
      ['.codex-plugin', 'plugin.json'],
    ]) {
      const dir = await project();
      const scratch = await outsideDir();
      await mkdir(path.join(scratch, directory), { recursive: true });

      const response = await invokeHook(
        writeCall(dir, path.join(scratch, directory, name), boundReviewer),
        dir,
      );

      expect(response.hookSpecificOutput.permissionDecision, `${directory}/${name}`).toBe('deny');
      expect(
        response.hookSpecificOutput.permissionDecisionReason,
        `${directory}/${name}`,
      ).toMatch(REFUSES_TOOL_CONFIG);
    }
  });

  it('RED: refuses a bound ticket writing a mocha rc file outside the project', async () => {
    // mocha is an admitted head and its find-up walk reaches $HOME, so the rc
    // file is read for a project that ships none. The `.cjs` spelling is mocha's
    // own first priority; nothing is written here either.
    const dir = await project();
    const scratch = await outsideDir();

    const response = await invokeHook(
      writeCall(dir, path.join(scratch, '.mocharc.cjs'), boundReviewer),
      dir,
    );

    expect(response.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(response.hookSpecificOutput.permissionDecisionReason).toMatch(REFUSES_TOOL_CONFIG);
  });

  it('GREEN: still admits the same ticket writing an ordinary scratchpad file', async () => {
    const dir = await project();
    const scratch = await outsideDir();

    const response = await invokeHook(
      writeCall(dir, path.join(scratch, 'notes.md'), boundReviewer),
      dir,
    );

    expect(response.hookSpecificOutput.permissionDecision).toBe('allow');
    expect(response.hookSpecificOutput.permissionDecisionReason).toMatch(OUT_OF_PROJECT_ALLOW);
  });

  it('GREEN: leaves the unbound main session alone on the same covered tail', async () => {
    const dir = await project();
    const scratch = await outsideDir();

    const response = await invokeHook(writeCall(dir, path.join(scratch, '.npmrc')), dir);

    expect(response.hookSpecificOutput.permissionDecision).toBe('allow');
    expect(response.hookSpecificOutput.permissionDecisionReason).toMatch(OUT_OF_PROJECT_ALLOW);
  });
});

// ---------------------------------------------------------------------------
// A1 — roadmap entry audit-2026-07-29-execution-config-residue, RESOLVED AS
// NAME RATHER THAN COVER.
//
// `.mcp.json` meets the host-agent entries' OWN stated criterion — "declares MCP
// servers by `command`" — at least as literally as `.codex-plugin/plugin.json`
// does, and THIS repository ships one at its own root declaring
// mcpServers.ape.command. So the omission from the table is real and is recorded
// rather than left silent. It is RECORDED and not closed because COVER is
// infeasible here: adding a tail to EXECUTION_CONFIG_TAIL is a CODE change to a
// bundled module, and __tests__/runtime-v2-bundle-freshness.test.js pins
// dist/ape-hooks.bundle.mjs and dist/ape-mcp.bundle.mjs byte-identical to a fresh
// esbuild, so the tail cannot land without also claiming two dist/ bundles. The
// arms below pin the NAME outcome; the GREEN GUARD at the end pins that COVER did
// not happen behind their back.
//
// HOST FACTS AND PROOF BOUNDARY. The official Claude Code MCP documentation,
// https://code.claude.com/docs/en/mcp, documents project-scoped `.mcp.json` at
// the project root/current project. It separately documents
// `CLAUDE_PROJECT_DIR` for plugin-provided MCP configuration. Those are the
// documented facts. Whether Claude Code discovers a project-scoped `.mcp.json`
// by walking ancestors is a distinct implementation detail the documentation
// does not establish and this repository has not verified.
//
// WHAT THE NARROWING IS. The flat sentence "the files a manifest points at are
// arbitrarily NAMED, so no enumeration reaches them" is FALSE for exactly one
// form: lib/runtime/plugin-validation.js's validateCodexPlugin normalizes a
// STRING mcpServers companion and errors unless it is exactly .mcp.json, so that
// one filename is fixed. The claim SURVIVES everywhere else — a string mcpServers
// on the CLAUDE side routes through validateComponentPaths with no name pin, and
// every INLINE mcpServers object names its own command, which is the form this
// tree's own .codex-plugin/plugin.json actually uses. So each site must say all
// three things, and a flat "the companion is name-pinned" satisfies none of them
// properly: WHICH name is fixed, WHAT fixes it (APE's own validator, not a
// guarantee about what a host loads from an overwritten manifest), and that the
// inline form stays arbitrary.
//
// THE SELF-SCAN HAZARD, AND HOW THESE ARMS AVOID IT. Two of the six sites live in
// THIS FILE, so an arm here has to parse its own source, and two shapes are
// unusable for that:
//   - a whole-file `toContain('.mcp.json')` is satisfied by the assertion's own
//     literal, so it is GREEN at end-of-test and pins nothing at all;
//   - a `matchAll` locator like `dotfileManagerWindows` above is worse — its
//     pattern source appears verbatim in the file it would scan, so it
//     MANUFACTURES an extra window around the locator itself, which then has to
//     satisfy the per-window assertion too. That is exactly why
//     `dotfileManagerWindows` scans bin/ape-hook.mjs, lib/runtime/hooks.js and
//     docs/hooks.md and never this suite.
// So every window below is bounded by FIRST-OCCURRENCE `indexOf` — the technique
// `shippedSetLiteral` above already uses — and this whole block is authored AFTER
// both in-suite sites, so the first occurrence of an anchor is the real site and
// never the anchor literal in the table below. For the four sites in OTHER files
// the opening anchor is additionally asserted to occur exactly ONCE, so a window
// can never silently start describing somewhere else; for the two in-suite sites
// that check is deliberately off, because the anchor's second occurrence IS the
// table below — the self-scan hazard in miniature — and each of those windows is
// instead asserted not to have leaked into this block.
//
// PER-SITE, NEVER PER-FILE. Each of the six sites gets its OWN window, its OWN
// `it` and its OWN labels. Per-file floors (hooks.js at least one, docs at least
// two, this suite at least two) are self-satisfiable and let a deleted site hide
// behind a surviving sibling in the same file; here, deleting one site fails that
// site's own arm and names it.
//
// NOT A SITE: docs/hooks.md's closure table cell that reads "the FILES a plugin
// manifest names on either host". It names the residual by title as a pointer
// into the residual list and asserts no arbitrary-naming claim of its own, so
// pinning it would be pinning a cross-reference.
//
// COVERAGE IS ADDED, NEVER MOVED. Nothing above changes: COVERED_TAILS carries
// the same entries iterated over the same two ticket kinds, and the only claim
// these arms make about `publishedDocTails`' window is that `.mcp.json` stays
// OUT of it.
// ---------------------------------------------------------------------------

const SELF = fileURLToPath(import.meta.url);

// The fixed name lib/runtime/plugin-validation.js pins the codex STRING
// companion to, and the token that carries the red: at the base tree it appears
// in none of lib/runtime/hooks.js, docs/hooks.md or this file, and
// `git log --all -S.mcp.json` over those three paths is EMPTY across every ref.
const PINNED_COMPANION = /\.mcp\.json/;
// The name alone is not the narrowing. The site must also say WHAT fixes it —
// APE's own validator, never a claim about what a host loads from a manifest an
// attacker overwrote…
const NAMES_WHAT_PINS_IT = /validat|pin/i;
// …and that the arbitrary-naming claim SURVIVES for the inline `command` value,
// which is the form this tree actually ships.
const KEEPS_THE_INLINE_FORM_OPEN = /inline|object form/i;

// THE HALF OF THE REACHABILITY-CLASS GROUND THAT SURVIVES RE-DERIVATION: the
// PROJECT dimension. `future session` is deliberately NOT one of these
// alternatives — the disposition arm below records why the SESSION dimension is
// not a property of the table at all, and an arm that accepted the session
// wording alone would let the falsified universal stand and still read green.
// (`other project` also matches "ANOTHER project"; both spellings are listed
// because the wording is the build's to choose.)
const CROSS_PROJECT_GROUND =
  /another project|other project|a different project|cross-project|that project/i;

// The HONESTY LABEL on a ground nothing in this tree verifies. Spelling is
// deliberately loose — any short connective between the two halves is accepted,
// so "DERIVED, NOT VERIFIED", "DERIVED and NOT VERIFIED" and "DERIVED but NOT
// VERIFIED" all satisfy it — but the fully hyphen-joined `derived-not-verified`
// does NOT, because that spelling is how this same bullet CROSS-REFERENCES the
// derived-not-verified list under *Shell assumption*, and a pointer at someone
// else's label is not this label. Without that exclusion the honesty label could
// be deleted, the pointer left behind, and this arm would never notice.
const DERIVED_NOT_VERIFIED = /\bderived\b[^.]{0,24}\bnot verified\b/i;
const CLAUDE_MCP_DOCS = 'https://code.claude.com/docs/en/mcp';
const DOCUMENTED_PROJECT_SCOPE = /project root|current project/i;
const PLUGIN_PROJECT_DIR = /CLAUDE_PROJECT_DIR[^.]{0,160}plugin|plugin[^.]{0,160}CLAUDE_PROJECT_DIR/i;
const UNVERIFIED_ANCESTOR_DISCOVERY =
  /ancestor[^.]{0,160}(unverified|not verified|not documented|does not (?:establish|document))/i;

// Drop the line-leading `//` of a JS comment before flattening, so an anchor may
// span a wrapped comment line without a marker landing in the middle of it.
// Markdown carries no such marker and is unaffected.
function flattenForAnchors(text) {
  return text.replace(/^[ \t]*\/\/ ?/gm, '').replace(/\s+/g, ' ');
}

// A bounded, unambiguous window. These anchors are LOAD-BEARING: a repeated
// opening anchor is how a text window silently starts describing somewhere else,
// which is the failure mode a per-file substring check cannot even detect.
function narrowingWindow(flat, label, opens, closes, uniqueOpening = true) {
  const start = flat.indexOf(opens);
  expect(start, `${label}: the opening anchor is present`).toBeGreaterThanOrEqual(0);
  if (uniqueOpening) {
    expect(flat.indexOf(opens, start + 1), `${label}: the opening anchor occurs once`).toBe(-1);
  }
  const end = flat.indexOf(closes, start + opens.length);
  expect(end, `${label}: the closing anchor follows the opening one`).toBeGreaterThan(start);
  return flat.slice(start, end);
}

const RESIDUAL_LIST = {
  label: 'docs/hooks.md residual list',
  opens: 'Residuals this narrowing does NOT close.',
  closes: '## Bound-subagent shell policy',
};

// PER-SITE, NEVER PER-FILE — one level further down. The `.mcp.json` disposition
// is ONE bullet inside a residual list of a dozen, and the two grounds pinned
// below are properties of THAT bullet: the list also talks about projects in the
// relocated-config and main-session bullets and points at the
// derived-not-verified list under *Shell assumption*, so a list-wide pin could be
// satisfied by a sibling while this bullet lost the very sentences it exists to
// publish. Both anchors are the bullets' own titles, which the narrowing does not
// touch. The window is taken from the RESIDUAL_LIST slice, so uniqueness is
// checked inside the list and the closure-table cell that names the next bullet
// by title (see "NOT A SITE" above) sits outside it and cannot bound anything.
const MCP_RESIDUAL = {
  label: 'docs/hooks.md — the `.mcp.json` disposition bullet',
  opens: '`.mcp.json`, and this repository ships one',
  closes: 'The FILES a plugin manifest names',
};

// The six sites that carry the arbitrary-naming claim. `relative: null` means
// this suite's own source.
const NARROWING_SITES = [
  {
    label: 'lib/runtime/hooks.js — the deliberately-NOT-covered enumeration',
    relative: ['lib', 'runtime', 'hooks.js'],
    opens: 'the FILES a plugin manifest names',
    closes: 'AND THE PROMISE THAT LIST MAKES IS BOUNDED',
    identity: [/mcpServers/, /manifest/i],
    uniqueOpening: true,
  },
  {
    label: 'lib/runtime/hooks.js — the EXECUTION_CONFIG_TAIL_PAIR manifest rationale',
    relative: ['lib', 'runtime', 'hooks.js'],
    opens: 'The FILES a manifest points at',
    closes: "'.claude-plugin/plugin.json',",
    identity: [/manifest/i, /enumerat/i],
    uniqueOpening: true,
  },
  {
    label: 'docs/hooks.md — the covered-entry rationale bullet',
    relative: ['docs', 'hooks.md'],
    opens: "BOTH hosts' plugin manifests",
    closes: 'the shell entries are listed in each shell',
    identity: [/mcpServers/, /manifest/i],
    uniqueOpening: true,
  },
  {
    label: 'docs/hooks.md — the residual bullet',
    relative: ['docs', 'hooks.md'],
    opens: 'The three plugin-manifest entries cover',
    closes: 'The `prettier` and `mocha` keys of a `package.json`',
    identity: [/mcpServers/, /manifest/i],
    uniqueOpening: true,
  },
  {
    // In-suite site 1 of 2. Uniqueness is OFF because the second occurrence of
    // this anchor is the `opens` literal three lines below — the self-scan
    // hazard in miniature. First-occurrence bounds still land on the real site,
    // because this whole block is authored after it.
    label: 'this suite — the COVERED_TAILS manifest rationale',
    relative: null,
    opens: 'The hook FILE and the command BINARY a manifest points at',
    closes: "'.claude-plugin/plugin.json',",
    identity: [/manifest/i, /enumerat/i],
    uniqueOpening: false,
  },
  {
    // In-suite site 2 of 2, same reason.
    label: 'this suite — the manifest-files residual arm',
    relative: null,
    opens: "it('does not close the FILES a plugin manifest names",
    closes: "it('does not close attacker-CREATED links",
    identity: [/mcpServers/, /manifest/i],
    uniqueOpening: false,
  },
];

describe('RED — A1: `.mcp.json` is RECORDED, and every arbitrary-naming site excludes it', () => {
  it('names `.mcp.json` in the docs/hooks.md residual list, with the ground it is left out on', async () => {
    const flat = flattenForAnchors(await readFile(path.join(root, 'docs', 'hooks.md'), 'utf8'));
    const residuals = narrowingWindow(
      flat,
      RESIDUAL_LIST.label,
      RESIDUAL_LIST.opens,
      RESIDUAL_LIST.closes,
    );
    // THE NAMING. A file that meets the published criterion and appears in
    // NEITHER the table NOR the residuals is the exact shape that falsified the
    // universal completeness sentence three revisions running — eslint, then
    // mocha, then pytest — so naming it is the whole of this resolution.
    expect(residuals, 'the residual list names `.mcp.json`').toMatch(PINNED_COMPANION);
    // AND THE GROUND, because a residual that names a file without saying why it
    // is out is the record-accuracy defect this phase exists to remove. The
    // ground is REACHABILITY CLASS, not harmlessness, and it is pinned in the ONE
    // dimension that survives re-derivation — the PROJECT dimension: the refusal
    // is a pure narrowing of one allow branch gated on an out-of-project target,
    // nothing in this tree resolves `.mcp.json` from anywhere but a PROJECT ROOT,
    // so such a tail would govern ANOTHER project rather than the current one,
    // and cross-project persistence is a threat model this table does not claim
    // today. Adopting it is a scope decision rather than one more row.
    //
    // THE SESSION DIMENSION IS NOT PINNED, AND MUST NOT BE. "Every row now in the
    // table redirects the CURRENT session" is FALSE of rows that ARE in the table,
    // so this suite neither echoes it nor requires the docs to publish it, and it
    // is recorded here as refuted rather than repeated:
    //   - `.claude-plugin/marketplace.json` is an INSTALL manifest — the one in
    //     this tree lists plugins[].source `./` for a future install;
    //   - `.claude-plugin/plugin.json` names only `./hooks/claude-hooks.json`, and
    //     the neighbouring residual frames that hole as overwriting an
    //     ALREADY-INSTALLED plugin's hook file, which pays off when the host next
    //     READS the manifest — and nothing in this tree establishes when that is;
    //   - plugin ENABLEMENT, which docs/hooks.md itself locates in the covered
    //     `.claude/settings.json` and `~/.claude.json`, governs a load too.
    // So `future session` is absent from CROSS_PROJECT_GROUND on purpose. The docs
    // stay free either to DROP the session clause or to KEEP it with its
    // exceptions named — both satisfy this arm, which is exactly why the arm
    // asserts the project half positively instead of asserting the session half's
    // absence: a negative pin would forbid one of the two honest repairs.
    const disposition = narrowingWindow(
      residuals,
      MCP_RESIDUAL.label,
      MCP_RESIDUAL.opens,
      MCP_RESIDUAL.closes,
    );
    expect(disposition, 'the disposition states the PROJECT-scope ground').toMatch(
      CROSS_PROJECT_GROUND,
    );
    // AND KEEPS ITS HONESTY LABEL, because the ground above is a CONJECTURE about
    // host behaviour, not a measurement: if a host resolved `.mcp.json` by an
    // ancestor walk the way `prettier`, `mocha` and `eslint` resolve theirs,
    // `$HOME/.mcp.json` would govern the CURRENT project and the ground would be
    // FALSE. The label is the only thing stopping the disposition from later
    // reading as settled, so a future edit must not be able to strip it with this
    // suite green — which is precisely what the ground-only pin above allowed.
    expect(disposition, 'the disposition keeps its DERIVED, NOT VERIFIED label').toMatch(
      DERIVED_NOT_VERIFIED,
    );
    expect(disposition, 'the disposition cites the official Claude Code MCP documentation')
      .toContain(CLAUDE_MCP_DOCS);
    expect(disposition, 'the disposition states the documented project-root/current-project fact')
      .toMatch(DOCUMENTED_PROJECT_SCOPE);
    expect(disposition, 'the disposition states the documented plugin CLAUDE_PROJECT_DIR fact')
      .toMatch(PLUGIN_PROJECT_DIR);
    expect(disposition, 'the disposition separates unverified ancestor-walk discovery')
      .toMatch(UNVERIFIED_ANCESTOR_DISCOVERY);
  });

  it('keeps the in-suite `.mcp.json` disposition surface aligned with the same cited proof boundary', async () => {
    const self = flattenForAnchors(await readFile(SELF, 'utf8'));
    const disposition = narrowingWindow(
      self,
      'this suite — the `.mcp.json` disposition comment',
      'A1 — roadmap entry audit-2026-07-29-execution-config-residue',
      'const SELF =',
      false,
    );
    expect(disposition).toContain(CLAUDE_MCP_DOCS);
    expect(disposition).toMatch(DOCUMENTED_PROJECT_SCOPE);
    expect(disposition).toMatch(PLUGIN_PROJECT_DIR);
    expect(disposition).toMatch(UNVERIFIED_ANCESTOR_DISCOVERY);
  });

  for (const site of NARROWING_SITES) {
    it(`${site.label} narrows the claim to exclude the fixed-name companion`, async () => {
      const source = await readFile(
        site.relative === null ? SELF : path.join(root, ...site.relative),
        'utf8',
      );
      const siteText = narrowingWindow(
        flattenForAnchors(source),
        site.label,
        site.opens,
        site.closes,
        site.uniqueOpening,
      );
      // The window really is the site: a mis-resolved anchor lands somewhere
      // that carries neither of these.
      for (const [index, pattern] of site.identity.entries()) {
        expect(siteText, `${site.label}: window identity ${index}`).toMatch(pattern);
      }
      // …and never this block, which is how a self-scanning arm silently pins
      // its own locator instead of the site.
      expect(siteText, `${site.label}: the window is the SITE, not this block`).not.toMatch(
        /NARROWING_SITES/,
      );
      expect(siteText, `${site.label}: names \`.mcp.json\``).toMatch(PINNED_COMPANION);
      expect(siteText, `${site.label}: names what pins that ONE name`).toMatch(NAMES_WHAT_PINS_IT);
      expect(siteText, `${site.label}: keeps the INLINE command form arbitrary`).toMatch(
        KEEPS_THE_INLINE_FORM_OPEN,
      );
    });
  }
});

describe('GREEN GUARD — NAME did not quietly become COVER (green before AND after)', () => {
  it('leaves `.mcp.json` out of both shipped Sets, the published list and the pinned list', async () => {
    // COVER is not merely unchosen, it is INFEASIBLE under this claim set: a
    // Set-literal STRING reaches dist/ape-hooks.bundle.mjs and
    // dist/ape-mcp.bundle.mjs, which __tests__/runtime-v2-bundle-freshness.test.js
    // pins byte-identical to a fresh esbuild, while a COMMENT reaches neither.
    // This guard is also parser hygiene for the arm above: `publishedDocTails`
    // harvests EVERY backticked span between "Covered tails (" and "Why the less
    // obvious ones are in:", so the residual naming MUST land outside that
    // window and an arm requiring it inside would be unsatisfiable by any
    // correct build.
    const source = await readFile(path.join(root, 'lib', 'runtime', 'hooks.js'), 'utf8');
    expect(shippedSetLiteral(source, 'EXECUTION_CONFIG_TAIL')).not.toContain('.mcp.json');
    expect(shippedSetLiteral(source, 'EXECUTION_CONFIG_TAIL_PAIR')).not.toContain('.mcp.json');
    const markdown = await readFile(path.join(root, 'docs', 'hooks.md'), 'utf8');
    expect(publishedDocTails(markdown)).not.toContain('.mcp.json');
    expect(COVERED_TAILS).not.toContain('.mcp.json');
  });

  it('keeps the pinned (tail, ticket-kind) pair count where it was', async () => {
    // Coverage is only ever ADDED here. The two deny arms at the top iterate the
    // ONE list over both ticket kinds, so the pair count is the list length
    // doubled, and this resolution adds no tail and removes none.
    expect(COVERED_TAILS.length * 2, 'pinned (tail, ticket-kind) pairs').toBeGreaterThanOrEqual(
      128,
    );
    const source = await readFile(path.join(root, 'lib', 'runtime', 'hooks.js'), 'utf8');
    const shipped = [
      ...shippedSetLiteral(source, 'EXECUTION_CONFIG_TAIL'),
      ...shippedSetLiteral(source, 'EXECUTION_CONFIG_TAIL_PAIR'),
    ];
    expect(shipped.length * 2, 'shipped (tail, ticket-kind) pairs').toBeGreaterThanOrEqual(128);
  });
});
