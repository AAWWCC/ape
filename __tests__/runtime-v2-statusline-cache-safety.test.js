import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync,
  rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const renderer = fileURLToPath(new URL('../bin/ape-statusline.mjs', import.meta.url));
const directories = [];
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture(history = false) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'ape-cache-safety-')));
  directories.push(root);
  const project = path.join(root, 'project');
  const cache = path.join(root, 'cache');
  mkdirSync(project); mkdirSync(cache);
  if (history) {
    const runtime = path.join(project, '.ape', 'runtime');
    mkdirSync(path.join(runtime, 'history'), { recursive: true });
    writeFileSync(path.join(runtime, 'active.json'), JSON.stringify({
      schema_version: '2.0.0', run_id: 'run-cache-fixture', objective: 'Cache fixture',
      mode: 'phase', lane: 'mechanical', host: 'codex', status: 'running', stage: 'build',
      dispatch_state: 'none', tickets: [], receipts: [], expired_tickets: [],
      updated_at: new Date().toISOString(),
    }));
  } else {
    const git = (...args) => execFileSync('git', ['-C', project, ...args], { stdio: 'pipe' });
    git('init', '-q', '-b', 'cache-work');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test',
      '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', 'fixture');
  }
  const hash = createHash('sha256').update(project).digest('hex');
  const files = {
    history: path.join(project, '.ape', 'runtime', 'statusline-cache.json'),
    branch: path.join(cache, `ape-statusline-branch-${hash}.json`),
    markers: path.join(cache, `ape-statusline-markers-${hash}.json`),
  };
  return { root, project, cache, files };
}
function childFor(f, envOverrides = {}) {
  const env = { ...process.env, TMPDIR: f.cache, TMP: f.cache, TEMP: f.cache,
    APE_STATUSLINE_CHARSET: 'ascii', APE_STATUSLINE_GIT_TIMEOUT_MS: '5000', ...envOverrides };
  delete env.CLAUDE_PROJECT_DIR; delete env.CODEX_CWD;
  const child = spawn(process.execPath, [renderer], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('status render exceeded watchdog')); }, 5_000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
  });
  return { child, done, start() { child.stdin.end(JSON.stringify({ workspace: { current_dir: f.project } })); } };
}

describe('statusline cache filesystem boundaries', () => {
  it.skipIf(process.platform === 'win32').each([
    ['history', 'symlink'], ['history', 'hardlink'], ['branch', 'symlink'], ['markers', 'symlink'],
  ])('preserves an unrelated target behind the old predictable %s %s temporary', async (kind, type) => {
    const f = fixture(kind === 'history');
    const sentinel = path.join(f.root, 'unrelated.txt');
    writeFileSync(sentinel, 'preserve unrelated contents');
    const run = childFor(f);
    const candidate = `${f.files[kind]}.${run.child.pid}.tmp`;
    if (type === 'symlink') symlinkSync(sentinel, candidate);
    else linkSync(sentinel, candidate);
    run.start();
    expect(await run.done).toMatchObject({ code: 0, signal: null, stderr: '' });
    expect(readFileSync(sentinel, 'utf8')).toBe('preserve unrelated contents');
    expect(lstatSync(candidate).isSymbolicLink()).toBe(type === 'symlink');
    expect(JSON.parse(readFileSync(f.files[kind], 'utf8'))).toBeTruthy();
    expect(readdirSync(path.dirname(f.files[kind])).filter((name) => name.endsWith('.tmp')))
      .toEqual([path.basename(candidate)]);
  });

  it.skipIf(process.platform === 'win32').each(['symlink', 'hardlink', 'regular'])(
    'preserves an existing %s even if a generated cache temporary name collides', async (type) => {
      const f = fixture(true);
      const sentinel = path.join(f.root, 'collision-target.txt');
      writeFileSync(sentinel, 'preserve collision contents');
      const uuid = '11111111-1111-4111-8111-111111111111';
      const candidate = `${f.files.history}.${uuid}.tmp`;
      if (type === 'symlink') symlinkSync(sentinel, candidate);
      else if (type === 'hardlink') linkSync(sentinel, candidate);
      else writeFileSync(candidate, 'preexisting independent temporary');
      const preload = path.join(f.root, 'fixed-cache-uuid.mjs');
      writeFileSync(preload, `import crypto from 'node:crypto';import {syncBuiltinESMExports} from 'node:module';
crypto.randomUUID=()=>${JSON.stringify(uuid)};syncBuiltinESMExports();`);
      const run = childFor(f, { NODE_OPTIONS: `--import=${preload}` });
      run.start();
      expect(await run.done).toMatchObject({ code: 0, signal: null, stderr: '' });
      expect(readFileSync(sentinel, 'utf8')).toBe('preserve collision contents');
      expect(readFileSync(candidate, 'utf8')).toBe(type === 'regular'
        ? 'preexisting independent temporary' : 'preserve collision contents');
      expect(lstatSync(candidate).isSymbolicLink()).toBe(type === 'symlink');
    },
  );

  it.skipIf(process.platform === 'win32').each(['branch', 'markers'])(
    'does not block on a %s cache FIFO after a Git timeout', async (kind) => {
      const f = fixture();
      const slowBin = path.join(f.root, 'slow-bin');
      mkdirSync(slowBin);
      // exec avoids a lingering grandchild keeping the renderer pipes open.
      writeFileSync(path.join(slowBin, 'git'), '#!/bin/sh\nexec sleep 10\n', { mode: 0o755 });
      if (kind === 'markers') writeFileSync(f.files.branch, JSON.stringify({ branch: 'cached-work' }));
      execFileSync('mkfifo', [f.files[kind]]);
      const run = childFor(f, { PATH: `${slowBin}${path.delimiter}${process.env.PATH}`,
        APE_STATUSLINE_GIT_TIMEOUT_MS: '100' });
      run.start();
      const result = await run.done;
      expect(result).toMatchObject({ code: 0, signal: null, stderr: '' });
      if (kind === 'markers') expect(result.stdout).toContain('cached-work');
      expect(lstatSync(f.files[kind]).isFIFO()).toBe(true);
    },
  );
});
