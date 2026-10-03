import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { buildSpawnPlan, runTestSuite } from '../lib/runtime/runner.js';
import { spawnWithTimeout } from '../lib/runtime/spawn.js';

const windows = process.platform === 'win32';
const roots = [];
const children = [];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
async function waitFor(check, label) {
  for (const end = Date.now() + 25_000; Date.now() < end;) {
    if (await check()) return;
    await delay(25);
  }
  throw new Error(`Native Windows fixture did not reach ${label}`);
}
afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  for (const root of roots.splice(0)) {
    for (const name of await readdir(root)) {
      if (!name.endsWith('.pid')) continue;
      const pid = Number(await readFile(path.join(root, name), 'utf8'));
      try { process.kill(pid, 'SIGKILL'); } catch {}
    }
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'ape Windows ownership café '));
  roots.push(root);
  await writeFile(path.join(root, 'descendant.cjs'), `
    const fs = require('node:fs'); const path = require('node:path');
    const root = process.argv[2];
    fs.writeFileSync(path.join(root, 'descendant.pid'), String(process.pid));
    setInterval(() => fs.appendFileSync(path.join(root, 'beats'), 'x'), 20);
    setTimeout(() => process.exit(94), 60000);
  `);
  await writeFile(path.join(root, 'suite.cjs'), `
    const fs = require('node:fs'); const path = require('node:path'); const {spawn} = require('node:child_process');
    const root = process.argv[2];
    fs.writeFileSync(path.join(root, 'suite.pid'), String(process.pid));
    fs.writeFileSync(path.join(root, 'args.json'), JSON.stringify(process.argv.slice(3)));
    const child = spawn(process.execPath, [path.join(root, 'descendant.cjs'), root], {stdio:'ignore'});
    child.unref();
    const timer = setInterval(() => {
      if (fs.existsSync(path.join(root, 'release')) && fs.existsSync(path.join(root, 'descendant.pid'))) process.exit(0);
    }, 20);
    setTimeout(() => process.exit(93), 60000);
  `);
  return root;
}
async function liveTree(root) {
  await waitFor(() => readFile(path.join(root, 'descendant.pid')).then(() => true, () => false), 'live descendant');
  const suite = Number(await readFile(path.join(root, 'suite.pid'), 'utf8'));
  const descendant = Number(await readFile(path.join(root, 'descendant.pid'), 'utf8'));
  expect(alive(suite)).toBe(true);
  expect(alive(descendant)).toBe(true);
  return { suite, descendant };
}

// Instrument only the real broker launch in an isolated owner process. The
// Job Object code and private proof transport run unchanged. A suffix barrier
// holds PowerShell after its proof flush, exposing the interval in which work
// is retired but the broker still owns cwd/output handles. The no-proof arm
// stops immediately before publication, after the real Job has been retired.
async function barrierOwner(root, scenario, publish = true) {
  const runnerUrl = pathToFileURL(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../lib/runtime/runner.js')).href;
  const ownerFile = path.join(root, 'barrier-owner.mjs');
  const source = `
    import cp from 'node:child_process';
    import net from 'node:net';
    import fs from 'node:fs';
    import path from 'node:path';
    import {syncBuiltinESMExports} from 'node:module';
    const root = ${JSON.stringify(root)};
    const original = cp.spawn;
    let broker, closed = false, settled = false;
    const createServer = net.createServer;
    net.createServer = function(listener) {
      return createServer.call(this, (socket) => {
        listener(socket);
        let received = '';
        socket.on('data', (chunk) => {
          received += chunk;
          if (received.includes('\\n')) {
            // Registered after the production listener, so this event means
            // the real authentication/completion handler has already run.
            process.send({event:'proof-delivered'});
            received = '';
          }
        });
      });
    };
    cp.spawn = function(command, args, options) {
      if (String(command).toLowerCase().endsWith('powershell.exe')) {
        const at = args.indexOf('-EncodedCommand');
        if (at < 0) throw new Error('expected the private native broker');
        let script = Buffer.from(args[at + 1], 'base64').toString('utf16le');
        if (!${publish}) {
          const publication = script.indexOf('$p=New-Object System.IO.Pipes.NamedPipeClientStream');
          if (publication < 0) throw new Error('native proof publication boundary unavailable');
          script = script.slice(0, publication);
        }
        const encodedRoot = Buffer.from(root).toString('base64');
        script += '\\n$fixtureRoot=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("' + encodedRoot + '"))\\n' +
          '[IO.File]::WriteAllText([IO.Path]::Combine($fixtureRoot,"broker-held"),"held")\\n' +
          '$fixtureClock=[Diagnostics.Stopwatch]::StartNew()\\n' +
          'while (!(Test-Path -LiteralPath ([IO.Path]::Combine($fixtureRoot,"broker-release"))) -and $fixtureClock.ElapsedMilliseconds -lt 15000) { Start-Sleep -Milliseconds 10 }\\n' +
          '[Console]::Out.WriteLine("broker-drain-tail")\\n';
        args = [...args];
        args[at + 1] = Buffer.from(script, 'utf16le').toString('base64');
        broker = original.call(this, command, args, options);
        broker.once('close', () => { closed = true; process.send({event:'broker-close'}); });
        return broker;
      }
      return original.call(this, command, args, options);
    };
    syncBuiltinESMExports();
    process.on('message', (m) => {
      if (m === 'inspect') process.send({event:'snapshot', settled, closed});
      if (m === 'finish') process.disconnect();
    });
    const {runTestSuite} = await import(${JSON.stringify(runnerUrl)});
    const scenario = ${JSON.stringify(scenario)};
    const result = await runTestSuite(root, {
      override: scenario === 'missing' ? {command:path.join(root,'no-such-runner-xyz'),args:[]} :
        {command:process.execPath,args:[path.join(root,'boundary-suite.cjs'),root,scenario]},
      timeout_ms: scenario === 'timeout' ? 3000 : 30000,
      kill_grace_ms: 300, drain_ms: 1000,
    });
    settled = true;
    process.send({event:'result', result, closed});
  `;
  await writeFile(ownerFile, source);
  await writeFile(path.join(root, 'boundary-suite.cjs'), `
    const fs = require('node:fs'), path = require('node:path'), {spawn} = require('node:child_process');
    const [root, scenario] = process.argv.slice(2);
    fs.writeFileSync(path.join(root, 'suite.pid'), String(process.pid));
    process.on('SIGTERM', () => {});
    const descendant = spawn(process.execPath, [path.join(root, 'descendant.cjs'), root], {stdio:'ignore'});
    descendant.unref();
    const interval = setInterval(() => {
      if (!fs.existsSync(path.join(root,'descendant.pid'))) return;
      if (scenario === 'timeout') return;
      clearInterval(interval);
      process.stdout.write(scenario === 'output' ? 'x'.repeat(400000) : 'suite-output\\n', () => process.exit(0));
    }, 10);
    setTimeout(() => process.exit(92), 10000).unref();
  `);
  const child = spawn(process.execPath, [ownerFile], {cwd:root, stdio:['ignore','pipe','pipe','ipc']});
  children.push(child);
  const events = [];
  let diagnostics = '';
  child.stdout.on('data', (s) => { if (diagnostics.length < 4096) diagnostics += s; });
  child.stderr.on('data', (s) => { if (diagnostics.length < 4096) diagnostics += s; });
  child.on('message', (m) => events.push(m));
  child.on('error', (e) => events.push({event:'owner-error', message:e.message}));
  const event = async (name) => {
    await waitFor(() => {
      if (child.exitCode !== null || events.some((e) => e.event === 'owner-error')) {
        throw new Error('boundary owner failed: ' + diagnostics + JSON.stringify(events));
      }
      return events.some((e) => e.event === name);
    }, name);
    return events.find((e) => e.event === name);
  };
  return { child, event };
}

// Capture the actual launch in a separate process; mocks cannot affect native tests.
// Native mode inserts progress before compilation without changing Job/proof code.
async function progressOwner(root, native, limit) {
  const spawnUrl = pathToFileURL(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../lib/runtime/spawn.js')).href;
  const ownerFile = path.join(root, 'progress-owner.mjs');
  await writeFile(ownerFile, `
    import cp from 'node:child_process';
    import net from 'node:net';
    import {EventEmitter} from 'node:events';
    import {syncBuiltinESMExports} from 'node:module';
    const original = cp.spawn;
    const native = ${JSON.stringify(native)};
    let preamble = null, intercepted = 0;
    if (!native) {
      Object.defineProperty(process, 'platform', {value:'win32'});
      net.createServer = () => {
        const server = new EventEmitter();
        server.listen = (_pipe, ready) => { queueMicrotask(ready); return server; };
        server.close = () => server;
        return server;
      };
    }
    cp.spawn = function(command, args, options) {
      if (!String(command).toLowerCase().endsWith('powershell.exe')) throw new Error('unexpected launch');
      const at = args.indexOf('-EncodedCommand');
      if (at < 0) throw new Error('missing encoded broker');
      let script = Buffer.from(args[at + 1], 'base64').toString('utf16le');
      const boundary = script.indexOf('Add-Type -TypeDefinition');
      if (boundary < 0) throw new Error('missing compilation boundary');
      intercepted++;
      preamble = script.slice(0, boundary);
      if (!native) throw new Error('capture-only launch');
      script = script.slice(0, boundary) +
        'Write-Progress -Activity "APE diagnostic leakage fixture" -Status "Before compilation" -PercentComplete 50\\n' +
        script.slice(boundary);
      args = [...args];
      args[at + 1] = Buffer.from(script, 'utf16le').toString('base64');
      return original.call(this, command, args, options);
    };
    syncBuiltinESMExports();
    const {spawnWithTimeout} = await import(${JSON.stringify(spawnUrl)});
    const result = await spawnWithTimeout(process.execPath, ['-e', 'process.exitCode = 0'], {
      cwd:${JSON.stringify(root)}, supervise:true, collect:'separate',
      timeout_ms:30000, drain_ms:5000,
      ...${JSON.stringify(limit === undefined ? {} : {max_output:limit})},
    });
    process.stdout.write(JSON.stringify({preamble, intercepted, result}));
  `);
  return spawnWithTimeout(process.execPath, [ownerFile], {
    cwd:root, collect:'separate', timeout_ms:40000,
  });
}

describe('Windows broker launch construction (isolated transport capture)', () => {
  it('suppresses broker progress before compilation while retaining stop-on-error', async () => {
    const root = await fixture();
    const captured = await progressOwner(root, false);
    expect(captured).toMatchObject({exit_code:0, timed_out:false, spawn_error:null, stderr:''});
    const launch = JSON.parse(captured.stdout);
    expect(launch.intercepted).toBe(1);
    expect(launch.preamble).toMatch(/\$ProgressPreference\s*=\s*['"]SilentlyContinue['"]/i);
    expect(launch.preamble).toMatch(/\$ErrorActionPreference\s*=\s*['"]Stop['"]/i);
    expect(launch.result.cleanup.status).toBe('unknown');
  }, 45000);
});

// The general durable-gate file runs receipt/REGATE/SHIP, both state sinks,
// lock recovery and sequential generations on every native OS. These arms
// specifically require Windows Job Object behavior, not a mocked platform.
describe.skipIf(!windows)('Windows native ownership and completion proof', () => {
  it.each([undefined, 64, 0])('does not collect forced broker progress for a silent child with cap %s', async (limit) => {
    const root = await fixture();
    const observed = await progressOwner(root, true, limit);
    expect(observed).toMatchObject({exit_code:0, timed_out:false, spawn_error:null, stderr:''});
    const {intercepted, result} = JSON.parse(observed.stdout);
    expect(intercepted).toBe(1);
    expect(result).toMatchObject({
      exit_code:0, timed_out:false, spawn_error:null, stdout:'', stderr:'', combined:'',
      stdout_truncated:false, stderr_truncated:false,
      cleanup:{status:'confirmed', cause:'owned job ActiveProcesses is zero'},
    });
  }, 50000);

  it.each(['success', 'output', 'timeout', 'missing'])(
    'waits for real broker close and output drain after %s retirement proof', async (scenario) => {
      const root = await fixture();
      const owner = await barrierOwner(root, scenario);
      try {
        await waitFor(() => readFile(path.join(root, 'broker-held')).then(() => true, () => false), 'proof-flushed broker barrier');
        await owner.event('proof-delivered');
        owner.child.send('inspect');
        const snapshot = await owner.event('snapshot');
        expect(snapshot.closed, 'the suffix barrier must still own the broker handles').toBe(false);
        expect(snapshot.settled, 'proof delivery alone must not resolve before broker close/drain').toBe(false);
        if (scenario !== 'missing') {
          for (const name of ['suite.pid', 'descendant.pid']) {
            const pid = Number(await readFile(path.join(root, name), 'utf8'));
            expect(alive(pid), `${name} must be retired before the proof barrier`).toBe(false);
          }
        }
        await writeFile(path.join(root, 'broker-release'), 'go');
        const observed = await owner.event('result');
        expect(observed.closed).toBe(true);
        const result = observed.result;
        if (scenario === 'missing') {
          expect(result).toMatchObject({passed:false, tooling_failure:true, exit_code:null});
        } else {
          expect(result.cleanup).toMatchObject({status:'confirmed', cause:'owned job ActiveProcesses is zero'});
          expect(result.tooling_failure).toBe(false);
          expect(result.passed).toBe(scenario !== 'timeout');
          if (scenario === 'timeout') expect(result.timed_out).toBe(true);
          else expect('timed_out' in result).toBe(false);
          if (scenario === 'output') {
            expect(result.output.length).toBeGreaterThanOrEqual(200000);
            expect(result.output.length).toBeLessThanOrEqual(200000 + 65536);
          } else expect(result.output).toContain('broker-drain-tail');
        }
      } finally {
        await writeFile(path.join(root, 'broker-release'), 'go');
        await owner.event('broker-close');
        if (owner.child.connected) owner.child.send('finish');
      }
    }, 50_000,
  );

  it('does not promote broker close without an authenticated retirement message to success', async () => {
    const root = await fixture();
    const owner = await barrierOwner(root, 'success', false);
    try {
      await waitFor(() => readFile(path.join(root, 'broker-held')).then(() => true, () => false), 'unpublished proof barrier');
      for (const name of ['suite.pid', 'descendant.pid']) {
        expect(alive(Number(await readFile(path.join(root, name), 'utf8')))).toBe(false);
      }
      await writeFile(path.join(root, 'broker-release'), 'go');
      const {result, closed} = await owner.event('result');
      expect(closed).toBe(true);
      expect(result).toMatchObject({passed:false, tooling_failure:true, exit_code:null});
      expect(result.output).toMatch(/without completion proof/);
    } finally {
      await writeFile(path.join(root, 'broker-release'), 'go');
      await owner.event('broker-close');
      if (owner.child.connected) owner.child.send('finish');
    }
  }, 50_000);

  it('normal successful work returns confirmed cleanup rather than permanently unknown', async () => {
    const root = await fixture();
    const pending = spawnWithTimeout(process.execPath, [path.join(root, 'suite.cjs'), root], {
      cwd: root, supervise: true, timeout_ms: 40_000, kill_grace_ms: 200, drain_ms: 100,
    });
    const tree = await liveTree(root);
    await writeFile(path.join(root, 'release'), 'go');
    const result = await pending;
    expect(result).toMatchObject({ exit_code: 0, timed_out: false, spawn_error: null, cleanup: { status: 'confirmed' } });
    expect(alive(tree.suite)).toBe(false);
    expect(alive(tree.descendant), 'the closed-output ordinary descendant must be retired before confirmed').toBe(false);
  }, 50_000);

  it('cancels a live Job through the broker and returns authenticated retirement before cleanup', async () => {
    const root = await fixture();
    const cancellation = new AbortController();
    const pending = spawnWithTimeout(process.execPath, [path.join(root, 'suite.cjs'), root], {
      cwd:root, supervise:true, signal:cancellation.signal, timeout_ms:40000,
      kill_grace_ms:300, drain_ms:1000,
    });
    const tree = await liveTree(root);
    cancellation.abort();
    const result = await pending;
    expect(result).toMatchObject({aborted:true, timed_out:false, spawn_error:null,
      cleanup:{status:'confirmed', cause:'owned job ActiveProcesses is zero'}});
    expect(alive(tree.suite)).toBe(false);
    expect(alive(tree.descendant)).toBe(false);
  }, 50_000);

  it('contains a real CMD wrapper with Unicode/space arguments and does not leak control handles', async () => {
    const root = await fixture();
    await writeFile(path.join(root, 'fixture.cmd'), `@echo off\r\n"${process.execPath}" "%~dp0suite.cjs" "%~dp0." %*\r\n`);
    const plan = buildSpawnPlan(path.join(root, 'fixture.cmd'), ['argument with spaces', 'café']);
    expect(plan.shell).toBe(true);
    const pending = spawnWithTimeout(plan.command, plan.args, { cwd: root, shell: plan.shell,
      supervise: true, timeout_ms: 40_000, kill_grace_ms: 200, drain_ms: 100 });
    const tree = await liveTree(root);
    expect(JSON.parse(await readFile(path.join(root, 'args.json'), 'utf8'))).toEqual(['argument with spaces', 'café']);
    await writeFile(path.join(root, 'release'), 'go');
    const result = await pending;
    expect(result).toMatchObject({ exit_code: 0, cleanup: { status: 'confirmed' } });
    expect(alive(tree.suite)).toBe(false);
    expect(alive(tree.descendant)).toBe(false);
  }, 50_000);

  it('retains ordinary descendants in containment when the suite runner dies abruptly', async () => {
    const root = await fixture();
    const spawnUrl = pathToFileURL(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../lib/runtime/spawn.js')).href;
    const owner = path.join(root, 'owner.mjs');
    await writeFile(owner, `import {spawnWithTimeout} from ${JSON.stringify(spawnUrl)}; await spawnWithTimeout(process.execPath, [${JSON.stringify(path.join(root, 'suite.cjs'))}, ${JSON.stringify(root)}], {cwd:${JSON.stringify(root)},supervise:true,timeout_ms:40000});`);
    const child = spawn(process.execPath, [owner], { cwd: root, stdio: 'ignore' });
    children.push(child);
    const exited = new Promise((resolve) => child.once('exit', resolve));
    const tree = await liveTree(root);
    child.kill('SIGKILL');
    await exited;
    await waitFor(() => !alive(tree.suite) && !alive(tree.descendant), 'retirement after runner death');
    // This assertion precedes fallback cleanup. Killing only the direct
    // runner with taskkill or assuming its exit proves tree death fails here.
    expect(alive(tree.descendant)).toBe(false);
  }, 50_000);

  it('keeps npm script success usable through the same confirmed cleanup path', async () => {
    const root = await fixture();
    await mkdir(path.join(root, 'npm package'));
    await writeFile(path.join(root, 'npm package/package.json'), JSON.stringify({ private: true, scripts: {
      test: `node "${path.join(root, 'suite.cjs').replaceAll('\\', '/')}" "${root.replaceAll('\\', '/')}"`,
    } }));
    const pending = runTestSuite(path.join(root, 'npm package'), { command: 'npm test --silent', timeout_ms: 40_000 });
    const tree = await liveTree(root);
    await writeFile(path.join(root, 'release'), 'go');
    const result = await pending;
    expect(result).toMatchObject({ passed: true, exit_code: 0, tooling_failure: false, cleanup: { status: 'confirmed' } });
    expect(alive(tree.suite)).toBe(false);
    expect(alive(tree.descendant)).toBe(false);
  }, 50_000);
});
