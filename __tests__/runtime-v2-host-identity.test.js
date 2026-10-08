import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireRunLock, releaseRunLock } from '../lib/runtime/lock.js';

const lockUrl = pathToFileURL(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../lib/runtime/lock.js')).href;
const roots = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, {recursive:true,force:true}))); });
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'ape-host-identity-'));
  roots.push(root);
  return root;
}

// A fresh process is essential: no cached parent identity or changed global
// environment can make this test pass. Only the child's observed hostname and
// optional synthetic provider failures are changed.
async function observe(root, name, { unavailable = false, malformed = false, bootVariant = false, namespaceVariant = false, overrides = false } = {}) {
  const script = `
    import os from 'node:os';
    import fs from 'node:fs';
    import cp from 'node:child_process';
    import {syncBuiltinESMExports} from 'node:module';
    os.hostname = () => ${JSON.stringify(name)};
    const transform = (value) => {
      const text = String(value);
      const changed = ${malformed} ? 'malformed-platform-evidence' : text.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/ig, '11111111-2222-4333-8444-555555555555');
      return Buffer.isBuffer(value) ? Buffer.from(changed) : changed;
    };
    if (${malformed || bootVariant || namespaceVariant}) {
      const read = fs.readFileSync;
      fs.readFileSync = (...args) => {
        const value = read(...args);
        return String(args[0]).includes('boot_id') && ${malformed || bootVariant} ? transform(value) : value;
      };
      for (const method of ['execFileSync', 'spawnSync']) {
        const original = cp[method];
        cp[method] = (...args) => {
          const value = original(...args);
          if (!/sysctl|powershell|pwsh/i.test(String(args[0])) || !${malformed || bootVariant}) return value;
          return method === 'spawnSync' ? {...value, stdout:transform(value.stdout)} : transform(value);
        };
      }
      const readlink = fs.readlinkSync;
      fs.readlinkSync = (...args) => {
        const value = readlink(...args);
        return String(args[0]).includes('/ns/pid') && ${namespaceVariant} ? String(value).replace(/[0-9]+/, '987654321') : value;
      };
      const stat = fs.statSync;
      fs.statSync = (...args) => {
        const value = stat(...args);
        if (String(args[0]).includes('/ns/pid') && ${namespaceVariant}) value.ino = typeof value.ino === 'bigint' ? value.ino + 1n : value.ino + 1;
        return value;
      };
    }
    if (${unavailable}) {
      const failure = () => { throw Object.assign(new Error('identity provider unavailable'), {code:'EACCES'}); };
      for (const method of ['readFileSync', 'readlinkSync', 'statSync']) {
        const original = fs[method];
        fs[method] = (...args) => ['boot_id', '/ns/pid', 'machine-id'].some((part) => String(args[0]).includes(part)) ? failure() : original(...args);
      }
      for (const method of ['execFileSync', 'spawnSync']) {
        const original = cp[method];
        cp[method] = (...args) => /sysctl|powershell|pwsh/i.test(String(args[0])) ? failure() : original(...args);
      }
    }
    syncBuiltinESMExports();
    try {
      const {acquireRunLock, releaseRunLock} = await import(${JSON.stringify(lockUrl)});
      const value = await acquireRunLock(${JSON.stringify(path.join(root, name + '.lock'))}, 'fixture', {host:'caller-forged', execution_identity:'caller-forged'});
      await releaseRunLock(${JSON.stringify(path.join(root, name + '.lock'))}, 'fixture');
      console.log(JSON.stringify({ok:true, host:value.host, pid:value.pid}));
    } catch (error) { console.log(JSON.stringify({ok:false, message:error.message})); }
  `;
  const env = {...process.env};
  delete env.NODE_OPTIONS;
  if (overrides) Object.assign(env, {APE_HOST_IDENTITY:'caller-forged', APE_EXECUTION_IDENTITY:'caller-forged', HOSTNAME:'caller-forged', COMPUTERNAME:'caller-forged'});
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {env, stdio:['ignore','pipe','pipe']});
    let out = '', err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.once('error', reject);
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error('isolated identity fixture failed: ' + err.slice(-1024)));
      else { try { resolve(JSON.parse(out)); } catch (error) { reject(error); } }
    });
  });
}

describe('trusted local execution identity through public ownership writes', () => {
  it('agrees across fresh processes and hostname changes while ignoring caller and environment identities', async () => {
    const root = await fixture();
    const a = await observe(root, 'before.invalid');
    const b = await observe(root, 'after.invalid', {overrides:true});
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(a.host).toBe(b.host);
    expect(a.host).not.toBe('before.invalid');
    expect(b.host).not.toBe('caller-forged');
    // The processes have actually exited: a valid current execution record
    // can be recovered despite its creator's old hostname observation.
    const lock = path.join(root, 'recover.lock');
    await writeFile(lock, JSON.stringify({version:1, run_id:'dead', pid:a.pid, host:a.host}));
    const recovered = await acquireRunLock(lock, 'recovered', {recoverStale:true});
    expect(recovered.run_id).toBe('recovered');
    await releaseRunLock(lock, 'recovered');
  }, 40_000);

  it.each(['unavailable', 'malformed'])('fails closed before writing ownership when platform identity evidence is %s', async (fault) => {
    const root = await fixture();
    const result = await observe(root, 'unavailable.invalid', {[fault]:true});
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/identity|execution|boot|unavailable/i);
    await expect(readFile(path.join(root, 'unavailable.invalid.lock'))).rejects.toMatchObject({code:'ENOENT'});
  }, 20_000);

  it('distinguishes a foreign boot execution even with the same observed hostname', async () => {
    const root = await fixture();
    const current = await observe(root, 'same.invalid');
    const foreign = await observe(root, 'same.invalid', {bootVariant:true});
    expect(current.ok).toBe(true);
    expect(foreign.ok).toBe(true);
    expect(foreign.host).not.toBe(current.host);
  }, 40_000);

  it.skipIf(process.platform !== 'linux')('distinguishes a foreign PID namespace within the same boot', async () => {
    const root = await fixture();
    const current = await observe(root, 'same.invalid');
    const foreign = await observe(root, 'same.invalid', {namespaceVariant:true});
    expect(current.ok).toBe(true);
    expect(foreign.ok).toBe(true);
    expect(foreign.host).not.toBe(current.host);
  }, 40_000);

  it.each(['legacy', 'foreign', 'malformed'])('never recovers or relabels a %s dead-owner record', async (kind) => {
    const root = await fixture();
    const current = await observe(root, 'current.invalid');
    expect(current.ok).toBe(true);
    const host = kind === 'legacy' ? hostname() : kind === 'malformed' ? {identity:current.host} :
      String(current.host).replace(/[a-f0-9](?=[^a-f0-9]*$)/, (digit) => digit === '0' ? '1' : '0');
    if (kind === 'foreign') expect(host).not.toBe(current.host);
    const lock = path.join(root, 'retained.lock');
    const bytes = JSON.stringify({version:1,run_id:'retained',pid:current.pid,host});
    await writeFile(lock, bytes);
    await expect(acquireRunLock(lock, 'replacement', {recoverStale:true})).rejects.toThrow();
    expect(await readFile(lock, 'utf8')).toBe(bytes);
  }, 20_000);
});


// Frozen test reference from 5a03bd7e752a08c0dd857e36072d05f806665eaa.
// This runs independently of Git/network and does not read production source.
const savedWindowsBootScript = "\n$ErrorActionPreference = 'Stop'\nAdd-Type -TypeDefinition @'\nusing System;\nusing System.Runtime.InteropServices;\npublic static class ApeBootIdentity {\n  [DllImport(\"ntdll.dll\")] static extern int NtQuerySystemInformation(int c, IntPtr p, int n, out int size);\n  public static string Read() {\n    IntPtr p = Marshal.AllocHGlobal(32);\n    try {\n      int size;\n      if (NtQuerySystemInformation(90, p, 32, out size) != 0) throw new Exception(\"Boot identity unavailable\");\n      byte[] bytes = new byte[16]; Marshal.Copy(p, bytes, 0, 16);\n      return new Guid(bytes).ToString();\n    } finally { Marshal.FreeHGlobal(p); }\n  }\n}\n'@\n[ApeBootIdentity]::Read()\n";
const windowsProvider = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const savedWindowsEnvironment = {
  SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows',
  PATH: 'C:\\Windows\\System32',
  PSModulePath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules',
  TEMP: 'C:\\Windows\\Temp', TMP: 'C:\\Windows\\Temp',
};
const identityUrl = new URL('../lib/runtime/host-identity.js', import.meta.url).href;

// Every probe is a fresh Node process. Provider output and errors stay inside
// that process; only booleans, validated execution digests and categories leave.
// A native result is evidence only after close, including stdout/stderr drain.
async function windowsIdentityProbe(mode, fault = 'none') {
  const root = await fixture();
  const script = `
    import cp from 'node:child_process';
    import fs from 'node:fs';
    import {createHash} from 'node:crypto';
    import {syncBuiltinESMExports} from 'node:module';
    const mode = ${JSON.stringify(mode)};
    const fault = ${JSON.stringify(fault)};
    const savedScript = ${JSON.stringify(savedWindowsBootScript)};
    const executable = ${JSON.stringify(windowsProvider)};
    const fixedEnv = ${JSON.stringify(savedWindowsEnvironment)};
    const lock = ${JSON.stringify(path.join(root, 'probe.lock'))};
    const options = {encoding:'utf8', timeout:5000, maxBuffer:16384, windowsHide:true, env:fixedEnv};
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const valid = value => uuid.test(value) && value !== '00000000-0000-0000-0000-000000000000';
    const digest = value => 'ape-execution-v1:' + createHash('sha256').update(JSON.stringify(['win32', value.toLowerCase(), ''])).digest('hex');
    function classify(error) {
      if (error?.code === 'ETIMEDOUT') return 'timeout';
      if (['ENOENT', 'EACCES', 'EPERM'].includes(error?.code)) return 'launch';
      // execFileSync's message includes the entire command, so inspecting it
      // would misclassify any failure from words in the fixed source itself.
      const privateText = String(error?.stderr ?? '');
      if (/ParserError|UnexpectedToken|TerminatorExpectedAtEndOfString|MissingEndCurlyBrace/.test(privateText)) return 'parser';
      if (/Exception calling "Read".*Boot identity unavailable/.test(privateText)) return 'native-query';
      if (/Add-Type|CompilerError|SOURCE_CODE_ERROR|CS[0-9]{4}/.test(privateText)) return 'compile';
      return 'unknown';
    }
    const realExec = cp.execFileSync;
    let calls = [], providerCategory = null, counter = 0;
    let fixedInvocation = false;
    const synthetic = mode === 'boundary';
    if (synthetic) Object.defineProperty(process, 'platform', {value:'win32'});
    cp.execFileSync = (file, args, opts) => {
      counter++;
      const encoded = args?.length === 5 && args[3] === '-EncodedCommand'
        && /^[A-Za-z0-9+/]+={0,2}$/.test(args[4]);
      const decoded = encoded ? Buffer.from(args[4], 'base64').toString('utf16le') : null;
      fixedInvocation = file === executable
        && JSON.stringify(args.slice(0,3)) === JSON.stringify(['-NoLogo','-NoProfile','-NonInteractive'])
        && encoded && decoded === savedScript
        && Buffer.from(decoded, 'utf16le').toString('base64') === args[4]
        && opts.encoding === 'utf8' && opts.timeout === 5000 && opts.maxBuffer === 16384
        && opts.windowsHide === true && !opts.shell && !opts.windowsVerbatimArguments
        && Object.keys(opts.env).sort().join() === Object.keys(fixedEnv).sort().join()
        && Object.entries(fixedEnv).every(([key,value]) => opts.env[key] === value);
      calls.push(fixedInvocation);
      if (synthetic) {
        if (counter === 1 && fault !== 'none') {
          if (fault === 'zero') return '00000000-0000-0000-0000-000000000000';
          if (fault === 'malformed') return '11111111-2222-4333-8444-555555555555\\nextra-output';
          throw Object.assign(new Error('PRIVATE_PROVIDER_SENTINEL 11111111-2222-4333-8444-555555555555'), {
            code:fault === 'timeout' ? 'ETIMEDOUT' : 'EACCES',
            stdout:'PRIVATE_PROVIDER_STDOUT', stderr:'PRIVATE_PROVIDER_STDERR', status:1,
          });
        }
        return '11111111-2222-4333-8444-555555555555\\r\\n';
      }
      try { return realExec(file, args, {...opts, stdio:['ignore','pipe','pipe']}); }
      catch (error) { providerCategory = classify(error); throw error; }
    };
    syncBuiltinESMExports();
    const emit = value => process.stdout.write(JSON.stringify(value));
    try {
      if (mode === 'saved' || mode === 'encoded-reference') {
        const args = ['-NoLogo','-NoProfile','-NonInteractive',
          mode === 'saved' ? '-Command' : '-EncodedCommand',
          mode === 'saved' ? savedScript : Buffer.from(savedScript, 'utf16le').toString('base64')];
        let value, failure;
        try { value = realExec(executable, args, {...options, stdio:['ignore','pipe','pipe']}).trim(); }
        catch (error) { failure = classify(error); }
        if (failure) emit({ok:false, category:failure});
        else emit(valid(value) ? {ok:true, category:'success', identity:digest(value)} : {ok:false, category:'invalid-output'});
      } else {
        const {localExecutionIdentity} = await import(${JSON.stringify(identityUrl)});
        const {acquireRunLock, releaseRunLock} = await import(${JSON.stringify(lockUrl)});
        let firstError, firstIdentity;
        try { firstIdentity = localExecutionIdentity(); } catch (error) { firstError = error; }
        if (synthetic && fault !== 'none') {
          let ownershipFailed = false;
          // Reinstate the failure at the last provider boundary before the sink.
          counter = 0;
          try { await acquireRunLock(lock, 'refused'); } catch { ownershipFailed = true; }
          const retained = !fs.existsSync(lock);
          counter = 1;
          const recovered = localExecutionIdentity();
          const cached = localExecutionIdentity();
          emit({ok:true, refused:!!firstError && ownershipFailed, retained,
            privateError:!!firstError && !/PRIVATE_PROVIDER|11111111|STDOUT|STDERR/.test(String(firstError.message) + String(firstError.cause ?? '')),
            retryValid:recovered === digest('11111111-2222-4333-8444-555555555555'),
            cached:cached === recovered && counter === 2, calls});
        } else if (firstError) {
          emit({ok:false, category:providerCategory ?? 'unknown'});
        } else {
          const owner = await acquireRunLock(lock, 'probe', {host:'caller-forged',execution_identity:'caller-forged'});
          await releaseRunLock(lock, 'probe');
          emit({ok:true, category:'success', identity:firstIdentity,
            ownership:owner.host === firstIdentity && /^ape-execution-v1:[a-f0-9]{64}$/.test(owner.host),
            released:!fs.existsSync(lock), cached:counter === 1, calls});
        }
      }
    } catch { emit({ok:false, category:'unknown'}); }
  `;
  const env = {...process.env};
  delete env.NODE_OPTIONS;
  Object.assign(env, {
    SystemRoot:'Z:\\untrusted', WINDIR:'Z:\\untrusted', PATH:'Z:\\untrusted',
    PSModulePath:'Z:\\untrusted', TEMP:'Z:\\untrusted', TMP:'Z:\\untrusted',
    COMPLUS_Version:'untrusted', DOTNET_STARTUP_HOOKS:'untrusted',
    APE_EXECUTION_IDENTITY:'caller-forged', HOSTNAME:'caller-forged', COMPUTERNAME:'caller-forged',
  });
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      env, stdio:['ignore','pipe','pipe'],
    });
    let stdout = '', stderr = '', timedOut = false, launchFailed = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 15_000);
    child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 16384) child.kill('SIGKILL'); });
    child.stderr.on('data', chunk => { stderr += chunk; if (stderr.length > 16384) child.kill('SIGKILL'); });
    child.once('error', () => { launchFailed = true; });
    child.once('close', code => {
      clearTimeout(timer);
      if (timedOut || launchFailed || code !== 0 || stderr) return reject(new Error('identity probe failed without publishing private output'));
      try { resolve(JSON.parse(stdout)); } catch { reject(new Error('identity probe returned invalid private output')); }
    });
  });
}

describe('Windows fixed provider command boundary (synthetic, not a native diagnosis)', () => {
  it('transports the exact fixed script losslessly as UTF-16LE with trusted environment and unchanged finite bounds', async () => {
    const result = await windowsIdentityProbe('boundary');
    expect(result).toMatchObject({ok:true, ownership:true, released:true, cached:true, calls:[true]});
  }, 20_000);

  it.each(['launch', 'timeout', 'zero', 'malformed'])('retains ownership, suppresses private output, and retries after %s evidence', async fault => {
    const result = await windowsIdentityProbe('boundary', fault);
    expect(result).toMatchObject({ok:true, refused:true, retained:true, privateError:true, retryValid:true, cached:true});
    expect(result.calls.length).toBe(3);
    expect(result.calls.every(Boolean)).toBe(true);
  }, 20_000);
});

describe.skipIf(process.platform !== 'win32')('native Windows saved/candidate differential evidence', () => {
  it('requires saved failure, transport-only success, and stable public ownership in fresh candidate processes', async () => {
    // Sequential probes preserve the same provider, script, environment and
    // 5000ms bound. A passing local mock is never accepted as this evidence.
    const saved = await windowsIdentityProbe('saved');
    const transport = await windowsIdentityProbe('encoded-reference');
    const first = await windowsIdentityProbe('candidate');
    const second = await windowsIdentityProbe('candidate');
    const categories = new Set(['success','launch','parser','compile','native-query','invalid-output','timeout','unknown']);
    for (const result of [saved, transport, first, second]) expect(categories.has(result.category)).toBe(true);
    console.info('Windows identity differential', {
      saved:saved.category, transport:transport.category, candidate:first.category, repeated:second.category,
    });
    // Unknown, original-success, or both-failed results explicitly block causal
    // acceptance and require remediation; never silently turn them into green.
    expect(saved.ok, 'saved provider must reproduce the failure on this native runner').toBe(false);
    expect(saved.category).not.toBe('unknown');
    expect(transport.ok, 'transport-only control must succeed').toBe(true);
    for (const result of [first, second]) {
      expect(result).toMatchObject({ok:true, ownership:true, released:true, cached:true, calls:[true]});
      expect(result.identity === transport.identity, 'fresh ownership must agree with the validated native control').toBe(true);
    }
  }, 65_000);
});
