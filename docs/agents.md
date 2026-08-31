# Agents

Canonical role instructions live in `prompts/`. Claude wrappers are in `agents/`; Codex project
definitions are in `.codex/agents/`. The ticket and inlined common/role prompts remain complete
even when Codex falls back to its built-in `worker` or `explorer` agent types.

| Role | Writes | Default tier |
| --- | --- | --- |
| preflight analyst | no | balanced |
| planner | no | deep |
| plan checker | no | fast |
| plan critic / judge | no | deep |
| test writer | authored tests only | balanced |
| implementer | production claims only | balanced |
| reviewer / security reviewer | no | deep |
| debugger | no | deep |
| spike researcher | no | balanced |

Default model mappings:

| Tier | Claude | Codex |
| --- | --- | --- |
| fast | `haiku` | `gpt-5.4-mini`, low reasoning |
| balanced | `sonnet` | `gpt-5.5`, medium reasoning |
| deep | `opus` | `gpt-5.5`, high reasoning |

Project configuration can override tier and per-role mappings. The Claude security reviewer is
pinned to `opus` by default and that role override outranks the deep-tier mapping.

The preflight analyst runs only for behavioral fast/full phase work using plan contract v2. Its
baseline commands must be receipt-backed. Output hashes are included when the host exposes enough
raw output to compute them and omitted—not fabricated—otherwise.

The test writer follows the immutable ticket intent. `red-first` is the default and receives
runtime-owned fail/fail admission. Explicit phase-only `green-maintenance` receives runtime-owned
pass/pass admission for green-on-arrival coverage or deflaking; when no production path is claimed,
review follows directly and no implementer is dispatched.

Agents never schedule other agents or write runtime state. External MCP tools exposed by the host
remain available without APE-specific names, claims, adapters, or provider allowlists. The host and
operator own discovery and permission decisions. APE still verifies repository changes at stage
and receipt boundaries, so ordinary filesystem changes must fit `claimed_paths` or `test_paths`.

Every canonical and packaged Claude role explicitly grants the receipt validator under both known
host-qualified names: `mcp__ape__ape_validate_receipt` and
`mcp__plugin_ape_ape__ape_validate_receipt`. The broad external-MCP wildcard is not treated as proof
that a deferred per-role schema was provisioned. The manual authenticated prerequisite in
`docs/operational-readiness.md` launches every role through Claude, verifies that an actual linked
validator call reaches the APE service, and emits a candidate-bound proof for external retention.
