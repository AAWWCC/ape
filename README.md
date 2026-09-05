# APE

APE runs coding tasks through planning, tests, implementation, review, and shipping.
It saves progress outside the chat, so a task can continue in another session.

APE coordinates the host's native agents. Its runtime decides the next stage and
checks the evidence before accepting a worker's result. This helps catch unsupported
claims; it does not guarantee that a test, review, or code change is correct.

## Current status

Version **2.24.11** is a local release candidate, not a published or fully
live-certified release. Offline checks and one live mechanical run passed.
The other live scenarios remain unverified. See the
[current release status](docs/prevention-release-status.md) for the exact limits.

Codex CLI is the primary host. The Claude Code package is included, but
Claude live operation is unverified. Codex IDE integrations and ChatGPT web,
mobile, and cloud runtimes are not supported.

Installing APE does not start a run. You choose when it can work and ship.

## Install

Node.js 22.12.0 or newer is required.

### Codex CLI

Run in a terminal:

```bash
codex plugin marketplace add AAWWCC/ape
codex plugin add ape@ape
```

### Claude Code

Run inside Claude Code:

```text
/plugin marketplace add AAWWCC/ape
/plugin install ape@ape
/reload-plugins
```

Both packages run locally through Node.js. APE stores project state under
`.ape/runtime/`; it does not send that state to an APE-operated service.
The coding host and configured tools still use their own services and permissions.

### Compatibility

[`compatibility.json`](compatibility.json) defines the supported host versions
and platforms. See [host compatibility](docs/compatibility.md) before changing a
CLI version. CI checks packages on Linux, macOS, and Windows.

## Use

Start by setting up the project's test commands. Configuration changes are
proposed for your approval:

```text
/ape:config init
/ape:config doctor
```

Then start a task, check its progress, or continue it later:

```text
/ape:run Add optimistic locking to invoice updates
/ape:status
/ape:resume
```

Use APE for work that needs tests, review, or continuity across sessions.
For a tiny edit or a quick question, an ordinary coding session may be simpler.

| Skill | What it does |
| --- | --- |
| `run` | Start a build, investigation, or shipping run. |
| `status` | Show progress, pending work, and blocks. |
| `resume` | Continue an interrupted run. |
| `history` | Inspect past runs and their results. |
| `config` | Set up commands, models, and shipping. |
| `override` | Request an audited abort, reset, or dispatch expiration. |
| `roadmap` | Manage an optional project roadmap. |

Only read-only `status` may be selected automatically. Invoke the other skills
explicitly. See the [skill reference](docs/skills.md) for details.

## Pipelines

| Mode | Work |
| --- | --- |
| `phase` | Plan, test, implement, review, and ship a change. |
| `debug` | Investigate a problem without editing files. |
| `spike` | Research a question without editing files. |
| `land` | Review and ship existing work without editing it. |

A `phase` run uses one of three lanes:

- **Mechanical:** documentation, generated files, and other non-behavioral changes.
- **Fast:** small behavioral changes without high-risk triggers.
- **Full:** larger or sensitive changes, such as authentication, migrations, or public APIs.

Choose `auto` to let APE classify the lane. A run can move to a stricter lane,
but not a lighter one.

Behavioral changes normally start with failing tests, written by a separate
test worker. Use `green-maintenance` for tests that should already pass, such as
a regression net or deflake. Non-behavioral work does not need fabricated failing
tests. See [pipeline rules](docs/pipeline.md) for scope limits and stage order.

## Gates and shipping

Before dispatching workers, APE checks the proposed scope, repository state,
commands, required capabilities, and later pipeline stages. Missing paths need
approval; they are not silently added.

Workers must return validated results called **receipts**. APE also checks file
scope, tree identity, tests, reviews, and the configured gates before shipping.

GitHub is the only shipping provider. Each project needs its own explicit
repository target. By default, green work waits for an audited `ship` action.
With `shipping.auto_merge: true`, a run also needs explicit per-run shipping
approval before APE may push, open a PR, and merge.

APE waits for required checks and proof of the remote merge. A failed local
cleanup does not undo a proven remote success. A blocked run does not authorize
automatic reset, abort, or restoration.

See [configuration](docs/configuration.md) and [pipeline rules](docs/pipeline.md)
for the exact checks and recovery options.

## Development

```bash
npm ci
npm run public:hooks
npm run typecheck
npm run test:agent
npm run bundle
npm run package:plugins
npm run package:check
npm run public:check
```

`npm test` uses six workers. `npm run test:agent -- <paths...>` uses three and is
the preferred profile when other agents may also be testing.

Keep runtime changes, tests, and generated packages easy to review separately.
The Git hooks check commit identities; verify the remote before pushing.
A rebuild does not update an installed plugin. Reinstallation, pushes, and
publication are separate actions.

For the full checklists, see [Contributing](CONTRIBUTING.md),
[release checks](docs/operational-readiness.md),
[prompt evaluations](evals/README.md), and
[performance baselines](docs/performance-baselines.md).

## Help and license

- [Documentation index](docs/README.md)
- [Report a bug](docs/incident-reporting.md)
- [GitHub Issues](https://github.com/AAWWCC/ape/issues) and [Discussions](https://github.com/AAWWCC/ape/discussions)
- [Security policy](SECURITY.md) for private vulnerability reports

APE is licensed under [MIT](LICENSE). See [third-party notices](THIRD_PARTY_NOTICES.md)
for material with separate terms.
