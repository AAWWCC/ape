# Lifecycle hooks

`bin/ape-hook.mjs` normalizes Claude and Codex events and applies the same runtime policy on both
hosts. The host is pinned by the launcher; stale variables from the other host are ignored. A
project hint seeds an upward walk to the nearest `.ape/`, so governance survives cwd drift.

## Codex native bootstrap

For new Codex dispatches, `SubagentStart` stores bounded provisional evidence: the native parent
session, child turn, child agent ID/type, and actual model. It does not bind a ticket. A valid
native observation also delivers a capability-free reminder to execute the parent-assigned
bootstrap, if that task contains bootstrap arguments, without requesting a new human task. The
reminder does not associate that child with a pending ticket or supply a bearer; unrelated assigned
tasks remain unrelated. Known native children do not receive parent-only SessionStart orientation,
even when later startup input omits the explicit child flag.
The child's first APE operation is `ape_bind` with the separate bootstrap bearer delivered in
`spawn_args.message`.
Bootstrap discovery and binding are not stage work and require no pre-existing ticket context.
That context is expected to be absent initially; the child checks for complete injected authority
only after `ape_bind` returns, never as a reason to skip the handshake.
If it is a deferred tool, search the host catalog for its bare registered name `ape_bind`, then
invoke the returned installed APE tool. Do not search by the host-qualified invocation alias:
the live catalog returned no results for that alias but found the registered name. The bearer is
never a search term. Only the required catalog/invocation wrapper is allowed, never
shell execution, project inspection, or another MCP operation as a substitute for binding.
Its trusted `PreToolUse` hook validates the exact authorized generation, parent linkage, actual
model, live immutable ticket and deadline, and atomically admits one child. Only this hook emits
the ticket context through `hookSpecificOutput.additionalContext`; it does not bypass host
permissions. A tool result without that complete trusted context grants no stage authority.
The two context-bearing binding handlers set Codex's `additionalContextLimit` to `0`: APE already
caps its injected contract at 160 KiB, and a host-spilled preview is not a complete contract. This
also avoids placing the receipt bearer in Codex's hook-output spill files.

The host can omit `agent_id` on later tool events. Identity is then recovered only from the
native observation keyed by that exact child turn and native session (or child-ID alias). Parent
and child turn IDs need not match. Conflicting, malformed, or unsafe evidence fails closed.
Bootstrap bearers, launch-name capabilities, and receipt capabilities use distinct derivations.

This is a bearer-delivery boundary: the trusted orchestrator must relay the returned native
message unchanged. The current native spawn result exposes a task name, not a verified link to
the child's UUID, so APE does not claim independent cryptographic proof of the physical spawn-to-UUID
relationship. Before the bearer is claimed, a provisional observation alone cannot label an
otherwise unrelated child as an APE probe. After binding, the exact canary identity remains
tool-denied, including external tools and later resumes. The wildcard hook permits only the exact
already-admitted bootstrap invocation to account for concurrent hook execution.
Canary-only denial evidence has separate immutable keys for its native child UUID and exact
parent-session/child-turn pair. These survive damaged candidate storage; a parent session alone
and an unrelated provisional child do not match. The keys grant no binding or stage authority.
Main-session startup reads failed or unreadable probe evidence without repairing it and directs
diagnosis rather than automatic relaunch, replacement, or run start.

During an active run, a project write requires one bound native subagent, one active ticket, a
writable role, and a path inside that ticket's claims. Test writers may edit authored tests only;
implementers may edit production claims only. Unknown or ambiguous paths fail closed. Outside-
project scratch writes remain available except for the execution-redirecting configuration listed
below.

## Write-content byte gate

The path checks answer where a write goes; this gate checks what the host edit tool writes. It runs
after path/role authorization and refuses C0 controls, DEL/C1, bidi/format characters, U+2028/U+2029,
U+FEFF, and the astral TAGS block. ZWNJ/ZWJ remain allowed. This is an enumerated tracked-source
policy, not all of Unicode `Cf`; see the authored-byte tests for the precise set.

**Routed tools.** `Write.content`, `Edit.new_string`, each `MultiEdit.edits[].new_string`,
`NotebookEdit.new_source`, and content-bearing `apply_patch` fields. The `apply_patch` route is live:
the hook checks every bound event, accepts compatibility path fields including top-level
`input.file_path`, and derives Codex native targets from column-zero Add/Update/Delete/Move headers.
Every source and destination in a multi-file patch is authorized atomically.

**Residual: Bash heredoc content is not covered.** Bash arrives as a command string, not as a host
edit-tool content field. The shell policy below governs the command, but this byte scan cannot
inspect a separate heredoc payload.

The gate is intentionally content-blind: a source edit whose purpose is to contain one of the
refused bytes must construct it (for example with `String.fromCodePoint`) rather than transmit the
literal byte through a host edit tool.

## Out-of-project execution configuration

A bound agent may use an external scratchpad, but it may not write a known user-level configuration
file that can redirect an already-admitted evidence command. Matching uses lowercased path segments,
not string suffixes. It checks both the raw target and its realpath-resolved target; neither lookup
subsumes the other. Raw matching catches a dotfile-manager layout such as `.cargo` symlinked into a
stow/chezmoi store, while resolved matching catches an ordinary path that links onto a covered
directory. Simple/full Unicode case folding also narrows case-insensitive filename aliases.

Covered tails (an enumeration, not a construction):
`.npmrc`, `npmrc`, `.yarnrc`, `.yarnrc.yml`, `.bunfig.toml`, `.gitconfig`, `.bashrc`,
`.bash_profile`, `.bash_login`, `.profile`, `.zshrc`, `.zshenv`, `.zprofile`, `.zlogin`,
`.envrc`, `sitecustomize.py`, `usercustomize.py`, `.mypy.ini`, `.pylintrc`, `.prettierrc`,
`.prettierrc.json`, `.prettierrc.json5`, `.prettierrc.yml`, `.prettierrc.yaml`,
`.prettierrc.toml`, `.prettierrc.js`, `.prettierrc.mjs`, `.prettierrc.cjs`, `.prettierrc.ts`,
`.prettierrc.mts`, `.prettierrc.cts`, `prettier.config.js`, `prettier.config.mjs`,
`prettier.config.cjs`, `prettier.config.ts`, `prettier.config.mts`, `prettier.config.cts`,
`eslint.config.js`, `eslint.config.mjs`, `eslint.config.cjs`, `eslint.config.ts`,
`eslint.config.mts`, `eslint.config.cts`, `.mocharc.cjs`, `.mocharc.js`, `.mocharc.mjs`,
`.mocharc.yaml`, `.mocharc.yml`, `.mocharc.jsonc`, `.mocharc.json`, `.claude.json`; and the
two-segment `npm/npmrc`, `git/config`, `mypy/config`, `.cargo/config.toml`, `.cargo/config`,
`go/env`, `.config/pylintrc`, `.claude/settings.json`, `.claude/settings.local.json`,
`.codex/config.toml`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`,
`.codex-plugin/plugin.json`. Why the less obvious ones are in:

- `pylint`, `prettier`, `eslint`, and `mocha` are admitted evidence heads whose config can load
  code or redirect execution; the lists cover their current reviewed user-level filenames.
- BOTH hosts' plugin manifests are covered because a manifest can name hook commands or inline
  `mcpServers`. A Codex string companion is validated and pinned to `.mcp.json`, but an inline
  object form still names its `command` arbitrarily; covering the manifest does not cover every
  file or binary it names. `.claude-plugin` and `.codex-plugin` therefore need their own rows.
- Shell startup files redefine the environment in which an admitted head runs; the shell entries
  are listed in each shell's own load order rather than inferred from one suffix.

Every tail above carries an arm in the policy tests. The list is a reviewed narrowing, not a claim
that every possible execution-config file has been discovered.

Residuals this narrowing does NOT close.

- Environment channels such as `BASH_ENV`, `ENV`, `NODE_OPTIONS`, and relocated config roots such
  as `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, or `ZDOTDIR`.
- New links created after resolution and the ordinary resolve/write TOCTOU window. Current bound
  shell policy does not admit link creation.
- The main session, which is not a bound stage and retains external scratch access.
- Pytest's ancestor configs and `conftest.py`, Python environment-manager configs, legacy ESLint
  config, package.json-hosted Prettier/Mocha config, flag-relocated config, and other unaudited
  runner files. Broadly refusing ordinary names such as `package.json` or `pyproject.toml` would be
  a larger over-block than this target-shaped rule accepts.
- `.mcp.json`, and this repository ships one. The official Claude Code MCP documentation
  (https://code.claude.com/docs/en/mcp) documents a project-scoped `.mcp.json` at the project root
  for the current project, and separately documents `CLAUDE_PROJECT_DIR` for plugin-provided MCP
  configuration. Those are documented facts. The checked-in `.mcp.json` argv is also executed by
  an in-repository test with divergent Claude and Codex root hints; that proves this declaration's
  command and environment precedence, but does not establish Claude Code's discovery algorithm.
  Whether project configuration is found by an ancestor walk is not documented and remains
  unverified. The current disposition is therefore based on project scope: covering the tail could
  govern another project. That reachability ground is DERIVED, NOT VERIFIED and must be revisited
  if a host adds ancestor discovery.
- The FILES a plugin manifest names. The three plugin-manifest entries cover the declaring
  manifests, but not arbitrary hook files or inline `mcpServers` command paths. Generated Codex
  packages use a validator-pinned string companion at `.mcp.json`; the host schema also permits an
  inline object form, so the general policy must treat that form as an open residual. The
  `prettier` and `mocha` keys of a `package.json` are similarly left open to avoid blocking an
  ordinary scratch filename.

## Bound-subagent shell policy

A bound Claude or Codex subagent gets an allowlisted evidence shell, not an open shell. Production
edits go through host write tools.

Recognized command families:

- package-manager `test`/`t`; `run <script>` is unrestricted for writable roles and restricted to
  declared/configured evidence scripts for read-only roles;
- Vitest, Jest, Mocha, Ava, Playwright, Tap, TypeScript, and Pytest test/check forms;
- `node --test|--check|--version`, Python test modules, supported Python environment-manager test
  wrappers, `tox`, `go test`, and `cargo test`;
- read-only git (`status`, `diff`, `log`, `show`, `rev-parse`, listing-only `branch`, `describe`,
  `ls-files`, `ls-tree`), with output-writing flags denied;
- `ls`, `pwd`, `cat`, `echo`, `true`, `which`, exact-head `sha256sum`/`shasum` checksum evidence,
  and bare `env`;
- check-only Ruff, Flake8, Mypy, Pylint, Black, Isort, ESLint, and Prettier forms; and
- at most one leading `cd <dir> &&`.

Fresh runs also pin each external command head to its trusted-start realpath and bounded fingerprint.
Missing-to-present, PATH-shadowed, or replaced executables are refused. `echo`, `pwd`, and `true`
are explicit shell builtins; Windows resolution honors PATHEXT and case-insensitive names.

### Exact command profiles

`policy.command_profiles` admits one exact operator-attested command for named roles and a declared
`read`, `write`, or `execute` effect. There is no prefix/glob matching. Write profiles require a
writable ticket, and write/execute effects trigger tree reconciliation.

For one investigation, `ape_run preview`/`start` may instead carry `run_command_profiles`. This
surface is restricted to `debugger` or `spike_researcher`, the profile must name only the mode's
role, and its effect must be `execute`. Each entry also requires a nonblank audit `reason` and
`operator_authorized: true`, which may be set only after the operator approves that exact literal
command. The exact command becomes a required capability in that run's immutable snapshot; it never
changes repository-wide configuration and cannot be added after start. This is the supported path
for measurements such as an exact interpreter invocation that is intentionally outside the generic
non-mutating command grammar. Because execute profiles can run arbitrary code, their normal
post-command tree reconciliation is defense in depth, not a substitute for that explicit approval.

### Token and character rules

Admission is tokenize-then-allowlist. The command is parsed into tokens, checked against one
recognized family, and then checked for containment and executable identity. Chaining,
substitution, redirects, inline interpreters, control characters, and ambiguous tokenization fail
closed.

Command-family recognition precedes executable-pinning diagnostics. An unrecognized mutation such
as `cp` is therefore refused as outside the non-mutating evidence allowlist, rather than being
misreported as a missing trusted-start executable. Recognized evidence heads still fail closed when
their pinned executable is missing, replaced, or PATH-shadowed. Only an obvious file-inspection or
read-only Git intent receives the correctable `command-shape` diagnostic; arbitrary or potentially
mutating heads retain the shell denial and host-edit-tool remedy.

The character allowlist admits ASCII letters/digits, non-ASCII code points by range, plain spaces
as separators, and the punctuation `- _ . / : = @ ~ , % ^ +`. Positional rules refuse `~`, `=`,
or `^` at token start; `~` and `=` are also refused immediately after `=` or `:`. This closes zsh
equals expansion such as `=node` under the named assumptions and narrows `MAGIC_EQUAL_SUBST`
exposure. A `cd` target additionally refuses `~` and `^` anywhere and a leading `-` or `+`; a name
can still be reached as `./-build` or `./+build`.

Static `cat` and `ls` operands may use one complete pair of single or double quotes. The de-quoted
content must use the ordinary token alphabet and may not contain spaces; partial quote concatenation,
quoted package-script names, and embedded quotes remain refused. This admits harmless shell spellings
such as `cat 'eslint.config.mjs'` without expanding the executable or script surface.

A complete argv vector serialized as uniformly single- or double-quoted, escape-free tokens is
canonicalized before policy checks only when every de-quoted token uses the ordinary positive
alphabet, so `'cat' 'tests/unit/graph.test.ts'` has the same verdict as its plain argv. Mixed or
partial quoting, quoted whitespace, shell operators, opposite nested quotes, escapes, and
unrecognized de-quoted heads remain refused. Single-quoted bracketed route operands retain their
quote provenance for the route validation below.

Next.js dynamic-route paths are a separate bracket-aware quote exception. A complete single-quoted
operand whose bracket-bearing segments are `[name]`, `[...name]`, or `[[...name]]` is de-quoted before
the same containment checks; for example, `cat 'app/trace/[traceId]/page.tsx'`. Unquoted brackets
remain refused because zsh treats them as glob syntax. Double-quoted dynamic routes, partial bracket
segments, embedded quotes, and spaces inside the quoted token remain refused.

Deletion is stricter: every target refuses `~`, `=`, and `^` in every position. The retired
`DELETION_UNSAFE_CHARS` argument was monotone only for truncation; it did not cover substitution,
and `rm =node` could resolve to an absolute executable path. The separate deletion tokenizer now
closes that instance.

Accepted over-blocks:

- `git log ^main master` is refused because `^` begins a token.
- A bare `cd +build` or `cd -build` is refused; `cd ./+build` and `cd ./-build` work.
- Shell syntax that a specific command might safely treat as data is still refused globally.

### Shell assumption

The character argument is scoped to the host shell and shell options it names. Claude commonly
executes through a persistent zsh/eval path; zsh `EXTENDED_GLOB`, `MAGIC_EQUAL_SUBST`, aliases,
functions, `ZDOTDIR`, startup injection, and other operator configuration can change parsing before
the target program runs. The policy narrows those risks but does not claim a character rule closes
them all. Executable pinning closes fresh-run PATH shadowing, while environment/startup channels
remain explicit residuals.

### Operand containment

Every path-shaped operand must resolve within the governed project. This includes `--flag=path`,
short attached operands, and relocation flags. The refusal names the operand, not merely the flag.
The optional leading `cd` is resolved first; the remaining command is checked relative to that
directory. The session cwd itself must already be inside the governed project.

## External MCP pass-through

APE does not match, classify, authorize, deny, or audit tools owned by other MCP servers. Server
names, operation names, schemas, discovery, and permissions remain host- and operator-owned. This
keeps an installed APE plugin from interfering with unrelated integrations or requiring future tool
names to be predicted before a run starts.

The shared policy hooks match only APE's own control-plane operations and receipt validator, plus
the host write, shell, and agent-dispatch surfaces APE actually governs. A defensive runtime branch
also immediately defers any non-APE `mcp__<server>__<operation>` event without returning a permission
decision if a host delivers it despite the narrowed matcher, before APE reads run state or resolves
a ticket binding.

Claude's supplemental asynchronous LARP hook still sees failed tool events for user-facing error
cues. It has no permission or receipt authority; the synchronous policy bundle does not receive
generic MCP events.

Claude agent manifests retain `ToolSearch` and `mcp__*` so parent-session providers remain visible
to bound workers. Their `disallowedTools` entries cover only APE's own orchestrator-controlled
operations; `ape_validate_receipt` remains the one worker protocol tool. Repository integrity is
still checked at agent/receipt boundaries against `claimed_paths` and `test_paths`, independently of
which external service a worker used.

## Main-session shell policy

The main session uses a blocklist as defense in depth, not as a sandbox. It blocks obvious file
writes/deletes, redirects (including no-space forms), inline interpreters, patch/install/truncate
commands, and known mutating git forms while a run is active. PostToolUse tree reconciliation is
the authoritative backstop. The main session remains responsible for MCP control-plane calls and
normal host orchestration.

## Receipt capabilities

Each dispatch uses a single-use launch nonce and a separate receipt capability. PreToolUse binds a
host-issued child identity to exactly one ticket; the child receives only its receipt capability.
Receipt admission verifies that binding and consumes the capability. `SubagentStop` is an observed
lifecycle event, not proof that a valid receipt was recorded.

The conventional `hooks/hooks.json` registers shared policy events for both hosts. Its shell-free
Node launcher selects Codex `PLUGIN_ROOT` or Claude `CLAUDE_PLUGIN_ROOT` and pins the host. Claude's
explicit `hooks/claude-hooks.json` contains only supplemental LARP handlers and its
`PostToolUseFailure` event.

## LARP MODE

LARP MODE is advisory and fail-open. It is disabled by default.

| Cue | Trigger |
| --- | --- |
| BOOT | Session start |
| ASK | Claude `AskUserQuestion` or Codex `request_user_input` |
| STOP | Main-session stop |
| SUBAGENT | Subagent stop (off by default) |
| ERROR | Positively reported APE failure; also generic Claude tool failure |
| PLAN | Passed planning outcome |
| BUILD | Passed implementer/green-phase outcome |
| SHIP | Completed run |

Codex command hooks detach playback and return neutral JSON. Claude keeps asynchronous supplemental
handlers. Codex has no `PostToolUseFailure`, so generic non-APE failures are silent there. Configure
`notifications.larp`, or override with `LARP_MODE`, `LARP_<EVENT>`, and `LARP_FILE_<EVENT>`. Public
packages include no recordings. An optional private overlay can provide the closed package-local
`assets/sounds/manifest.json`; invalid, escaping, or missing entries are silent.
