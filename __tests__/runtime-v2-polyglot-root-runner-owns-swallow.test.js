import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { proposeRunners } from '../lib/runtime/config.js';
import { runnerOwnsFile } from '../lib/runtime/gates.js';

// Regression anchor for review Bug B (multi-agent runtime review, 2026-07-22).
//
// Before the fix, proposeRunners gave a repo-ROOT runner owns:['**']. Under the
// UNION ownership router (lib/runtime/service.js observeRedTestPerRunner and
// gates.js resolveRunnerSet, via the shared runnerOwnsFile matcher), '**'
// matched EVERY sub-runner's files, so a sub-runner's authored test was owned by
// BOTH the wrong-toolchain root runner AND its own runner. The root (e.g. vitest)
// runner then ran the sub-runner's test with the wrong toolchain
// (`npx vitest run api/tests/test_new.py`), matched zero .py files, exited
// non-zero, and sealed that vacuous red as an observed red phase.
//
// The fix keeps UNION ownership (intentional for explicit configs — see
// resolveRunnerSet's "overlap / union (case 2)") and instead stops the AUTO
// PROPOSAL from creating a wrong-toolchain overlap: runnerOwnsFile gained a
// `!glob` exclusion operator (a hard veto, no glob library — invariant 6), and
// proposeRunners now carves each broad runner's own descendant sub-runners out
// of its `owns` (root becomes ['**', '!api/**']). So the root runner still owns
// the whole repo INCLUDING future root-level files, but never the pytest
// subtree. Fixtures live under os.tmpdir() mkdtemp so this repo's tree SHA is
// untouched.

const VITEST_PKG = JSON.stringify({
  name: 'fixture-root-web',
  version: '1.0.0',
  scripts: { test: 'vitest run' },
  devDependencies: { vitest: '^2.0.0' },
}, null, 2);

// A genuine non-JS pytest manifest with NO package.json under api/, so
// detectRunnerAt resolves the python family there (distinct from the root's JS
// family) — the two distinct families proposeRunners requires to emit runners[].
const PYTEST_TOML = '[tool.pytest.ini_options]\naddopts = ""\n';

const dirs = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

// A polyglot tree whose ROOT is itself a runner root: root package.json (vitest)
// plus api/ pyproject.toml (pytest).
function polyglotRootPlusSubdir() {
  const dir = mkdtempSync(join(tmpdir(), 'ape-root-owns-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'package.json'), VITEST_PKG);
  mkdirSync(join(dir, 'api'), { recursive: true });
  writeFileSync(join(dir, 'api', 'pyproject.toml'), PYTEST_TOML);
  return dir;
}

describe('APE v2 polyglot: a root runner must not swallow sub-runner subtrees (review Bug B)', () => {
  it('carves each sub-runner subtree out of the auto root runner so no path routes to the wrong toolchain', async () => {
    const dir = polyglotRootPlusSubdir();
    const runners = await proposeRunners(dir);

    // Two distinct-family runners across the tree: the root (vitest) and api/ (pytest).
    expect(runners.length).toBe(2);
    const rootRunner = runners.find((runner) => runner.root === '.');
    const apiRunner = runners.find((runner) => runner.root === 'api');
    expect(rootRunner).toBeTruthy();
    expect(apiRunner).toBeTruthy();

    // The proposal carves the api subtree out of the root runner's owns.
    expect(rootRunner.owns).toEqual(['**', '!api/**']);
    expect(apiRunner.owns).toEqual(['api/**']);

    const subPath = 'api/tests/test_new.py';

    // The api runner owns its own subtree; the wrong-toolchain root runner does
    // NOT (the '!api/**' carve-out vetoes the '**' match). So the sub-runner path
    // resolves to EXACTLY ONE owner — never a vitest run over a .py file.
    expect(runnerOwnsFile(apiRunner, subPath)).toBe(true);
    expect(runnerOwnsFile(rootRunner, subPath)).toBe(false);
    const owners = runners.filter((runner) => runnerOwnsFile(runner, subPath)).map((runner) => runner.root);
    expect(owners).toEqual(['api']);

    // The root runner still owns the rest of the repo, INCLUDING files added
    // later at the root or in any non-sub-runner directory.
    expect(runnerOwnsFile(rootRunner, 'src/index.js')).toBe(true);
    expect(runnerOwnsFile(rootRunner, 'package.json')).toBe(true);
    expect(runnerOwnsFile(rootRunner, 'lib/added/later.js')).toBe(true);
  });
});
