import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { evaluateGatePreflight, resolveSuiteSelection } from '../lib/runtime/gate-evaluation.js';
import { startGateSuite } from '../lib/runtime/gate-watch.js';
import { currentTreeSha, runGit } from '../lib/runtime/git.js';
import { validateClaudePlugin, validateCodexPlugin } from '../lib/runtime/plugin-validation.js';
import { runTestSuite } from '../lib/runtime/runner.js';

const fixtures = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'ape-execution-preflight-')));
  fixtures.push(root);
  return root;
}
async function plugin(host, declaration) {
  const root = await fixture();
  await mkdir(path.join(root, `.${host}-plugin`));
  await writeFile(path.join(root, `.${host}-plugin`, 'plugin.json'), JSON.stringify({
    name: 'fixture', version: '1.0.0',
    ...(declaration === undefined ? {} : { mcpServers: declaration }),
  }));
  return root;
}
const validate = { claude: validateClaudePlugin, codex: validateCodexPlugin };

describe.each(['claude', 'codex'])('%s MCP structural preflight', (host) => {
  it.each(['{broken', 'null', '[]', '{"mcpServers":[]}', '{"mcpServers":{"bad":{"args":"wrong"}}}'])(
    'rejects malformed companion bytes: %s', async (content) => {
      const root = await plugin(host, './.mcp.json');
      await writeFile(path.join(root, '.mcp.json'), content);
      expect((await validate[host](root)).passed).toBe(false);
    },
  );
  it('checks an automatically discovered companion and keeps parse contents out of errors', async () => {
    const root = await plugin(host);
    const privateFixtureMarker = 'synthetic-companion-marker';
    await writeFile(path.join(root, '.mcp.json'), `{${privateFixtureMarker}`);
    const result = await validate[host](root);
    expect(result.passed).toBe(false);
    expect(result.errors.join(' ')).not.toContain(privateFixtureMarker);
  });
  it('accepts a plugin without MCP components', async () => {
    expect((await validate[host](await plugin(host))).passed).toBe(true);
  });
  it.each(['direct', 'mcpServers', 'mcp_servers'])('accepts valid %s server maps', async (wrapper) => {
    const root = await plugin(host, './.mcp.json');
    const servers = { local: { command: 'node', args: ['server.cjs'], env: { FIXTURE: '1' } } };
    await writeFile(path.join(root, '.mcp.json'), JSON.stringify(wrapper === 'direct' ? servers : { [wrapper]: servers }));
    expect((await validate[host](root)).passed).toBe(true);
  });
  it('accepts inline HTTP servers and rejects a malformed argv field', async () => {
    expect((await validate[host](await plugin(host, { remote: { type: 'http', url: 'https://example.com/mcp' } }))).passed)
      .toBe(true);
    expect((await validate[host](await plugin(host, { local: { command: 'node', args: [null] } }))).passed)
      .toBe(false);
  });
  it('bounds a declared companion read', async () => {
    const root = await plugin(host, './.mcp.json');
    await writeFile(path.join(root, '.mcp.json'), ' '.repeat(1024 * 1024 + 1));
    expect((await validate[host](root)).passed).toBe(false);
  });
  it.skipIf(process.platform === 'win32')('rejects a FIFO companion without opening a blocking read', async () => {
    const root = await plugin(host, './.mcp.json');
    expect(spawnSync('mkfifo', [path.join(root, '.mcp.json')]).status).toBe(0);
    expect((await validate[host](root)).passed).toBe(false);
  });
  it('resolves malformed declaration types as a failed preflight', async () => {
    expect((await validate[host](await plugin(host, [null]))).passed).toBe(false);
  });
});

async function gitFixture() {
  const root = await fixture();
  await mkdir(path.join(root, '.ape'));
  await writeFile(path.join(root, 'slow.cjs'), "require('node:fs').appendFileSync('.ape/executions', 'run\\n'); setTimeout(() => {}, 200);");
  await runGit(root, ['init', '-q']);
  await runGit(root, ['add', 'slow.cjs']);
  await runGit(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']);
  return root;
}
async function profilePreflight(root, deadlines, { staleSecondRoot = false } = {}) {
  const metadata = await stat(root);
  const profiles = deadlines.map((timeout_ms, index) => ({
    id: `profile${index}`, command: `"${process.execPath}" slow.cjs`, timeout_ms,
  }));
  const state = {
    lane: 'mechanical', receipts: [], verification_profiles: profiles,
    verification_profile_roots: profiles.map((profile, index) => ({
      id: profile.id, realpath: root, dev: String(metadata.dev),
      ino: staleSecondRoot && index === 1 ? 'invalid-fixture-inode' : String(metadata.ino),
    })),
    preflight: { artifact: { verification_profiles: profiles.map((profile) => ({ id: profile.id, disposition: 'required' })) } },
    approved_plan: { plan: { workstreams: [{ verification_profiles: profiles.map((profile) => profile.id) }] } },
  };
  return evaluateGatePreflight(root, state, {}, { treeSha: await currentTreeSha(root), strategy: 'single' });
}

describe('verification execution contract identity', () => {
  it('cannot reuse a slow passing check for a required tighter deadline', async () => {
    const result = await profilePreflight(await gitFixture(), [3000, 10]);
    expect(result.verificationProfiles.passed).toBe(false);
    expect(result.verificationProfiles.results[0].passed).toBe(true);
    expect(result.verificationProfiles.results[1]).toMatchObject({ passed: false, timed_out: true });
  });
  it('still deduplicates identical command, root, and deadline contracts', async () => {
    const root = await gitFixture();
    const result = await profilePreflight(root, [3000, 3000]);
    expect(result.verificationProfiles.passed).toBe(true);
    expect(await readFile(path.join(root, '.ape', 'executions'), 'utf8')).toBe('run\n');
  });
  it('validates each profile root snapshot before sharing an execution result', async () => {
    const result = await profilePreflight(await gitFixture(), [3000, 3000], { staleSecondRoot: true });
    expect(result.verificationProfiles.results[0].passed).toBe(true);
    expect(result.verificationProfiles.results[1].passed).toBe(false);
  });
});

describe('single-suite impacted deletion fallback', () => {
  it('returns a tooling failure for an empty detached command on Windows before spawning', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    try {
      Object.defineProperty(process, 'platform', { ...descriptor, value: 'win32' });
      const result = await startGateSuite('/synthetic/no-side-effects', {}, { lane: 'fast' }, {}, {
        preflight: { passed: true }, strategy: 'single', suiteMode: 'full', suiteCommand: '   ', treeSha: 'a'.repeat(40),
      });
      expect(result.hit.full.verification).toMatchObject({ passed: false, tooling_failure: true });
      expect(result.hit.full.verification.output).toMatch(/must contain an executable/);
    } finally {
      Object.defineProperty(process, 'platform', descriptor);
    }
  });

  it('executes the full failing suite when a changed path was deleted alongside a present path', async () => {
    const root = await fixture();
    await writeFile(path.join(root, 'present.js'), 'fixture');
    await writeFile(path.join(root, 'full.cjs'), "process.exit(require('node:fs').existsSync('deleted.js') ? 0 : 1);");
    await writeFile(path.join(root, 'related.cjs'), 'process.exit(0);');
    const config = {
      test_commands: { full: `"${process.execPath}" full.cjs`, impacted_template: `"${process.execPath}" related.cjs {paths}` },
      shipping: { required_remote_checks: true },
    };
    const selection = await resolveSuiteSelection(root, { receipts: [{ changed_files: ['deleted.js', 'present.js'] }] }, config);
    expect(selection.mode).toBe('full');
    const result = await runTestSuite(root, { command: selection.command, timeout_ms: 3000 });
    expect(result).toMatchObject({ passed: false, exit_code: 1 });
    const presentOnly = await resolveSuiteSelection(root, { receipts: [{ changed_files: ['present.js'] }] }, config);
    expect(presentOnly).toMatchObject({ mode: 'impacted', impacted_paths: ['present.js'] });
  });
});
