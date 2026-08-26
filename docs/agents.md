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

Agents never schedule other agents or write runtime state. A connected Unity, Blender, Playwright,
GitHub, or Codex Security MCP operation is available only when the ticket has matching
`tool_claims`; ordinary filesystem changes must still fit `claimed_paths` or `test_paths`.
Unreviewed plugin MCPs support exact per-operation read claims only.
