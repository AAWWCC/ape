export const RUNTIME_VERSION = 2;
export const SCHEMA_VERSION = '2.0.0';

// `phase` is the one building mode. Its former alias `patch` ran the identical
// lane-classified pipeline (the scheduler never branched on the distinction),
// so it was collapsed into `phase`; latency classes live on lanes, where they
// always really were. Archived history keeps legacy `patch` labels verbatim.
export const RUN_MODES = Object.freeze(['phase', 'debug', 'spike']);
export const LANES = Object.freeze(['auto', 'mechanical', 'fast', 'full']);
export const MODEL_TIERS = Object.freeze(['fast', 'balanced', 'deep']);
export const RECEIPT_STATUSES = Object.freeze(['passed', 'failed']);

export const TERMINAL_STATUSES = new Set(['completed', 'blocked', 'aborted']);

// The reason stamped on a run HELD at stage 'merge' when shipping.auto_merge is
// not true (green gates, but real acceptance is out-of-band). It doubles as the
// SHIP arm's validity key (scheduler.js) and the status-doc merge-hold hint key
// (status-doc.js), so it must have exactly ONE definition and stay
// byte-identical: decorating it (attemptSummaries-style) would silently make the
// reason-exact SHIP guard reject every real hold and kill the ship lever. ~20
// suites also assert this literal verbatim as the never-really-merge fixture.
export const AUTO_MERGE_HOLD_REASON = 'auto-merge is disabled by configuration';

// Terminal statuses retained in active.json as sealed history (truthful
// completion): history on display, not a live governor. Blocked is deliberately
// excluded — a blocked run holds unresolved tickets awaiting remediation or an
// audited abort/reset. Hook policy and status reporting must agree on this set.
export const SEALED_STATUSES = new Set(['completed', 'aborted']);

export const DEFAULT_MODELS = Object.freeze({
  claude: Object.freeze({
    fast: Object.freeze({ model: 'haiku' }),
    balanced: Object.freeze({ model: 'sonnet' }),
    deep: Object.freeze({ model: 'opus' }),
  }),
  codex: Object.freeze({
    fast: Object.freeze({ model: 'gpt-5.4-mini', reasoning_effort: 'low' }),
    balanced: Object.freeze({ model: 'gpt-5.5', reasoning_effort: 'medium' }),
    deep: Object.freeze({ model: 'gpt-5.5', reasoning_effort: 'high' }),
  }),
});

// Versioned snapshots of every historical shipped default that later changed
// (F36). Older `config set` implementations materialized the whole
// then-current default tree into config.json; a stored leaf that matches one
// of these snapshots but not the current default is ambiguous — it may be an
// intentional override or a frozen old default. Detection
// (detectAmbiguousConfigOverrides) surfaces such leaves via doctor instead of
// silently keeping or stripping them.
export const LEGACY_SHIPPED_DEFAULTS = Object.freeze([
  Object.freeze({
    version: '2.0.20',
    defaults: Object.freeze({
      deadlines_ms: Object.freeze({ fast: 15 * 60_000, full: 45 * 60_000 }),
    }),
  }),
  Object.freeze({
    version: '2.0.21',
    defaults: Object.freeze({
      models: Object.freeze({
        claude: Object.freeze({
          fast: Object.freeze({ model: 'sonnet' }),
          balanced: Object.freeze({ model: 'opus' }),
          deep: Object.freeze({ model: 'fable' }),
        }),
      }),
    }),
  }),
  // 2.6.2 was the last released carrier of the 10s inline gate grace
  // (GATE_INLINE_GRACE_MS=10000, introduced in #268); #308 retuned it to
  // 300000 without a version bump landing first, so a provenance-less
  // materialized 10000 is ambiguous against this snapshot.
  Object.freeze({
    version: '2.6.2',
    defaults: Object.freeze({
      gates: Object.freeze({ inline_grace_ms: 10_000 }),
    }),
  }),
]);

export const RISK_TRIGGERS = Object.freeze([
  'security',
  'authentication',
  'migration',
  'dependency',
  'public-api',
  'schema',
  'concurrency',
  'destructive-operation',
]);

export const ROLE_POLICIES = Object.freeze({
  preflight_analyst: Object.freeze({ writable: false, model_tier: 'balanced' }),
  planner: Object.freeze({ writable: false, model_tier: 'deep' }),
  plan_checker: Object.freeze({ writable: false, model_tier: 'fast' }),
  plan_critic: Object.freeze({ writable: false, model_tier: 'deep' }),
  plan_judge: Object.freeze({ writable: false, model_tier: 'deep' }),
  test_writer: Object.freeze({ writable: true, model_tier: 'balanced', writes: 'tests' }),
  implementer: Object.freeze({ writable: true, model_tier: 'balanced', writes: 'production' }),
  reviewer: Object.freeze({ writable: false, model_tier: 'deep' }),
  security_reviewer: Object.freeze({ writable: false, model_tier: 'deep' }),
  debugger: Object.freeze({ writable: false, model_tier: 'deep' }),
  spike_researcher: Object.freeze({ writable: false, model_tier: 'balanced' }),
});

// Fable's cyber classifiers apply to security-focused analysis, so the security
// reviewer stays on opus even when a project override points the deep tier at
// fable.
export const ROLE_MODEL_OVERRIDES = Object.freeze({
  security_reviewer: Object.freeze({
    claude: Object.freeze({ model: 'opus' }),
  }),
});

// The deep tier runs long single turns; the fast and full lanes get headroom
// so valid receipts are not rejected purely for lateness.
export const DEFAULT_DEADLINES_MS = Object.freeze({
  mechanical: 15 * 60_000,
  fast: 30 * 60_000,
  full: 60 * 60_000,
});

export const MAX_STAGE_ATTEMPTS = 2;
export const MAX_REMEDIATION_CYCLES = 3;
// New receipt-contract tickets may launch one replacement physical worker
// after validation exhaustion; each worker receives three bounded draft
// submissions. Readiness uses these ceilings to forecast physical work from
// the logical ticket graph.
export const RECEIPT_MAX_PHYSICAL_WORKERS_PER_TICKET = 2;
export const RECEIPT_MAX_SUBMISSIONS_PER_WORKER = 3;
// The immutable ticket capability manifest is intentionally small enough to
// travel with every worker dispatch. These are shared by config admission,
// run readiness, and the authoritative ticket schema so a configuration that
// cannot be represented never survives until ticket issuance.
export const CAPABILITY_MANIFEST_MAX_REQUIRED_CAPABILITIES = 64;
export const CAPABILITY_MANIFEST_MAX_ALLOWED_EVIDENCE_COMMANDS = 256;
export const CAPABILITY_MANIFEST_MAX_COMMAND_PROFILES = 64;
export const CAPABILITY_MANIFEST_MAX_VERIFICATION_PROFILES = 64;
export const CAPABILITY_CATALOG_MAX_EVIDENCE_SCRIPTS = 64;
export const CAPABILITY_CATALOG_MAX_RUNNERS = 64;
export const CAPABILITY_CATALOG_MAX_TOOL_CLAIMS = 64;
export const CAPABILITY_MANIFEST_MAX_UTF8_BYTES = 256 * 1_024;
// New native runs advertise and enforce one aggregate budget for the
// runtime-derived authored-test path set. A test-writer may legitimately turn
// a directory claim into many concrete files, but those paths are rendered
// into exact evidence commands on every later ticket. Bounding both the item
// count and the serialized UTF-8 representation keeps that monotone growth
// representable by the immutable capability manifest. Existing run snapshots
// do not acquire the version marker that activates these limits.
export const CAPABILITY_DYNAMIC_TEST_PATHS_MAX = 64;
export const CAPABILITY_DYNAMIC_TEST_PATHS_MAX_UTF8_BYTES = 4 * 1_024;
// More than one member of a review group can declare a scope expansion, and
// each member's reason justifies its own proposed paths. Each is bounded
// individually where it is recorded (service.js's SCOPE_EXPANDED dispatch) and
// only then joined, so no member's reason can consume another's budget. This
// caps how many are joined; when it bites, the join spends its last slot on
// the runtime's own omission note instead of dropping a reason silently.
// Shared by scheduler.js, which performs the join, and service.js, which
// derives the whole-block ceiling from it, so the two cannot drift apart.
export const SCOPE_EXPANSION_REASONS_MAX = 8;
// A gate-blocked run may be re-gated (re-run the full merge-gate suite after
// the operator fixes the environment) only a bounded number of times, so a
// permanently red environment cannot loop the recovery forever.
export const MAX_REGATE_ATTEMPTS = 3;

// CI registers a just-created PR's check runs asynchronously, so `gh pr
// checks --watch` invoked immediately after `gh pr create` can bail with "no
// checks reported" on a pure timing race (friction #4). Shipping retries only
// that exact condition, sleeping RETRY_DELAY between attempts for at most
// WINDOW of accumulated waiting, then fails closed — a repository with no CI
// must state that intent via shipping.required_remote_checks=false, never be
// auto-passed (invariant 9).
export const CHECKS_REGISTRATION_WINDOW_MS = 120_000;
export const CHECKS_REGISTRATION_RETRY_DELAY_MS = 10_000;

// Non-blocking local merge gates (gating watch). The full gate suite runs in a
// runtime-spawned detached child; the parent rests the run in the 'gating'
// status and each `ape_run next` polls once for the child's artifact. These
// knobs are read via config.gates?.<knob> ?? DEFAULT so a project can override
// them (documented in docs/configuration.md with shipped-default provenance).
//
// GATE_RUNNER_HEARTBEAT_MS — how often the detached runner refreshes its
//   heartbeat file so a poll can tell a live runner from a dead one.
// GATE_RUNNER_STALE_MS — a heartbeat older than this is stale (the runner is
//   presumed dead); combined with the pid fence it authorizes a bounded respawn.
// GATE_RUNNER_MAX_SPAWNS — total detached spawns per watch (the initial spawn
//   plus bounded respawns); exhaustion fails the gate closed rather than looping.
// GATE_INLINE_GRACE_MS — after starting the suite, the record/regate call waits
//   at most this long inline for the artifact; the default now lets a typical
//   multi-minute suite complete its gate evaluation inside the recording call
//   (in one call) rather than resting in gating. 0 disables the grace poll
//   entirely (every poll is an explicit next); an explicit operator override
//   (including 0 and 10000) is honored verbatim for hosts with strict per-call
//   timeouts.
// GATE_POLL_RETRY_DELAY_MS — advisory retry cadence surfaced on a pending poll.
export const GATE_RUNNER_HEARTBEAT_MS = 5_000;
export const GATE_RUNNER_STALE_MS = 30_000;
export const GATE_RUNNER_MAX_SPAWNS = 2;
export const GATE_INLINE_GRACE_MS = 300_000;
export const GATE_POLL_RETRY_DELAY_MS = 5_000;

// Bounds for the gate-suite directory's orphaned-temp sweep (roadmap
// orphaned-heartbeat-temp-has-no-sweeper), run at every launchGateRunner
// chokepoint (gates.js). BOUNDS ARE CONSTANTS, NOT OPERATOR KNOBS — deliberately
// absent from config.js/DEFAULT_CONFIG, so no docs/configuration.md reference
// row is owed for them (a `gates.*` row with no matching DEFAULT_CONFIG key
// fails config-doc-parity in the other direction).
//
// GATE_SUITE_TEMP_SWEEP_STALE_MS — a temp this age or younger may still belong
//   to a live concurrent write (open+writeFile+fsync+rename of a small JSON
//   file) and is left alone; only an older one is swept. Deliberately looser
//   than GATE_RUNNER_STALE_MS: that knob ages a WITNESS whose freshness is
//   refreshed every heartbeat_ms, while this one must outlast one single write
//   under host scheduling pressure, not a whole beat cadence.
// GATE_SUITE_TEMP_SWEEP_SCAN_CAP — the sweep reads the directory once, then
//   stats every matching temp (uncapped: that reach scales with the
//   directory). What this caps is the REMOVAL work: the AGE-ordered
//   (oldest-mtime-first, never lexicographic-name) candidate list is capped
//   here at removal time, so a directory holding more stale candidates than
//   the cap is drained incrementally across later launches, never all at once,
//   and a fresher temp can never shadow a genuinely stale one out of the pass.
export const GATE_SUITE_TEMP_SWEEP_STALE_MS = 300_000;
export const GATE_SUITE_TEMP_SWEEP_SCAN_CAP = 1_000;

// The ape_run next wait clamp cap; < the smallest lane deadline
// DEFAULT_DEADLINES_MS.mechanical=900000 so it never masks a stuck run.
export const GATE_NEXT_MAX_WAIT_MS = 300_000;
// Minimum inter-poll cadence for the waited-next loop so a 0 poll_retry_delay_ms
// cannot hot-loop. It shares its PURPOSE with the inline-grace sleep floor at
// service.js:384 — both stop a zero-delay busy loop — but the two values are
// deliberately DISTINCT and neither tracks the other: this one is the
// waited-next inter-poll cadence (250), while that one is the inline grace
// sleep (Math.min(200, graceMs), which also shrinks to a short remaining
// grace). Changing either value must not be justified by "matching" the other.
export const GATE_NEXT_POLL_FLOOR_MS = 250;
