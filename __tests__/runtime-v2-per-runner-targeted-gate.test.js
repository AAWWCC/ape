import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { evaluateTargetedRunners } from '../lib/runtime/gates.js';

// Review acme issue #4: the targeted-tests gate used to run ONE runner (a single
// detectTestRunner invocation) over the UNION of every test path, at the repo
// root — so a mixed monorepo ran e.g. pytest over `.tsx` paths (101 false
// failures). evaluateTargetedRunners routes each test path to its owning runner
// and runs each runner's SCOPED targeted invocation at its OWN root, then ANDs
// the verdicts. These probes record their cwd and the {paths} they received, so
// the routing / execution-cwd / path-relativization are directly observable:
// the vitest runner sees only the .tsx path (at web/), the pytest runner only
// the .py path (at api/). Fixtures live under os.tmpdir() mkdtemp.

const PROBE = [
  "const fs = require('node:fs');",
  'const a = process.argv.slice(2);',
  'const [mode, cwddump, argvdump] = a;',
  'const tail = a.slice(3);',
  "try { fs.writeFileSync(cwddump, process.cwd()); } catch (e) {}",
  'try { fs.writeFileSync(argvdump, JSON.stringify(tail)); } catch (e) {}',
  "process.exit(mode === 'fail' ? 1 : 0);",
].join('\n');

const cleanups = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function scratch() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-targeted-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'ape-targeted-out-'));
  cleanups.push(dir, outside);
  return { dir, outside };
}

// A runner whose targeted_template is a cwd+argv-recording probe, so where it
// ran and which paths it received are observable.
function probeRunner(outside, probe, { id, root, mode = 'pass' }) {
  const cwddump = path.join(outside, `${id}.cwd`);
  const argvdump = path.join(outside, `${id}.argv`);
  return {
    config: {
      id, owns: [`${root}/**`], root,
      profile: { targeted_template: `node "${probe}" ${mode} "${cwddump}" "${argvdump}" {paths}` },
    },
    cwd: async () => { try { return (await readFile(cwddump, 'utf8')).trim(); } catch { return null; } },
    argv: async () => { try { return JSON.parse(await readFile(argvdump, 'utf8')); } catch { return null; } },
    ran: async () => { try { await readFile(cwddump, 'utf8'); return true; } catch { return false; } },
  };
}

async function withRunnerDirs(dir, ...roots) {
  for (const root of roots) await mkdir(path.join(dir, root), { recursive: true });
}

describe('APE v2 per-runner targeted gate (review #4)', () => {
  it('routes each test path to its owner and runs it scoped at that runner root', async () => {
    const { dir, outside } = await scratch();
    await withRunnerDirs(dir, 'web', 'api');
    const probe = path.join(outside, 'probe.cjs');
    await writeFile(probe, PROBE);
    const web = probeRunner(outside, probe, { id: 'web', root: 'web' });
    const api = probeRunner(outside, probe, { id: 'api', root: 'api' });

    const present = ['web/foo.test.tsx', 'api/test_foo.py'];
    const result = await evaluateTargetedRunners(dir, present, { runners: [web.config, api.config] }, 30_000, 'tree-1');

    expect(result.executed).toBe(true);
    expect(result.passed).toBe(true);
    expect(result.runners.map((entry) => entry.id).sort()).toEqual(['api', 'web']);

    // #4 CORE: each runner ran at its OWN root and received ONLY its own paths,
    // relativized to that root — vitest never sees the .py, pytest never the .tsx.
    expect(path.basename(await web.cwd())).toBe('web');
    expect(await web.argv()).toEqual(['foo.test.tsx']);
    expect(path.basename(await api.cwd())).toBe('api');
    expect(await api.argv()).toEqual(['test_foo.py']);
  });

  it('ANDs the per-runner verdicts: one red runner fails the whole targeted gate', async () => {
    const { dir, outside } = await scratch();
    await withRunnerDirs(dir, 'web', 'api');
    const probe = path.join(outside, 'probe.cjs');
    await writeFile(probe, PROBE);
    const web = probeRunner(outside, probe, { id: 'web', root: 'web', mode: 'pass' });
    const api = probeRunner(outside, probe, { id: 'api', root: 'api', mode: 'fail' });

    const result = await evaluateTargetedRunners(dir, ['web/a.test.tsx', 'api/test_b.py'], { runners: [web.config, api.config] }, 30_000, 'tree-1');
    expect(result.executed).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.runners.find((entry) => entry.id === 'api').passed).toBe(false);
    expect(result.runners.find((entry) => entry.id === 'web').passed).toBe(true);
  });

  it('runs ONLY the runners that own a present path', async () => {
    const { dir, outside } = await scratch();
    await withRunnerDirs(dir, 'web', 'api');
    const probe = path.join(outside, 'probe.cjs');
    await writeFile(probe, PROBE);
    const web = probeRunner(outside, probe, { id: 'web', root: 'web' });
    const api = probeRunner(outside, probe, { id: 'api', root: 'api' });

    // Only a web path changes — the api runner must not run at all.
    const result = await evaluateTargetedRunners(dir, ['web/only.test.tsx'], { runners: [web.config, api.config] }, 30_000, 'tree-1');
    expect(result.runners.map((entry) => entry.id)).toEqual(['web']);
    expect(await web.ran()).toBe(true);
    expect(await api.ran()).toBe(false);
  });

  it('fails closed on an orphan test path owned by no runner', async () => {
    const { dir, outside } = await scratch();
    const probe = path.join(outside, 'probe.cjs');
    await writeFile(probe, PROBE);
    const web = probeRunner(outside, probe, { id: 'web', root: 'web' });
    const result = await evaluateTargetedRunners(dir, ['unowned/x.test.tsx'], { runners: [web.config] }, 30_000, 'tree-1');
    expect(result.executed).toBe(false);
    expect(result.reason).toMatch(/owned by no configured runner/);
  });

  it('fails closed when a participating runner cannot be scoped (no template, no detectable runner)', async () => {
    const { dir, outside } = await scratch();
    await withRunnerDirs(dir, 'web');
    // A runner with no targeted_template and an empty root (no manifest) cannot
    // scope a non-JS test path — a whole-suite run is not proof it passes.
    const config = { runners: [{ id: 'web', owns: ['web/**'], root: 'web', profile: {} }] };
    const result = await evaluateTargetedRunners(dir, ['web/thing_test.py'], config, 30_000, 'tree-1');
    expect(result.executed).toBe(false);
    expect(result.reason).toMatch(/cannot scope|targeted_template/);
  });
});
