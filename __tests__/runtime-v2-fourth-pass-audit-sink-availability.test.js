import { spawnSync } from 'node:child_process';
import { link, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { appendJsonLine } from '../lib/runtime/storage.js';

const fixtures = [];
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'ape-fourth-audit-sink-'));
  fixtures.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('fourth-pass runtime audit sink availability', () => {
  it.skipIf(process.platform === 'win32').each(['fifo', 'symlink-to-fifo'])(
    'rejects a stable %s audit sink without waiting for a reader', async (shape) => {
      const root = await fixture();
      const file = path.join(root, 'audit.jsonl');
      const fifo = shape === 'fifo' ? file : path.join(root, 'pipe');
      expect(spawnSync('mkfifo', [fifo]).status).toBe(0);
      if (shape === 'symlink-to-fifo') await symlink(fifo, file);
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
        import { appendJsonLine } from ${JSON.stringify(new URL('../lib/runtime/storage.js', import.meta.url).href)};
        try { await appendJsonLine(${JSON.stringify(file)}, { operation: 'fixture' }); }
        catch { console.log('refused'); }
      `], { timeout: 3000, killSignal: 'SIGKILL', encoding: 'utf8' });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe('refused');
    },
  );

  it('keeps complete prior audit lines and appends one complete JSON line', async () => {
    const file = path.join(await fixture(), 'audit.jsonl');
    await writeFile(file, '{"operation":"prior"}\n');
    await appendJsonLine(file, { operation: 'fixture' });
    expect(await readFile(file, 'utf8')).toBe('{"operation":"prior"}\n{"operation":"fixture"}\n');
  });

  it.skipIf(process.platform === 'win32').each(['symlink', 'hardlink'])(
    'preserves outside sentinel bytes when the runtime audit leaf is a %s', async (shape) => {
      const root = await fixture();
      const outside = path.join(await fixture(), 'outside.txt');
      const original = 'unrelated caller-owned bytes\n';
      await writeFile(outside, original);
      const file = path.join(root, 'audit.jsonl');
      if (shape === 'symlink') await symlink(outside, file);
      else await link(outside, file);
      await expect(appendJsonLine(file, { operation: 'fixture' })).rejects.toThrow();
      expect(await readFile(outside, 'utf8')).toBe(original);
      expect(await readFile(file, 'utf8')).toBe(original);
    },
  );
});
