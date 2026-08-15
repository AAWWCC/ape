---
name: config
description: "Read, update, diagnose, or wire the APE host-neutral runtime configuration."
---

# APE config

Use only when the user explicitly requests APE configuration work. Call `ape_config` with one of:

On Google Antigravity / Gemini, pass the exact open project root as `project_dir`.

- `get`: read configuration, optionally at a dot-path key.
- `set`: write the requested dot-path value. Preserve unrelated sparse overrides.
- `doctor`: diagnose runtime, git, hook, bundle, lock, and statusline readiness. Supply run-start
  facts only when validating a prospective run.
- `init`: inspect project manifests and propose test commands without writing. Apply only after
  explicit approval, using `apply: true`; user-supplied `values` override proposed slots.
- `wire` / `unwire`: change statusline integration for an explicitly named host.

Do not translate host-neutral test commands into platform-specific shell strings. Do not claim the
Codex native status line is the custom APE renderer. Before any mutating action, restate the exact
key, values, or host in scope; report tool warnings and rejected fields without weakening them.
