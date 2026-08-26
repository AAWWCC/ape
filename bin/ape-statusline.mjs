#!/usr/bin/env node
/**
 * APE v2 statusline renderer.
 *
 * Claude Code (and Codex) pipe a JSON status payload on stdin and render this
 * command's stdout as the statusline. Host-neutral, node builtins plus the
 * shared `lib/runtime/paths.js` resolver (shipped alongside this script): it
 * resolves the project root from the payload and reads that project's
 * `.ape/runtime/active.json` — the file `lib/runtime/paths.js` writes — to
 * show the live run.
 *
 * Style carries the v1 aesthetic onto the v2 data model:
 *   - truecolor tokyo-night palette (256-color fallback, chosen by $COLORTERM)
 *   - charset tiers via $APE_STATUSLINE_CHARSET: nerdfont (powerline + glyphs),
 *     unicode (default), ascii — glyph codepoints match v1
 *   - a context-window gauge (used %, colored by the v1 threshold ladder), shown
 *     whenever the host reports it, independent of any run
 *   - an APE identity box, permanent in APE projects (any dir owning `.ape/`):
 *     `APE <mode>/<lane>` during a run, `APE idle` otherwise — so the box
 *     appearing/disappearing never reshuffles the line inside a project
 *   - run-only readouts beside it: a stage box carrying the milestone word
 *     (coloured by milestone/status — check at completion, warning when
 *     blocked, red ABORT when aborted), a stage strip (per-milestone glyphs on
 *     nerdfont, initials elsewhere; while the run moves, done green / current
 *     highlighted / pending dim), and a time-calibrated progress bar. A
 *     TERMINAL run carries its state in the strip's colour instead: every mark
 *     orange when blocked, every mark red once aborted, with no done/current
 *     boundary at all — which is what lets an aborted run keep a strip (the
 *     sealed state's stage is the literal 'aborted', and a uniform strip
 *     reports no position to be wrong about) while still dropping the bar,
 *     whose fill would fabricate one. No reason text renders here: the block
 *     reason lives in `ape_run action: status` AND `.ape/runtime/status.md`,
 *     the abort reason in `ape_run action: status`
 *
 * Degrades to `model · dir · branch · ctx%` outside APE projects, so it is safe
 * to wire globally.
 */
import { readFileSync, readdirSync, existsSync, lstatSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hostname, tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolveGovernedRoot } from '../lib/runtime/paths.js';
import { projectRunDiagnostic, safeDiagnosticText, strictIsoMs } from '../lib/runtime/diagnostics.js';

const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';

// tokyo-night: [truecolor hex, xterm-256 fallback]
const PALETTE = {
  accent: ['#7aa2f7', 111], cyan: ['#7dcfff', 117], green: ['#9ece6a', 149],
  yellow: ['#e0af68', 179], orange: ['#ff9e64', 215], red: ['#f7768e', 204],
  magenta: ['#bb9af7', 141], gray: ['#565f89', 60], fg: ['#c0caf5', 189],
  bg: ['#1a1b26', 235], panel: ['#292e42', 236], s2: ['#3b4261', 237], track: ['#414868', 238],
};
const TRUECOLOR = /truecolor|24bit/i.test(process.env.COLORTERM ?? '');
const rgb = (hex) => { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const fg = (name) => { const [h, x] = PALETTE[name]; return TRUECOLOR ? `\x1b[38;2;${rgb(h).join(';')}m` : `\x1b[38;5;${x}m`; };
const bg = (name) => { const [h, x] = PALETTE[name]; return TRUECOLOR ? `\x1b[48;2;${rgb(h).join(';')}m` : `\x1b[48;5;${x}m`; };

const CHARSET = (() => {
  const c = process.env.APE_STATUSLINE_CHARSET;
  return ['nerdfont', 'unicode', 'ascii'].includes(c) ? c : 'unicode';
})();

// Glyph codepoints (hex) mirror v1's fallback theme table.
const nf = (hex) => String.fromCodePoint(parseInt(hex, 16));
const GLYPH_HEX = {
  nerdfont: {
    sep: 'e0b0', model: 'f2db', folder: 'f07b', branch: 'f418', gauge: 'f0e4',
    block: 'f071', check: 'f00c',
    dirty: '25cf', ahead: '2191', behind: '2193',
  },
  unicode: {
    sep: '', model: '', folder: '', branch: '', gauge: '',
    block: '26a0', check: '2713',
    dirty: '25cf', ahead: '2191', behind: '2193',
  },
  ascii: {
    sep: '', model: '', folder: '', branch: '', gauge: '',
    block: '', check: '',
    dirty: '2a', ahead: '5e', behind: '76',
  },
};
const G = Object.fromEntries(
  Object.entries(GLYPH_HEX[CHARSET]).map(([k, v]) => [k, v ? nf(v) : '']),
);
// Fixed gauge label where a charset has no glyph.
const GAUGE = G.gauge ? `${G.gauge} ` : 'ctx ';

const BAR_PARTIALS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'];
// One continuous bar: the fill colour drawn as foreground over a SOLID
// track-colour background. Painting the track as a real background (not the airy
// ░ light-shade over terminal bg) closes the gap two ways — a partial cell's
// unfilled remainder shows the track colour instead of a terminal-bg notch, and
// the empty cells are solid track rather than sparse dots.
function smoothBar(pct, width, fillName, trackName) {
  if (CHARSET === 'ascii') {
    const full = Math.round((pct / 100) * width);
    return `${fg(fillName)}${'#'.repeat(full)}${fg(trackName)}${'-'.repeat(width - full)}${RESET}`;
  }
  const cells = (pct / 100) * width;
  let full = Math.floor(cells);
  let rem = Math.round((cells - full) * 8);
  // A fraction that rounds to 8/8 IS a full cell — indexing BAR_PARTIALS[8]
  // would render the literal string "undefined".
  if (rem === 8) { full += 1; rem = 0; }
  const partial = rem ? BAR_PARTIALS[rem] : '';
  const fill = '█'.repeat(full) + partial;
  const empty = ' '.repeat(Math.max(0, width - full - (partial ? 1 : 0)));
  return `${bg(trackName)}${fg(fillName)}${fill}${empty}${RESET}`;
}

const readStdin = () => { try { return readFileSync(0, 'utf8'); } catch { return ''; } };
const parse = (raw) => { try { return raw.trim() ? JSON.parse(raw) : {}; } catch { return {}; } };
// Same project-root resolution as the hook and MCP server (F6): the host's
// explicit workspace.project_dir (or the env pin) outranks the drifting
// current dir, and every hint seeds the walk up to the nearest ancestor
// holding `.ape/` — so the run segment survives a cd into a subdirectory and
// a session *launched* in one.
const projectDir = (p) =>
  resolveGovernedRoot({
    explicitDir: p.workspace?.project_dir,
    cwd: p.workspace?.current_dir ?? p.cwd,
    // Codex exposes built-in footer items only and never launches this
    // command renderer. Pin the actual adapter host so a stale CODEX_CWD (or
    // missing Claude marker in a manually wired shell) cannot redirect it.
    host: 'claude',
  });
let activeStateCorrupt = false;
const readActive = (dir) => {
  try {
    const value = JSON.parse(readFileSync(join(dir, '.ape', 'runtime', 'active.json'), 'utf8'));
    const diagnostic = projectRunDiagnostic(value);
    if (diagnostic.reason_code === 'corrupt_state') {
      const legacy = value && typeof value === 'object' && !Array.isArray(value) &&
        !['schema_version', 'run_id', 'host', 'dispatch_state'].some((key) => Object.hasOwn(value, key)) &&
        !Object.hasOwn(value, 'objective') &&
        ['phase', 'debug', 'spike', 'land'].includes(value.mode) &&
        ['auto', 'mechanical', 'fast', 'full'].includes(value.lane) &&
        ['planning', 'running', 'gating', 'blocked', 'shipping', 'completed', 'aborted'].includes(value.status) &&
        ['dispatch', 'plan', 'plan-replan', 'plan-check', 'plan-critic', 'plan-judge',
          'test', 'test-reconcile', 'test-recheck', 'build', 'review',
          'security-review', 'remediation-test', 'remediation-build', 'remediation-review',
          'remediation-security-review', 'gates', 'merge', 'debug', 'spike', 'complete',
          'completed', 'aborted'].includes(value.stage) &&
        Array.isArray(value.tickets) && value.tickets.length <= 256 &&
        Array.isArray(value.receipts) && value.receipts.length <= 256 &&
        (value.tickets.length > 0 || Object.hasOwn(value, 'updated_at') ||
          ['blocked', 'completed', 'aborted'].includes(value.status));
      if (legacy) {
        return {
          schema_version: '2.0.0',
          run_id: 'run-statusline-legacy',
          mode: value.mode,
          lane: value.lane,
          host: 'claude',
          status: value.status,
          stage: value.stage,
          dispatch_state: 'none',
          tickets: [],
          receipts: [],
          expired_tickets: [],
          ...(strictIsoMs(value.updated_at) !== null ? { updated_at: value.updated_at } : {}),
        };
      }
      activeStateCorrupt = true;
      const safeVisual = value && typeof value === 'object' && !Array.isArray(value)
        && ['phase', 'debug', 'spike', 'land'].includes(value.mode)
        && ['auto', 'mechanical', 'fast', 'full'].includes(value.lane)
        && ['planning', 'running', 'gating', 'blocked', 'shipping', 'completed', 'aborted'].includes(value.status)
        && ['dispatch', 'plan', 'plan-replan', 'plan-check', 'plan-critic', 'plan-judge',
          'test', 'test-reconcile', 'test-recheck', 'build', 'review',
          'security-review', 'remediation-test', 'remediation-build', 'remediation-review',
          'remediation-security-review', 'gates', 'merge', 'debug', 'spike', 'complete',
          'completed', 'aborted'].includes(value.stage)
        && Array.isArray(value.tickets) && value.tickets.length <= 256
        && Array.isArray(value.receipts) && value.receipts.length <= 256;
      if (!safeVisual) return null;
      return {
        schema_version: '2.0.0',
        run_id: isCanonicalVisualRunId(value.run_id) ? value.run_id : 'run-statusline-corrupt',
        mode: value.mode,
        lane: value.lane,
        host: ['claude', 'codex'].includes(value.host) ? value.host : 'claude',
        status: value.status,
        stage: value.stage,
        dispatch_state: 'none',
        tickets: [],
        receipts: [],
        expired_tickets: [],
        ...(strictIsoMs(value.updated_at) !== null ? { updated_at: value.updated_at } : {}),
      };
    }
    return value;
  } catch {
    activeStateCorrupt = existsSync(join(dir, '.ape', 'runtime', 'active.json'));
    return null;
  }
};
const isCanonicalVisualRunId = (value) => typeof value === 'string' && /^run-[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/.test(value);
// The ONE numeric environment-variable reader in this file (roadmap entry
// outside-input-coerced-not-refused-and-ambient-env-denylist, item A). Taking
// a raw env string straight through the `Number` constructor treats a
// SET-BUT-EMPTY variable as 0 -- an empty string converts to 0, and 0 is
// finite -- silently indistinguishable from a deliberate override of exactly
// 0. That is not a hypothetical: it is exactly what nowMs() below used to do,
// freezing the progress bar and stage-mark pulse at the milestone start
// forever with no diagnostic. A WHITESPACE-ONLY value has the identical
// failure mode: per StringToNumber, a StrWhiteSpace-only string also has MV
// 0, so `Number(' ')` is finite and would silently pin the clock exactly
// like an empty string would. An unset, empty OR whitespace-only variable
// falls back to `fallback` here; a set, non-blank value must parse to a
// finite number no smaller than `min` (default 0) or it is treated the same
// as absent, never silently accepted as some other coerced number. Every
// other numeric env read in this file must route through this helper --
// never a bare conversion of an env string -- so a third numeric var added
// later inherits the same floor automatically.
/**
 * @param {string} name
 * @param {{ min?: number, fallback?: number }} [options]
 */
function envFiniteMs(name, { min = 0, fallback } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= min ? value : fallback;
}

// Every render-path git probe shares one bound: a timeout so a hung git never
// stalls the render, and GIT_OPTIONAL_LOCKS=0 so probes take no optional
// locks. The cap is generous enough to tolerate a merely-slow git on a loaded
// machine (a real hang lasts seconds), and env-overridable so tests stay
// deterministic. gitBranch used to run unbounded, contradicting the
// never-stalls goal the status probe already met.
const GIT_TIMEOUT_MS = envFiniteMs('APE_STATUSLINE_GIT_TIMEOUT_MS', { min: 1, fallback: 200 });

// Last-known branch, persisted per project dir so a transient git spawn
// timeout on one stateless render does not blank a branch a prior render
// already resolved (each render is a fresh process — nothing survives in
// memory). Lives under the OS temp dir, keyed by a hash of the resolved
// project path — NEVER under the project's own `.ape/` — because an ordinary
// git repo that is not an APE project has no `.ape/` to write into, and
// creating one here would plant the walk-up marker root resolution keys on
// (resolveProjectRoot) as a side effect of an unrelated successful git probe,
// making a stray `APE idle` box appear on the next render. Same atomic
// discipline as the history-samples cache below (temp + rename, mode 0o600,
// never delete-first, best-effort try/catch), but — unlike that cache, which
// gates its write on an already-existing `.ape/runtime` so it can never plant
// `.ape` — this one needs no such gate because it never touches the project
// tree at all. Written only on a SUCCESSFUL probe, so a genuine non-repo
// never fabricates one.
const branchCachePath = (dir) =>
  join(tmpdir(), `ape-statusline-branch-${createHash('sha256').update(dir).digest('hex')}.json`);
const readCachedBranch = (dir) => {
  try {
    const cached = JSON.parse(readFileSync(branchCachePath(dir), 'utf8'));
    return typeof cached?.branch === 'string' ? cached.branch : '';
  } catch { return ''; }
};
const writeCachedBranch = (dir, branch) => {
  const temp = `${branchCachePath(dir)}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify({ branch }), { mode: 0o600 });
    renameSync(temp, branchCachePath(dir));
  } catch {
    try { rmSync(temp, { force: true }); } catch { /* leaked temp is inert */ }
  }
};
const gitBranch = (dir) => {
  /** @type {import('node:child_process').ExecFileSyncOptionsWithStringEncoding} */
  const bounds = {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, timeout: GIT_TIMEOUT_MS,
  };
  try {
    const ref = execFileSync('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], bounds).trim();
    // Detached HEAD reports the literal "HEAD"; show the short SHA instead so the
    // segment stays informative when not on a named branch.
    const branch = ref === 'HEAD'
      ? execFileSync('git', ['-C', dir, 'rev-parse', '--short', 'HEAD'], bounds).trim()
      : ref;
    writeCachedBranch(dir, branch);
    return branch;
  } catch (err) {
    // A GIT_TIMEOUT_MS kill is indistinguishable from a genuine non-repo by
    // exit code alone; Node marks a timeout kill with `killed`/`signal` (and
    // often `code === 'ETIMEDOUT'`), which a real git failure (plain non-zero
    // exit, no kill) never sets. Only that transient case falls back to the
    // last-known branch — a genuine non-repo still renders no branch.
    if (err?.killed || err?.signal || err?.code === 'ETIMEDOUT') return readCachedBranch(dir);
    return '';
  }
};

// Last-known dirty/ahead/behind markers, persisted per project dir with the
// exact same discipline as the branch cache above (distinct filename, same
// tmpdir()+sha256(dir) keying, atomic temp+rename, mode 0o600, best-effort,
// write-on-success only) — so a transient git spawn timeout on gitStatus
// alone does not zero out markers a prior render already resolved, even
// though the branch segment itself survives via its own cache.
const markersCachePath = (dir) =>
  join(tmpdir(), `ape-statusline-markers-${createHash('sha256').update(dir).digest('hex')}.json`);
const readCachedMarkers = (dir) => {
  try {
    const cached = JSON.parse(readFileSync(markersCachePath(dir), 'utf8'));
    const valid = cached && typeof cached === 'object' &&
      typeof cached.dirty === 'boolean' &&
      Number.isInteger(cached.ahead) && cached.ahead >= 0 &&
      Number.isInteger(cached.behind) && cached.behind >= 0;
    return valid
      ? { dirty: cached.dirty, ahead: cached.ahead, behind: cached.behind }
      : { dirty: false, ahead: 0, behind: 0 };
  } catch { return { dirty: false, ahead: 0, behind: 0 }; }
};
const writeCachedMarkers = (dir, markers) => {
  const temp = `${markersCachePath(dir)}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(markers), { mode: 0o600 });
    renameSync(temp, markersCachePath(dir));
  } catch {
    try { rmSync(temp, { force: true }); } catch { /* leaked temp is inert */ }
  }
};

// Probe of working-tree + remote state. The porcelain branch header
// (`## main...origin/main [ahead N, behind M]`) carries ahead/behind against a
// tracking upstream; any further lines mean the tree is dirty. Same bounds as
// gitBranch; a genuine non-repo/error yields a clean/zeroed result since
// these markers are decorative, but a classified transient timeout (same
// killed/signal/ETIMEDOUT test as gitBranch) falls back to the last-known
// cached markers instead of blinking them off.
const gitStatus = (dir) => {
  const git = (...args) => execFileSync('git', ['-C', dir, ...args],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, timeout: GIT_TIMEOUT_MS });
  try {
    const lines = git('status', '-sb', '--porcelain').split('\n');
    const header = lines[0] || '';
    const dirty = lines.slice(1).some((l) => l.trim().length > 0);
    // With a tracking upstream the header is `## a...b [ahead N, behind M]`, so
    // ahead/behind come straight from it. A branch with NO upstream (a plain
    // `## a` header — e.g. one created locally and never pushed) has no upstream
    // for git to measure "ahead" against, so fall back to counting commits on
    // HEAD that live on no remote-tracking ref: the true unpushed set. Rendered
    // through the same ↑N marker. The fallback is skipped when there are no
    // remote refs at all, since `--not --remotes` would then count every commit.
    let ahead = 0;
    let behind = 0;
    if (header.includes('...')) {
      ahead = Number(header.match(/ahead (\d+)/)?.[1] ?? 0);
      behind = Number(header.match(/behind (\d+)/)?.[1] ?? 0);
    } else if (git('for-each-ref', '--count=1', 'refs/remotes').trim()) {
      ahead = Number(git('rev-list', '--count', 'HEAD', '--not', '--remotes').trim()) || 0;
    }
    const markers = { dirty, ahead, behind };
    writeCachedMarkers(dir, markers);
    return markers;
  } catch (err) {
    // Same classification as gitBranch: only a killed/timed-out spawn is
    // indistinguishable from a genuine non-repo, and only that transient
    // case falls back to the last-known markers.
    if (err?.killed || err?.signal || err?.code === 'ETIMEDOUT') return readCachedMarkers(dir);
    return { dirty: false, ahead: 0, behind: 0 };
  }
};

// Build the ` ● ↑N ↓N` marker suffix for inside the branch segment. Each marker
// is inline-colored (dirty=yellow, ahead=cyan, behind=orange) then returned to
// the branch segment's fg so the powerline background is preserved. A clean,
// up-to-date branch yields ''.
function gitMarkers(g, segFgName) {
  let out = '';
  const mark = (color, text) => { out += ` ${fg(color)}${text}${fg(segFgName)}`; };
  if (g.dirty && G.dirty) mark('yellow', G.dirty);
  if (g.ahead && G.ahead) mark('cyan', `${G.ahead}${g.ahead}`);
  if (g.behind && G.behind) mark('orange', `${G.behind}${g.behind}`);
  return out;
}

// Coarse pipeline milestones per mode/lane, and the current stage's milestone —
// so the bar and N/M reflect how far through the run we are.
function milestones(run) {
  if (run.mode === 'debug') return ['debug'];
  if (run.mode === 'spike') return ['spike'];
  // Mode outranks lane (pipeline.js): a land run is review-only plus gates and
  // merge; its classified lane (fast/full/mechanical) must not paint test or
  // build marks the pipeline never had. Same list as status-doc.js.
  if (run.mode === 'land') return ['review', 'gates', 'merge'];
  if (run.lane === 'mechanical') return ['build'];
  if (run.lane === 'fast') return ['test', 'build', 'review'];
  // Any other lane — 'full' or unrecognized — takes the plan-first FULL
  // pipeline: pipeline.js initialStages falls through to `plan` for every
  // non-mechanical/non-fast lane (the shared scheduler truth), and
  // status-doc.js milestonesFor mirrors this same default arm.
  return ['plan', 'test', 'build', 'review', 'gates', 'merge'];
}
function milestoneOf(stage) {
  if (['dispatch', 'plan', 'plan-replan', 'plan-check', 'plan-critic', 'plan-judge'].includes(stage)) return 'plan';
  // 'remediation-test' is the remediation cycle's optional first stage (roadmap
  // entry remediation-test-path-role-gap). Without this fold the `return stage`
  // fall-through below hands GLOBAL_ORDER an unknown word, indexOf pins the
  // milestone index at 0 and the box renders a raw stage id; status-doc.js
  // STAGE_TO_MILESTONE maps it to 'test' for the same reason.
  if (['test', 'test-reconcile', 'test-recheck', 'remediation-test'].includes(stage)) return 'test';
  if (['build', 'remediation-build'].includes(stage)) return 'build';
  if (['review', 'security-review', 'remediation-review', 'remediation-security-review'].includes(stage)) return 'review';
  if (stage === 'gates') return 'gates';
  return stage; // merge, complete, debug, spike
}
// Stage colour drives the box and the trailing bar. Terminal states win; an
// active run is coloured by its current milestone so the hue tracks progress.
const MILESTONE_COLOR = {
  plan: 'accent', test: 'cyan', build: 'green', review: 'magenta',
  gates: 'yellow', merge: 'green', debug: 'orange', spike: 'cyan',
};
function runColor(run) {
  if (run.status === 'blocked') return 'orange';
  if (run.status === 'aborted') return 'red';
  if (run.status === 'completed') return 'green';
  if (run.status === 'shipping') return 'cyan';
  return MILESTONE_COLOR[milestoneOf(run.stage)] ?? 'green';
}

// Powerline join (nerdfont): bg-colored chevrons. Other charsets: colored-fg
// segments joined by a dim separator.
function joinSegments(segments) {
  if (CHARSET !== 'nerdfont') {
    return segments.map((s) => `${fg(s.fg)}${s.text}${RESET}`).join(`${DIM} · ${RESET}`);
  }
  let out = '';
  segments.forEach((s, i) => {
    out += `${bg(s.bg)}${fg(s.fg)} ${s.text} `;
    const next = segments[i + 1];
    out += next ? `${bg(next.bg)}${fg(s.bg)}${G.sep}` : `${RESET}${fg(s.bg)}${G.sep}${RESET}`;
  });
  return out;
}

function modelText(p) {
  let model = p.model?.display_name ?? p.model?.id ?? '';
  const total = p.context_window?.total_tokens;
  if (model && total > 0) {
    const size = total >= 1_000_000 ? `${Math.floor(total / 1_000_000)}M` : `${Math.floor(total / 1_000)}K`;
    model = `${model} (${size})`;
  }
  return safeDiagnosticText(model, 128) ?? '';
}

// Context-window gauge — the v1 tracker: used %, v1 threshold color ladder.
// Rendered as a trailing metric (coloured text on the terminal background), and
// shown from the first render: before any message the host payload carries no
// `used_percentage`, so treat a missing/non-finite value as 0%.
function contextText(p) {
  const raw = p.context_window?.used_percentage;
  const pct = typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
  const r = Math.round(pct);
  const color = r >= 90 ? 'red' : r >= 75 ? 'orange' : r >= 50 ? 'yellow' : 'green';
  return `${fg(color)}${GAUGE}${r}%${RESET}`;
}

function processExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

const DISPATCH_ARTIFACT_MAX_BYTES = 64 * 1024;
const DISPATCH_HASH = /^[0-9a-f]{64}$/i;
const DISPATCH_NONCE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DISPATCH_TEXT = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

function boundedArtifactJson(file) {
  try {
    const metadata = lstatSync(file);
    if (!metadata.isFile() || metadata.size > DISPATCH_ARTIFACT_MAX_BYTES) return null;
    const bytes = readFileSync(file);
    if (bytes.length > DISPATCH_ARTIFACT_MAX_BYTES) return null;
    const value = JSON.parse(bytes.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return null;
    return value;
  } catch {
    return null;
  }
}

function validLockArtifact(value, run) {
  return value?.version === 1
    && value.run_id === run.run_id
    && typeof value.host === 'string' && value.host.length > 0 && value.host.length <= 255
    && Number.isSafeInteger(value.pid) && value.pid > 0
    && strictIsoMs(value.acquired_at) !== null
    && DISPATCH_NONCE.test(value.nonce ?? '');
}

function validIntentArtifact(value, run, ticketId, now) {
  if (value?.version !== 2 || value.host !== run.host || value.run_id !== run.run_id
    || value.ticket_id !== ticketId || value.status !== 'bound') return false;
  const bindingHash = run.host === 'codex' ? value.launch_name_hash : value.nonce_hash;
  if (!DISPATCH_HASH.test(value.ticket_hash ?? '') || !DISPATCH_HASH.test(bindingHash ?? '')
    || !DISPATCH_HASH.test(value.capability_hash ?? '') || !DISPATCH_TEXT.test(value.agent_type ?? '')) return false;
  if (!Number.isSafeInteger(value.launch_attempts) || value.launch_attempts < 0) return false;
  for (const key of ['prepared_at', 'expires_at', 'launched_at', 'launch_expires_at', 'bound_at']) {
    if (strictIsoMs(value[key]) === null) return false;
  }
  if (value.agent_stopped_at !== undefined && strictIsoMs(value.agent_stopped_at) === null) return false;
  const expiresAt = strictIsoMs(value.expires_at);
  return expiresAt !== null && expiresAt > now;
}

function statuslineDispatchState(dir, run) {
  if (!run) return 'none';
  if (['pending', 'needs-redispatch', 'live', 'stopped'].includes(run?.dispatch_state)) {
    return run.dispatch_state;
  }
  const tickets = Array.isArray(run.tickets) ? run.tickets : [];
  const receipts = Array.isArray(run.receipts) ? run.receipts : [];
  const expired = new Set(Array.isArray(run.expired_tickets) ? run.expired_tickets : []);
  const receipted = new Set(receipts.map((receipt) => receipt?.ticket_id));
  const pending = tickets
    .map((ticket) => ticket?.ticket_id)
    .filter((ticketId) => typeof ticketId === 'string' && !receipted.has(ticketId) && !expired.has(ticketId));
  if (pending.length === 0) return 'none';
  if (!['claude', 'codex'].includes(run.host)) return 'pending';

  const lock = boundedArtifactJson(join(dir, '.ape', 'runtime', 'active.lock'));
  if (!validLockArtifact(lock, run) || (lock.host === hostname() && !processExists(lock.pid))) return 'pending';

  const intentsDir = join(dir, '.ape', 'runtime', 'dispatch-intents');
  const now = Date.now();
  let stopped = false;
  const live = pending.every((ticketId) => {
    const name = `${createHash('sha256').update(ticketId).digest('hex')}.json`;
    const intent = boundedArtifactJson(join(intentsDir, name));
    if (!validIntentArtifact(intent, run, ticketId, now)) return false;
    if (intent.agent_stopped_at) stopped = true;
    return !intent.agent_stopped_at;
  });
  return live ? 'live' : stopped ? 'stopped' : 'pending';
}

function diagnosticText(dir, run) {
  const diagnostic = projectRunDiagnostic(run, {
    corrupt: activeStateCorrupt,
    dispatchState: statuslineDispatchState(dir, run),
  });
  const failed = diagnostic.failed_checks.length > 0
    ? ` [${diagnostic.failed_checks.join(',')}]`
    : '';
  return `${diagnostic.reason_code} · ${diagnostic.next_safe_action}${failed}`;
}

// The run renders as TWO powerline boxes: a static `APE <mode>/<lane>`
// identity box in a fixed neutral gray (constant for the whole run), and a
// stage box carrying the milestone word with ALL the colour change — the hue
// tracks the milestone while running and the status when terminal. The strip
// owns the per-stage glyphs, so the boxes carry no stage icon; only status
// marks remain (a check at completion, the warning when blocked). No loading
// glyph: the coloured stage box plus the strip already read as "in progress",
// and the host cannot animate a spinner anyway. Gray never collides with any
// milestone/status colour, so the two boxes always render as distinct blocks.
// In an APE project with no active run, the identity box stays put and reads
// `APE idle` — the runtime is wired, just dormant. Outside APE projects (no
// `.ape/` ancestor) no APE box renders at all, keeping the global wiring safe.
function apeSegments(run) {
  const idFg = CHARSET === 'nerdfont' ? 'bg' : 'magenta';
  if (!run) return [{ text: 'APE idle', fg: idFg, bg: 'gray' }];
  const identity = {
    text: `APE ${safeDiagnosticText(run.mode, 32) ?? '?'}/${safeDiagnosticText(run.lane, 32) ?? '?'}`,
    fg: idFg, bg: 'gray',
  };
  const color = runColor(run);
  const mark = run.status === 'blocked' ? G.block : run.status === 'completed' ? G.check : '';
  const baseLabel = run.status === 'blocked' ? 'BLOCK'
    : run.status === 'aborted' ? 'ABORT'
      : safeDiagnosticText(milestoneOf(run.stage), 64) ?? 'unknown';
  const routeLabel = run.remediation_route?.route === 'test-production'
    ? 'test→build'
    : safeDiagnosticText(run.remediation_route?.route, 64);
  const label = routeLabel && run.stage?.startsWith('remediation-')
    ? `${baseLabel} ${routeLabel}`
    : baseLabel;
  const stage = {
    text: `${mark ? `${mark} ` : ''}${label}`,
    fg: CHARSET === 'nerdfont' ? 'bg' : color, bg: color,
  };
  return [identity, stage];
}

// Trailing run metrics: a stage-initials strip plus a time-calibrated progress
// bar — set off from the powerline blocks so they read high-contrast on the
// terminal background instead of dark-on-colour. No spinner: animation here
// must derive from the wall clock, not a frame counter, because the render is
// stateless and the host's re-invocation cadence is config-dependent (the
// wired refreshInterval timer, or only conversation-update debounces without
// it) — a frame-based spinner would stutter or freeze, while the wall-clock
// stage-mark pulse below degrades to a static mark. No pending-ticket marker
// (that count lives in the human-readable status.md projection).
// Global pipeline order (mirrors status-doc.js GLOBAL_ORDER), so progress stays
// honest when the scheduler drives a run into a stage outside its lane's
// displayed milestone list — a fast or mechanical run at gates/merge.
const GLOBAL_ORDER = ['plan', 'test', 'build', 'review', 'gates', 'merge', 'debug', 'spike'];

// Where the run sits in its displayed milestone list. `idx === list.length`
// means every displayed milestone ranks behind the current stage (a fast or
// mechanical run at gates/merge): the strip reads all-done and the bar pins
// full.
function milestoneIndex(run) {
  const list = milestones(run);
  const milestone = milestoneOf(run.stage);
  let idx = list.indexOf(milestone);
  if (idx < 0) {
    const rank = GLOBAL_ORDER.indexOf(milestone);
    idx = rank < 0 ? 0 : list.filter((m) => GLOBAL_ORDER.indexOf(m) < rank).length;
  }
  return { list, idx };
}

// Per-milestone marks for the stage strip. Nerdfont gets a representative
// glyph per stage — pencil/flask/wrench/eye/shield, rocket for merge (the
// FA code-fork reads identical to the branch segment's git-branch), bug for
// debug, lightbulb for spike — all Font-Awesome-range codepoints, stable
// across nerd-font versions. Unicode/ascii fall back to the milestone
// initial (P T B R G M), which needs no font support.
const MILESTONE_GLYPH_HEX = {
  plan: 'f040', test: 'f0c3', build: 'f0ad', review: 'f06e',
  gates: 'f132', merge: 'f135', debug: 'f188', spike: 'f0eb',
};
const milestoneMark = (m) =>
  CHARSET === 'nerdfont' && MILESTONE_GLYPH_HEX[m] ? nf(MILESTONE_GLYPH_HEX[m]) : m[0].toUpperCase();

// The stage strip: one mark per displayed milestone, colored by fact — done
// milestones green, the current one in its own milestone colour, pending ones in the track colour.
// This is the discrete, honest progress readout; the bar beside it adds motion.
//
// A TERMINAL run (blocked or aborted) drops that split entirely and paints
// EVERY mark in the state colour — orange blocked, red aborted. The uniform
// strip IS the state signal, and it replaced the truncated reason text the
// line used to trail; the full reason lives in `ape_run action: status` (and,
// for a block, in `.ape/runtime/status.md`). Two consequences, both intended:
// a uniform strip asserts no done/current boundary, which is exactly what lets
// an ABORTED run carry a strip at all — its sealed stage is the literal
// 'aborted' and maps to no milestone, so the list comes from milestones(run)
// alone, never milestoneIndex(run), whose GLOBAL_ORDER fallback would pin a
// meaningless idx 0; and a BLOCKED strip therefore shows no per-milestone
// position either, leaving the frozen bar's fill as the only position signal.
// Each mark re-states the colour, so no reset can land between two marks and
// leave one uncoloured.
//
// The current mark "breathes" dim → normal → bold across successive
// refreshes: the render is stateless, so the frame derives from elapsed time
// in the current milestone (currentMilestoneElapsedMs below), never the raw
// wall clock alone — a raw `Date.now()` bucket ties the visible phase to
// WHICH absolute second a render happens to land on, which is exactly what
// made two regenerations of docs/assets/statusline/running.svg (the
// generator drives this same renderer against a fixed fixture run) differ
// with zero renderer change (roadmap entry support-tooling-answers-honestly,
// absorbing statusline-gallery-regeneration-unsafe, defect B). Elapsed time
// still advances every real second during a live render, so the breathing
// motion is unchanged for a live statusline. One-second buckets step cleanly
// at the host's timer-driven refreshInterval (min 1s) AND at its ~300ms
// event-driven debounce — a finer bucket would skip phases whenever only the
// 1s timer is firing. A terminal run never reaches the pulse at all: nothing
// is moving.
function stageStrip(run) {
  if (run.status === 'blocked' || run.status === 'aborted') {
    const state = runColor(run);
    return milestones(run).map((m) => `${fg(state)}${milestoneMark(m)}`).join(' ') + RESET;
  }
  const { list, idx } = milestoneIndex(run);
  const done = run.status === 'completed' ? list.length : idx;
  const pulse = [DIM, '', BOLD, ''][Math.floor(currentMilestoneElapsedMs(run) / 1000) % 4];
  return list.map((m, i) => {
    const ch = milestoneMark(m);
    if (i < done) return `${fg('green')}${ch}`;
    if (i === idx && run.status !== 'completed') return `${pulse}${fg(MILESTONE_COLOR[m] ?? 'cyan')}${ch}${RESET}`;
    return `${fg('track')}${ch}`;
  }).join(' ') + RESET;
}

// Fallback per-milestone medians (seconds) when the project's history has no
// timing samples yet. Only the creep rate of the estimate depends on these.
const DEFAULT_MEDIAN_S = {
  plan: 300, test: 300, build: 480, review: 300,
  gates: 120, merge: 60, debug: 480, spike: 480,
};

function collectReceiptTimings(samples, receipts) {
  for (const r of receipts ?? []) {
    const stage = String(r.ticket_id ?? '').split(':')[1] ?? '';
    const s = Date.parse(r.timing?.started_at);
    const e = Date.parse(r.timing?.completed_at);
    if (!stage || !Number.isFinite(s) || !Number.isFinite(e) || e <= s) continue;
    (samples[milestoneOf(stage)] ??= []).push((e - s) / 1000);
  }
}

// The history-derived samples cache. The render fires every second while
// wired, and re-JSON.parsing 20 full history records (each embedding complete
// tickets[] and receipts[]) per render is pure waste: records are immutable
// and supersession only ADDS files, so the parsed samples change exactly when
// the directory listing does. The key captures that listing — file count,
// newest name, newest mtime — so staleness is bounded at one render. The
// cache is advisory, atomic (temp + rename, never delete-first), disposable,
// and .ape-scoped; on ANY read/shape/write failure the render silently falls
// back to a fresh parse. Only sample arrays of finite positive numbers are
// trusted from disk — a corrupt cache must never leak NaN into the bar math.
const STATUSLINE_CACHE_VERSION = 1;
const cachePath = (dir) => join(dir, '.ape', 'runtime', 'statusline-cache.json');

function validCachedSamples(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.values(value).every((arr) =>
      Array.isArray(arr) && arr.every((n) => typeof n === 'number' && Number.isFinite(n) && n > 0));
}

// Per-milestone duration samples (seconds) from the newest history records.
// Never throws; {} when there is no history. Writes the cache only after a
// successful directory read, so it can never plant `.ape` (the project-root
// walk-up marker) in a non-APE directory.
function historySamples(dir) {
  const samples = {};
  try {
    const hist = join(dir, '.ape', 'runtime', 'history');
    // History filenames embed a sortable timestamp, so a lexical sort is
    // chronological and slice(-20) keeps the most recent records.
    const files = readdirSync(hist).filter((n) => n.endsWith('.json')).sort();
    const newest = files.at(-1) ?? null;
    let newestMtime = 0;
    if (newest) { try { newestMtime = statSync(join(hist, newest)).mtimeMs; } catch { /* key stays 0 */ } }
    const key = { count: files.length, newest, newest_mtime_ms: newestMtime };
    try {
      const cached = JSON.parse(readFileSync(cachePath(dir), 'utf8'));
      if (
        cached?.version === STATUSLINE_CACHE_VERSION &&
        JSON.stringify(cached.key) === JSON.stringify(key) &&
        validCachedSamples(cached.samples)
      ) {
        return cached.samples;
      }
    } catch { /* absent or corrupt cache: fall through to a fresh parse */ }
    for (const f of files.slice(-20)) {
      try { collectReceiptTimings(samples, JSON.parse(readFileSync(join(hist, f), 'utf8')).receipts); } catch { /* skip */ }
    }
    const temp = `${cachePath(dir)}.${process.pid}.tmp`;
    try {
      writeFileSync(temp, JSON.stringify({ version: STATUSLINE_CACHE_VERSION, key, samples }), { mode: 0o600 });
      renameSync(temp, cachePath(dir));
    } catch {
      try { rmSync(temp, { force: true }); } catch { /* leaked temp is inert */ }
    }
  } catch { /* no history yet */ }
  return samples;
}

// Median per-milestone stage duration (seconds), measured from receipt
// timings — the completed-run records in .ape/runtime/history (cached above)
// plus the active run's own receipts, merged per render so a live receipt
// calibrates immediately. Any failure yields {} and DEFAULT_MEDIAN_S takes
// over (the estimate is decorative).
function medianDurations(dir, run) {
  // Copy the cached arrays: the live-run merge and the sort below must never
  // mutate what historySamples returned (it may be written to the cache by a
  // future refactor, and shared references rot silently).
  const samples = Object.fromEntries(
    Object.entries(historySamples(dir)).map(([m, arr]) => [m, [...arr]]),
  );
  collectReceiptTimings(samples, run.receipts);
  return Object.fromEntries(Object.entries(samples).map(([m, arr]) => {
    arr.sort((a, b) => a - b);
    return [m, arr[Math.floor(arr.length / 2)]];
  }));
}

// When the run ENTERED its current milestone. One milestone spans several
// stages (plan → plan-check → plan-critic → plan-judge all map to 'plan'),
// and the runtime bumps updated_at at every persisted transition — so
// anchoring the bar's creep at updated_at made it visibly retreat each time
// a sub-stage PASSED inside one milestone. The honest slice anchor is the
// earliest receipt started_at within the current milestone (evidence the
// milestone's first stage was already under way); with no such receipt yet,
// updated_at (the entry into the milestone's first stage) is correct.
function milestoneEnteredMs(run, milestone) {
  let earliest = Number.POSITIVE_INFINITY;
  for (const r of run.receipts ?? []) {
    const stage = String(r?.ticket_id ?? '').split(':')[1] ?? '';
    if (milestoneOf(stage) !== milestone) continue;
    const s = Date.parse(r?.timing?.started_at);
    if (Number.isFinite(s) && s < earliest) earliest = s;
  }
  return earliest;
}

// The "now" the elapsed-time math below measures against: the real wall
// clock, UNLESS the statusline SVG generator (scripts/render-statusline-
// svg.mjs) has injected one via APE_STATUSLINE_NOW_MS. The generator computes
// ONE instant, uses it to seed its own `minsAgo`-relative fixtures, and
// passes that SAME instant to every renderer child it spawns -- so a real
// `npm run statusline:svg` regeneration measures elapsed time against the
// exact instant its own fixture was anchored to, rather than this process's
// own independent Date.now() read racing the generator's earlier one (roadmap
// entry support-tooling-answers-honestly, absorbing statusline-gallery-
// regeneration-unsafe, defect B: real generator-to-render latency used to
// leak into running.svg's rendered bytes). A live statusline render never
// sets this var, so it is always the untouched wall clock there.
function nowMs() {
  return envFiniteMs('APE_STATUSLINE_NOW_MS', { fallback: Date.now() });
}

// Milliseconds elapsed since the run entered its CURRENT milestone — the one
// relative "now" shared by the stage-mark pulse (stageStrip above) and the
// progress bar's asymptotic creep (runBar below), so neither reads the
// absolute wall clock on its own. Deliberately a DIFFERENCE (now minus the
// absolute entry instant baked into the run's own timestamps via
// milestoneEnteredMs/updated_at), never a raw Date.now() value alone: a raw
// absolute read leaks whatever real instant a render happens to run at into
// the rendered bytes. This difference still grows every real second during a
// live render, so both the pulse and the bar keep moving exactly as before;
// it simply no longer matters WHICH absolute second the render lands on.
function currentMilestoneElapsedMs(run) {
  const milestone = milestoneOf(run.stage);
  const updated = Date.parse(run.updated_at);
  const entered = Math.min(
    milestoneEnteredMs(run, milestone),
    Number.isFinite(updated) ? updated : Number.POSITIVE_INFINITY,
  );
  return Number.isFinite(entered) ? Math.max(0, nowMs() - entered) : 0;
}

// The time-calibrated bar. Completed milestones fill their 1/N slice solid
// (fact); the current milestone's slice fills asymptotically with time spent
// in the milestone — `1 - 0.5^(elapsed/median)` halves the remaining slice
// every median interval, capped at 95%, so the bar visibly creeps between the
// discrete stage transitions but never claims a boundary it hasn't crossed.
// Elapsed time is now − the milestone entry (currentMilestoneElapsedMs
// above), so the creep is monotonic across sub-stage transitions within a
// milestone. A blocked run freezes the estimate at the slice start — nothing
// is progressing.
function runBar(run, medians) {
  const { list, idx } = milestoneIndex(run);
  const total = list.length;
  if (activeStateCorrupt) return smoothBar(100 / Math.max(1, total), 8, 'orange', 'track');
  // A running bar stays neutral (the palette fg, a soft white) — the strip and
  // the stage box already carry the milestone hue. Status states keep colour
  // as their signal: yellow blocked, green completed, cyan shipping. (Aborted
  // never reaches here — main() drops the bar for a sealed abort; only the
  // strip renders there, uniformly red.)
  const color = ['blocked', 'completed', 'shipping'].includes(run.status)
    ? runColor(run) : 'fg';
  let fill = 1;
  if (run.status !== 'completed' && idx < total) {
    const milestone = milestoneOf(run.stage);
    const elapsed = currentMilestoneElapsedMs(run) / 1000;
    const median = medians[milestone] ?? DEFAULT_MEDIAN_S[milestone] ?? 300;
    const intra = run.status === 'blocked' ? 0 : Math.min(0.95, 1 - 0.5 ** (elapsed / median));
    fill = (idx + intra) / total;
  }

  // No reason text trails the bar: a real block_reason is a full sentence, and
  // the 56-char slice this used to append cut mid-word and pushed the context
  // gauge off a narrow terminal. The yellow strip beside it carries the state.
  return smoothBar(fill * 100, 8, color, 'track');
}

function main() {
  const p = parse(readStdin());
  const dir = projectDir(p);
  const run = readActive(dir);
  const apeProject = run || existsSync(join(dir, '.ape'));
  const base = safeDiagnosticText(dir.split(/[\\/]/).filter(Boolean).slice(-2).join('/') || dir, 128) ?? 'workspace';
  const branch = apeProject ? '' : (safeDiagnosticText(gitBranch(dir), 128) ?? '');

  // Each segment gets a DISTINCT background so the powerline chevrons render as
  // separate boxes; no two adjacent segments may share a bg.
  const segs = [];
  const model = modelText(p);
  if (model) segs.push({ text: `${G.model ? `${G.model} ` : ''}${model}`, fg: CHARSET === 'nerdfont' ? 'bg' : 'gray', bg: 'accent' });
  if (!apeProject) segs.push({ text: `${G.folder ? `${G.folder} ` : ''}${base}`, fg: 'cyan', bg: 'panel' });
  if (branch) {
    const markers = gitMarkers(gitStatus(dir), 'green');
    segs.push({ text: `${G.branch ? `${G.branch} ` : ''}${branch}${markers}`, fg: 'green', bg: 's2' });
  }
  // The APE identity + stage boxes are the last powerline blocks. The strip,
  // the pipeline bar and the context gauge trail as plain metrics (after a
  // gap) so they read on the terminal background — the v1 separation the
  // fused v2 box had collapsed.
  if (apeProject) segs.push(...apeSegments(run));

  const trailing = [];
  if (apeProject) trailing.push(diagnosticText(dir, run));
  if (run && run.status === 'aborted') {
    // A sealed abort records stage: 'aborted', so nothing here may anchor to a
    // milestone. The strip does not need to: stageStrip's terminal arm derives
    // its marks from milestones(run) — the mode/lane list alone — and paints
    // them uniformly red, asserting no done/current boundary and so fabricating
    // no position. The BAR stays dropped, because a fill fraction WOULD claim
    // one, and its elapsed-time estimate would keep creeping on a dead run.
    // Dropping it also keeps medianDurations — and its statusline-cache write —
    // off the dead-run path. The abort reason renders nowhere on this line.
    trailing.push(stageStrip(run));
  } else if (run) {
    trailing.push(stageStrip(run), runBar(run, medianDurations(dir, run)));
  }
  trailing.push(contextText(p));

  const rendered = renderLine(segs, trailing);
  process.stdout.write(rendered.length < 1024 ? rendered : `${rendered.slice(0, 1019)}${RESET}`);
}

// Powerline blocks, then (after a gap) the trailing metrics joined by a dim
// separator. In unicode/ascii everything is one dim-separated list.
function renderLine(segs, trailing) {
  const left = joinSegments(segs);
  if (!trailing.length) return left;
  const joined = trailing.join(`${DIM} · ${RESET}`);
  if (!left) return joined;
  return CHARSET === 'nerdfont' ? `${left}  ${joined}` : `${left}${DIM} · ${RESET}${joined}`;
}

main();
