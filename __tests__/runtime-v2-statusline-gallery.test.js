import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ===========================================================================
// CONTRACT SUITE for scripts/render-statusline-svg.mjs (roadmap entry
// statusline-gallery-regeneration-unsafe, folded into the combined entry
// support-tooling-answers-honestly). Three independent defects (A, B, C
// below), pinned across FOUR independent behavioral arms in the describe
// block that carries them -- defect B alone contributes two, an
// absolute-clock dimension and a separate latency dimension:
//
// DEFECT A (a real leak): renderAnsi() spawns the real renderer
// (bin/ape-statusline.mjs) with `env: { ...process.env, ... }` and a
// synthetic stdin payload that supplies only `workspace.current_dir`, never
// `workspace.project_dir`. resolveGovernedRoot (lib/runtime/paths.js) ranks
// an ambient CLAUDE_PROJECT_DIR (as the pin) and CODEX_CWD (as the walk
// start) ABOVE the payload's cwd, so on any machine where either is set --
// the normal state inside a Claude Code or Codex session, i.e. exactly where
// a maintainer would run `npm run statusline:svg` -- every regenerated SVG
// can depict a live, unrelated APE run instead of the throwaway fixture, and
// can plant a `statusline-cache.json` under that unrelated project's
// `.ape/runtime/` before any image is even compared.
//
// DEFECT B (not reproducible): running.svg embeds two wall-clock-derived
// values -- the stage mark's pulse phase and the progress bar's asymptotic
// creep, both derived from `nowMs()` in bin/ape-statusline.mjs (which itself
// reads `Date.now()` absent an injected `APE_STATUSLINE_NOW_MS` override) --
// so two regenerations of the gallery, run with zero renderer change, can
// produce different bytes for running.svg depending purely on when each was
// run.
//
// DEFECT C (roadmap entry outside-input-coerced-not-refused-and-ambient-env-
// denylist, item C): renderAnsi() spawns the renderer with `env: {
// ...process.env }` MINUS two deleted names, and the generator's own git()
// helper passes no env override at all (inheriting every ambient variable
// unfiltered), so an ambient GIT_DIR/GIT_WORK_TREE/GIT_CONFIG_GLOBAL -- set by
// git hooks, `git rebase --exec`, or wrapper tooling on a maintainer's own
// machine -- redirects BOTH the fixture-creation git() calls and the
// renderer's own gitBranch/gitStatus probes onto that ambient repository
// instead of the throwaway fixture: a write into a repository the generator
// never meant to touch, and a leaked branch/dirty marker baked into the
// committed public SVGs.
//
// Neither the generator nor the renderer is importable as a module without
// running its top-level side effects (the generator WRITES real SVGs into
// docs/assets/statusline/ the instant it is loaded), so every arm below
// EITHER stages a throwaway COPY of scripts/, bin/, and lib/ into a scratch
// directory and runs the real, UNMODIFIED generator script there -- exactly
// the technique __tests__/runtime-v2-loaded-module-stamp-precision.test.js's
// stageSourceExecutionProject() already uses for the same reason -- OR, for
// the one arm that needs to invoke the renderer directly (see
// renderDirect() below), spawns the real bin/ape-statusline.mjs UNSTAGED:
// safe without staging because the renderer writes only inside the
// caller-given scratch project dir it is handed on stdin, never a fixed
// relative location, exactly the precedent this file's own later
// renderStatusline() helper already establishes. Because
// scripts/render-statusline-svg.mjs computes its OUT_DIR relative to its own
// `import.meta.url`, running the staged copy writes into
// `<staged>/docs/assets/statusline/`, never into this repository's real
// docs/ -- so this suite never touches a pre-existing production file.
// ===========================================================================

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const GALLERY_NAMES = ['aborted', 'blocked', 'completed', 'idle', 'running'];
const STATUSLINE_RENDERER = join(REPO_ROOT, 'bin', 'ape-statusline.mjs');

// A CJS preload (Node's `--require` runs it before the ESM entry point is
// evaluated, regardless of the entry's own module type) that pins
// `Date.now()` to ONE literal instant baked directly into the returned
// source TEXT -- never read back out of an environment variable name at
// preload time. `Date.now` is the ONLY wall-clock read either the generator
// (its `minsAgo` fixture anchors) or the renderer (bin/ape-statusline.mjs's
// stage-mark pulse and progress-bar elapsed-time math, on the rare path
// where it has no injected APE_STATUSLINE_NOW_MS anchor to prefer) performs;
// `Date.parse` on an already-materialized ISO string is untouched.
//
// An EARLIER version of this preload instead read a caller-chosen env var
// NAME (APE_TEST_FIXED_NOW_MS / APE_TEST_FIXED_RENDER_NOW_MS) at preload
// time, so ONE shared file could be inherited by both the generator process
// and any renderer child it spawns and still resolve to a DIFFERENT pinned
// instant per process. That shape never actually controlled the renderer
// CHILD's math, for two independent reasons: scripts/render-statusline-
// svg.mjs's childEnv() allowlist never forwarded either test-only var name
// to the child, so the preload's own env read there always resolved to
// `undefined` -> `NaN` and no-opped; and even had it resolved, renderAnsi()
// unconditionally sets the renderer's own APE_STATUSLINE_NOW_MS to the
// GENERATOR's single computed instant, which nowMs() (bin/ape-
// statusline.mjs) always prefers over Date.now() whenever it is present --
// so the renderer CHILD's own Date.now() reread was never the thing being
// measured. The "latency dimension" arm below no longer routes through the
// generator/renderAnsi() pipeline for this reason: it drives the REAL
// renderer directly (renderDirect() below), so this baked preload can pin
// ITS OWN Date.now() independently of whatever a generator or a childEnv()
// allowlist would or would not forward.
const bakedTimePreload = (fixedMs) =>
  `'use strict';\nDate.now = function () { return ${fixedMs}; };\n`;

function stageGeneratorProject() {
  const dir = mkdtempSync(join(tmpdir(), 'ape-statusline-svg-stage-'));
  for (const entry of ['scripts', 'bin', 'lib']) {
    cpSync(join(REPO_ROOT, entry), join(dir, entry), { recursive: true });
  }
  return dir;
}

// Runs the STAGED copy of the real generator script. Ambient
// CLAUDE_PROJECT_DIR/CODEX_CWD are stripped by default -- exactly the scrub
// __tests__/runtime-v2-statusline.test.js's own `render()` helper already
// performs on the renderer directly -- so every call is safe against this
// live session's own APE project unless a test deliberately re-adds them via
// `envOverrides` to exercise DEFECT A. renderAnsi() (scripts/render-
// statusline-svg.mjs) is contracted to spawn the renderer through childEnv(),
// an ALLOWLIST of exactly what the renderer needs rather than a `{
// ...process.env }` spread of the whole ambient environment (DEFECT C
// below), so whatever allowlisted env this call sets on the GENERATOR
// process propagates to the renderer CHILD it spawns too.
function runGenerator(stagedDir, envOverrides = {}) {
  const env = { ...process.env };
  delete env.CLAUDE_PROJECT_DIR;
  delete env.CODEX_CWD;
  Object.assign(env, envOverrides);
  return execFileSync(
    process.execPath,
    [join(stagedDir, 'scripts', 'render-statusline-svg.mjs')],
    { cwd: stagedDir, env, encoding: 'utf8' },
  );
}

// Runs the generator with its OWN Date.now() pinned to `fixedNowMs` via a
// baked preload -- seeding its `minsAgo`-relative fixtures and (through
// renderAnsi()'s unconditional APE_STATUSLINE_NOW_MS override) every
// renderer child it spawns, all from that ONE shared instant. This is what
// makes the absolute-clock arm below fully deterministic rather than a
// timing gamble: two calls with a DIFFERENT `fixedNowMs` deterministically
// expose whether the rendered bytes depend on WHICH absolute instant is
// asked for. It does NOT, and cannot, expose anything about generator-to-
// render LATENCY: renderAnsi() forwards its own NOW_MS to every renderer
// child it spawns unconditionally, by construction, so no execution path
// through this pipeline can ever make a renderer child observe an instant
// DIFFERENT from its own generator's -- see renderDirect()/the latency arm
// below for the one that actually exercises the renderer's Date.now()
// fallback path directly.
function runGeneratorWithFixedClock(stagedDir, fixedNowMs) {
  const preloadPath = join(stagedDir, 'fixed-time-preload.cjs');
  writeFileSync(preloadPath, bakedTimePreload(fixedNowMs));
  return runGenerator(stagedDir, { NODE_OPTIONS: `--require ${preloadPath}` });
}

function galleryPath(stagedDir, name) {
  return join(stagedDir, 'docs', 'assets', 'statusline', `${name}.svg`);
}

function readGallery(stagedDir) {
  return Object.fromEntries(GALLERY_NAMES.map((name) => [name, readFileSync(galleryPath(stagedDir, name))]));
}

// Every visible glyph the generator draws is either a `<text>` element
// holding exactly one character (scripts/render-statusline-svg.mjs's toSvg:
// "everything else is plain ASCII on the viewer's monospace stack" -- an
// explicit, documented design goal for legibility) or a shape (icon/bar/
// separator/dirty-dot) that carries no readable text at all; space cells
// paint nothing. Concatenating every `<text>` node's content in document
// order therefore reconstructs the rendered line's letters, with spaces
// collapsed out -- enough to prove WHICH identity box rendered without
// depending on any other implementation detail.
function svgVisibleText(svgContent) {
  return [...svgContent.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]).join('');
}

// Invokes the REAL renderer directly -- no generator, no childEnv()
// allowlist in between -- so the caller's own env, including NODE_OPTIONS,
// reaches the renderer process exactly as given. Used ONLY by the latency
// arm below, which needs independent control over the renderer's OWN
// observed Date.now(); no route through renderAnsi() can ever provide that
// (see the bakedTimePreload doc comment above). Same
// CLAUDE_PROJECT_DIR/CODEX_CWD scrub as runGenerator, for the same reason.
function renderDirect(dir, envOverrides = {}) {
  const env = {
    ...process.env,
    APE_STATUSLINE_CHARSET: 'nerdfont',
    COLORTERM: 'truecolor',
    APE_STATUSLINE_GIT_TIMEOUT_MS: '5000',
  };
  delete env.CLAUDE_PROJECT_DIR;
  delete env.CODEX_CWD;
  return execFileSync(process.execPath, [STATUSLINE_RENDERER], {
    input: JSON.stringify({
      model: { display_name: 'Fable 5' },
      workspace: { current_dir: dir },
      context_window: { used_percentage: 42 },
    }),
    encoding: 'utf8',
    env: { ...env, ...envOverrides },
  });
}

describe('statusline gallery regeneration is safe and reproducible', () => {
  it(
    'still depicts the throwaway fixture when ambient CLAUDE_PROJECT_DIR/CODEX_CWD point at an unrelated live project, and plants no cache under that pointed-at project (DEFECT A)',
    () => {
      const staged = stageGeneratorProject();
      const outsideScratch = mkdtempSync(join(tmpdir(), 'ape-statusline-svg-outside-'));
      const outsideDir = join(outsideScratch, 'unrelated', 'live-project');
      try {
        // An unrelated, ALREADY-RUNNING APE project -- standing in for "the
        // real repository" the defect description names. A real, non-idle
        // run here (rather than none) makes the leak observably DIFFERENT
        // from the fixture's own idle state, so the assertion below cannot
        // hold vacuously for the wrong reason.
        mkdirSync(join(outsideDir, '.ape', 'runtime', 'history'), { recursive: true });
        writeFileSync(
          join(outsideDir, '.ape', 'runtime', 'active.json'),
          JSON.stringify({
            mode: 'spike',
            lane: 'full',
            stage: 'spike',
            status: 'running',
            updated_at: new Date().toISOString(),
            tickets: [],
            receipts: [],
          }),
        );
        const outsideCachePath = join(outsideDir, '.ape', 'runtime', 'statusline-cache.json');
        // Fixture truth: nothing has run yet, so the cache genuinely does
        // not exist before the generator is invoked below.
        expect(existsSync(outsideCachePath)).toBe(false);

        // The generator's own fixtures always carry `run: null` for the
        // "idle" state (scripts/render-statusline-svg.mjs STATES), so a
        // correct, non-leaking regeneration renders idle.svg as `APE idle`
        // no matter what an ambient host env sets -- exactly the scenario a
        // maintainer's own Claude Code or Codex session produces.
        runGenerator(staged, { CLAUDE_PROJECT_DIR: outsideDir, CODEX_CWD: outsideDir });

        const idleSvg = readFileSync(galleryPath(staged, 'idle'), 'utf8');
        const text = svgVisibleText(idleSvg);
        expect(text).toContain('APEidle');
        // Never the unrelated project's own identity leaking through instead.
        expect(text).not.toContain('APEspike/full');

        // The leak's second half: historySamples() (bin/ape-statusline.mjs)
        // writes a `.ape/runtime/statusline-cache.json` into whatever
        // project it resolved -- which must never be the pointed-at,
        // unrelated live project.
        expect(existsSync(outsideCachePath)).toBe(false);
      } finally {
        rmSync(staged, { recursive: true, force: true });
        rmSync(outsideScratch, { recursive: true, force: true });
      }
    },
    60_000,
  );

  it(
    'regenerates the full gallery byte-identically across two DIFFERENT absolute instants, including running.svg (DEFECT B, absolute-clock dimension)',
    () => {
      const staged = stageGeneratorProject();
      try {
        // Two generations, each self-consistently pinning its OWN generator
        // process AND every renderer child it spawns to ONE exact instant --
        // 0ms and 2000ms, two whole seconds apart -- rather than any real
        // elapsed gap. renderAnsi() unconditionally forwards the generator's
        // own instant to the renderer child, so `currentMilestoneElapsedMs`
        // (bin/ape-statusline.mjs, its nowMs() minus the fixture anchor)
        // resolves to the SAME exact 300000ms (the fixture's `minsAgo(5)`) in
        // BOTH generations, by construction: the stage-mark pulse phase and
        // bar creep are therefore IDENTICAL between them, never "guaranteed
        // different". This arm isolates and proves only that WHICH absolute
        // instant is chosen cannot leak into the rendered bytes -- it does
        // NOT, by itself, prove independence from generator-to-render
        // LATENCY; see the arm below for that.
        runGeneratorWithFixedClock(staged, 0);
        const firstGeneration = readGallery(staged);

        runGeneratorWithFixedClock(staged, 2_000); // second, independent generation overwrites the same files in place
        const secondGeneration = readGallery(staged);

        for (const name of GALLERY_NAMES) {
          expect(
            secondGeneration[name].equals(firstGeneration[name]),
            `${name}.svg differed between two generations run at different instants with no renderer change`,
          ).toBe(true);
        }
      } finally {
        rmSync(staged, { recursive: true, force: true });
      }
    },
    60_000,
  );

  it(
    "renders byte-identical output for two direct renders that share ONE injected APE_STATUSLINE_NOW_MS anchor but let the renderer's OWN Date.now() diverge by 1500ms, proving the injected anchor -- never the renderer's own clock read -- drives the stage-mark pulse and bar creep (DEFECT B, latency dimension)",
    () => {
      // A PRIOR version of this arm tried to prove the same thing by routing
      // two full gallery generations through the generator/childEnv()
      // pipeline with different `renderNowMs` env values. It could never
      // detect anything: renderAnsi() always overrides the renderer's
      // APE_STATUSLINE_NOW_MS with the generator's OWN NOW_MS (never a
      // separately-injected renderNowMs), so no execution path through that
      // pipeline can make the renderer observe an instant different from its
      // own generator's, by design -- the arm passed unconditionally,
      // regardless of whether the underlying implementation was correct.
      // This arm instead drives the RENDERER directly (renderDirect()
      // above), so it can hold APE_STATUSLINE_NOW_MS fixed across both calls
      // while genuinely varying the ONE thing a correct nowMs() must ignore:
      // the renderer's own Date.now() read, baked into two distinct preload
      // files with no env-var name in between.
      const dir = mkdtempSync(join(tmpdir(), 'ape-statusline-svg-latency-'));
      const scratch = mkdtempSync(join(tmpdir(), 'ape-statusline-svg-latency-preload-'));
      try {
        mkdirSync(join(dir, '.ape', 'runtime'), { recursive: true });
        writeFileSync(
          join(dir, '.ape', 'runtime', 'active.json'),
          JSON.stringify({
            mode: 'phase', lane: 'full', tickets: [], receipts: [],
            status: 'running', stage: 'build',
            updated_at: new Date(500_000).toISOString(),
          }),
        );
        const zeroLatencyPreload = join(scratch, 'zero.cjs');
        const inducedLatencyPreload = join(scratch, 'induced.cjs');
        writeFileSync(zeroLatencyPreload, bakedTimePreload(500_000));
        writeFileSync(inducedLatencyPreload, bakedTimePreload(500_000 + 1_500));

        // Every input the renderer could use to compute elapsed time is held
        // IDENTICAL between the two calls except the renderer's OWN
        // Date.now() read (via the baked preload) -- the one input a correct
        // implementation must never consult while APE_STATUSLINE_NOW_MS is
        // present.
        const zeroLatency = renderDirect(dir, {
          NODE_OPTIONS: `--require ${zeroLatencyPreload}`,
          APE_STATUSLINE_NOW_MS: '500000',
        });
        const inducedLatency = renderDirect(dir, {
          NODE_OPTIONS: `--require ${inducedLatencyPreload}`,
          APE_STATUSLINE_NOW_MS: '500000',
        });
        expect(
          inducedLatency,
          "output changed when only the renderer's OWN Date.now() (baked via preload, never consulted while APE_STATUSLINE_NOW_MS is present) moved 1500ms later -- the renderer is reading the wall clock directly instead of honouring the injected anchor",
        ).toBe(zeroLatency);
      } finally {
        rmSync(dir, { recursive: true, force: true });
        rmSync(scratch, { recursive: true, force: true });
      }
    },
    60_000,
  );

  it(
    'regenerates the gallery without leaking into, or writing to, an ambient repository named by GIT_DIR/GIT_WORK_TREE (DEFECT C)',
    () => {
      const staged = stageGeneratorProject();
      const ambientScratch = mkdtempSync(join(tmpdir(), 'ape-statusline-svg-ambient-'));
      const ambientDir = join(ambientScratch, 'ambient-repo');
      try {
        // A second, pre-existing repository standing in for "the maintainer's
        // real, live repository" -- distinct from the throwaway fixture the
        // generator itself creates, on a distinctly-named branch so a leak is
        // unambiguous. Named by GIT_DIR/GIT_WORK_TREE rather than by cwd: that
        // is exactly the class of ambient variable a git hook, `git rebase
        // --exec`, or wrapper tooling exports on a real developer machine.
        mkdirSync(ambientDir, { recursive: true });
        execFileSync('git', ['init', '-q', '-b', 'ambientwork'], { cwd: ambientDir });
        execFileSync('git', ['config', 'user.email', 'ambient@example.test'], { cwd: ambientDir });
        execFileSync('git', ['config', 'user.name', 'ambient'], { cwd: ambientDir });
        writeFileSync(join(ambientDir, 'ambient.txt'), 'ambient\n');
        execFileSync('git', ['add', 'ambient.txt'], { cwd: ambientDir });
        execFileSync('git', ['commit', '-q', '-m', 'ambient baseline'], { cwd: ambientDir });
        const beforeHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ambientDir, encoding: 'utf8' }).trim();
        const beforeStatus = execFileSync('git', ['status', '--porcelain'], { cwd: ambientDir, encoding: 'utf8' });

        runGenerator(staged, {
          GIT_DIR: join(ambientDir, '.git'),
          GIT_WORK_TREE: ambientDir,
        });

        // The ambient repository must come out of this regeneration byte-for-
        // byte as it went in: no new commit, no dirty working tree, even
        // though the generator's own fixture-creation git() calls and the
        // renderer's own gitBranch/gitStatus probes both ran while these two
        // variables were exported.
        const afterHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ambientDir, encoding: 'utf8' }).trim();
        const afterStatus = execFileSync('git', ['status', '--porcelain'], { cwd: ambientDir, encoding: 'utf8' });
        expect(afterHead, 'the ambient repository must not gain a new commit').toBe(beforeHead);
        expect(afterStatus, 'the ambient repository working tree must stay clean').toBe(beforeStatus);

        // And the rendered gallery must depict the THROWAWAY fixture's own
        // branch, never the ambient repository's.
        const idleSvg = readFileSync(galleryPath(staged, 'idle'), 'utf8');
        const text = svgVisibleText(idleSvg);
        expect(text, "must not depict the ambient repository's branch").not.toContain('ambientwork');
      } finally {
        rmSync(staged, { recursive: true, force: true });
        rmSync(ambientScratch, { recursive: true, force: true });
      }
    },
    60_000,
  );
});

// ===========================================================================
// CONTRACT ARM for bin/ape-statusline.mjs's numeric environment-variable
// reads (roadmap entry outside-input-coerced-not-refused-and-ambient-env-
// denylist, item A). nowMs() used to read
// `Number(process.env.APE_STATUSLINE_NOW_MS)` directly and accept the result
// whenever `Number.isFinite` held -- but `Number('')` is 0, and 0 IS finite,
// so a SET-BUT-EMPTY APE_STATUSLINE_NOW_MS was silently treated as an
// injected clock pinned to the epoch instead of falling back to the real
// wall clock. currentMilestoneElapsedMs then computed Math.max(0, 0 -
// entered), which was 0 for any run entered after 1970: the progress bar and
// stage-mark pulse froze at the milestone start forever, with no diagnostic
// -- silent degradation introduced BY the fix (support-tooling-answers-
// honestly) for silent degradation, now fixed by envFiniteMs (below). The two
// arms below pin the BEHAVIORAL contract (an empty string must fall back
// exactly like an unset variable, never like an explicit override of 0) and
// the STRUCTURAL contract the run objective specifies: ONE module-level
// helper, envFiniteMs(name, {min}), is the ONLY
// numeric env read in the file, derived from source rather than hard-coded to
// today's two readers, so a third numeric env var added later cannot reopen
// this class silently.
// ===========================================================================
function writeStatuslineActiveRun(dir, overrides = {}) {
  mkdirSync(join(dir, '.ape', 'runtime'), { recursive: true });
  writeFileSync(
    join(dir, '.ape', 'runtime', 'active.json'),
    JSON.stringify({
      mode: 'phase',
      lane: 'full',
      status: 'running',
      stage: 'build',
      tickets: [],
      receipts: [],
      ...overrides,
    }),
  );
}

function renderStatusline(dir, envOverrides = {}) {
  const env = { ...process.env, APE_STATUSLINE_CHARSET: 'unicode', APE_STATUSLINE_GIT_TIMEOUT_MS: '5000' };
  delete env.CLAUDE_PROJECT_DIR;
  delete env.CODEX_CWD;
  return execFileSync('node', [STATUSLINE_RENDERER], {
    input: JSON.stringify({ workspace: { current_dir: dir }, model: { display_name: 'Opus' } }),
    encoding: 'utf8',
    env: { ...env, ...envOverrides },
  });
}

// Locates a top-level `function <name>(...) { ... }` declaration by brace
// counting (never a non-greedy regex, which can truncate at the first nested
// `}` on its own line -- the dominant style in this file's own if-chains) and
// returns its full source text, or null when no such function exists yet.
function extractFunctionSource(source, name) {
  const header = new RegExp(`function\\s+${name}\\s*\\([^)]*\\)\\s*\\{`);
  const match = header.exec(source);
  if (!match) return null;
  let depth = 1;
  let i = match.index + match[0].length;
  while (i < source.length && depth > 0) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') depth -= 1;
    i += 1;
  }
  return source.slice(match.index, i);
}

describe('bin/ape-statusline.mjs numeric env reads refuse empty-string input rather than coercing it (DEFECT A)', () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ape-statusline-envfinitems-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('does not freeze the progress bar/pulse at the milestone start when APE_STATUSLINE_NOW_MS is set but empty', () => {
    writeStatuslineActiveRun(dir, {
      stage: 'build',
      updated_at: new Date(Date.now() - 5 * 60_000).toISOString(),
    });
    const emptyOut = renderStatusline(dir, { APE_STATUSLINE_NOW_MS: '' });
    // An explicit override of exactly 0 (a real, deliberately pinned epoch
    // clock) is the shape an empty string was INDISTINGUISHABLE from under
    // the old bug: Number('') === 0 and Number.isFinite(0) is true, so both
    // strings used to freeze currentMilestoneElapsedMs at 0 forever. The
    // correct, now-shipped implementation falls back to the real wall clock
    // for the empty case, which -- with a run entered five real minutes ago
    // -- renders materially different bytes than a deliberately pinned
    // epoch-zero clock.
    const epochOut = renderStatusline(dir, { APE_STATUSLINE_NOW_MS: '0' });
    expect(emptyOut).not.toBe(epochOut);
  });

  it('routes every numeric environment-variable read through one shared envFiniteMs(name, {min}) helper, with no bypass', () => {
    const source = readFileSync(STATUSLINE_RENDERER, 'utf8');
    const helperSource = extractFunctionSource(source, 'envFiniteMs');
    expect(helperSource, 'bin/ape-statusline.mjs must define its own envFiniteMs helper').not.toBeNull();

    // Derived from the CALL SITES, never hard-coded to today's two readers
    // (APE_STATUSLINE_GIT_TIMEOUT_MS, APE_STATUSLINE_NOW_MS): a third numeric
    // env var introduced later is covered by this same floor as long as it is
    // read through the helper too.
    const callSites = [...source.matchAll(/envFiniteMs\(\s*['"](\w+)['"]/g)].map((match) => match[1]);
    expect(callSites.length).toBeGreaterThanOrEqual(2);
    expect(new Set(callSites).has('APE_STATUSLINE_NOW_MS')).toBe(true);
    expect(new Set(callSites).has('APE_STATUSLINE_GIT_TIMEOUT_MS')).toBe(true);

    // No numeric env read may bypass the helper: strip the helper's OWN body
    // (which necessarily converts its raw string with Number(...) itself)
    // before checking the REST of the file for a residual raw read.
    const withoutHelperBody = source.replace(helperSource ?? '', '');
    expect(withoutHelperBody).not.toMatch(/Number\(\s*process\.env\./);
  });
});
