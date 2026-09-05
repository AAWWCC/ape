# Agents

APE assigns each stage to a worker with a specific role and limited write access.
Workers do not schedule other workers or edit APE's runtime state.

| Role | May edit | Default tier |
| --- | --- | --- |
| preflight analyst | Nothing | balanced |
| planner | Nothing | deep |
| plan checker | Nothing | fast |
| plan critic / judge | Nothing | deep |
| test writer | Authored tests only | balanced |
| implementer | Approved production paths only | balanced |
| reviewer / security reviewer | Nothing | deep |
| debugger | Nothing | deep |
| spike researcher | Nothing | balanced |

## Models

| Tier | Claude | Codex |
| --- | --- | --- |
| fast | `haiku` | `gpt-5.4-mini`, low reasoning |
| balanced | `sonnet` | `gpt-5.5`, medium reasoning |
| deep | `opus` | `gpt-5.5`, high reasoning |

Project configuration can override tiers or individual roles. Claude's security
reviewer defaults to `opus`; its role override takes priority over the deep tier.

## Tests and evidence

The preflight analyst runs only for behavioral fast/full phase work using plan
contract v2. Each reported baseline command needs a matching receipt entry.
Output hashes are included only when the host exposes enough output to compute them.

The test writer follows the ticket's test intent:

- `red-first` (default): the runtime must observe fail/fail evidence.
- `green-maintenance` (phase mode only): the runtime must observe pass/pass evidence
  for green-on-arrival coverage or deflaking. If there are no production claims,
  review follows testing without an implementer.

## Tools and receipts

The host controls external MCP tools and their permissions. APE still checks that
project edits fit `claimed_paths` or `test_paths`.

Trusted hooks give each bound worker its receipt envelope and role-specific
`output_schema`. The worker's final response must be the receipt object itself.
`SubagentStop` returns field corrections if it is missing or malformed. The worker
must also call `ape_validate_receipt` to attest the exact draft before the parent
can record it. See [receipt validation](mcp-tools.md#receipt-validation-and-recovery).

Claude roles grant both exact validator names: `mcp__ape__ape_validate_receipt` and
`mcp__plugin_ape_ape__ape_validate_receipt`. An external-tool wildcard alone does not
prove the validator is available. The [Claude release prerequisite](operational-readiness.md)
checks actual tool reachability for every packaged role without changing its allowlist.

## Instruction files

Shared role instructions live in `prompts/`, Claude wrappers in `agents/`, and
Codex definitions in `.codex/agents/`. Tickets include the full common and role
instructions even when Codex uses its built-in `worker` or `explorer` types.
