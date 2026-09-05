import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { runGit } from './git.js';
import { spawnWithTimeout } from './spawn.js';
import { sha256 } from './canonical.js';
import { validatedAdmittedStartIdentity } from './admitted-start-identity.js';

const PUBLIC_APE_REPOSITORY = 'AAWWCC/ape';
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;

function originRepository(value) {
  if (typeof value !== 'string' || value.length > 512 || value !== value.trim()) return null;
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(value);
  return match && REPOSITORY.test(match[1]) ? match[1] : null;
}

function validBase(value) {
  return typeof value === 'string' && value.length <= 200 &&
    /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) &&
    !value.includes('..') && !value.includes('//') && !value.includes('/.') &&
    !value.endsWith('.') && !value.endsWith('/') &&
    !value.split('/').some((part) => part.endsWith('.lock'));
}

function configuredTarget(config) {
  const value = config?.shipping?.target;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const repository = originRepository(value.origin);
  if (!repository || !REPOSITORY.test(value.repository ?? '') ||
      repository.toLowerCase() !== value.repository.toLowerCase() || !validBase(value.base)) return null;
  return {
    version: 1,
    provider: 'github',
    origin: value.origin,
    repository: value.repository,
    base: value.base,
    required_remote_checks: config.shipping.required_remote_checks !== false,
  };
}

async function isCanonicalApePackage(projectDir) {
  let handle;
  try {
    handle = await open(path.join(projectDir, 'package.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > 1_048_576) throw new Error('package identity is not a bounded regular file');
    const bytes = Buffer.alloc(1_048_577);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 1_048_576) throw new Error('package identity exceeds its bound');
    const pkg = JSON.parse(bytes.subarray(0, bytesRead).toString('utf8'));
    const origin = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
    return pkg.name === 'ape' && originRepository(origin)?.toLowerCase() === PUBLIC_APE_REPOSITORY.toLowerCase();
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw new Error('shipping package identity is unreadable or invalid');
  } finally {
    await handle?.close();
  }
}

async function assertOrigin(projectDir, target) {
  const options = { env: { GIT_OPTIONAL_LOCKS: '0' }, timeout_ms: 10_000 };
  // Validate the EFFECTIVE frozen transport too. A named HTTPS origin can be
  // correct while a separately configured frozen SSH URL is redirected by
  // insteadOf/pushInsteadOf. --get-url is local: Git expands configuration and
  // exits without contacting the remote or creating refs/configuration.
  const urls = await Promise.all([
    runGit(projectDir, ['remote', 'get-url', '--all', 'origin'], options),
    runGit(projectDir, ['remote', 'get-url', '--push', '--all', 'origin'], options),
    runGit(projectDir, ['ls-remote', '--get-url', target.origin], options),
  ]);
  const pushRules = await spawnWithTimeout('git', ['config', '--null', '--get-regexp', '^url\\..*\\.pushinsteadof$'], {
    cwd: projectDir, shell: false, collect: 'combined', timeout_ms: 10_000, max_output: 1_048_576,
    env: options.env,
  });
  if (pushRules.spawn_error || pushRules.timed_out === true ||
      ![0, 1].includes(pushRules.exit_code) || typeof pushRules.combined !== 'string' ||
      pushRules.combined.length > 1_048_576 || (pushRules.exit_code === 1 && pushRules.combined !== '')) {
    throw new Error('shipping origin no longer matches the explicit frozen target; Git URL rewriting could not be verified');
  }
  const entries = pushRules.combined.split('\0').filter(Boolean);
  if (entries.length > 128) throw new Error('shipping origin URL rewriting exceeds the bounded inspection limit');
  for (const entry of entries) {
    const separator = entry.indexOf('\n');
    const key = entry.slice(0, separator);
    const prefix = entry.slice(separator + 1);
    if (separator < 0 || !key.startsWith('url.') || !key.endsWith('.pushinsteadof')) {
      throw new Error('shipping origin URL rewriting could not be verified');
    }
    if (!target.origin.startsWith(prefix)) continue;
    // Checking every matching rule is conservative when a longer prefix wins:
    // an unsafe overlapping rule must be explicitly resolved, never ignored.
    const candidate = key.slice(4, -'.pushinsteadof'.length) + target.origin.slice(prefix.length);
    urls.push(candidate, await runGit(projectDir, ['ls-remote', '--get-url', candidate], options));
  }
  const expected = originRepository(target.origin)?.toLowerCase();
  if (urls.some((output) => {
    const values = String(output).split(/\r?\n/).filter(Boolean);
    return values.length !== 1 || originRepository(values[0])?.toLowerCase() !== expected;
  })) throw new Error('shipping origin no longer matches the explicit frozen target');
}

async function boundedGithub(projectDir, args) {
  const result = await spawnWithTimeout('gh', args, {
    cwd: projectDir, shell: false, collect: 'combined', timeout_ms: 30_000, max_output: 1_048_576,
    env: { GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0' },
  });
  return result.exit_code === 0 && !result.spawn_error && result.timed_out !== true &&
    typeof result.combined === 'string' && result.combined.length <= 1_048_576 ? result.combined : null;
}

async function githubJson(projectDir, target, endpoint) {
  await assertOrigin(projectDir, target);
  // gh api has no --repo flag; explicit endpoints avoid ambient GH_REPO and
  // {owner}/{repo} placeholder resolution. Never persist raw API/error output.
  const output = await boundedGithub(projectDir, ['api', `repos/${target.repository}${endpoint}`, '--hostname', 'github.com']);
  if (output === null) return null;
  try { return JSON.parse(output); } catch { return null; }
}

export async function assertQueuedShippingProtection(projectDir, target) {
  // Green checks plus a point-in-time local base observation cannot prove a
  // future merged tree. Queued shipping needs server-enforced future-base CI.
  const base = encodeURIComponent(target.base);
  const rules = await githubJson(projectDir, target, `/rules/branches/${base}`);
  const checks = Array.isArray(rules) ? rules.filter((rule) =>
    rule?.type === 'required_status_checks' &&
    Array.isArray(rule.parameters?.required_status_checks) &&
    rule.parameters.required_status_checks.some((check) => typeof check?.context === 'string' && check.context.trim() !== '')) : [];
  const strict = checks.some((rule) => rule.parameters.strict_required_status_checks_policy === true);
  const queue = Array.isArray(rules) && checks.length > 0 && rules.some((rule) =>
    rule?.type === 'merge_queue' && rule.parameters?.grouping_strategy === 'ALLGREEN');
  if (strict || queue) return;
  const classic = await githubJson(projectDir, target, `/branches/${base}/protection/required_status_checks`);
  if (classic?.strict === true && (
    (Array.isArray(classic.contexts) && classic.contexts.some((context) => typeof context === 'string' && context.trim() !== '')) ||
    (Array.isArray(classic.checks) && classic.checks.some((check) => typeof check?.context === 'string' && check.context.trim() !== ''))
  )) return;
  throw new Error('auto-merge requires verified up-to-date required checks or an ALLGREEN merge queue with required checks; preserve the watch and inspect the frozen repository protection before retrying');
}

async function inspectPrerequisites(projectDir, target, requested, blocking) {
  const facts = {
    status: 'deferred', git_identity: 'deferred', signing: 'deferred', github_cli: 'deferred',
    repository_access: 'deferred', squash_merge: 'deferred', protected_merge: 'deferred',
  };
  if (!requested || blocking.length > 0) return facts;
  const options = { env: { GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' }, timeout_ms: 10_000 };
  try {
    const identities = await Promise.all(['GIT_AUTHOR_IDENT', 'GIT_COMMITTER_IDENT'].map((key) => runGit(projectDir, ['var', key], options)));
    if (identities.some((value) => typeof value !== 'string' || value.length > 4096 || !/^.+ <[^<>\s]+> \d+ [+-]\d{4}$/.test(value))) throw new Error('invalid identity');
    facts.git_identity = 'ready';
  } catch {
    facts.git_identity = 'unavailable';
    blocking.push({ code: 'shipping_git_identity_unavailable', message: 'Configure a valid non-interactive Git author and committer identity before admitting shipping.' });
  }
  try {
    const signing = await runGit(projectDir, ['config', '--type=bool', '--default=false', '--get', 'commit.gpgsign'], options);
    if (signing !== 'false') throw new Error('signing not proven');
    facts.signing = 'disabled';
  } catch {
    facts.signing = 'unverified';
    blocking.push({ code: 'shipping_signing_unverified', message: 'Configured commit signing cannot be non-interactively proven by read-only admission; explicitly resolve the signing policy before shipping. No signer or key is invoked.' });
  }
  if (blocking.length > 0) return { ...facts, status: 'blocked' };
  if (await boundedGithub(projectDir, ['--version']) === null) {
    facts.github_cli = 'unavailable';
    blocking.push({ code: 'shipping_github_unavailable', message: 'A usable GitHub CLI is required before shipping admission; install or repair it explicitly.' });
    return { ...facts, status: 'blocked' };
  }
  facts.github_cli = 'ready';
  const repo = await githubJson(projectDir, target, '');
  if (!repo || typeof repo.full_name !== 'string' || repo.full_name.toLowerCase() !== target.repository.toLowerCase() ||
      repo.archived !== false || repo.disabled !== false || repo.permissions?.pull !== true || repo.permissions?.push !== true) {
    facts.repository_access = 'unverified';
    blocking.push({ code: 'shipping_repository_access_unverified', message: 'Read-only GitHub inspection could not prove authenticated read/write access to the active frozen repository; verify its access before shipping. No credential refresh is performed.' });
  } else facts.repository_access = 'ready';
  if (repo?.allow_squash_merge !== true) {
    facts.squash_merge = 'unavailable';
    blocking.push({ code: 'shipping_squash_unavailable', message: 'The frozen repository must explicitly allow squash merging before this shipping workflow can start.' });
  } else facts.squash_merge = 'ready';
  if (target.required_remote_checks) {
    try {
      await assertQueuedShippingProtection(projectDir, target);
      facts.protected_merge = 'ready';
    } catch {
      facts.protected_merge = 'unverified';
      blocking.push({ code: 'shipping_protection_unverified', message: 'Shipping with required checks needs readable, nonempty up-to-date required checks or an ALLGREEN merge queue with required checks before work starts.' });
    }
  } else facts.protected_merge = 'not-required';
  return { ...facts, status: blocking.length > 0 ? 'blocked' : 'ready' };
}

// Read-only admission never changes refs, configuration, credentials, or
// worktree bytes. Explicit shipping requests also inspect bounded GitHub API
// prerequisites; produce-and-hold freezes a local target with proof deferred.
export async function inspectShippingAdmission(projectDir, input, config) {
  const blocking = [];
  const target = configuredTarget(config);
  if (config?.shipping?.provider !== 'github') {
    blocking.push({ code: 'shipping_provider_unsupported', message: 'shipping requires the github provider' });
  }
  if (!target) {
    blocking.push({ code: config?.shipping?.target == null ? 'shipping_target_missing' : 'shipping_target_invalid', message: 'configure an explicit shipping.target origin, repository, and base' });
    return { ready: false, blocking, shipping_target: null };
  }
  let canonical = false;
  try {
    canonical = await isCanonicalApePackage(projectDir);
    if (canonical && target.repository.toLowerCase() !== PUBLIC_APE_REPOSITORY.toLowerCase()) {
      blocking.push({ code: 'canonical_ape_target_mismatch', message: 'the canonical public APE package must ship only to AAWWCC/ape' });
    }
  } catch {
    blocking.push({ code: 'shipping_package_identity_unreadable', message: 'package identity must be readable before shipping admission' });
  }
  try {
    await assertOrigin(projectDir, target);
  } catch {
    blocking.push({ code: 'shipping_origin_mismatch', message: 'origin fetch and push URLs must match the configured shipping target' });
  }
  const requested = input?.ship_requested === true ||
    (input?.auto_merge_authorized === true && config.shipping?.auto_merge === true);
  const prerequisites = await inspectPrerequisites(projectDir, target, requested, blocking);
  return {
    ready: blocking.length === 0,
    blocking,
    prerequisites,
    shipping_target: blocking.length === 0 ? {
      ...target,
      ...(canonical ? { project_guard: 'canonical-ape-public-v1' } : {}),
    } : null,
  };
}

export async function resolveFrozenShippingTarget(projectDir, state, config) {
  const frozen = state?.shipping_target;
  const parsed = configuredTarget({ shipping: { target: frozen, required_remote_checks: frozen?.required_remote_checks } });
  if (!parsed || frozen.version !== 1 || frozen.provider !== 'github' ||
      typeof frozen.required_remote_checks !== 'boolean') {
    throw new Error('shipping requires a valid frozen shipping target admitted when the run started; legacy or unbound runs cannot ship');
  }
  const admission = state.admission;
  const admittedUnborn = admission?.manifest?.repository?.unborn === true &&
    admission.manifest.repository.base_commit === null;
  if (admission?.version !== 1 || admission.manifest?.version !== 1 || admission.manifest.ready !== true ||
      typeof admission.digest !== 'string' || !/^[0-9a-f]{64}$/.test(admission.digest) ||
      !admission.manifest.shipping_target || typeof admission.manifest.shipping_target !== 'object' || Array.isArray(admission.manifest.shipping_target) ||
      sha256(admission.manifest) !== admission.digest ||
      sha256(admission.manifest.shipping_target ?? null) !== sha256(frozen) ||
      admission.manifest.repository?.base_branch !== state.base_branch ||
      (!admittedUnborn && admission.manifest.repository?.base_commit !== state.base_commit_sha)) {
    throw new Error('shipping admission commitment is absent or inconsistent; preserve this run and obtain a fresh reviewed admission with operator approval, never upgrade a legacy run in place');
  }
  if (!validatedAdmittedStartIdentity(state)) {
    throw new Error('shipping admitted-start identity does not match its original commitment; preserve the run for operator inspection before a fresh reviewed admission');
  }
  if (frozen.project_guard !== undefined && frozen.project_guard !== 'canonical-ape-public-v1') {
    throw new Error('frozen shipping target contains an invalid project guard');
  }
  if (frozen.project_guard === 'canonical-ape-public-v1' &&
      frozen.repository.toLowerCase() !== PUBLIC_APE_REPOSITORY.toLowerCase()) {
    throw new Error('the canonical public APE target cannot be changed');
  }
  const current = configuredTarget(config);
  if (!current || config.shipping.provider !== 'github' ||
      ['origin', 'repository', 'base', 'required_remote_checks'].some((key) => current[key] !== parsed[key]) ||
      state.base_branch !== parsed.base) {
    throw new Error('shipping target or policy drifted from the frozen run admission; preserve the run and restore its approved configuration');
  }
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(state.base_commit_sha ?? '')) {
    throw new Error('shipping requires the immutable base commit admitted when this run started');
  }
  if (admittedUnborn) {
    // The preview cannot name a not-yet-created commit. Only the explicit
    // unborn admission may defer that SHA; the validated start identity above
    // binds the actual root baseline, which must still be an empty commit.
    const options = { env: { GIT_OPTIONAL_LOCKS: '0' }, timeout_ms: 10_000 };
    const [kind, tree, emptyTree] = await Promise.all([
      runGit(projectDir, ['cat-file', '-t', state.base_commit_sha], options),
      runGit(projectDir, ['rev-parse', `${state.base_commit_sha}^{tree}`], options),
      runGit(projectDir, ['hash-object', '-t', 'tree', '--stdin'], options),
    ]);
    if (kind !== 'commit' || tree !== emptyTree) {
      throw new Error('shipping admitted unborn baseline is not an empty commit; preserve the run for operator inspection');
    }
  }
  await assertOrigin(projectDir, parsed);
  return Object.freeze({ ...frozen, enforce: true, git_remote: frozen.origin, github_repository: frozen.repository });
}

export async function assertShippingOriginCurrent(projectDir, target) {
  await assertOrigin(projectDir, target);
}

export function shippingPrUrlMatches(value, target) {
  if (typeof value !== 'string' || value.length > 512) return false;
  const match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/([1-9][0-9]*)$/.exec(value);
  return Boolean(match && match[1].toLowerCase() === target.repository.toLowerCase());
}
