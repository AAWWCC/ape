import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { beforeAll, describe, expect, it } from 'vitest';

// Closes roadmap entry `bundle-reachability-needs-rebuild-not-grep`. See the
// run objective for the full incident (run-fixture-494d93e8fd2f): a prior
// run declared `lib/runtime/runner.js` reached ONLY dist/ape-mcp.bundle.mjs by
// grepping the committed bundles for two chosen symbols. That method is
// invalid — esbuild tree-shakes, so an absent symbol proves only that ONE
// export is unused, never that the module is absent — and a plan-checker
// independently confirmed the false conclusion by reasoning from the stated
// premise rather than testing it. This suite pins the mechanical replacement,
// `scripts/bundle-reach.mjs`, against ground truth this suite computes itself
// via a fresh, out-of-tree esbuild rebuild — never against a memorised
// constant — exactly the discipline the aid exists to enforce.

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TOOL = path.join(REPO_ROOT, 'scripts', 'bundle-reach.mjs');

// Mirrors scripts/bundle-mcp.mjs's three entry points and their exact build
// options (bundle/platform/format/target/minifyWhitespace) — see that file's
// header comment. The reachability aid must answer the same question that
// script would produce a committed artifact for, so this suite's own ground
// truth is built with matching options, out-of-tree (`write: false`) so
// running this suite never touches dist/.
const ENTRIES = [
  { label: 'mcp', entry: 'bin/ape-mcp.mjs' },
  { label: 'hooks', entry: 'bin/ape-hook.mjs' },
  { label: 'larp', entry: 'bin/ape-larp.mjs' },
];

let metafiles;

beforeAll(async () => {
  metafiles = {};
  for (const { label, entry } of ENTRIES) {
    const result = await build({
      entryPoints: [path.join(REPO_ROOT, entry)],
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      minifyWhitespace: true,
      write: false,
      metafile: true,
      absWorkingDir: REPO_ROOT,
      logLevel: 'silent',
    });
    metafiles[label] = result.metafile;
  }
}, 30000);

/**
 * Ground truth for which entry-point bundles `sourceRelPath` contributes
 * bytes to, derived from THIS suite's own fresh rebuild's metafile
 * (`bytesInOutput`), never from grepping a committed artifact or copying a
 * prior run's stated conclusion — the exact distinction this ticket exists
 * to enforce.
 */
function reachedLabels(sourceRelPath) {
  const reached = [];
  for (const { label } of ENTRIES) {
    const metafile = metafiles[label];
    const [outputKey] = Object.keys(metafile.outputs);
    const info = metafile.outputs[outputKey].inputs[sourceRelPath];
    if (info && info.bytesInOutput > 0) reached.push(label);
  }
  return reached;
}

function runTool(args) {
  return spawnSync(process.execPath, [TOOL, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
}

// OUTPUT CONTRACT pinned by this suite, which any correct implementation of
// `scripts/bundle-reach.mjs` must satisfy: invoked as
// `node scripts/bundle-reach.mjs <source-path>` for a single, existing,
// in-repo source path, the tool exits 0 and writes a report to stdout that
// names — in any incidental formatting, matched case-insensitively by
// substring — every dist/ entry-point label ('mcp', 'hooks', 'larp') the path
// contributes bytes to, and names none of the labels it does not reach.
describe('bundle reachability aid (scripts/bundle-reach.mjs)', () => {
  it('reports larp for a lib/runtime/runner.js change and does not report hooks', () => {
    const target = 'lib/runtime/runner.js';

    // Ground truth, independently derived (see WHY THIS EXISTS in the run
    // objective): runner.js is pulled into the larp bundle via
    // bin/ape-larp.mjs -> lib/runtime/config.js -> lib/runtime/runner.js, and
    // runner.js's top-level `if (invokedAsGateRunner()) {...}` defeats
    // tree-shaking, so the whole module lands regardless of which export is
    // used. It also contributes to the mcp bundle (bin/ape-mcp.mjs also
    // imports lib/runtime/config.js). Nothing imports it on the path to the
    // hooks entry. Pin the FULL expected set (mcp AND larp, not hooks, in
    // ENTRIES order) rather than a partial substring check: docs/architecture.md
    // enshrines this as a two-part fact, and a check that only confirms
    // 'contains larp' / 'excludes hooks' would stay green even if the mcp half
    // silently went stale.
    const reached = reachedLabels(target);
    expect(reached).toEqual(['mcp', 'larp']);

    const result = runTool([target]);
    expect(result.status).toBe(0);
    const stdout = (result.stdout ?? '').toLowerCase();
    expect(stdout).toMatch(/mcp/);
    expect(stdout).toMatch(/larp/);
    expect(stdout).not.toMatch(/hooks/);
  });

  it('matches an independent out-of-tree rebuild for a hooks-only path (bin/ape-hook.mjs)', () => {
    const target = 'bin/ape-hook.mjs';

    // Sanity-check the fixture itself before relying on it: bin/ape-hook.mjs
    // is the hooks entry point's own source and is not imported by either of
    // the other two bin/ entries, so it must be reached by exactly the
    // 'hooks' build. If this ever stops holding, the fixture — not the aid —
    // needs to change; the assertion below fails loudly either way.
    const reached = reachedLabels(target);
    expect(reached).toEqual(['hooks']);

    const result = runTool([target]);
    expect(result.status).toBe(0);
    const stdout = (result.stdout ?? '').toLowerCase();
    // A lazy implementation that reports every artifact for every input would
    // pass a bare "mentions hooks" check; requiring the OTHER two labels be
    // absent catches it.
    expect(stdout).toMatch(/hooks/);
    expect(stdout).not.toMatch(/larp/);
    expect(stdout).not.toMatch(/mcp/);
  });
});

// USAGE-ERROR CONTRACT pinned by this suite (see the tool's own header,
// "Usage:" block): zero arguments, a nonexistent path, a path outside the
// repository, and a directory are each a usage error — exit non-zero with
// the message on stderr — rather than a silent "reaches no dist/ artifact"
// answer with exit 0. A silent exit-0 empty answer is exactly the false
// confidence the parent roadmap entry (and this whole aid) exists to remove:
// a run author reads it as "no dist claim needed" and omits a claim they in
// fact need. See DEFECT (a) in the run objective.
describe('bundle reachability aid: usage errors fail loudly, never silently', () => {
  it('refuses zero arguments with a non-zero exit and no reachability report', () => {
    const result = runTool([]);
    expect(result.status).not.toBe(0);
    const stdout = (result.stdout ?? '').toLowerCase();
    expect(stdout).not.toMatch(/reaches|dist\//);
  });

  it('refuses a nonexistent path with a non-zero exit and no reachability report', () => {
    const target = 'lib/runtime/this-file-does-not-exist-for-bundle-reach.js';
    const result = runTool([target]);
    expect(result.status).not.toBe(0);
    const stdout = (result.stdout ?? '').toLowerCase();
    expect(stdout).not.toMatch(/reaches|dist\//);
  });

  it('refuses a path outside the repository with a non-zero exit that names its own cause', () => {
    // process.execPath is an existing regular file that is outside the
    // repository on every host, so this arm exercises the exists-but-outside
    // case the outside-repo guard actually protects: a fixture that does not
    // exist would satisfy this arm just as well via the nonexistent-path
    // guard, which proves nothing about the outside-repository guard
    // specifically (removing that guard would still leave the tool refusing
    // via the nonexistent-path branch for a fixture that never existed).
    const target = process.execPath;
    const result = runTool([target]);
    expect(result.status).not.toBe(0);
    const stdout = (result.stdout ?? '').toLowerCase();
    expect(stdout).not.toMatch(/reaches|dist\//);

    // Pin WHICH refusal fired: without this, deleting the outside-repo guard
    // still passes this arm (statSync on an existing, in-fact-outside path
    // would then succeed and isFile() would pass too, producing a silent
    // exit-0 "reaches no dist/ artifact" answer for stdout, which the stdout
    // assertion above already forbids) or — for a fixture that does not
    // exist — the nonexistent-path guard supplies the same non-zero exit and
    // empty stdout, masking the outside-repo usage-error class entirely.
    const stderr = (result.stderr ?? '').toLowerCase();
    expect(stderr).toMatch(/outside the repository/);
  });

  it("refuses a directory argument with a non-zero exit that names its own cause, not the nonexistent-path message", () => {
    // lib/runtime plainly exists (this suite rebuilds through it above) —
    // it is a directory, not a file. DEFECT (b) in the run objective: the
    // current guard correctly refuses it but reuses the "no such file"
    // wording that belongs to the nonexistent-path case, so an operator who
    // typed a directory by mistake is told the path doesn't exist when it
    // plainly does. The refusal must name ITS OWN cause instead.
    const target = 'lib/runtime';
    const result = runTool([target]);

    expect(result.status).not.toBe(0);
    const stdout = (result.stdout ?? '').toLowerCase();
    expect(stdout).not.toMatch(/reaches|dist\//);

    const stderr = (result.stderr ?? '').toLowerCase();
    // The path exists (it IS a directory), so a refusal that claims "no
    // such file" misdiagnoses the cause and sends the operator hunting for
    // a misspelling that is not there.
    expect(stderr).not.toMatch(/no such file/);
    // Pin the POSITIVE: the refusal must actually name its own cause, not
    // merely avoid the wrong one — a message with the cause dropped
    // entirely (or a different, unrelated cause) would satisfy the negative
    // assertion above while deliverable 2 (the directory refusal names its
    // own cause) has regressed.
    expect(stderr).toMatch(/not a file/);
  });
});
