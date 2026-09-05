# APE config

Use only when the user explicitly requests APE configuration work. Pass the governed project root
as `project_dir`; apply only changes covered by the user's instruction. Call `ape_config` with:

- `get`: read configuration, optionally at a dot-path key.
- `set`: write the requested dot-path value. Preserve unrelated sparse overrides.
- `doctor`: diagnose runtime, git, hook, bundle, lock, and statusline readiness. Supply run-start
  facts only when validating a prospective run.
- `init`: inspect manifests, or exact prospective `behavioral`/`test_paths` for a blank repository,
  and propose commands without writing. Use `apply: true` only within existing explicit approval;
  user-supplied `values` override proposed slots. An explicit run authorizes filling missing required
  slots from a complete grounded proposal. Compare with `get`; preserve existing values, using
  scoped `set` calls if applying the proposal would overwrite them. Enroll `evidence_scripts` only
  when the user explicitly accepts those exact discovered script IDs.
  APE never creates or edits `AGENTS.md`, `AGENTS.override.md`, `CLAUDE.md`, or
  another repository instruction file; bounded, versioned operational orientation is injected by
  the runtime at session start.
- `wire` / `unwire`: change statusline integration for an explicitly named host.

Do not translate host-neutral test commands into platform-specific shell strings. Do not claim the
Codex native status line is the custom APE renderer. State the exact key, values, or host being
changed without asking again for approved work. Ask only for missing choices or changes outside
that approval; report tool warnings and rejected fields without weakening them.
