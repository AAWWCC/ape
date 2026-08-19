/**
 * Statusline wiring for Claude's command renderer and Codex's native footer.
 *
 * Claude exposes a command-backed statusLine. `${CLAUDE_PLUGIN_ROOT}` is NOT
 * expanded there, so a marketplace install cannot ship the command directly;
 * `ape_config wire` writes an explicit, opt-in statusLine into settings.json.
 *
 * settings.json points at a STABLE shim in the host config dir; the shim resolves
 * the newest installed `bin/ape-statusline.mjs` from the plugin cache at run time,
 * so a version bump that changes the cache directory never breaks the wire.
 *
 * Codex deliberately has a different contract: `[tui].status_line` is an
 * ordered list of built-in item identifiers, not an external command hook. Its
 * wire path therefore installs the closest native footer and reports that the
 * APE powerline renderer is unavailable instead of pretending the Claude shim
 * can run. A private ownership record lets unwire restore only APE's own two
 * assignments while preserving later edits to unrelated config.toml keys.
 */
import { readFile, mkdir, realpath, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { atomicReplaceText, atomicWriteJson } from './storage.js';

const SUPPORTED_HOSTS = new Set(['claude', 'codex']);

// These identifiers are supported by Codex's native /statusline picker. They
// approximate the host-neutral parts of APE's Claude renderer without claiming
// to expose APE stage state: Codex currently has no plugin/custom-command status
// item surface. Keep this conservative list compatible with the first Codex
// releases that shipped configurable status lines.
const CODEX_STATUS_LINE_ITEMS = Object.freeze([
  'model-with-reasoning',
  'current-dir',
  'git-branch',
  'task-progress',
  'context-used',
]);
const CODEX_STATUS_LINE_ASSIGNMENT = `status_line = ${JSON.stringify(CODEX_STATUS_LINE_ITEMS)}`;
const CODEX_STATUS_LINE_COLORS_ASSIGNMENT = 'status_line_use_colors = true';
const CODEX_WIRE_MARKER = '# APE managed Codex-native status line';
const CODEX_WIRE_STATE_VERSION = 1;
const CODEX_RENDERER_LIMITATION =
  'Codex supports built-in status-line items only; custom APE powerline blocks and glyphs require an external-command status-line API that Codex does not currently expose.';

function assertHost(host) {
  if (!SUPPORTED_HOSTS.has(host)) {
    throw new Error(`statusline wiring supports hosts 'claude' and 'codex'; got '${host}'`);
  }
}

function claudeConfigDir() {
  return path.join(homedir(), '.claude');
}

function claudeSettingsPath() {
  return path.join(claudeConfigDir(), 'settings.json');
}

function claudeShimPath() {
  return path.join(claudeConfigDir(), 'ape-statusline.sh');
}

function shimCommand() {
  return `bash "${claudeShimPath()}"`;
}

function codexConfigDir() {
  return process.env.CODEX_HOME
    ? path.resolve(process.env.CODEX_HOME)
    : path.join(homedir(), '.codex');
}

function codexConfigPath() {
  return path.join(codexConfigDir(), 'config.toml');
}

function codexWireStatePath() {
  return path.join(codexConfigDir(), 'ape-statusline-wire.json');
}

// Marker every APE statusLine command contains, so status detection never
// mistakes a foreign or wrapped command for APE's own.
const WIRE_MARKER = 'ape-statusline';

// Shipped fallback for the wired refresh cadence (T12), mirroring
// DEFAULT_CONFIG.statusline.refresh_interval_seconds in config.js.
const DEFAULT_REFRESH_INTERVAL_SECONDS = 5;

// Resolve the configured statusline.refresh_interval_seconds into the integer
// second count written to settings.statusLine.refreshInterval. A finite number
// floors to an integer clamped up to a minimum of 1 (0/-1 -> 1, 1.5 -> 1,
// 2.9 -> 2), with no upper clamp; any non-numeric or non-finite value (a
// hand-edited 'abc', null, NaN, Infinity) falls back to the shipped default.
function resolveRefreshInterval(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(1, Math.floor(value));
  }
  return DEFAULT_REFRESH_INTERVAL_SECONDS;
}

function shimContent() {
  return `#!/usr/bin/env bash
# APE v2 statusline shim — written by ape_config wire. STABLE and version-
# INDEPENDENT: settings.json points here, and this file resolves the newest
# COMPLETE plugin-cache renderer (bin/ape-statusline.mjs) at RUN time, so a
# plugin update that changes the version directory cannot break the wired
# statusLine. Candidate version dirs are probed newest-first and the first one
# actually holding the renderer wins, so a partial newer directory (an
# interrupted update) falls back to the newest complete install instead of
# silently rendering nothing.
input=$(cat)
cache_base="$HOME/.claude/plugins/cache/ape/ape"
resolved=""
if [ -d "$cache_base" ]; then
  for candidate in $(ls -1 "$cache_base" 2>/dev/null | sort -rV); do
    if [ -f "$cache_base/$candidate/bin/ape-statusline.mjs" ]; then
      resolved="$cache_base/$candidate/bin/ape-statusline.mjs"
      break
    fi
  done
fi
if [ -n "$resolved" ]; then
  printf '%s' "$input" | node "$resolved"
fi
`;
}

async function readSettings(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw error;
  }
}

async function readText(file, fallback = undefined) {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT' && fallback !== undefined) return fallback;
    throw error;
  }
}

async function readCodexWireState() {
  try {
    const state = JSON.parse(await readFile(codexWireStatePath(), 'utf8'));
    if (
      state?.version !== CODEX_WIRE_STATE_VERSION ||
      typeof state?.installed?.status_line !== 'string' ||
      typeof state?.installed?.status_line_use_colors !== 'string' ||
      typeof state?.previous?.had_tui_section !== 'boolean' ||
      !(typeof state?.previous?.status_line === 'string' || state?.previous?.status_line === null) ||
      !(
        typeof state?.previous?.status_line_use_colors === 'string' ||
        state?.previous?.status_line_use_colors === null
      )
    ) {
      throw new Error(`invalid APE Codex statusline ownership record: ${codexWireStatePath()}`);
    }
    return state;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function splitLines(text) {
  return text.match(/.*(?:\r\n|\n|$)/g).filter((line) => line.length > 0);
}

function lineBody(line) {
  return line.replace(/(?:\r\n|\n)$/, '');
}

function eolFor(text) {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

function assignmentEnd(lines, start) {
  let square = 0;
  let curly = 0;
  let quote = null;
  let escaped = false;
  let sawContainer = false;

  for (let index = start; index < lines.length; index += 1) {
    const body = lineBody(lines[index]);
    const begin = index === start ? Math.max(0, body.indexOf('=') + 1) : 0;
    for (let cursor = begin; cursor < body.length; cursor += 1) {
      const char = body[cursor];
      if (quote) {
        if (quote === '"' && escaped) {
          escaped = false;
        } else if (quote === '"' && char === '\\') {
          escaped = true;
        } else if (char === quote) {
          quote = null;
        }
        continue;
      }
      if (char === '#') break;
      if (char === '"' || char === "'") {
        quote = char;
      } else if (char === '[') {
        square += 1;
        sawContainer = true;
      } else if (char === ']') {
        square -= 1;
      } else if (char === '{') {
        curly += 1;
        sawContainer = true;
      } else if (char === '}') {
        curly -= 1;
      }
      if (square < 0 || curly < 0) break;
    }
    if (!quote && square === 0 && curly === 0 && (index === start || sawContainer)) return index + 1;
  }
  throw new Error('cannot safely edit Codex config.toml: unterminated [tui] assignment');
}

function inspectCodexTui(text) {
  const lines = splitLines(text);
  const unsupportedDotted = lines.some((line) =>
    /^\s*(?:tui\s*=|tui\.(?:status_line|status_line_use_colors)\s*=)/.test(lineBody(line)),
  );
  const quotedTui = lines.some((line) => /^\s*\[\s*["']tui["']\s*\]/.test(lineBody(line)));
  if (unsupportedDotted || quotedTui) {
    throw new Error(
      'cannot safely edit Codex statusline: use a standard [tui] table in config.toml (inline, dotted, and quoted-table forms are not rewritten)',
    );
  }

  const headers = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (/^\s*\[\s*tui\s*\]\s*(?:#.*)?$/.test(lineBody(lines[index]))) headers.push(index);
  }
  if (headers.length > 1) {
    throw new Error('cannot safely edit Codex config.toml: multiple [tui] tables found');
  }

  const header = headers[0] ?? null;
  const sectionEnd = header === null
    ? null
    : lines.findIndex((line, index) => index > header && /^\s*\[\[?.+/.test(lineBody(line)));
  const end = header === null || sectionEnd === -1 ? lines.length : sectionEnd;
  const assignments = {};
  if (header !== null) {
    for (let index = header + 1; index < end; index += 1) {
      const match = lineBody(lines[index]).match(/^\s*(status_line|status_line_use_colors)\s*=/);
      if (!match) continue;
      if (assignments[match[1]]) {
        throw new Error(`cannot safely edit Codex config.toml: duplicate [tui].${match[1]} assignments`);
      }
      const assignmentEndIndex = assignmentEnd(lines, index);
      if (assignmentEndIndex > end) {
        throw new Error(`cannot safely edit Codex config.toml: [tui].${match[1]} crosses a table boundary`);
      }
      assignments[match[1]] = {
        start: index,
        end: assignmentEndIndex,
        raw: lines.slice(index, assignmentEndIndex).join(''),
      };
      index = assignmentEndIndex - 1;
    }
  }
  return { lines, header, end, assignments };
}

function withoutTrailingEol(text) {
  return text.replace(/(?:\r\n|\n)+$/, '');
}

function assignmentMatches(assignment, expected) {
  return assignment && withoutTrailingEol(assignment.raw).trim() === expected;
}

function codexConfigMatchesState(inspection, state) {
  return Boolean(
    assignmentMatches(inspection.assignments.status_line, state?.installed?.status_line) &&
    assignmentMatches(
      inspection.assignments.status_line_use_colors,
      state?.installed?.status_line_use_colors,
    ),
  );
}

function removeCodexManagedLines(inspection) {
  const { lines, assignments } = inspection;
  const ranges = Object.values(assignments)
    .filter(Boolean)
    .map(({ start, end }) => ({ start, end }));
  for (let index = 0; index < lines.length; index += 1) {
    if (lineBody(lines[index]).trim() === CODEX_WIRE_MARKER) ranges.push({ start: index, end: index + 1 });
  }
  ranges.sort((left, right) => right.start - left.start);
  for (const range of ranges) lines.splice(range.start, range.end - range.start);
  return lines;
}

function installCodexStatusline(text) {
  const inspection = inspectCodexTui(text);
  const previous = {
    had_tui_section: inspection.header !== null,
    status_line: inspection.assignments.status_line?.raw ?? null,
    status_line_use_colors: inspection.assignments.status_line_use_colors?.raw ?? null,
  };
  const lines = removeCodexManagedLines(inspection);
  const eol = eolFor(text);
  const refreshed = inspectCodexTui(lines.join(''));
  if (refreshed.header === null) {
    if (lines.length > 0 && !/(?:\r\n|\n)$/.test(lines.at(-1))) lines[lines.length - 1] += eol;
    lines.push(`[tui]${eol}`);
    lines.push(`${CODEX_WIRE_MARKER}${eol}`);
    lines.push(`${CODEX_STATUS_LINE_ASSIGNMENT}${eol}`);
    lines.push(`${CODEX_STATUS_LINE_COLORS_ASSIGNMENT}${eol}`);
  } else {
    const insertAt = refreshed.header + 1;
    lines.splice(
      insertAt,
      0,
      `${CODEX_WIRE_MARKER}${eol}`,
      `${CODEX_STATUS_LINE_ASSIGNMENT}${eol}`,
      `${CODEX_STATUS_LINE_COLORS_ASSIGNMENT}${eol}`,
    );
  }
  return { text: lines.join(''), previous };
}

function restoreCodexStatusline(text, previous) {
  const inspection = inspectCodexTui(text);
  const lines = removeCodexManagedLines(inspection);
  let refreshed = inspectCodexTui(lines.join(''));
  const eol = eolFor(text);
  if (refreshed.header === null && (previous.status_line || previous.status_line_use_colors)) {
    if (lines.length > 0 && !/(?:\r\n|\n)$/.test(lines.at(-1))) lines[lines.length - 1] += eol;
    lines.push(`[tui]${eol}`);
    refreshed = inspectCodexTui(lines.join(''));
  }
  if (refreshed.header !== null) {
    const restored = [previous.status_line, previous.status_line_use_colors]
      .filter((value) => typeof value === 'string')
      .map((value) => (/(?:\r\n|\n)$/.test(value) ? value : `${value}${eol}`));
    lines.splice(refreshed.header + 1, 0, ...restored);
  }

  // If APE created the [tui] table and it is still empty after removing our
  // assignments, remove the table too. Any user-added key or comment keeps it.
  if (!previous.had_tui_section) {
    const finalInspection = inspectCodexTui(lines.join(''));
    if (finalInspection.header !== null) {
      const body = lines
        .slice(finalInspection.header + 1, finalInspection.end)
        .map(lineBody)
        .filter((line) => line.trim() !== '');
      if (body.length === 0) lines.splice(finalInspection.header, finalInspection.end - finalInspection.header);
    }
  }
  return lines.join('');
}

function isWired(settings) {
  const command = settings?.statusLine?.command;
  return typeof command === 'string' && command.includes(WIRE_MARKER);
}

// settings.json is the user's GLOBAL host configuration: an in-place write
// truncated by a crash breaks their whole Claude Code setup, so it gets the
// same temp-then-atomic-replace discipline as runtime state (D1). Two
// user-owned-file courtesies the runtime's own state files never need: write
// through realpath so a symlinked settings.json keeps its link instead of
// being replaced by a regular file, and preserve the existing mode (default
// 0644 for a fresh file — never storage's private 0600, which would lock out
// readers the user had allowed).
async function writeSettings(file, settings) {
  await writeCallerOwnedText(file, `${JSON.stringify(settings, null, 2)}\n`);
}

async function writeCallerOwnedText(file, text) {
  let target = file;
  try {
    target = await realpath(file);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  let mode = 0o644;
  try {
    mode = (await stat(target)).mode & 0o777;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  await atomicReplaceText(target, text, { mode });
}

// Mode for the settings.json.bak sibling (audit 1.13 nit 6): the backup is a
// copy of the user's own settings file, so it must carry the SOURCE file's
// mode — a 0600-ish settings.json must not leak a wider umask-default .bak.
// A fresh (absent) source keeps the same 0644 default writeSettings uses.
async function settingsBackupMode(file) {
  try {
    return (await stat(file)).mode & 0o777;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    return 0o644;
  }
}

export async function statuslineState({ host = 'claude' } = {}) {
  assertHost(host);
  if (host === 'codex') return codexStatuslineState();
  const settings = await readSettings(claudeSettingsPath());
  return {
    wired: isWired(settings),
    mode: 'command',
    renderer: 'ape-powerline',
    custom_renderer: true,
    command: settings?.statusLine?.command ?? null,
    settings_path: claudeSettingsPath(),
    shim_path: claudeShimPath(),
  };
}

async function codexStatuslineState() {
  const config = await readText(codexConfigPath(), '');
  const state = await readCodexWireState();
  const inspection = inspectCodexTui(config);
  const wired = Boolean(state && codexConfigMatchesState(inspection, state));
  return {
    wired,
    modified: Boolean(state && !wired),
    mode: 'native',
    renderer: 'codex-native',
    custom_renderer: false,
    items: CODEX_STATUS_LINE_ITEMS,
    config_path: codexConfigPath(),
    state_path: codexWireStatePath(),
    limitation: CODEX_RENDERER_LIMITATION,
  };
}

async function wireCodexStatusline() {
  const file = codexConfigPath();
  await mkdir(codexConfigDir(), { recursive: true });
  const config = await readText(file, '');
  const oldState = await readCodexWireState();
  const inspection = inspectCodexTui(config);
  const owned = Boolean(oldState && codexConfigMatchesState(inspection, oldState));

  // A same-version rewire is a true no-op: in particular, do not replace the
  // backup or original assignments that unwire still needs to restore.
  if (
    owned &&
    oldState.installed.status_line === CODEX_STATUS_LINE_ASSIGNMENT &&
    oldState.installed.status_line_use_colors === CODEX_STATUS_LINE_COLORS_ASSIGNMENT
  ) {
    return {
      ...(await codexStatuslineState()),
      backup_path: `${file}.bak`,
      unchanged: true,
    };
  }

  const installed = installCodexStatusline(config);
  const previous = owned ? oldState.previous : installed.previous;
  const state = {
    version: CODEX_WIRE_STATE_VERSION,
    installed: {
      status_line: CODEX_STATUS_LINE_ASSIGNMENT,
      status_line_use_colors: CODEX_STATUS_LINE_COLORS_ASSIGNMENT,
    },
    previous,
  };

  // config.toml is caller-owned, so keep an exact, mode-preserving backup and
  // write through symlinks. The sidecar is APE-owned private state.
  await atomicReplaceText(`${file}.bak`, config, { mode: await settingsBackupMode(file) });
  await writeCallerOwnedText(file, installed.text);
  await atomicWriteJson(codexWireStatePath(), state);
  return {
    ...(await codexStatuslineState()),
    backup_path: `${file}.bak`,
  };
}

async function unwireCodexStatusline() {
  const file = codexConfigPath();
  const state = await readCodexWireState();
  if (!state) {
    return {
      ...(await codexStatuslineState()),
      removed: false,
    };
  }
  const config = await readText(file, '');
  const inspection = inspectCodexTui(config);
  if (!codexConfigMatchesState(inspection, state)) {
    return {
      ...(await codexStatuslineState()),
      removed: false,
      modified: true,
    };
  }

  await atomicReplaceText(`${file}.bak`, config, { mode: await settingsBackupMode(file) });
  await writeCallerOwnedText(file, restoreCodexStatusline(config, state.previous));
  await rm(codexWireStatePath(), { force: true });
  return {
    wired: false,
    removed: true,
    modified: false,
    mode: 'native',
    renderer: 'codex-native',
    custom_renderer: false,
    items: CODEX_STATUS_LINE_ITEMS,
    config_path: file,
    state_path: codexWireStatePath(),
    limitation: CODEX_RENDERER_LIMITATION,
  };
}

/**
 * @param {{ host?: string, refreshIntervalSeconds?: number }} [options] The
 *   wired project's resolved statusline.refresh_interval_seconds (T12);
 *   undefined falls back to the shipped default in resolveRefreshInterval.
 */
export async function wireStatusline({ host = 'claude', refreshIntervalSeconds } = {}) {
  assertHost(host);
  if (host === 'codex') return wireCodexStatusline();
  const file = claudeSettingsPath();
  await mkdir(claudeConfigDir(), { recursive: true });

  // Stable resolver shim, marked executable — atomic-replace so a crash can
  // never leave a truncated shim (or temp litter) behind (audit 1.13 nit 6).
  await atomicReplaceText(claudeShimPath(), shimContent(), { mode: 0o755 });

  const settings = await readSettings(file);
  // Back up whatever was there before touching a user-owned global file, with
  // the source file's own mode and the same atomic-replace discipline.
  await atomicReplaceText(`${file}.bak`, `${JSON.stringify(settings, null, 2)}\n`, {
    mode: await settingsBackupMode(file),
  });
  // refreshInterval keeps the renderer's wall-clock animations (stage-mark
  // pulse, bar creep) moving while the host session is idle — e.g. waiting on
  // a dispatched subagent, exactly when an APE run is busiest. Without it the
  // host only re-renders on session events. But that cadence is a standing
  // cost: every tick spawns one node plus up to ~3 git processes in every
  // wired project, forever, even when APE is idle — disproportionate as an
  // always-on default. So the wired default is 5s, config-driven via
  // statusline.refresh_interval_seconds (floored to an integer >= 1, no upper
  // clamp); a user who wants the old 1s animation smoothness sets it back to 1
  // explicitly. 1s is the host's minimum.
  const refreshInterval = resolveRefreshInterval(refreshIntervalSeconds);
  settings.statusLine = { type: 'command', command: shimCommand(), refreshInterval };
  await writeSettings(file, settings);

  return {
    wired: true,
    mode: 'command',
    renderer: 'ape-powerline',
    custom_renderer: true,
    settings_path: file,
    shim_path: claudeShimPath(),
    command: shimCommand(),
    backup_path: `${file}.bak`,
  };
}

export async function unwireStatusline({ host = 'claude' } = {}) {
  assertHost(host);
  if (host === 'codex') return unwireCodexStatusline();
  const file = claudeSettingsPath();
  const settings = await readSettings(file);
  const command = settings?.statusLine?.command;
  // Ownership is EXACT-COMMAND equality, not marker presence (audit 1.13
  // nit 7): a user who wrapped APE's wired command in their own pipeline
  // (`bash ".../ape-statusline.sh" | tee …`) still carries the marker, but
  // that statusLine is no longer APE's to remove — and the shim their
  // pipeline invokes must survive too. Settings stay byte-identical, the
  // shim stays on disk, and the additive `wrapped` flag reports why nothing
  // was removed.
  if (typeof command === 'string' && command.trim() !== shimCommand() && isWired(settings)) {
    return { wired: true, removed: false, wrapped: true, settings_path: file };
  }
  const removed = isWired(settings);
  // Only a wired settings.json is touched: unwiring an unwired host must not
  // create (or needlessly rewrite) the user's global file — removing the shim
  // is the whole job then. When it IS wired, back up before modifying, the
  // same courtesy wire extends (source-mode-preserving and atomic, nit 6).
  if (removed) {
    await atomicReplaceText(`${file}.bak`, `${JSON.stringify(settings, null, 2)}\n`, {
      mode: await settingsBackupMode(file),
    });
    delete settings.statusLine;
    await writeSettings(file, settings);
  }
  await rm(claudeShimPath(), { force: true });
  return {
    wired: false,
    removed,
    mode: 'command',
    renderer: 'ape-powerline',
    custom_renderer: true,
    settings_path: file,
  };
}
