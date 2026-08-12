import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// RED-FIRST unit tests for resolveRunnerSet — the PURE deterministic routing
// function for the polyglot multi-runner merge gate, to be implemented in
// lib/runtime/gates.js. It does not exist yet, so the named import resolves to
// `undefined` under vitest's lenient module transform and every call throws
// (`resolveRunnerSet is not a function`) → deterministic failure. Once a correct
// implementation of the public contract lands, these turn GREEN.
//
// Contract shape (asserted below, derived only from the public contract):
//   async function resolveRunnerSet(projectDir, state, config)
//   * EMPTY/UNSET runners → { strategy:'single', selection:<resolveSuiteSelection>, orphans:[] }
//   * CONFIGURED runners  → { strategy:'multi', participants[], orphans[],
//                             orphan_forced_full, orphan_policy, blocked }
// Changed-set normalization mirrors resolveSuiteSelection: the de-duplicated
// union of every receipt.changed_files (missing → []), filtered to files that
// EXIST on disk under projectDir, sorted ascending. Because of the on-disk
// filter EVERY routed file must be written to a real mkdtemp project dir; a
// "deleted" file is simply one that is never written.
import { resolveRunnerSet } from '../lib/runtime/gates.js';

// ---------------------------------------------------------------------------
// Fixtures. Every fixture dir is created with os.tmpdir()+mkdtemp so the project
// tree SHA is never touched, and torn down in afterEach.
// ---------------------------------------------------------------------------
let tempDirs = [];
beforeEach(() => {
  tempDirs = [];
});
afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) =>
      rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })),
  );
});

// A temp project dir with each listed relative path written as a real file so it
// survives the existing-on-disk filter. Paths NOT listed here are "deleted".
async function makeProjectDir(files = []) {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-runner-routing-'));
  tempDirs.push(dir);
  for (const rel of files) {
    const abs = path.join(dir, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, `// ${rel}\n`);
  }
  return dir;
}

// Build state.receipts from raw changed_files arrays. An `undefined` entry
// models a receipt with NO changed_files field (contract: missing → []).
function receiptsFrom(...changedFilesArrays) {
  return changedFilesArrays.map((changed) =>
    (changed === undefined ? {} : { changed_files: changed }));
}

function stateWith(receipts, overrides = {}) {
  return { receipts, ...overrides };
}

// A well-formed runner element: { id, owns:[glob], root, profile }. profile
// carries the test_commands shape (string|null slots) incl. full + impacted_template.
function makeRunner(id, owns, { root, full = `${id}-full`, impacted_template = null } = {}) {
  return { id, owns, root: root ?? id, profile: { full, impacted_template } };
}

const byRunner = (result, id) => result.participants.find((p) => p.runner === id);

// ---------------------------------------------------------------------------
// 1. single-owner routing
// ---------------------------------------------------------------------------
describe('resolveRunnerSet — single-owner routing (case 1)', () => {
  it('routes the one changed file to the one owning runner, no orphans', async () => {
    const dir = await makeProjectDir(['packages/js/a.test.js']);
    const config = { runners: [makeRunner('js', ['packages/js/**'], { root: 'packages/js' })] };
    // second receipt has NO changed_files field → contract "missing → []"
    const state = stateWith(receiptsFrom(['packages/js/a.test.js'], undefined));

    const result = await resolveRunnerSet(dir, state, config);

    expect(result.strategy).toBe('multi');
    expect(result.orphans).toEqual([]);
    expect(result.blocked).toBe(false);
    expect(result.orphan_forced_full).toBe(false);
    expect(result.orphan_policy).toBe('run-all-full');
    expect(result.participants).toHaveLength(1);
    const js = byRunner(result, 'js');
    expect(js).toBeTruthy();
    expect(js.runner).toBe('js');
    expect(js.root).toBe('packages/js');
    expect(js.changedSubset).toEqual(['packages/js/a.test.js']);
    expect(js.mode).toBe('full');
    expect(js.invocation).toBeNull();
    expect(js.impacted_paths).toBeNull();
    expect(js.template).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. overlap / union (inverse of first-match) + dedup across receipts
// ---------------------------------------------------------------------------
describe('resolveRunnerSet — overlap union (case 2)', () => {
  it('a file owned by two runners lands in BOTH changed subsets', async () => {
    const dir = await makeProjectDir(['packages/js/a.js']);
    const config = {
      runners: [
        makeRunner('pkg-all', ['packages/**'], { root: 'packages' }),
        makeRunner('pkg-js', ['packages/js/**'], { root: 'packages/js' }),
      ],
    };
    // two receipts list the SAME file → the union de-duplicates to one path
    const state = stateWith(receiptsFrom(['packages/js/a.js'], ['packages/js/a.js']));

    const result = await resolveRunnerSet(dir, state, config);

    expect(result.strategy).toBe('multi');
    expect(result.orphans).toEqual([]);
    expect(result.participants).toHaveLength(2);
    // participants sorted ascending by runner id
    expect(result.participants.map((p) => p.runner)).toEqual(['pkg-all', 'pkg-js']);
    expect(byRunner(result, 'pkg-all').changedSubset).toEqual(['packages/js/a.js']);
    expect(byRunner(result, 'pkg-js').changedSubset).toEqual(['packages/js/a.js']);
    expect(result.blocked).toBe(false);
    expect(result.orphan_forced_full).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. orphan handling: default run-all-full policy vs. block_on_orphan
// ---------------------------------------------------------------------------
describe('resolveRunnerSet — orphan handling (case 3)', () => {
  it('default policy forces ALL runners to full, listing unmatched files sorted', async () => {
    const dir = await makeProjectDir([
      'packages/js/a.js',
      'random/z-orphan.txt',
      'random/a-orphan.txt',
    ]);
    const config = { runners: [makeRunner('js', ['packages/js/**'], { root: 'packages/js' })] };
    const state = stateWith(receiptsFrom([
      'packages/js/a.js',
      'random/z-orphan.txt',
      'random/a-orphan.txt',
    ]));

    const result = await resolveRunnerSet(dir, state, config);

    expect(result.strategy).toBe('multi');
    expect(result.orphans).toEqual(['random/a-orphan.txt', 'random/z-orphan.txt']);
    expect(result.orphan_forced_full).toBe(true);
    expect(result.orphan_policy).toBe('run-all-full');
    expect(result.blocked).toBe(false);
    expect(result.participants).toHaveLength(1);
    const js = byRunner(result, 'js');
    expect(js.mode).toBe('full');
    expect(js.changedSubset).toEqual(['packages/js/a.js']);
    expect(js.invocation).toBeNull();
    expect(js.impacted_paths).toBeNull();
    expect(js.template).toBeNull();
  });

  it('block_on_orphan fails closed: same input blocks with no participants (never a silent skip)', async () => {
    const dir = await makeProjectDir(['packages/js/a.js', 'random/orphan.txt']);
    const config = {
      runners: [makeRunner('js', ['packages/js/**'], { root: 'packages/js' })],
      gates: { block_on_orphan: true },
    };
    const state = stateWith(receiptsFrom(['packages/js/a.js', 'random/orphan.txt']));

    const result = await resolveRunnerSet(dir, state, config);

    expect(result.strategy).toBe('multi');
    expect(result.blocked).toBe(true);
    expect(result.participants).toEqual([]);
    expect(result.orphans).toEqual(['random/orphan.txt']);
    expect(result.orphan_policy).toBe('block');
    expect(result.orphan_forced_full).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. regate / ship → force full (never impacted)
// ---------------------------------------------------------------------------
describe('resolveRunnerSet — force full on regate/ship (case 4)', () => {
  it('regate_attempts>0 forces every participating runner to full despite impacted eligibility', async () => {
    const dir = await makeProjectDir(['packages/js/a.js']);
    const config = {
      runners: [makeRunner('js', ['packages/js/**'], {
        root: 'packages/js',
        impacted_template: 'js-runner {paths}',
      })],
      shipping: { required_remote_checks: true },
    };
    const state = stateWith(receiptsFrom(['packages/js/a.js']), { regate_attempts: 1 });

    const result = await resolveRunnerSet(dir, state, config);

    expect(result.strategy).toBe('multi');
    expect(result.participants).toHaveLength(1);
    const js = byRunner(result, 'js');
    expect(js.mode).toBe('full');
    expect(js.invocation).toBeNull();
    expect(js.impacted_paths).toBeNull();
    expect(js.template).toBeNull();
    expect(result.orphan_forced_full).toBe(false);
    expect(result.blocked).toBe(false);
  });

  it('ship_requested===true forces every participating runner to full despite impacted eligibility', async () => {
    const dir = await makeProjectDir(['packages/js/a.js']);
    const config = {
      runners: [makeRunner('js', ['packages/js/**'], {
        root: 'packages/js',
        impacted_template: 'js-runner {paths}',
      })],
      shipping: { required_remote_checks: true },
    };
    const state = stateWith(receiptsFrom(['packages/js/a.js']), { ship_requested: true });

    const result = await resolveRunnerSet(dir, state, config);

    const js = byRunner(result, 'js');
    expect(js.mode).toBe('full');
    expect(js.invocation).toBeNull();
    expect(js.impacted_paths).toBeNull();
    expect(js.template).toBeNull();
    expect(result.orphan_forced_full).toBe(false);
    expect(result.blocked).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. per-runner impacted rule (invariant 9, applied per runner)
// ---------------------------------------------------------------------------
describe('resolveRunnerSet — per-runner impacted rule (case 5)', () => {
  it('an eligible runner is impacted with impacted_paths===changedSubset, template, and a rendered invocation', async () => {
    const dir = await makeProjectDir(['packages/js/a.js']);
    const config = {
      // required_remote_checks unset → defaults to enabled (!== false)
      runners: [makeRunner('js', ['packages/js/**'], {
        root: 'packages/js',
        impacted_template: 'js-runner {paths}',
      })],
    };
    const state = stateWith(receiptsFrom(['packages/js/a.js']));

    const result = await resolveRunnerSet(dir, state, config);

    expect(result.participants).toHaveLength(1);
    const js = byRunner(result, 'js');
    expect(js.mode).toBe('impacted');
    expect(js.changedSubset).toEqual(['packages/js/a.js']);
    expect(js.impacted_paths).toEqual(['packages/js/a.js']);
    expect(js.template).toBe('js-runner {paths}');
    expect(js.invocation).toEqual({ command: 'js-runner', args: ['packages/js/a.js'] });
  });

  it('flipping required_remote_checks=false reverts that runner to full PER runner (invariant 9)', async () => {
    const dir = await makeProjectDir(['packages/js/a.js']);
    const config = {
      runners: [makeRunner('js', ['packages/js/**'], {
        root: 'packages/js',
        impacted_template: 'js-runner {paths}',
      })],
      shipping: { required_remote_checks: false },
    };
    const state = stateWith(receiptsFrom(['packages/js/a.js']));

    const result = await resolveRunnerSet(dir, state, config);

    const js = byRunner(result, 'js');
    expect(js.mode).toBe('full');
    expect(js.invocation).toBeNull();
    expect(js.impacted_paths).toBeNull();
    expect(js.template).toBeNull();
  });

  it('a runner with no impacted_template is full', async () => {
    const dir = await makeProjectDir(['packages/js/a.js']);
    const config = {
      runners: [makeRunner('js', ['packages/js/**'], { root: 'packages/js', impacted_template: null })],
    };
    const state = stateWith(receiptsFrom(['packages/js/a.js']));

    const result = await resolveRunnerSet(dir, state, config);

    const js = byRunner(result, 'js');
    expect(js.mode).toBe('full');
    expect(js.invocation).toBeNull();
    expect(js.template).toBeNull();
  });

  it('a malformed template (no {paths} token) falls back to full, never skipping', async () => {
    const dir = await makeProjectDir(['packages/js/a.js']);
    const config = {
      runners: [makeRunner('js', ['packages/js/**'], {
        root: 'packages/js',
        impacted_template: 'js-runner --all',
      })],
    };
    const state = stateWith(receiptsFrom(['packages/js/a.js']));

    const result = await resolveRunnerSet(dir, state, config);

    const js = byRunner(result, 'js');
    expect(js.mode).toBe('full');
    expect(js.invocation).toBeNull();
    expect(js.template).toBeNull();
  });

  it('a malformed template (unterminated quote) falls back to full', async () => {
    const dir = await makeProjectDir(['packages/js/a.js']);
    const config = {
      runners: [makeRunner('js', ['packages/js/**'], {
        root: 'packages/js',
        impacted_template: 'js-runner "{paths}',
      })],
    };
    const state = stateWith(receiptsFrom(['packages/js/a.js']));

    const result = await resolveRunnerSet(dir, state, config);

    expect(byRunner(result, 'js').mode).toBe('full');
  });

  it('a mixed config resolves one impacted-eligible and one non-eligible runner in the same call', async () => {
    const dir = await makeProjectDir(['packages/js/a.js', 'services/py/main.py']);
    const config = {
      runners: [
        makeRunner('js', ['packages/js/**'], { root: 'packages/js', impacted_template: 'js-runner {paths}' }),
        makeRunner('py', ['services/py/**'], { root: 'services/py', impacted_template: null }),
      ],
    };
    const state = stateWith(receiptsFrom(['packages/js/a.js', 'services/py/main.py']));

    const result = await resolveRunnerSet(dir, state, config);

    expect(result.orphans).toEqual([]);
    expect(result.participants.map((p) => p.runner)).toEqual(['js', 'py']);
    const js = byRunner(result, 'js');
    const py = byRunner(result, 'py');
    expect(js.mode).toBe('impacted');
    expect(js.impacted_paths).toEqual(['packages/js/a.js']);
    expect(js.template).toBe('js-runner {paths}');
    expect(js.invocation).toEqual({ command: 'js-runner', args: ['packages/js/a.js'] });
    // services/py/** matches services/py/main.py
    expect(py.mode).toBe('full');
    expect(py.changedSubset).toEqual(['services/py/main.py']);
    expect(py.invocation).toBeNull();
    expect(py.impacted_paths).toBeNull();
    expect(py.template).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 6. empty / unset runners → strategy 'single'
// ---------------------------------------------------------------------------
describe('resolveRunnerSet — empty/unset runners → single (case 6)', () => {
  it('an empty runners array yields the single strategy with a non-null selection and no orphans', async () => {
    const dir = await makeProjectDir(['src/x.js']);
    const config = { runners: [], test_commands: { full: 'run-full-suite' } };
    const state = stateWith(receiptsFrom(['src/x.js']));

    const result = await resolveRunnerSet(dir, state, config);

    expect(result.strategy).toBe('single');
    expect(result.orphans).toEqual([]);
    expect(result.selection).not.toBeNull();
    expect(typeof result.selection).toBe('object');
  });

  it('undefined runners yields the single strategy (byte-identical-to-today path)', async () => {
    const dir = await makeProjectDir(['src/x.js']);
    const config = { test_commands: { full: 'run-full-suite' } };
    const state = stateWith(receiptsFrom(['src/x.js']));

    const result = await resolveRunnerSet(dir, state, config);

    expect(result.strategy).toBe('single');
    expect(result.orphans).toEqual([]);
    expect(result.selection).not.toBeNull();
    expect(typeof result.selection).toBe('object');
  });
});

// ---------------------------------------------------------------------------
// 7. determinism + coverage fail-safe
// ---------------------------------------------------------------------------
describe('resolveRunnerSet — determinism and coverage fail-safe (case 7)', () => {
  it('is deterministic: identical inputs yield deep-equal output across repeated calls', async () => {
    const dir = await makeProjectDir(['packages/js/a.js', 'services/py/main.py']);
    const config = {
      runners: [
        makeRunner('js', ['packages/js/**'], { root: 'packages/js', impacted_template: 'js-runner {paths}' }),
        makeRunner('py', ['services/py/**'], { root: 'services/py' }),
      ],
    };
    const state = stateWith(receiptsFrom(['packages/js/a.js', 'services/py/main.py']));

    const first = await resolveRunnerSet(dir, state, config);
    const second = await resolveRunnerSet(dir, state, config);

    expect(second).toEqual(first);
  });

  it('drops a deleted changed file (in receipts, not on disk): neither routed nor an orphan', async () => {
    // packages/js/a.js is written; random/deleted.txt is NOT (a deletion). Were
    // random/deleted.txt on disk it would be an orphan; deleted, it must vanish.
    const dir = await makeProjectDir(['packages/js/a.js']);
    const config = { runners: [makeRunner('js', ['packages/js/**'], { root: 'packages/js' })] };
    const state = stateWith(receiptsFrom(['packages/js/a.js', 'random/deleted.txt']));

    const result = await resolveRunnerSet(dir, state, config);

    expect(result.orphans).toEqual([]);
    const js = byRunner(result, 'js');
    expect(js.changedSubset).toEqual(['packages/js/a.js']);
    expect(js.changedSubset).not.toContain('random/deleted.txt');
  });

  it('an empty present set with runners configured runs ALL runners at full (never a silent skip)', async () => {
    const dir = await makeProjectDir([]); // nothing written → every changed file is "deleted"
    const config = {
      runners: [
        makeRunner('js', ['packages/js/**'], { root: 'packages/js', impacted_template: 'js-runner {paths}' }),
        makeRunner('py', ['services/py/**'], { root: 'services/py' }),
      ],
    };
    const state = stateWith(receiptsFrom(['packages/js/ghost.js', 'services/py/ghost.py']));

    const result = await resolveRunnerSet(dir, state, config);

    expect(result.strategy).toBe('multi');
    expect(result.orphans).toEqual([]);
    expect(result.blocked).toBe(false);
    expect(result.orphan_forced_full).toBe(false);
    expect(result.orphan_policy).toBe('run-all-full');
    expect(result.participants.map((p) => p.runner)).toEqual(['js', 'py']);
    for (const p of result.participants) {
      expect(p.mode).toBe('full');
      expect(p.changedSubset).toEqual([]);
      expect(p.invocation).toBeNull();
      expect(p.impacted_paths).toBeNull();
      expect(p.template).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// Precedence: block(2) > coverage-fail-safe(3) > force-full(4) > per-runner(5)
// ---------------------------------------------------------------------------
describe('resolveRunnerSet — precedence resolution', () => {
  it('coverage fail-safe(3) outranks force-full(4): orphan + regate → all full, orphan_forced_full stays true', async () => {
    const dir = await makeProjectDir(['packages/js/a.js', 'random/orphan.txt']);
    const config = {
      runners: [makeRunner('js', ['packages/js/**'], {
        root: 'packages/js',
        impacted_template: 'js-runner {paths}',
      })],
    };
    const state = stateWith(
      receiptsFrom(['packages/js/a.js', 'random/orphan.txt']),
      { regate_attempts: 2 },
    );

    const result = await resolveRunnerSet(dir, state, config);

    expect(result.orphans).toEqual(['random/orphan.txt']);
    expect(result.orphan_forced_full).toBe(true);
    expect(result.orphan_policy).toBe('run-all-full');
    expect(result.blocked).toBe(false);
    expect(result.participants).toHaveLength(1);
    const js = byRunner(result, 'js');
    expect(js.mode).toBe('full');
    expect(js.changedSubset).toEqual(['packages/js/a.js']);
    expect(js.invocation).toBeNull();
  });

  it('block(2) outranks coverage-fail-safe(3) and force-full(4) when an orphan exists', async () => {
    const dir = await makeProjectDir(['packages/js/a.js', 'random/orphan.txt']);
    const config = {
      runners: [makeRunner('js', ['packages/js/**'], {
        root: 'packages/js',
        impacted_template: 'js-runner {paths}',
      })],
      gates: { block_on_orphan: true },
    };
    const state = stateWith(
      receiptsFrom(['packages/js/a.js', 'random/orphan.txt']),
      { regate_attempts: 3, ship_requested: true },
    );

    const result = await resolveRunnerSet(dir, state, config);

    expect(result.blocked).toBe(true);
    expect(result.participants).toEqual([]);
    expect(result.orphans).toEqual(['random/orphan.txt']);
    expect(result.orphan_policy).toBe('block');
    expect(result.orphan_forced_full).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Glob dialect: anchored, literal metachars, `**` crosses `/`, single `*` does
// not. Pinned through observable routing (the glob helper is not exported).
// ---------------------------------------------------------------------------
describe('resolveRunnerSet — owns glob dialect', () => {
  it('** matches nested paths (zero-or-more segments) but never a sibling tree', async () => {
    const dir = await makeProjectDir([
      'packages/js/a.test.js',
      'packages/js/sub/b.js',
      'packages/py/x.py',
    ]);
    const config = { runners: [makeRunner('js', ['packages/js/**'], { root: 'packages/js' })] };
    const state = stateWith(receiptsFrom([
      'packages/js/a.test.js',
      'packages/js/sub/b.js',
      'packages/py/x.py',
    ]));

    const result = await resolveRunnerSet(dir, state, config);

    // packages/js/** matches the flat file AND the nested one; packages/py/x.py
    // is outside the tree → orphan.
    expect(byRunner(result, 'js').changedSubset)
      .toEqual(['packages/js/a.test.js', 'packages/js/sub/b.js']);
    expect(result.orphans).toEqual(['packages/py/x.py']);
  });

  it('single * matches within one segment only, never across /', async () => {
    const dir = await makeProjectDir(['src/a.js', 'src/sub/a.js']);
    const config = { runners: [makeRunner('src', ['src/*.js'], { root: 'src' })] };
    const state = stateWith(receiptsFrom(['src/a.js', 'src/sub/a.js']));

    const result = await resolveRunnerSet(dir, state, config);

    expect(byRunner(result, 'src').changedSubset).toEqual(['src/a.js']);
    expect(result.orphans).toEqual(['src/sub/a.js']);
  });

  it('the . in a/*.js is a literal, so a/xjs does not match', async () => {
    const dir = await makeProjectDir(['a/x.js', 'a/xjs']);
    const config = { runners: [makeRunner('a', ['a/*.js'], { root: 'a' })] };
    const state = stateWith(receiptsFrom(['a/x.js', 'a/xjs']));

    const result = await resolveRunnerSet(dir, state, config);

    expect(byRunner(result, 'a').changedSubset).toEqual(['a/x.js']);
    expect(result.orphans).toEqual(['a/xjs']);
  });
});
