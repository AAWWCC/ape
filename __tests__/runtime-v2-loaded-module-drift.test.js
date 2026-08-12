import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import {
  appendFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { doctor } from '../lib/runtime/doctor.js';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// roadmap entry bundle-drift-cannot-see-the-loaded-module: the bundle-drift
// doctor check compares FILE BYTES ON DISK, so it reports healthy while the
// running MCP module differs from what is on disk now.
//
// Two observable consequences, both exercised here against a real MCP server
// process running a real bundle:
//
//  1. When the executing bundle IS the governed project's own tracked dist/
//     output (the project-root deployment: `node <project>/dist/ape-mcp.bundle.mjs`),
//     the disk comparison compares a file to ITSELF, so it can only ever be equal.
//  2. An on-disk comparison cannot see in-memory staleness at all: the server
//     loads the bundle once at session start, `npm run bundle` then rewrites
//     that file, and BOTH sides of the comparison become the new bytes — the
//     check goes green precisely BECAUSE a rebuild happened, while the live
//     process keeps executing the module it loaded earlier.
//
// The contract this file pins, derived from the public `ape_config doctor`
// surface (and `doctor()` for the installed-copy dimension):
//
//  (a) after a real rebuild under a live server, the report carries an
//      informational notice that the module the process is EXECUTING no longer
//      matches the bundle on disk, naming the recovery for THIS deployment
//      shape — restart the MCP server;
//  (b) the notice stays informational: never a health failure, never a run-start
//      block, on any host;
//  (c) no notice while the loaded module still matches the file on disk;
//  (d) silence in a project that tracks no APE bundle, and in a non-git
//      directory;
//  (e) the pre-existing PATH-based dimension survives: an installed-copy
//      deployment whose tracked dist/ differs from the executing bundle's
//      directory still gets its notice, naming the plugin reload recovery.
//
// Deliberately implementation-agnostic: the fingerprint may be a hash, a
// length+mtime stamp, or a build stamp baked into the bundle, so the fixture
// produces the stale-module condition the only faithful way — by running the
// project's OWN bundler over changed sources while the server keeps running —
// and the assertions match on reported CONTENT rather than on one check name.
describe('ape v2 doctor sees the LOADED runtime module, not just disk bytes', () => {
  const dirs = [];

  function tempDir(prefix) {
    // realpath: the ESM loader reports the resolved path in import.meta.url, so
    // an unresolved /var -> /private/var temp path would compare two spellings
    // of the same file for reasons unrelated to this contract.
    const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
    dirs.push(dir);
    return dir;
  }

  function cleanup(dir) {
    // Unlink the node_modules SYMLINK before the recursive remove so no
    // cleanup path can ever reach into the repository's real node_modules.
    try {
      rmSync(join(dir, 'node_modules'), { force: true, maxRetries: 10, retryDelay: 500 });
    } catch {
      /* not staged with a symlink */
    }
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  }

  function gitInit(dir) {
    execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
  }

  function gitCommitAll(dir, message) {
    execFileSync('git', ['add', '--all'], { cwd: dir, stdio: 'ignore' });
    execFileSync(
      'git',
      [
        '-c',
        'user.email=ape@test.invalid',
        '-c',
        'user.name=ape-test',
        'commit',
        '--no-verify',
        '--no-gpg-sign',
        '-m',
        message,
      ],
      { cwd: dir, stdio: 'ignore' },
    );
  }

  // `npm run bundle` for a staged copy: the project's own bundler, so whatever
  // it bakes into the artifact (including any build stamp) is present exactly
  // as a real release build produces it.
  function runBundler(dir) {
    execFileSync(process.execPath, [join(dir, 'scripts', 'bundle-mcp.mjs')], { cwd: dir, stdio: 'ignore' });
  }

  // A self-contained APE deployment whose dist/ bundles are built from THIS
  // checkout's sources and committed, so the executing bundle is the governed
  // project's own tracked output — the project-root deployment shape.
  function stageDeployment() {
    const dir = tempDir('ape-loaded-drift-');
    for (const entry of ['package.json', 'bin', 'lib', 'scripts', 'hooks']) {
      cpSync(join(REPO_ROOT, entry), join(dir, entry), { recursive: true });
    }
    symlinkSync(join(REPO_ROOT, 'node_modules'), join(dir, 'node_modules'), 'dir');
    writeFileSync(join(dir, '.gitignore'), 'node_modules\n');
    mkdirSync(join(dir, '.ape', 'runtime'), { recursive: true });
    writeFileSync(
      join(dir, '.ape', 'runtime', 'config.json'),
      JSON.stringify({ version: 2, test_commands: { full: 'npm test' } }),
    );
    gitInit(dir);
    runBundler(dir);
    gitCommitAll(dir, 'ship dist bundles');
    return dir;
  }

  function startServer(projectDir) {
    const env = { ...process.env };
    // Root resolution must come from the call arguments alone, never from the
    // ambient session pins of whoever runs the suite.
    delete env.CLAUDE_PROJECT_DIR;
    delete env.CODEX_CWD;
    const child = spawn(process.execPath, [join(projectDir, 'dist', 'ape-mcp.bundle.mjs')], {
      cwd: projectDir,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const pending = new Map();
    let buffer = '';
    let stderr = '';
    let exit = null;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let index = buffer.indexOf('\n');
      while (index >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf('\n');
        if (line === '') continue;
        let message = null;
        try {
          message = JSON.parse(line);
        } catch {
          continue; // progress/diagnostic noise is not a response frame
        }
        const settle = pending.get(message?.id);
        if (settle) {
          pending.delete(message.id);
          settle.resolve(message);
        }
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('exit', (code, signal) => {
      exit = { code, signal };
      for (const settle of pending.values()) settle.reject(new Error(`server exited (${code}/${signal}): ${stderr}`));
      pending.clear();
    });
    let nextId = 0;
    const request = (method, params) =>
      new Promise((resolve, reject) => {
        if (exit !== null) {
          reject(new Error(`server already exited: ${stderr}`));
          return;
        }
        const id = ++nextId;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`no response to ${method} within 60s: ${stderr}`));
        }, 60_000);
        pending.set(id, {
          resolve: (message) => {
            clearTimeout(timer);
            resolve(message);
          },
          reject: (cause) => {
            clearTimeout(timer);
            reject(cause);
          },
        });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    return {
      request,
      alive: () => exit === null,
      async doctorReport(args) {
        const message = await request('tools/call', {
          name: 'ape_config',
          arguments: { action: 'doctor', ...args },
        });
        const text = message.result?.content?.[0]?.text ?? '';
        if (message.result?.isError) throw new Error(`ape_config doctor reported an error: ${text}`);
        const payload = JSON.parse(text);
        if (!Array.isArray(payload?.doctor?.checks)) {
          throw new Error(`ape_config doctor returned no checks: ${text.slice(0, 400)}`);
        }
        return payload.doctor;
      },
      stop() {
        try {
          child.stdin.end();
        } catch {
          /* already gone */
        }
        child.kill('SIGKILL');
      },
    };
  }

  // Any check entry reporting a bundle/module problem. Matched on CONTENT, not
  // on a single hard-coded name: an implementation may extend the existing
  // `bundle-drift` check or add a sibling check for the loaded-module
  // dimension, and either shape satisfies this contract.
  const isBundleNotice = (entry) => {
    const text = `${entry.name ?? ''} ${entry.detail ?? ''}`;
    return (
      /bundle|module/i.test(text) && /drift|stale|outdated|out.of.date|mismatch|differ|no longer/i.test(text)
    );
  };
  // A notice is an entry that is NOT an affirmative pass: informational
  // (passed: null) or, hypothetically, a failure. Every such entry is returned,
  // so an implementation reporting the two drift dimensions as two checks is
  // judged on the whole set rather than on whichever one comes first.
  const bundleNotices = (report) => report.checks.filter((entry) => entry.passed !== true).filter(isBundleNotice);
  const expectInformationalOnly = (notices) => {
    for (const notice of notices) {
      expect(notice.informational, `${notice.name} must be informational`).toBe(true);
      expect(notice.passed, `${notice.name} must never fail health`).not.toBe(false);
    }
  };

  const RUN_START = {
    explicit_invocation: true,
    hooks_trusted: true,
    subagents_available: true,
    behavioral: false,
  };

  const PROBE =
    '\n// test probe: a real source change, so the rebuilt bundle differs from the loaded one\n' +
    "if (process.env.APE_LOADED_DRIFT_PROBE === 'never-set') process.stderr.write('ape loaded-drift probe\\n');\n";

  let project;
  let bundleFile;
  let loadedBytes;
  let rebuiltBytes;
  let server;
  let reportBeforeRebuild;
  let reportAfterRebuild;
  const runStartReports = {};
  let reportForeignProject;
  let reportNonGitDir;

  beforeAll(async () => {
    project = stageDeployment();
    bundleFile = join(project, 'dist', 'ape-mcp.bundle.mjs');
    loadedBytes = readFileSync(bundleFile);

    // Session start: the server process loads the bundle exactly once. Awaiting
    // a response proves the module finished evaluating, so any load-time
    // fingerprint is now captured.
    server = startServer(project);
    await server.request('initialize', { protocolVersion: '2025-06-18' });
    reportBeforeRebuild = await server.doctorReport({ project_dir: project });

    // Mid-session release build: sources change, the project's own bundler
    // rewrites dist/, and the live server keeps executing the module it loaded
    // at session start.
    appendFileSync(join(project, 'bin', 'ape-mcp.mjs'), PROBE);
    runBundler(project);
    rebuiltBytes = readFileSync(bundleFile);

    reportAfterRebuild = await server.doctorReport({ project_dir: project });
    for (const host of ['claude', 'codex']) {
      runStartReports[host] = await server.doctorReport({ project_dir: project, host, ...RUN_START });
    }

    // A managed project that tracks no APE bundle at all, asked by the same
    // stale-module server.
    const foreign = tempDir('ape-loaded-drift-foreign-');
    mkdirSync(join(foreign, 'dist'), { recursive: true });
    writeFileSync(join(foreign, 'dist', 'index.js'), 'export default 42;\n');
    writeFileSync(join(foreign, 'README.md'), '# managed project\n');
    gitInit(foreign);
    gitCommitAll(foreign, 'seed non-APE build output');
    reportForeignProject = await server.doctorReport({ project_dir: foreign });

    reportNonGitDir = await server.doctorReport({ project_dir: tempDir('ape-loaded-drift-nogit-') });
  }, 240_000);

  afterAll(() => {
    server?.stop();
    dirs.splice(0).forEach(cleanup);
  }, 60_000);

  it('fixture truth: a real rebuild rewrote the bundle while the server kept running the old module', () => {
    expect(server.alive()).toBe(true);
    expect(rebuiltBytes.equals(loadedBytes)).toBe(false);
    // Failure (1): the executing bundle IS the governed project's tracked dist/
    // output, so comparing "project dist" against "the executing bundle's
    // directory" compares one file with itself and can only ever be equal.
    expect(readFileSync(join(project, 'dist', 'ape-mcp.bundle.mjs')).equals(rebuiltBytes)).toBe(true);
  });

  it('says nothing while the loaded module still matches the bundle on disk', () => {
    expect(bundleNotices(reportBeforeRebuild)).toEqual([]);
    expect(reportBeforeRebuild.healthy).toBe(true);
  });

  it('reports the executing module as stale after the rebuild, naming the MCP-server restart recovery', () => {
    const notices = bundleNotices(reportAfterRebuild);
    expect(notices.length, 'no notice that the executing module is stale').toBeGreaterThan(0);
    expectInformationalOnly(notices);
    // The recovery an operator can act on for THIS deployment shape (the
    // executing bundle IS the governed project's own dist/ output): restart the
    // MCP server. A plugin reload is the OTHER deployment's recovery, so the
    // notice must name the case that applies.
    const restart = notices.find((notice) => /restart/i.test(String(notice.detail)));
    expect(restart, 'no notice names the MCP-server restart recovery').toBeDefined();
    expect(restart.detail).toMatch(/server|session/i);
    expect(reportAfterRebuild.healthy).toBe(true);
  });

  it('never fails health and never blocks a run start under a stale loaded module, on either host', () => {
    for (const host of ['claude', 'codex']) {
      const report = runStartReports[host];
      expect(report.healthy).toBe(true);
      // Host-neutral: the same notice is reported whoever the host is.
      const notices = bundleNotices(report);
      expect(notices.length, `no stale-module notice for host ${host}`).toBeGreaterThan(0);
      expectInformationalOnly(notices);
    }
  });

  it('stays silent for a managed project that tracks no APE bundle, and in a non-git directory', () => {
    expect(bundleNotices(reportForeignProject)).toEqual([]);
    expect(reportForeignProject.healthy).toBe(true);
    // A non-git directory fails its own git-repository check; the bundle
    // dimension must add nothing there.
    expect(bundleNotices(reportNonGitDir)).toEqual([]);
  });

  it('keeps the path-based drift dimension for the installed-copy deployment, naming the plugin reload', async () => {
    // The installed-copy shape: the executing runtime was loaded from a
    // directory OUTSIDE the governed project, and that copy's bundles differ
    // from the project's tracked dist/ output. This test process was loaded
    // from this checkout, so a project whose tracked bundles hold other bytes
    // is exactly that case.
    const dir = tempDir('ape-loaded-drift-installed-');
    mkdirSync(join(dir, 'dist'), { recursive: true });
    for (const name of ['ape-mcp.bundle.mjs', 'ape-hooks.bundle.mjs', 'ape-larp.bundle.mjs']) {
      writeFileSync(join(dir, 'dist', name), `// stand-in ${name}: bytes that differ from the executing runtime\n`);
    }
    gitInit(dir);
    gitCommitAll(dir, 'seed drifted dist bundles');

    const report = await doctor(dir, {});
    const notices = bundleNotices(report);
    expect(notices.length, 'the path-based drift dimension went silent').toBeGreaterThan(0);
    expectInformationalOnly(notices);
    expect(report.healthy).toBe(true);
    // The recovery for THIS deployment shape is the plugin reload, not a
    // server restart: the notice must name the case that applies.
    const reload = notices.find((notice) => /reload/i.test(String(notice.detail)));
    expect(reload, 'no notice names the plugin-reload recovery').toBeDefined();
  }, 60_000);
});
