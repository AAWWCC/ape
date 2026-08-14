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

export const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'apply_patch']);

// ---------------------------------------------------------------------------
// OUT-OF-PROJECT EXECUTION-REDIRECTING CONFIGURATION
// (roadmap entry `readonly-out-of-project-tool-config-write`).
//
// THE DEFECT THIS NARROWS. The out-of-project allow below returns before the
// read-only deny, so a BOUND subagent — read-only roles included — could write
// ANY file outside the governed project. `$HOME/.npmrc` carrying
// `script-shell=<binary>` changes what the admitted `npm test` EXECUTES with no
// token anywhere on the command line, so no command-string check can see it:
// not the evidence allowlist, not the operand containment of acme PR #368. Sources:
// spike run-fixture-e9d0b87e839d receipt c0b04edd finding 2-RESIDUAL R2,
// and security receipt cb0109c4.
//
// WHY THIS IS NOT A REORDER. Moving the out-of-project allow behind the
// read-only deny closes the family in three lines, and that spike REJECTED it:
// the Claude host injects a per-session scratchpad directive telling subagents
// — read-only roles included — to write their temp files OUTSIDE the project,
// so a blanket deny strands every role that obeys it. The refusal is
// TARGET-SHAPED instead: it refuses the out-of-project targets that REDIRECT
// EXECUTION of an already-admitted evidence command and leaves ordinary
// scratchpad writes admitted. Gated on `out_of_project === true`, it is a pure
// NARROWING of that one allow branch: no in-project verdict moves, and nothing
// denied today becomes allowed.
//
// KEYED ON THE FILENAME, CONTENT-BLIND, AND MONOTONE. Deny-on-presence of a
// covered tail is the only shape this gate is allowed to grow (the monotonicity
// constraint stated above `gitEvidenceArgsSafe`): an admission conditional on
// some token being PRESENT is what made `black . # --check` a live in-place
// write channel. Content is never consulted, and it need not be — the rule sees
// exactly the tools whose payload exposes a path and that the host matcher
// fires on. Ordinary write tools use `file_path`/`filePath`/`path`; apply_patch
// additionally derives every path from its freeform operation headers. A
// malformed patch carrying no valid header remains fail-closed.
//
// SEGMENTS, NEVER A STRING SUFFIX. `endsWith('git/config')` also matches every
// `<anything>/.git/config` — denying writes to any out-of-project repository's
// git config — and `legacy-git/config`; `endsWith('.cargo/config.toml')`
// matches `vendor.cargo/config.toml`. (`foonpm/npmrc` is NOT an instance of
// that class and was cited as one here: bare `npmrc` is itself a single-segment
// entry, so it denies under either scheme.) The separator-blocklist class those
// two real examples belong to has bitten this gate four times. The comparison
// is therefore over whole SEGMENTS, and it is LOWERCASED because APFS is
// case-insensitive: `$HOME/.NPMRC` IS `$HOME/.npmrc`.
//
// THE INCLUSION CRITERION, so the table can be argued with rather than guessed
// at, is THREE SUFFICIENT GROUNDS AND NOT ONE — docs/hooks.md publishes all
// three, labelled (A), (B) and (C), and this comment is kept in step with it
// because a divergent copy of a SECURITY inclusion rule is what a future run
// reads when deciding whether a newly-derived file earns a row. The single
// sentence that used to stand alone here published only (A) and then attributed
// the plugin-manifest and shell-startup rows to it, which (A) never reached.
//
// GROUND (A), the original and the widest: an entry earns its place when a head
// this runtime ALREADY ADMITS as evidence reads that file out of an
// out-of-project home and the file can name a program or import a module. (A)
// governs 48 of the 64 rows — every package-manager, git, cargo, go,
// `*customize.py`, linter and runner entry below. That is why `go/env` sits
// beside `.cargo/config.toml` (`go env -w GOFLAGS=-toolexec=/x`, read by the
// admitted `go test`), why `.mypy.ini` and `mypy/config` are in at all
// (`plugins =` imports arbitrary Python into the admitted `mypy`), why
// `pylint`'s rc files and the user-level config of `prettier`, `eslint` and
// `mocha` sit beside them (`load-plugins =`, `plugins`, a flat config that is
// IMPORTED WHOLE and mocha's `require` bring arbitrary code into four heads
// admitted on exactly the same footing, and each of the four reaches a file at
// `$HOME` for a project that ships none — by a DIFFERENT route per head, stated
// one head at a time because the single sweeping version of this sentence was
// false for two of them: `pylint` performs no find-up walk at all, it reads the
// NAMED user-level locations `~/.pylintrc` and `~/.config/pylintrc`;
// `prettier`'s cosmiconfig search starts at the FILE BEING FORMATTED — not at
// the cwd — and walks up to the HOME DIRECTORY
// (prettier.io/docs/configuration), which is the same statement this file makes
// beside prettier's own entries below and the same one docs/hooks.md publishes;
// `mocha` starts at the cwd and `eslint` at the cwd in v9 and at the LINTED
// FILE from v10, and those two are the ones that walk to the FILESYSTEM ROOT.
// Not one of the four has a project-root stop, and the governed project lives
// under the home directory).
//
// GROUND (B) — THE HOST reads it, and it NAMES A PROGRAM THE HOST THEN RUNS.
// The 7 host-agent and plugin rows are in on this, NOT on (A): `.claude.json`,
// `.claude/settings.json`, `.claude/settings.local.json`, `.codex/config.toml`
// and BOTH hosts' plugin manifests. No admitted EVIDENCE head reads a host or
// plugin manifest — the host does — so (A) never reached any of them, and
// attributing them to it (as this comment once did) published a criterion that
// does not hold. The mechanism: the hook file whose contents declare PreToolUse
// hook COMMANDS, or an `mcpServers` entry's `command`; "declares MCP servers by
// `command`" is ONE INSTANCE of (B) rather than the whole of it, since the other
// five name hook COMMANDS, plugin ENABLEMENT or an install manifest instead.
//
// GROUND (C) — IT REDEFINES THE EXECUTION ENVIRONMENT AN ADMITTED HEAD RUNS IN,
// rather than configuring the head. The 9 shell-startup rows are in on this and
// not on (A) either: `.bashrc`, `.bash_profile`, `.bash_login`, `.profile`,
// `.zshrc`, `.zshenv`, `.zprofile`, `.zlogin` and `.envrc`. No admitted evidence
// head READS a shell rc — the shell is the EXECUTOR of an admitted head rather
// than a head itself — and direnv is not an admitted head at all, so `.envrc`
// sits outside (A)'s reach twice over. This ground was RUNNING in the tree
// unpublished: it is the REDEFINE-rather-than-configure pairing already stated
// beside those entries below, and it is why bash's `.bash_login` and zsh's
// `.zlogin` are in beside their covered siblings — bash runs the FIRST EXISTING
// of `.bash_profile`, `.bash_login`, `.profile`, so covering the outer two and
// not the middle one covers nothing on a machine that has only the middle one.
//
// 48 + 7 + 9 = 64, so no row is left with no published ground. Any ONE ground is
// sufficient; none is necessary.
//
// THE TABLE IS AN ENUMERATION, NOT A CONSTRUCTION. Applying the criterion above
// is a judgment call per head, so absence from this table is NOT evidence that a
// file is harmless: what is deliberately NOT covered — the
// `uv`/`poetry`/`pdm`/`hatch`/`rye`/`pipenv`/`pixi` wrappers' user config, never
// audited entry by entry for an execution-naming key; the `prettier` and
// `mocha` KEYS of a `package.json`, because refusing every out-of-project
// `package.json` is an over-block far larger than the hole it closes; eslint's
// LEGACY `.eslintrc.*` family, which ESLint 9 loads only under
// `ESLINT_USE_FLAT_CONFIG=false` and which therefore needs a derivation of its
// own; the FILES a plugin manifest names — the hook file on the Claude side, the
// `mcpServers` `command` on the codex one, each of whose filename the manifest
// itself chooses, WITH ONE FORM EXCEPTED and it is a NARROWING of that clause
// rather than a hole in it: lib/runtime/plugin-validation.js's
// validateCodexPlugin normalizes a STRING `mcpServers` companion and errors
// unless it is exactly `.mcp.json`, so for THAT form the filename is pinned
// rather than chosen. The pin binds APE'S OWN validator and NOT what a host
// loads from a manifest an attacker overwrote, and it reaches nothing else: a
// string `mcpServers` on the CLAUDE side goes through validateComponentPaths
// with NO name pin, and every INLINE `mcpServers` object names its own
// `command` freely — which is the form this tree's own
// `.codex-plugin/plugin.json` actually uses, so the name-pinned string
// companion is a form nothing here ships. A flat "the companion is name-pinned"
// would overstate the tree in the other direction. `.mcp.json` is RECORDED as a
// residual in docs/hooks.md on a REACHABILITY-CLASS ground stated there rather
// than covered by an entry below. The official Claude MCP documentation
// (https://code.claude.com/docs/en/mcp) documents project-root/current-project
// scope and `CLAUDE_PROJECT_DIR` for plugin-provided MCP configuration; neither
// it nor this tree verifies ancestor-walk discovery. The checked-in declaration
// argv proof establishes APE's host-hint precedence, not Claude's discovery
// algorithm. The `pytest` INI FAMILY, which is the
// find-up shape that earned `eslint`, `prettier` and `mocha` their places and
// is UNCOVERED anyway:
// `pytest.toml`, `.pytest.toml`, `pytest.ini`, `.pytest.ini`, `pyproject.toml`,
// `tox.ini` and `setup.cfg` are searched through ANCESTOR directories to the
// filesystem root (docs.pytest.org/en/stable/reference/customize.html),
// `addopts` and `pythonpath` reach execution from any of them, and an ini
// planted at `$HOME` moves rootdir there and pulls a home-level `conftest.py`
// — a module pytest IMPORTS — into scope. It is not an entry appended here:
// four of those eight names are among the most ordinary filenames in a scratch
// directory, so refusing them on a bare segment is the over-block this refusal
// is shaped to avoid, and the family needs a derivation of its own — is named at
// residual R2 in docs/hooks.md.
//
// AND THE PROMISE THAT LIST MAKES IS BOUNDED. This comment used to end "rather
// than left to a generic caveat", which reads as a guarantee that EVERY admitted
// head absent from the table is named in R2. It is not one, and asserting it is
// how this surface over-read its own diff three times running (`eslint`, then
// `mocha`, then `pytest`, each found missing from both the table and the
// residuals while the sentence was being republished as now-true). R2 names what
// has been DERIVED and left out, and separately names `vitest`, `jest`, `ava`,
// `playwright`, `tap`, `tsc`, `node`, `tox`, `ruff`, `flake8`, `black` and
// `isort` as admitted heads whose user-level configuration has never been
// derived at all — unaudited, which is weaker than cleared. Absence from the
// table remains no evidence that a file is harmless.
//
// Every tail shipped here carries an arm in
// __tests__/runtime-v2-readonly-tool-config-write.test.js, and
// that suite checks the correspondence MECHANICALLY and in both directions,
// against these two Sets and against the list docs/hooks.md publishes: an entry
// with no arm can be deleted with every suite green while the docs still publish
// it, which is how an enumeration silently shrinks.
//
// BOTH LOOKUPS ARE REQUIRED, AND NEITHER SUBSUMES THE OTHER. The refusal
// consults the RAW target and the hook's realpath-RESOLVED one, and the two
// catch OPPOSITE symlink layouts. The RAW half is what catches the
// dotfile-manager layout — under stow/chezmoi `$HOME/.cargo` is a symlink INTO a
// managed store, so resolution ERASES the match (the resolved tail is
// `cargo/config.toml`, which no table carries) and only the raw tail matches at
// all. The RESOLVED half catches the mirror layout, where an ordinary-named path
// (`link/config.toml`) resolves ONTO a covered directory. Deleting either lookup
// silently drops a whole layout; both directions carry an end-to-end arm in
// __tests__/runtime-v2-readonly-tool-config-write.test.js, the raw one paired
// with an ADMIT arm on the store path itself so the erasure is a pinned fact.
//
// The enumeration is durable only while no bound channel can CREATE a link or
// rename a path: `ln` is not a recognized evidence head, `SHELL_WRITE` matches
// it on the main-session arm, and no WRITE_TOOL creates links. Both halves
// therefore cover PRE-EXISTING links only, in either direction, and
// never attacker-made ones — and admitting a rename- or link-capable channel
// later silently reopens the whole family. What stays open (PATH shadowing, the
// `BASH_ENV`/`ENV` half, the codex R6 fallthrough, hardlinks and TOCTOU, a
// relocated host config dir, the uncovered heads above) is published by name at
// residual R2 in docs/hooks.md.
const CONFIG_TAIL_SEPARATOR = /[/\\]/;

// The covered FINAL SEGMENT, lowercased.
const EXECUTION_CONFIG_TAIL = new Set([
  // Package-manager and runtime configuration: these CONFIGURE an admitted
  // head. `.npmrc` `script-shell` is the demonstrated instance; bare `npmrc` is
  // npm's own prefix-level spelling of the same file.
  '.npmrc',
  'npmrc',
  '.yarnrc',
  '.yarnrc.yml',
  '.bunfig.toml',
  // Read-only git IS an admitted evidence family, and `core.pager`, aliases and
  // `core.hooksPath` each redirect an admitted `git status`.
  '.gitconfig',
  // Shell startup: these REDEFINE an admitted head rather than configure it.
  // This is the FILE half of that family only — the `BASH_ENV`/`ENV` half is not
  // a file-write channel at all and no filename rule reaches it. The bash trio
  // is listed in bash's OWN order: it runs the first EXISTING of `.bash_profile`,
  // `.bash_login`, `.profile`, so the middle entry is the one that actually runs
  // on a machine without the first — an enumeration that skipped it would be
  // bypassed by the sibling between two covered entries.
  '.bashrc',
  '.bash_profile',
  '.bash_login',
  '.profile',
  '.zshrc',
  '.zshenv',
  '.zprofile',
  '.zlogin',
  // direnv sources this on entering the directory.
  '.envrc',
  // Imported by `site` at interpreter start, the admitted `python -m pytest`
  // included: `sitecustomize` when it lands anywhere on `sys.path`
  // (site-packages, `PYTHONPATH` — NOT a bare `$HOME/sitecustomize.py` for a run
  // started from the project dir), and `usercustomize` from the user site
  // directory whenever user site is enabled, which is the stronger of the two.
  // Both are keyed on the FILENAME, so each is caught wherever out-of-project it
  // lands, including the site directories that make it load.
  'sitecustomize.py',
  'usercustomize.py',
  // `mypy` is an admitted check-only linter head and its config's `plugins =`
  // key IMPORTS ARBITRARY PYTHON. With no config in the project, mypy falls back
  // to `$XDG_CONFIG_HOME/mypy/config`, `~/.config/mypy/config` and this file.
  '.mypy.ini',
  // `pylint` is an admitted check-only head on exactly the same footing, and its
  // `load-plugins =` key imports arbitrary Python the same way. With no config in
  // the project it reads `~/.pylintrc` and `~/.config/pylintrc` (the pair entry
  // below).
  '.pylintrc',
  // `prettier` is an admitted check-only head too, and its cosmiconfig search
  // walks UP from the linted file to `$HOME`, so a user-level config governs a
  // project that ships none. `plugins` imports arbitrary modules in every
  // spelling, and the `.js`/`.mjs`/`.cjs` AND `.ts`/`.mts`/`.cts` forms ARE
  // arbitrary modules. This is EVERY documented search place
  // (prettier.io/docs/configuration) except the `prettier` KEY of a
  // `package.json`, which is deliberately not covered — refusing every
  // out-of-project `package.json` is an over-block far larger than the hole it
  // closes — and that one residual is published rather than implied. Shipping
  // the `.js` trio without the `.ts` trio was a bypass of entries that ARE
  // covered, on the same argument that puts `.cargo/config` beside
  // `.cargo/config.toml`.
  '.prettierrc',
  '.prettierrc.json',
  '.prettierrc.json5',
  '.prettierrc.yml',
  '.prettierrc.yaml',
  '.prettierrc.toml',
  '.prettierrc.js',
  '.prettierrc.mjs',
  '.prettierrc.cjs',
  '.prettierrc.ts',
  '.prettierrc.mts',
  '.prettierrc.cts',
  'prettier.config.js',
  'prettier.config.mjs',
  'prettier.config.cjs',
  'prettier.config.ts',
  'prettier.config.mts',
  'prettier.config.cts',
  // `eslint` is an admitted check-only head on the identical footing to
  // `prettier`, and its FLAT CONFIG is IMPORTED as a module.
  //
  // THE SEARCH ORIGIN, STATED PRECISELY — the previous revision of this comment
  // had it wrong in the direction that flattered the conclusion. ESLint 9
  // searches from the CURRENT WORKING DIRECTORY by default and walks ancestors
  // upward until it finds an `eslint.config.*`; starting from the directory of
  // the FILE BEING LINTED is what the `v10_config_lookup_from_file` feature flag
  // (earlier `unstable_config_lookup_from_file`) opts into, and it is the
  // DEFAULT only from ESLint 10, where the flag itself was removed. The security
  // conclusion is UNCHANGED under either origin, which is why the entries do not
  // move: NEITHER has a project-root stop, both walk up ancestors to the
  // FILESYSTEM ROOT, and the cwd of an evidence command is inside the governed
  // project — which lives under the home directory — so a config planted at
  // `$HOME` governs every project beneath it that ships none. THIS repository
  // ships none, which makes it one of those projects. These six are the whole
  // flat-config search list, cited at the version this paragraph is ABOUT
  // rather than at `latest`, which now documents ESLint 10 and would undercut
  // the v9 DEFAULT sentence it supports (eslint.org/docs/v9.x/use/configure/
  // configuration-files). The LEGACY `.eslintrc.*` family is deliberately NOT
  // here: ESLint 9 does not load it unless `ESLINT_USE_FLAT_CONFIG=false`, so it
  // is a version-gated surface with a derivation of its own, and it is published
  // at residual R2 rather than smuggled in behind this one.
  'eslint.config.js',
  'eslint.config.mjs',
  'eslint.config.cjs',
  'eslint.config.ts',
  'eslint.config.mts',
  'eslint.config.cts',
  // `mocha` is an admitted runner head in TWO positions — bare, and after
  // npx/pnpm/yarn/bun — and it resolves its rc file with exactly the find-up
  // walk that earns `eslint` and `prettier` their places: mocha looks in the cwd
  // and, failing that, searches parent directories until one is found or the
  // FILESYSTEM ROOT is reached (mochajs.org/running/configuring). No
  // project-root stop, so a file at the home directory governs every project
  // below it that ships none, and this repository ships none.
  //
  // ALL SEVEN DOCUMENTED SPELLINGS, in mocha's own priority order, and not only
  // the three that are JavaScript: `.mocharc.cjs`, `.mocharc.js` and
  // `.mocharc.mjs` are MODULES mocha loads, while the YAML and JSON spellings
  // are data that reaches arbitrary execution anyway — an rc file may set ANY
  // command-line option, and `require` names a module loaded before the test
  // files, so `{"require": "<path>"}` in `.mocharc.json` runs arbitrary code
  // exactly as `plugins` does from `.prettierrc.json`. Shipping the module
  // spellings without the data ones would be the trivially equivalent bypass
  // this table already refuses for `.cargo/config` beside `.cargo/config.toml`.
  //
  // NOT here, named rather than left implied: the `mocha` KEY of a
  // `package.json` (the same residual, for the same over-block reason, as
  // prettier's `prettier` key) and the extension-less `.mocharc`, which mocha
  // does not search for at all.
  '.mocharc.cjs',
  '.mocharc.js',
  '.mocharc.mjs',
  '.mocharc.yaml',
  '.mocharc.yml',
  '.mocharc.jsonc',
  '.mocharc.json',
  // HOST-AGENT configuration, named rather than left to a generic "this is an
  // enumeration" caveat: `~/.claude.json` declares MCP servers by `command`.
  '.claude.json',
]);

// The covered FINAL TWO SEGMENTS, lowercased and joined with `/`. A bare
// `config`, `config.toml` or `settings.json` is far too ordinary a scratch
// filename to refuse on its own, so each is keyed on the directory that gives
// it its meaning.
const EXECUTION_CONFIG_TAIL_PAIR = new Set([
  // XDG spellings of files already covered in their dotfile form.
  'npm/npmrc',
  'git/config',
  'mypy/config',
  // cargo still honors the extension-less spelling, so covering only the
  // `.toml` one would leave a trivially equivalent bypass of an entry that IS
  // covered.
  '.cargo/config.toml',
  '.cargo/config',
  // The exact peer of the cargo entries: `go env -w GOFLAGS=-toolexec=/x` writes
  // `os.UserConfigDir()/go/env` (`~/Library/Application Support/go/env`,
  // `$XDG_CONFIG_HOME/go/env`) and the admitted `go test` reads it, so an
  // arbitrary program runs for every tool invocation. Two-segment: a bare `env`
  // is one of the most ordinary scratch filenames there is.
  'go/env',
  // pylint's XDG location, keyed on its directory: a bare `pylintrc` outside a
  // config directory is an ordinary scratch filename, and stays admitted.
  '.config/pylintrc',
  // Host-agent configuration, and the highest-value target on the host this
  // runtime actually runs on: the Claude settings file declares PreToolUse hook
  // COMMANDS — arbitrary execution on every tool call, and the one file that can
  // disable this very gate — and the codex `config.toml` is its peer. Keyed on
  // the DIRECTORY NAME, so a host config dir relocated by `CLAUDE_CONFIG_DIR`
  // (or `CODEX_HOME`) is NOT covered; that residual is published with the rest.
  '.claude/settings.json',
  '.claude/settings.local.json',
  '.codex/config.toml',
  // THE PLUGIN MANIFEST SURFACE, on BOTH hosts, which reaches arbitrary
  // execution through the SAME mechanism that puts `.claude/settings.json` and
  // `~/.claude.json` in this table: a plugin manifest NAMES A PROGRAM the host
  // then runs — the hook file whose contents declare PreToolUse hook COMMANDS,
  // or an `mcpServers` entry's `command`. This repository is registered exactly
  // that way on both: its own `.claude-plugin/plugin.json` carries `"hooks":
  // "./hooks/claude-hooks.json"`, `.claude-plugin/marketplace.json` is the
  // manifest it is installed by, and `.codex-plugin/plugin.json` — shipped in
  // this very tree — declares `mcpServers.ape.command` =
  // `./dist/ape-mcp.bundle.mjs`.
  //
  // The codex manifest is here on the host-agent entries' OWN stated criterion,
  // "declares MCP servers by `command`", which it meets literally. Covering the
  // Claude pair alone was a host-SPECIFIC closure advertised as a host-neutral
  // one, and invariant 6 is why it cannot be dispositioned as a residual: a rule
  // that closes one host's manifest and leaves the other's open is host policy
  // in a host-neutral runtime.
  //
  // The FILES a manifest points at — the hook file, the `command` binary — are
  // arbitrarily NAMED by that manifest, so no enumeration reaches them; the
  // manifests that name them can be enumerated, which is why these three entries
  // are the manifests and not the files they point at. Plugin ENABLEMENT needs
  // no entry of its own: it lives in the already-covered
  // `.claude/settings.json` and `~/.claude.json`.
  //
  // ONE FORM IS EXCEPTED FROM "arbitrarily NAMED", and it is a narrowing of that
  // sentence rather than a hole in it. lib/runtime/plugin-validation.js's
  // validateCodexPlugin normalizes a STRING `mcpServers` companion and errors
  // unless it is exactly `.mcp.json`, so for THAT one form the filename is
  // pinned rather than chosen. The pin binds APE'S OWN validator, not what a
  // host loads from a manifest an attacker overwrote, and it reaches nothing
  // else: a string `mcpServers` on the CLAUDE side goes through
  // validateComponentPaths with NO name pin, and every INLINE `mcpServers`
  // object names its own `command` freely — the form this tree's own
  // `.codex-plugin/plugin.json` uses, so the name-pinned string companion is a
  // form nothing here ships. `.mcp.json` is deliberately NOT an entry below: it
  // is RECORDED as a residual in docs/hooks.md on a REACHABILITY-CLASS ground
  // whose one surviving half is PROJECT SCOPE — a `.mcp.json` at another project
  // ROOT governs THAT project, whereas every row in this table is reachable from
  // the CURRENT one. The SESSION half is NOT part of that ground, and stating it
  // here as one would diverge from docs/hooks.md, which now says why: rows
  // already IN this table pay off on a LATER load — an INSTALL manifest, the
  // hook file a manifest names, plugin ENABLEMENT — so "every row redirects the
  // CURRENT session" is false of the table itself. Official Claude MCP docs at
  // https://code.claude.com/docs/en/mcp document project-root/current-project
  // scope and plugin-provided `CLAUDE_PROJECT_DIR`, not ancestor-walk
  // discovery; the checked-in argv proof likewise establishes APE's hint
  // precedence, not host discovery. That ground is DERIVED, NOT VERIFIED and
  // is labelled so where it is stated in full.
  '.claude-plugin/plugin.json',
  '.claude-plugin/marketplace.json',
  '.codex-plugin/plugin.json',
]);

// LOWERCASING IS CASE MAPPING; A CASE-INSENSITIVE FILESYSTEM RESOLVES BY CASE
// FOLDING, AND THE TWO DISAGREE. `String.prototype.toLowerCase` leaves U+017F
// (LATIN SMALL LETTER LONG S) exactly as it found it, while simple case folding
// maps it onto `s` — so `$HOME/.ba<U+017F>hrc` is a name the segment compare
// below reads as unrelated to `.bashrc` and `open(2)` on a folding filesystem
// resolves to the real file. The premise was verified rather than assumed;
// docs/research/2026-07-29-execution-config-case-folding.md records the method
// and the answer, and __tests__/runtime-v2-execution-config-case-folding.test.js
// re-derives both halves on whatever host runs the suite. The live half is
// CREATE, not overwrite: realpath cannot canonicalize a file that does not exist
// yet, so the resolved lookup rescues nothing there — and a machine with no
// `~/.zlogin` is exactly where planting one wins. U+212A (KELVIN SIGN) is NOT a
// second vector: `toLowerCase` already maps it to `k`.
//
// THE SHAPE IS FOLD-THEN-COMPARE, AS A SECOND ATTEMPT AND NEVER A REPLACEMENT.
// Refusing every segment that merely CONTAINS a non-ASCII character is the fix
// this must not be: an out-of-project scratch file with an accented or CJK name
// is ordinary, and keeping the scratchpad open is this whole refusal's design
// constraint. Matching the same tables a second time under case folding is
// MONOTONE (a second attempt can only ADD denials — the lowercase compare is
// untouched and still runs first, so no segment becomes MORE admissible than it
// is today; the monotonicity constraint stated above `gitEvidenceArgsSafe`),
// SYNCHRONOUS (it consults no filesystem, so `evaluateLifecyclePolicy` stays
// synchronous), TOTAL (it decides every string without throwing), and
// HOST-NEUTRAL (invariant 6): the verdict is a property of the SPELLING, not of
// the filesystem underneath. Probing the host for case-insensitivity would make
// one payload decide differently on darwin and on Linux, which is exactly what
// invariant 6 forbids; the accepted price is that on a case-sensitive filesystem
// this over-blocks a filename nobody legitimately writes.
//
// The folding primitive is a `u`-flagged case-insensitive RegExp, which
// canonicalizes by SIMPLE CASE FOLDING, so no Unicode table of its own is
// needed. The patterns are built ONCE from the tables above, and the fold pass
// runs only for a segment that actually carries a non-ASCII code point — for
// pure ASCII, folding and lowercasing agree by construction, so the common path
// is byte-for-byte the compare it always was.
//
// FULL FOLDING IS THE OTHER HALF, AND A REGEXP DOES NOT REACH IT. Simple folding
// maps one code point onto one; FULL folding maps a handful onto MULTI-CHARACTER
// sequences, and a `u`-flagged RegExp performs the simple mapping only — so
// `.bunﬁg.toml` (U+FB01) and `.gitconﬁg` stayed unrelated strings to the pattern
// above while the filesystem resolved them onto the covered names (observed on
// darwin/APFS by the authored suite, which re-derives it per shipped tail rather
// than trusting this note). The claim that this "cannot bite while no table
// entry contains the expansion" was simply FALSE: every `config` and `profile`
// entry carries `fi`, and `sitecustomize.py`/`usercustomize.py` carry `st`.
//
// The closure is an EXPANSION TABLE consulted before the same pattern match, and
// it is small and CLOSED rather than a normalization pass: of every full-fold
// mapping in CaseFolding.txt, exactly nine expand to pure ASCII — U+00DF and
// U+1E9E onto `ss`, and the seven U+FB00..U+FB06 ligatures. Every other
// multi-character mapping expands to a sequence that is itself non-ASCII (U+0130
// and U+01F0 onto a letter plus a combining mark, U+0149, the U+1E96..U+1E9A
// group, the Greek and Armenian ligatures), so it cannot collide with a table in
// which no entry is non-ASCII — by CONSTRUCTION, not by luck. Expanding is
// MONOTONE for the same reason the RegExp pass is (it is a third attempt, after
// both compares that already ran) and it can never LOSE a match either, since no
// entry contains a ligature for the expansion to destroy. NFKC normalization was
// rejected: it rewrites far more than these nine and would make the gate inspect
// a materially different string from the one the OS receives.
const NON_ASCII_SEGMENT = /\P{ASCII}/u;

const REGEXP_META = /[.*+?^${}()|[\]\\]/g;

const FULL_FOLD_ASCII_EXPANSION = new Map([
  ['ß', 'ss'], // U+00DF LATIN SMALL LETTER SHARP S
  ['ẞ', 'ss'], // U+1E9E LATIN CAPITAL LETTER SHARP S
  ['ﬀ', 'ff'], // U+FB00 LATIN SMALL LIGATURE FF
  ['ﬁ', 'fi'], // U+FB01 LATIN SMALL LIGATURE FI
  ['ﬂ', 'fl'], // U+FB02 LATIN SMALL LIGATURE FL
  ['ﬃ', 'ffi'], // U+FB03 LATIN SMALL LIGATURE FFI
  ['ﬄ', 'ffl'], // U+FB04 LATIN SMALL LIGATURE FFL
  ['ﬅ', 'st'], // U+FB05 LATIN SMALL LIGATURE LONG S T
  ['ﬆ', 'st'], // U+FB06 LATIN SMALL LIGATURE ST
]);

// DERIVED from the Map rather than written out beside it, so the scanner and the
// expansion cannot drift apart and substitute an `undefined`. No key is a RegExp
// metacharacter, so no escaping is required and none is silently skipped.
const FULL_FOLD_ASCII_SOURCE = new RegExp(
  `[${[...FULL_FOLD_ASCII_EXPANSION.keys()].join('')}]`,
  'gu',
);

function expandFullFolds(segment) {
  return segment.replace(
    FULL_FOLD_ASCII_SOURCE,
    (char) => FULL_FOLD_ASCII_EXPANSION.get(char) ?? char,
  );
}

function foldedTailPatterns(table) {
  return [...table].map((entry) => [
    new RegExp(`^${entry.replace(REGEXP_META, '\\$&')}$`, 'iu'),
    entry,
  ]);
}

const EXECUTION_CONFIG_TAIL_FOLDED = foldedTailPatterns(EXECUTION_CONFIG_TAIL);

const EXECUTION_CONFIG_TAIL_PAIR_FOLDED = foldedTailPatterns(EXECUTION_CONFIG_TAIL_PAIR);

// Simple folding first (the RegExp), then the same patterns against the
// full-fold expansion of the same candidate. Two attempts, both additive.
function foldedTailMatch(patterns, candidate) {
  const expanded = expandFullFolds(candidate);
  for (const [pattern, entry] of patterns) {
    if (pattern.test(candidate) || pattern.test(expanded)) return entry;
  }
  return null;
}

// The matched tail, or null. Pure, total and synchronous: it takes an already
// absolute path (the raw `target_path`, or the hook's realpath-resolved one) and
// compares whole lowercased segments against the two tables above, then — only
// for a segment carrying a non-ASCII code point — the same segments again under
// case folding, simple and full. The returned value is always a TABLE ENTRY,
// never caller-supplied text, so a deny reason can interpolate it unbounded and
// a folded spelling never echoes the caller's own bytes back into a hook
// response.
export function executionConfigTail(target) {
  if (typeof target !== 'string' || target.length === 0) return null;
  const segments = target.split(CONFIG_TAIL_SEPARATOR).filter((segment) => segment.length > 0);
  if (segments.length === 0) return null;
  const rawLast = segments[segments.length - 1];
  const last = rawLast.toLowerCase();
  if (EXECUTION_CONFIG_TAIL.has(last)) return last;
  const rawPair = segments.length < 2 ? null : `${segments[segments.length - 2]}/${rawLast}`;
  if (rawPair !== null && EXECUTION_CONFIG_TAIL_PAIR.has(rawPair.toLowerCase())) {
    return rawPair.toLowerCase();
  }
  if (NON_ASCII_SEGMENT.test(rawLast)) {
    const folded = foldedTailMatch(EXECUTION_CONFIG_TAIL_FOLDED, rawLast);
    if (folded) return folded;
  }
  if (rawPair !== null && NON_ASCII_SEGMENT.test(rawPair)) {
    return foldedTailMatch(EXECUTION_CONFIG_TAIL_PAIR_FOLDED, rawPair);
  }
  return null;
}


// Main-session shell gating is a BLOCKLIST (defense in depth), not a sandbox:
// it enumerates the write channels an orchestrator session naturally reaches
// — file verbs (including the touch/truncate/ln/install/patch family), the
// git working-tree mutators (apply, restore, checkout, switch, reset, stash,
// am, cherry-pick, revert, merge, rebase, pull, clean; audit finding 1.7),
// sed -i, redirects (spaced or not), inline interpreters, dd. A write verb
// the blocklist still does not enumerate is caught by the backstops: every
// main-session Bash POST event runs tree reconciliation while a run is
// writing (driftGuardApplies no longer keys solely off this pattern for the
// main session, so an unenumerated mutation surfaces as an unattributed tree
// change at its own post event instead of being laundered into a pending
// ticket), and receipt-time diff recomputation rejects any unclaimed write
// before it can ride into an accepted run. See docs/hooks.md. Pattern notes:
// over-blocking is the safe direction for a blocklist — `git stash list` and
// the quoted-`>` false positive (`grep 'a>b'`) are accepted denials, while
// the operator's read-only recovery verbs (git status|diff|log ...) stay
// deliberately outside the git-mutation arm. The no-space redirect arm
// excludes `->` (git log --format="%h -> %p") and `2>&1`-style fd dups. The
// interpreter arm anchors on a separator so `ssh -c cipher` never matches
// `sh -c`, and the git arm anchors both `git` and its verb so `git log
// --grep reset` never matches `git reset`.
export const SHELL_WRITE = /(?:^|[\s;&|])(?:rm|mv|cp|tee|touch|truncate|ln|install|patch)\s|(?:^|[\s;&|])git\s+(?:apply|restore|checkout|switch|reset|stash|am|cherry-pick|revert|merge|rebase|pull|clean)\b|(?:^|[\s;&|])sed\s+[^\n]*-[a-z]*i|\s(?:>|>>)\s*\S+|(?:^|[^<>-])>{1,2}(?!&)|(?:^|[\s;&|])(?:node\s+(?:-e|--eval)|python3?\s+-c|perl\s+-e|ruby\s+-e|(?:ba|z)?sh\s+-c)|(?:^|[\s;&|])dd\s[^\n]*\bof=/i;

// Deletion channel. The sanctioned WRITE_TOOLS can only replace content, never
// remove a file, so a whole-file-deletion ticket is unsatisfiable without a
// shell channel. `rm` / `git rm` get their own aggressively fail-closed grammar:
// no chaining, no globs, no quoting, no substitution, no expansion — a single
// forbidden character rejects the whole command — and flags come from a fixed
// whitelist. Parsing yields only the target tokens; bin/ape-hook.mjs resolves
// each target against the ticket claims (same claims selection and realpath
// semantics as the host edit tool) and the role rules, and the policy consumes
// the precomputed event.deletion. A parsed deletion never falls through to the
// generic evidence-command channel.
// ---------------------------------------------------------------------------
// THE CHARACTER HAZARD CLASS, shared by BOTH gated shell channels — this one and
// the evidence allowlist below. It refuses a code point whose presence makes the
// STRING THIS FILE INSPECTS differ from the BYTES THE SHELL AND THE KERNEL
// RECEIVE. It is stated as CATEGORIES, never as an enumeration, and that is
// exactly why sharing THIS constant between the two channels is sound while
// sharing an ALPHABET is not (the DELETION TARGET ALPHABET note directly below
// says where the two alphabets must differ, and why): a category refusal only
// ever REFUSES MORE, and the argument for each category is about BYTES, which is
// identical in both threat models.
//   [^\S ]   any whitespace but U+0020. JS `/\s+/` (and `\b`) split on CR, VT,
//            FF, U+00A0, U+2028, U+2029 and U+FEFF while the shell's default IFS
//            does not, so the gate would tokenize DIFFERENTLY from the shell.
//   \p{Cc}   control characters. U+0000 truncates argv at execve, so the KERNEL
//            runs a shorter command than the one that was vetted.
//   \p{Cf}   invisible format characters (U+200B, U+00AD, U+202E). They cannot
//            forge a recognized head — head recognition is exact-token equality,
//            so a head carrying one is simply not the head — but they make
//            OPERANDS and DENY REASONS unauditable, and U+202E reverses the
//            rendered direction of everything after it.
//   \p{Cs}   a LONE SURROGATE. A JS string may hold one; encoding it as UTF-8
//            substitutes U+FFFD, so the bytes the shell receives are not the code
//            points this file inspected. DERIVED, NOT verified in vivo — the host
//            tool transport re-encodes, so no live probe can carry one through.
// NAMED FOR THE RANGE WHERE IT IS LOAD-BEARING. Below U+0080 both alphabets
// already refuse every character outside their own set, so this class only ever
// ADDS refusals at or above U+0080; it is applied to the whole string anyway
// because a category test is cheaper than a range-restricted one.
// TOTALITY: two single character classes under one alternation — no quantifier,
// so no backtracking, and no /g, so no lastIndex state (see DEV_NULL_REDIRECT).
export const NON_ASCII_HAZARD = /[^\S ]|[\p{Cc}\p{Cf}\p{Cs}]/u;

// THE DELETION TARGET ALPHABET IS A POSITIVE ALLOWLIST. It replaces
// `DELETION_UNSAFE_CHARS`, which was a BLOCKLIST of shell metacharacters
// (`/[\n;|&<>`$(){}*?[\]~"'\\]/`) — converted in the SAME phase as the evidence
// gate's, because leaving one channel a blocklist and the other an allowlist
// while this file calls them "the same shape" is precisely the reuse trap round
// 5 fell into. A backslash is still refused, now by construction rather than by
// name: a backslash-escaped `\.\.` reads as literal path segments to
// normalizePath (which never equals `..`) yet the host shell de-escapes it back
// to `..` and deletes outside the claims.
//
// THE TWO ALPHABETS SHARE A SHAPE, NOT A THREAT MODEL, and they DIFFER ON
// PURPOSE. This one is the evidence alphabet MINUS the three characters that
// carry a zsh WORD-LEVEL EXPANSION — `~`, `=`, `^` — refused WHOLESALE here
// rather than by POSITION as the evidence gate refuses them, because every `rm`
// operand is a path and the effect is unrecoverable:
//   `~`  tilde expansion. Never the harmless `git log HEAD~3` it is over there.
//        Refused wholesale by the blocklist too; unchanged.
//   `=`  zsh EQUALS expansion replaces a word BEGINNING with `=` by the full path
//        of the command it names. The blocklist omitted it, so `rm =node` parsed
//        to the target `=node`, bin/ape-hook.mjs resolved `<sessionCwd>/=node` —
//        LEXICALLY INSIDE the project — and admission turned only on
//        pathResolvesWithinClaims, which PASSES whenever the session cwd sits in
//        a claimed subdirectory, while the shell deletes the absolute path of
//        whatever `node` names. The round-5 note that this constant's shared `#`
//        omission was safe here "because admission is MONOTONE under truncation"
//        DOES NOT EXTEND TO IT: EQUALS is a SUBSTITUTION, not a truncation — it
//        does not drop a target, it REPLACES a contained relative one with an
//        absolute out-of-project one, which is the opposite direction.
//   `^`  the EXTENDED_GLOB exclusion operator. `rm ^a.js` under `setopt
//        extended_glob` expands to every file in the directory EXCEPT `a.js` —
//        an unrecoverable multi-file delete from a token vector the gate read as
//        one target. The option is unset in the observed session but is common in
//        shipped profiles, and the host sources the operator profile.
// NAMED OVER-BLOCK COST, so the refusal is a decision rather than an accident: a
// filename containing `#`, `!`, `~`, `=`, `^`, a TAB, a U+00A0, a control or an
// invisible format character cannot be deleted through this channel at all. The
// blocklist already refused a quote, a backslash and `*?[]~;|&<>$(){}`, and a
// name carrying a space was never expressible here (the split makes it two
// targets). `%`, `,` and `+` REMAIN deletable — they carry no shell meaning in
// either shell and sit in both alphabets, and the derivation this phase
// inherited listed them as costs in error.
// DO NOT RE-SYNC THE TWO ALPHABETS. They must differ on `~`, `=` and `^`.
const DELETION_TOKEN_CHAR_REFUSED = /[^ A-Za-z0-9\-_.\/:@,%+\u{80}-\u{10FFFF}]/u;

const RM_FLAGS = new Set(['-f', '-r', '-rf', '-fr']);

const GIT_RM_FLAGS = new Set(['-f', '--force', '-q', '--quiet', '--cached', '-r']);

export function parseDeletionCommand(command) {
  if (typeof command !== 'string') return null;
  if (DELETION_TOKEN_CHAR_REFUSED.test(command) || NON_ASCII_HAZARD.test(command)) return null;
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  let flags;
  // Narrow a copy, not tokens[0]: shift/splice do not reset tsc's element
  // narrowing, so comparing tokens[0] against '--' below would be flagged as
  // an impossible '"rm" | "git"' comparison.
  const head = tokens[0];
  if (head === 'rm') {
    flags = RM_FLAGS;
    tokens.shift();
  } else if (head === 'git' && tokens[1] === 'rm') {
    flags = GIT_RM_FLAGS;
    tokens.splice(0, 2);
  } else {
    return null;
  }
  while (tokens.length > 0 && tokens[0] !== '--' && flags.has(tokens[0])) tokens.shift();
  if (tokens[0] === '--') tokens.shift();
  if (tokens.length === 0 || tokens.some((token) => token.startsWith('-'))) return null;
  return { targets: tokens };
}

// ---------------------------------------------------------------------------
// WRITE-CONTENT BYTE GATE (roadmap entry authored-and-agent-facing-byte-
// integrity, WRITE side). Every gate above this point inspects a write-tool
// call's TARGET PATH (event.file / event.path_safe) or a Bash COMMAND string
// (event.command, event.deletion) — never the CONTENT a Write/Edit/MultiEdit/
// NotebookEdit call carries — so a decoded control, DEL/C1, or bidi/format
// code point in that content reached tracked source untouched by a gate that
// believes it is inspecting a safe operation.
//
// ROUTE TABLE, enumerated rather than an ad hoc per-tool if-chain — the same
// self-policing idiom EVIDENCE_COMMAND_HEADS below states: each entry names
// the tool and reads every content-bearing string out of THAT tool's own
// tool_input shape, so a tool added here with no route is a one-line miss
// rather than a buried branch. Every WRITE_TOOLS member (above) has an entry
// below EXCEPT Bash heredoc content, which is not a WRITE_TOOLS member at all
// but a SIXTH content-bearing channel the run objective names beside the five
// tool routes: this gate structurally cannot see it, because
// normalizeLifecycleEvent (below) extracts only `tool_input.command` for a
// Bash event, never a heredoc body piped in on stdin, and no JSON field of a
// PreToolUse Bash event carries one for this hook to read. Recorded here
// rather than silently unguarded.
// Exported (never merely a local constant) so the residual is PUBLISHED
// rather than only commented: a reader of this module's surface — or a future
// coverage arm built on the EVIDENCE_COMMAND_HEADS idiom — can see the one
// content-bearing route this gate structurally cannot reach without
// re-deriving it from prose.
export const WRITE_CONTENT_UNREACHABLE_ROUTE =
  "Bash heredoc content is not covered: bin/ape-hook.mjs's Bash channel reads only tool_input.command, never a heredoc body, so no JSON field of a PreToolUse Bash event carries it for this gate to inspect";

// Security review, non-blocking: a coverage arm that tests a WRITE_TOOLS
// member's membership in the residual above with String#includes is a
// SUBSTRING match against an English sentence — one that happens to contain
// the word "Bash" and would rubber-stamp a future WRITE_TOOLS member spelled
// literally as "Bash" as covered by the residual even though it names no such
// tool. Exported here as an exact, enumerable Set so a coverage arm can match
// membership instead: EMPTY today, because every current WRITE_TOOLS member
// (Edit, Write, MultiEdit, NotebookEdit, apply_patch) has its own
// WRITE_CONTENT_ROUTES entry — the prose above describes a channel outside
// WRITE_TOOLS entirely (Bash heredoc content), not a WRITE_TOOLS member left
// uncovered, so nothing belongs in this Set until that changes.
// Review, non-blocking: Object.freeze here seals the Set OBJECT's own
// properties (and the exported binding is a `const`), never its internal
// [[SetData]] — `.add()`/`.delete()` still succeed on a frozen Set, so this
// is discipline this module observes (nothing in this file ever calls `.add`
// on it; only `.has()` reads it), not a runtime-enforced immutability
// guarantee.
export const WRITE_CONTENT_UNREACHABLE_TOOLS = Object.freeze(new Set());

const WRITE_CONTENT_ROUTES = Object.freeze([
  Object.freeze({ tool: 'Write', extract: (input) => [input?.content] }),
  Object.freeze({ tool: 'Edit', extract: (input) => [input?.new_string] }),
  Object.freeze({
    tool: 'MultiEdit',
    extract: (input) => (Array.isArray(input?.edits) ? input.edits.map((edit) => edit?.new_string) : []),
  }),
  Object.freeze({ tool: 'NotebookEdit', extract: (input) => [input?.new_source] }),
  // apply_patch is a governed WRITE_TOOLS member and one of only three write
  // tools the shipped Codex host matcher (hooks/hooks.json) registers, so
  // leaving it out of this table (as a prior revision did) closes the gate
  // for a third of the registered write surface with no recorded reason —
  // unlike Bash heredoc content above, this channel really does carry its
  // payload in the PreToolUse event; the gap was an omission, not a
  // structural limit. Its tool_input SHAPE is DERIVED-NOT-VERIFIED, in the
  // same sense docs/hooks.md uses that label elsewhere: the vendor tool has
  // shipped at least two shapes (an older function-style call with a single
  // `input` string carrying the whole patch document, and a newer freeform
  // tool that some hosts surface as a shell-style `{command: ['apply_patch',
  // <patch text>]}`), and this project has not verified which one this
  // runtime's own host delivers. Rather than assert one schema, every
  // plausible content-bearing field is scanned — extracting more candidates
  // than the real shape needs only ADDS scanning coverage, it can never
  // narrow it, and an absent field simply yields `undefined`, which
  // firstWriteContentHazard (below) already treats as no hazard. A host that
  // delivers the patch body under some OTHER field name stays uncovered by
  // this route, same as any undiscovered field would.
  //
  // REACH, recorded rather than implied: this route is hardened, not a
  // closed bypass, and this extractor is NOT skipped for any shape below.
  // bin/ape-hook.mjs computes event.write_content_hazard for every
  // bound-ticket event whether or not an explicit path field is present —
  // content is orthogonal to path. normalizeLifecycleEvent accepts the legacy
  // `file_path`/`filePath`/`path` fields (including input.file_path), and for
  // Codex's native freeform shape it derives every target from the patch's
  // Add/Update/Delete/Move headers. Every derived target is then checked
  // against the ticket; only a malformed patch with no valid target header
  // retains the fail-closed missing-path verdict. The content verdict is still
  // consumed only after path, claim, role, and scope authorization succeeds.
  Object.freeze({
    tool: 'apply_patch',
    extract: (input) => {
      // A tool_input that is itself a string (one more DERIVED-NOT-VERIFIED
      // shape: a caller that hands the whole patch document as the
      // top-level value rather than nesting it under `input`/`patch`/
      // `command`) was scanned nowhere before this — `input?.input` and
      // `input?.patch` are both undefined on a string, so it fell through
      // silently. typeof input === 'string' catches it the same way the
      // `command` string arm below catches its own shape.
      const candidates = typeof input === 'string' ? [input] : [input?.input, input?.patch];
      // Security review, non-blocking: a THIRD shell-style shape carries
      // `command` as a bare STRING (`{command: 'apply_patch <patch text>'}`)
      // rather than the array form `{command: ['apply_patch', <patch
      // text>]}` the comment above already scans. Array.isArray is false for
      // a string, so that shape reached no candidate at all until now — one
      // more DERIVED-NOT-VERIFIED shape scanned defensively, same as the
      // other two, never a narrowing.
      // A caller-supplied `command` array is walked with a bounded for-of,
      // never spread into Array#push: bin/ape-hook.mjs admits up to
      // INPUT_CAP_BYTES (8 MB) of stdin, so a `command` array of roughly one
      // to two million short elements exceeds V8's spread-argument call
      // limit and throws a RangeError. The top-level catch in
      // bin/ape-hook.mjs still fails closed on that throw, so this was
      // robustness rather than an admitted bypass, but the deny reason it
      // produced misattributed the cause to the wrong check; a for-of has no
      // such argument-count limit.
      if (Array.isArray(input?.command)) {
        for (const item of input.command) candidates.push(item);
      } else if (typeof input?.command === 'string') {
        candidates.push(input.command);
      }
      return candidates;
    },
  }),
]);

// The hazard class this gate refuses STARTED as the identical code-point set
// receipt-service.js's SCOPE_EXPANSION_CONTROL_CHARS / pipeline.js's
// TEST_REMEDIATION_CONTROL_CHARS use (character policy 2 of the FIVE
// enumerated at service.js's own comment naming all five — deliberately NOT
// unified with policy 1, BOUNDED_SUMMARY_CONTROL_CHARS, which additionally
// neutralizes U+200C/U+200D; see that enumeration for why unifying them would
// reverse a recorded decision), and is still DUPLICATED rather than imported,
// for the same reason: write-policy.js is imported by lifecycle-policy.js (service.js's own
// acyclicity note — it already imports this file, so the reverse edge would
// cycle) and by pipeline.js's own sibling copy's reasoning.
//
// SECURITY REVIEW, BOTH BLOCKING — WIDENED THIS COPY ONLY, ON PURPOSE. This
// gate alone governs bytes that become part of the SOURCE THIS RUNTIME
// EXECUTES; the other two copies bound OPERATOR-FACING TEXT (a bounded
// evidence summary), a materially different threat model, so a hand-picked
// Cf subset that misses a live bypass is a strictly worse trade here than
// there. Two findings, both against the class this gate already claimed to
// refuse:
//   - U+2028 LINE SEPARATOR / U+2029 PARAGRAPH SEPARATOR were admitted (their
//     own Unicode General_Category is Zl/Zp, not Cc/Cf/Cs, so the numeric
//     enumeration below jumped over them). Both are ECMAScript
//     LineTerminators: `// ordinary comment<U+2028>maliciousCall();` ends the
//     single-line comment and EXECUTES `maliciousCall()`, while `git diff`
//     and a terminal still render one visual comment line — exactly the
//     read-differs-from-executes class this gate exists to refuse.
//   - U+FEFF (invisible, and WhiteSpace in ECMAScript, so it can split an
//     identifier a reviewer reads as one token) and the whole astral TAGS
//     block (U+E0001, U+E0020-U+E007F — the canonical invisible-text
//     instruction-smuggling channel) were admitted: the enumeration below was
//     a hand-picked SUBSET of \p{Cf}, not the category itself, so it missed
//     both. This is the direct threat to this gate's own AGENT-FACING half —
//     a bound implementer could embed TAG-encoded instructions in a source
//     comment that a later agent reads as raw bytes while every human
//     reviewer and diff view sees nothing.
//
// SECURITY REVIEW, NON-BLOCKING, NOT CLOSED HERE. Both findings above are
// fixed, but the enumeration below is still an ENUMERATION, never \p{Cf} the
// category itself, and closing two hand-picked gaps does not close the class:
// it still ADMITS eleven further \p{Cf} ranges (U+0600-U+0605, U+06DD,
// U+070F, U+0890-U+0891, U+08E2, U+180E, U+110BD, U+110CD, U+13430-U+1343F,
// U+1BCA0-U+1BCA3, U+1D173-U+1D17A), \p{Cs} LONE SURROGATES (near-zero
// impact here: a lone surrogate arriving over JSON is re-encoded to U+FFFD
// by a UTF-8 write before it ever reaches tracked source, and
// NON_ASCII_HAZARD above already refuses \p{Cs} outright on both gated shell
// channels — a distinct threat model this gate does not share), and,
// outside \p{Cf} entirely, both variation-selector families (U+FE00-U+FE0F
// and U+E0100-U+E01EF, both \p{Mn}) — the OTHER documented invisible-byte
// smuggling channel, and one this comment's own threat model above already
// names in its own words. The remainder was NOT closed by this run: the
// tracked-source scanner's own isHazardCodePoint in
// __tests__/runtime-v2-authored-byte-integrity.test.js is an AUTHORED TEST
// path, and this gate is deliberately kept no wider than that scanner can
// backstop — an implementer may never write an authored test, so widening
// this production copy past what the scanner covers would ship a hazard
// class with no regression fixture watching it. Recorded as a residual (see
// docs/hooks.md's own record of it) rather than silently implied closed by
// this comment's own past framing.
// This set is therefore now WIDER than policy 2's pair; keep it that way
// rather than re-syncing it back down to their narrower set — it is recorded
// as its own policy (policy 5 at service.js's enumeration), not a third copy
// of policy 2 to be kept in lockstep with it. Built from NUMERIC code
// points via String.fromCodePoint (String.fromCharCode cannot represent the
// astral TAGS members correctly — see the 'u' flag note below), never a
// literal byte or a `\u` escape in this file's own text, per the authoring
// hazard binding every file this gate touches.
function writeContentHazardPattern() {
  const codePoint = (value) => String.fromCodePoint(value);
  const range = (from, to) => (to > from ? `${codePoint(from)}-${codePoint(to)}` : codePoint(from));
  const parts = [
    range(0x0000, 0x0008),
    range(0x000e, 0x001f),
    range(0x007f, 0x009f),
    range(0x00ad, 0x00ad),
    range(0x061c, 0x061c),
    // U+200B-U+200F MINUS the U+200C/U+200D (ZWNJ/ZWJ) exemption — the SAME
    // one-sided exemption policy 2 makes, so a legitimately-named joining
    // sequence stays admitted here too.
    range(0x200b, 0x200b),
    range(0x200e, 0x200f),
    // U+2028/U+2029 (security review, BLOCKING) — see the class comment above.
    range(0x2028, 0x2029),
    range(0x202a, 0x202e),
    range(0x2060, 0x206f),
    // U+FEFF (security review, BLOCKING) — see the class comment above.
    range(0xfeff, 0xfeff),
    range(0xfff9, 0xfffb),
    // The astral TAGS block (security review, BLOCKING) — see the class
    // comment above. U+E0001 LANGUAGE TAG stands alone; U+E0020-U+E007F are
    // the TAG characters proper.
    range(0xe0001, 0xe0001),
    range(0xe0020, 0xe007f),
  ];
  return `[${parts.join('')}]`;
}

// 'u' flag, added by this same widening: required syntactically for a class
// member above U+FFFF (the TAGS block) to be treated as one code point rather
// than a lone UTF-16 surrogate half. It changes nothing below U+FFFF — every
// other member here was already a single BMP code unit either way.
const WRITE_CONTENT_HAZARD_CHARS = new RegExp(writeContentHazardPattern(), 'u');

// The first hazard code point in `text`, named as an uppercase 'U+XXXX'
// string (never the raw byte, and never fewer than 4 hex digits), or null.
// Iterates by CODE POINT (`for...of` over a string), not UTF-16 code unit, so
// a surrogate pair is never split — load-bearing for correctness of BOTH the
// scan AND the match now that the astral TAGS block is in the hazard set: a
// `for...of` element for one of those members is the full two-unit code
// point, and WRITE_CONTENT_HAZARD_CHARS's own 'u' flag (see above) is what
// lets `.test()` match it as one code point rather than one surrogate half.
// No `/g` flag on WRITE_CONTENT_HAZARD_CHARS: each `.test()` call here
// is independent and single-character, so there is no lastIndex state to
// drift (the same hazard DEV_NULL_REDIRECT's own comment names).
function firstWriteContentHazard(text) {
  if (typeof text !== 'string') return null;
  // FAST PATH (security review, non-blocking performance finding). Content
  // reaching this scan is bounded only by bin/ape-hook.mjs's INPUT_CAP_BYTES
  // (8 MB — its own comment records a package-lock.json edit carrying the
  // whole hunk inline) against the host's 30s PreToolUse hook timeout
  // (hooks/hooks.json), and the overwhelmingly common call carries no hazard
  // code point at all. One native whole-string `.test()` answers that common
  // case in a single pass; the per-code-point loop below then runs ONLY to
  // NAME the offending code point once the fast path has already proven one
  // exists. Safe to call `.test()` twice in a row: WRITE_CONTENT_HAZARD_CHARS
  // carries no `/g` flag (see above), so it has no `lastIndex` state for
  // this call and the loop's own per-character calls to desynchronize.
  if (!WRITE_CONTENT_HAZARD_CHARS.test(text)) return null;
  for (const ch of text) {
    if (WRITE_CONTENT_HAZARD_CHARS.test(ch)) {
      return `U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`;
    }
  }
  return null;
}

// Evaluates the write-content byte gate for one PreToolUse event's tool_input.
// Pure and synchronous (string scanning only, no I/O) — bin/ape-hook.mjs
// calls it as a precompute beside the existing deletion and evidence
// precomputes, and evaluateLifecyclePolicy (below) only READS the verdict it
// produces, keeping the policy itself synchronous. Returns `{ safe: true }`
// for a tool with no route (every tool but the five above) or content with no
// hazard code point, and `{ safe: false, reason }` — naming the DECODED code
// point, never the literal escape text — otherwise.
export function evaluateWriteContentPolicy(toolName, toolInput) {
  const route = WRITE_CONTENT_ROUTES.find((entry) => entry.tool === toolName);
  if (!route) return { safe: true };
  for (const text of route.extract(toolInput)) {
    const hazard = firstWriteContentHazard(text);
    if (hazard) {
      return {
        safe: false,
        // prose-bound-exempt: toolName is a fixed write-tool name and hazard is a bounded code-point label.
        reason: `${toolName} content decodes to a refused control, DEL/C1, line/paragraph separator, or bidi/format code point (${hazard}); authored and agent-facing source may not carry one`,
      };
    }
  }
  return { safe: true };
}

export function normalizePath(value, projectDir) {
  if (typeof value !== 'string' || value.length === 0) return null;
  const absolute = path.resolve(projectDir, value);
  const relative = path.relative(projectDir, absolute).replaceAll('\\', '/');
  if (relative.startsWith('../') || relative === '..') return null;
  return relative;
}

function declaredCommandProfiles(projectDir) {
  if (typeof projectDir !== 'string' || projectDir.length === 0) return [];
  try {
    const stored = JSON.parse(readFileSync(runtimePaths(projectDir).config, 'utf8'));
    const profiles = stored?.policy?.command_profiles;
    if (!Array.isArray(profiles)) return [];
    return profiles.filter((profile) =>
      profile &&
      typeof profile === 'object' &&
      !Array.isArray(profile) &&
      typeof profile.id === 'string' &&
      typeof profile.command === 'string' &&
      profile.command.length > 0 &&
      profile.command.length <= 8192 &&
      !/[\r\n\0]/.test(profile.command) &&
      Array.isArray(profile.roles) &&
      profile.roles.every((role) => typeof role === 'string' && role.length > 0) &&
      ['read', 'write', 'execute'].includes(profile.effect));
  } catch {
    return [];
  }
}

export function matchingCommandProfile(projectDir, command) {
  return declaredCommandProfiles(projectDir).find((profile) => profile.command === command) ?? null;
}

// Codex's native apply_patch tool is freeform: the lifecycle payload carries
// the patch document itself, not a synthetic file_path field. Keep the parser
// deliberately narrower than a general diff parser and aligned with the
// apply_patch envelope. Each operation header contributes its source/target;
// a move contributes its destination as an additional governed write. Lines
// in hunk content begin with a diff marker, so they cannot forge one of these
// column-zero headers.
function applyPatchDocuments(toolInput) {
  if (typeof toolInput === 'string') return [toolInput];
  if (!toolInput || typeof toolInput !== 'object') return [];
  const documents = [];
  for (const candidate of [toolInput.input, toolInput.patch]) {
    if (typeof candidate === 'string') documents.push(candidate);
  }
  if (typeof toolInput.command === 'string') {
    documents.push(toolInput.command);
  } else if (Array.isArray(toolInput.command)) {
    for (const candidate of toolInput.command) {
      if (typeof candidate === 'string') documents.push(candidate);
    }
  }
  return documents;
}

export function extractApplyPatchPaths(toolInput) {
  const paths = [];
  const seen = new Set();
  const operationHeader = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/;
  const moveHeader = /^\*\*\* Move to: (.+)$/;
  for (const document of applyPatchDocuments(toolInput)) {
    let insidePatch = false;
    for (const rawLine of document.split('\n')) {
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
      if (line === '*** Begin Patch') {
        insidePatch = true;
        continue;
      }
      if (line === '*** End Patch') {
        insidePatch = false;
        continue;
      }
      if (!insidePatch) continue;
      const match = operationHeader.exec(line) ?? moveHeader.exec(line);
      const candidate = match?.[1]?.trim();
      if (!candidate || seen.has(candidate)) continue;
      seen.add(candidate);
      paths.push(candidate);
    }
  }
  return paths;
}

async function nearestExistingPath(absolute) {
  let candidate = absolute;
  const suffix = [];
  for (;;) {
    try {
      await lstat(candidate);
      const resolved = await realpath(candidate);
      return path.join(resolved, ...suffix.reverse());
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const parent = path.dirname(candidate);
      if (parent === candidate) return null;
      suffix.push(path.basename(candidate));
      candidate = parent;
    }
  }
}

export async function pathResolvesWithinClaims(projectDir, file, claims) {
  if (!file || !Array.isArray(claims) || claims.length === 0) return false;
  const root = await realpath(projectDir);
  const target = await nearestExistingPath(path.resolve(projectDir, file));
  if (!target) return false;
  const relativeToRoot = path.relative(root, target);
  if (relativeToRoot === '..' || relativeToRoot.startsWith(`..${path.sep}`)) return false;
  for (const claim of claims) {
    const claimTarget = await nearestExistingPath(path.resolve(projectDir, claim));
    if (!claimTarget) continue;
    const relative = path.relative(claimTarget, target);
    if (relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) {
      return true;
    }
  }
  return false;
}

// The out-of-project verdict AND the realpath-resolved target from ONE walk.
// bin/ape-hook.mjs precomputes both onto the event: the boolean drives the
// long-standing out-of-project exemption, and the RESOLVED path gives the
// execution-redirecting-configuration refusal its SECOND lookup. That refusal
// consults the RAW target and this resolved one, and NEITHER SUBSUMES the other,
// because the two catch OPPOSITE symlink layouts. THIS half sees a tail only
// resolution reveals: an ordinary-named path that resolves ONTO a covered
// directory (`link/config.toml` landing on `.cargo/config.toml`). The RAW half
// sees the layout a dotfile manager produces — under stow or chezmoi
// `$HOME/.cargo` is a symlink INTO a managed store, so resolution ERASES the
// match and the resolved tail is `cargo/config.toml`, which is in no table.
//
// `resolved` is null exactly when nothing on the path exists, which is also the
// input for which `outside` is false and the write keeps failing closed.
export async function resolveOutOfProjectTarget(projectDir, absoluteTarget) {
  if (typeof absoluteTarget !== 'string' || absoluteTarget.length === 0) {
    return { outside: false, resolved: null };
  }
  const root = await realpath(projectDir);
  const resolved = await nearestExistingPath(path.resolve(projectDir, absoluteTarget));
  if (!resolved) return { outside: false, resolved: null }; // unresolvable: fail closed, keep the governed deny
  const relative = path.relative(root, resolved);
  return {
    outside: relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative),
    resolved,
  };
}

// The boolean half, unchanged in signature and semantics — including the
// polarity trap documented at its bin/ape-hook.mjs call sites: FALSE for a path
// it cannot resolve, and it swallows only ENOENT.
export async function pathResolvesOutsideProject(projectDir, absoluteTarget) {
  return (await resolveOutOfProjectTarget(projectDir, absoluteTarget)).outside;
}

// Scope of the tree-drift lockdown (bin/ape-hook.mjs). An unattributed tree
// change is dangerous only where it could be extended — a write-capable tool,
// or a shell command that fails the read-only heuristic — or laundered into an
// accepted result: SubagentStop and the post events of the Agent tool. A
// read-only tool can do neither, and denying it blocks exactly the diagnosis
// and recovery the drift calls for, so everything else stays governed by the
// ordinary lifecycle policy alone — with one decoupled backstop. SHELL_WRITE
// is a blocklist, so keying the guard solely off it meant a main-session
// shell write it did not enumerate landed silently and was laundered into the
// next drift-guarded event's sole-candidate attribution (audit finding 1.7,
// invariant 2). Main-session Bash POST events therefore always reconcile: an
// unattributed change is DENIED at the very event that produced it (a loud,
// operator-visible refusal) rather than landing silently. The deny does NOT
// revert the bytes, though: a persisted drift that happens to fall within a
// pending writer ticket's claims can still be re-attributed at that ticket's
// Agent post-event, because author-blind receipt admission cannot tell the
// drift from the writer's own work. That residual is a known, tracked gap —
// see docs/research/2026-07-22-main-session-write-laundering.md — not a closed
// one. Pre events stay pattern-bound so the operator's read-only
// diagnosis (`git status` during drift) keeps working, and bound subagents
// stay pattern-bound because their Bash channel is already restricted to the
// non-mutating evidence allowlist.
export function driftGuardApplies(event) {
  if (event.event === 'SubagentStop') return true;
  if (
    (event.event === 'PostToolUse' || event.event === 'PostToolUseFailure') &&
    [
      'Agent',
      'spawn_agent',
      'collaborationspawn_agent',
      'collaboration.spawn_agent',
      'collaboration__spawn_agent',
    ].includes(event.tool_name)
  ) {
    return true;
  }
  if (WRITE_TOOLS.has(event.tool_name)) return true;
  const external = event.external_tool ?? classifyExternalTool(
    event.tool_name,
    event.raw?.tool_input ?? event.raw?.toolInput ?? event.raw?.input ?? {},
  );
  if (
    external &&
    (external.conservative_drift === true || ['write', 'execute', 'unknown'].includes(external.effect))
  ) return true;
  if (event.tool_name !== 'Bash') return false;
  const profile = matchingCommandProfile(event.project_dir, event.command ?? '');
  if (profile && ['write', 'execute'].includes(profile.effect)) return true;
  if (SHELL_WRITE.test(event.command ?? '')) return true;
  return (
    (event.event === 'PostToolUse' || event.event === 'PostToolUseFailure') &&
    !event.is_subagent
  );
}

export function evaluateTreePolicy(event, context, changedFiles) {
  if (!context?.state || context.state.status !== 'running' || changedFiles.length === 0) {
    return { decision: 'allow', reason: 'tree unchanged' };
  }
  const ticket = context.ticket;
  if (event.path_safe === false) {
    return { decision: 'deny', reason: 'APE result denied: changed target resolves outside ticket claims' };
  }
  if (!event.is_subagent || !ticket) {
    return { decision: 'deny', reason: 'APE result denied: tree changed without one active writing ticket' };
  }
  for (const file of changedFiles) {
    // prose-bound-exempt: role is a fixed ticket enum and file is a runtime-derived changed path.
    if (!ticket.writable) return { decision: 'deny', reason: `APE result denied: ${ticket.role} changed ${file}` };
    if (
      ticket.role !== 'test_writer' &&
      !ticket.claimed_paths.some((claim) => withinClaim(file, claim))
    ) {
      // prose-bound-exempt: file is a runtime-derived changed path.
      return { decision: 'deny', reason: `APE result denied: unclaimed change ${file}` };
    }
    if (ticket.role === 'test_writer' && !withinTestScope(file, ticket.test_paths)) {
      // prose-bound-exempt: file is a runtime-derived changed path.
      return { decision: 'deny', reason: `APE result denied: test writer changed production path ${file}` };
    }
    if (ticket.role === 'implementer' && looksLikeTest(file, ticket.test_paths)) {
      // prose-bound-exempt: file is a runtime-derived changed path.
      return { decision: 'deny', reason: `APE result denied: implementer changed authored test ${file}` };
    }
  }
  // prose-bound-exempt: ticket_id is runtime-issued and schema-bounded.
  return { decision: 'allow', reason: `tree changes authorized by ${ticket.ticket_id}` };
}

