import { access, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGit } from './git.js';
import { runtimePaths } from './paths.js';
import { detectAmbiguousConfigOverrides, loadRuntimeConfig } from './config.js';
import { inspectRunLock } from './lock.js';
import { readJson } from './storage.js';

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

// The minimal run-state shape every ape_run lever assumes: a plain object (not
// null, not an array) carrying a string run_id — the same guard the service
// reducers use. A parseable active.json that fails it is schema-invalid
// corruption every lever refuses, not a usable state.
function isRunStateShape(value) {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (/** @type {{ run_id?: unknown }} */ (value)).run_id === 'string'
  );
}

const PROJECT_MCP_CONFIGS = Object.freeze([
  ['.mcp.json'],
  ['.cursor', 'mcp.json'],
  ['.vscode', 'mcp.json'],
  ['.claude', 'settings.json'],
  ['.claude', 'settings.local.json'],
  ['.codex', 'config.toml'],
]);

async function providerEvidence(root, relativeFiles, pattern) {
  const found = [];
  for (const relative of relativeFiles) {
    const content = await readFile(join(root, ...relative), 'utf8').catch(() => '');
    if (pattern.test(content)) found.push(relative.join('/'));
  }
  return [...new Set(found)];
}

export function runtimeBundleCandidates(moduleUrl = import.meta.url) {
  return [
    // Bundled execution: doctor.js is inlined into dist/ape-mcp.bundle.mjs.
    new URL('./ape-mcp.bundle.mjs', moduleUrl),
    // Source execution: doctor.js lives at lib/runtime/doctor.js.
    new URL('../../dist/ape-mcp.bundle.mjs', moduleUrl),
  ];
}

export function codexHookManifestCandidates(moduleUrl = import.meta.url) {
  return [
    // Bundled execution: doctor.js is inlined into dist/ape-mcp.bundle.mjs.
    new URL('../hooks/hooks.json', moduleUrl),
    // Source execution: doctor.js lives at lib/runtime/doctor.js.
    new URL('../../hooks/hooks.json', moduleUrl),
  ];
}

function matcherCovers(matcher, toolName) {
  if (matcher === '*') return true;
  if (typeof matcher !== 'string' || matcher.length === 0) return false;
  try {
    // Codex matches the complete flattened tool name. Treating a substring as
    // coverage let `spawn_agent` falsely certify Multi-Agent V2's distinct
    // `collaborationspawn_agent` event while the live hook never ran.
    return new RegExp(`^(?:${matcher})$`).test(toolName);
  } catch {
    return false;
  }
}

function policyGroupsFor(events, eventName) {
  return Array.isArray(events?.[eventName])
    ? events[eventName].filter((group) =>
        Array.isArray(group?.hooks) && group.hooks.some((hook) =>
          typeof hook?.command === 'string' && hook.command.includes('ape-hooks.bundle.mjs')))
    : [];
}

// Static validation of the shipped Codex hook seam. It deliberately does not
// claim the host fired these lifecycle events: the mandatory live binding
// preflight is the authority for that operational capability.
export function validateCodexHookWiring(manifest) {
  const events = manifest?.hooks;
  const pre = policyGroupsFor(events, 'PreToolUse');
  const post = policyGroupsFor(events, 'PostToolUse');
  const start = policyGroupsFor(events, 'SubagentStart');
  const missing = [];
  if (!pre.some((group) => matcherCovers(group.matcher, 'spawn_agent'))) {
    missing.push('PreToolUse spawn_agent matcher');
  }
  if (!pre.some((group) => matcherCovers(group.matcher, 'collaborationspawn_agent'))) {
    missing.push('PreToolUse collaborationspawn_agent matcher');
  }
  if (!post.some((group) => matcherCovers(group.matcher, 'spawn_agent'))) {
    missing.push('PostToolUse spawn_agent matcher');
  }
  if (!post.some((group) => matcherCovers(group.matcher, 'collaborationspawn_agent'))) {
    missing.push('PostToolUse collaborationspawn_agent matcher');
  }
  if (start.length === 0) missing.push('SubagentStart binding hook');
  return missing.length === 0
    ? {
        passed: true,
        detail: 'shipped Codex hook manifest covers legacy spawn_agent, Multi-Agent V2 collaborationspawn_agent, and SubagentStart; operational delivery must still pass the mandatory live binding preflight',
      }
    : {
        passed: false,
        detail: `shipped Codex hook wiring is incomplete: ${missing.join(', ')}`,
      };
}

async function inspectCodexHookWiring(moduleUrl = import.meta.url) {
  for (const candidate of codexHookManifestCandidates(moduleUrl)) {
    try {
      const manifest = JSON.parse(await readFile(candidate, 'utf8'));
      return validateCodexHookWiring(manifest);
    } catch {
      // Source and bundle layouts deliberately use different candidates.
    }
  }
  return {
    passed: false,
    detail: 'cannot read the shipped Codex hooks manifest; spawn_agent binding cannot be verified',
  };
}

// bundle-drift-cannot-see-the-loaded-module: the path comparison further down
// reads FILE BYTES ON DISK on both sides, which cannot observe the one staleness
// that actually matters. The MCP server loads dist/ape-mcp.bundle.mjs once at
// session start; `npm run bundle` then rewrites that same file, BOTH sides of the
// comparison become the new bytes, and the check goes green precisely BECAUSE a
// rebuild happened — while the live process keeps executing the module it loaded
// hours earlier. In the project-root deployment (`node <project>/dist/ape-mcp.bundle.mjs`,
// which is what CLAUDE_PLUGIN_ROOT resolves to for a plugin installed from its
// own checkout) it degenerates completely: the executing bundle IS the project's
// tracked output, so every comparison is a file against ITSELF.
//
// The fix is a fingerprint taken at MODULE LOAD. Reading the executing bundle
// once during module initialization captures what this process is executing;
// every later doctor() call compares that frozen stamp against the file as it is
// NOW, so no rebuild can produce a stale green. A build stamp baked into the
// artifact is deliberately NOT used: the committed bundles are attested
// byte-identical to a plain esbuild build of the sources
// (__tests__/runtime-v2-bundle-freshness.test.js), which no injected build
// identity could survive.
function captureLoadedBundleStamp(candidates) {
  for (const candidate of candidates) {
    try {
      // Stat BEFORE read, and take BOTH size and mtime_ms from that ONE stat:
      // this ordering guarantees ONLY that the recorded hint can never be
      // NEWER than the recorded hash — a same-length rewrite landing between
      // this statSync and this readFileSync can at worst make the HASH
      // describe a state at or after the HINT (forcing loadedBundleDrift's
      // slow hash comparison instead of trusting a stale hint), never a hash
      // strictly OLDER than its own hint (the prior, read-then-stat shape's
      // failure: a hint from the NEW file beside the OLD hash, which let
      // loadedBundleDrift's fast path trust an unchanged hint and never
      // recheck a hash a rebuild had already invalidated). That is the one
      // pairing this ordering closes; a hint match can no longer mask a hash
      // mismatch.
      //
      // It does NOT close the underlying exposure (roadmap entry
      // support-tooling-answers-honestly, absorbing loaded-module-stamp-
      // loader-read-window), which lives entirely OUTSIDE this pair: the ESM
      // loader reads and evaluates this module's own executing bytes (this
      // same file, inlined, under bundled execution) BEFORE this line ever
      // runs, so the code the process is actually running was fixed at that
      // earlier, unobservable read. A same-length rewrite landing at ANY
      // point between the loader's read and this function's own stat/read
      // records a stamp — hint AND hash alike — of bytes at or after what the
      // process loaded, never strictly before it (the loader's read is
      // always first, and a file cannot un-rewrite itself). But "newer, and
      // internally self-consistent" is not "correct": a later doctor() call
      // whose on-disk state still matches that stamp (a hint match, or a
      // hash match on the slow path) reports "no drift" while the running
      // process is genuinely executing the OLDER, never-hashed bytes
      // underneath it — the exact failure acme PR #378 exists to eliminate,
      // reached by a route this ordering cannot see, let alone close.
      //
      // ACCEPTED, not closed: fingerprinting what the loader itself read
      // would require intercepting the loader's own file read (a custom ESM
      // loader hook), a materially larger and riskier change than this
      // diagnostic warrants for a signal that stays INFORMATIONAL only —
      // loadedBundleDrift's one call site never fails health, blocks a run
      // start, or escalates a lane on it. The window is also narrow in
      // practice: it is only reachable by a rewrite racing a fresh process's
      // OWN module load (a rebuild landing in the instant a server is
      // starting up), not by an already-running server merely missing a
      // LATER rebuild — the ordinary case this stamp was added to catch, and
      // does.
      const info = statSync(candidate);
      const bytes = readFileSync(candidate);
      return {
        url: candidate,
        name: basename(fileURLToPath(candidate)),
        size: info.size,
        mtime_ms: info.mtimeMs,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      };
    } catch {
      // Not this candidate (source execution has no sibling bundle, and a
      // checkout with no dist/ has neither); try the next.
    }
  }
  return null;
}

// Captured eagerly, once, at module initialization — the whole point. A lazily
// captured fingerprint would read the file on the first doctor() call, i.e.
// AFTER any mid-session rebuild, and go stale-green exactly like the disk
// comparison it supplements. One read plus one sha256 of the ~700 KB bundle, and
// only in the artifact that carries doctor code (dist/ape-mcp.bundle.mjs).
export const LOADED_BUNDLE_STAMP = captureLoadedBundleStamp(runtimeBundleCandidates());

// The candidate loop above falls back to the project's tracked
// dist/ape-mcp.bundle.mjs even under SOURCE execution (doctor.js evaluated
// directly from lib/runtime/, never inlined into a bundle) — a file this
// process is not executing at all. The stamp is a truthful fingerprint of
// what THIS process loaded only when the resolved candidate IS the module
// doctor.js's own code was loaded from: bundled execution, where
// import.meta.url is already, self-referentially, that same bundle.
// loadedBundleDrift below is gated on this so no notice ever names a bundle
// the process never ran.
const LOADED_BUNDLE_STAMP_IS_EXECUTING = LOADED_BUNDLE_STAMP !== null && LOADED_BUNDLE_STAMP.url.href === import.meta.url;

// Does the executing bundle on disk NOW still hold the bytes this process
// loaded? Cheap first: an unchanged size + mtime pair means the file was never
// rewritten, so the steady state costs one stat and no hashing at all. Only a
// changed stamp pays for a re-read and a hash — which also keeps an idempotent
// rebuild (fresh mtime, identical bytes) from reporting a drift that does not
// exist.
async function loadedBundleDrift(stamp) {
  if (!stamp) return null;
  const info = await stat(stamp.url).catch(() => null);
  // The executing bundle is unreadable or gone: nothing comparable, stay silent.
  if (!info) return null;
  if (info.size === stamp.size && info.mtimeMs === stamp.mtime_ms) return null;
  const bytes = await readFile(stamp.url).catch(() => null);
  if (bytes === null) return null;
  const onDisk = createHash('sha256').update(bytes).digest('hex');
  if (onDisk === stamp.sha256) return null;
  return { loaded_sha256: stamp.sha256, on_disk_sha256: onDisk };
}

// Resolve symlinks so two spellings of one directory (a /var vs /private/var
// temp path, a symlinked plugin install) are not read as two deployments.
async function realDirectory(pathname) {
  try {
    return await realpath(pathname);
  } catch {
    return resolve(pathname);
  }
}

export async function doctor(projectDir, context = {}) {
  const checks = [];
  const add = (name, passed, detail) => checks.push({ name, passed, detail });
  // Run-start preconditions are enforced only when the caller supplies them —
  // ape_run start always does via its input schema. The documented diagnosis
  // call (`ape_config doctor` with no run-start fields) cannot observe host
  // trust or subagent availability itself, so unsupplied preconditions are
  // reported as informational rather than failing.
  const precondition = (name, supplied, passed, detail) => {
    if (supplied) add(name, passed, detail);
    else {
      checks.push({
        name,
        passed: null,
        informational: true,
        detail: `${detail} (run-start precondition; not supplied, verified at ape_run start)`,
      });
    }
  };
  precondition(
    'explicit-invocation',
    'explicit_invocation' in context,
    context.explicit_invocation === true,
    'APE cannot start agents implicitly',
  );
  precondition(
    'trusted-hooks',
    'hooks_trusted' in context,
    context.hooks_trusted === true,
    'host hooks must be reviewed and trusted',
  );
  precondition(
    'native-subagents',
    'subagents_available' in context,
    context.subagents_available === true,
    'native subagents must be available',
  );
  precondition('host', 'host' in context, ['claude', 'codex'].includes(context.host), 'host must be claude or codex');
  if ('tool_claims' in context) {
    checks.push({
      name: 'external-tool-claims',
      passed: true,
      informational: true,
      detail: Array.isArray(context.tool_claims) && context.tool_claims.length
        ? `${context.tool_claims.length} external tool claim(s) will be sealed into every issued ticket`
        : 'no external MCP/editor capabilities requested for this run',
    });
  }
  // Unlike hooks_trusted (a host/operator fact), the package's own hook wiring
  // is locally inspectable. Fail run-start when the shipped matcher cannot see
  // both legacy spawn_agent and Multi-Agent V2's canonical flattened tool;
  // the prior loose matcher proof produced a false green while every live
  // intent stayed unlaunched.
  if (context.host === 'codex') {
    const wiring = await inspectCodexHookWiring();
    checks.push({
      name: 'codex-write-enforcement',
      passed: wiring.passed,
      detail: wiring.detail,
    });
  }
  if (context.behavioral !== false) {
    precondition(
      'test-path-claims',
      'test_paths' in context || 'behavioral' in context,
      Array.isArray(context.test_paths) && context.test_paths.length > 0,
      'behavioral runs must claim authored test paths before the test writer can write',
    );
  }

  const paths = runtimePaths(projectDir);
  try {
    const info = await stat(paths.runtime).catch((error) => {
      if (error?.code === 'ENOENT') return null;
      throw error;
    });
    if (!info) add('state-dir', true, 'no runtime state directory yet (created on first run)');
    else if (!info.isDirectory()) add('state-dir', false, `${paths.runtime} exists but is not a directory`);
    else {
      // A present active.json that parses but is NOT a run state (a non-object
      // like 42, an array, or an object with no string run_id like {}) is the
      // schema-invalid corruption every ape_run lever refuses; reporting the dir
      // "usable" would hide exactly the state needing recovery. A null payload
      // (no active.json, or a literal null) stays usable. Surface it as an
      // advisory diagnosis, not a hard failure — the schema-invalid state is
      // already refused at ape_run start by activeState.
      const active = await readJson(paths.active, null);
      if (active !== null && !isRunStateShape(active)) {
        checks.push({
          name: 'state-dir',
          passed: null,
          informational: true,
          warning: true,
          detail:
            'runtime state directory holds a schema-invalid active.json (valid JSON but not a run state carrying a string run_id); recover with ape_run override reset plus an audit reason before starting',
        });
      } else add('state-dir', true, 'runtime state directory is usable');
    }
  } catch (error) {
    add('state-dir', false, `runtime state is unreadable: ${error.message}`);
  }
  try {
    await loadRuntimeConfig(paths.config);
    add('config-parse', true, 'runtime config parses and merges with shipped defaults');
  } catch (error) {
    add('config-parse', false, `runtime config is invalid: ${error.message}`);
  }
  // F36: a stored override without explicit provenance that matches a default
  // an older release shipped is ambiguous — it may be intentional or a legacy
  // materialized snapshot. Surface it (never fail health for it, and never
  // silently keep or strip it) with the remediation that disambiguates it.
  try {
    const storedConfig = await readJson(paths.config, {});
    const ambiguous = detectAmbiguousConfigOverrides(storedConfig);
    if (ambiguous.length === 0) {
      add('config-override-provenance', true, 'no ambiguous legacy config overrides');
    } else {
      checks.push({
        name: 'config-override-provenance',
        passed: null,
        informational: true,
        warning: true,
        ambiguous_keys: ambiguous.map((entry) => entry.key),
        detail: `ambiguous config overrides match a default shipped by an older release: ${ambiguous
          .map((entry) => `${entry.key}=${JSON.stringify(entry.value)} (default in ${entry.matches_shipped_default_of})`)
          .join('; ')}. If intentional, claim each with ape_config set <key> <value>; otherwise set it to the current default.`,
      });
    }
  } catch {
    // Unreadable config is already reported by config-parse.
  }
  // Foreign-repo onboarding advisory: a project whose gate commands are
  // unconfigured (test_commands.full AND targeted_template both unset) has no
  // grounded suite for APE to run. Surface it as informational guidance toward
  // `ape_config init`, never a hard failure — a fresh foreign repo is not
  // unhealthy, so this must never flip a passing install. Guard config loading
  // like the config-override-provenance check above.
  try {
    const config = await loadRuntimeConfig(paths.config);
    const full = config.test_commands?.full ?? null;
    const targetedTemplate = config.test_commands?.targeted_template ?? null;
    if (full == null && targetedTemplate == null) {
      checks.push({
        name: 'gate-test-commands',
        passed: null,
        informational: true,
        warning: true,
        detail:
          'test_commands.full and test_commands.targeted_template are unset, so APE has no grounded gate commands for this project. Run `ape_config init` to inspect a proposal and apply it.',
      });
    } else {
      add('gate-test-commands', true, 'test_commands gate commands are configured');
    }
  } catch {
    // Unreadable config is already reported by config-parse.
  }
  const unityMarkers = await Promise.all([
    exists(join(paths.root, 'Assets')),
    exists(join(paths.root, 'Packages', 'manifest.json')),
    exists(join(paths.root, 'ProjectSettings', 'ProjectVersion.txt')),
  ]);
  if (unityMarkers.every(Boolean)) {
    checks.push({
      name: 'unity-project',
      passed: true,
      informational: true,
      detail: 'Unity project detected from Assets, Packages/manifest.json, and ProjectSettings/ProjectVersion.txt',
    });
    const unityProviderEvidence = await providerEvidence(paths.root, [
      ['Packages', 'manifest.json'],
      ['Packages', 'packages-lock.json'],
      ...PROJECT_MCP_CONFIGS,
    ], /(?:unity.?mcp|com\.unity\.ai\.assistant|coplay|ivanmurzak|codergamester|mcp.?unity)/i);
    checks.push({
      name: 'unity-mcp-provider',
      passed: unityProviderEvidence.length ? true : null,
      informational: true,
      ...(unityProviderEvidence.length ? {} : { warning: true }),
      detail: unityProviderEvidence.length
        ? `Unity MCP provider evidence found in ${unityProviderEvidence.join(', ')}; live Editor connectivity still requires a low-risk tool probe`
        : 'Unity project detected but no Unity MCP provider configuration was found; repository-only workflows remain available',
    });
  }
  const rootEntries = await readdir(paths.root, { withFileTypes: true }).catch(() => []);
  const blenderProject = rootEntries.some((entry) => entry.isFile() && /\.blend\d*$/i.test(entry.name));
  const blenderProviderEvidence = await providerEvidence(
    paths.root,
    PROJECT_MCP_CONFIGS,
    /(?:blender.?mcp|mcpblender|blender_mcp|uvx\s+blender-mcp)/i,
  );
  if (blenderProject || blenderProviderEvidence.length) {
    checks.push({
      name: 'blender-project',
      passed: blenderProject ? true : null,
      informational: true,
      ...(blenderProject ? {} : { warning: true }),
      detail: blenderProject
        ? 'Blender project detected from a root .blend file'
        : 'Blender MCP configuration detected without a root .blend file yet',
    });
    checks.push({
      name: 'blender-mcp-provider',
      passed: blenderProviderEvidence.length ? true : null,
      informational: true,
      ...(blenderProviderEvidence.length ? {} : { warning: true }),
      detail: blenderProviderEvidence.length
        ? `Blender MCP provider evidence found in ${blenderProviderEvidence.join(', ')}; live Blender connectivity still requires get_scene_info or another low-risk read probe`
        : 'Blender project detected but no Blender MCP provider configuration was found; command profiles remain available',
    });
  }
  const packageJson = await readFile(join(paths.root, 'package.json'), 'utf8').catch(() => '');
  const playwrightConfigs = [
    'playwright.config.ts', 'playwright.config.js', 'playwright.config.mts',
    'playwright.config.mjs', 'playwright.config.cts', 'playwright.config.cjs',
  ];
  const playwrightProject =
    /["']@playwright\/test["']/.test(packageJson) ||
    (await Promise.all(playwrightConfigs.map((file) => exists(join(paths.root, file))))).some(Boolean);
  const playwrightProviderEvidence = await providerEvidence(
    paths.root,
    [...PROJECT_MCP_CONFIGS, ['package.json']],
    /(?:@playwright\/mcp|playwright-mcp)/i,
  );
  if (playwrightProject || playwrightProviderEvidence.length) {
    checks.push({
      name: 'playwright-project',
      passed: playwrightProject ? true : null,
      informational: true,
      ...(playwrightProject ? {} : { warning: true }),
      detail: playwrightProject
        ? 'Playwright project detected from package.json or a playwright.config file'
        : 'Playwright MCP configuration detected without a project test configuration',
    });
    checks.push({
      name: 'playwright-mcp-provider',
      passed: playwrightProviderEvidence.length ? true : null,
      informational: true,
      ...(playwrightProviderEvidence.length ? {} : { warning: true }),
      detail: playwrightProviderEvidence.length
        ? `Playwright MCP provider evidence found in ${playwrightProviderEvidence.join(', ')}; live browser connectivity still requires browser_snapshot or another low-risk read probe`
        : 'Playwright project detected but no Playwright MCP provider configuration was found; CLI and repository-only workflows remain available',
    });
  }
  const githubProviderEvidence = await providerEvidence(
    paths.root,
    PROJECT_MCP_CONFIGS,
    /(?:api\.githubcopilot\.com\/mcp|github-mcp-server|github\/github-mcp-server|\[mcp_servers\.github\])/i,
  );
  if (githubProviderEvidence.length) {
    checks.push({
      name: 'github-mcp-provider',
      passed: true,
      informational: true,
      detail: `GitHub MCP provider evidence found in ${githubProviderEvidence.join(', ')}; APE admits the reviewed read-only GitHub tool surface, while GitHub mutations remain runtime-owned and fail closed during a run`,
    });
  }
  const codexSecurityEvidence = await providerEvidence(
    paths.root,
    PROJECT_MCP_CONFIGS,
    /(?:codex-security|codex_security)/i,
  );
  if (codexSecurityEvidence.length) {
    checks.push({
      name: 'codex-security-mcp-provider',
      passed: true,
      informational: true,
      detail: `Codex Security MCP provider evidence found in ${codexSecurityEvidence.join(', ')}; APE admits triage-result inspection only and keeps scan/remediation state changes fail closed`,
    });
  }
  try {
    const lock = await inspectRunLock(paths.lock);
    if (!lock.present) add('lock-health', true, 'no active-run lock held');
    else if (!lock.readable) {
      add('lock-health', false, 'active-run lock exists but is unreadable; use override reset with an audit reason');
    } else if (lock.stale) {
      add('lock-health', true, `active-run lock for ${lock.run_id ?? 'unknown'} is stale (holder exited); recovered at next run start`);
    } else {
      // A live-held lock is healthy only when a matching active run exists.
      // Without one it is the orphan a crashed start leaves behind: every
      // lever reports 'no active run' while each new start is refused, so
      // doctor blessing it would hide exactly the state needing recovery.
      // The active.json read is explicit (audit 1.13 nit 2): a THROWING read
      // is corrupt state on disk — a different recovery story from an orphan
      // whose active.json was never persisted at all — while ENOENT/absent
      // (readJson's null fallback) keeps the orphan classification below.
      let active = null;
      let activeCorrupt = false;
      try {
        active = await readJson(paths.active, null);
      } catch {
        activeCorrupt = true;
      }
      if (activeCorrupt) {
        add(
          'lock-health',
          false,
          `active-run lock held by ${lock.run_id ?? 'unknown'} beside a corrupt active.json (state exists but cannot be parsed); ` +
            'clear it with ape_run override reset plus an audit reason',
        );
      } else if (!active || active.run_id !== lock.run_id) {
        add(
          'lock-health',
          false,
          `active-run lock held by ${lock.run_id ?? 'unknown'} but no matching active run (orphaned); ` +
            'clear it with ape_run override reset plus an audit reason, or restart the process holding it',
        );
      } else add('lock-health', true, `active-run lock held by ${lock.run_id ?? 'unknown'}`);
    }
  } catch (error) {
    add('lock-health', false, `active-run lock is unreadable: ${error.message}`);
  }
  try {
    await runGit(projectDir, ['rev-parse', '--is-inside-work-tree']);
    add('git-repository', true, 'git repository detected');
  } catch (error) {
    add('git-repository', false, error.message);
  }
  const bundleCandidates = runtimeBundleCandidates();
  const bundleChecks = await Promise.all(bundleCandidates.map((candidate) => exists(candidate)));
  add('runtime-bundle', bundleChecks.some(Boolean), 'bundled MCP runtime is available');
  // friction-18-self-release-gap (findings #18/#11 in
  // .planning/pipeline-friction-2026-07-06.md): the live MCP server and
  // lifecycle hooks execute the INSTALLED plugin's dist/ bundles, so in APE's
  // own repository a session that rebuilds a release keeps running under the
  // OLD runtime — and the live action enum stays stale — until the plugin
  // reloads. Surface that as an informational notice, never a health failure
  // or a run-start block, by comparing the bundle the executing runtime was
  // loaded from against the project's tracked dist/ape-*.bundle.mjs output.
  // Host-neutral by construction (git listing plus byte comparison only), and
  // silent in any project that tracks no APE bundle (every managed non-APE
  // project), in a non-git directory, or when nothing is comparable.
  //
  // This block reports TWO independent dimensions under those same conditions:
  // `bundle-drift` (paths — the installed copy versus the tracked output) and
  // `loaded-module-drift` (the module this process is EXECUTING versus the file
  // on disk now, via LOADED_BUNDLE_STAMP above). Both are informational.
  const executingBundle = bundleCandidates[bundleChecks.indexOf(true)] ?? null;
  if (executingBundle) {
    try {
      const executingDist = new URL('./', executingBundle);
      const trackedNames = (await runGit(projectDir, ['ls-files', '--', 'dist']))
        .split('\n')
        .filter((line) => /^dist\/ape-[^/]+\.bundle\.mjs$/.test(line))
        .map((line) => line.slice('dist/'.length));
      // Which deployment shape is this? The executing bundle INSIDE the governed
      // project is the project-root deployment (the plugin runs the checkout's own
      // dist/ output); outside it is the installed-copy deployment. The two have
      // different recoveries — a server restart versus a plugin reload — so every
      // notice below names the one that applies instead of offering both blindly.
      const executingIsProjectDist =
        (await realDirectory(fileURLToPath(executingDist))) === (await realDirectory(join(projectDir, 'dist')));
      const drifted = [];
      let compared = 0;
      for (const name of trackedNames) {
        const projectBytes = await readFile(join(projectDir, 'dist', name)).catch(() => null);
        const executingBytes = await readFile(new URL(name, executingDist)).catch(() => null);
        if (projectBytes === null || executingBytes === null) continue;
        compared += 1;
        if (!projectBytes.equals(executingBytes)) drifted.push(name);
      }
      if (drifted.length > 0) {
        checks.push({
          name: 'bundle-drift',
          passed: null,
          informational: true,
          detail:
            `executing runtime bundle differs from this repository's tracked dist/ output (${drifted.join(', ')}): ` +
            'the live MCP server and hooks keep running the stale installed bundle, so a rebuilt release cannot be ' +
            'exercised in the session that built it — reload the plugin and verify in a fresh session (friction #18/#11)',
        });
      } else if (compared > 0) {
        // Equal bytes mean two different things. In the installed-copy
        // deployment they are real evidence the installed artifact matches the
        // tracked output; in the project-root deployment the comparison read the
        // SAME FILE twice, so "matches" is a tautology and must not be reported
        // as if it proved the live runtime is current — the loaded-module check
        // below is what covers staleness there.
        add(
          'bundle-drift',
          true,
          executingIsProjectDist
            ? LOADED_BUNDLE_STAMP_IS_EXECUTING
              ? "executing runtime bundle IS this project's own tracked dist/ output (same file on disk), so a byte comparison is vacuous here; loaded-module-drift covers staleness for this deployment"
              : "executing runtime bundle IS this project's own tracked dist/ output (same file on disk), so a byte comparison is vacuous here; this process is running from source and never loaded that bundle, so no dimension here covers staleness for it"
            : 'executing runtime bundle matches the tracked dist/ output',
        );
      }
      // The loaded-module dimension (roadmap entry
      // bundle-drift-cannot-see-the-loaded-module). Gated on the project tracking
      // an APE bundle at all, so every managed non-APE project stays silent — and
      // a non-git directory never reaches here, because its ls-files throws into
      // the catch below. Also gated on LOADED_BUNDLE_STAMP_IS_EXECUTING: under
      // source execution the candidate loop resolves to the project's
      // dist/ape-mcp.bundle.mjs purely as a fallback, never a file this process
      // loaded, so there is nothing truthful this dimension can report there.
      if (trackedNames.length > 0 && LOADED_BUNDLE_STAMP_IS_EXECUTING) {
        const loadedDrift = await loadedBundleDrift(LOADED_BUNDLE_STAMP);
        if (loadedDrift) {
          const short = (hex) => hex.slice(0, 12);
          const stamped =
            `(loaded sha256 ${short(loadedDrift.loaded_sha256)}, on disk now ${short(loadedDrift.on_disk_sha256)})`;
          checks.push({
            name: 'loaded-module-drift',
            passed: null,
            informational: true,
            loaded_sha256: loadedDrift.loaded_sha256,
            on_disk_sha256: loadedDrift.on_disk_sha256,
            detail: executingIsProjectDist
              ? `the live MCP server is executing a STALE runtime module: ${LOADED_BUNDLE_STAMP.name} was rewritten ` +
                `on disk after this process loaded it ${stamped}. The executing bundle IS this project's own tracked ` +
                'dist/ output, so comparing bytes on disk compares that file with itself and can never see this — ' +
                'RESTART the MCP server (end this host session and start a fresh one) so the process loads the ' +
                'rebuilt bundle; until then every runtime change built in this session is inert'
              : `the live MCP server is executing a STALE runtime module: the installed ${LOADED_BUNDLE_STAMP.name} ` +
                `it was loaded from was replaced on disk after this process loaded it ${stamped} — RELOAD the plugin ` +
                'so the host respawns the server from the bundle now on disk; until then the live runtime is still ' +
                'the copy this process started with',
          });
        }
      }
    } catch {
      // Advisory only (friction #18/#11): a non-repo project or an unreadable
      // bundle produces no drift notice and never affects health.
    }
  }
  return { healthy: checks.every((check) => check.informational === true || check.passed === true), checks };
}
