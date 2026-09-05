import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readlink, realpath } from 'node:fs/promises';
import path from 'node:path';
import { sha256 } from './canonical.js';
import { resolveBaseBranch, runGit } from './git.js';
import { canonicalProjectRelativePathError, withinClaims } from './path-scope.js';
import { inspectShippingAdmission } from './shipping-target.js';
import { runVersionProvenance } from './versions.js';
import { resolveModel, resolveTicketDeadline, validateAdmissionCommandConfiguration } from './config.js';
import { splitCommand } from './runner.js';
import { activeState } from './active-state.js';
import { runtimePaths } from './paths.js';
import { assertRoadmapRequirementsReady } from './roadmap.js';
import { inspectAdmissionBaseline } from './admission-baseline.js';
import { inspectAdmissionCommandPrerequisites, resolveAdmissionExecutable } from './admission-command-prerequisites.js';
export { resolveAdmissionExecutable } from './admission-command-prerequisites.js';

export const ADMISSION_CONTRACT_VERSION = 1;
const sorted = (values) => [...new Set(values)].sort();
const projectFile = (file) => file !== '.ape' && !file.startsWith('.ape/');
const MAX_ADMISSION_CHANGED_PATHS = 2_048;
const MAX_ADMISSION_CHANGED_BYTES = 64 * 1024 * 1024;
const gitRead = (root, args) => runGit(root, args, { raw: true, env: { GIT_OPTIONAL_LOCKS: '0' } });
const list = async (root, args) => (await gitRead(root, args)).split('\0').filter(Boolean).filter(projectFile).sort();

function originCommitment(value) {
  if (value === null) return null;
  // Remote URLs sometimes embed credentials. Bind exact bytes without ever
  // copying them to preview, active state, history, or correction prose.
  const github = /^(?:https:\/\/(?:[^/@]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(value);
  return { identity: github ? `github.com/${github[1]}` : 'other-origin', url_digest: sha256(value) };
}

// The one input commitment used by preview and start. The proof supplied by
// the caller cannot hash itself; a probe is an independently checked runtime
// prerequisite, not a different work request. No timestamps or mutable .ape
// evidence enter the commitment.
export function reviewedAdmissionInput(input) {
  const { expected_admission_digest, binding_probe, ...reviewed } = input;
  return reviewed;
}

async function fileFingerprint(root, file, remainingBytes) {
  const absolute = path.join(root, file);
  const canonicalRoot = await realpath(root);
  const parent = await realpath(path.dirname(absolute)).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (parent && parent !== canonicalRoot && !parent.startsWith(`${canonicalRoot}${path.sep}`)) {
    throw new Error(`changed path has an outside-project ancestor: ${file}`);
  }
  const metadata = await lstat(absolute).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!metadata) return { path: file, kind: 'absent' };
  if (metadata.isSymbolicLink()) return { path: file, kind: 'symlink', target_hash: sha256(await readlink(absolute)) };
  if (!metadata.isFile()) throw new Error(`changed path is not a regular file or Git symlink: ${file}`);
  const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.ino !== metadata.ino || before.dev !== metadata.dev) throw new Error(`changed path identity raced admission: ${file}`);
    if (before.size > remainingBytes) throw new Error(`changed content exceeds the ${MAX_ADMISSION_CHANGED_BYTES}-byte read-only admission budget; decompose the finished diff before preview`);
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(64 * 1024);
    let bytes = 0;
    for (;;) {
      const read = await handle.read(buffer, 0, buffer.length, bytes);
      if (!read.bytesRead) break;
      bytes += read.bytesRead;
      if (bytes > remainingBytes) throw new Error(`changed content grew beyond the admission byte budget: ${file}`);
      hash.update(buffer.subarray(0, read.bytesRead));
    }
    const after = await handle.stat();
    const current = await lstat(absolute);
    if (await realpath(path.dirname(absolute)) !== parent || !current.isFile() || current.ino !== before.ino || current.dev !== before.dev ||
        bytes !== before.size || ['size', 'mtimeMs', 'ctimeMs'].some((key) => after[key] !== before[key] || current[key] !== before[key])) {
      throw new Error(`changed content was modified while preview read it; retry preview after writes stop: ${file}`);
    }
    return { path: file, kind: 'file', mode: before.mode, size: before.size, sha256: hash.digest('hex') };
  } finally { await handle.close(); }
}

export async function inspectAdmissionRepository(root, input) {
  const canonicalRoot = await realpath(root);
  const top = (await gitRead(root, ['rev-parse', '--show-toplevel'])).trim();
  if (await realpath(top) !== canonicalRoot) throw new Error('APE admission requires the repository root, not a nested working directory');
  const branch = (await gitRead(root, ['branch', '--show-current'])).trim();
  const head = await gitRead(root, ['rev-parse', '--verify', 'HEAD']).then((s) => s.trim(), () => null);
  const unborn = head === null && (await gitRead(root, ['symbolic-ref', '-q', 'HEAD']).catch(() => '')).trim() === `refs/heads/${branch}`;
  const base = unborn ? { branch, start_point: `refs/heads/${branch}` } : await resolveBaseBranch(root);
  const baseCommit = unborn ? null : (await gitRead(root, ['rev-parse', base.start_point])).trim();
  const allStatus = (await gitRead(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames']))
    .split('\0').filter(Boolean).map((record) => ({ index: record[0], worktree: record[1], path: record.slice(3) }));
  const status = allStatus.filter((entry) => projectFile(entry.path));
  const runtimeStaged = allStatus.filter((entry) => !projectFile(entry.path) && ![' ', '?'].includes(entry.index)).map((entry) => entry.path);
  const staged = status.filter((s) => ![' ', '?'].includes(s.index)).map((s) => s.path);
  const unstaged = status.filter((s) => s.worktree !== ' ').map((s) => s.path);
  const conflicts = status.filter((s) => s.index === 'U' || s.worktree === 'U' || ['AA', 'DD'].includes(s.index + s.worktree)).map((s) => s.path);
  const committed = head && baseCommit ? await list(root, ['diff', '--name-only', '--no-renames', '-z', baseCommit, head, '--']) : [];
  const changed = sorted([...status.map((s) => s.path), ...committed]);
  if (changed.length > MAX_ADMISSION_CHANGED_PATHS) throw new Error(`changed scope exceeds ${MAX_ADMISSION_CHANGED_PATHS} paths; decompose the finished diff before admission`);
  const fingerprints = [];
  let remainingBytes = MAX_ADMISSION_CHANGED_BYTES;
  for (const file of changed) {
    const fingerprint = await fileFingerprint(root, file, remainingBytes);
    fingerprints.push(fingerprint);
    remainingBytes -= fingerprint.size ?? 0;
  }
  return {
    root: canonicalRoot, branch, head, unborn, base_branch: base.branch, base_ref: base.start_point, base_commit: baseCommit,
    origin: originCommitment(await gitRead(root, ['remote', 'get-url', 'origin']).then((s) => s.trim(), () => null)),
    index_digest: sha256(await gitRead(root, ['ls-files', '--stage', '-z'])),
    staged_paths: sorted([...staged, ...runtimeStaged]), runtime_paths_staged: sorted(runtimeStaged), unstaged_paths: sorted(unstaged), conflict_paths: sorted(conflicts),
    dirty_paths: sorted(status.map((s) => s.path)), changed_paths: changed,
    changed_content: fingerprints,
    descends_from_base: !head || !baseCommit || head === baseCommit || await gitRead(root, ['merge-base', '--is-ancestor', baseCommit, head]).then(() => true, () => false),
  };
}

export async function evaluateAdmission({ root, input, config, classification, projection, readiness, health }) {
  const blocking = [...(readiness.blocking ?? [])];
  try { validateAdmissionCommandConfiguration(config); }
  catch (error) { blocking.push({ code: 'invalid-command-effect-contract', message: error.message }); }
  try {
    const current = await activeState(runtimePaths(root));
    if (current && !['completed', 'aborted'].includes(current.status)) blocking.push({ code: 'active-run-exists',
      message: `A run is already ${current.status}; new admission cannot replace it. Diagnose it and obtain any required operator decision.` });
    await assertRoadmapRequirementsReady(runtimePaths(root), input.requirements, { phase: 'preview' });
  } catch (error) { blocking.push({ code: 'runtime-prerequisite-unavailable', message: error.message }); }
  let repository = null;
  try { repository = await inspectAdmissionRepository(root, input); }
  catch (error) { blocking.push({ code: 'repository-unavailable', message: error.message }); }
  const approved = [...input.claimed_paths, ...input.test_paths];
  for (const file of approved) {
    const error = canonicalProjectRelativePathError(file);
    if (error) blocking.push({ code: 'invalid-scope-path', path: file, message: error });
  }
  const roles = new Set(projection.stages.map((stage) => stage.role));
  const commandProfiles = [...(config.policy?.command_profiles ?? []), ...(input.run_command_profiles ?? [])]
    .filter((profile) => profile.roles?.some((role) => roles.has(role)));
  const outputPaths = sorted(commandProfiles.flatMap((profile) => profile.output_paths ?? []));
  for (const profile of commandProfiles) {
    for (const role of profile.roles.filter((role) => roles.has(role))) {
      const roleClaims = role === 'test_writer' ? input.test_paths : input.claimed_paths;
      const outside = (profile.output_paths ?? []).filter((file) => !withinClaims(file, roleClaims));
      if (outside.length) blocking.push({ code: 'writer-output-scope-missing', profile: profile.id, role, paths: outside,
        message: 'Approve every generated output in the producing role’s scope before its ticket is issued.' });
    }
  }
  const requiredPaths = sorted([
    ...outputPaths,
    ...(input.mode === 'land' ? repository?.changed_paths ?? [] : []),
  ]);
  const missingApproval = requiredPaths.filter((file) => !withinClaims(file, approved));
  if (missingApproval.length) blocking.push({ code: 'scope-approval-required', paths: missingApproval,
    message: 'Declare these required changed/generated paths in claimed_paths or test_paths after operator approval; APE did not widen scope.' });
  if (repository) {
    if (!repository.branch) blocking.push({ code: 'detached-head', message: 'Select or explicitly create a branch before admission.' });
    if (repository.conflict_paths.length) blocking.push({ code: 'unresolved-conflicts', paths: repository.conflict_paths });
    if (repository.runtime_paths_staged.length) blocking.push({ code: 'runtime-metadata-staged', paths: repository.runtime_paths_staged,
      message: 'Pre-existing staged APE metadata must not ride along in bootstrap or shipping commits. Preserve it and obtain an operator decision about the index before starting.' });
    if (input.mode !== 'land' && repository.dirty_paths.length) blocking.push({ code: 'dirty-start', paths: repository.dirty_paths,
      message: 'A build run requires a clean baseline. Preserve and explicitly commit/stash your work, or use land for a finished diff.' });
    if (input.mode === 'land') {
      if (repository.unborn) blocking.push({ code: 'land-unborn', message: 'Land requires an existing baseline commit; use phase to bootstrap.' });
      if (!repository.changed_paths.length) blocking.push({ code: 'land-empty-diff', message: 'Land requires a non-empty finished diff against the resolved base.' });
      if (!repository.descends_from_base) blocking.push({ code: 'land-base-divergence', message: 'Rebase the finished feature onto the resolved base before review.' });
    }
  }
  const shipping = config.shipping?.target != null || (config.shipping?.auto_merge === true && input.auto_merge_authorized === true)
    ? await inspectShippingAdmission(root, input, config)
    : { ready: true, blocking: [], shipping_target: null };
  blocking.push(...shipping.blocking);
  if (shipping.shipping_target && repository?.base_branch !== shipping.shipping_target.base) {
    blocking.push({ code: 'shipping-base-mismatch', message: 'The resolved repository base must match the explicitly configured shipping.target.base.' });
  }
  for (const check of health.checks ?? []) {
    if (check.passed !== true && (check.informational !== true || ['bundle-drift', 'loaded-module-drift'].includes(check.name))) {
      blocking.push({ code: `doctor:${check.name}`, message: check.detail });
    }
  }
  const commands = [
    ...Object.entries(config.test_commands ?? {}).filter(([, command]) => typeof command === 'string').filter(([name]) => !['shuffle', 'serialize'].includes(name)).map(([id, command]) => ({ id: `test:${id}`, command, root: '.' })),
    ...(config.runners ?? []).flatMap((runner) => Object.entries(runner.profile ?? {})
      .filter(([name, command]) => typeof command === 'string' && !['shuffle', 'serialize'].includes(name))
      .map(([id, command]) => ({ id: `runner:${runner.id}:${id}`, command, root: runner.root ?? '.' }))),
    ...(config.verification?.profiles ?? []).map((profile) => ({ id: `verification:${profile.id}`, command: profile.command, root: profile.root ?? '.' })),
    ...commandProfiles.map((profile) => ({ id: `command:${profile.id}`, command: profile.command, root: '.' })),
  ];
  const executableFacts = [];
  for (const command of commands) {
    try {
      const argv = splitCommand(command.command);
      const executable = argv[0];
      if (!executable) throw new Error('an exact executable is required');
      const commandRoot = path.resolve(root, command.root);
      const resolved = await resolveAdmissionExecutable(commandRoot, executable);
      executableFacts.push({ id: command.id, executable, resolved });
      if (!resolved) blocking.push({ code: 'command-executable-unavailable', profile: command.id, executable,
        message: 'Install or explicitly configure this runner/tool before starting; baseline test failure is distinct from an unavailable executable.' });
    } catch (error) { blocking.push({ code: 'command-unrepresentable', profile: command.id, message: error.message }); }
  }
  blocking.push(...await inspectAdmissionCommandPrerequisites(root, commands, executableFacts));
  blocking.push(...await inspectAdmissionBaseline(root, input, repository, commands, executableFacts));
  const manifest = {
    version: ADMISSION_CONTRACT_VERSION,
    authorization: 'reviewed-inputs-only', ready: blocking.length === 0,
    request: reviewedAdmissionInput(input), config_digest: sha256(config), runtime: runVersionProvenance(input.host),
    repository, scope: { claimed_paths: [...input.claimed_paths], test_paths: [...input.test_paths], generated_paths: outputPaths, missing_approval: missingApproval },
    // Schema hashes bind exact consumer bytes without repeating a many-KiB
    // identical receipt schema once for every projected stage. Workers still
    // receive the full canonical schema on their authenticated tickets.
    pipeline: { lane: classification.lane, stages: projection.stages.map(({ output_schema, ...stage }) => ({
      ...stage, output_schema_hash: sha256(output_schema),
      model: (() => { try { return resolveModel(config, input.host, stage.model_tier, stage.role); } catch { return null; } })(),
    })), conditional_branches: projection.conditional_branches, dispatch_bounds: projection.dispatch_bounds },
    ticket_deadline: resolveTicketDeadline(config, input.mode, classification.lane),
    contract: readiness.admission_contract ?? null,
    capability_catalog_digest: readiness.available_capability_catalog?.catalog_hash ?? null,
    executable_facts: executableFacts,
    shipping_target: shipping.shipping_target,
    shipping_prerequisites: 'prerequisites' in shipping ? shipping.prerequisites : { status: 'not-requested' },
    baseline: { evidence: 'availability-only', execution: 'not-run-by-read-only-preview', head: repository?.head ?? null },
    blocking,
  };
  return { admission: manifest, admission_digest: sha256(manifest) };
}
