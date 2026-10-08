import { readdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveConfig as resolveVitestConfig } from 'vitest/node';

// Roadmap: spawn-test-parallelism-isolation. The 2026-07-20 spike
// (run-fixture-7e7287db5e67) showed that under the file-parallel forks
// pool (maxWorkers: 3) concurrently scheduled spawn-heavy gate-integration
// files — each spawning REAL child node processes — oversubscribe the host:
// awaited children starve past testTimeout and the run wedges (~352s vs
// ~86-88s clean). Contract under test: vitest.config.js gains a second
// project named 'spawn-serial' that runs the spawn-heavy files one at a
// time, the 'default' project excludes exactly those files (a disjoint,
// covering partition of the __tests__ *.test.js listing), and — because
// vitest project members do NOT inherit root timeouts — the new project
// mirrors testTimeout 15000 / hookTimeout 20000.
//
// These assertions are derived from the public config contract only: they
// resolve each project's include/exclude patterns against the real
// __tests__ listing rather than hard-coding the spawn-serial membership,
// so quarantining an additional spawn-heavy peer later cannot break them.

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const KNOWN_WEDGERS = [
  '__tests__/runtime-v2-core-land-lane.test.js',
  '__tests__/runtime-v2-round3-terminal-tree.test.js',
  '__tests__/runtime-v2-risk-trigger-receipt-surfacing.test.js',
];

/** Load the resolved vitest config object (supports the function form). */
async function loadConfig() {
  const configUrl = pathToFileURL(path.join(ROOT, 'vitest.config.js')).href;
  const mod = await import(configUrl);
  let config = mod.default;
  if (typeof config === 'function') {
    config = await config({ mode: 'test', command: 'serve' });
  }
  return config;
}

/**
 * Normalize the projects array into [{ name, test }] entries. Inline vitest
 * projects are config objects carrying a `test` block; tolerate a bare test
 * block too so the assertion messages stay about the contract, not the shape.
 */
async function loadProjects() {
  const config = await loadConfig();
  const projects = config?.test?.projects;
  expect(
    Array.isArray(projects),
    'vitest.config.js must keep the test.projects array',
  ).toBe(true);
  return projects.map((entry) => {
    const test = entry && typeof entry === 'object' ? (entry.test ?? entry) : {};
    return { name: test?.name, test };
  });
}

function normalizePattern(pattern) {
  let p = String(pattern).replace(/\\/g, '/');
  while (p.startsWith('./')) p = p.slice(2);
  return p;
}

/** Expand single-level {a,b} brace groups (recursively) into plain globs. */
function expandBraces(pattern) {
  const m = pattern.match(/^(.*?)\{([^{}]*)\}(.*)$/);
  if (!m) return [pattern];
  const [, pre, body, post] = m;
  return body.split(',').flatMap((alt) => expandBraces(pre + alt + post));
}

/** Convert one brace-free glob to an anchored RegExp (picomatch-compatible
 *  for the subset used here: literals, `*`, `?`, `**`, and `**` + `/`). */
function globToRegExp(glob) {
  let source = '';
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          source += '(?:[^/]*/)*'; // `**/` — zero or more whole segments
          i += 3;
        } else {
          source += '.*'; // bare `**`
          i += 2;
        }
      } else {
        source += '[^/]*'; // `*` — within one segment
        i += 1;
      }
    } else if (c === '?') {
      source += '[^/]';
      i += 1;
    } else {
      source += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
      i += 1;
    }
  }
  return new RegExp(`^${source}$`);
}

function matchesAny(patterns, file) {
  return patterns
    .flatMap((pattern) => expandBraces(normalizePattern(pattern)))
    .some((glob) => globToRegExp(glob).test(file));
}

/** Resolve a project's include/exclude patterns against the file listing. */
function resolveMembership(project, files) {
  const include = project.test?.include;
  expect(
    Array.isArray(include) && include.length > 0,
    `project '${project.name}' must declare a non-empty include list`,
  ).toBe(true);
  const exclude = Array.isArray(project.test?.exclude) ? project.test.exclude : [];
  return files.filter(
    (file) => matchesAny(include, file) && !matchesAny(exclude, file),
  );
}

/** The actual __tests__ *.test.js listing, as root-relative posix paths. */
async function listTestFiles() {
  const entries = await readdir(path.join(ROOT, '__tests__'), {
    recursive: true,
  });
  return entries
    .map((entry) => String(entry).replace(/\\/g, '/'))
    .filter((entry) => entry.endsWith('.test.js'))
    .map((entry) => `__tests__/${entry}`)
    .sort();
}

async function getProject(name) {
  const projects = await loadProjects();
  return projects.find((project) => project.name === name);
}

/** Resolve fixtures with the installed runner, without loading the repo config
 * or starting a test run. In Vitest 4, fileParallelism:false forces maxWorkers
 * to 1; removed poolOptions controls have no effect. */
async function resolveTestConfig(test) {
  const { vitestConfig } = await resolveVitestConfig({
    ...test,
    root: ROOT,
    config: false,
    watch: false,
  });
  return vitestConfig;
}

/** Use the same effective-contract guard for live config and adversarial inputs.
 * Isolated projects with one worker and default groupOrder are scheduled as
 * serial files by Vitest 4, including the supported maxWorkers:1 equivalent. */
async function assertSerialFiles(test) {
  const effective = await resolveTestConfig(test);
  expect(
    effective.maxWorkers,
    'spawn-serial must serialize file execution with fileParallelism: false or maxWorkers: 1',
  ).toBe(1);
  expect(effective.isolate, 'spawn-serial must retain per-file isolation').toBe(true);
  expect(effective.pool, 'spawn-serial must retain forks process isolation').toBe('forks');
  expect(effective.sequence.groupOrder, 'spawn-serial must retain the default scheduling group').toBe(0);
  return effective;
}

describe('spawn-serial vitest project isolates spawn-heavy gate-integration tests', () => {
  it("(a) defines a 'spawn-serial' project alongside 'default'", async () => {
    const names = (await loadProjects()).map((project) => project.name);
    expect(names, "the 'default' project must survive").toContain('default');
    expect(
      names,
      "a 'spawn-serial' project must exist for the spawn-heavy files",
    ).toContain('spawn-serial');
  });

  it('(b) default and spawn-serial partition the __tests__ *.test.js listing: every file in exactly one project', async () => {
    const files = await listTestFiles();
    expect(files.length, 'sanity: the __tests__ listing is non-empty').toBeGreaterThan(0);

    const defaultProject = await getProject('default');
    const spawnSerial = await getProject('spawn-serial');
    expect(defaultProject, "the 'default' project must exist").toBeTruthy();
    expect(spawnSerial, "the 'spawn-serial' project must exist").toBeTruthy();

    const defaultFiles = new Set(resolveMembership(defaultProject, files));
    const serialFiles = new Set(resolveMembership(spawnSerial, files));

    const overlap = [...serialFiles].filter((file) => defaultFiles.has(file));
    expect(overlap, 'no test file may run in both projects').toEqual([]);

    const dropped = files.filter(
      (file) => !defaultFiles.has(file) && !serialFiles.has(file),
    );
    expect(dropped, 'no test file may be dropped by the partition').toEqual([]);

    expect(
      serialFiles.size,
      'spawn-serial must actually own at least the known wedgers',
    ).toBeGreaterThanOrEqual(KNOWN_WEDGERS.length);
    expect(
      defaultFiles.size,
      'quarantining everything forfeits the parallel win: default must keep the bulk of the suite',
    ).toBeGreaterThan(serialFiles.size);
  });

  it('(c) the three known wedgers are members of spawn-serial', async () => {
    const files = await listTestFiles();
    const spawnSerial = await getProject('spawn-serial');
    expect(spawnSerial, "the 'spawn-serial' project must exist").toBeTruthy();
    const serialFiles = resolveMembership(spawnSerial, files);
    for (const wedger of KNOWN_WEDGERS) {
      expect(serialFiles, `${wedger} must run in spawn-serial`).toContain(wedger);
    }
  });

  it('(d) spawn-serial effectively runs one isolated file at a time in installed Vitest', async () => {
    const spawnSerial = await getProject('spawn-serial');
    expect(spawnSerial, "the 'spawn-serial' project must exist").toBeTruthy();
    await assertSerialFiles(spawnSerial.test);
  });

  it.each([
    ['fileParallelism:false', { fileParallelism: false }],
    ['fileParallelism:false overrides multiple workers', { fileParallelism: false, maxWorkers: 3 }],
    ['maxWorkers:1 with default file parallelism', { maxWorkers: 1 }],
    ['maxWorkers:1 with enabled file parallelism', { maxWorkers: 1, fileParallelism: true }],
  ])('accepts the installed effective serialization contract: %s', async (_name, test) => {
    await assertSerialFiles(test);
  });

  const legacyControls = [
    ['singleFork', { pool: 'forks', poolOptions: { forks: { singleFork: true } } }],
    ['singleThread', { pool: 'threads', poolOptions: { threads: { singleThread: true } } }],
  ];
  const legacyFixtures = legacyControls.flatMap(([name, test]) => [
    [`${name}, fileParallelism absent`, { ...test, maxWorkers: 3 }],
    [`${name}, fileParallelism enabled`, { ...test, maxWorkers: 3, fileParallelism: true }],
  ]);

  it.each([
    ...legacyFixtures,
    ['no serialization control', {}],
    ['multiple workers with default file parallelism', { maxWorkers: 3 }],
    ['multiple workers with enabled file parallelism', { maxWorkers: 3, fileParallelism: true }],
  ])('rejects ineffective serialization with an actionable diagnostic: %s', async (_name, test) => {
    await expect(assertSerialFiles(test)).rejects.toThrow(
      'spawn-serial must serialize file execution with fileParallelism: false or maxWorkers: 1',
    );
  });

  it('rejects serialization that disables per-file isolation', async () => {
    await expect(assertSerialFiles({ fileParallelism: false, isolate: false }))
      .rejects.toThrow('spawn-serial must retain per-file isolation');
  });

  it('rejects a serial threads pool that loses forks process isolation', async () => {
    await expect(assertSerialFiles({ fileParallelism: false, pool: 'threads' }))
      .rejects.toThrow('spawn-serial must retain forks process isolation');
  });

  it('retains process isolation in the parallel default project', async () => {
    const defaultProject = await getProject('default');
    expect(defaultProject, "the 'default' project must exist").toBeTruthy();
    const effective = await resolveTestConfig(defaultProject.test);
    expect(effective.isolate).toBe(true);
    expect(effective.pool).toBe('forks');
  });

  it('runs benchmark CLI lock tests only in the serial project', async () => {
    const files = await listTestFiles();
    const benchmark = '__tests__/runtime-v2-benchmark.test.js';
    expect(resolveMembership(await getProject('spawn-serial'), files)).toContain(benchmark);
    expect(resolveMembership(await getProject('default'), files)).not.toContain(benchmark);
  });

  it('(e) spawn-serial mirrors testTimeout 15000 and hookTimeout 20000 (projects do not inherit root timeouts)', async () => {
    const spawnSerial = await getProject('spawn-serial');
    expect(spawnSerial, "the 'spawn-serial' project must exist").toBeTruthy();
    expect(
      spawnSerial.test.testTimeout,
      'spawn-serial must pin testTimeout to the intended root value',
    ).toBe(15000);
    expect(
      spawnSerial.test.hookTimeout,
      'spawn-serial must pin hookTimeout to the intended root value',
    ).toBe(20000);
  });

});
