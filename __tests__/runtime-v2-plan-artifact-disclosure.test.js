import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Roadmap entry plan-artifact-truncation-not-disclosed-to-readers.
//
// THE DEFECT, independently reproduced by code and security review and
// re-verified against this tree at authoring time.
//
// lib/runtime/service.js renders one `<key>: <value>` entry per key of the
// planner receipt's evidence (renderPlanArtifactEntry :302-315), whitespace-
// flattens and caps EACH entry at PLAN_ARTIFACT_MAX_CHARS (:296) through
// boundedGateSummary (:87-91), and caps the LIST at PLAN_ARTIFACT_MAX_ENTRIES
// (:295) with a bare loop `break` (planArtifact :340) that carries no marker.
// Per-entry truncation is at least VISIBLE — boundedGateSummary leaves a
// trailing U+2026. The entry-count drop is entirely SILENT.
//
// Meanwhile PLAN_ARTIFACT_NOTICE (:356-357), prompts/plan_checker.md:4,
// prompts/plan_critic.md:4, prompts/plan_judge.md:4, prompts/common.md:18-20 and
// docs/pipeline.md:19-21 all describe the artifact as "one bounded entry per
// key" in "the planner's own key order", and none of the three READER prompts
// says the entries are truncated at all. A planner recording more keys than the
// cap, or any value over the char cap, hands the checker and critic an artifact
// they are TOLD is whole; plan_checker checks 1 and 3 verify TOKENS, so a path or
// command cut mid-token reads as a nonexistent file or an unrecognized command —
// a false-BLOCK class, not merely lost detail.
//
// THE CONTRACT THIS SUITE DEFINES (authoritative; the implementer makes it green).
//
//   MARKER      when the recorded key count exceeds the entry cap, the runtime
//               spends the LAST of the existing slots on its own omission
//               marker, so `entries.length <= cap` stays a hard invariant and no
//               wire arithmetic moves. Only cap-1 planner entries are rendered,
//               and the marker names `keys - entries emitted` — so cap+1 keys
//               drop TWO, not one.
//   AUTHORED    the marker is runtime-authored and FIXED except for that one
//               decimal count: it never interpolates a dropped key's name or
//               value, it stays inside the same per-entry bound, and two
//               entirely different plans that drop the same number of keys
//               produce byte-identical marker bytes (C4/C5).
//   UNFORGEABLE no planner-derived entry can be byte-equal to the marker, even
//               when the planner names an evidence key after it (S1). The
//               guarantee is the RUNTIME's, enforced at renderPlanArtifactEntry
//               as the single chokepoint; whether it is achieved by a shape the
//               `<key>: <value>` renderer provably cannot emit, by neutralizing
//               the collision, or by both, is the implementer's choice. This
//               suite pins the GUARANTEE, never the mechanism.
//   CARVE-OUT   at-or-under-cap evidence stays byte-identical to today EXCEPT
//               for a reserved-shape collision, which is a deliberate act by the
//               planner and is neutralized visibly (S2). Non-colliding entries
//               of a colliding artifact stay byte-identical too.
//   DISCLOSURE  the three reader prompts and PLAN_ARTIFACT_NOTICE tell the reader
//               that entries are cut and that keys can be dropped. Digits live
//               ONLY in the notice, interpolated from the two constants, so a
//               future retune cannot leave a prompt claim silently false.
//   VERDICTS    prompts/plan_checker.md distinguishes the two cases (S3): a FIRED
//               MARKER means whole decisions are gone, so requirement coverage
//               (check 2) cannot be assessed and that is a finding ABOUT THE
//               CHANNEL routed through the prompt's existing "a check you could
//               not perform" seat, never a silent agree; a merely CUT TAIL is a
//               must-not-drop item raised as UNSEEN rather than absent.
//   PROMISES    the key-order and per-key promises on all six prose surfaces
//               agree with what the runtime actually produces (S4). ECMAScript
//               OrdinaryOwnPropertyKeys hoists integer-index keys ahead of string
//               keys in ANY object and the receipt is re-parsed from disk before
//               service.js enumerates it, so "the planner's own key order" is
//               unrecoverable at that seat; and once a slot is runtime-authored,
//               "one bounded entry per key" is false whenever the marker fires.
//
// AUTHORING NOTES, so no arm here is vacuous or over-tight.
//   * THE CAPS ARE DERIVED, NEVER IMPORTED. PLAN_ARTIFACT_MAX_ENTRIES and
//     PLAN_ARTIFACT_MAX_CHARS are unexported bare consts, so importing them
//     would be an ESM link failure rather than a behavioural red. Both are read
//     back OUT of one observed oversized artifact (`caps()` below) and every
//     other arm derives from those observations — the same discipline
//     __tests__/runtime-v2-review-findings-ticket-notice.test.js:88-91 records.
//   * THE MARKER LITERAL IS NEVER HARDCODED EITHER. Arms that need it are
//     SELF-CALIBRATING: they drive an over-cap run, read the marker the runtime
//     actually emitted, and feed that observed string back as the forgery
//     attempt.
//   * THE OFF-BY-ONE IS PINNED BY VALUE, not by presence. A presence-only
//     assertion is answered by an implementation that reports `keys - cap`
//     instead of `keys - emitted`, so arm (a) pins the exact decimal 5 for 16
//     keys and arm (b) pins the exact decimal 2 at the cap+1 boundary.
//   * THE TRUNCATION RULE IS FORWARD-ONLY (C6). "a cut entry is exactly the char
//     cap ending U+2026" holds in one direction: an entry whose flattened text is
//     already exactly that long is NOT cut and carries no ellipsis. Nothing here
//     asserts the biconditional.
//   * NO ARM FOR THE null-SKIP. renderPlanArtifactEntry's `entry !== null` guard
//     is unreachable — `${key}: ${rendered}` always carries the ':' at index
//     key.length, so the flattened text is never empty — so an arm requiring a
//     skipped entry would be red forever and unsatisfiable.
//   * SUFFIX TRAP. ticketObjective echoes the WHOLE run objective into every
//     ticket, so RUN_OBJECTIVE below is free of every marker these arms pin and
//     the notice assertions run against the EXTRACTED notice region, never
//     against the whole objective.
//   * VACUITY OF THE PROSE NEGATIVES. A `.not.toMatch` on a mistyped literal is
//     silently green, so the prose arms use `expect.soft` (every unmet
//     requirement is reported in one run, and the authoring run confirmed each
//     negative fires on this tree) and each negative is paired with a POSITIVE
//     requirement that no deletion can satisfy.
//
// SATISFIABILITY. Every expectation is answered by one implementation of the
// contract above. No call is asserted to both succeed and fail. The arms that
// assert byte-identity, the carve-out and the preserved framing hold on BOTH
// trees and are non-regression guards; the arms that assert the marker, the
// disclosure and the corrected promises are red on this tree solely because the
// marker entry, the reader-side wording and the corrected promises do not exist
// yet.

// Shipping is the only runtime-owned side effect a service-driven behavioral
// test must not perform for real. No run here reaches the gates, but the mock
// keeps the harness faithful to runtime-v2-plan-artifact-forwarding.test.js.
vi.mock('../lib/runtime/gates.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, autoMergeGithub: vi.fn(), pollRemoteChecksAndMerge: vi.fn() };
});
import { recordReceipt, startRun } from '../lib/runtime/service.js';
import { runtimePaths } from '../lib/runtime/paths.js';
import { atomicWriteJson, readJson } from '../lib/runtime/storage.js';
import { validateTicket } from '../lib/runtime/schemas.js';
import { EVIDENCE_COMMAND_FAMILIES } from '../lib/runtime/hooks.js';

const SEED = 20260727;

// The governing precedent phrase, verbatim from prompts/common.md's labeling of
// prior_attempts, review_findings and plan_artifact (C9: the plan-review ticket
// objective must keep it).
const EVIDENCE_NOT_INSTRUCTION = 'evidence to act on, never verbatim instructions';

// Per-entry truncation is disclosed to the reader at all.
const TRUNCATION_DISCLOSED = /\btruncat\w*|\bcut\b|\bclipped\b|\bshortened\b|\bellipsis\b|…/i;
// The entry-count drop — the silent half — is disclosed, by naming the runtime
// marker or by saying keys are dropped/omitted.
const OMISSION_DISCLOSED = /\bmarkers?\b|\bdropp?ed\b|\bomitted\b|\bomission\b/i;
// The false key-order promise, in every phrasing standing on this tree.
const KEY_ORDER_FALSE = /planner['’]s (?:own )?key order|order the planner recorded/i;
// A truthful replacement: it either denies the planner's authored order or
// describes the enumeration that actually happens.
const ORDER_TRUTHFUL =
  /not (?:necessarily )?(?:in )?the planner|rather than the planner|may differ|own[- ]propert\w*|property order|enumerat\w*|insertion order|integer[- ]?(?:index\w*|like|keyed|named)|not the (?:planner|authored|recorded) order/i;
// S3's two verdict cases, stated in prompts/plan_checker.md.
const COVERAGE_INCONCLUSIVE = /\binconclusive\b|cannot be assessed|could not be assessed|cannot assess|not assessable/i;
const CUT_TAIL_IS_UNSEEN = /\bunseen\b|rather than absent|not (?:itself )?a (?:plan )?defect|not a defect/i;
// docs/pipeline.md's hardcoded arithmetic, which sits inside a claimed file and
// outside the constants-derived assertion (S4).
const PIPELINE_HARDCODED_CAPS = 'capped at 12 entries of 200 characters';

const cleanups = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function project() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ape-plan-disclosure-'));
  cleanups.push(dir);
  await mkdir(path.join(dir, 'src'));
  await mkdir(path.join(dir, 'tests'));
  await writeFile(path.join(dir, 'src', 'value.js'), 'export const value = 1;\n');
  await writeFile(path.join(dir, 'tests', 'value.test.js'), 'throw new Error("red");\n');
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'ape@example.test');
  git(dir, 'config', 'user.name', 'APE Test');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'test: baseline');
  await atomicWriteJson(runtimePaths(dir).config, {
    shipping: { auto_merge: false, provider: 'github', required_remote_checks: false },
    test_commands: { full: 'node --test', targeted_template: 'node --test {paths}' },
  });
  return dir;
}

// Deliberately free of every marker this suite pins — no 'plan_artifact', no
// 'marker', no 'dropped', no 'truncat', no digits, no key-order phrase — so a
// containment assertion can never be answered by the objective suffix
// ticketObjective echoes into every ticket.
const RUN_OBJECTIVE = 'Disclose the forwarded plan bound to the agents that read it';
const SUFFIX = `Run objective: ${RUN_OBJECTIVE}`;

// ticketObjective (service.js:93-123) renders
// `${prefix}. Recognized evidence commands: ${EVIDENCE_COMMAND_FAMILIES}.${notice} Run objective: ${run.objective}`.
// Reconstructed from the SAME exported constant the runtime uses, so this is the
// template rather than a transcription of one observed string.
const PLAN_CHECK_HEAD =
  `Mechanically verify the plan: claimed paths, requirement coverage, evidence commands. Recognized evidence commands: ${EVIDENCE_COMMAND_FAMILIES}.`;

// Everything ticketObjective interpolated as `${notice}`: for a plan-check ticket
// that is exactly PLAN_ARTIFACT_NOTICE, because the four-arm stageNotice chain
// (service.js:455-461) returns '' for a stage with no required checks, not the
// reviewer role and not remediation-test.
function noticeRegion(objective, head = PLAN_CHECK_HEAD) {
  expect(typeof objective).toBe('string');
  expect(objective.startsWith(head)).toBe(true);
  expect(objective.endsWith(SUFFIX)).toBe(true);
  const cut = objective.length - SUFFIX.length;
  expect(objective[cut - 1]).toBe(' ');
  return objective.slice(head.length, cut - 1);
}

function startInput(overrides = {}) {
  return {
    objective: RUN_OBJECTIVE,
    mode: 'phase',
    lane: 'full',
    host: 'codex',
    claimed_paths: ['src/value.js'],
    test_paths: ['tests/value.test.js'],
    requirements: ['R1'],
    risk_triggers: [],
    behavioral: true,
    hooks_trusted: true,
    subagents_available: true,
    explicit_invocation: true,
    ...overrides,
  };
}

function receipt(ticket, overrides = {}) {
  return {
    ticket_id: ticket.ticket_id,
    status: 'passed',
    agent_identity: `agent-${ticket.role}`,
    tests: [],
    findings: [],
    evidence: { verdict: 'pass' },
    timing: {
      started_at: ticket.issued_at,
      completed_at: new Date(Date.parse(ticket.issued_at) + 10).toISOString(),
      duration_ms: 10,
    },
    ...overrides,
  };
}

function readDiskTicket(dir, ticket) {
  const paths = runtimePaths(dir);
  return readJson(path.join(paths.tickets, `${ticket.ticket_id.replaceAll(':', '_')}.json`));
}

// Drive the REAL service from START through a passed planner receipt to the
// pending plan-review pair. Direct service imports return FULL tickets, so the
// wire projection can never mask or manufacture a field.
async function walkToPlanReview(dir, evidence) {
  const started = await startRun(dir, startInput());
  expect(started.ok, JSON.stringify(started.errors ?? [])).toBe(true);
  expect(started.run.lane).toBe('full');
  const planTicket = started.run.tickets[0];
  expect(planTicket.stage_id).toBe('plan');
  const recorded = await recordReceipt(dir, receipt(planTicket, { evidence }));
  expect(recorded.ok, JSON.stringify(recorded.errors ?? [])).toBe(true);
  const planCheck = recorded.run.tickets.find((ticket) => ticket.stage_id === 'plan-check');
  const planCritic = recorded.run.tickets.find((ticket) => ticket.stage_id === 'plan-critic');
  expect(planCheck?.role).toBe('plan_checker');
  expect(planCritic?.role).toBe('plan_critic');
  return { planCheck, planCritic };
}

// One plan-review walk, reduced to the artifact the two group members carry.
// Group parity, on-disk parity and schema validity ride along for free on every
// artifact this suite observes.
async function renderArtifact(evidence) {
  const dir = await project();
  const { planCheck, planCritic } = await walkToPlanReview(dir, evidence);
  const entries = planCheck.plan_artifact;
  expect(Array.isArray(entries), 'the plan-check ticket carries no plan_artifact at all').toBe(true);
  expect(planCritic.plan_artifact).toEqual(entries);
  const disk = await readDiskTicket(dir, planCheck);
  expect(disk.plan_artifact).toEqual(entries);
  expect(validateTicket(disk).valid).toBe(true);
  return entries;
}

// Memoized by label so the fixed evidences below cost one service walk each
// across the whole file. Values are plain arrays, so the scratch project they
// came from is cleaned up normally.
const rendered = new Map();
function artifactFor(label, evidence) {
  if (!rendered.has(label)) rendered.set(label, renderArtifact(evidence));
  return rendered.get(label);
}

const pad = (index) => String(index).padStart(2, '0');
const planKey = (index) => `k${pad(index)}`;
// Front-loaded so it survives the per-entry cut: a marker that interpolated a
// dropped key's VALUE would carry this tag.
const planTag = (index) => `PLANVALUE${pad(index)}`;

// Evidence of a realistic oversized shape: every value overruns the char cap, so
// every planner entry is cut and the marker cannot hide behind a short entry.
function widePlan(count) {
  const evidence = {};
  for (let index = 0; index < count; index += 1) {
    evidence[planKey(index)] = `${planTag(index)} ${'v'.repeat(2000)}`;
  }
  return evidence;
}

// PLAN_ARTIFACT_MAX_ENTRIES and PLAN_ARTIFACT_MAX_CHARS are unexported bare
// consts: both are read back out of ONE observed oversized artifact instead.
let capsPromise;
function caps() {
  capsPromise ??= (async () => {
    const entries = await artifactFor('wide-16', widePlan(16));
    const maxEntries = entries.length;
    expect(maxEntries).toBeGreaterThan(1);
    expect(maxEntries).toBeLessThan(16);
    const truncated = entries.find((entry) => entry.endsWith('…'));
    expect(typeof truncated, 'no entry of an oversized plan was cut').toBe('string');
    expect(truncated.length).toBeGreaterThan(20);
    return { maxEntries, maxChars: truncated.length };
  })();
  return capsPromise;
}

function digitRuns(text) {
  return text.match(/\d+/g) ?? [];
}

// The marker with its one decimal count replaced, so two markers that differ
// ONLY in that count compare equal (C4: runtime-authored and fixed except for
// one decimal). A standalone count is never a digit of a larger number.
function skeleton(marker, count) {
  return marker.replace(new RegExp(`(?<!\\d)${count}(?!\\d)`, 'g'), '{N}');
}

// The shape every planner-derived entry provably has today, stated FORWARD only
// (C6): renderPlanArtifactEntry emits `${key}: ${rendered}` and boundedGateSummary
// only flattens whitespace, trims, and slices the TAIL — so the ':' at index
// key.length survives unless the cut lands before it, in which case the entry is
// exactly the char cap and ends U+2026. This is a PRESERVED-INVARIANT guard: it
// is what makes an unforgeable marker shape available at all. It is never
// asserted of the marker itself, because neutralization is an equally valid
// route to the same guarantee.
function plannerShaped(entry, maxChars) {
  return (entry.length === maxChars && entry.endsWith('…')) || entry.includes(': ') || entry.endsWith(':');
}

// Every way a planner could try to name an evidence key after the OBSERVED
// marker, including the padded variants that exploit a cap which eats suffixes.
function forgeryAttempts(marker) {
  const attempts = [];
  const separator = marker.indexOf(': ');
  if (separator > 0) {
    attempts.push(['split', marker.slice(0, separator), marker.slice(separator + 2)]);
    attempts.push(['split-padded', marker.slice(0, separator), `${marker.slice(separator + 2)}${'X'.repeat(600)}`]);
  }
  if (marker.endsWith(':')) attempts.push(['trailing-colon', marker.slice(0, -1), '']);
  attempts.push(['key-is-marker', marker, '']);
  attempts.push(['key-and-value', marker, marker]);
  attempts.push(['padded-key', `${marker}${'X'.repeat(600)}`, 'value']);
  return attempts;
}

async function read(relative) {
  return readFile(new URL(`../${relative}`, import.meta.url), 'utf8');
}

function flat(text) {
  return text.replace(/\s+/g, ' ').trim();
}

// prompts/common.md is a bullet list; the plan_artifact clause is a parenthetical
// of ONE bullet it shares with review_findings and prior_attempts (C7).
function bulletsMentioning(text, needle) {
  return text
    .split(/\n(?=- )/)
    .filter((chunk) => chunk.includes(needle))
    .join(' ');
}

function paragraphsMentioning(text, needle) {
  return text
    .split(/\n\s*\n/)
    .filter((chunk) => chunk.includes(needle))
    .join(' ');
}

// ─── THE PUBLISHED DISCRIMINATOR (arm (l), S1) ──────────────────────────────
//
// Arm (f) drives the exact near-forgery — its 'padded-key' attempt renders a
// colon-free, brand-opening entry of exactly the per-entry cap — but asserts
// only BYTE-inequality with the observed marker. Byte-equality is impossible on
// ANY tree (the marker sits well inside the cap while a cap-cut entry is exactly
// the cap and ends U+2026), so that assertion is green whether or not the S1
// guarantee holds, and nothing pins the entry it constructs.
//
// What a reader acts on is not byte-equality. It is the RULE the runtime
// publishes for telling its own marker apart, and the invariant is that the rule
// is SOUND: the runtime's own marker satisfies it and nothing a planner can
// author does. Note the DIRECTION — a planner-derived line that a reader reads
// as the runtime saying "N keys were dropped" buys the plan LENIENCY, and it
// needs no marker to fire at all, so the case below stays UNDER the entry cap
// where every observed entry is planner-derived.
//
// THE RULE IS READ BACK OUT of each published surface rather than transcribed,
// so this arm follows a rewording instead of freezing today's wording, and it
// pins no mechanism: a tree that neutralizes every brand-opening entry at the
// render chokepoint and a tree that publishes the full runtime-only shape on all
// four reader surfaces both satisfy it. Only a tree where the published rule is
// looser than what the runtime enforces fails.

// The literal a reader is told the marker OPENS with, derived rather than
// transcribed: the longest prefix of the OBSERVED marker that the published
// notice itself carries. Retuning the brand moves both together.
function publishedOpener(marker, notice) {
  for (let width = marker.length; width > 0; width -= 1) {
    const candidate = marker.slice(0, width);
    if (notice.includes(candidate)) return candidate;
  }
  return '';
}

// The published rule is the prose AROUND that literal, not the whole surface:
// every surface also — correctly — says that a CUT ENTRY ends in an ellipsis,
// which is a statement about planner entries, not about the marker.
const RULE_WINDOW_BEFORE = 300;
const RULE_WINDOW_AFTER = 450;
function markerRule(text, opener) {
  if (opener === '') return '';
  const flatText = flat(text);
  const at = flatText.indexOf(opener);
  if (at < 0) return '';
  return flatText.slice(Math.max(0, at - RULE_WINDOW_BEFORE), at + opener.length + RULE_WINDOW_AFTER);
}

// Every observable condition a published rule can put on the marker beyond
// "opens with that literal", paired with the check a reader would actually run.
// A condition joins the rule only when the surface STATES it, so tightening the
// wording tightens the rule this arm enforces — and leaving it loose does not.
const MARKER_CONDITIONS = [
  {
    id: 'colon-free',
    stated: /colon[-\s]?free|\bno colon\b|without a colon|carries no colon/i,
    holds: (entry) => !entry.includes(':'),
  },
  {
    id: 'inside the per-entry cap',
    stated:
      /(?:shorter|smaller|briefer|fewer|less) than [^.;:]{0,48}(?:cap|bound|limit|width|maximum|characters)|(?:under|below|inside|within) (?:the )?[^.;:]{0,48}(?:cap|bound|limit|width|maximum)|never (?:reaches|fills|hits) [^.;:]{0,48}(?:cap|bound|limit|width)/i,
    holds: (entry, maxChars) => entry.length < maxChars,
  },
  {
    id: 'never ellipsis-terminated',
    stated: /\b(?:not|never|no|without|neither)\b[^.;:]{0,60}(?:ellipsis|…)/i,
    holds: (entry) => !entry.endsWith('…'),
  },
];

// The keys a planner can actually author against that rule, INCLUDING THE ONE
// THE CAP ITSELF CREATES: a key longer than the per-entry cap that opens with
// the published literal and carries no colon. renderPlanArtifactEntry emits
// `${key}: ${value}`, so the ':' sits at index key.length — past the cut — and
// the rendered entry is exactly the cap, ends U+2026, is COLON-FREE and opens
// with the literal, while never being byte-equal to the marker. Held under the
// entry cap so no runtime marker fires and every observed entry is planner-
// derived.
function nearForgeries(marker, opener, maxChars) {
  const padding = maxChars * 3;
  return {
    alpha_filler: 'alpha',
    [`${marker}${'X'.repeat(padding)}`]: 'the whole marker as a key, padded past the cap',
    [`${opener} ${'y'.repeat(padding)}`]: 'the published literal alone, padded past the cap',
    [`${opener}${'z'.repeat(padding)}`]: `${opener} in the value too`,
    [marker]: '',
    [`${opener} short`]: 'short',
    omega_filler: 'omega',
  };
}

describe('APE v2 plan artifact omission marker', () => {
  it('(a) more keys than the cap spends the LAST slot on a runtime-authored marker naming the exact dropped count', async () => {
    const { maxEntries, maxChars } = await caps();
    const entries = await artifactFor('wide-16', widePlan(16));

    // The hard invariant: the marker takes one of the existing slots rather than
    // adding a thirteenth, so no wire arithmetic moves.
    expect(entries).toHaveLength(maxEntries);

    // Only cap-1 planner entries are rendered, and they are the first recorded
    // keys, unchanged.
    const survivors = entries.slice(0, maxEntries - 1);
    survivors.forEach((entry, index) => {
      expect(entry.startsWith(`${planKey(index)}: ${planTag(index)}`), `slot ${index} is not the ${planKey(index)} entry: ${entry.slice(0, 60)}`).toBe(true);
      expect(entry).toHaveLength(maxChars);
      expect(entry.endsWith('…')).toBe(true);
    });

    const marker = entries.at(-1);
    // Runtime-authored (C4): no key name, no value, no planner text at all.
    expect(marker, 'the last slot is still a planner-derived entry').not.toMatch(/k\d\d/);
    for (let index = maxEntries - 1; index < 16; index += 1) {
      expect(marker).not.toContain(planKey(index));
      expect(marker).not.toContain(planTag(index));
    }
    expect(marker).not.toContain('v'.repeat(20));
    // Inside the SAME per-entry bound, and whitespace-flattened like every entry.
    expect(marker.length).toBeGreaterThan(0);
    expect(marker.length).toBeLessThanOrEqual(maxChars);
    expect(marker).not.toMatch(/[\n\r\t]/);
    // THE EXACT DECIMAL (C3): 16 recorded keys minus the 11 entries emitted is
    // 5. An implementation reporting `keys - cap` would say 4 and pass a
    // presence-only assertion.
    expect(digitRuns(marker), `the marker does not report 5 dropped keys: ${marker}`)
      .toContain(String(16 - (maxEntries - 1)));
  }, 60_000);

  it('(b) at the cap+1 boundary TWO keys drop, not one, and the marker text is fixed except for that one decimal', async () => {
    const { maxEntries } = await caps();
    const boundaryKeys = maxEntries + 1;
    const boundary = await artifactFor('wide-boundary', widePlan(boundaryKeys));
    const oversized = await artifactFor('wide-16', widePlan(16));

    expect(boundary).toHaveLength(maxEntries);
    // The surviving slots are identical in both runs: the same first cap-1 keys.
    expect(boundary.slice(0, maxEntries - 1)).toEqual(oversized.slice(0, maxEntries - 1));

    const boundaryMarker = boundary.at(-1);
    const oversizedMarker = oversized.at(-1);
    const boundaryDropped = boundaryKeys - (maxEntries - 1);
    const oversizedDropped = 16 - (maxEntries - 1);
    expect(boundaryDropped).toBe(2);

    expect(digitRuns(boundaryMarker), `cap+1 keys must report ${boundaryDropped} dropped, not 1: ${boundaryMarker}`)
      .toContain(String(boundaryDropped));
    expect(digitRuns(oversizedMarker)).toContain(String(oversizedDropped));
    // C4: the two markers differ ONLY in that decimal. A marker that also
    // interpolated the recorded key count, or any other varying text, would
    // differ here after the dropped count is masked out.
    expect(boundaryMarker).not.toBe(oversizedMarker);
    expect(
      skeleton(boundaryMarker, boundaryDropped),
      'the marker varies by more than its one dropped-count decimal',
    ).toBe(skeleton(oversizedMarker, oversizedDropped));
  }, 60_000);

  it('(c) at exactly the cap nothing drops, so POSITION alone can never identify the marker', async () => {
    const { maxEntries } = await caps();
    const atCap = await artifactFor('wide-at-cap', widePlan(maxEntries));
    const oversized = await artifactFor('wide-16', widePlan(16));

    expect(atCap).toHaveLength(maxEntries);
    atCap.forEach((entry, index) => {
      expect(entry.startsWith(`${planKey(index)}: ${planTag(index)}`), `slot ${index} is not the ${planKey(index)} entry`).toBe(true);
    });
    // Byte-identical to the oversized run wherever both carry planner entries.
    expect(atCap.slice(0, maxEntries - 1)).toEqual(oversized.slice(0, maxEntries - 1));

    // S1: when nothing drops, a PLANNER entry occupies the last slot. So the
    // reader's rule cannot be positional — and the two last slots must differ.
    expect(atCap.at(-1), 'the last slot is the same bytes whether or not keys were dropped')
      .not.toBe(oversized.at(-1));
  }, 60_000);

  it('(d) S2 carve-out — evidence at or under the cap renders byte-identical to today, with no marker', async () => {
    const evidence = {
      verdict: 'pass',
      summary: 'Disclose the bound to the readers and mark the drop',
      design: { approach: 'spend the last slot', files: ['lib/runtime/service.js'] },
      test_arms: ['marker', 'disclosure'],
      risks: '  a reviewer could\ttreat a cut tail\n\nas an absence  ',
      residuals: 3,
    };
    const entries = await artifactFor('under-cap-mixed', evidence);

    expect(entries).toEqual([
      'verdict: pass',
      'summary: Disclose the bound to the readers and mark the drop',
      'design: {"approach":"spend the last slot","files":["lib/runtime/service.js"]}',
      'test_arms: ["marker","disclosure"]',
      'risks: a reviewer could treat a cut tail as an absence',
      'residuals: 3',
    ]);
  }, 60_000);

  it('(e) C5 — the same recorded evidence renders the same artifact bytes in an independent run', async () => {
    const first = await artifactFor('wide-16', widePlan(16));
    const second = await renderArtifact(widePlan(16));
    expect(second).toEqual(first);
  }, 60_000);
});

describe('APE v2 plan artifact marker unforgeability (S1)', () => {
  it('(f) a planner key crafted from the OBSERVED marker cannot reproduce it, and non-colliding entries stay byte-identical', async () => {
    const { maxEntries } = await caps();
    const oversized = await artifactFor('wide-16', widePlan(16));
    const marker = oversized.at(-1);

    for (const [label, key, value] of forgeryAttempts(marker)) {
      const evidence = { alpha_filler: 'alpha', [key]: value, omega_filler: 'omega' };
      const keys = Object.keys(evidence);
      expect(keys.length).toBeLessThanOrEqual(maxEntries);
      const entries = await renderArtifact(evidence);

      // Under the cap: every key still gets its entry and no slot is spent on a
      // marker.
      expect(entries, `${label}: an under-cap plan changed entry count`).toHaveLength(keys.length);
      // THE S1 GUARANTEE: a planner cannot put the runtime's marker into the
      // artifact, however it names its keys.
      expect(entries, `${label}: a planner-derived entry reproduced the runtime marker`)
        .not.toContain(marker);
      // S2: the neutralization is targeted, not global — everything that did not
      // collide is byte-identical to today.
      expect(entries).toContain('alpha_filler: alpha');
      expect(entries).toContain('omega_filler: omega');
    }
  }, 120_000);

  it('(g) over arbitrary planner evidence the marker is byte-identical and no planner entry equals it', async () => {
    const { maxEntries, maxChars } = await caps();
    const marker = (await artifactFor('wide-16', widePlan(16))).at(-1);

    // Adversarial content the `<key>: <value>` renderer has to survive: colons,
    // the ellipsis the cut convention uses, whitespace runs, JSON punctuation and
    // non-ASCII. Keys carry a unique index suffix so all 16 are distinct,
    // non-empty and never integer-index (which ECMAScript would hoist).
    const units = [': ', ':', ' ', '  ', '…', '\n', '\t', '"', '\\', '{', '}', '[', ']', 'a', 'Z', '0', '9', 'é', '→', 'PLANVALUE', 'v'];
    const textArb = fc
      .array(fc.constantFrom(...units), { minLength: 0, maxLength: 10 })
      .map((parts) => parts.join(''));
    const valueArb = fc
      .tuple(textArb, fc.nat({ max: 400 }))
      .map(([text, width]) => `${text}${'w'.repeat(width)}`);
    const evidenceArb = fc
      .array(fc.tuple(textArb, valueArb), { minLength: 16, maxLength: 16 })
      .map((pairs) => Object.fromEntries(pairs.map(([key, value], index) => [`${key}#${index}`, value])));

    await fc.assert(
      fc.asyncProperty(evidenceArb, async (evidence) => {
        expect(Object.keys(evidence)).toHaveLength(16);
        const entries = await renderArtifact(evidence);
        expect(entries).toHaveLength(maxEntries);

        // C4/C5: same dropped count, same marker bytes — whatever the planner
        // wrote. An implementation that interpolated any planner text would
        // differ here from the calibration run.
        expect(entries.at(-1), 'the last slot varies with the planner text').toBe(marker);

        for (const entry of entries.slice(0, -1)) {
          expect(entry).not.toBe(marker);
          expect(entry.length).toBeLessThanOrEqual(maxChars);
          // PRESERVED INVARIANT: the renderer keeps every planner entry inside
          // the shape an unforgeable marker can stand outside of.
          expect(plannerShaped(entry, maxChars), `planner entry escaped the rendered shape: ${entry.slice(0, 60)}`).toBe(true);
        }
      }),
      // endOnFailure: shrinking would re-drive the whole service per candidate.
      { seed: SEED, numRuns: 4, endOnFailure: true },
    );
  }, 120_000);
});

describe('APE v2 plan artifact truncation disclosure to its readers', () => {
  it('(h) both plan reviewers receive the same bounded artifact under the immutable objective', async () => {
    const { maxEntries, maxChars } = await caps();
    const dir = await project();
    const { planCheck, planCritic } = await walkToPlanReview(dir, widePlan(16));
    expect(planCheck.objective).toBe(RUN_OBJECTIVE);
    expect(planCritic.objective).toBe(RUN_OBJECTIVE);
    expect(planCheck.plan_artifact).toEqual(planCritic.plan_artifact);
    expect(planCheck.plan_artifact).toHaveLength(maxEntries);
    expect(planCheck.plan_artifact.every((entry) => entry.length <= maxChars)).toBe(true);
    expect(planCheck.plan_artifact.at(-1)).toMatch(/dropped whole|truncated/i);
  }, 60_000);

  it('(i) reader prompts stay transport-neutral and treat incomplete material as unseen', async () => {
    const { maxEntries, maxChars } = await caps();

    for (const file of ['prompts/plan_checker.md', 'prompts/plan_critic.md', 'prompts/plan_judge.md']) {
      const text = flat(await read(file));
      expect.soft(digitRuns(text), `${file}: hardcodes the entry cap`).not.toContain(String(maxEntries));
      expect.soft(digitRuns(text), `${file}: hardcodes the char cap`).not.toContain(String(maxChars));
      expect.soft(text, `${file}: still promises the planner's own key order`).not.toMatch(KEY_ORDER_FALSE);
      expect.soft(text, `${file}: lost the untrusted-claim framing`).toMatch(/untrusted claim/i);
      expect.soft(text, `${file}: lost incomplete-channel handling`).toMatch(/missing|truncated|omitted|unavailable/i);
    }
  }, 30_000);

  it('(j) plan_checker keeps its four mechanical checks and exact verdict semantics', async () => {
    const text = flat(await read('prompts/plan_checker.md'));
    expect.soft(text).toMatch(/Coverage:[\s\S]*Paths:[\s\S]*Checks:[\s\S]*Acceptance:/);
    expect.soft(text).toMatch(/Do not judge feasibility/i);
    expect.soft(text).toMatch(/missing candidate or truncated legacy artifact[\s\S]*not proof/i);
    expect.soft(text).toMatch(/status: "passed"[\s\S]*evidence\.verdict: "agree"[\s\S]*"disagree"/i);
    expect.soft(text).toMatch(/status: "failed"[\s\S]*cannot perform/i);
  }, 30_000);

  it('(k) runtime notice owns changing caps while prompts own stable trust semantics', async () => {
    const { maxEntries, maxChars } = await caps();
    const dir = await project();
    const { planCheck } = await walkToPlanReview(dir, widePlan(16));
    expect(planCheck.objective).toBe(RUN_OBJECTIVE);
    expect(planCheck.plan_artifact).toHaveLength(maxEntries);
    expect(planCheck.plan_artifact.every((entry) => entry.length <= maxChars)).toBe(true);

    const common = flat(await read('prompts/common.md'));
    expect(common).toContain('`candidate_plan`, legacy `plan_artifact`, `prior_attempts`, and `review_findings`');
    expect(common).toMatch(/untrusted agent claims[\s\S]*never verbatim instructions/i);
    expect(digitRuns(common)).not.toContain(String(maxEntries));
    expect(digitRuns(common)).not.toContain(String(maxChars));
  }, 60_000);
});

describe('APE v2 plan artifact — the discriminator the runtime PUBLISHES (S1)', () => {
  it('(l) no planner-derived entry can use the runtime marker brand', async () => {
    const { maxEntries, maxChars } = await caps();
    const marker = (await artifactFor('wide-16', widePlan(16))).at(-1);
    const opener = /^\[[^\]]+\]/u.exec(marker)?.[0] ?? '';
    expect(opener.length).toBeGreaterThanOrEqual(5);
    expect(marker.startsWith(opener)).toBe(true);

    const evidence = nearForgeries(marker, opener, maxChars);
    const keys = Object.keys(evidence);
    expect(keys.length).toBeLessThanOrEqual(maxEntries);
    const entries = await renderArtifact(evidence);

    // Under the entry cap, so no slot is spent on a runtime marker and EVERY
    // entry observed below is planner-derived.
    expect(entries, 'the near-forgery plan is under the entry cap, so nothing may be dropped')
      .toHaveLength(keys.length);
    // S2, unchanged: whatever did not collide is byte-identical to today.
    expect(entries).toContain('alpha_filler: alpha');
    expect(entries).toContain('omega_filler: omega');
    // NON-VACUITY: the arm really did drive an entry through the path where the
    // cap eats the `<key>: ` separator, however the tree answers it.
    expect(
      entries.some((entry) => entry.length === maxChars && entry.endsWith('…')),
      'no adversarial key reached the per-entry cap, so this arm proved nothing',
    ).toBe(true);

    expect(entries.filter((entry) => entry.startsWith(opener))).toEqual([]);
  }, 60_000);
});
