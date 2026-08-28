import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RENDERER = fileURLToPath(new URL('../bin/ape-statusline.mjs', import.meta.url));
const PACKAGE_BUILDER = fileURLToPath(new URL('../scripts/build-plugin-packages.mjs', import.meta.url));

function render(payload, charset = 'unicode', envOverrides = {}) {
  // Pin the charset so assertions on unicode glyphs (e.g. the ⟳ loading /
  // ✓ done marks) are deterministic regardless of an ambient
  // APE_STATUSLINE_CHARSET.
  const env = { ...process.env, APE_STATUSLINE_CHARSET: charset, APE_STATUSLINE_GIT_TIMEOUT_MS: '5000' };
  // The renderer consults the host project pins; strip the ambient ones so a
  // suite run from a live Claude session (CLAUDE_PROJECT_DIR = this repo)
  // cannot leak into scratch-project resolution. Pinned cases inject their
  // own via envOverrides.
  delete env.CLAUDE_PROJECT_DIR;
  delete env.CODEX_CWD;
  return execFileSync('node', [RENDERER], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    // Generous git-probe timeout so the marker assertions never flake on a
    // slow CI runner where a real `git status` exceeds the tight prod default.
    env: { ...env, ...envOverrides },
  });
}

function renderProgram(program, payload) {
  const env = { ...process.env, APE_STATUSLINE_CHARSET: 'unicode', APE_STATUSLINE_GIT_TIMEOUT_MS: '5000' };
  delete env.CLAUDE_PROJECT_DIR;
  delete env.CODEX_CWD;
  return execFileSync('node', [program], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env,
  });
}

// eslint-disable-next-line no-control-regex
const stripAnsi = (text) => text.replace(/\x1b\[[0-9;]*m/g, '');

function writeActive(dir, run) {
  mkdirSync(join(dir, '.ape', 'runtime'), { recursive: true });
  writeFileSync(join(dir, '.ape', 'runtime', 'active.json'), JSON.stringify({
    schema_version: '2.0.0',
    run_id: 'run-statusline-fixture',
    objective: 'Statusline fixture',
    mode: 'phase',
    lane: 'fast',
    host: 'codex',
    status: 'running',
    stage: 'build',
    dispatch_state: 'none',
    tickets: [],
    receipts: [],
    expired_tickets: [],
    ...run,
  }));
}

describe('ape v2 statusline renderer', () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ape-statusline-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('degrades to model · dir outside APE projects — no APE box at all', () => {
    const out = stripAnsi(render({ workspace: { current_dir: dir }, model: { display_name: 'Opus' } }));
    expect(out).toContain('Opus');
    expect(out).toContain(basename(dir)); // basename is OS-agnostic; the renderer splits on / and \
    expect(out).not.toContain('APE');
  });

  it('keeps the identity box as APE idle in an APE project with no active run', () => {
    // The project owns .ape/ but nothing is running (no active.json).
    mkdirSync(join(dir, '.ape', 'runtime'), { recursive: true });
    const out = stripAnsi(render({ workspace: { current_dir: dir }, model: { display_name: 'Opus' } }));
    expect(out).toContain('APE idle');
    // No run: none of the run-only readouts render.
    expect(out).not.toContain('█');
    expect(out).not.toContain('BLOCK');
  });

  it('renders the active run mode/lane/stage/status', () => {
    writeActive(dir, {
      mode: 'phase',
      lane: 'full',
      status: 'running',
      stage: 'build',
      tickets: [],
      receipts: [],
    });
    const out = stripAnsi(render({ workspace: { current_dir: dir }, model: { display_name: 'Opus' } }));
    expect(out).toContain('APE');
    expect(out).toContain('phase/full');
    expect(out).toContain('build');
    // Status is carried by colour, not the word "running"; the stage-initials
    // strip trails the stage box (P T B R G M = the full-lane pipeline).
    expect(out).toContain('P T B R G M');
  });

  it.each([
    ['plan-replan', 'full', 'plan'],
    ['test-reconcile', 'fast', 'test'],
    ['test-recheck', 'fast', 'test'],
  ])('renders active %s as the %s milestone without a corrupt/unknown fallback', (stage, lane, milestone) => {
    writeActive(dir, {
      lane,
      stage,
      tickets: [{ ticket_id: `ticket-${stage}`, stage_id: stage, role:
        stage === 'plan-replan' ? 'planner' : stage === 'test-recheck' ? 'test_writer' : 'reviewer' }],
    });
    const out = stripAnsi(render({ workspace: { current_dir: dir } }));
    expect(out).toContain(milestone);
    expect(out).not.toContain('corrupt_state');
    expect(out).not.toContain('unknown');
  });

  it('carries in-progress state without any glyph — no loading mark, spinner, pending marker, or check', () => {
    writeActive(dir, {
      mode: 'phase',
      lane: 'fast',
      status: 'running',
      stage: 'test',
      tickets: [
        { ticket_id: 't1', stage_id: 'test', role: 'test_writer' },
        { ticket_id: 't2', stage_id: 'test', role: 'test_writer' },
      ],
      receipts: [{ ticket_id: 't1', status: 'passed' }],
    });
    const out = stripAnsi(render({ workspace: { current_dir: dir } }));
    // The fast lane displays a three-milestone strip: test/build/review.
    expect(out).toContain('T B R');
    // In progress is carried by the stage box colour and the strip alone —
    // no loading glyph, no check…
    expect(out).not.toContain('⟳');
    expect(out).not.toContain('✓');
    // …and neither the animated braille spinner nor the pending-ticket
    // hourglass survives (pending now lives only in status.md).
    expect(out).not.toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
    expect(out).not.toContain('⧗');
  });

  it('shows a check (not a loading glyph) only at full completion', () => {
    writeActive(dir, {
      mode: 'phase',
      lane: 'fast',
      status: 'completed',
      stage: 'complete',
      tickets: [],
      receipts: [],
    });
    const out = stripAnsi(render({ workspace: { current_dir: dir } }));
    expect(out).toContain('T B R');
    expect(out).toContain('✓');
    expect(out).not.toContain('⟳');
    // A completed run pins the bar full regardless of any timing estimate.
    expect(out).toContain('█'.repeat(8));
  });

  it.each([
    ['absent', undefined],
    ['not returned', {
      status: 'retained',
      base_branch: 'main',
      run_branch: 'ape/phase-terminal-cleanup',
      retained: true,
      deleted: false,
    }],
  ])('projects ape_run resume in root and packaged statuslines when terminal cleanup is %s', (_label, cleanup) => {
    writeActive(dir, {
      status: 'completed',
      stage: 'completed',
      base_branch: 'main',
      branch: 'ape/phase-terminal-cleanup',
      ...(cleanup === undefined ? {} : { checkout_cleanup: cleanup }),
    });
    const outputRoot = join(dir, 'packages');
    execFileSync('node', [PACKAGE_BUILDER, '--output-root', outputRoot], { encoding: 'utf8' });
    const payload = { workspace: { current_dir: dir } };
    const rootLine = stripAnsi(renderProgram(RENDERER, payload));
    const packagedLine = stripAnsi(renderProgram(
      join(outputRoot, 'ape-claude', 'bin', 'ape-statusline.mjs'),
      payload,
    ));
    for (const line of [rootLine, packagedLine]) {
      expect(line).toContain('ape_run resume');
      expect(line).not.toContain('ape_run start');
    }
  }, 30_000);

  it('shows the land pipeline strip (R G M) — mode outranks the classified lane', () => {
    // classifyLane never yields 'land': a land run carries fast/full/
    // mechanical, and the lane arms would paint T/B marks for stages the
    // review-only land pipeline never had.
    writeActive(dir, {
      mode: 'land',
      lane: 'fast',
      status: 'running',
      stage: 'review',
      tickets: [],
      receipts: [],
    });
    const out = stripAnsi(render({ workspace: { current_dir: dir } }));
    expect(out).toContain('R G M');
    expect(out).not.toContain('T B R');
  });

  it('shows honest fast-lane progress at gates via the global-order fallback (F30)', () => {
    writeActive(dir, {
      mode: 'phase',
      lane: 'fast',
      status: 'running',
      stage: 'gates',
      tickets: [],
      receipts: [],
    });
    const out = stripAnsi(render({ workspace: { current_dir: dir } }));
    // gates is not a displayed fast-lane milestone; all three displayed
    // milestones (test/build/review) rank before it, so the strip shows and
    // the bar pins full — not the step-0 fallback.
    expect(out).toContain('T B R');
    expect(out).toContain('█'.repeat(8));
    expect(out).toContain('gates');
    // Still running: no completion check.
    expect(out).not.toContain('✓');
  });

  it('fills the mechanical bar completely once the run reaches gates (F30)', () => {
    writeActive(dir, {
      mode: 'phase',
      lane: 'mechanical',
      status: 'running',
      stage: 'gates',
      tickets: [],
      receipts: [],
    });
    const out = stripAnsi(render({ workspace: { current_dir: dir } }));
    // build (the only displayed milestone) is behind gates, so the 8-cell bar
    // is full rather than frozen half-filled.
    expect(out).toContain('█'.repeat(8));
  });

  it('starts the time-fill bar empty at a fresh stage transition', () => {
    writeActive(dir, {
      mode: 'phase',
      lane: 'mechanical',
      status: 'running',
      stage: 'build',
      updated_at: new Date().toISOString(), // stage just began
      tickets: [],
      receipts: [],
    });
    const out = stripAnsi(render({ workspace: { current_dir: dir } }));
    // build is the only displayed milestone and no time has elapsed: the
    // intra-stage estimate is ~0, so no full cell is painted yet.
    expect(out).not.toContain('█');
  });

  it('creeps the bar with time spent in the stage, but never fills it (asymptotic cap)', () => {
    writeActive(dir, {
      mode: 'phase',
      lane: 'mechanical',
      status: 'running',
      stage: 'build',
      // Deep into the stage: many multiples of any median. The estimate
      // saturates at the 95% cap — visibly near-full but never complete.
      updated_at: new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString(),
      tickets: [],
      receipts: [],
    });
    const out = stripAnsi(render({ workspace: { current_dir: dir } }));
    expect(out).toMatch(/█{7}/);
    expect(out).not.toContain('█'.repeat(8));
  });

  it('never retreats when a passed sub-stage transition bumps updated_at inside one milestone', () => {
    // plan → plan-check → plan-critic all map to the 'plan' milestone. The
    // runtime bumps updated_at at every persisted transition, so anchoring the
    // creep there reset the bar to the slice start each time a planning
    // sub-stage PASSED. The anchor must be the milestone entry — the earliest
    // receipt started_at within the milestone — not the last state write.
    const now = Date.now();
    writeActive(dir, {
      mode: 'phase',
      lane: 'full',
      status: 'running',
      stage: 'plan-critic',
      updated_at: new Date(now).toISOString(), // sub-stage transition just persisted
      tickets: [],
      receipts: [{
        // The planner receipt: the plan milestone began an hour ago, and its
        // 10s duration calibrates the plan median so the creep saturates.
        ticket_id: 'run-1:plan:x',
        status: 'passed',
        timing: {
          started_at: new Date(now - 3600 * 1000).toISOString(),
          completed_at: new Date(now - 3590 * 1000).toISOString(),
        },
      }],
    });
    const out = stripAnsi(render({ workspace: { current_dir: dir } }));
    // An hour deep into a ~10s-median milestone the creep is saturated at 95%
    // of the first of six slices: at least one full cell paints (the old
    // updated_at anchor rendered none), but never two — the bar must not
    // claim the plan/test boundary it hasn't crossed.
    expect(out).toContain('█');
    expect(out).not.toContain('██');
  });

  it('calibrates the intra-stage estimate from historical receipt timings', () => {
    // History says build takes ~10s in this project; the active run has been
    // in build for 60s (6 medians deep → estimate saturates at the cap).
    // Against the static default median (480s) the same 60s would paint no
    // full cell at all, so a near-full bar proves the history was read.
    const hist = join(dir, '.ape', 'runtime', 'history');
    mkdirSync(hist, { recursive: true });
    writeFileSync(join(hist, 'run-1.json'), JSON.stringify({
      receipts: [{
        ticket_id: 'run-1:build:x',
        timing: { started_at: '2026-01-01T00:00:00Z', completed_at: '2026-01-01T00:00:10Z' },
      }],
    }));
    writeActive(dir, {
      mode: 'phase',
      lane: 'mechanical',
      status: 'running',
      stage: 'build',
      updated_at: new Date(Date.now() - 60 * 1000).toISOString(),
      tickets: [],
      receipts: [],
    });
    const out = stripAnsi(render({ workspace: { current_dir: dir } }));
    expect(out).toMatch(/█{7}/);
    expect(out).not.toContain('█'.repeat(8));
  });

  it('renders per-milestone glyphs in the strip on the nerdfont charset', () => {
    writeActive(dir, {
      mode: 'phase',
      lane: 'full',
      status: 'running',
      stage: 'build',
      tickets: [],
      receipts: [],
    });
    const out = stripAnsi(render({ workspace: { current_dir: dir } }, 'nerdfont'));
    // pencil / flask / wrench / eye / shield / rocket — one mark per milestone.
    for (const cp of [0xf040, 0xf0c3, 0xf0ad, 0xf06e, 0xf132, 0xf135]) {
      expect(out).toContain(String.fromCodePoint(cp));
    }
    // The strip is the ONLY place stage glyphs live: the boxes carry no stage
    // icon (build = wrench appears exactly once) and no loading mark.
    expect(out.match(new RegExp(String.fromCodePoint(0xf0ad), 'g'))).toHaveLength(1);
    expect(out).not.toContain(String.fromCodePoint(0xf110));
    // The unicode tier keeps the font-independent initials.
    expect(out).not.toContain('P T B R G M');
  });

  it('paints the running bar in the neutral fg colour, not the milestone hue', () => {
    writeActive(dir, {
      mode: 'phase',
      lane: 'full',
      status: 'running',
      stage: 'build',
      updated_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(), // cells painted
      tickets: [],
      receipts: [],
    });
    const raw = render({ workspace: { current_dir: dir } }, 'unicode', {
      // Pin truecolor so the colour bytes are deterministic.
      COLORTERM: 'truecolor',
    });
    // Bar fill opens with tokyo-night fg (#c0caf5) ahead of its █ cells…
    expect(raw).toMatch(/38;2;192;202;245m█/);
    // …never the build-stage green the box uses.
    expect(raw).not.toMatch(/38;2;158;206;106m█/);
  });

  it('freezes the bar estimate while blocked', () => {
    writeActive(dir, {
      mode: 'phase',
      lane: 'mechanical',
      status: 'blocked',
      stage: 'build',
      block_reason: 'stage build failed twice',
      // Long since the block was persisted: a running run would have crept
      // to the cap, a blocked one must not pretend progress.
      updated_at: new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString(),
      tickets: [],
      receipts: [],
    });
    const out = stripAnsi(render({ workspace: { current_dir: dir } }));
    expect(out).not.toContain('█');
    expect(out).toContain('BLOCK');
  });

  it('renders an aborted run as a sealed ABORT box — a state-coloured stage strip, no moving bar, no reason', () => {
    writeActive(dir, {
      mode: 'phase',
      lane: 'full',
      status: 'aborted',
      // The runtime seals an abort with the literal stage 'aborted'. The
      // displayed milestone list derives from mode/lane alone, so a UNIFORMLY
      // coloured strip anchors to no milestone and asserts no done/current
      // boundary; a bar would still fabricate a position, so it stays dropped.
      stage: 'aborted',
      abort_reason: 'operator override: wrong ticket',
      // Long since the abort was persisted: the old fallthrough treated this
      // as a running stage and crept the bar toward the cap.
      updated_at: new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString(),
      tickets: [],
      receipts: [],
    });
    const out = stripAnsi(render({ workspace: { current_dir: dir } }));
    expect(out).toContain('ABORT');
    // The statusline is not the record of the reason: the full text lives in
    // `ape_run action: status` (status.md renders no abort reason).
    expect(out).not.toContain('wrong ticket');
    expect(out).not.toContain('█'); // no bar at all — nothing is progressing
    expect(out).toContain('P T B R G M'); // the full-lane strip, painted in the abort colour
  });

  it('prefers workspace.project_dir over current_dir so the run segment survives cd (F6)', () => {
    writeActive(dir, {
      mode: 'phase',
      lane: 'full',
      status: 'running',
      stage: 'build',
      tickets: [],
      receipts: [],
    });
    const sub = join(dir, 'nested', 'deeper');
    mkdirSync(sub, { recursive: true });
    // Session cd'd into a subdirectory: current_dir drifts but project_dir
    // still names the root that owns .ape/runtime.
    const out = stripAnsi(render({ workspace: { project_dir: dir, current_dir: sub } }));
    expect(out).toContain('APE');
    expect(out).toContain('phase/full');
  });

  it('walks up from a drifted current_dir to the nearest .ape root when the host omits project_dir (F6)', () => {
    writeActive(dir, {
      mode: 'phase',
      lane: 'full',
      status: 'running',
      stage: 'build',
      tickets: [],
      receipts: [],
    });
    const sub = join(dir, 'nested', 'deeper');
    mkdirSync(sub, { recursive: true });
    // No project_dir in the payload: the renderer must resolve the project
    // root the same way the hook does — walk up from current_dir to the
    // nearest ancestor holding .ape/ — instead of going blank off-root.
    const out = stripAnsi(render({ workspace: { current_dir: sub } }));
    expect(out).toContain('APE');
    expect(out).toContain('phase/full');
  });

  it('keeps the run segment when workspace.project_dir pins a subdirectory (pin-seeded walk)', () => {
    writeActive(dir, {
      mode: 'phase',
      lane: 'full',
      status: 'running',
      stage: 'build',
      tickets: [],
      receipts: [],
    });
    const sub = join(dir, 'nested', 'deeper');
    mkdirSync(sub, { recursive: true });
    // Hosts pin the *launch* dir: a session opened in a subdirectory reports
    // project_dir=sub even though the root owns .ape/runtime. The pin seeds
    // the marker walk instead of being trusted verbatim, so the segment must
    // render the root's run rather than going blank.
    const out = stripAnsi(render({ workspace: { project_dir: sub, current_dir: sub } }));
    expect(out).toContain('APE');
    expect(out).toContain('phase/full');
  });

  it('honors a CLAUDE_PROJECT_DIR pin naming a subdirectory when the payload omits project_dir', () => {
    writeActive(dir, {
      mode: 'phase',
      lane: 'full',
      status: 'running',
      stage: 'build',
      tickets: [],
      receipts: [],
    });
    const sub = join(dir, 'nested', 'deeper');
    mkdirSync(sub, { recursive: true });
    const neutral = mkdtempSync(join(tmpdir(), 'ape-statusline-neutral-'));
    try {
      // Payload carries only a drifted current_dir outside the project; the
      // env pin — always present in a real Claude session — must still govern
      // via the same shared walk-up the hook and MCP server use.
      const out = stripAnsi(render(
        { workspace: { current_dir: neutral } },
        'unicode',
        { CLAUDECODE: '1', CLAUDE_PROJECT_DIR: sub },
      ));
      expect(out).toContain('APE');
      expect(out).toContain('phase/full');
    } finally {
      rmSync(neutral, { recursive: true, force: true });
    }
  });

  it('uses only the active host project pin in a mixed environment', () => {
    writeActive(dir, {
      mode: 'phase', lane: 'full', status: 'running', stage: 'build', tickets: [], receipts: [],
    });
    const foreign = mkdtempSync(join(tmpdir(), 'ape-statusline-foreign-'));
    try {
      const claude = stripAnsi(render(
        { workspace: { current_dir: foreign } },
        'unicode',
        // The renderer is a Claude-only adapter and pins that host explicitly,
        // even if a manually wired shell omitted the marker and retained a
        // stale Codex root.
        { CLAUDE_PROJECT_DIR: dir, CODEX_CWD: foreign },
      ));
      expect(claude).toContain('phase/full');
    } finally {
      rmSync(foreign, { recursive: true, force: true });
    }
  });

  it('carries a block by the state box and strip colour alone — never the block reason text', () => {
    writeActive(dir, {
      mode: 'phase',
      lane: 'full',
      status: 'blocked',
      stage: 'security-review',
      block_reason: 'stage security-review failed twice',
      tickets: [],
      receipts: [],
    });
    const out = stripAnsi(render({ workspace: { current_dir: dir } }));
    expect(out).toContain('BLOCK'); // Option C: blocked state reads as a yellow BLOCK box
    // The reason never renders here — the full text lives in `ape_run action:
    // status` and the .ape/runtime/status.md projection.
    expect(out).not.toContain('security-review failed twice');
  });

  it('renders the shared failed-gate reason, action, and durable failed identifiers', () => {
    writeActive(dir, {
      mode: 'phase',
      lane: 'fast',
      status: 'blocked',
      stage: 'gates',
      gates: {
        passed: false,
        checks: {
          typecheck: { passed: false },
          tests: { passed: true },
        },
      },
      tickets: [],
      receipts: [],
    });
    const out = stripAnsi(render({ workspace: { current_dir: dir } }));
    expect(out).toContain('gate_failed');
    expect(out).toContain('ape_run regate');
    expect(out).toContain('typecheck');
    expect(out.length).toBeLessThan(1024);
  });

  it('degrades malformed nested runtime collections to a bounded corrupt-state diagnostic', () => {
    writeActive(dir, {
      schema_version: '2.0.0',
      run_id: 'run-malformed-statusline',
      mode: 'phase',
      lane: 'fast',
      status: 'running',
      stage: 'build',
      tickets: [],
      receipts: {},
    });
    const out = stripAnsi(render({ workspace: { current_dir: dir } }));
    expect(out).toContain('corrupt_state');
    expect(out).toContain('ape_run override reset');
    expect(out.length).toBeLessThan(1024);
  });

  it('renders corrupt blocked-looking state as CORRUPT without a blocked progress claim', () => {
    writeActive(dir, {
      schema_version: 'invalid',
      status: 'blocked',
      stage: 'build',
      tickets: [],
      receipts: [],
    });
    const out = stripAnsi(render({ workspace: { current_dir: dir } }));
    expect(out).toContain('CORRUPT');
    expect(out).toContain('corrupt_state');
    expect(out).toContain('ape_run override reset');
    expect(out).not.toContain('BLOCK');
    expect(out).not.toContain('█');
    expect(out).not.toContain('T B R');
  });

  it.each([
    ['schema_version', 'PRIVATE_ROOT_STATUSLINE_SCHEMA'],
    ['mode', 'PRIVATE_ROOT_STATUSLINE_MODE'],
    ['lane', 'PRIVATE_ROOT_STATUSLINE_LANE'],
    ['status', 'PRIVATE_ROOT_STATUSLINE_STATUS'],
    ['stage', 'PRIVATE_ROOT_STATUSLINE_STAGE'],
    ['host', 'PRIVATE_ROOT_STATUSLINE_HOST'],
    ['dispatch_state', 'PRIVATE_ROOT_STATUSLINE_DISPATCH'],
  ])('validates %s before rendering the root statusline and never echoes its invalid value', (field, secret) => {
    writeActive(dir, { [field]: secret, objective: 'PRIVATE_ROOT_STATUSLINE_OBJECTIVE' });
    const out = stripAnsi(render({ workspace: { current_dir: dir } }));
    expect(out).toContain('corrupt_state');
    expect(out).toContain('ape_run override reset');
    expect(out).not.toContain(secret);
    expect(out).not.toContain('PRIVATE_ROOT_STATUSLINE_OBJECTIVE');
    expect(out.length).toBeLessThan(1024);
  });

  it('rejects missing and safe-looking noncanonical run IDs even without a schema marker', () => {
    const runtime = join(dir, '.ape', 'runtime');
    mkdirSync(runtime, { recursive: true });
    for (const state of [
      { mode: 'phase', lane: 'fast', status: 'running', stage: 'build', tickets: [], receipts: [] },
      { run_id: 'foo', mode: 'phase', lane: 'fast', status: 'running', stage: 'build', tickets: [], receipts: [] },
    ]) {
      writeFileSync(join(runtime, 'active.json'), JSON.stringify(state));
      const out = stripAnsi(render({ workspace: { current_dir: dir } }));
      expect(out).toContain('corrupt_state');
      expect(out).toContain('ape_run override reset');
      expect(out).not.toContain('stage_active');
      expect(out.length).toBeLessThan(1024);
    }
  });

  it('derives pending, live, and stopped dispatch truth during a later build stage', () => {
    const ticketId = 'run-later-dispatch:build:ticket';
    const runtime = join(dir, '.ape', 'runtime');
    const intents = join(runtime, 'dispatch-intents');
    const state = {
      run_id: 'run-later-dispatch',
      mode: 'phase',
      lane: 'fast',
      host: 'claude',
      status: 'running',
      stage: 'build',
      tickets: [{ ticket_id: ticketId, stage_id: 'build', role: 'implementer' }],
      receipts: [],
      expired_tickets: [],
    };
    writeActive(dir, state);
    expect(stripAnsi(render({ workspace: { current_dir: dir } }))).toContain('dispatch_pending');

    mkdirSync(intents, { recursive: true });
    writeFileSync(join(runtime, 'active.lock'), JSON.stringify({
      version: 1,
      run_id: state.run_id,
      host: hostname(),
      pid: process.pid,
      acquired_at: new Date().toISOString(),
      nonce: '12345678-1234-4234-8234-123456789abc',
    }));
    const intentFile = join(intents, createHash('sha256').update(ticketId).digest('hex') + '.json');
    const bound = {
      version: 2,
      host: 'claude',
      run_id: state.run_id,
      ticket_id: ticketId,
      ticket_hash: 'a'.repeat(64),
      agent_type: 'implementer',
      nonce_hash: 'b'.repeat(64),
      status: 'bound',
      prepared_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      launch_attempts: 1,
      parent_session_id: 'session-statusline',
      tool_use_id: 'tool-statusline',
      launched_at: new Date().toISOString(),
      launch_expires_at: new Date(Date.now() + 30_000).toISOString(),
      bound_agent_id: 'agent-statusline',
      capability_hash: 'c'.repeat(64),
      bound_at: new Date().toISOString(),
    };
    writeFileSync(intentFile, JSON.stringify(bound));
    expect(stripAnsi(render({ workspace: { current_dir: dir } }))).toContain('dispatch_live');

    writeFileSync(intentFile, JSON.stringify({
      ...bound,
      agent_stopped_at: new Date().toISOString(),
    }));
    expect(stripAnsi(render({ workspace: { current_dir: dir } }))).toContain('dispatch_stopped');
  });

  it('recognizes a real Codex bound intent carrying launch_name_hash instead of nonce_hash', () => {
    const ticketId = 'run-codex-bound-statusline:build:ticket';
    const runtime = join(dir, '.ape', 'runtime');
    const intents = join(runtime, 'dispatch-intents');
    writeActive(dir, {
      run_id: 'run-codex-bound-statusline',
      host: 'codex',
      status: 'running',
      stage: 'build',
      dispatch_state: 'none',
      tickets: [{ ticket_id: ticketId, stage_id: 'build', role: 'implementer' }],
      receipts: [],
      expired_tickets: [],
    });
    mkdirSync(intents, { recursive: true });
    writeFileSync(join(runtime, 'active.lock'), JSON.stringify({
      version: 1,
      run_id: 'run-codex-bound-statusline',
      host: hostname(),
      pid: process.pid,
      acquired_at: new Date().toISOString(),
      nonce: '12345678-1234-4234-8234-123456789abc',
    }));
    const intentFile = join(intents, createHash('sha256').update(ticketId).digest('hex') + '.json');
    writeFileSync(intentFile, JSON.stringify({
      version: 2,
      host: 'codex',
      run_id: 'run-codex-bound-statusline',
      ticket_id: ticketId,
      ticket_hash: 'a'.repeat(64),
      agent_type: 'implementer',
      launch_name_hash: 'b'.repeat(64),
      status: 'bound',
      prepared_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      launch_attempts: 1,
      parent_session_id: 'parent-codex-statusline',
      launched_at: new Date().toISOString(),
      launch_expires_at: new Date(Date.now() + 30_000).toISOString(),
      bound_session_id: 'child-codex-statusline',
      bound_agent_id: 'agent-codex-statusline',
      capability_hash: 'c'.repeat(64),
      bound_at: new Date().toISOString(),
    }));

    const out = stripAnsi(render({ workspace: { current_dir: dir } }));
    expect(out).toContain('dispatch_live');
    expect(out).not.toContain('dispatch_pending');
  });

  it('classifies oversized dispatch collections before probing intent files', () => {
    writeActive(dir, {
      run_id: 'run-oversized-dispatch',
      mode: 'phase',
      lane: 'fast',
      host: 'claude',
      status: 'running',
      stage: 'build',
      tickets: Array.from({ length: 2000 }, (_, index) => ({
        ticket_id: `run-oversized-dispatch:build:${index}`,
        stage_id: 'build',
        role: 'implementer',
      })),
      receipts: [],
      expired_tickets: [],
    });
    const out = stripAnsi(render({ workspace: { current_dir: dir } }));
    expect(out).toContain('corrupt_state');
    expect(out).toContain('ape_run override reset');
    expect(out).not.toContain('dispatch_pending');
    expect(out.length).toBeLessThan(1024);
  });

  it('does not render repository path or branch identity in an APE statusline', () => {
    const bidi = String.fromCharCode(0x202e);
    const repoSentinel = `PRIVATE_REPOSITORY_SENTINEL_${bidi}${'r'.repeat(180)}`;
    const project = join(dir, repoSentinel);
    mkdirSync(project, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: project });
    const branchSentinel = [
      `PRIVATE_BRANCH_SENTINEL_${bidi}${'a'.repeat(180)}`,
      'b'.repeat(180),
      'c'.repeat(180),
      'd'.repeat(180),
      'e'.repeat(180),
    ].join('/');
    execFileSync('git', ['checkout', '-qb', branchSentinel], { cwd: project });
    writeActive(project, {
      schema_version: '2.0.0',
      run_id: 'run-private-repository-statusline',
      mode: 'phase',
      lane: 'fast',
      status: 'running',
      stage: 'build',
      tickets: [],
      receipts: [],
    });

    const out = stripAnsi(render({ workspace: { current_dir: project } }));
    expect(out).not.toContain('PRIVATE_REPOSITORY_SENTINEL');
    expect(out).not.toContain('PRIVATE_BRANCH_SENTINEL');
    expect(out).not.toContain(bidi);
    expect(out.length).toBeLessThan(1024);
  });

  it('shows the context-window gauge from the payload', () => {
    const out = stripAnsi(render({
      workspace: { current_dir: dir },
      model: { display_name: 'Opus' },
      context_window: { used_percentage: 42, total_tokens: 1_000_000 },
    }));
    expect(out).toContain('42%');
    expect(out).toContain('Opus (1M)'); // context-window size label
  });

  it('shows the gauge at 0% when the host reports no context usage', () => {
    const out = stripAnsi(render({ workspace: { current_dir: dir }, model: { display_name: 'Opus' } }));
    expect(out).toContain('0%');
  });

  it('never throws on malformed stdin', () => {
    const out = execFileSync('node', [RENDERER], { input: 'not json', encoding: 'utf8' });
    expect(typeof out).toBe('string');
  });

  // --- history-samples cache (audit: the 1s wired cadence re-parsed 20 full
  // history records — complete tickets[] and receipts[] — on every render) ---

  const CACHE = () => join(dir, '.ape', 'runtime', 'statusline-cache.json');

  // One history record whose build stage took `seconds`; mtime normalized to
  // whole milliseconds so key comparisons never chase sub-ms fs precision.
  function writeHistoryRecord(name, seconds) {
    const hist = join(dir, '.ape', 'runtime', 'history');
    mkdirSync(hist, { recursive: true });
    const file = join(hist, name);
    writeFileSync(file, JSON.stringify({
      receipts: [{
        ticket_id: 'run-h:build:x',
        timing: {
          started_at: '2026-01-01T00:00:00Z',
          completed_at: new Date(Date.parse('2026-01-01T00:00:00Z') + seconds * 1000).toISOString(),
        },
      }],
    }));
    const stamp = new Date(Math.floor(Date.now() / 1000) * 1000);
    utimesSync(file, stamp, stamp);
    return file;
  }

  function activeBuildRun(secondsInStage = 60) {
    writeActive(dir, {
      mode: 'phase',
      lane: 'mechanical',
      status: 'running',
      stage: 'build',
      updated_at: new Date(Date.now() - secondsInStage * 1000).toISOString(),
      tickets: [],
      receipts: [],
    });
  }

  it('writes a history-samples cache keyed on the history listing', () => {
    const file = writeHistoryRecord('run-1.json', 10);
    activeBuildRun();
    const out = stripAnsi(render({ workspace: { current_dir: dir } }));
    // 60s into build against a 10s historical median: near-full bar proves
    // the history was parsed (the 480s default would paint no full cell).
    expect(out).toMatch(/█{7}/);
    const cache = JSON.parse(readFileSync(CACHE(), 'utf8'));
    expect(cache.version).toBe(1);
    expect(cache.key).toEqual({
      count: 1,
      newest: 'run-1.json',
      newest_mtime_ms: statSync(file).mtimeMs,
    });
    expect(cache.samples).toEqual({ build: [10] });
  });

  it('serves cached samples while the history listing is unchanged', () => {
    const file = writeHistoryRecord('run-1.json', 10);
    activeBuildRun();
    const first = stripAnsi(render({ workspace: { current_dir: dir } }));
    expect(first).toMatch(/█{7}/);
    // Rewrite the record with a wildly different duration but restore the
    // exact mtime: the key (count, newest, mtime) is unchanged, so a correct
    // cache serves the OLD samples without re-parsing. Immutable history
    // records make this divergence unreachable in production — the probe
    // exists purely to observe which source the renderer read.
    const before = statSync(file);
    writeHistoryRecord('run-1.json', 100_000);
    utimesSync(file, before.atime, before.mtime);
    const second = stripAnsi(render({ workspace: { current_dir: dir } }));
    expect(second).toMatch(/█{7}/); // still the cached 10s median
    expect(JSON.parse(readFileSync(CACHE(), 'utf8')).samples).toEqual({ build: [10] });
  });

  it('re-parses and rewrites the cache when a new history record lands', () => {
    writeHistoryRecord('run-1.json', 10);
    activeBuildRun();
    expect(stripAnsi(render({ workspace: { current_dir: dir } }))).toMatch(/█{7}/);
    // A superseding/new completion ADDS a file; the median flips to 100000s,
    // so 60s of elapsed build paints no full cell — stale cached samples
    // would keep the near-full bar.
    const newest = writeHistoryRecord('run-2.json', 100_000);
    const out = stripAnsi(render({ workspace: { current_dir: dir } }));
    expect(out).not.toContain('█'.repeat(7));
    const cache = JSON.parse(readFileSync(CACHE(), 'utf8'));
    expect(cache.key).toEqual({
      count: 2,
      newest: 'run-2.json',
      newest_mtime_ms: statSync(newest).mtimeMs,
    });
    expect(cache.samples).toEqual({ build: [10, 100_000] });
  });

  it('recovers from a corrupt cache: renders normally and rewrites it', () => {
    writeHistoryRecord('run-1.json', 10);
    activeBuildRun();
    writeFileSync(CACHE(), '{torn write');
    const out = stripAnsi(render({ workspace: { current_dir: dir } }));
    expect(out).toMatch(/█{7}/); // fresh parse still calibrated the bar
    const cache = JSON.parse(readFileSync(CACHE(), 'utf8'));
    expect(cache.samples).toEqual({ build: [10] });
  });

  it('rejects cached samples of an invalid shape and re-parses', () => {
    const file = writeHistoryRecord('run-1.json', 10);
    activeBuildRun();
    // Key matches but the samples are poisoned (a NaN would corrupt the bar
    // math): the renderer must fall back to a fresh parse and rewrite.
    writeFileSync(CACHE(), JSON.stringify({
      version: 1,
      key: { count: 1, newest: 'run-1.json', newest_mtime_ms: statSync(file).mtimeMs },
      samples: { build: ['not-a-number'] },
    }));
    const out = stripAnsi(render({ workspace: { current_dir: dir } }));
    expect(out).toMatch(/█{7}/);
    expect(JSON.parse(readFileSync(CACHE(), 'utf8')).samples).toEqual({ build: [10] });
  });

  it('creates no cache file when the project has no history directory', () => {
    activeBuildRun();
    const out = stripAnsi(render({ workspace: { current_dir: dir } }));
    expect(out).toContain('APE'); // rendered fine
    expect(existsSync(CACHE())).toBe(false);
  });

  it.skipIf(process.platform === 'win32')(
    'bounds gitBranch by APE_STATUSLINE_GIT_TIMEOUT_MS so a hung git never stalls the render',
    () => {
      // A PATH-shimmed git that hangs far past the render budget: without the
      // timeout the render blocks for the full sleep (the old gitBranch had
      // no bound, unlike gitStatus).
      const shim = mkdtempSync(join(tmpdir(), 'ape-slow-git-'));
      try {
        writeFileSync(join(shim, 'git'), '#!/bin/sh\nsleep 10\n', { mode: 0o755 });
        const startedAt = Date.now();
        const out = stripAnsi(render(
          { workspace: { current_dir: dir }, model: { display_name: 'Opus' } },
          'unicode',
          { PATH: `${shim}:${process.env.PATH}`, APE_STATUSLINE_GIT_TIMEOUT_MS: '150' },
        ));
        expect(Date.now() - startedAt).toBeLessThan(5000);
        expect(out).toContain('Opus'); // degraded render, never a stall/crash
      } finally {
        rmSync(shim, { recursive: true, force: true });
      }
    },
    20_000,
  );

  it('shows the branch with dirty/ahead markers for a git working tree', () => {
    const git = (...args) => execFileSync('git', ['-C', dir, ...args], {
      encoding: 'utf8',
      // Ignore stderr: some calls (e.g. the `@{u}` sanity probe on a branch with
      // no upstream) are expected to fail, and execFileSync forwards child stderr
      // to the parent by default, which leaks git `fatal:` lines into test output.
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
    });
    git('init', '-q', '-b', 'work');
    git('config', 'user.email', 't@t');
    git('config', 'user.name', 't');
    writeFileSync(join(dir, 'a.txt'), 'one');
    git('add', 'a.txt');
    git('commit', '-qm', 'init');
    // A bare "remote" the branch tracks, so an unpushed commit reads as ahead 1.
    const remote = mkdtempSync(join(tmpdir(), 'ape-remote-'));
    execFileSync('git', ['init', '-q', '--bare', remote]);
    git('remote', 'add', 'origin', remote);
    git('push', '-q', '-u', 'origin', 'work');
    writeFileSync(join(dir, 'b.txt'), 'two');
    git('add', 'b.txt');
    git('commit', '-qm', 'second'); // now ahead 1
    writeFileSync(join(dir, 'a.txt'), 'dirty'); // now also dirty

    const out = stripAnsi(render({ workspace: { current_dir: dir }, model: { display_name: 'Opus' } }));
    expect(out).toContain('work');
    expect(out).toContain('●'); // dirty
    expect(out).toContain('↑1'); // one unpushed commit
    rmSync(remote, { recursive: true, force: true });
  });

  it('shows unpushed commits as ↑N on a branch with no upstream', () => {
    const git = (...args) => execFileSync('git', ['-C', dir, ...args], {
      encoding: 'utf8',
      // Ignore stderr: some calls (e.g. the `@{u}` sanity probe on a branch with
      // no upstream) are expected to fail, and execFileSync forwards child stderr
      // to the parent by default, which leaks git `fatal:` lines into test output.
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
    });
    git('init', '-q', '-b', 'work');
    git('config', 'user.email', 't@t');
    git('config', 'user.name', 't');
    writeFileSync(join(dir, 'a.txt'), 'one');
    git('add', 'a.txt');
    git('commit', '-qm', 'init');
    const remote = mkdtempSync(join(tmpdir(), 'ape-remote-'));
    execFileSync('git', ['init', '-q', '--bare', remote]);
    git('remote', 'add', 'origin', remote);
    // Push WITHOUT -u: a remote-tracking ref now exists, but the branch has no
    // upstream — so git reports no "ahead" and the count must come from the
    // "commits on HEAD not on any remote" fallback.
    git('push', '-q', 'origin', 'work');
    writeFileSync(join(dir, 'b.txt'), 'two');
    git('add', 'b.txt');
    git('commit', '-qm', 'second'); // one local commit that is on no remote
    // Sanity: the branch really has no upstream configured.
    expect(() => git('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}')).toThrow();

    const out = stripAnsi(render({ workspace: { current_dir: dir }, model: { display_name: 'Opus' } }));
    expect(out).toContain('work');
    expect(out).toContain('↑1'); // surfaced despite no upstream
    rmSync(remote, { recursive: true, force: true });
  });

  it('shows the short commit SHA (not "HEAD") in detached-HEAD state', () => {
    const git = (...args) => execFileSync('git', ['-C', dir, ...args], {
      encoding: 'utf8',
      // Ignore stderr: some calls (e.g. the `@{u}` sanity probe on a branch with
      // no upstream) are expected to fail, and execFileSync forwards child stderr
      // to the parent by default, which leaks git `fatal:` lines into test output.
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
    });
    git('init', '-q', '-b', 'work');
    git('config', 'user.email', 't@t');
    git('config', 'user.name', 't');
    writeFileSync(join(dir, 'a.txt'), 'one');
    git('add', 'a.txt');
    git('commit', '-qm', 'init');
    // Detach HEAD by checking out the commit directly.
    const fullSha = git('rev-parse', 'HEAD').trim();
    git('checkout', '-q', fullSha);
    const shortSha = git('rev-parse', '--short', 'HEAD').trim();
    expect(shortSha).toMatch(/^[0-9a-f]{7,}$/); // sanity: real short SHA

    const out = stripAnsi(render({ workspace: { current_dir: dir }, model: { display_name: 'Opus' } }));
    // The branch segment should surface the short SHA, not the literal "HEAD".
    expect(out).toContain(shortSha);
    expect(out).not.toContain('HEAD');
  });

  it('keeps the last-known branch segment through a transient git timeout on a later render', () => {
    const git = (...args) => execFileSync('git', ['-C', dir, ...args], {
      encoding: 'utf8',
      // Ignore stderr: consistent with the other git-repo fixtures in this file.
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
    });
    git('init', '-q', '-b', 'work');
    git('config', 'user.email', 't@t');
    git('config', 'user.name', 't');
    writeFileSync(join(dir, 'a.txt'), 'one');
    git('add', 'a.txt');
    git('commit', '-qm', 'init');

    // Warm render: the real, fast git resolves the branch normally — this is
    // the "branch is otherwise knowable" precondition a correct fix retains.
    const warm = stripAnsi(render({ workspace: { current_dir: dir }, model: { display_name: 'Opus' } }));
    expect(warm).toContain('work');

    // Cold render, same project dir: a PATH-shimmed git that blocks well past
    // a tight timeout budget, simulating a transient spawn timeout (the
    // ETIMEDOUT kill gitBranch's catch swallows indistinguishably from a
    // non-repo). Portable across POSIX and Windows, so this Windows-facing
    // case is never skipped here.
    const shim = mkdtempSync(join(tmpdir(), 'ape-slow-git-'));
    try {
      if (process.platform === 'win32') {
        // A PATH entry with no extension resolves against PATHEXT (.CMD is
        // included by default); `ping` against localhost blocks without
        // needing a console/stdin, unlike `timeout.exe`.
        writeFileSync(join(shim, 'git.cmd'), '@echo off\r\nping -n 11 127.0.0.1 >nul\r\n');
      } else {
        writeFileSync(join(shim, 'git'), '#!/bin/sh\nsleep 10\n', { mode: 0o755 });
      }
      const pathSep = process.platform === 'win32' ? ';' : ':';
      const out = stripAnsi(render(
        { workspace: { current_dir: dir }, model: { display_name: 'Opus' } },
        'unicode',
        { PATH: `${shim}${pathSep}${process.env.PATH}`, APE_STATUSLINE_GIT_TIMEOUT_MS: '150' },
      ));
      // The branch is knowable (the warm render above proved it); a transient
      // git timeout on THIS render alone must not blank the segment.
      expect(out).toContain('work');
    } finally {
      rmSync(shim, { recursive: true, force: true });
    }
  }, 20_000);

  it('keeps the dirty marker through a transient git timeout on a later render, when known from a prior successful render', () => {
    const git = (...args) => execFileSync('git', ['-C', dir, ...args], {
      encoding: 'utf8',
      // Ignore stderr: consistent with the other git-repo fixtures in this file.
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
    });
    git('init', '-q', '-b', 'work');
    git('config', 'user.email', 't@t');
    git('config', 'user.name', 't');
    writeFileSync(join(dir, 'a.txt'), 'one');
    git('add', 'a.txt');
    git('commit', '-qm', 'init');
    // An untracked file makes the working tree dirty for both renders below.
    writeFileSync(join(dir, 'b.txt'), 'two');

    // Warm render: the real, fast git resolves both the branch and the dirty
    // status — this is the "markers are otherwise knowable" precondition a
    // correct fix retains, mirroring the branch-retention case above.
    const warm = stripAnsi(render({ workspace: { current_dir: dir }, model: { display_name: 'Opus' } }));
    expect(warm).toContain('work');
    expect(warm).toContain('●'); // dirty marker on the warm render

    // Later render, same project dir, same dirty tree: a PATH-shimmed git
    // that blocks well past a tight timeout budget, simulating a transient
    // spawn timeout (the ETIMEDOUT kill gitStatus's catch currently
    // swallows into a zeroed {dirty:false,...} indistinguishably from a
    // clean tree). Portable across POSIX and Windows, so this Windows-facing
    // case is never skipped here.
    const shim = mkdtempSync(join(tmpdir(), 'ape-slow-git-'));
    try {
      if (process.platform === 'win32') {
        // A PATH entry with no extension resolves against PATHEXT (.CMD is
        // included by default); `ping` against localhost blocks without
        // needing a console/stdin, unlike `timeout.exe`.
        writeFileSync(join(shim, 'git.cmd'), '@echo off\r\nping -n 11 127.0.0.1 >nul\r\n');
      } else {
        writeFileSync(join(shim, 'git'), '#!/bin/sh\nsleep 10\n', { mode: 0o755 });
      }
      const pathSep = process.platform === 'win32' ? ';' : ':';
      const out = stripAnsi(render(
        { workspace: { current_dir: dir }, model: { display_name: 'Opus' } },
        'unicode',
        { PATH: `${shim}${pathSep}${process.env.PATH}`, APE_STATUSLINE_GIT_TIMEOUT_MS: '150' },
      ));
      // The branch survives via its own cache; the dirty marker is equally
      // knowable from the warm render above, so a transient git timeout on
      // THIS render alone must not drop it either.
      expect(out).toContain('work');
      expect(out).toContain('●');
    } finally {
      rmSync(shim, { recursive: true, force: true });
    }
  }, 20_000);

  it('rejects a hostile negative ahead count from the markers cache — degrades to zeroed markers, never a negative glyph', () => {
    const git = (...args) => execFileSync('git', ['-C', dir, ...args], {
      encoding: 'utf8',
      // Ignore stderr: consistent with the other git-repo fixtures in this file.
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
    });
    git('init', '-q', '-b', 'work');
    git('config', 'user.email', 't@t');
    git('config', 'user.name', 't');
    writeFileSync(join(dir, 'a.txt'), 'one');
    git('add', 'a.txt');
    git('commit', '-qm', 'init');
    // A bare "remote" the branch tracks, so an unpushed commit reads as ahead 1.
    const remote = mkdtempSync(join(tmpdir(), 'ape-remote-'));
    execFileSync('git', ['init', '-q', '--bare', remote]);
    git('remote', 'add', 'origin', remote);
    git('push', '-q', '-u', 'origin', 'work');
    writeFileSync(join(dir, 'b.txt'), 'two');
    git('add', 'b.txt');
    git('commit', '-qm', 'second'); // now ahead 1
    writeFileSync(join(dir, 'a.txt'), 'dirty'); // now also dirty

    // A DEDICATED temp dir, pointed at via TMPDIR/TMP/TEMP so only this
    // test's branch/markers caches land there — never scan the shared
    // os.tmpdir() and never recompute the sha256(dir) cache filename.
    const cacheDir = mkdtempSync(join(tmpdir(), 'ape-markers-cache-'));
    try {
      const before = new Set(readdirSync(cacheDir));
      // Warm render: real git, the render()'s default (generous) git timeout —
      // production resolves the branch and status for real and writes BOTH
      // the branch cache and the markers cache into the dedicated dir.
      const warm = stripAnsi(render(
        { workspace: { current_dir: dir }, model: { display_name: 'Opus' } },
        'unicode',
        { TMPDIR: cacheDir, TMP: cacheDir, TEMP: cacheDir },
      ));
      expect(warm).toContain('work');
      expect(warm).toContain('↑1'); // precondition: a real, positive ahead count

      // Locate the markers cache file by a before/after readdirSync set-diff
      // of the dedicated dir — never by recomputing the hash.
      const after = readdirSync(cacheDir);
      const markersName = after.find((n) =>
        !before.has(n) && n.startsWith('ape-statusline-markers-') && n.endsWith('.json'));
      expect(markersName).toBeTruthy();
      const markersPath = join(cacheDir, markersName);
      const cached = JSON.parse(readFileSync(markersPath, 'utf8'));
      expect(cached.ahead).toBeGreaterThanOrEqual(1); // sanity: production wrote a real ahead count

      // Poison the cache: a hostile/corrupt writer sets a negative ahead.
      // Keep dirty/behind as production wrote them — only ahead is tampered.
      writeFileSync(markersPath, JSON.stringify({ ...cached, ahead: -5 }));

      // Cold render, same repo, same dedicated cache dir — but a tiny git
      // timeout. A real `git` spawn is GUARANTEED to exceed 1ms on every
      // platform, so both gitBranch and gitStatus are killed and fall back
      // to their caches deterministically. No slow-git PATH shim: that
      // approach does not reliably exceed the timeout on CI, letting the
      // real ahead:1 win and masking the poisoned cache.
      const cold = stripAnsi(render(
        { workspace: { current_dir: dir }, model: { display_name: 'Opus' } },
        'unicode',
        { TMPDIR: cacheDir, TMP: cacheDir, TEMP: cacheDir, APE_STATUSLINE_GIT_TIMEOUT_MS: '1' },
      ));
      expect(cold).toContain('work'); // branch still resolves, from its own cache
      // The poisoned negative ahead must degrade to zeroed markers — never
      // surface as a negative-count glyph.
      expect(cold).not.toContain('↑');
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
      rmSync(remote, { recursive: true, force: true });
    }
  }, 20_000);

  it('uses dispatch and lock artifacts only after regular-file, byte, shape, discriminator, number, and timestamp validation', () => {
    const ticketId = 'run-hostile-dispatch-artifacts:build:ticket';
    const runtime = join(dir, '.ape', 'runtime');
    const intents = join(runtime, 'dispatch-intents');
    const lockFile = join(runtime, 'active.lock');
    const intentFile = join(intents, createHash('sha256').update(ticketId).digest('hex') + '.json');
    writeActive(dir, {
      run_id: 'run-hostile-dispatch-artifacts',
      host: 'claude',
      status: 'running',
      stage: 'build',
      dispatch_state: 'none',
      tickets: [{ ticket_id: ticketId, stage_id: 'build', role: 'implementer' }],
      receipts: [],
      expired_tickets: [],
    });
    mkdirSync(intents, { recursive: true });

    const validLock = {
      version: 1,
      run_id: 'run-hostile-dispatch-artifacts',
      host: hostname(),
      pid: process.pid,
      acquired_at: new Date().toISOString(),
      nonce: '12345678-1234-4234-8234-123456789abc',
    };
    const validIntent = {
      version: 2,
      host: 'claude',
      run_id: 'run-hostile-dispatch-artifacts',
      ticket_id: ticketId,
      ticket_hash: 'a'.repeat(64),
      agent_type: 'implementer',
      nonce_hash: 'b'.repeat(64),
      status: 'bound',
      prepared_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      launch_attempts: 1,
      parent_session_id: 'session-statusline',
      tool_use_id: 'tool-statusline',
      launched_at: new Date().toISOString(),
      launch_expires_at: new Date(Date.now() + 30_000).toISOString(),
      bound_agent_id: 'agent-statusline',
      capability_hash: 'c'.repeat(64),
      bound_at: new Date().toISOString(),
    };
    const renderDiagnostic = () => stripAnsi(render({ workspace: { current_dir: dir } }));
    const reset = () => {
      rmSync(lockFile, { force: true });
      rmSync(intentFile, { force: true });
      writeFileSync(lockFile, JSON.stringify(validLock));
      writeFileSync(intentFile, JSON.stringify(validIntent));
    };

    reset();
    expect(renderDiagnostic()).toContain('dispatch_live');

    const intentCases = [
      ['array shape', JSON.stringify([validIntent])],
      ['version discriminator', JSON.stringify({ ...validIntent, version: 3 })],
      ['host discriminator', JSON.stringify({ ...validIntent, host: 'PRIVATE_INTENT_HOST' })],
      ['status discriminator', JSON.stringify({ ...validIntent, status: 'PRIVATE_INTENT_STATUS' })],
      ['negative launch attempts', JSON.stringify({ ...validIntent, launch_attempts: -1 })],
      ['fractional launch attempts', JSON.stringify({ ...validIntent, launch_attempts: 1.5 })],
      ['impossible expiry', JSON.stringify({ ...validIntent, expires_at: '2026-02-30T05:00:00.000Z' })],
      ['invalid stop time', JSON.stringify({ ...validIntent, agent_stopped_at: 'PRIVATE_STOP_TIME' })],
      ['oversized regular file', JSON.stringify(validIntent) + ' '.repeat(2 * 1024 * 1024)],
    ];
    for (const [label, bytes] of intentCases) {
      reset();
      writeFileSync(intentFile, bytes);
      const out = renderDiagnostic();
      expect(out, label).toContain('dispatch_pending');
      expect(out, label).not.toContain('dispatch_live');
      expect(out, label).not.toContain('dispatch_stopped');
      expect(out, label).not.toContain('PRIVATE_');
      expect(out.length, label).toBeLessThan(1024);
    }

    reset();
    const intentTarget = join(dir, 'intent-target.json');
    writeFileSync(intentTarget, JSON.stringify(validIntent));
    rmSync(intentFile);
    symlinkSync(intentTarget, intentFile);
    expect(renderDiagnostic()).toContain('dispatch_pending');

    const lockCases = [
      ['array shape', JSON.stringify([validLock])],
      ['version discriminator', JSON.stringify({ ...validLock, version: 2 })],
      ['negative pid', JSON.stringify({ ...validLock, pid: -1 })],
      ['fractional pid', JSON.stringify({ ...validLock, pid: 1.5 })],
      ['impossible acquired time', JSON.stringify({ ...validLock, acquired_at: '2026-02-30T05:00:00.000Z' })],
      ['oversized regular file', JSON.stringify(validLock) + ' '.repeat(2 * 1024 * 1024)],
    ];
    for (const [label, bytes] of lockCases) {
      reset();
      writeFileSync(lockFile, bytes);
      const out = renderDiagnostic();
      expect(out, label).toContain('dispatch_pending');
      expect(out, label).not.toContain('dispatch_live');
      expect(out, label).not.toContain('PRIVATE_');
      expect(out.length, label).toBeLessThan(1024);
    }

    reset();
    const lockTarget = join(dir, 'lock-target.json');
    writeFileSync(lockTarget, JSON.stringify(validLock));
    rmSync(lockFile);
    symlinkSync(lockTarget, lockFile);
    expect(renderDiagnostic()).toContain('dispatch_pending');

    reset();
    writeFileSync(intentFile, JSON.stringify({
      ...validIntent,
      agent_stopped_at: new Date().toISOString(),
    }));
    expect(renderDiagnostic()).toContain('dispatch_stopped');
  });

});
