import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULT_CONFIG } from '../lib/runtime/config.js';
import { configAction } from '../lib/runtime/service.js';
import { evaluateGatePreflight } from '../lib/runtime/gate-evaluation.js';

const dirs = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function project() {
  const dir = mkdtempSync(path.join(tmpdir(), 'ape-verification-profiles-'));
  dirs.push(dir);
  return dir;
}

const valid = (overrides = {}) => ({
  id: 'unit', description: 'Run the deterministic unit suite', command: 'npm test', root: '.', timeout_ms: 30_000,
  ...overrides,
});

async function setProfiles(dir, profiles) {
  return configAction(dir, 'set', { key: 'verification.profiles', value: profiles });
}

describe('verification.profiles configuration', () => {
  it('ships a bounded empty profile list and round-trips valid exact commands', async () => {
    expect(DEFAULT_CONFIG.verification).toEqual({ profiles: [] });
    const dir = project();
    const profiles = [valid(), valid({ id: 'types', command: 'npm run typecheck', root: 'packages/api' })];
    await setProfiles(dir, profiles);
    expect((await configAction(dir, 'get', {})).config.verification.profiles).toEqual(profiles);
  });

  it.each([
    ['duplicate ids', [valid(), valid()]],
    ['unknown fields', [valid({ shell: true })]],
    ['shell syntax', [valid({ command: 'npm test && touch owned' })]],
    ['absolute root', [valid({ root: '/tmp' })]],
    ['traversal root', [valid({ root: '../outside' })]],
    ['zero timeout', [valid({ timeout_ms: 0 })]],
    ['oversized timeout', [valid({ timeout_ms: 86_400_001 })]],
    ['blank description', [valid({ description: ' ' })]],
  ])('rejects %s atomically', async (_label, profiles) => {
    const dir = project();
    await expect(setProfiles(dir, profiles)).rejects.toThrow(/verification|profile|command|root|timeout/i);
    expect((await configAction(dir, 'get', {})).config.verification.profiles).toEqual([]);
  });

  it('treats root as optional and preserves a shell-free argv snapshot', async () => {
    const dir = project();
    const profile = valid();
    delete profile.root;
    await setProfiles(dir, [profile]);
    expect((await configAction(dir, 'get', {})).config.verification.profiles).toEqual([profile]);
  });

  it('fails closed when a snapshotted profile root resolves through a symlink outside the project', async () => {
    const dir = project();
    const outside = project();
    writeFileSync(path.join(dir, 'package.json'), '{"name":"profile-root-test","private":true}\n');
    symlinkSync(outside, path.join(dir, 'linked'), 'dir');
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'ape@example.test'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'APE Test'], { cwd: dir });
    execFileSync('git', ['add', '.'], { cwd: dir });
    execFileSync('git', ['commit', '-qm', 'test: baseline'], { cwd: dir });
    const treeSha = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: dir, encoding: 'utf8' }).trim();
    const profile = valid({ command: 'node --version', root: 'linked' });
    const state = {
      run_id: 'run-profile-root', lane: 'mechanical', high_risk: false,
      policy: { high_risk_security_review: true }, claimed_paths: [], test_paths: [], receipts: [],
      verification_profiles: [profile],
      preflight: {
        artifact: {
          verification_profiles: [{ id: 'unit', disposition: 'required', reason: 'Required gate.' }],
        },
      },
      approved_plan: { plan: { workstreams: [{ verification_profiles: ['unit'] }] } },
    };

    const result = await evaluateGatePreflight(dir, state, DEFAULT_CONFIG, {
      strategy: 'single', treeSha, blocked: false, orphans: [],
    });
    expect(result.verificationProfiles).toMatchObject({
      passed: false,
      results: [expect.objectContaining({ id: 'unit', passed: false, reason: expect.stringMatching(/root|symlink|contain/i) })],
    });
  });
});

