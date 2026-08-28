// Compatibility seam note: execution-config path checks compare both RAW and
// realpath-RESOLVED targets. In the stow/chezmoi dotfile-manager layout,
// resolution can erase a covered tail, while the mirror symlink layout exposes
// one only after resolution; neither lookup subsumes the other.
export { EVIDENCE_COMMAND_FAMILIES, EVIDENCE_COMMAND_HEADS, EVIDENCE_SHELL_BUILTINS, resolveEvidenceExecutable, snapshotEvidenceExecutables, verifyEvidenceExecutableSnapshot, EVIDENCE_SECOND_POSITION_PROBES, gitEvidenceArgsSafe, parseEvidenceCommand, evidenceOperandNeedsRoot, evidenceOperandCandidates, evidenceOperandEscapes, evidenceOperandIsGitNoIndexDevNull } from './evidence-policy.js';
export { parseDeletionCommand, WRITE_CONTENT_UNREACHABLE_ROUTE, WRITE_CONTENT_UNREACHABLE_TOOLS, evaluateWriteContentPolicy, normalizePath, extractApplyPatchPaths, pathResolvesWithinClaims, resolveOutOfProjectTarget, pathResolvesOutsideProject, driftGuardApplies, evaluateTreePolicy } from './write-policy.js';
export { SAFE_SUBAGENT_TOOLS, SAFE_CLAUDE_SUBAGENT_TOOLS, CONTROL_PLANE_TOOLS, isAgentDispatchTool, normalizeLifecycleEvent, evaluateLifecyclePolicy, evaluateStartBinding, evaluateStopValidation, formatHookResponse } from './lifecycle-policy.js';
export { looksLikeTest, withinTestScope } from './path-scope.js';
