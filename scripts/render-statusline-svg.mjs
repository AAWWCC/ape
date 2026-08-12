#!/usr/bin/env node
/**
 * Renders the docs' statusline gallery: runs the REAL renderer
 * (bin/ape-statusline.mjs, nerdfont + truecolor) against synthetic run states
 * in throwaway git repos, then converts the captured ANSI to self-contained
 * SVGs in docs/assets/statusline/. Regenerate after any visual change:
 *
 *   npm run statusline:svg
 *
 * The SVGs embed no fonts: powerline chevrons, nerdfont icons, and bar block
 * cells are drawn as vector shapes, and everything else is plain ASCII on the
 * viewer's monospace stack — so the images render faithfully for readers
 * without a patched font.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RENDERER = join(ROOT, 'bin', 'ape-statusline.mjs');
const OUT_DIR = join(ROOT, 'docs', 'assets', 'statusline');

// ---------------------------------------------------------------------------
// Synthetic states — one throwaway project per image, on branch main with the
// .ape/ state gitignored so the branch segment renders clean.
// ---------------------------------------------------------------------------

// Env ALLOWLIST shared by every child process this generator spawns -- the
// fixture-creation git() calls below AND renderAnsi()'s renderer child
// (roadmap entry outside-input-coerced-not-refused-and-ambient-env-denylist,
// item C). Before this, git() passed no env override at all (full ambient
// inheritance) and renderAnsi() spread `{ ...process.env }` minus two deleted
// names -- both a DENYLIST shape, where a new ambient variable is admitted by
// default. An ambient GIT_DIR/GIT_WORK_TREE/GIT_CONFIG_GLOBAL -- set by a git
// hook, `git rebase --exec`, or wrapper tooling on a maintainer's own machine
// -- would silently redirect both the fixture-creation git() calls and the
// renderer's own gitBranch/gitStatus probes onto that ambient repository
// instead of the throwaway fixture. An allowlist is the only construction
// where such a variable is excluded by default rather than included by
// default.
//
// PATH is required to spawn `git`/`node` at all. HOME and GIT_CONFIG_GLOBAL
// are pinned to an explicit, inert scratch value rather than ever passed
// through from the ambient environment: git still consults them for
// init.templateDir/hooks even though makeProject already passes
// -c user.email/user.name per commit for identity, so an ambient
// ~/.gitconfig or GIT_CONFIG_GLOBAL naming a templateDir could otherwise
// plant hooks or config into every throwaway fixture repo this generator
// creates. GIT_CONFIG_NOSYSTEM (security review, non-blocking hardening
// note) closes the one config layer HOME/GIT_CONFIG_GLOBAL cannot: a
// SYSTEM-level `/etc/gitconfig` (or platform equivalent) naming
// init.templateDir or core.hooksPath still applies to every git invocation
// below regardless of HOME, since git consults it independently of the
// per-user config file. Setting it to '1' (git's own documented spelling for
// "skip the system config") pins the third and last config layer this
// generator's own git() and renderAnsi() calls could otherwise inherit.
//
// NODE_OPTIONS is NOT allowlisted. An earlier revision kept it admitted on
// the recorded rationale that the gallery suite's clock-pinning `--require`
// preload (__tests__/runtime-v2-statusline-gallery.test.js, DEFECT B) needed
// it forwarded to the renderer CHILD this file spawns -- that rationale was
// FALSE: the preload the suite actually uses bakes its pinned instant
// directly into the preload's own source TEXT (no env-var name in between),
// and renderAnsi() below already forwards this generator's own computed
// NOW_MS to the renderer child unconditionally via an explicit
// APE_STATUSLINE_NOW_MS override, so the renderer child never needed
// NODE_OPTIONS at all. Keeping it admitted bought nothing and re-opened
// ambient arbitrary-code injection into every spawned node child, inside the
// very change whose thesis is that a denylist is unsound for exactly this
// reason. The suite's one arm that genuinely needs to control a renderer's
// own Date.now() (the latency dimension) drives bin/ape-statusline.mjs
// directly, with no childEnv() allowlist in between, so this file's own
// child spawns never need to carry NODE_OPTIONS at all.
const CHILD_ENV_ALLOWLIST = ['PATH'];
const INERT_HOME = mkdtempSync(join(tmpdir(), 'ape-statusline-svg-home-'));

function childEnv(overrides = {}) {
  const env = {};
  for (const name of CHILD_ENV_ALLOWLIST) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  env.HOME = INERT_HOME;
  env.GIT_CONFIG_GLOBAL = join(INERT_HOME, '.no-such-gitconfig');
  env.GIT_CONFIG_NOSYSTEM = '1';
  return { ...env, ...overrides };
}

const git = (dir, ...args) =>
  execFileSync('git', ['-C', dir, ...args], { stdio: ['ignore', 'pipe', 'ignore'], env: childEnv() });

function makeProject(run, { dirty = false } = {}) {
  // basename pair "apps/ape" — the renderer shows the last two path segments.
  const scratch = mkdtempSync(join(tmpdir(), 'ape-statusline-svg-'));
  const dir = join(scratch, 'apps', 'ape');
  mkdirSync(join(dir, '.ape', 'runtime'), { recursive: true });
  writeFileSync(join(dir, '.gitignore'), '.ape/\n');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, '-c', 'user.email=a@b.c', '-c', 'user.name=ape', 'commit', '-q', '--allow-empty', '-m', 'x');
  git(dir, 'add', '.gitignore');
  git(dir, '-c', 'user.email=a@b.c', '-c', 'user.name=ape', 'commit', '-q', '-m', 'ignore ape state');
  if (dirty) writeFileSync(join(dir, 'wip.txt'), 'wip\n');
  if (run) writeFileSync(join(dir, '.ape', 'runtime', 'active.json'), JSON.stringify(run));
  return { dir, scratch };
}

// One instant, captured ONCE here at module load and threaded through both
// this generator's own `minsAgo` fixture anchors AND every renderer child
// renderAnsi spawns below (as APE_STATUSLINE_NOW_MS, consulted by
// bin/ape-statusline.mjs's currentMilestoneElapsedMs in place of its own
// Date.now() read). Without this, the fixture's `updated_at` and the
// renderer's elapsed-time math were each independently read off the wall
// clock in two separate processes, so a real `npm run statusline:svg`
// regeneration's running.svg embedded the real, unpredictable latency
// between generator start and the running-state render (roadmap entry
// support-tooling-answers-honestly, absorbing statusline-gallery-
// regeneration-unsafe, defect B).
const NOW_MS = Date.now();

function renderAnsi(dir, usedPct) {
  // childEnv() is an ALLOWLIST (see above), so the ambient project-root hints
  // resolveGovernedRoot ranks ABOVE the payload's own workspace.current_dir
  // (lib/runtime/paths.js) -- CLAUDE_PROJECT_DIR, CODEX_CWD -- are excluded by
  // construction rather than needing an explicit scrub here. Left admitted, a
  // maintainer running this generator from inside a live Claude Code or Codex
  // session (where one or both are normally set) would have every
  // regenerated SVG, and the renderer's own
  // `.ape/runtime/statusline-cache.json` write, resolve to that live,
  // unrelated project instead of this throwaway fixture (roadmap entry
  // support-tooling-answers-honestly, absorbing statusline-gallery-
  // regeneration-unsafe, defect A).
  return execFileSync('node', [RENDERER], {
    input: JSON.stringify({
      model: { display_name: 'Fable 5' },
      workspace: { current_dir: dir },
      context_window: { used_percentage: usedPct },
    }),
    encoding: 'utf8',
    env: childEnv({
      APE_STATUSLINE_CHARSET: 'nerdfont',
      COLORTERM: 'truecolor',
      APE_STATUSLINE_GIT_TIMEOUT_MS: '5000',
      APE_STATUSLINE_NOW_MS: String(NOW_MS),
    }),
  });
}

const minsAgo = (m) => new Date(NOW_MS - m * 60_000).toISOString();
const base = { mode: 'phase', lane: 'full', tickets: [], receipts: [] };

const STATES = [
  { name: 'idle', usedPct: 8, run: null },
  {
    name: 'running', usedPct: 42, dirty: true,
    run: { ...base, status: 'running', stage: 'build', updated_at: minsAgo(5) },
  },
  {
    name: 'blocked', usedPct: 63,
    run: {
      ...base, status: 'blocked', stage: 'build', updated_at: minsAgo(11),
      block_reason: 'stage build failed twice',
    },
  },
  {
    name: 'completed', usedPct: 71,
    run: { ...base, status: 'completed', stage: 'complete', updated_at: minsAgo(2) },
  },
  {
    name: 'aborted', usedPct: 54,
    run: {
      ...base, status: 'aborted', stage: 'aborted', updated_at: minsAgo(30),
      abort_reason: 'operator override: wrong ticket',
    },
  },
];

// ---------------------------------------------------------------------------
// ANSI → styled cells. The renderer emits SGR only: 0 reset, 1 bold, 2 dim,
// 38;2;r;g;b fg, 48;2;r;g;b bg (COLORTERM=truecolor pins the 24-bit forms).
// ---------------------------------------------------------------------------

const DEFAULT_FG = '#c0caf5';

function parseAnsi(text) {
  const cells = [];
  let fg = DEFAULT_FG; let bg = null; let bold = false; let dim = false;
  const re = /\x1b\[([0-9;]*)m/g;
  let last = 0; let m;
  const emit = (chunk) => {
    for (const ch of chunk) cells.push({ ch, fg, bg, bold, dim });
  };
  while ((m = re.exec(text))) {
    emit(text.slice(last, m.index));
    last = re.lastIndex;
    const p = m[1] === '' ? [0] : m[1].split(';').map(Number);
    for (let i = 0; i < p.length; i++) {
      if (p[i] === 0) { fg = DEFAULT_FG; bg = null; bold = false; dim = false; }
      else if (p[i] === 1) bold = true;
      else if (p[i] === 2) dim = true;
      else if (p[i] === 38 && p[i + 1] === 2) { fg = `rgb(${p[i + 2]},${p[i + 3]},${p[i + 4]})`; i += 4; }
      else if (p[i] === 48 && p[i + 1] === 2) { bg = `rgb(${p[i + 2]},${p[i + 3]},${p[i + 4]})`; i += 4; }
    }
  }
  emit(text.slice(last));
  while (cells.length && cells[cells.length - 1].ch === '\n') cells.pop();
  return cells;
}

// ---------------------------------------------------------------------------
// Vector stand-ins for every non-ASCII glyph the nerdfont tier emits, drawn in
// a 16×16 box (fill/stroke = the cell's fg). Keeps the SVGs font-independent.
// ---------------------------------------------------------------------------

const S = (d, w = 1.6) => ({ stroke: d, w });
const F = (d) => ({ fill: d });
const nf = (cp) => String.fromCodePoint(cp);
const SEP = nf(0xe0b0); // powerline chevron

const ICONS = {
  [nf(0xf2db)]: [ // cpu chip (model)
    S('M5.1 0.8 V3.2 M8 0.8 V3.2 M10.9 0.8 V3.2 M5.1 12.8 V15.2 M8 12.8 V15.2 M10.9 12.8 V15.2 M0.8 5.1 H3.2 M0.8 8 H3.2 M0.8 10.9 H3.2 M12.8 5.1 H15.2 M12.8 8 H15.2 M12.8 10.9 H15.2', 1.3),
    S('M4.6 3.4 h6.8 a1.2 1.2 0 0 1 1.2 1.2 v6.8 a1.2 1.2 0 0 1 -1.2 1.2 H4.6 a1.2 1.2 0 0 1 -1.2 -1.2 V4.6 a1.2 1.2 0 0 1 1.2 -1.2 Z'),
    F('M6.3 6.3 h3.4 v3.4 h-3.4 Z'),
  ],
  [nf(0xf07b)]: [F('M1.2 3.6 h4.6 l1.6 2 h7.4 a1 1 0 0 1 1 1 v5.8 a1 1 0 0 1 -1 1 H2.2 a1 1 0 0 1 -1 -1 V4.6 a1 1 0 0 1 1 -1 Z')], // folder
  [nf(0xf418)]: [ // git branch
    S('M4.2 5.6 V10.4', 1.7),
    S('M11.8 7.4 C11.8 9.8 8.4 9.6 5.4 11.1', 1.7),
    S('M4.2 5.5 a1.9 1.9 0 1 1 0.001 0 Z M4.2 14.3 a1.9 1.9 0 1 1 0.001 0 Z M11.8 7.3 a1.9 1.9 0 1 1 0.001 0 Z', 1.5),
  ],
  [nf(0xf0e4)]: [ // gauge / dashboard (context)
    S('M2.1 12.2 A6.4 6.4 0 1 1 13.9 12.2', 1.7),
    S('M8 10.6 L11.6 5.8', 1.5),
    F('M8 10.6 a1.3 1.3 0 1 1 0.001 0 Z'),
  ],
  [nf(0xf071)]: [ // warning triangle (blocked)
    F('M8 1.6 a1.4 1.4 0 0 1 1.2 0.7 l6 10.4 a1.4 1.4 0 0 1 -1.2 2.1 H2 a1.4 1.4 0 0 1 -1.2 -2.1 l6 -10.4 A1.4 1.4 0 0 1 8 1.6 Z'),
    { fill: 'M7.2 5.6 h1.6 v4.2 h-1.6 Z M7.2 11.2 h1.6 v1.6 h-1.6 Z', hole: true },
  ],
  [nf(0xf00c)]: [S('M2.4 8.8 L6.2 12.6 L13.6 3.8', 2.3)], // check
  [nf(0xf040)]: [F('M2 14 l0.7 -3 L10.6 3.1 a1.3 1.3 0 0 1 1.8 0 l1.5 1.5 a1.3 1.3 0 0 1 0 1.8 L6 14.3 l-3 0.7 A0.8 0.8 0 0 1 2 14 Z')], // pencil (plan)
  [nf(0xf0c3)]: [S('M6.5 1.6 h3 M6.9 1.8 V6.2 L2.8 12.9 a1.6 1.6 0 0 0 1.4 2.4 h7.6 a1.6 1.6 0 0 0 1.4 -2.4 L9.1 6.2 V1.8', 1.6)], // flask (test)
  [nf(0xf0ad)]: [F('M14.9 4.3 a4.2 4.2 0 0 1 -5.6 5 L4.9 13.7 a2 2 0 0 1 -2.8 -2.8 L6.5 6.5 a4.2 4.2 0 0 1 5.2 -5.4 L9.2 3.6 l2.9 2.9 2.5 -2.5 A4.2 4.2 0 0 1 14.9 4.3 Z')], // wrench (build)
  [nf(0xf06e)]: [S('M1.4 8 C3 4.8 5.4 3.2 8 3.2 s5 1.6 6.6 4.8 C13 11.2 10.6 12.8 8 12.8 S3 11.2 1.4 8 Z', 1.5), F('M8 8 m-2 0 a2 2 0 1 0 4 0 a2 2 0 1 0 -4 0')], // eye (review)
  [nf(0xf132)]: [F('M8 1.2 L14.2 3.4 V7.8 c0 3.8 -2.7 6.2 -6.2 7.4 C4.5 14 1.8 11.6 1.8 7.8 V3.4 Z')], // shield (gates)
  [nf(0xf135)]: [F('M8 0.8 C9.9 2.5 10.5 5.2 10.5 7.6 V9.2 L12.6 11.9 L9.8 11.2 A2.6 2.6 0 0 1 6.2 11.2 L3.4 11.9 L5.5 9.2 V7.6 C5.5 5.2 6.1 2.5 8 0.8 Z'), { fill: 'M8 4.6 a1.35 1.35 0 1 1 -0.001 0 Z', hole: true }, S('M8 12.6 V15', 1.5)], // rocket (merge)
  [nf(0xf188)]: [F('M8 5.4 c2.2 0 3.7 1.9 3.7 4.4 S10.2 14.4 8 14.4 s-3.7 -2.1 -3.7 -4.6 S5.8 5.4 8 5.4 Z M8 1.8 a2 2 0 0 1 2 2 H6 A2 2 0 0 1 8 1.8 Z'), S('M4.4 7.2 L1.8 5.8 M4.2 9.8 H1.4 M4.4 12 L2 13.6 M11.6 7.2 L14.2 5.8 M11.8 9.8 H14.6 M11.6 12 L14 13.6', 1.2)], // bug (debug)
  [nf(0xf0eb)]: [S('M8 1.8 a4.4 4.4 0 0 1 2.4 8.1 c-0.5 0.4 -0.8 0.9 -0.8 1.5 H6.4 c0 -0.6 -0.3 -1.1 -0.8 -1.5 A4.4 4.4 0 0 1 8 1.8 Z', 1.5), F('M6.4 12.4 h3.2 v1.2 h-3.2 Z M6.9 14.2 h2.2 v1 h-2.2 Z')], // lightbulb (spike)
};

// Bar block cells: fraction of the cell painted fg, left-aligned, full height.
const BLOCK_FRACTION = {
  '█': 1, '▉': 7 / 8, '▊': 6 / 8, '▋': 5 / 8,
  '▌': 4 / 8, '▍': 3 / 8, '▎': 2 / 8, '▏': 1 / 8,
};

// ---------------------------------------------------------------------------
// SVG assembly — one row of fixed-width cells on a rounded terminal panel.
// ---------------------------------------------------------------------------

const FS = 14;          // font size
const CW = 8.4;         // cell advance (monospace ~0.6em)
const ROW = 30;         // row height
const PAD_X = 16;
const PAD_Y = 10;
const TERM_BG = '#16161e';
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function toSvg(cells) {
  const W = Math.ceil(PAD_X * 2 + cells.length * CW);
  const H = ROW + PAD_Y * 2;
  const top = PAD_Y;
  const mid = PAD_Y + ROW / 2;
  const parts = [];
  parts.push(`<rect width="${W}" height="${H}" rx="8" fill="${TERM_BG}"/>`);

  // Background runs first, merged so segment boxes are seamless.
  let i = 0;
  while (i < cells.length) {
    const b = cells[i].bg;
    let j = i;
    while (j < cells.length && cells[j].bg === b) j += 1;
    if (b) {
      parts.push(`<rect x="${(PAD_X + i * CW).toFixed(2)}" y="${top}" width="${((j - i) * CW).toFixed(2)}" height="${ROW}" fill="${b}"/>`);
    }
    i = j;
  }

  cells.forEach((c, idx) => {
    const x = PAD_X + idx * CW;
    const alpha = c.dim ? ' opacity="0.55"' : '';
    if (c.ch === ' ') return;
    if (c.ch === SEP) { // powerline chevron: fg triangle over the (already painted) next bg
      parts.push(`<path d="M${x.toFixed(2)} ${top} L${(x + CW + 0.4).toFixed(2)} ${mid} L${x.toFixed(2)} ${top + ROW} Z" fill="${c.fg}"/>`);
      return;
    }
    const frac = BLOCK_FRACTION[c.ch];
    if (frac !== undefined) {
      parts.push(`<rect x="${x.toFixed(2)}" y="${top}" width="${(CW * frac).toFixed(2)}" height="${ROW}" fill="${c.fg}"${alpha}/>`);
      return;
    }
    if (c.ch === '●') { // dirty marker
      parts.push(`<circle cx="${(x + CW / 2).toFixed(2)}" cy="${mid}" r="2.6" fill="${c.fg}"${alpha}/>`);
      return;
    }
    const icon = ICONS[c.ch];
    if (icon) {
      const s = 10.5 / 16; // icon box ≈ 10.5px, centred on the cell
      const tx = x + CW / 2 - 8 * s;
      const ty = mid - 8 * s;
      const body = icon.map((p) => p.stroke
        ? `<path d="${p.stroke}" fill="none" stroke="${c.fg}" stroke-width="${p.w}" stroke-linecap="round" stroke-linejoin="round"/>`
        : `<path d="${p.fill}" fill="${p.hole ? TERM_BG : c.fg}"/>`).join('');
      parts.push(`<g transform="translate(${tx.toFixed(2)} ${ty.toFixed(2)}) scale(${s})"${alpha}>${body}</g>`);
      return;
    }
    const weight = c.bold ? ' font-weight="600"' : '';
    parts.push(`<text x="${(x + CW / 2).toFixed(2)}" y="${mid}" fill="${c.fg}"${weight}${alpha} text-anchor="middle" dominant-baseline="central">${esc(c.ch)}</text>`);
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="ui-monospace, 'SF Mono', Menlo, Consolas, 'DejaVu Sans Mono', monospace" font-size="${FS}">\n${parts.join('\n')}\n</svg>\n`;
}

// ---------------------------------------------------------------------------

mkdirSync(OUT_DIR, { recursive: true });
try {
  for (const state of STATES) {
    const { dir, scratch } = makeProject(state.run, state);
    try {
      const ansi = renderAnsi(dir, state.usedPct);
      const svg = toSvg(parseAnsi(ansi));
      writeFileSync(join(OUT_DIR, `${state.name}.svg`), svg);
      console.log(`wrote docs/assets/statusline/${state.name}.svg`);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
} finally {
  // Best-effort: the throwaway HOME/GIT_CONFIG_GLOBAL scratch dir childEnv()
  // pins every child process to is inert and disposable, never part of any
  // real output.
  rmSync(INERT_HOME, { recursive: true, force: true });
}
