---
name: config
description: "Read, update, diagnose, or wire the APE host-neutral runtime configuration."
argument-hint: "[get|set|doctor|wire|unwire|init] [key] [value]"
disable-model-invocation: true
---

# APE config

Use only when the user explicitly requests APE configuration work. Call `ape_config` with one of:

On Google Antigravity / Gemini, pass the exact open project root as `project_dir`.

- `get`: read configuration, optionally at a dot-path key.
- `set`: write the requested dot-path value. Preserve unrelated sparse overrides.
- `doctor`: diagnose runtime, git, hook, bundle, lock, and statusline readiness. Supply run-start
  facts only when validating a prospective run.
- `init`: inspect project manifests and propose test commands/evidence scripts without writing. It
  may also propose a small managed APE orientation block for the effective project instruction
  file; `AGENTS.override.md` takes precedence over `AGENTS.md`. Applying config requires explicit
  approval and `apply: true`; user-supplied `values` override proposed slots. Applying the
  orientation is a separate explicit action using `apply_agents: true`, the exact proposed
  `agents_path`, and its matching `agents_expected_hash`. Never apply a stale proposal or write the
  non-effective instruction file.
- `wire` / `unwire`: change statusline integration for an explicitly named host.

Do not translate host-neutral test commands into platform-specific shell strings. Do not claim the
Codex native status line is the custom APE renderer. Before any mutating action, restate the exact
key, values, or host in scope; report tool warnings and rejected fields without weakening them.
