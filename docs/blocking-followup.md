# Blocking and failure follow-up

This record distinguishes reproduced fixes from remaining limits. It covers the
September 5 follow-up on the local 2.24.11 candidate. It does not establish that
every old failure had the same cause or that the installed plugin contains these changes.

## Reproduced and corrected

| Problem | Current behavior | Regression evidence |
|---|---|---|
| Safe Git branch filters, patterns, and spaced option values were refused. | Complete branch argv is interpreted before deciding whether it can change refs. Safe listings pass; mutations and mode-reset combinations cannot create a branch. | `runtime-v2-evidence-git-inspection.test.js` compares actual Git metadata before and after reads and proves mutating counterexamples separately. |
| Git filenames resembling output options and combined file-listing switches were refused. | A proven path separator preserves option-looking filenames as data; recognized `ls-files` short groups remain reads. Unknown or potentially consuming prefixes retain the full output-flag check. | The same Git suite checks worktree and Git metadata, including commands that consume `--` as an option value and write before reporting errors. |
| Quoted working directories could not reach ordinary inspection or test commands. | One complete literal directory followed by `&&` is decoded consistently for command recognition, executable resolution, and containment. | `runtime-v2-literal-inspection.test.js` and `runtime-v2-evidence-effective-cwd.test.js` exercise real shells and hook path checks. |
| Help/version calls demanded nonexistent script or preload files. | Informational Node/npm arguments stop prerequisite inspection at the correct boundary; real script arguments retain their prerequisites. | Admission baseline and command-prerequisite suites. |
| Forwarded package-script options changed the package root inspected by admission. | The package-manager argument separator ends package-root parsing. | Admission baseline and command-prerequisite suites. |
| Script help/version arguments were confused with package-manager information requests. | npm's own help/version requests avoid unnecessary writer checks. Arguments forwarded to a generator by npm/pnpm/Yarn/Bun retain writer scope. | Optional-admission capability suite; npm/pnpm checked locally, Yarn/Bun forwarding checked against primary documentation. |
| Recovery offered REGATE after exhaustion or outside the gate stage, or SHIP after a shipping failure. | Suggested actions use the receiving lifecycle's exact eligibility rules. Failed-check evidence remains visible when a retry is unavailable. | `runtime-v2-recovery-action-eligibility.test.js`, unified diagnostics, and legacy status-document coverage. |
| Resuming active gates or shipping suggested expiring an agent dispatch. | Guidance retains `ape_run next` polling for the existing runtime watch. | Recovery action eligibility and session-guidance suites. |
| Public export rejected the approved project name as a personal author identity. | The exact possessive project name is accepted; unrelated author identities and other protected content retain their checks. | Public-surface allow/deny regressions and an actual disposable public export. |
| A refused parent-tool change could later be accepted as a worker's change. | Run-scoped observations retain affected reference entries. Result hooks and fresh/prepared receipt admission refuse unresolved changes, while reads and authorized repairs stay available. Observed exact restoration clears the affected entries. | Tree-attribution, parent-shell hook, and receipt-parent-drift suites cover refusal persistence, partial restoration, unrelated work, and committed receipt replay. |
| Parent reads or duplicate host events could relabel existing worker changes. | Direct inspection posts remain reads. Git calls use matched pre/post snapshots because configured helpers can write. Retained completed-call outcomes make host replay idempotent. | Parent-shell hook regressions cover existing worker edits, unchanged commands, replay, and actual external-diff helper mutations. |
| Retained execution-budget work advertised passive waiting although nothing would advance in the background. | Diagnostics and bounded responses name `ape_run next`; explicit worker-retirement waits retain their own instructions. | Continuation-recovery guidance tests exercise actual retained-action replay and integrity refusal. |

See [release status](prevention-release-status.md) for the latest completed full
suite and package checks.

## Remaining limits and verification work

- The command grammar still excludes general shell programs and expansions.
  Some harmless spellings need a literal or exact supported form. Examples are
  `git log '^main' master` and `cd './+build' && npm test`. Branch option
  abbreviations and unknown options remain outside the modeled grammar.
- Shell startup settings, aliases, functions, and directory-search settings can
  change execution. Existing executable and path checks do not model every
  environment-dependent behavior. See [shell assumptions](hooks.md#shell-assumption).
- Attribution evidence begins when the hook observes an event. It cannot
  reconstruct past or unobserved changes or prove authorship under arbitrary
  concurrent external writes. Missing matched host events use the conservative
  run baseline; retained observations are not a general filesystem sandbox.
  Refusals never restore files automatically. An observation that exceeds the
  bounded path store retains a whole-tree restoration requirement instead of
  forgetting the refusal. Total storage failure cannot make evidence durable.
- Historical incident records have uneven evidence. The aggregate audit is not
  a proof that every failed run was a product defect, every refusal was justified,
  or every historical defect is fixed. See [historical evidence](prevention-release-status.md#historical-evidence-disposition).
- Full native Codex and Claude verification remains incomplete. This follow-up
  uses source tests and disposable fixtures; the installed plugin is unchanged.
