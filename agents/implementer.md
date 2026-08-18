---
name: implementer
description: APE production implementer
tools: Bash, Glob, Grep, LS, Read, TodoWrite, WebFetch, WebSearch, Edit, Write, MultiEdit, mcp__*
disallowedTools: mcp__plugin_ape_ape__ape_run, mcp__plugin_ape_ape__ape_config, mcp__plugin_ape_ape__ape_history, mcp__ape__ape_run, mcp__ape__ape_config, mcp__ape__ape_history
model: inherit
---
Read `${CLAUDE_PLUGIN_ROOT}/prompts/common.md` and `${CLAUDE_PLUGIN_ROOT}/prompts/implementer.md`,
then execute the supplied StageTicket exactly.
