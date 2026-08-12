import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Terminal-state stage strip: a blocked or aborted run carries its state in the
 * strip's COLOUR, not in trailing reason text.
 *
 * The statusline is not the record of why a run stopped — the BLOCK reason
 * lives in `ape_run action: status` AND the `.ape/runtime/status.md`
 * projection, the ABORT reason in `ape_run action: status` alone (no arm of
 * renderStatusDoc reads abort_reason) — so neither `block_reason` nor
 * `abort_reason` renders here, in any charset tier.
 * What replaces them is a uniformly state-coloured strip: every milestone mark
 * yellow while blocked, every mark red once aborted. The aborted run regains
 * the strip it used to drop (a uniform strip asserts no done/current boundary,
 * so it fabricates no position) but still carries NO progress bar.
 */

const RENDERER = fileURLToPath(new URL('../bin/ape-statusline.mjs', import.meta.url));

// tokyo-night truecolor foregrounds (bin/ape-statusline.mjs PALETTE). Pinning
// COLORTERM below is what makes these deterministic: without it the renderer
// emits the 256-colour forms (38;5;179 / 38;5;204) instead.
const ORANGE = '38;2;255;158;100'; // #ff9e64 — blocked
const RED = '38;2;247;118;142'; // #f7768e — aborted
const GREEN = '38;2;158;206;106'; // #9ece6a — a done milestone
const CYAN = '38;2;125;207;255'; // #7dcfff — the current milestone
const TRACK = '38;2;65;72;104'; // #414868 — a pending milestone
// The progress bar is the ONLY user of the track colour as a BACKGROUND, so its
// absence is a precise "no bar was rendered" probe on the non-ascii tiers.
const TRACK_BG = '48;2;65;72;104';

// The full-lane pipeline's six milestone marks per charset tier: nerdfont
// paints one Font-Awesome glyph per milestone (pencil/flask/wrench/eye/shield/
// rocket), unicode and ascii the font-independent initials.
const NERD_MARKS = ['f040', 'f0c3', 'f0ad', 'f06e', 'f132', 'f135']
  .map((hex) => String.fromCodePoint(parseInt(hex, 16)));
const INITIAL_MARKS = ['P', 'T', 'B', 'R', 'G', 'M'];
const marksFor = (charset) => (charset === 'nerdfont' ? NERD_MARKS : INITIAL_MARKS);

const BLOCK_REASON = 'stage security-review failed twice; operator input required to continue';
const ABORT_REASON = 'operator override: wrong ticket dispatched to a live run';

function render(payload, charset) {
  const env = {
    ...process.env,
    APE_STATUSLINE_CHARSET: charset,
    APE_STATUSLINE_GIT_TIMEOUT_MS: '5000',
    // Pin truecolor so the SGR bytes asserted above are the ones emitted.
    COLORTERM: 'truecolor',
  };
  // The renderer consults the host project pins; strip the ambient ones so a
  // suite run from a live Claude/Codex session cannot leak this repo in as the
  // resolved project (which would both render the live run and write its
  // statusline cache here instead of the scratch project).
  delete env.CLAUDE_PROJECT_DIR;
  delete env.CODEX_CWD;
  return execFileSync(process.execPath, [RENDERER], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env,
  });
}

// eslint-disable-next-line no-control-regex
const stripAnsi = (text) => text.replace(/\x1b\[[0-9;]*m/g, '');

function writeActive(dir, run) {
  mkdirSync(join(dir, '.ape', 'runtime'), { recursive: true });
  writeFileSync(join(dir, '.ape', 'runtime', 'active.json'), JSON.stringify(run));
}

// The active foreground colour at `index` of the raw (ANSI-bearing) render,
// read the way a terminal reads it: a 38;… sequence sets the colour, a full
// reset clears it, and bold/dim/background sequences leave it alone.
function fgAt(raw, index) {
  // eslint-disable-next-line no-control-regex
  const sgr = /\x1b\[([0-9;]*)m/g;
  let color = null;
  for (let m = sgr.exec(raw); m && m.index < index; m = sgr.exec(raw)) {
    const params = m[1];
    if (params === '' || params === '0') color = null;
    else if (params.startsWith('38;')) color = params;
  }
  return color;
}

// Every stage-strip mark in render order, with the foreground colour actually
// active at each one.
//
// Anchoring on the MARK CHARACTERS matters: the blocked bar's cells and the
// BLOCK/ABORT box carry the very same state SGR sequence, so a bare search for
// the colour code would pass on a render that never coloured a single mark.
// `boxLabel` is the stage box's text — the last thing on the line before the
// trailing metrics — so the scan starts past the boxes and the project path,
// whose uppercase letters would otherwise collide with the initials tier.
function stripMarks(raw, boxLabel, marks) {
  const cut = raw.lastIndexOf(boxLabel);
  expect(cut).toBeGreaterThanOrEqual(0); // the box label must render at all
  const from = cut + boxLabel.length;
  const found = [];
  for (const mark of marks) {
    for (let at = raw.indexOf(mark, from); at >= 0; at = raw.indexOf(mark, at + mark.length)) {
      found.push({ mark, at, color: fgAt(raw, at) });
    }
  }
  return found.sort((a, b) => a.at - b.at);
}

function expectNoBar(raw, charset) {
  const plain = stripAnsi(raw);
  if (charset === 'ascii') {
    expect(plain).not.toContain('#'); // ascii fill cells
    expect(plain).not.toContain('-'.repeat(8)); // ascii empty track
  } else {
    expect(plain).not.toContain('█'); // fill cells
    expect(raw).not.toContain(TRACK_BG); // the bar's solid track background
  }
}

function expectBar(raw, charset) {
  const plain = stripAnsi(raw);
  if (charset === 'ascii') expect(plain).toContain('###');
  else {
    expect(plain).toContain('██');
    expect(raw).toContain(TRACK_BG);
  }
}

for (const charset of ['nerdfont', 'unicode', 'ascii']) {
  describe(`ape v2 statusline terminal-state strip — ${charset}`, () => {
    const MARKS = marksFor(charset);
    let dir;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'ape-statusline-terminal-'));
    });
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('paints every milestone mark in the block colour and renders no block reason', () => {
      writeActive(dir, {
        mode: 'phase',
        lane: 'full',
        status: 'blocked',
        stage: 'build',
        block_reason: BLOCK_REASON,
        updated_at: new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString(),
        tickets: [],
        receipts: [],
      });
      const raw = render({ workspace: { current_dir: dir } }, charset);
      const plain = stripAnsi(raw);

      // Sanity on the pin: with COLORTERM=truecolor the block colour really is
      // this byte sequence (a 256-colour render would emit 38;5;179 instead).
      expect(raw).toContain(ORANGE);

      // Stage build is mid-pipeline, so a done-green / current-highlight /
      // pending-track split shows three different hues here. A blocked run
      // paints ONE uniform state colour across the whole strip instead: no
      // done/current/pending distinction, nothing pulsing.
      const marks = stripMarks(raw, 'BLOCK', MARKS);
      expect(marks.map((m) => m.mark)).toEqual(MARKS);
      expect(marks.map((m) => m.color)).toEqual(MARKS.map(() => ORANGE));

      // The reason is gone entirely — neither whole nor as the 56-char
      // mid-word slice the renderer used to trail.
      expect(plain).not.toContain(BLOCK_REASON);
      expect(plain).not.toContain('failed twice');
      expect(plain).not.toContain('operator input');

      // The frozen bar keeps rendering exactly as it does today.
      expectBar(raw, charset);
    });

    it('paints every milestone mark in the abort colour, with no abort reason and no bar', () => {
      writeActive(dir, {
        mode: 'phase',
        lane: 'full',
        status: 'aborted',
        // The runtime seals an abort with the literal stage 'aborted'. The
        // displayed milestone list comes from mode/lane alone, so a uniformly
        // coloured strip reports no done/current boundary and fabricates no
        // position — unlike a bar, which would.
        stage: 'aborted',
        abort_reason: ABORT_REASON,
        updated_at: new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString(),
        tickets: [],
        receipts: [],
      });
      const raw = render({ workspace: { current_dir: dir } }, charset);
      const plain = stripAnsi(raw);

      expect(plain).toContain('ABORT'); // the sealed state still reads as the red box
      // Sanity on the pin: with COLORTERM=truecolor the abort colour really is
      // this byte sequence (a 256-colour render would emit 38;5;204 instead).
      expect(raw).toContain(RED);

      const marks = stripMarks(raw, 'ABORT', MARKS);
      expect(marks.map((m) => m.mark)).toEqual(MARKS);
      expect(marks.map((m) => m.color)).toEqual(MARKS.map(() => RED));

      expect(plain).not.toContain(ABORT_REASON);
      expect(plain).not.toContain('wrong ticket');
      expect(plain).not.toContain('operator override');

      // No bar at all: nothing is progressing on a dead run.
      expectNoBar(raw, charset);
    });

    it('leaves the done/current/pending strip of a running run unchanged', () => {
      writeActive(dir, {
        mode: 'phase',
        lane: 'full',
        status: 'running',
        stage: 'build',
        updated_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        tickets: [],
        receipts: [],
      });
      const raw = render({ workspace: { current_dir: dir } }, charset);
      const marks = stripMarks(raw, 'build', MARKS);
      expect(marks.map((m) => m.mark)).toEqual(MARKS);
      // plan/test done, build current (milestone color = green), review/gates/merge pending.
      expect(marks.map((m) => m.color)).toEqual([GREEN, GREEN, GREEN, TRACK, TRACK, TRACK]);
      expectBar(raw, charset);
    });

    it('leaves the all-green strip and full bar of a completed run unchanged', () => {
      writeActive(dir, {
        mode: 'phase',
        lane: 'full',
        status: 'completed',
        stage: 'complete',
        tickets: [],
        receipts: [],
      });
      const raw = render({ workspace: { current_dir: dir } }, charset);
      const marks = stripMarks(raw, 'complete', MARKS);
      expect(marks.map((m) => m.mark)).toEqual(MARKS);
      expect(marks.map((m) => m.color)).toEqual(MARKS.map(() => GREEN));
      const plain = stripAnsi(raw);
      expect(plain).toContain(charset === 'ascii' ? '#'.repeat(8) : '█'.repeat(8));
    });
  });
}
