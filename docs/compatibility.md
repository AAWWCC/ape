# Host compatibility

APE supports Linux, macOS, and Windows. Node.js 22.12.0 or newer is required.

Release checks use these exact versions:

| Component | Pinned version |
|---|---|
| Node.js | 24.15.0 |
| Codex CLI | 0.153.4 |
| Claude Code | 2.1.228 |

The Codex pin changes explicitly from 0.147.0 to 0.153.4 for GPT-6 Astra
worker defaults. The catalog returned to 0.147.0 omitted Astra, so native
`spawn_agent` rejected the requested model even though the parent could run.
The reviewed 0.153.4 catalog includes Astra with V2 metadata. This compatibility
decision requires fresh checks on the exact host and candidate; it does not
certify a release or change the outcome of earlier failed attempts. Model
metadata comes from the host's provider catalog, without fabricated entries
or copying a catalog across client versions.

APE's Codex native worker dispatch requires the V2 agent interface on the pinned
0.153.4 host. Enable it in the Codex home used to launch APE:

```bash
codex features enable multi_agent_v2
codex features list
```

The enable command writes `features.multi_agent_v2 = true` to that home's
`config.toml`. The equivalent TOML setting is:

```toml
[features]
multi_agent_v2 = true
```

Restart Codex after changing the setting, and verify that `multi_agent_v2` is
`true` in the effective feature list for the same home and launch environment.
For one invocation, `codex --enable multi_agent_v2` selects the same interface
without persisting the setting.

This explicit V2 setting selects the native `spawn_agent` schema used by APE's
launch envelopes, including `task_name`, `fork_turns`, and model/reasoning
overrides. It also enables the V2 wait tool by default. `multi_agent = true`
alone can select the older V1 interface, which cannot accept those envelopes.
No additional feature flag is required for this selection. These details are
verified against the pinned host's [version selection](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/core/src/config/mod.rs#L1533)
and [native tool definitions](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/core/src/tools/handlers/multi_agents_spec.rs#L100).

Codex is the sole required live release-certification host.
Claude live operation is unverified. Credential-free CI checks its package, manifest, pinned CLI, and
marketplace installation structurally. Operators with authorized Claude access may
also run the optional [authenticated worker-validator check](operational-readiness.md#optional-claude-validation).
That proof checks validator reachability, not a complete Claude run. Claude
subscription or API access is not required for Codex release certification or
publication.

[`compatibility.json`](../compatibility.json) owns these values.
`npm run compatibility:check` checks its consumers for drift. Update the manifest
and its consumers together; do not silently upgrade a host to pass a release gate.

PR and release jobs use the pins above. Host validation runs without publish
privileges, and publication depends on it. The separate edge workflow tests newer
versions on temporary runners. It is informational only: no secrets, write,
identity-token, attestation, or release authority, and no ability to waive a gate.
