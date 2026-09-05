import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { previewRun, startRun } from '../lib/runtime/lifecycle-service.js';
import { ticketCapabilityManifest } from '../lib/runtime/capability-manifest.js';
import { evaluateLifecyclePolicy } from '../lib/runtime/lifecycle-policy.js';
import * as shipping from '../lib/runtime/shipping-target.js';
import * as gitRuntime from '../lib/runtime/git.js';
import { validatePreflightArtifact } from '../lib/runtime/plan-contract.js';
import { driftGuardApplies, matchingCommandProfile } from '../lib/runtime/write-policy.js';
import { invokesDeclaredWriteProfile } from '../lib/runtime/capability-selection.js';

const roots = [];
const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8',
  env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } }).trim();
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture(config = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'ape-optional-admission-'));
  roots.push(root);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Synthetic optional admission');
  git(root, 'config', 'user.email', 'optional@example.test');
  git(root, 'config', 'commit.gpgsign', 'false');
  await writeFile(path.join(root, 'README.md'), 'baseline\n');
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'baseline');
  await mkdir(path.join(root, '.ape/runtime'), { recursive: true });
  await writeFile(path.join(root, '.ape/runtime/config.json'), JSON.stringify(config));
  return root;
}
const request = (extra = {}) => ({ objective: 'Clarify the readme', mode: 'phase', lane: 'mechanical',
  host: 'claude', behavioral: false, claimed_paths: ['README.md'], test_paths: [], hooks_trusted: true,
  subagents_available: true, explicit_invocation: true, admission_contract_version: 1,
  binding_protocol: 'native-v1', ...extra });

describe('optional catalog entries do not become unrelated run requirements', () => {
  it.each(['debug', 'spike'])('admits %s without unused configured test tools or behavioral test prerequisites', async (mode) => {
    const root = await fixture({ test_commands: { full: 'ape-unused-test-tool', targeted: 'ape-unused-test-tool' },
      runners: [{ id: 'unused', root: 'unrelated-package', owns: ['unrelated-package/**'], profile: { full: 'ape-unused-runner' } }] });
    const input = request({ mode, lane: 'full', behavioral: true });
    const preview = await previewRun(root, input);
    expect(preview.admission.blocking).toEqual([]);
    expect(preview.admission.executable_facts).toEqual([]);
    expect(preview.blueprint.readiness.derived_capability_requirements.test_runner_profiles).toEqual([]);
    const started = await startRun(root, { ...input, expected_admission_digest: preview.admission_digest });
    expect(started.ok).toBe(true);
  });

  it('keeps a documentation run independent of optional generators without granting their writes', async () => {
    const profile = { id: 'generate', command: 'npm run generate', roles: ['implementer'],
      effect: 'write', output_paths: ['dist/generated.js'] };
    const root = await fixture({ policy: { command_profiles: [profile], evidence_scripts: ['generate'] } });
    const input = request();
    const preview = await previewRun(root, input);
    expect(preview.admission.ready).toBe(true);
    expect(preview.admission.scope.generated_paths).toEqual([]);
    expect(preview.blueprint.readiness.available_capability_catalog.command_profiles).toEqual([profile]);
    expect((await startRun(root, { ...input, expected_admission_digest: preview.admission_digest })).ok).toBe(true);
    const state = JSON.parse(await readFile(path.join(root, '.ape/runtime/active.json'), 'utf8'));
    const ticket = state.tickets[0];
    expect(ticket.capability_manifest.command_profiles).toEqual([]);
    expect(ticket.capability_manifest.allowed_evidence_commands).not.toContain(profile.command);
    const planner = ticketCapabilityManifest(state, { role: 'planner' }, []);
    expect(planner.planning_command_profiles).toEqual([]);
    expect(planner.plannable_evidence_commands).not.toContain(profile.command);
    for (const command of [profile.command, 'npm   run generate', 'npm run "generate"', 'npm run generate -- --production',
      'npm run generate -- --version', 'npm run generate -- -v']) {
      expect(evaluateLifecyclePolicy({ project_dir: root, host: 'claude', event: 'PreToolUse',
        tool_name: 'Bash', is_subagent: true, command }, { state, ticket })).toMatchObject({ decision: 'deny' });
    }
    for (const option of ['--help', '-h', '--version', '-v']) {
      expect(evaluateLifecyclePolicy({ project_dir: root, host: 'claude', event: 'PreToolUse',
        tool_name: 'Bash', is_subagent: true, command: `npm run generate ${option}` }, { state, ticket }))
        .toMatchObject({ decision: 'allow' });
    }
  });

  it.skipIf(process.platform === 'win32')('matches npm version execution before and after its argument separator', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ape-npm-version-'));
    roots.push(root);
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { generate: 'node marker.js' } }));
    await writeFile(path.join(root, 'marker.js'), "require('node:fs').writeFileSync('marker', 'executed');\n");
    const profile = { id: 'generate', command: 'npm run generate', roles: ['implementer'],
      effect: 'write', output_paths: ['dist/generated.js'] };
    for (const option of ['--version', '-v']) for (const forwarded of [false, true]) {
      await rm(path.join(root, 'marker'), { force: true });
      const args = ['run', 'generate', ...(forwarded ? ['--'] : []), option];
      execFileSync('npm', args, { cwd: root, stdio: 'ignore', timeout: 10_000 });
      const executed = await readFile(path.join(root, 'marker'), 'utf8').then(() => true, () => false);
      expect(executed).toBe(forwarded);
      expect(invokesDeclaredWriteProfile(['npm', ...args].join(' '), profile)).toBe(executed);
    }
  });

  it('still requires the scope and executable for an explicitly selected generator', async () => {
    const profile = { id: 'generate', command: 'ape-missing-generator', roles: ['implementer'],
      effect: 'write', output_paths: ['dist/generated.js'] };
    const root = await fixture({ policy: { command_profiles: [profile] } });
    const input = request({ required_capabilities: [{ kind: 'command_profile', id: profile.id, role: 'implementer' }] });
    const preview = await previewRun(root, input);
    expect(preview.admission.blocking).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'writer-output-scope-missing', profile: profile.id }),
      expect.objectContaining({ code: 'command-executable-unavailable', profile: `command:${profile.id}` }),
    ]));
    expect(await startRun(root, { ...input, expected_admission_digest: preview.admission_digest }))
      .toMatchObject({ ok: false, code: 'admission-not-ready', attempts_consumed: 0 });
  });

  it.each(['pnpm', 'yarn', 'bun'])('keeps %s script help arguments subject to the declared output scope', async (manager) => {
    const profile = { id: 'generate', command: `${manager} run generate`, roles: ['implementer'],
      effect: 'write', output_paths: ['dist/generated.js'] };
    const root = await fixture({ policy: { command_profiles: [profile], evidence_scripts: ['generate'] } });
    const input = request();
    const preview = await previewRun(root, input);
    expect(preview.admission.ready).toBe(true);
    expect((await startRun(root, { ...input, expected_admission_digest: preview.admission_digest })).ok).toBe(true);
    const state = JSON.parse(await readFile(path.join(root, '.ape/runtime/active.json'), 'utf8'));
    const ticket = state.tickets[0];
    for (const suffix of ['--help', '-h', '-- --help']) {
      expect(evaluateLifecyclePolicy({ project_dir: root, host: 'claude', event: 'PreToolUse',
        tool_name: 'Bash', is_subagent: true, command: `${profile.command} ${suffix}` }, { state, ticket }))
        .toMatchObject({ decision: 'deny', reason: expect.stringContaining('declared writer is unavailable') });
    }
  });

  it('keeps an optional generator available to a writer who owns its outputs', async () => {
    const profile = { id: 'generate', command: 'node --version', roles: ['implementer'],
      effect: 'write', output_paths: ['dist/generated.js'] };
    const root = await fixture({ policy: { command_profiles: [profile] } });
    const input = request({ claimed_paths: ['README.md', 'dist/generated.js'] });
    const preview = await previewRun(root, input);
    expect(preview.admission.ready).toBe(true);
    expect((await startRun(root, { ...input, expected_admission_digest: preview.admission_digest })).ok).toBe(true);
    const state = JSON.parse(await readFile(path.join(root, '.ape/runtime/active.json'), 'utf8'));
    const ticket = state.tickets[0];
    expect(ticket.capability_manifest.command_profiles).toEqual([profile]);
    expect(ticket.capability_manifest.allowed_evidence_commands).toContain(profile.command);
    for (const command of [profile.command, 'node   --version', 'node "--version"']) {
      expect(evaluateLifecyclePolicy({ project_dir: root, host: 'claude', event: 'PreToolUse',
        tool_name: 'Bash', is_subagent: true, command }, { state, ticket })).toMatchObject({ decision: 'allow' });
      expect(matchingCommandProfile(root, command, { state, ticket })).toEqual(profile);
      for (const event of ['PreToolUse', 'PostToolUse', 'PostToolUseFailure']) {
        expect(driftGuardApplies({ project_dir: root, event, tool_name: 'Bash', is_subagent: true, command },
          { state, ticket })).toBe(true);
      }
    }
    const wrongHash = { ...ticket, capability_manifest: { ...ticket.capability_manifest, config_hash: 'untrusted' } };
    expect(matchingCommandProfile(root, 'node   --version', { state, ticket: wrongHash })).toBeNull();
  });

  it.each([
    ["node '$HOME'", 'node "$HOME"'],
    ["node '*.js'", 'node *.js'],
    ["node '`pwd`'", 'node "`pwd`"'],
    ['node script.js >output.txt', 'node   script.js >output.txt'],
    ['node script.js', "node script.js ''"],
    ["'MODE=test' node --version", 'MODE=test node --version'],
  ])('keeps shell-sensitive profile %s exact', (declared, variant) => {
    const profile = { id: 'sensitive', command: declared, roles: ['implementer'], effect: 'execute' };
    const state = { capability_snapshot: { version: 1, config_hash: 'frozen', command_profiles: [profile] } };
    const ticket = { receipt_contract_version: 1,
      capability_manifest: { version: 1, config_hash: 'frozen', command_profiles: [profile] } };
    expect(matchingCommandProfile(null, declared, { state, ticket })).toEqual(profile);
    expect(matchingCommandProfile(null, variant, { state, ticket })).toBeNull();
  });

  it('admits an optional missing verifier and blocks the same explicitly required verifier', async () => {
    const profile = { id: 'browser', description: 'Optional browser checks', command: 'ape-missing-browser', timeout_ms: 1000 };
    const root = await fixture({ verification: { profiles: [profile] } });
    const optional = await previewRun(root, request());
    expect(optional.admission.ready).toBe(true);
    expect(optional.blueprint.readiness.available_capability_catalog.verification_profiles).toEqual([profile]);
    const required = await previewRun(root, request({ required_capabilities: [{ kind: 'verification_profile', id: profile.id }] }));
    expect(required.admission.blocking).toContainEqual(expect.objectContaining({
      code: 'command-executable-unavailable', profile: `verification:${profile.id}`,
    }));
  });

  it('freezes only available verifier roots and rejects later selection of an unavailable optional verifier', async () => {
    const profile = { id: 'optional', description: 'Optional package checks', command: 'node --version', root: 'unrelated/missing', timeout_ms: 1000 };
    const root = await fixture({ test_commands: { targeted: 'node --version', full: 'node --version' },
      verification: { profiles: [profile] } });
    const input = request({ lane: 'fast', behavioral: true, plan_contract_version: 2,
      claimed_paths: ['src/value.js'], test_paths: ['tests/value.test.js'] });
    const requiredInput = { ...input, required_capabilities: [{ kind: 'verification_profile', id: profile.id }] };
    const required = await previewRun(root, requiredInput);
    expect(required.admission.blocking).toContainEqual(expect.objectContaining({ code: 'verification-profile-root-unavailable' }));
    expect(await startRun(root, { ...requiredInput, expected_admission_digest: required.admission_digest }))
      .toMatchObject({ ok: false, code: 'admission-not-ready', attempts_consumed: 0 });
    const preview = await previewRun(root, input);
    expect(preview.admission.ready).toBe(true);
    expect(preview.blueprint.readiness.available_capability_catalog.verification_profiles).toEqual([profile]);
    expect(preview.admission.unavailable_verification_profiles).toEqual([
      { id: profile.id, root: profile.root, reason: 'root is missing or unreadable' },
    ]);
    expect((await startRun(root, { ...input, expected_admission_digest: preview.admission_digest })).ok).toBe(true);
    const state = JSON.parse(await readFile(path.join(root, '.ape/runtime/active.json'), 'utf8'));
    expect(state.verification_profiles).toEqual([]);
    expect(state.verification_profile_roots).toEqual([]);
    expect(state.capability_snapshot.verification_profiles).toEqual([]);
    const profiles = state.tickets[0].capability_manifest.verification_profiles;
    expect(profiles).toEqual([]);
    const artifact = { version: 1, objective: input.objective, acceptance: ['Observe the behavior'], non_goals: [],
      baseline: [{ command: 'node --version', observation: 'Available' }], impacted_paths: { read: [], write: [] },
      compatibility: 'Preserve existing callers', rollback: 'Revert the change', questions: [],
      verification_profiles: [{ id: profile.id, disposition: 'required', reason: 'Attempt to select unavailable profile' }] };
    const selected = validatePreflightArtifact(artifact, { objective: input.objective, profiles, tests: [{ command: 'node --version' }] });
    expect(selected.valid).toBe(false);
    expect(selected.errors).toContain(`evidence.preflight_artifact references unknown verification profile: ${profile.id}`);
  });

  it('preserves phase and land gate prerequisites, including documentation changes', async () => {
    const root = await fixture({ test_commands: { full: 'ape-missing-gate-runner' } });
    for (const mode of ['phase', 'land']) {
      if (mode === 'land') await writeFile(path.join(root, 'README.md'), 'finished docs change\n');
      const preview = await previewRun(root, request({ mode }));
      expect(preview.admission.blocking).toContainEqual(expect.objectContaining({
        code: 'command-executable-unavailable', profile: 'test:full',
      }));
    }
  });

  it.each(['debug', 'spike'])('does not infer shipping consent or inspect shipping prerequisites for %s', async (mode) => {
    const target = { origin: 'https://github.com/synthetic/example.git', repository: 'synthetic/example', base: 'main' };
    const root = await fixture({ shipping: { auto_merge: true, target } });
    git(root, 'remote', 'add', 'origin', target.origin);
    git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    git(root, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
    const shippingSpy = vi.spyOn(shipping, 'inspectShippingAdmission').mockRejectedValue(new Error('shipping must not run'));
    const remoteSpy = vi.spyOn(gitRuntime, 'remoteBranchTip').mockRejectedValue(new Error('remote shipping check must not run'));
    const input = request({ mode });
    const preview = await previewRun(root, input);
    expect(preview.admission.ready).toBe(true);
    expect(preview.admission.request.auto_merge_authorized).not.toBe(true);
    expect(preview.admission.shipping_target).toBeNull();
    expect(preview.admission.shipping_prerequisites).toEqual({ status: 'not-requested' });
    expect((await startRun(root, { ...input, expected_admission_digest: preview.admission_digest })).ok).toBe(true);
    expect(shippingSpy).not.toHaveBeenCalled();
    expect(remoteSpy).not.toHaveBeenCalled();
  });

  it.each(['phase', 'land'])('preserves configured shipping consent and prerequisite admission for %s', async (mode) => {
    const target = { origin: 'https://github.com/synthetic/example.git', repository: 'synthetic/example', base: 'main' };
    const root = await fixture({ shipping: { auto_merge: true, target } });
    if (mode === 'land') await writeFile(path.join(root, 'README.md'), 'finished docs change\n');
    const shippingSpy = vi.spyOn(shipping, 'inspectShippingAdmission').mockResolvedValue({ ready: false,
      blocking: [{ code: 'synthetic-shipping-prerequisite' }], shipping_target: null });
    const preview = await previewRun(root, request({ mode }));
    expect(preview.admission.request.auto_merge_authorized).toBe(true);
    expect(preview.admission.blocking).toContainEqual({ code: 'synthetic-shipping-prerequisite' });
    expect(shippingSpy).toHaveBeenCalledOnce();
  });
});
