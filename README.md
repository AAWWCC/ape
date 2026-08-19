DO NOT USE GEMINI MODELS; THEY ARE COMPLETE TRASH. THEY WILL HALLUCINATE, LIE, AND BE UNABLE TO RUN PLUGINS CORRECTLY

# APE

APE turns AI coding from session-driven improvisation into durable, evidence-gated engineering
runs. It keeps Plan → Build → Ship state outside the chat, resumes across sessions, and accepts
progress only when the working tree, tests, reviews, and configured gates support it.

Under the hood, APE is a deterministic runtime for Claude Code and Codex that coordinates
each host's native agents. The scheduler—not the model—owns stage order,
retries, lane selection, receipts, recovery, and merge decisions. Agents and tooling can still be
wrong; APE reduces the chance that an unsupported claim advances by requiring the evidence it knows
how to verify.

## Current status

- Claude Code and Codex CLI are supported end to end.
- The public surface is seven skills backed by four MCP tools.
- Runs are explicit. Installing APE does not start agents or change a repository.
- GitHub is the only shipping provider.
- Node.js 22 or newer is required.
- Claude and Codex install from this repository's marketplace files. Both launch the bundled MCP server locally
  over stdio. A hosted broker and universal cloud-directory submission are outside the 2.18 release
  scope.
- Codex IDE integrations and ChatGPT web, mobile, and cloud runtimes are not supported in 2.18.

## Install

### Claude Code

Run these commands inside Claude Code:

```text
/plugin marketplace add AAWWCC/ape
/plugin install ape@ape
/reload-plugins
```

### Codex CLI

Run these commands in a terminal:

```bash
codex plugin marketplace add AAWWCC/ape
codex plugin add ape@ape
```

Each host uses an allowlisted package from `plugins/`. The package starts
`dist/ape-mcp.bundle.mjs` with local Node and communicates over stdio; it does not send APE state
to an APE-operated service.

### Compatibility

| Host | Package | MCP transport | Agent integration | External-tool attestation |
| --- | --- | --- | --- | --- |
| Codex CLI | `plugins/ape` | Local stdio | Native Codex subagents and lifecycle hooks | Codex-specific GitHub connector and Codex Security reads are covered; other providers depend on the installed server. |
| Claude Code | `plugins/ape-claude` | Local stdio | Claude Agent tool and supplemental hooks | Core policy is shared, but Codex-only connectors and live provider parity are not claimed. |

Node.js 22 and 24 are exercised on Windows, Linux, and macOS. Provider availability, host plugin
discovery, and external editor connections remain host/version/environment dependent.

For development from this checkout, rebuild the packages before using a host reinstall helper:

```bash
npm ci
npm run bundle
npm run package:plugins
npm run reinstall:codex
```

The Codex wrapper validates a small allowlisted package, promotes it under a new immutable cache
version, and leaves both the source manifest and versions used by open tasks unchanged. Start a new host
task after reinstalling.

## Use

APE is useful when work must survive session boundaries, has meaningful tests or review gates, or
needs an auditable Plan → Build → Ship record. It is usually excessive for a one-line local edit,
throwaway exploration, or work whose cost is lower than setting up claims and evidence. Use
`debug` or `spike` for bounded read-only investigation; do not start a stateful run merely because
the plugin is installed.

Invoke a skill explicitly:

```text
/ape:run Add optimistic locking to invoice updates
/ape:status
/ape:resume
```

Available skills:

| Skill | Purpose |
| --- | --- |
| `run` | Start a `phase`, `debug`, `spike`, or `land` run. |
| `status` | Show the active run and roadmap summary. |
| `resume` | Continue an interrupted run. |
| `history` | Query runs, explain one run, import history, or maintain old artifacts. |
| `config` | Inspect, change, diagnose, or wire APE configuration. |
| `override` | Abort, reset, or expire a dispatch with an audit reason. |
| `roadmap` | Inspect or update the optional project roadmap. |

Every state-changing skill requires explicit operator invocation. `history`, `roadmap`, `run`,
`resume`, `config`, and `override` are also explicit-only at the host-discovery layer; only the
read-only `status` skill may be selected implicitly when relevant.

## Pipelines

| Mode | Pipeline |
| --- | --- |
| `phase` | Plan, test, implement, review, gate, and ship. The selected lane controls how much of that pipeline is needed. |
| `debug` | Run one read-only debugger. |
| `spike` | Run one read-only researcher. |
| `land` | Review, gate, and ship an existing non-empty diff. APE does not edit it. |

The building lanes are:

- `mechanical`: documentation, generated output, non-behavioral configuration, or tracked data.
- `fast`: behavioral work with at most six production files and no high-risk trigger.
- `full`: larger or sensitive work, including security, auth, migrations, dependencies, public APIs,
  schemas, concurrency, and destructive operations.

`auto` lets the runtime classify the run. Scope may escalate during a run, but it never downgrades.

Behavioral `phase` work in the fast and full lanes follows a test-first protocol: a test writer is
assigned failing tests in `test_paths`, then a separate implementer owns production
`claimed_paths`, and read-only reviewers judge the result. APE verifies the artifacts and receipts
available to it; it cannot guarantee that a test is meaningful or a review is correct. This
protocol does not describe mechanical work, read-only `debug`/`spike`, or `land`, which reviews and
ships an existing diff without editing it. High-risk runs add a security review. Each failed stage
can be retried once; a blocking review gets one remediation cycle.

New code and security reviews classify each blocking finding as production-, test-, or both-owned.
APE serializes the matching remediation writers: production goes to the implementer, test goes to
the test writer, and mixed/both goes to the test writer then implementer before the applicable
review group reconvenes. Versioned remediation-test tickets mark their test scope exact; authored
tests remain test-writer-owned, while unversioned legacy tickets retain sibling widening.

## Gates and shipping

APE verifies receipt integrity, path scope, tree identity, targeted tests, plugin validity when
relevant, the configured suite, conditional security evidence, and remote checks. Local suites and
remote checks can rest in `gating` or `shipping`; `next` advances either watch, and `wait_ms` can
keep one call open for a bounded period.

By default, a green run is held at merge until the audited `ship` action re-proves the gates. With
`shipping.auto_merge: true`, APE instead pushes the run branch, opens or reuses a GitHub pull
request, waits for required checks, and squash-merges.

## Configuration

Configuration is a sparse overlay at `.ape/runtime/config.json`. Start with:

```text
/ape:config init
/ape:config doctor
```

`init` detects common test runners and proposes commands; it does not apply them without approval.
Use `wire` to opt into the full APE statusline on Claude or Codex's closest native footer. LARP MODE
notifications are available on both hosts and are off by default. Public packages contain no
sound files; operators may configure their own files, and a private package overlay may provide the
closed package-local sound manifest described in the configuration guide.

See [configuration](docs/configuration.md), [pipelines](docs/pipeline.md), and the
[documentation index](docs/README.md).

## Development

```bash
npm ci
npm run typecheck
npm run test:v2
npm run bundle
npm run package:plugins
npm run package:check
npm run package:reproducible
npm run public:check
npm run eval:prompts:check
npm run validate
```

`npm run release:artifacts` produces the three host tarballs, checksum ledger, release manifest, and
SPDX SBOM under `release/`. `npm run release:reproducible` builds that set twice and compares every
artifact digest. Tagged releases run the same gates, a clean full-source export, and GitHub
provenance attestation before publication. The credential-free prompt-evaluation check validates
the synthetic scenario matrix, prompt hashes, schema, scorer, and release thresholds. It makes no
model calls. Live prompt evaluation has separate explicit paid-call guards, and
`npm run eval:prompts:verify` verifies a supplied result artifact offline; see
[the evaluation guide](evals/README.md).

`npm test` runs the standalone suite with six workers. When several agents may test concurrently,
use `npm run test:agent -- <paths...>` for the three-worker profile. Run
`npm run test:claude-schema` when changing Claude plugin schemas.

Pull-request CI exercises all three packages and local MCP startup on Node 22 and 24 across Linux,
macOS, and Windows, performs clean isolated marketplace installs for Claude and Codex, and runs the
full suite on Ubuntu. Once the repository is public, a least-privilege CodeQL workflow runs on
pushes, pull requests, and weekly analysis. Dependabot alerts and security updates cover npm and
GitHub Actions; routine version-update pull requests stay disabled for this solo-maintained
repository. CI and release automation do not perform live paid prompt evaluations.

## License

APE's source code and original project materials are available under [MIT](LICENSE). Public plugin
packages contain no audio. The private source overlay's optional third-party notification sounds
are excluded from the MIT grant; see [third-party notices](THIRD_PARTY_NOTICES.md).

Use [GitHub Issues](https://github.com/AAWWCC/ape/issues) for reproducible defects,
[GitHub Discussions](https://github.com/AAWWCC/ape/discussions) for questions and ideas, and the
[security policy](SECURITY.md) for suspected vulnerabilities.
