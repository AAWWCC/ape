import {
  DEFAULT_DEADLINES_MS,
  DEFAULT_MODELS,
  GATE_INLINE_GRACE_MS,
  GATE_POLL_RETRY_DELAY_MS,
  GATE_RUNNER_HEARTBEAT_MS,
  GATE_RUNNER_MAX_SPAWNS,
  GATE_RUNNER_STALE_MS,
  LEGACY_SHIPPED_DEFAULTS,
  MAX_REMEDIATION_CYCLES,
  ROLE_POLICIES,
  ROLE_MODEL_OVERRIDES,
  RUNTIME_VERSION,
  CAPABILITY_CATALOG_MAX_EVIDENCE_SCRIPTS,
  CAPABILITY_CATALOG_MAX_RUNNERS,
  CAPABILITY_MANIFEST_MAX_COMMAND_PROFILES,
  CAPABILITY_MANIFEST_MAX_VERIFICATION_PROFILES,
} from './constants.js';
import path from 'node:path';
import { readdir } from 'node:fs/promises';
import { withDirLock } from './lock.js';
import { atomicWriteJson, readJson } from './storage.js';
import { canonicalJson } from './canonical.js';
import { assertSafeDottedKey, assertSafeInput } from './input-guard.js';
import { detectTestRunner, splitCommand } from './runner.js';

export const DEFAULT_CONFIG = Object.freeze({
  version: RUNTIME_VERSION,
  shipping: Object.freeze({
    auto_merge: false,
    provider: 'github',
    required_remote_checks: true,
  }),
  policy: Object.freeze({
    fast_max_files: 6,
    high_risk_security_review: true,
    design_assurance_required: true,
    max_remediation_cycles: MAX_REMEDIATION_CYCLES,
    full_suite_cache: true,
    // Operator lever for the role-aware `<pm> run <script>` evidence gate (see
    // lib/runtime/hooks.js). On a READ-ONLY ticket a bound subagent may
    // run only declared script names: the floor {'test'}, the names derived
    // from the configured test_commands / runners[].profile commands, and
    // these. Ships EMPTY, so an unconfigured install is exactly the derived
    // floor; a writable ticket is unaffected. Each entry is a bare script name
    // matched by EXACT string equality — never a pattern — and set-time
    // validation refuses anything else (assertEvidenceScriptsValue).
    evidence_scripts: Object.freeze([]),
    // Exact, operator-attested batch commands for projects whose verification
    // requires an external editor/toolchain (Unity, Blender, custom generators).
    // Bound agents still face role checks and post-command tree reconciliation;
    // no prefix, glob, or shell-fragment matching is supported.
    command_profiles: Object.freeze([]),
  }),
  deadlines_ms: DEFAULT_DEADLINES_MS,
  models: DEFAULT_MODELS,
  role_models: ROLE_MODEL_OVERRIDES,
  verification: Object.freeze({
    profiles: Object.freeze([]),
  }),
  test_commands: Object.freeze({
    targeted: null,
    // Red-phase per-path command template for runners without native per-file
    // selection (cargo/maven/gradle/rake pick tests by NAME, not path): the
    // `{paths}` placeholder receives the authored test files, e.g.
    // `bundle exec rake test TEST={paths}`. Without it, red-test admission
    // REFUSES on those runners rather than run the whole suite — an unrelated
    // failure must never stand in as proof the authored test is red.
    targeted_template: null,
    // Optional order-shuffle seam for the DOUBLE-RUN red-test admission
    // (red-admission-flake-screen): a `{paths}` command template (mirroring
    // targeted_template) that renders the SECOND admission run only, with a
    // shape the operator ATTESTS varies execution order, e.g.
    // `npx vitest run --sequence.shuffle {paths}`. The runtime never generates
    // shuffling itself — ordering is per-runner knowledge (invariant 6) — and
    // when unset the second run re-executes the first run's exact invocation,
    // so absence provably changes nothing beyond the plain double run.
    targeted_shuffle_template: null,
    // Composable order-shuffle MODIFIER for the DOUBLE-RUN red-test admission
    // (test-command-modifiers): a shell-token string APPENDED to run A's exact
    // invocation to form the SECOND admission run, used only when the fuller
    // targeted_shuffle_template escape hatch above is UNSET. The operator
    // ATTESTS the appended tokens vary execution order (e.g. `--sequence.shuffle`
    // or `-p 'randomize_seed'`); the runtime never generates shuffling itself
    // (invariant 6). targeted_shuffle_template retains precedence — when set the
    // slot neither renders nor tags — and when both are unset run B re-executes
    // run A byte-identically, so an unset slot is byte-identical to today. A run
    // B driven by this slot carries a distinct `shuffle_modifier` marker; a
    // malformed value (one that fails tokenization) refuses admission with a
    // test_commands.shuffle-named error rather than silently admitting.
    shuffle: null,
    // Impacted-test selection for the LOCAL merge gate: a `{paths}` command
    // template (mirroring targeted_template) whose placeholder receives the
    // run's changed production+test files, so the local full-suite check scales
    // with the change instead of the project's age. INVARIANT-9 HARD RULE: it
    // substitutes the LOCAL full suite ONLY when shipping.required_remote_checks
    // !== false — the remote CI full suite stays the true full gate; a no-CI
    // project runs the FULL local suite regardless. Configured-but-unusable
    // (malformed, or an empty changed set) falls back fail-safe to the FULL
    // suite, never to skipping. Framework knowledge lives entirely in this
    // operator-supplied template (host/project agnosticism), e.g.
    // `npx vitest related --run {paths}`.
    impacted_template: null,
    full: null,
    // Serialized variant of `full`, executed on re-gate evaluations (serial re-gate, 2.0.32): a
    // gate block caused by a parallelism race in the project's suite must not
    // burn bounded re-gate attempts re-rolling the identical dice throw. MUST
    // be the SAME suite with a serialized execution shape — the runtime
    // trusts that attestation exactly as it trusts `full`; coverage is
    // operator-attested either way.
    full_serial: null,
    // Composable serialized-execution MODIFIER for the re-gate full suite
    // (test-command-modifiers): a shell-token string APPENDED to `full` on a
    // re-gate evaluation (state.regate_attempts > 0), used only when the fuller
    // full_serial escape hatch above is UNSET. It forms the serialized re-gate
    // command (e.g. `--no-file-parallelism`) and MUST be the same suite in a
    // serialized execution shape — trusted exactly as `full` is. full_serial
    // retains precedence (its whole command replaces `full`, and serialize is
    // not also appended), and the first (non-re-gate) evaluation never composes,
    // so an unset slot is byte-identical to today. The suite cache key hashes the
    // RESOLVED command, so the composed serial can never be cross-answered by the
    // parallel base's pass (invariant 9).
    serialize: null,
  }),
  // Detached merge-gate runner knobs (the 'gating' watch). The VALUES live in
  // constants.js (the single source); this subtree references them so
  // `ape_config set` validates their types at set time and `ape_config get`
  // surfaces the shipped defaults, while gates.js keeps reading
  // config.gates?.<knob> ?? GATE_* so an unset install resolves the constant.
  gates: Object.freeze({
    inline_grace_ms: GATE_INLINE_GRACE_MS,
    heartbeat_ms: GATE_RUNNER_HEARTBEAT_MS,
    stale_ms: GATE_RUNNER_STALE_MS,
    max_spawns: GATE_RUNNER_MAX_SPAWNS,
    poll_retry_delay_ms: GATE_POLL_RETRY_DELAY_MS,
  }),
  // LARP MODE (advisory notification sounds, bin/ape-larp.mjs). Off by
  // default; `subagent` additionally defaults muted because it fires on every
  // subagent exit. `files.<event>` supplies an operator-owned path. Env vars
  // (LARP_MODE, LARP_<EVENT>, LARP_FILE_<EVENT>) outrank config; an optional
  // contained package manifest is the final fallback, and no file is silence.
  notifications: Object.freeze({
    larp: Object.freeze({
      enabled: false,
      events: Object.freeze({
        boot: true,
        ask: true,
        stop: true,
        subagent: false,
        error: true,
        plan: true,
        build: true,
        ship: true,
      }),
      files: Object.freeze({}),
    }),
  }),
  // Statusline wiring cadence (T12). `ape_config wire` writes this into
  // settings.statusLine.refreshInterval — the interval at which the host
  // re-invokes the renderer while the session is idle. Each tick spawns one
  // node plus up to ~3 git processes in every wired project, so the always-on
  // default is 5s rather than 1s; a user who wants the smoothest wall-clock
  // animations sets it back to 1 explicitly (the wire path floors it to an
  // integer >= 1, no upper clamp).
  statusline: Object.freeze({
    refresh_interval_seconds: 5,
  }),
  // Polyglot multi-runner gate config foundation (roadmap:
  // runners-config-validator; spike run-fixture-4255f916cdf7). An array
  // of runner descriptors, each declaring a language/tool runner's `id`, the
  // `owns` globs it claims, its `root`, and a test-command `profile` that reuses
  // the test_commands slot discipline. Ships EMPTY, so an unset install is
  // byte-identical to today; a `set` list is validated whole at set time
  // against RUNNERS_ELEMENT_SHAPE (see assertRunnersValue) and fails LOUDLY
  // rather than persisting a malformed list (invariant 7).
  runners: Object.freeze([]),
});

// Runtime-owned top-level keys in config.json. `version` reports the shipped
// runtime; `explicit_keys` is the override-provenance ledger (F36). Neither is
// a project override: they are stripped before merging and cannot be `set`.
const RESERVED_CONFIG_KEYS = Object.freeze(['version', 'explicit_keys']);

function storedOverrides(configured) {
  if (!configured || typeof configured !== 'object' || Array.isArray(configured)) return {};
  const copy = { ...configured };
  for (const key of RESERVED_CONFIG_KEYS) delete copy[key];
  return copy;
}

function explicitKeyList(configured) {
  const keys =
    configured && typeof configured === 'object' && Array.isArray(configured.explicit_keys)
      ? configured.explicit_keys
      : [];
  return keys.filter((key) => typeof key === 'string' && key.length > 0);
}

function merge(base, override) {
  if (!override || typeof override !== 'object' || Array.isArray(override)) return base;
  const output = { ...base };
  for (const [key, value] of Object.entries(override)) {
    output[key] =
      value && typeof value === 'object' && !Array.isArray(value)
        ? merge(base?.[key] ?? {}, value)
        : value;
  }
  return output;
}

export async function loadRuntimeConfig(configPath) {
  const configured = await readJson(configPath, {});
  assertSafeInput(configured);
  // Runtime-owned metadata never shadows the shipped runtime: `version` from
  // an older release must not misreport, and the provenance ledger is not a
  // configuration value.
  return { ...merge(DEFAULT_CONFIG, storedOverrides(configured)), version: RUNTIME_VERSION };
}

function setNested(object, key, value) {
  const parts = key.split('.');
  const copy = structuredClone(object);
  let cursor = copy;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const part = parts[i];
    // A stored array accepts only numeric-index segments beneath it: a named
    // property lands on the array object but JSON.stringify drops it, so the
    // set would report success while persisting nothing — silent data loss on
    // an ok:true response. Numeric-index sets keep working.
    if (Array.isArray(cursor[part]) && !/^\d+$/.test(parts[i + 1])) {
      throw new Error(`config key ${key}: ${parts.slice(0, i + 1).join('.')} is an array; only numeric indices can be set beneath it`);
    }
    if (!cursor[part] || typeof cursor[part] !== 'object') cursor[part] = {};
    cursor = cursor[part];
  }
  cursor[parts.at(-1)] = value;
  return copy;
}

function deepEqual(a, b) {
  return canonicalJson(a) === canonicalJson(b);
}

function valueAtPath(object, key) {
  let cursor = object;
  for (const part of key.split('.')) {
    if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor) || !(part in cursor)) {
      return undefined;
    }
    cursor = cursor[part];
  }
  return cursor;
}

function hasStoredPath(object, key) {
  return valueAtPath(object, key) !== undefined;
}

// config.json is a sparse overlay of overrides merged over DEFAULT_CONFIG at
// load time. Persisting materialized defaults would freeze them into existing
// installs (shipped-default fixes dead on arrival), so pruning drops every
// stored leaf that matches the current shipped default — which also migrates
// configs fully materialized by earlier `set` versions. A leaf whose key-path
// carries explicit-override provenance (F36) is exempt and persists verbatim,
// even while it equals the shipped default: the operator deliberately chose
// it, and a future default change must not silently repoint it.
function pruneDefaults(override, defaults, explicit = new Set(), prefix = '') {
  if (!override || typeof override !== 'object' || Array.isArray(override)) return override;
  const output = {};
  for (const [key, value] of Object.entries(override)) {
    const keyPath = prefix ? `${prefix}.${key}` : key;
    const fallback = defaults?.[key];
    if (explicit.has(keyPath)) {
      output[key] = value;
    } else if (
      value && typeof value === 'object' && !Array.isArray(value)
      && fallback && typeof fallback === 'object' && !Array.isArray(fallback)
    ) {
      const pruned = pruneDefaults(value, fallback, explicit, keyPath);
      if (Object.keys(pruned).length > 0) output[key] = pruned;
    } else if (!deepEqual(value, fallback)) {
      output[key] = value;
    }
  }
  return output;
}

function expectedTypeName(shape) {
  if (shape === null) return 'a string or null';
  if (typeof shape === 'object') return 'an object';
  return `a ${typeof shape}`;
}

// Shipped-empty array slots whose `[]` default carries no element shape for
// assertValueMatchesShape to recurse into (shape[0] is undefined, which
// validates NOTHING). Keyed by full dotted config path and consulted at the TOP
// of assertValueMatchesShape, so the assertion fires on every route that can
// persist the slot: an exact-key `set`, and an ancestor object `set` that
// reaches it through the object recursion (`ape_config set policy '{...}'`).
// The remaining route — a numeric-index `set` beneath the array — is already
// refused by assertValueMatchesDefaults' scalar-leaf guard. A per-path table
// rather than an inline key comparison is what makes routes 1 and 2 share one
// assertion; a check placed only in assertValueMatchesDefaults is bypassable.
// A Map, not an object literal: the lookup key is operator-supplied, and a
// plain-object lookup would resolve `constructor`/`toString` to an inherited
// function and silently skip validation.
const PATH_VALUE_ASSERTIONS = new Map([
  ['policy.max_remediation_cycles', assertMaxRemediationCyclesValue],
  ['policy.evidence_scripts', assertEvidenceScriptsValue],
  ['policy.command_profiles', assertCommandProfilesValue],
  ['verification.profiles', assertVerificationProfilesValue],
]);

function assertMaxRemediationCyclesValue(key, value) {
  if (!Number.isInteger(value) || value < 1 || value > 10) {
    throw new Error(`config key ${key} must be an integer from 1 through 10`);
  }
}

function assertVerificationProfilesValue(key, value) {
  if (!Array.isArray(value) || value.length > CAPABILITY_MANIFEST_MAX_VERIFICATION_PROFILES) {
    throw new Error(`config key ${key} expects at most ${CAPABILITY_MANIFEST_MAX_VERIFICATION_PROFILES} verification profile objects`);
  }
  const ids = new Set();
  value.forEach((profile, index) => {
    const itemKey = `${key}[${index}]`;
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
      throw new Error(`config key ${itemKey} expects a verification profile object`);
    }
    const allowed = new Set(['id', 'description', 'command', 'root', 'timeout_ms']);
    const extras = Object.keys(profile).filter((field) => !allowed.has(field));
    if (extras.length > 0) throw new Error(`config key ${itemKey} has unknown fields: ${extras.join(', ')}`);
    if (typeof profile.id !== 'string' || !/^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(profile.id)) {
      throw new Error(`config key ${itemKey}.id expects a stable verification profile identifier`);
    }
    if (ids.has(profile.id)) throw new Error(`config key ${key} has duplicate verification profile id ${profile.id}`);
    ids.add(profile.id);
    if (typeof profile.description !== 'string' || !profile.description.trim() || profile.description.length > 500) {
      throw new Error(`config key ${itemKey}.description expects non-blank text of at most 500 characters`);
    }
    if (typeof profile.command !== 'string' || !profile.command.trim() || profile.command.length > 8192) {
      throw new Error(`config key ${itemKey}.command expects one exact non-empty command`);
    }
    if (/[\r\n\0;&|<>`$]/.test(profile.command)) {
      throw new Error(`config key ${itemKey}.command must be shell-free exact argv`);
    }
    let argv;
    try { argv = splitCommand(profile.command); } catch (error) {
      throw new Error(`config key ${itemKey}.command is invalid: ${error.message}`);
    }
    if (argv.length === 0) throw new Error(`config key ${itemKey}.command must contain an executable`);
    if (profile.root !== undefined) {
      if (
        typeof profile.root !== 'string' || !profile.root || profile.root.includes('\\') ||
        path.posix.isAbsolute(profile.root) || /^[A-Za-z]:\//.test(profile.root) ||
        path.posix.normalize(profile.root) !== profile.root ||
        profile.root === '..' || profile.root.startsWith('../')
      ) {
        throw new Error(`config key ${itemKey}.root must be a contained project-relative POSIX root`);
      }
    }
    if (!Number.isInteger(profile.timeout_ms) || profile.timeout_ms < 1 || profile.timeout_ms > 86_400_000) {
      throw new Error(`config key ${itemKey}.timeout_ms must be an integer from 1 through 86400000`);
    }
  });
}

// `policy.evidence_scripts` is read by the hook on every bound-subagent Bash
// event of every later run, so a type-invalid value detonates far from the set:
// it must fail LOUDLY here and persist nothing (invariant 7). Each entry is a
// bare script name in the same grammar the hook's run-script derivation
// captures — a pattern-shaped entry (`.*`, `test|validate`) is refused rather
// than stored, because membership is exact-string and such an entry could never
// match. A LEADING `-` is refused for the same reason the hook's RUN_SCRIPT_NAME
// refuses one: `npm run --silent validate` has npm consume `--silent` as config
// and run `validate`, while the gate checked the token `--silent`, so declaring
// a flag as a "script name" would admit an invocation of a never-checked script.
const EVIDENCE_SCRIPT_NAME = /^[\w:@./][\w:@./-]*$/;

export function assertEvidenceScriptsValue(key, value) {
  if (!Array.isArray(value) || value.length > CAPABILITY_CATALOG_MAX_EVIDENCE_SCRIPTS) {
    throw new Error(`config key ${key} expects an array of at most ${CAPABILITY_CATALOG_MAX_EVIDENCE_SCRIPTS} package-script names; got ${JSON.stringify(value)}`);
  }
  value.forEach((element, index) => {
    if (typeof element !== 'string' || !EVIDENCE_SCRIPT_NAME.test(element)) {
      throw new Error(`config key ${key}[${index}] expects a non-empty package-script name matching ${EVIDENCE_SCRIPT_NAME.source}; got ${JSON.stringify(element)}`);
    }
  });
}

const COMMAND_PROFILE_EFFECTS = new Set(['read', 'write', 'execute']);

function assertCommandProfilesValue(key, value) {
  if (!Array.isArray(value) || value.length > CAPABILITY_MANIFEST_MAX_COMMAND_PROFILES) {
    throw new Error(`config key ${key} expects an array of at most ${CAPABILITY_MANIFEST_MAX_COMMAND_PROFILES} command profile objects; got ${JSON.stringify(value)}`);
  }
  const ids = new Set();
  value.forEach((profile, index) => {
    const itemKey = `${key}[${index}]`;
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
      throw new Error(`config key ${itemKey} expects an object`);
    }
    const allowed = new Set(['id', 'command', 'roles', 'effect']);
    const extras = Object.keys(profile).filter((field) => !allowed.has(field));
    if (extras.length) throw new Error(`config key ${itemKey} has unknown fields: ${extras.join(', ')}`);
    if (typeof profile.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(profile.id)) {
      throw new Error(`config key ${itemKey}.id expects a stable identifier`);
    }
    if (ids.has(profile.id)) throw new Error(`config key ${key} has duplicate profile id ${JSON.stringify(profile.id)}`);
    ids.add(profile.id);
    if (
      typeof profile.command !== 'string' ||
      profile.command.length === 0 ||
      profile.command.length > 8192 ||
      /[\r\n\0]/.test(profile.command)
    ) {
      throw new Error(`config key ${itemKey}.command expects one non-empty, single-line command of at most 8192 characters`);
    }
    if (
      !Array.isArray(profile.roles) ||
      profile.roles.length === 0 ||
      profile.roles.some((role) => typeof role !== 'string' || !(role in ROLE_POLICIES))
    ) {
      throw new Error(`config key ${itemKey}.roles expects a non-empty array of known APE role names`);
    }
    if (!COMMAND_PROFILE_EFFECTS.has(profile.effect)) {
      throw new Error(`config key ${itemKey}.effect expects read, write, or execute`);
    }
  });
}

function assertValueMatchesShape(key, value, shape) {
  const pathAssertion = PATH_VALUE_ASSERTIONS.get(key);
  if (pathAssertion) {
    pathAssertion(key, value);
    return;
  }
  if (shape === null) {
    // The null defaults (test_commands.*) are "no command configured" slots
    // that hold shell command strings when set.
    if (value !== null && typeof value !== 'string') {
      throw new Error(`config key ${key} expects a string or null; got ${JSON.stringify(value)}`);
    }
    return;
  }
  if (typeof shape === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`config key ${key} expects a finite number; got ${JSON.stringify(value)}`);
    }
    return;
  }
  if (typeof shape === 'boolean' || typeof shape === 'string') {
    if (typeof value !== typeof shape) {
      throw new Error(`config key ${key} expects ${expectedTypeName(shape)}; got ${JSON.stringify(value)}`);
    }
    return;
  }
  if (Array.isArray(shape)) {
    // An array shape (e.g. a runner's `owns: ['']`) asserts the value is an
    // array and validates EACH element against the single element shape at
    // shape[0] (recurse). owns' element shape is the empty string, so every
    // entry must be a string; a `[]` shape carries no element shape and leaves
    // elements unchecked, which is why `runners` is special-cased in
    // assertValueMatchesDefaults rather than validated through its `[]` default.
    if (!Array.isArray(value)) {
      throw new Error(`config key ${key} expects an array; got ${JSON.stringify(value)}`);
    }
    const elementShape = shape[0];
    value.forEach((element, index) => {
      assertValueMatchesShape(`${key}[${index}]`, element, elementShape);
    });
    return;
  }
  if (typeof shape === 'object' && !Array.isArray(shape)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`config key ${key} expects ${expectedTypeName(shape)}; got ${JSON.stringify(value)}`);
    }
    // Recurse over the value's KNOWN leaves only: extra keys under a known
    // subtree (a new model tier, an operator annotation) carry no shipped
    // shape and stay legal.
    for (const [childKey, childValue] of Object.entries(value)) {
      if (childKey in shape) {
        assertValueMatchesShape(`${key}.${childKey}`, childValue, shape[childKey]);
      }
    }
  }
}

// `runners` (roadmap: runners-config-validator) is the config foundation for
// the polyglot multi-runner gate. It ships EMPTY, so DEFAULT_CONFIG.runners
// carries no element from which to derive a per-element shape; this constant IS
// that shape. Each element is an object with a non-empty string `id`, a
// non-empty `owns` array of glob strings (its [''] element shape asserts each
// glob is a string), a string `root`, and a `profile` that reuses the existing
// test_commands string|null slot discipline — so a runner declares its own gate
// commands (invariant 6) with exactly the shape the runtime already validates.
const RUNNERS_ELEMENT_SHAPE = Object.freeze({
  id: '',
  owns: [''],
  root: '',
  profile: DEFAULT_CONFIG.test_commands,
});

// Whole-list set-time validation for `runners`, mirroring the deadlines_ms
// set-time discipline: a malformed list fails LOUDLY here with a `runner`-named
// error and never persists (invariant 7). The per-element shape check
// (RUNNERS_ELEMENT_SHAPE) covers object-ness, `id`/`root` string typing, `owns`
// as an array of strings, and each `profile` slot's string|null discipline; the
// list-level invariants a shape cannot express are enforced directly here — a
// non-empty `id`, a non-empty `owns` list, and `id`s unique across the list.
export function assertRunnersValue(key, value) {
  if (!Array.isArray(value) || value.length > CAPABILITY_CATALOG_MAX_RUNNERS) {
    throw new Error(`config key ${key} expects an array of at most ${CAPABILITY_CATALOG_MAX_RUNNERS} runner objects; got ${JSON.stringify(value)}`);
  }
  const seenIds = new Set();
  value.forEach((element, index) => {
    const elementKey = `${key}[${index}]`;
    assertValueMatchesShape(elementKey, element, RUNNERS_ELEMENT_SHAPE);
    if (typeof element.id !== 'string' || element.id.length === 0) {
      throw new Error(`config key ${elementKey} expects a non-empty string runner id; got ${JSON.stringify(element.id)}`);
    }
    if (!Array.isArray(element.owns) || element.owns.length === 0) {
      throw new Error(`config key ${elementKey} expects a non-empty owns array of glob strings for runner ${JSON.stringify(element.id)}`);
    }
    if (seenIds.has(element.id)) {
      throw new Error(`config key ${key} has a duplicate runner id ${JSON.stringify(element.id)}`);
    }
    seenIds.add(element.id);
  });
}

// `set` validates the value against the DEFAULT_CONFIG shape at the key path:
// a type-invalid value for a known key must fail loudly AT SET TIME. Stored,
// `deadlines_ms.fast: "30m"` passes doctor, then the next fast start throws
// RangeError in the ticket deadline math AFTER acquire_lock and before
// persist_state — wedging the run lock with no active run to abort (invariant
// 7). Keys outside the defaults tree (custom.*, extra tiers) carry no shipped
// shape and pass unvalidated.
function assertValueMatchesDefaults(key, value) {
  const parts = key.split('.');
  let node = DEFAULT_CONFIG;
  for (let i = 0; i < parts.length; i += 1) {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) {
      // A known scalar leaf has no children: a value buried beneath it would
      // shadow the shaped value with an object the runtime never reads.
      throw new Error(`config key ${key}: ${parts.slice(0, i).join('.')} is ${expectedTypeName(node)} leaf and cannot hold nested key ${parts[i]}`);
    }
    if (!(parts[i] in node)) return;
    node = node[parts[i]];
  }
  // `runners` ships as an empty array, so its DEFAULT_CONFIG node carries no
  // element shape to recurse into; validate a whole-list `set` against the
  // dedicated runner-element shape plus the list-level invariants.
  if (key === 'runners') {
    assertRunnersValue(key, value);
    return;
  }
  assertValueMatchesShape(key, value, node);
}

// Config-store lock cadence (audit 1.10, invariant 7). The critical section is
// one read-merge-write of config.json — milliseconds, never a gate run — so it
// gets its OWN lock (`<configPath>.lock`) riding the shared withDirLock helper
// rather than the receipt-effects lock: that lock is legitimately held for a
// whole full-suite gate run, and an operator `ape_config set` must not spuriously
// report busy for minutes behind it. Staleness/heartbeat/busy mirror the
// receipt-effects cadence so a genuinely dead holder is stolen the same way (F9).
const CONFIG_LOCK_STALE_MS = 60_000;
const CONFIG_LOCK_HEARTBEAT_MS = 15_000;
const CONFIG_LOCK_BUSY_MS = 15_000;

export async function setRuntimeConfig(configPath, key, value) {
  assertSafeDottedKey(key);
  if (RESERVED_CONFIG_KEYS.includes(key.split('.')[0])) {
    throw new Error(`config key ${key.split('.')[0]} is runtime-owned and cannot be set`);
  }
  assertSafeInput(value);
  assertValueMatchesDefaults(key, value);
  // Serialized read-modify-write (audit 1.10, invariant 7): the bare
  // readJson -> merge -> atomicWriteJson let two concurrent setters read the
  // same stored base, so the last atomic write silently dropped the other
  // setter's key AND its explicit_keys provenance entry while both calls
  // returned ok. The lock lives HERE, not in the callers, so every writer of
  // the store — `ape_config set` (service.js) and each slot the
  // `ape_config init --apply` per-slot loop persists through this function —
  // rides the same serialization. Validation above stays outside the lock: an
  // invalid set never contends for the store.
  return withDirLock(
    `${configPath}.lock`,
    async () => {
      const storedRaw = await readJson(configPath, {});
      assertSafeInput(storedRaw);
      const stored = storedOverrides(storedRaw);
      // Explicit-override provenance (F36): record every key-path an operator
      // deliberately set, so a stored value can always be distinguished from a
      // default materialized by an older release. Keys whose values no longer
      // exist on disk (e.g. replaced by a later set of an ancestor) drop out.
      const explicit = new Set([...explicitKeyList(storedRaw), key]);
      const overrides = pruneDefaults(setNested(stored, key, value), DEFAULT_CONFIG, explicit);
      const explicitKeys = [...explicit].filter((entry) => hasStoredPath(overrides, entry)).sort();
      if (explicitKeys.length > 0) overrides.explicit_keys = explicitKeys;
      await atomicWriteJson(configPath, overrides);
      return { ...merge(DEFAULT_CONFIG, storedOverrides(overrides)), version: RUNTIME_VERSION };
    },
    {
      staleMs: CONFIG_LOCK_STALE_MS,
      heartbeatMs: CONFIG_LOCK_HEARTBEAT_MS,
      busyMs: CONFIG_LOCK_BUSY_MS,
      serializeLocal: true,
      busyMessage: 'the config store is busy; retry the config set',
    },
  );
}

function flattenLeaves(node, prefix = '', out = []) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) {
    if (prefix) out.push([prefix, node]);
    return out;
  }
  for (const [key, value] of Object.entries(node)) {
    flattenLeaves(value, prefix ? `${prefix}.${key}` : key, out);
  }
  return out;
}

// Versioned detection of legacy materialized defaults (F36). A stored leaf
// that (a) carries no explicit-override provenance, (b) differs from the
// current shipped default, and (c) exactly matches a default some earlier
// release shipped, is ambiguous: it may be an intentional override or a
// snapshot an old `set` materialized. The runtime must not guess — pruning
// keeps it (never strip possible intent) and doctor surfaces it so the
// operator can claim it with an explicit `config set` (which records
// provenance and disambiguates it permanently).
export function detectAmbiguousConfigOverrides(storedRaw) {
  const explicit = new Set(explicitKeyList(storedRaw));
  const ambiguous = [];
  for (const [key, value] of flattenLeaves(storedOverrides(storedRaw))) {
    const parts = key.split('.');
    const claimed = parts.some((_, index) => explicit.has(parts.slice(0, index + 1).join('.')));
    if (claimed) continue;
    const current = valueAtPath(DEFAULT_CONFIG, key);
    if (current !== undefined && deepEqual(value, current)) continue;
    for (const snapshot of LEGACY_SHIPPED_DEFAULTS) {
      const legacy = valueAtPath(snapshot.defaults, key);
      if (legacy !== undefined && deepEqual(value, legacy)) {
        ambiguous.push({ key, value, matches_shipped_default_of: snapshot.version });
        break;
      }
    }
  }
  return ambiguous;
}

export function resolveModel(config, host, tier, role = null) {
  const override = role ? config.role_models?.[role]?.[host] : null;
  const selected = override?.model ? override : config.models?.[host]?.[tier];
  if (!selected?.model) throw new Error(`no ${host} model mapping configured for tier ${tier}`);
  return selected;
}

// The eight nullable test_commands slots onboarding (`ape_config init`) may
// propose and persist — exactly the sparse slots in DEFAULT_CONFIG, derived
// here so the whitelist can never drift from the shipped shape. This includes
// the two composable modifier slots (serialize/shuffle): recognized runners now
// propose them in DRY flag form (onboarding-modifier-proposals), and they stay
// in the whitelist so an explicit apply can persist them.
const ONBOARDING_SLOTS = Object.freeze(Object.keys(DEFAULT_CONFIG.test_commands));

// Fixed, host-neutral decision table for a recognized JavaScript runner. Each
// entry maps the whitelisted slots to grounded commands. `{paths}` in a
// targeted_template is the red-phase per-path placeholder (see runner.js). A
// runner without a serialized shape simply omits full_serial. The `serialize`
// and `shuffle` entries are the DRY composable-modifier flag forms — the tokens
// the runtime APPENDS to `full` (serialize) or run-A (shuffle), never a second
// runner invocation — proposed only where the runner grounds one. These strings
// are literal and platform-independent — `npx` resolves the local binary on
// every OS (win32 batch quoting is applied later in buildSpawnPlan) — so the
// proposal never embeds process.platform.
//
// CONSEQUENCE FOR THE READ-ONLY EVIDENCE TIER. Every command here is
// `npx`-headed, and ONBOARDING_SLOTS covers test_commands only, so for every JS
// project onboarded by `ape_config init` the hook's anchored `<pm> run <script>`
// derivation (docs/hooks.md) finds nothing and the read-only tier collapses to
// its floor `{test}`. That is fail-closed, and the `npx` forms proposed here are
// themselves recognized evidence — but the host-neutrality argument for the
// derivation ("a project whose suite is `npm run spec` runs it unconfigured")
// holds only for a hand-configured `<pm> run` command; an init-onboarded project
// widens the tier through `policy.evidence_scripts` instead.
const JS_RUNNER_TABLE = Object.freeze({
  vitest: {
    targeted_template: 'npx vitest run {paths}',
    full: 'npx vitest run',
    full_serial: 'npx vitest run --no-file-parallelism',
    serialize: '--no-file-parallelism',
    shuffle: '--sequence.shuffle',
  },
  jest: {
    targeted_template: 'npx jest {paths}',
    full: 'npx jest',
    full_serial: 'npx jest --runInBand',
    serialize: '--runInBand',
  },
  mocha: {
    targeted_template: 'npx mocha {paths}',
    full: 'npx mocha',
  },
  ava: {
    targeted_template: 'npx ava {paths}',
    full: 'npx ava',
    full_serial: 'npx ava --serial',
    serialize: '--serial',
  },
  playwright: {
    targeted_template: 'npx playwright test {paths}',
    full: 'npx playwright test',
    full_serial: 'npx playwright test --workers=1',
    serialize: '--workers=1',
  },
});

// First-match precedence for recognizing a JavaScript runner from package.json.
const JS_RUNNER_ORDER = Object.freeze(['vitest', 'jest', 'mocha', 'ava', 'playwright']);

// The dependency package names that identify each runner. playwright ships its
// test runner as `@playwright/test`; the others match their bare name.
const JS_RUNNER_DEP_NAMES = Object.freeze({
  vitest: ['vitest'],
  jest: ['jest'],
  mocha: ['mocha'],
  ava: ['ava'],
  playwright: ['playwright', '@playwright/test'],
});

// Recognize a JavaScript runner from a package.json manifest, in fixed
// precedence order: RUNNER ORDER wins first (vitest > jest > mocha > ava >
// playwright — the loop returns the earliest runner recognized through ANY
// source, so a later runner's devDependency never outranks an earlier
// runner's scripts.test mention), and only within a single runner does a
// declared devDependency outrank a dependency outrank a bare scripts.test
// mention — that within-runner ranking shapes nothing but the rationale
// `source` token. Returns the runner name plus the grounding source for a
// machine-readable rationale, or null when no runner is recognized. Reads
// only the manifest — no env, no platform, no timestamps.
function recognizeJsRunner(pkg) {
  if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) return null;
  const devDeps = pkg.devDependencies && typeof pkg.devDependencies === 'object' ? pkg.devDependencies : {};
  const deps = pkg.dependencies && typeof pkg.dependencies === 'object' ? pkg.dependencies : {};
  const script = typeof pkg.scripts?.test === 'string' ? pkg.scripts.test : '';
  for (const name of JS_RUNNER_ORDER) {
    const aliases = JS_RUNNER_DEP_NAMES[name];
    if (aliases.some((dep) => Object.prototype.hasOwnProperty.call(devDeps, dep))) return { name, source: 'devdep' };
    if (aliases.some((dep) => Object.prototype.hasOwnProperty.call(deps, dep))) return { name, source: 'dep' };
    // A whole-word mention in the test script (e.g. "vitest run"), never a
    // substring of another token ("java" must not match "ava").
    if (new RegExp(`(^|[^\\w-])${name}([^\\w-]|$)`).test(script)) return { name, source: 'script' };
  }
  return null;
}

// Non-JS manifest families recognized by detectTestRunner (FAMILY only — its
// command/args descriptor embeds process.platform, so it must never shape a
// proposal string). Each maps to grounded commands; cargo/go cannot path-scope
// their selection (they pick tests by NAME, not file path), so those never get
// a targeted_template. `serialize` is the DRY flag form appended to `full`; for
// pytest it disables the randomly and xdist plugins so a re-gate run executes
// deterministically — the pytest-xdist serialize gap this table now closes.
const NON_JS_FAMILY_TABLE = Object.freeze({
  'python-uv': {
    rationale: 'detected-uv-lock',
    targeted_template: 'uv run pytest {paths}',
    full: 'uv run pytest',
    serialize: '-p no:randomly -p no:xdist',
  },
  python: {
    rationale: 'detected-pytest-manifest',
    targeted_template: 'python -m pytest {paths}',
    full: 'python -m pytest',
    serialize: '-p no:randomly -p no:xdist',
  },
  go: {
    rationale: 'detected-go-module',
    full: 'go test ./...',
  },
  rust: {
    rationale: 'detected-cargo-manifest',
    full: 'cargo test',
  },
});

// The grounded, path/env-neutral command slots a decision-table entry may
// carry — the exact set the root proposal and every per-subdir runner profile
// draw from. A bare test script grounds only a whole-suite wrapper.
const PROFILE_SLOTS = Object.freeze(['targeted_template', 'full', 'full_serial', 'serialize', 'shuffle']);
const TEST_SCRIPT_TABLE = Object.freeze({ full: 'npm test' });

// Map a detected family token to its grounded decision-table entry (the flat
// slot strings), or null for an unrecognized family. JS runner names key
// JS_RUNNER_TABLE, detectTestRunner's non-JS families key NON_JS_FAMILY_TABLE,
// and the bare-script sentinel maps to the whole-suite wrapper.
function runnerProfileTable(family) {
  if (Object.prototype.hasOwnProperty.call(JS_RUNNER_TABLE, family)) return JS_RUNNER_TABLE[family];
  if (Object.prototype.hasOwnProperty.call(NON_JS_FAMILY_TABLE, family)) return NON_JS_FAMILY_TABLE[family];
  if (family === 'test-script') return TEST_SCRIPT_TABLE;
  return null;
}

// Shared single-directory runner detection — the ONE code path root onboarding
// (proposeTestCommands) and per-subdir polyglot detection (proposeRunners) both
// walk, so they can never drift. Precedence is first-match: a package.json
// recognized JS runner outranks detectTestRunner's non-JS FAMILY (read ONLY its
// platform-independent `.runner` field, never its platform-shaped command/args)
// outranks a bare scripts.test. Returns { family, source } — the family token
// keying the decision tables plus the fully-formed rationale token — or null
// when no runner is recognized. Reads only the directory's own manifests: no
// env, no platform, no timestamps.
async function detectRunnerAt(dir) {
  let pkg = null;
  try {
    pkg = await readJson(path.join(dir, 'package.json'), null);
  } catch {
    // A malformed manifest is not a confident runner signal.
    pkg = null;
  }
  const jsRunner = recognizeJsRunner(pkg);
  if (jsRunner) return { family: jsRunner.name, source: `detected-${jsRunner.name}-${jsRunner.source}` };
  // FAMILY recognition only. When package.json carries a scripts.test this
  // returns the 'javascript' family (not in NON_JS_FAMILY_TABLE), which falls
  // through to the bare-script branch, so the non-JS branch fires only for
  // genuine non-JS repos.
  const family = (await detectTestRunner(dir)).runner;
  const nonJs = NON_JS_FAMILY_TABLE[family];
  if (nonJs) return { family, source: nonJs.rationale };
  if (typeof pkg?.scripts?.test === 'string' && pkg.scripts.test.trim()) {
    // A bare test script with no recognized runner: only a whole-suite wrapper
    // is grounded — `npm test` forwards to the project's own script.
    return { family: 'test-script', source: 'detected-test-script' };
  }
  return null;
}

// Directories a polyglot traversal never descends into or treats as a runner
// root: dependency, build, cache, and VCS artifacts. Frozen denylist; any
// dotdir is additionally excluded. Deterministic — no env, no platform.
const IGNORED_DIRS = Object.freeze(new Set([
  'node_modules', '.git', '.hg', '.svn', '.ape', 'dist', 'build', 'out',
  'coverage', 'target', '.venv', 'venv', 'env', '__pycache__', '.next',
  '.cache', 'vendor',
]));
const RUNNERS_MAX_DEPTH = 3;
const RUNNERS_MAX_CANDIDATES = 64;

// Deterministic slug for a runner descriptor id: lowercase, every run of
// non-[a-z0-9] collapses to a single '-', trimmed; the repo root ('.') and any
// otherwise-empty slug become 'root'. Collisions are disambiguated by the
// caller in sorted-root order.
function slugForRoot(root) {
  const slug = root
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');
  return slug || 'root';
}

// The flat test_commands-shaped profile (plain string|null slots per
// RUNNERS_ELEMENT_SHAPE — never the {value, rationale} proposal wrapper) for a
// detected family, drawn only from the grounded PROFILE_SLOTS and excluding the
// tables' internal `rationale` bookkeeping.
function runnerProfile(family) {
  const table = runnerProfileTable(family);
  const profile = {};
  if (!table) return profile;
  for (const slot of PROFILE_SLOTS) {
    if (table[slot]) profile[slot] = table[slot];
  }
  return profile;
}

// Deterministic polyglot runner proposal. Performs a bounded, sorted pre-order
// DFS from the project root (directories only; the IGNORED_DIRS denylist and any
// dotdir are pruned; depth capped at RUNNERS_MAX_DEPTH, total candidates capped
// at RUNNERS_MAX_CANDIDATES), running detectRunnerAt at every candidate incl. the
// root at depth 0. A tree with FEWER THAN TWO distinct runner families is not
// polyglot and yields [] (so a single-runner tree is byte-identical to today).
// Otherwise it returns one { id, owns, root, profile } descriptor per detected
// runner root, SORTED by POSIX-relative root ascending, with deterministic slug
// ids (collisions suffixed '-2','-3' in sorted-root order). Fully deterministic:
// no process.platform, env, Date, or Math.random; readdir order is normalized by
// an explicit code-point sort.
export async function proposeRunners(projectDir) {
  const candidates = [];
  const walk = async (dir, rel, depth) => {
    if (candidates.length >= RUNNERS_MAX_CANDIDATES) return;
    candidates.push({ dir, rel });
    if (depth >= RUNNERS_MAX_DEPTH) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      // An unreadable directory contributes no candidates.
      return;
    }
    const names = entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && !IGNORED_DIRS.has(entry.name))
      .map((entry) => entry.name)
      .sort();
    for (const name of names) {
      if (candidates.length >= RUNNERS_MAX_CANDIDATES) break;
      await walk(path.join(dir, name), rel ? `${rel}/${name}` : name, depth + 1);
    }
  };
  await walk(projectDir, '', 0);

  const detected = [];
  for (const candidate of candidates) {
    const runner = await detectRunnerAt(candidate.dir);
    if (runner) detected.push({ root: candidate.rel === '' ? '.' : candidate.rel, family: runner.family });
  }

  const distinctFamilies = new Set(detected.map((entry) => entry.family));
  if (distinctFamilies.size < 2) return [];

  const sorted = [...detected].sort((a, b) => (a.root < b.root ? -1 : a.root > b.root ? 1 : 0));
  const allRoots = sorted.map((entry) => entry.root);
  // child is strictly inside parent: the repo root ('.') contains every non-root
  // path; otherwise child must sit under `parent/`. A shared-prefix sibling
  // (`apix` vs `api`) is NOT a descendant.
  const isStrictDescendant = (child, parent) =>
    child !== parent && (parent === '.' ? true : child.startsWith(`${parent}/`));
  const usedIds = new Set();
  const runners = [];
  for (const entry of sorted) {
    const base = slugForRoot(entry.root);
    let id = base;
    let suffix = 2;
    while (usedIds.has(id)) {
      id = `${base}-${suffix}`;
      suffix += 1;
    }
    usedIds.add(id);
    // Own this runner's own subtree ('**' at the repo root), MINUS every
    // more-specific sub-runner's subtree ('!child/**') so a broad runner never
    // swallows a subdir runner's files and fires a WRONG-TOOLCHAIN vacuous run
    // (union ownership would otherwise route those files to both). Only the
    // TOPMOST descendant boundaries are carved (a descendant already inside
    // another carved descendant is redundant), keeping the proposal minimal and
    // deterministic. Union ownership across EXPLICIT operator configs is
    // untouched — the carve-outs live only on this auto proposal.
    const baseGlob = entry.root === '.' ? '**' : `${entry.root}/**`;
    const descendants = allRoots.filter((root) => isStrictDescendant(root, entry.root));
    const carveouts = descendants
      .filter((root) => !descendants.some((other) => other !== root && isStrictDescendant(root, other)))
      .sort()
      .map((root) => `!${root}/**`);
    const owns = [baseGlob, ...carveouts];
    runners.push({ id, owns, root: entry.root, profile: runnerProfile(entry.family) });
  }
  return runners;
}

// Deterministic foreign-repo onboarding proposal. Inspects only the project's
// own manifests — package.json (scripts.test + dev/dependencies) for a
// JavaScript runner, then detectTestRunner's FAMILY for a non-JS manifest
// (pytest/uv/go/cargo), then a bare scripts.test as a last resort — via the
// shared detectRunnerAt precedence, and maps the detected fact to grounded gate
// commands through the fixed decision tables above. A recognized JS runner
// outranks a bare scripts.test. Every proposed slot carries {value, rationale}
// with a machine-readable rationale token. For a POLYGLOT tree (two or more
// distinct runner families across subdirectories) it additionally attaches a
// deterministic `runners` list; a single-runner tree omits the key entirely.
// This performs NO writes; service.js persists it only on an explicit operator
// apply. Fully deterministic: no network, no env, no timestamps, no
// process.platform influence, stable key order, so the same tree always yields
// the same proposal.
export async function proposeTestCommands(projectDir) {
  const proposed = {};

  const detected = await detectRunnerAt(projectDir);
  if (detected) {
    const table = runnerProfileTable(detected.family);
    for (const slot of PROFILE_SLOTS) {
      if (table[slot]) proposed[slot] = { value: table[slot], rationale: detected.source };
    }
  }

  // Emit slots in the canonical DEFAULT_CONFIG order for a stable key set.
  const test_commands = {};
  for (const slot of ONBOARDING_SLOTS) {
    if (proposed[slot]) test_commands[slot] = proposed[slot];
  }
  const undetected = ONBOARDING_SLOTS.filter((slot) => !(slot in test_commands));
  // Complete only when BOTH the red-phase per-path template and the full-suite
  // command are grounded.
  const proposal_complete = 'targeted_template' in test_commands && 'full' in test_commands;
  const proposal = { test_commands, undetected, proposal_complete };
  if (detected) {
    proposal.detected_runner = { family: detected.family, rationale: detected.source };
  }
  // Script discovery is proposal-only. These names do not become executable
  // evidence authority until an operator explicitly applies selected values.
  const pkg = await readJson(path.join(projectDir, 'package.json'), null).catch(() => null);
  const scripts = pkg?.scripts && typeof pkg.scripts === 'object' && !Array.isArray(pkg.scripts)
    ? Object.keys(pkg.scripts)
    : [];
  const evidenceScripts = scripts
    .filter((name) => /^(?:test|lint|typecheck|check|verify|validate|build)(?::[\w.-]+)*$/.test(name))
    .sort()
    .map((value) => ({ value, rationale: 'detected-package-script' }));
  if (evidenceScripts.length > 0) proposal.evidence_scripts = evidenceScripts;
  // Attach a polyglot runners list ONLY when detected (never an empty key), so
  // a single-runner/non-polyglot tree stays byte-identical to today.
  const runners = await proposeRunners(projectDir);
  if (runners.length > 0) proposal.runners = runners;
  return { applied: false, proposal };
}
