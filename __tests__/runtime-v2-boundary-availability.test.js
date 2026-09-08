import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readBoundedRegularFileUtf8, spawnWithTimeout } from '../lib/runtime/spawn.js';
import { startGateSuite } from '../lib/runtime/gate-watch.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { extractReceiptDraftFromText } from '../lib/runtime/receipt-input.js';
import { proposeTestCommands } from '../lib/runtime/config.js';
import { doctor } from '../lib/runtime/doctor.js';

const fixtures = [];
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'ape-boundary-availability-'));
  fixtures.push(directory);
  return directory;
}
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((directory) => rm(directory, {
    recursive: true, force: true, maxRetries: 10, retryDelay: 50,
  })));
});

describe('detached launch failures', () => {
  it.each(['missing-command', 'missing-cwd'])('keeps the caller alive after %s', async (failure) => {
    const directory = await fixture();
    const missing = path.join(directory, 'missing');
    const script = `
      import { spawnDetached } from ${JSON.stringify(new URL('../lib/runtime/spawn.js', import.meta.url).href)};
      const child = spawnDetached(${failure === 'missing-command' ? JSON.stringify(missing) : 'process.execPath'}, [], {
        cwd: ${JSON.stringify(failure === 'missing-cwd' ? missing : directory)}
      });
      console.log('pid=' + child.pid);
      setTimeout(() => console.log('caller-survived'), 50);
    `;
    const result = await spawnWithTimeout(process.execPath, ['--input-type=module', '-e', script], {
      cwd: directory, timeout_ms: 5_000, kill_grace_ms: 100,
    });
    expect(result.exit_code).toBe(0);
    expect(result.combined).toContain('pid=undefined');
    expect(result.combined).toContain('caller-survived');
  });

  it('returns a tooling failure instead of publishing a watch for an unsuccessful spawn', async () => {
    const directory = await fixture();
    // Synthetic preflight isolates a cwd removed between preflight and launch.
    const result = await startGateSuite(path.join(directory, 'removed-cwd'), runtimePaths(directory), {
      run_id: 'run-launch-failure', lane: 'fast',
    }, {}, {
      preflight: { passed: true }, treeSha: 'a'.repeat(40), cacheKey: 'spawn-failure',
      suiteMode: 'impacted', suiteCommand: 'node -e ""',
      suiteInvocation: { command: process.execPath, args: ['-e', ''] },
    });
    expect(result.watch).toBeUndefined();
    expect(result.hit.full).toMatchObject({ passed: false, verification: { tooling_failure: true } });
    expect(result.hit.full.verification.output).toMatch(/process could not start.*ENOENT/);
  });
});

describe('bounded receipt text extraction', () => {
  const receipt = { ticket_id: 'run-a:test:t1', status: 'passed', tests: [], findings: [],
    evidence: { nested: { summary: 'braces { } and "quotes" and \\escapes' } } };

  it.each([
    (draft) => `Here is the receipt: ${JSON.stringify(draft)}. Done.`,
    (draft) => JSON.stringify({ response: { draft } }),
    (draft) => `An unmatched { prefix followed by ${JSON.stringify(draft)}`,
    (draft) => `Bad JSON example: {"\n${JSON.stringify(draft)}`,
    (draft) => `\`\`\`json\n${JSON.stringify(draft, null, 2)}\n\`\`\``,
  ])('preserves nested, escaped and prose-wrapped valid receipts', (wrap) => {
    expect(extractReceiptDraftFromText(wrap(receipt))).toEqual(receipt);
  });

  it('accepts pretty-printing larger than the compact receipt input allowance', () => {
    const draft = { ...receipt, evidence: { samples: Array.from({ length: 1000 }, () => 'x'.repeat(110)) } };
    const pretty = JSON.stringify(draft, null, ' '.repeat(10));
    expect(Buffer.byteLength(JSON.stringify(draft))).toBeLessThan(128 * 1024);
    expect(Buffer.byteLength(pretty)).toBeGreaterThan(128 * 1024);
    expect(extractReceiptDraftFromText(pretty)).toEqual(draft);
  });

  it('terminates on large malformed brace sequences within an external process deadline', () => {
    // External timeout prevents a parser regression from pinning the test worker.
    const script = `
      import { extractReceiptDraftFromText } from ${JSON.stringify(new URL('../lib/runtime/receipt-input.js', import.meta.url).href)};
      for (const text of ['{'.repeat(300000), '{'.repeat(300000) + '}'.repeat(300000)]) {
        if (extractReceiptDraftFromText(text) !== null) process.exit(2);
      }
      console.log('bounded');
    `;
    expect(execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      timeout: 5_000, killSignal: 'SIGKILL', encoding: 'utf8',
    }).trim()).toBe('bounded');
  });
});

describe('bounded repository manifest inspection', () => {
  it('reads regular manifests and preserves grounded runner and Playwright discovery', async () => {
    const directory = await fixture();
    const text = JSON.stringify({ scripts: { test: 'vitest run' }, devDependencies: {
      vitest: '1.0.0', '@playwright/test': '1.0.0',
    } });
    await writeFile(path.join(directory, 'package.json'), text);
    expect(await readBoundedRegularFileUtf8(path.join(directory, 'package.json'), { maxBytes: text.length })).toBe(text);
    expect((await proposeTestCommands(directory)).proposal.proposal_complete).toBe(true);
    expect((await doctor(directory)).checks.some((check) => check.name === 'playwright-project')).toBe(true);
  });

  it('rejects oversized manifests before decoding them', async () => {
    const directory = await fixture();
    const file = path.join(directory, 'package.json');
    await writeFile(file, ' '.repeat(256 * 1024 + 1));
    await expect(readBoundedRegularFileUtf8(file)).rejects.toMatchObject({ code: 'APE_UNSAFE_FILE' });
    expect((await proposeTestCommands(directory)).proposal.proposal_complete).toBe(false);
  });

  it.skipIf(process.platform === 'win32').each(['fifo', 'symlink-to-fifo'])('finishes doctor and runner discovery with a %s manifest', async (kind) => {
    const directory = await fixture();
    const file = path.join(directory, 'package.json');
    const fifo = kind === 'fifo' ? file : path.join(directory, 'pipe');
    execFileSync('mkfifo', [fifo]);
    if (kind === 'symlink-to-fifo') await symlink(fifo, file);
    const script = `
      import { doctor } from ${JSON.stringify(new URL('../lib/runtime/doctor.js', import.meta.url).href)};
      import { proposeTestCommands } from ${JSON.stringify(new URL('../lib/runtime/config.js', import.meta.url).href)};
      import { detectTestRunner } from ${JSON.stringify(new URL('../lib/runtime/runner.js', import.meta.url).href)};
      const root = ${JSON.stringify(directory)};
      await doctor(root);
      const proposed = await proposeTestCommands(root);
      const detected = await detectTestRunner(root);
      console.log(JSON.stringify({ complete: proposed.proposal.proposal_complete, runner: detected.runner }));
    `;
    const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      timeout: 5_000, killSignal: 'SIGKILL', encoding: 'utf8',
    }));
    expect(result).toEqual({ complete: false, runner: 'none' });
  });
});
