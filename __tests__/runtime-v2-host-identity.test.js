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
