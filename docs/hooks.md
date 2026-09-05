# Lifecycle hooks

Hooks enforce APE's rules at host events. `bin/ape-hook.mjs` translates Claude
and Codex events into the same runtime policy. The launcher selects the host;
stale variables from another host are ignored.

APE finds the governed project by walking up from a project hint to the nearest
`.ape/` directory. A changed working directory does not remove that protection.

## Codex native bootstrap

New Codex workers receive authority in this order:

1. `SubagentStart` records provisional native identity and actual model. It does
   not bind a ticket. A reminder tells an assigned APE child to run its bootstrap,
   without supplying a credential or assigning unrelated children to APE.
2. The child discovers the bare registered name `ape_bind`, if needed, then calls
   the installed tool with the bootstrap arguments from `spawn_args.message`.
   Do not search for a host-qualified alias or put the credential in the query.
3. The trusted `PreToolUse` hook checks generation, parent, model, ticket, and
   deadline, then binds exactly one child. It injects the task context through
   `hookSpecificOutput.additionalContext`.
4. Only after that injection may the worker begin. Missing ticket context before
   binding is expected; a tool result without trusted context is not authority.

Discovery allows only the required tool-catalog wrapper, not shell commands,
project inspection, or substitute MCP calls. The parent must forward the returned
native message unchanged. Hooks do not bypass host permissions.

APE caps injected context at 160 KiB. Its two binding handlers set Codex's
`additionalContextLimit` to `0` so the host does not replace the contract with a
preview or spill its receipt credential to hook-output files.

### Identity and failed probes

Later events may omit `agent_id`. APE resolves it only from the matching native
session and child turn, or child-ID alias. Parent and child turns may differ.
Conflicting or unsafe evidence stops binding. Bootstrap, launch-name, and receipt
credentials are derived separately.

The native spawn result gives a task name, not an independently verified link to
the child's UUID. The trusted parent's unchanged message delivery remains part
of this trust boundary.

Provisional observations alone do not make unrelated children APE probes.
Once bound, a probe remains denied ordinary tools, including external tools and
later resumes. Immutable denial records identify the exact child UUID and
parent-session/child-turn pair, never the parent alone. They survive damaged
candidate storage and grant no work authority.

The wildcard hook permits the exact admitted bootstrap call for concurrent hook
delivery. Main-session startup reports failed or unreadable probes without
repairing, replacing, or relaunching them. Known children do not receive
parent-only session instructions.

### Project writes

An active-run write requires a bound worker, an active writable ticket, and an
approved path. Test writers own authored tests; implementers own production
claims. Unknown or ambiguous paths are refused. Outside-project scratch writes
are allowed except for the execution configuration listed below.

## Write-content byte gate

After checking the path and role, APE checks content sent through host edit tools.
It refuses C0 controls, DEL/C1, bidi/format characters, U+2028/U+2029, U+FEFF, and
the astral TAGS block. ZWNJ/ZWJ remain allowed. This is a specific list, not every
Unicode `Cf` character.

**Routed tools.** `Write.content`, `Edit.new_string`, each
`MultiEdit.edits[].new_string`, `NotebookEdit.new_source`, and content-bearing
`apply_patch` fields. The `apply_patch` route is live. It accepts compatibility
path fields such as `input.file_path` and reads Codex paths from column-zero
Add/Update/Delete/Move headers. It authorizes every source and destination in a
multi-file patch together.

**Residual: Bash heredoc content is not covered.** The shell policy checks the
command string, but this scan does not inspect a separate heredoc payload.

A source edit that needs a refused character must construct it, for example with
`String.fromCodePoint`, rather than include the literal character.

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

Bound workers get an allowlisted evidence shell, not an unrestricted shell.
Use host edit tools for production changes.

Recognized command families include:

- Package-manager `test` / `t`. Writable roles may use `run <script>`;
  read-only roles are limited to configured or declared evidence scripts.
- Vitest, Jest, Mocha, Ava, Playwright, Tap, TypeScript, and Pytest checks.
- `node --test|--check|--version`, Python test modules and supported environment
  wrappers, `tox`, `go test`, and `cargo test`.
- Read-only Git: `status`, `diff`, `log`, `show`, `rev-parse`, listing-only
  `branch`, `describe`, `ls-files`, and `ls-tree`. Output-writing flags are refused.
- `ls`, `pwd`, `cat`, `echo`, `true`, `which`, bare `env`, and exact-head
  `sha256sum` / `shasum` checks.
- Check-only Ruff, Flake8, Mypy, Pylint, Black, Isort, ESLint, and Prettier.
- At most one leading `cd <dir> &&`.

New runs pin each external executable to its resolved path and fingerprint at
start. A missing, shadowed, newly appeared, or replaced executable is refused.
`echo`, `pwd`, and `true` are explicit builtins; Windows resolution uses PATHEXT
and case-insensitive names.

### Exact command profiles

`policy.command_profiles` can allow one exact operator-approved command for
named roles, with a `read`, `write`, or `execute` effect. Prefixes and globs do
not match. A write profile needs a writable ticket. Write and execute profiles
trigger checks for unexpected tree changes.

For one `debug` or `spike` run, preview/start may instead supply
`run_command_profiles`. Each entry must:

- Name only that mode's `debugger` or `spike_researcher` role.
- Use `effect: "execute"`.
- Include a nonblank audit `reason` and `operator_authorized: true`, set only
  after approval of the exact command.

These profiles are frozen at start and do not alter project-wide config.
Execute profiles can run arbitrary code; later tree checks do not replace approval.

### Token and character rules

APE tokenizes the command, matches a command family, then checks paths and
executable identity. Chaining, substitutions, redirects, inline interpreters,
controls, and ambiguous tokens are refused.

An unknown command such as `cp` is reported as outside the evidence allowlist,
not as a missing executable. Only obvious file-inspection or read-only Git
commands receive a correctable `command-shape` error; potentially mutating
commands must use the permitted edit path.

The character allowlist accepts ASCII letters/digits, non-ASCII code points by
range, plain spaces as separators, and `- _ . / : = @ ~ , % ^ +`.
It refuses `~`, `=`, and `^` at token start, and `~` / `=` immediately after
`=` or `:`. This blocks zsh equals expansion such as `=node` under the stated
shell assumptions and narrows `MAGIC_EQUAL_SUBST` exposure.

A `cd` target also refuses `~` and `^` anywhere, or a leading `-` / `+`.
Use `./-build` or `./+build` to name those directories.

Quoting rules:

- Static `cat` and `ls` operands may use a complete single- or double-quoted
  token, such as `cat 'eslint.config.mjs'`. Its content must use the ordinary
  alphabet without spaces.
- A complete argv may use uniformly single- or double-quoted, escape-free tokens.
  Each unquoted token must pass ordinary policy. For example,
  `'cat' 'tests/unit/graph.test.ts'` has the same verdict as plain argv.
- Next.js paths may use single-quoted segments shaped as `[name]`, `[...name]`,
  or `[[...name]]`: `cat 'app/trace/[traceId]/page.tsx'`.
  Unquoted brackets, double-quoted routes, partial brackets, and spaces are refused.
- Mixed or partial quoting, embedded quotes, quoted package-script names, shell
  operators, and quoted whitespace do not gain an exception.

Deletion refuses `~`, `=`, and `^` anywhere. The retired
`DELETION_UNSAFE_CHARS` check did not cover substitution: `rm =node` could target
an absolute executable path. Its old safety argument was monotone under truncation
(cutting input short), not substitution (replacing input). A separate deletion
tokenizer now refuses that form.

Accepted over-blocks:

- `git log ^main master` is refused because `^` starts a token.
- `cd +build` and `cd -build` are refused; use `cd ./+build` or `cd ./-build`.
- Shell syntax can be refused even when one command would treat it as harmless data.

### Shell assumption

Shell options can change parsing before the target program runs. Claude commonly
uses persistent zsh/eval; `EXTENDED_GLOB`, `MAGIC_EQUAL_SUBST`, aliases, functions,
`ZDOTDIR`, and startup files matter. The character rules narrow these risks;
they do not eliminate every environment or startup channel. Executable pinning
addresses fresh-run PATH shadowing, not those remaining channels.

### Operand containment

Path-shaped operands must resolve inside the governed project, including
`--flag=path`, short attached operands, and relocation flags. Errors name the
operand. A leading `cd` is resolved first; the command is checked from that
directory. The session's working directory must already be inside the project.

## External MCP pass-through

The host and operator control other MCP servers' discovery and permissions.
APE's ordinary policy hooks do not classify or authorize their operations. If a
host sends a non-APE MCP event anyway, the runtime defers it before reading run
state or resolving a ticket. Bound probe denial is the exception described above.

Claude manifests retain `ToolSearch` and `mcp__*` so external providers remain
visible. They deny workers APE's parent-only controls; receipt validation remains
available. APE checks repository changes at worker and receipt boundaries, even
when an external service made them.

Claude's asynchronous LARP error hook can observe generic tool failures for a
notification. It grants no permission or receipt authority.

## Main-session shell policy

During a run, the parent handles APE controls and native dispatch, not stage work.
A blocklist rejects obvious writes/deletes, redirects, inline interpreters,
patch/install/truncate commands, and mutating Git forms. This is not a sandbox:
PostToolUse tree checks remain the backstop.

## Receipt capabilities

A dispatch has separate single-use launch and receipt credentials. Trusted hooks
bind one native child to one ticket. Receipt admission checks that binding and
consumes the receipt credential. `SubagentStop` reports termination, not a
successfully recorded result.

`hooks/hooks.json` registers shared policy for both hosts. The shell-free Node
launcher uses Codex `PLUGIN_ROOT` or Claude `CLAUDE_PLUGIN_ROOT` and pins the
host. Claude's explicit `hooks/claude-hooks.json` adds only LARP notifications,
including `PostToolUseFailure`.

## LARP MODE

LARP MODE provides optional notifications. It is off by default; a notification
failure does not block a run.

| Cue | Trigger |
| --- | --- |
| BOOT | Session start |
| ASK | Claude `AskUserQuestion` or Codex `request_user_input` |
| STOP | Main-session stop |
| SUBAGENT | Subagent stop; off by default |
| ERROR | Reported APE failure, or a generic Claude tool failure |
| PLAN | Passed planning |
| BUILD | Passed implementation or green phase |
| SHIP | Completed run |

Codex detaches playback and returns neutral hook JSON. Claude uses asynchronous
handlers. Codex has no `PostToolUseFailure`, so unrelated tool failures are silent.

Configure `notifications.larp`, or use `LARP_MODE`, `LARP_<EVENT>`, and
`LARP_FILE_<EVENT>`. Public packages contain no recordings. An optional private
overlay may supply `assets/sounds/manifest.json`; invalid, escaping, or missing
entries remain silent.
