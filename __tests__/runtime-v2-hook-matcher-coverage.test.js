import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SAFE_CLAUDE_SUBAGENT_TOOLS,
  CONTROL_PLANE_TOOLS,
  evaluateLifecyclePolicy,
  driftGuardApplies,
  isAgentDispatchTool,
} from '../lib/runtime/hooks.js';

// APE invariant 2 (no main-session production writes) is only enforced for the
// tool calls the shared conventional policy hook is wired to observe.
// hooks/hooks.json is loaded by Codex and auto-discovered by Claude; the
// Claude-specific manifest contains supplemental LARP handlers and the one
// policy event Codex does not implement. The shared PreToolUse/PostToolUse
// matchers cover exactly the enforcement tool set:
//
//   Edit|Write|MultiEdit|NotebookEdit|apply_patch|Bash|Agent|Task|mcp__.*|ape_(run|status|config|history)
//
// This suite is the executable proof that the narrowing keeps zero enforcement
// gap. The coverage/tripwire assertions (§1, §2 incl. amendments A1/A2, §4, §5)
// are matcher-independent and pass both under the current "*" wiring and under
// the narrowed matcher — they are the permanent drift tripwire, NOT the red
// signal. The red signal comes solely from the §3 narrowing pins, which fail
// against the current "*" matchers and go green once the two policy arms are
// narrowed. The enforcement set is DERIVED from lib/runtime (source extraction +
// behavioral cross-checks), never a hardcoded copy, so a future enforcement
// addition that the matcher does not cover fails this suite loudly.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const read = (rel) => readFileSync(path.join(REPO, rel), 'utf8');
const ownerSource = (rel) => {
  const absolute = path.join(REPO, rel);
  return existsSync(absolute) ? readFileSync(absolute, 'utf8') : null;
};

const claudeHooks = JSON.parse(read('hooks/claude-hooks.json')).hooks;
const codexHooks = JSON.parse(read('hooks/hooks.json')).hooks;

// A "policy arm" is a matcher group whose hook entries invoke the enforcement
// bundle (ape-hooks.bundle.mjs); a "larp arm" invokes the observability bundle
// (ape-larp.bundle.mjs). Common policy comes from hooks/hooks.json exactly once
// on both hosts; Claude-specific handlers must not duplicate those arms.
const POLICY_BUNDLE = 'ape-hooks.bundle.mjs';
const LARP_BUNDLE = 'ape-larp.bundle.mjs';

function refersToBundle(entry, bundle) {
  return (entry.hooks ?? []).some(
    (hook) =>
      (Array.isArray(hook.args) && hook.args.some((arg) => typeof arg === 'string' && arg.includes(bundle))) ||
      (typeof hook.command === 'string' && hook.command.includes(bundle)),
  );
}
const policyArms = (entries) => (entries ?? []).filter((entry) => refersToBundle(entry, POLICY_BUNDLE));
const larpArms = (entries) => (entries ?? []).filter((entry) => refersToBundle(entry, LARP_BUNDLE));

// Conservative full-match emulation of Claude's matcher semantics: a bare "*"
// matches everything, otherwise the matcher string is treated as an anchored
// regex. Claude's real matcher regex is UNANCHORED (substring), so a full match
// implies a real match — this emulation can only be stricter, never more
// permissive, which is the safe direction for a coverage proof.
function matchesTool(matcher, tool) {
  return matcher === '*' || new RegExp(`^(?:${matcher})$`).test(tool);
}
const coveredBy = (matchers, tool) => matchers.some((matcher) => matchesTool(matcher, tool));

const prePolicyMatchers = policyArms(codexHooks.PreToolUse).map((entry) => entry.matcher);
const postPolicyMatchers = policyArms(codexHooks.PostToolUse).map((entry) => entry.matcher);

// §1 — the enforcement tool-name set is derived from the runtime, not copied.
const writePolicySource = ownerSource('lib/runtime/write-policy.js');
const writeToolsLiteral = writePolicySource?.match(/const WRITE_TOOLS = new Set\(\[([\s\S]*?)\]\)/) ?? null;
const WRITE_TOOLS = writeToolsLiteral
  ? [...writeToolsLiteral[1].matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1])
  : [];

describe('enforcement tool-name set derived from the runtime (plan §1)', () => {
  it('extracts WRITE_TOOLS from its genuine write-policy.js owner and cross-checks every name behaviorally', () => {
    // WRITE_TOOLS is module-private (unexported) and lib/runtime is outside this
    // run's claims, so source extraction is a deliberate tripwire: a future
    // WRITE_TOOLS addition or a declaration reshape fails extraction loudly.
    expect(writePolicySource, 'missing required owner: lib/runtime/write-policy.js').not.toBeNull();
    if (writePolicySource === null) return;
    expect(writeToolsLiteral, 'const WRITE_TOOLS = new Set([...]) literal not found in lib/runtime/write-policy.js').not.toBeNull();
    expect(WRITE_TOOLS.length).toBeGreaterThan(0);
    expect(WRITE_TOOLS).toContain('Edit');
    expect(WRITE_TOOLS).toContain('Write');

    // Behavioral cross-check: each extracted name is the LIVE enforcement name.
    // A main-session PreToolUse write of that tool must be denied by invariant 2,
    // and the drift guard must engage on its post events.
    for (const tool of WRITE_TOOLS) {
      const decision = evaluateLifecyclePolicy(
        { event: 'PreToolUse', tool_name: tool, host: 'claude', is_subagent: false, file: 'lib/production.js' },
        { state: { status: 'running' }, ticket: null },
      );
      expect(decision.decision, `${tool} main-session write should deny`).toBe('deny');
      expect(decision.reason).toMatch(/main-session production writes are forbidden/);
      expect(driftGuardApplies({ event: 'PostToolUse', tool_name: tool }), `${tool} drift guard`).toBe(true);
    }
  });

  it('grounds Bash across the shell-write deny and the drift guard', () => {
    const decision = evaluateLifecyclePolicy(
      { event: 'PreToolUse', tool_name: 'Bash', host: 'claude', is_subagent: false, command: 'rm -rf build' },
      { state: { status: 'running' }, ticket: null },
    );
    expect(decision.decision).toBe('deny');
    // Message-precision (roadmap hook-denial-message-precision): the main-session
    // fail-closed shell deny must name what it CLASSIFIED — the guard cannot
    // prove the command is read-only (invariant 2) — not falsely assert it is a
    // "shell write". The old '...shell writes are forbidden' wording fails this
    // (red anchor); 'running' is not gating, so no ape_run poll hint is appended.
    expect(decision.reason).toMatch(/not provably read-only|cannot verify|fail-closed/i);
    expect(decision.reason).not.toMatch(/shell writes are forbidden/);
    expect(driftGuardApplies({ event: 'PostToolUse', tool_name: 'Bash', command: 'rm -rf build' })).toBe(true);
  });

  it('grounds Claude Agent and Codex spawn_agent via the shared dispatch predicate', () => {
    expect(driftGuardApplies({ event: 'PostToolUse', tool_name: 'Agent' })).toBe(true);
    expect(driftGuardApplies({ event: 'PostToolUseFailure', tool_name: 'Agent' })).toBe(true);
    expect(driftGuardApplies({ event: 'PostToolUse', tool_name: 'spawn_agent' })).toBe(true);
    expect(isAgentDispatchTool('Agent')).toBe(true);
    expect(isAgentDispatchTool('spawn_agent')).toBe(true);
    expect(isAgentDispatchTool('collaboration.spawn_agent')).toBe(true);
    expect(isAgentDispatchTool('collaborationspawn_agent')).toBe(true);
    expect(isAgentDispatchTool('mcp__other__spawn_agent')).toBe(false);
    expect(read('bin/ape-hook.mjs')).toContain('isAgentDispatchTool(event.tool_name)');
  });
});

describe('policy-arm matcher coverage of the enforcement set (plan §2)', () => {
  it('selects exactly one enforcement policy arm on each of PreToolUse and PostToolUse', () => {
    expect(policyArms(codexHooks.PreToolUse)).toHaveLength(1);
    expect(policyArms(codexHooks.PostToolUse)).toHaveLength(1);
    expect(policyArms(claudeHooks.PreToolUse)).toHaveLength(0);
    expect(policyArms(claudeHooks.PostToolUse)).toHaveLength(0);
    expect(prePolicyMatchers).toHaveLength(1);
    expect(postPolicyMatchers).toHaveLength(1);
  });

  it('matches every write tool, Bash, the dispatch tool (Agent) and its host alias (Task) on BOTH events', () => {
    // 'Task' carries no runtime predicate of its own; it is the documented host
    // alias of the dispatch tool and is required in the matcher belt-and-braces.
    const alwaysMatched = [...WRITE_TOOLS, 'Bash', 'Agent', 'Task'];
    for (const tool of alwaysMatched) {
      expect(coveredBy(prePolicyMatchers, tool), `PreToolUse must match ${tool}`).toBe(true);
      expect(coveredBy(postPolicyMatchers, tool), `PostToolUse must match ${tool}`).toBe(true);
    }
  });

  it('reconstructs CONTROL_PLANE_TOOLS from source and matches every generated control-plane name (amendment A1)', () => {
    // Do NOT hardcode control-plane sample names: generate them from
    // CONTROL_PLANE_TOOLS.source so a future addition (e.g. ape_abort) fails the
    // coverage test until the matcher grows. First prove the reconstruction is
    // STRICTLY EQUAL to the live source (equality, not subset) so any reshape of
    // the regex also fails loudly.
    const controlSource = CONTROL_PLANE_TOOLS.source;
    const alternation = controlSource.match(/ape_\(([^)]+)\)/);
    expect(alternation, 'CONTROL_PLANE_TOOLS.source shape changed; update this extraction').not.toBeNull();
    const names = alternation[1].split('|');
    expect(names.length).toBeGreaterThan(0);
    const reconstruction = `(?:^|__)ape_(${names.join('|')})$`;
    expect(reconstruction).toBe(controlSource);

    for (const name of names) {
      const samples = [
        `ape_${name}`,
        `mcp__plugin_ape_ape__ape_${name}`,
        `mcp__ape__ape_${name}`,
        `mcp__anyserver__ape_${name}`,
      ];
      for (const sample of samples) {
        // Self-consistency: the generated name is a real control-plane tool name.
        expect(CONTROL_PLANE_TOOLS.test(sample), `${sample} should satisfy CONTROL_PLANE_TOOLS`).toBe(true);
        expect(coveredBy(prePolicyMatchers, sample), `PreToolUse must match ${sample}`).toBe(true);
        expect(coveredBy(postPolicyMatchers, sample), `PostToolUse must match ${sample}`).toBe(true);
      }
    }
  });

  it('matches arbitrary namespaced MCP tools on both hosts so editor policy cannot be bypassed', () => {
    for (const sample of ['mcp__unity__save_scene', 'mcp__official_unity__read_console', 'mcp__future_provider__unknown']) {
      expect(coveredBy(prePolicyMatchers, sample), `Claude PreToolUse must match ${sample}`).toBe(true);
      expect(coveredBy(postPolicyMatchers, sample), `Claude PostToolUse must match ${sample}`).toBe(true);
      for (const event of ['PreToolUse', 'PostToolUse']) {
        const matchers = policyArms(codexHooks[event]).map((entry) => entry.matcher);
        expect(coveredBy(matchers, sample), `Codex ${event} must match ${sample}`).toBe(true);
      }
    }
  });

  it('inventories tool_name literal predicates across the runtime and matches each (amendment A2)', () => {
    // Scan every `tool_name === '<literal>'` / `tool_name !== '<literal>'`
    // predicate in the enforcement code paths. Over-matching (incl. !==) and
    // scanning claude-dispatch.js (zero predicates today) is the safe direction:
    // a new predicate added beside the existing literals — or a first predicate
    // added to claude-dispatch.js — fails this test until the matcher grows.
    // This supplements, not replaces, the §1 behavioral groundings.
    const ownerFiles = [
      'lib/runtime/evidence-policy.js',
      'lib/runtime/write-policy.js',
      'lib/runtime/lifecycle-policy.js',
    ];
    const ownerSources = ownerFiles.map((file) => [file, ownerSource(file)]);
    for (const [file, source] of ownerSources) {
      expect(source, `missing required owner: ${file}`).not.toBeNull();
    }
    if (ownerSources.some(([, source]) => source === null)) return;
    const sources = [
      ...ownerSources.map(([, source]) => source),
      read('bin/ape-hook.mjs'),
      read('lib/runtime/claude-dispatch.js'),
    ];
    const literals = new Set();
    const predicate = /\btool_name\s*[!=]==\s*['"]([^'"]+)['"]/g;
    for (const source of sources) {
      for (const match of source.matchAll(predicate)) literals.add(match[1]);
    }
    expect(literals.size).toBeGreaterThan(0);
    expect(literals.has('Bash')).toBe(true);
    expect(literals.has('Agent')).toBe(true);
    for (const literal of literals) {
      expect(coveredBy(prePolicyMatchers, literal), `PreToolUse must match tool_name literal ${literal}`).toBe(true);
      expect(coveredBy(postPolicyMatchers, literal), `PostToolUse must match tool_name literal ${literal}`).toBe(true);
    }
  });
});

describe('narrowing pins — RED until the policy matchers are narrowed (plan §3)', () => {
  it('forbids a wildcard or empty policy matcher on PreToolUse and PostToolUse', () => {
    // RED today: both policy arms are matcher "*". Green once narrowed. Scoped to
    // PreToolUse/PostToolUse only — PostToolUseFailure legitimately keeps "*".
    expect(prePolicyMatchers.length + postPolicyMatchers.length).toBeGreaterThan(0);
    for (const matcher of [...prePolicyMatchers, ...postPolicyMatchers]) {
      expect(matcher, 'policy matcher must not be the always-on wildcard').not.toBe('*');
      expect(matcher, 'policy matcher must not be empty').not.toBe('');
    }
  });

  it('does not match hot read-only tools that the hook already allows', () => {
    // Residual-behavior note (amendment A3). Narrowing removes the policy hook
    // from these read-only tools. That is outcome-identical for the MAIN session
    // (a non-write tool was always allowed at hooks.js:461) and for BOUND
    // subagents (each hot tool is in SAFE_CLAUDE_SUBAGENT_TOOLS, so the hook's
    // own decision was already "allow"). Two devolutions apply ONLY to unmatched
    // non-safe/non-write tool calls and are BACKSTOPPED, not new write gaps:
    //   (i)  the bound-subagent indirect-channel deny (hooks.js:452-461) no
    //        longer fires at hook level for unmatched non-safe tools; and
    //   (ii) the no-exact-binding deny (hooks.js:374-380) — under "*" an unbound
    //        ape:*-typed subagent (an orphan, or a blocked-run formerly-bound
    //        subagent whose binding no longer resolves because pendingTicket
    //        requires status 'running') was denied on EVERY tool-channel event
    //        including Read/Grep/Glob; after narrowing those unmatched calls
    //        bypass the hook. So "skipping the hook is the hook's own allow"
    //        (hooks.js:461) holds for bound subagents and the main session only.
    // Both are backstopped: the layer-2 agents/*.md tools: allowlists (no
    // Agent/Task, no mcp__ tools; pinned green by
    // runtime-v2-agent-tool-surface.test.js), the still-matched write/Bash/Agent/
    // ape_* channels that keep reaching the 374-380 and 344-355 denies, the
    // launch-nonce gate (bin/ape-hook.mjs:100-113) that blocks minting new
    // unbound ape:* agents while a run is active, matcher-free SubagentStop tree
    // reconciliation, and receipt-time diff recomputation. No invariant-2 write
    // channel opens.
    const HOT_READ_ONLY = ['Read', 'Grep', 'Glob', 'LS', 'TodoWrite', 'WebFetch', 'WebSearch'];
    for (const tool of HOT_READ_ONLY) {
      // Precondition: the hook already allows these for bound subagents.
      expect(SAFE_CLAUDE_SUBAGENT_TOOLS.has(tool), `${tool} must be a safe subagent tool`).toBe(true);
      expect(coveredBy(prePolicyMatchers, tool), `PreToolUse must NOT match hot read-only ${tool}`).toBe(false);
      expect(coveredBy(postPolicyMatchers, tool), `PostToolUse must NOT match hot read-only ${tool}`).toBe(false);
    }
  });
});

describe('Claude supplemental wiring and shared binding policy (plan §4)', () => {
  const onlyLarpAsync = (entries, label) => {
    expect(entries, label).toHaveLength(1);
    expect(entries[0].hooks, `${label} hooks`).toHaveLength(1);
    expect(refersToBundle(entries[0], LARP_BUNDLE)).toBe(true);
    expect(entries[0].hooks[0].async).toBe(true);
  };

  it('SessionStart and Stop each carry exactly the async ape-larp entry', () => {
    onlyLarpAsync(claudeHooks.SessionStart, 'SessionStart');
    onlyLarpAsync(claudeHooks.Stop, 'Stop');
  });

  it('SubagentStart carries one shared policy entry and no Claude duplicate', () => {
    expect(claudeHooks.SubagentStart).toBeUndefined();
    expect(codexHooks.SubagentStart).toHaveLength(1);
    const [arm] = policyArms(codexHooks.SubagentStart);
    expect(arm).toBeDefined();
    expect(arm.matcher).toBeUndefined();
  });

  it('SubagentStop splits shared policy from the Claude-only async larp entry', () => {
    expect(codexHooks.SubagentStop).toHaveLength(2);
    expect(policyArms(codexHooks.SubagentStop)).toHaveLength(1);
    expect(larpArms(codexHooks.SubagentStop)).toHaveLength(1);
    expect(claudeHooks.SubagentStop).toHaveLength(1);
    const group = claudeHooks.SubagentStop[0];
    expect(group.hooks).toHaveLength(1);
    expect(refersToBundle(group, POLICY_BUNDLE)).toBe(false);
    expect(refersToBundle(group, LARP_BUNDLE)).toBe(true);
    expect(group.hooks[0].async).toBe(true);
  });

  it('PostToolUseFailure keeps one wildcard group carrying both bundles', () => {
    expect(claudeHooks.PostToolUseFailure).toHaveLength(1);
    const group = claudeHooks.PostToolUseFailure[0];
    expect(group.matcher).toBe('*');
    expect(group.hooks).toHaveLength(2);
    expect(refersToBundle(group, POLICY_BUNDLE)).toBe(true);
    expect(refersToBundle(group, LARP_BUNDLE)).toBe(true);
  });

  it('PreToolUse retains the AskUserQuestion larp arm', () => {
    const arms = larpArms(claudeHooks.PreToolUse);
    expect(arms).toHaveLength(1);
    expect(arms[0].matcher).toBe('AskUserQuestion');
    expect(arms[0].hooks[0].async).toBe(true);
  });

  it('PostToolUse retains the ape_run outcome-cue larp arm unchanged', () => {
    const arms = larpArms(claudeHooks.PostToolUse);
    expect(arms).toHaveLength(1);
    expect(arms[0].matcher).toBe('mcp__plugin_ape_ape__ape_run|mcp__ape__ape_run');
    expect(arms[0].hooks[0].async).toBe(true);
  });
});

describe('Codex hooks parity guard (plan §5)', () => {
  it('covers the shared write, dispatch, and MCP surfaces on both events', () => {
    for (const event of ['PreToolUse', 'PostToolUse']) {
      const matchers = (codexHooks[event] ?? []).map((entry) => entry.matcher);
      for (const tool of ['Bash', 'Edit', 'Write', 'apply_patch', 'Agent', 'spawn_agent', 'collaborationspawn_agent', 'mcp__unity__save_scene']) {
        expect(coveredBy(matchers, tool), `Codex ${event} must match ${tool}`).toBe(true);
      }
    }
  });

  it('registers Codex LARP lifecycle, question, and ape_run outcome cues without async handlers', () => {
    expect(larpArms(codexHooks.SessionStart)).toHaveLength(1);
    expect(larpArms(codexHooks.Stop)).toHaveLength(1);
    expect(larpArms(codexHooks.SubagentStop)).toHaveLength(1);

    const ask = larpArms(codexHooks.PreToolUse);
    expect(ask).toHaveLength(1);
    expect(ask[0].matcher).toBe('AskUserQuestion|request_user_input');

    const outcomes = larpArms(codexHooks.PostToolUse);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].matcher).toBe('(?:^|__)ape_run$');

    for (const event of ['SessionStart', 'Stop', 'SubagentStop', 'PreToolUse', 'PostToolUse']) {
      for (const arm of larpArms(codexHooks[event])) {
        expect(arm.hooks).toHaveLength(1);
        expect(arm.hooks[0].async).toBeUndefined();
        expect(arm.hooks[0].commandWindows).toBe(arm.hooks[0].command);
      }
    }
  });
});

describe('main-session shell-deny message precision (roadmap hook-denial-message-precision)', () => {
  // The main-session fail-closed shell deny (lib/runtime/hooks.js:477) must name
  // what it actually CLASSIFIED. SHELL_WRITE matches a large class of commands
  // that are NOT writes — a quoted `>` (`grep 'a>b'`), a compound command, an
  // inline interpreter — which are denied only because the guard
  // cannot PROVE they are read-only (fail-closed, invariant 2), not because they
  // are writes. This is a MESSAGE-ONLY change: the DECISION stays `deny` for
  // every currently-denied input and `allow` for every currently-allowed one, so
  // the denial SET is unchanged. Derived from the objective's public contract:
  // the reason names the fail-closed classification (never "shell writes"), and
  // — mirroring the deletion-channel gating message (hooks.js:439-441) — appends
  // an `ape_run next` poll hint only while the run is 'gating', never 'running'.
  const denyMain = (command, status) =>
    evaluateLifecyclePolicy(
      { event: 'PreToolUse', tool_name: 'Bash', host: 'claude', is_subagent: false, command },
      { state: { status }, ticket: null },
    );

  // `grep 'a>b'` matches SHELL_WRITE via the bare-`>` arm (the quoted `>` reads
  // as a redirect-shaped token to the pattern) yet is a pure read: the archetypal
  // denied-but-not-a-write case whose old "shell writes are forbidden" message was
  // simply false. Unlike a sole redirect to exactly /dev/null — now ALLOWED by the
  // main-session fail-safe carve-out (see runtime-v2-hook-shell-policy.test.js) —
  // this quoted-`>` false positive is NOT a /dev/null redirect, so the carve-out
  // does not exempt it and it stays DENIED with the fail-closed message both pre-
  // and post-fix, keeping these message-precision assertions valid throughout.
  const NOT_A_WRITE = "grep 'a>b'";

  it('names the fail-closed classification (not "shell writes") for a non-write redirect under running, with no poll hint', () => {
    const decision = denyMain(NOT_A_WRITE, 'running');
    expect(decision.decision).toBe('deny');
    expect(decision.reason).toMatch(/not provably read-only|cannot verify|fail-closed/i);
    expect(decision.reason).not.toMatch(/shell writes are forbidden/);
    // 'running' is not a gating state, so no detached-suite poll hint is appended.
    expect(decision.reason).not.toMatch(/ape_run next/);
  });

  it('appends an ape_run next poll hint for the same command while gating', () => {
    const decision = denyMain(NOT_A_WRITE, 'gating');
    expect(decision.decision).toBe('deny');
    // While the detached merge-gate suite runs and the tree is frozen, name the
    // poll verb — mirroring the deletion-channel gating message (hooks.js:439-441).
    expect(decision.reason).toMatch(/ape_run next/);
    expect(decision.reason).toMatch(/not provably read-only|cannot verify|fail-closed/i);
    expect(decision.reason).not.toMatch(/shell writes are forbidden/);
  });

  it('leaves the denial SET unchanged: real writes still deny, read-only commands still allow', () => {
    // A genuine mutation stays denied (holds pre- and post-fix — message only).
    expect(denyMain('rm -rf build', 'running').decision).toBe('deny');
    // Commands that never matched SHELL_WRITE stay allowed (pre- and post-fix).
    expect(denyMain('ls', 'running').decision).toBe('allow');
    expect(denyMain('git status', 'running').decision).toBe('allow');
  });
});
