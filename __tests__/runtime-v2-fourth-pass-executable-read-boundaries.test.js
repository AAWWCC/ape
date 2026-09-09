import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  resolveEvidenceExecutable,
  snapshotEvidenceExecutables,
  verifyEvidenceExecutableSnapshot,
} from '../lib/runtime/evidence-policy.js';

const fixtures = [];
const policyUrl = new URL('../lib/runtime/evidence-policy.js', import.meta.url).href;
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'ape-fourth-executable-'));
  fixtures.push(directory);
  return directory;
}

async function executable(directory) {
  const file = path.join(directory, 'npm');
  await writeFile(file, '#!/bin/sh\nprintf trusted\n');
  await chmod(file, 0o755);
  return file;
}

describe('fourth-pass executable resolution and bounded fingerprint reads', () => {
  it.each(['directory', 'directory symlink'])('skips a PATH %s like the executing shell', async (kind) => {
    const directory = await fixture();
    const earlier = path.join(directory, 'earlier');
    const trusted = path.join(directory, 'trusted');
    await mkdir(earlier);
    await mkdir(trusted);
    await executable(trusted);
    if (kind === 'directory') await mkdir(path.join(earlier, 'npm'));
    else await symlink(trusted, path.join(earlier, 'npm'), 'dir');
    const options = { cwd: directory, env: { PATH: `${earlier}${path.delimiter}${trusted}` } };
    if (process.platform !== 'win32') {
      expect(spawnSync('/bin/sh', ['-c', 'npm'], { ...options, encoding: 'utf8' }).stdout).toBe('trusted');
    }
    expect(resolveEvidenceExecutable('npm', options)).toBe(await realpath(path.join(trusted, 'npm')));
    const snapshot = snapshotEvidenceExecutables(options);
    expect(snapshot.heads.npm.realpath).toBe(await realpath(path.join(trusted, 'npm')));
    expect(verifyEvidenceExecutableSnapshot(snapshot, 'npm', options).safe).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('does not block when an executable becomes a FIFO after its size check', async () => {
    const directory = await fixture();
    await executable(directory);
    // Replace exactly after the policy's real stat. A separate process makes
    // the pre-fix blocking read observable without hanging the test worker.
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import fs from 'node:fs';
      import { execFileSync } from 'node:child_process';
      import { syncBuiltinESMExports } from 'node:module';
      const directory = process.argv[1];
      const target = fs.realpathSync(directory + '/npm');
      const original = fs.statSync;
      let replaced = false;
      fs.statSync = function(file, options) {
        const result = original(file, options);
        if (!replaced && String(file) === target && options?.bigint === true) {
          replaced = true;
          fs.unlinkSync(target);
          execFileSync('mkfifo', [target]);
        }
        return result;
      };
      syncBuiltinESMExports();
      const { snapshotEvidenceExecutables } = await import(process.argv[2]);
      const snapshot = snapshotEvidenceExecutables({ cwd: directory, env: { PATH: directory } });
      process.stdout.write(JSON.stringify({ replaced, fingerprint: snapshot.heads.npm.fingerprint }));
    `, directory, policyUrl], { encoding: 'utf8', timeout: 3000 });
    expect(child.error?.code, child.stderr).not.toBe('ETIMEDOUT');
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual({ replaced: true, fingerprint: null });
  });

  it('refuses growth beyond the fingerprint read limit after its initial stat', async () => {
    const directory = await fixture();
    await executable(directory);
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const directory = process.argv[1];
      const target = fs.realpathSync(directory + '/npm');
      const original = fs.statSync;
      let grown = false;
      fs.statSync = function(file, options) {
        const result = original(file, options);
        if (!grown && String(file) === target && options?.bigint === true) {
          grown = true;
          fs.truncateSync(target, 9 * 1024 * 1024);
        }
        return result;
      };
      syncBuiltinESMExports();
      const { snapshotEvidenceExecutables } = await import(process.argv[2]);
      const snapshot = snapshotEvidenceExecutables({ cwd: directory, env: { PATH: directory } });
      process.stdout.write(JSON.stringify({ grown, fingerprint: snapshot.heads.npm.fingerprint }));
    `, directory, policyUrl], { encoding: 'utf8', timeout: 3000 });
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual({ grown: true, fingerprint: null });
  });
});
