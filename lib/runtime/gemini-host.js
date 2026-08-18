import { open, realpath } from 'node:fs/promises';
import path from 'node:path';

const TRANSCRIPT_PREFIX_BYTES = 256 * 1024;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{32,256}$/;
const PROJECT_PATTERN = /^[A-Za-z0-9_-]{2,8192}$/;

function containedBy(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!path.isAbsolute(relative) &&
      relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !relative.startsWith('../') &&
      !relative.startsWith('..\\'))
  );
}

function uniqueMatch(text, pattern) {
  const values = [...text.matchAll(pattern)].map((match) => match[1]);
  return values.length === 1 ? values[0] : null;
}

export function encodeGeminiProjectDir(projectDir) {
  return Buffer.from(path.resolve(projectDir), 'utf8').toString('base64url');
}

export function extractGeminiPromptContext(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > TRANSCRIPT_PREFIX_BYTES) {
    return { nonce: null, project_dir: null };
  }
  const nonce = uniqueMatch(
    text,
    /(?:^|\r?\n)APE_DISPATCH_NONCE=([A-Za-z0-9_-]{1,300})(?=\r?\n|$)/g,
  );
  const encodedProject = uniqueMatch(
    text,
    /(?:^|\r?\n)APE_PROJECT_DIR_B64=([A-Za-z0-9_-]{1,8192})(?=\r?\n|$)/g,
  );
  let projectDir = null;
  if (encodedProject && PROJECT_PATTERN.test(encodedProject)) {
    try {
      const decoded = Buffer.from(encodedProject, 'base64url').toString('utf8');
      if (path.isAbsolute(decoded) && !decoded.includes('\0')) projectDir = path.resolve(decoded);
    } catch {
      // Malformed dispatch metadata carries no root authority.
    }
  }
  return {
    nonce: nonce && NONCE_PATTERN.test(nonce) ? nonce : null,
    project_dir: projectDir,
  };
}

async function readTranscriptPrefix(input) {
  const transcriptPath = input?.transcriptPath;
  const artifactDirectoryPath = input?.artifactDirectoryPath;
  if (
    typeof transcriptPath !== 'string' ||
    typeof artifactDirectoryPath !== 'string' ||
    !path.isAbsolute(transcriptPath) ||
    !path.isAbsolute(artifactDirectoryPath) ||
    !containedBy(artifactDirectoryPath, transcriptPath)
  ) {
    return '';
  }
  try {
    const [realArtifact, realTranscript] = await Promise.all([
      realpath(artifactDirectoryPath),
      realpath(transcriptPath),
    ]);
    if (!containedBy(realArtifact, realTranscript)) return '';
    const handle = await open(realTranscript, 'r');
    try {
      const buffer = Buffer.alloc(TRANSCRIPT_PREFIX_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      return buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      await handle.close();
    }
  } catch {
    return '';
  }
}

function transcriptPromptText(prefix) {
  const values = [];
  for (const line of prefix.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (typeof entry?.content === 'string') values.push(entry.content);
      if (values.length >= 8) break;
    } catch {
      // Ignore a trailing partial JSONL record at the fixed-size read boundary.
    }
  }
  return values.join('\n');
}

export async function normalizeGeminiHookInput(input, env = process.env) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const toolCall = input.toolCall && typeof input.toolCall === 'object' ? input.toolCall : null;
  const toolInput = input.tool_input ?? input.toolInput ?? input.input ?? toolCall?.args ?? {};
  const subagentPrompt = Array.isArray(toolInput.Subagents)
    ? toolInput.Subagents[0]?.Prompt
    : null;
  const directContext = extractGeminiPromptContext(
    typeof subagentPrompt === 'string' ? subagentPrompt : '',
  );
  const transcriptContext = directContext.nonce && directContext.project_dir
    ? { nonce: null, project_dir: null }
    : extractGeminiPromptContext(transcriptPromptText(await readTranscriptPrefix(input)));
  const workspaceDir = Array.isArray(input.workspacePaths)
    ? input.workspacePaths.find((candidate) => typeof candidate === 'string' && candidate.length > 0) ?? null
    : null;
  const stepId = Number.isInteger(input.stepIdx) ? String(input.stepIdx) : null;
  return {
    ...input,
    hook_event_name:
      input.hook_event_name ?? input.hookEventName ?? input.event ?? env.APE_HOOK_EVENT ?? 'unknown',
    tool_name: input.tool_name ?? input.toolName ?? input.tool ?? toolCall?.name ?? '',
    tool_input: toolInput,
    session_id: input.session_id ?? input.sessionId ?? input.conversationId ?? null,
    tool_use_id: input.tool_use_id ?? input.toolUseId ?? stepId,
    project_dir:
      input.project_dir ??
      toolInput.project_dir ??
      directContext.project_dir ??
      transcriptContext.project_dir ??
      workspaceDir ??
      null,
    cwd: input.cwd ?? toolInput.Cwd ?? toolInput.cwd ?? workspaceDir ?? null,
    gemini_dispatch_nonce: directContext.nonce ?? transcriptContext.nonce ?? null,
  };
}
