import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const run = promisify(execFile);
const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CHECKER = path.join(REPO_ROOT, 'scripts', 'check-public-surface.mjs');
const scratchRoots = [];

afterEach(async () => {
  await Promise.all(scratchRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function surface(files, env = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'ape-public-surface-'));
  scratchRoots.push(root);
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(root, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  try {
    const result = await run(process.execPath, [CHECKER, '--root', root], {
      env: { ...process.env, ...env },
    });
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      exitCode: error.code,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? '',
    };
  }
}

function fingerprint(rawDigest) {
  return createHash('sha256')
    .update('APE-public-forbidden-v1\0')
    .update(Buffer.from(rawDigest, 'hex'))
    .digest('hex');
}

async function isolatedSurface(files, fingerprints = []) {
  const repository = await mkdtemp(path.join(tmpdir(), 'ape-public-checker-'));
  scratchRoots.push(repository);
  const checker = path.join(repository, 'scripts', 'check-public-surface.mjs');
  const root = path.join(repository, 'surface');
  await mkdir(path.dirname(checker), { recursive: true });
  await writeFile(checker, await readFile(CHECKER));
  await writeFile(path.join(repository, 'public-asset-fingerprints.json'), `${JSON.stringify({
    version: 1,
    domain: 'APE-public-forbidden-v1',
    fingerprints,
  }, null, 2)}\n`);
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(root, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  try {
    const result = await run(process.execPath, [checker, '--root', root], {
      env: {
        ...process.env,
        APE_PUBLIC_FORBIDDEN_HASHES: '',
        APE_PUBLIC_REQUIRE_FORBIDDEN_HASHES: '1',
      },
    });
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return { exitCode: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

describe('public-surface privacy and licensing gate', () => {
  it('allows synthetic fixture identities and references', async () => {
    const result = await surface({
      'fixture.txt': [
        'developer@example.com',
        'automation@users.noreply.github.com',
        'git@github.com:acme/project.git',
        'Synthetic acme acme issue #42 is test data.',
        'run-fixture-stage-one',
      ].join('\n'),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('public surface passed');
  });

  it('rejects personal email and qualified private repository references', async () => {
    const result = await surface({
      'leak.txt': `${['person', 'personal-domain.dev'].join('@')}\n${[
        'https://github.com/AAWWCC/ape',
        'pull',
        '314',
      ].join('/')}\n`,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('personal/non-fixture email address');
    expect(result.stderr).toContain('qualified private AAWWCC/ape reference');
  });

  it('rejects date-shaped private run IDs while allowing the fixture namespace', async () => {
    const result = await surface({
      'runs.txt': `run-fixture-safe\n${['run', '20260811123456789', 'deadbeef'].join('-')}\n`,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('private date-shaped run id');
  });

  it('rejects audio signatures even without an audio extension', async () => {
    const bytes = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEdata')]);
    const result = await surface({ 'renamed.bin': bytes });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('audio file signature');
  });

  it('enforces the five-mebibyte public file cap', async () => {
    const result = await surface({ 'too-large.bin': Buffer.alloc(5 * 1024 * 1024 + 1) });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('exceeds 5 MiB');
  });

  it('rejects a protected private blob hash injected by CI without committing it', async () => {
    const forbidden = 'b'.repeat(64);
    const result = await surface(
      { 'leaked-hash.txt': forbidden },
      { APE_PUBLIC_FORBIDDEN_HASHES: forbidden },
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('forbidden private blob hash');
  });

  it('hashes raw file bytes so renamed private blobs cannot bypass the injected set', async () => {
    const privateBlob = Buffer.from([0, 255, 19, 87, 0, 44, 91, 173]);
    const forbidden = createHash('sha256').update(privateBlob).digest('hex');
    const result = await surface(
      { 'renamed-private-blob.bin': privateBlob },
      { APE_PUBLIC_FORBIDDEN_HASHES: forbidden },
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('forbidden private blob hash');
  });

  it('uses committed domain-separated fingerprints in no-secret public CI', async () => {
    const privateBlob = Buffer.from('synthetic private fixture bytes');
    const digest = createHash('sha256').update(privateBlob).digest('hex');
    const result = await isolatedSurface(
      { 'renamed-private-blob.bin': privateBlob },
      [fingerprint(digest)],
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('forbidden private blob hash');
  });

  it('fails closed when a release gate has neither fingerprints nor injected raw hashes', async () => {
    const result = await isolatedSurface({ 'safe.txt': 'synthetic public fixture' });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('no forbidden private blob protections are configured');
  });
});
