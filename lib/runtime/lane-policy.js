import { RISK_TRIGGERS } from './constants.js';

// Must agree with pipeline.js's DOC_EXTENSIONS regex: an extension pipeline
// treats as documentation but this Set omits can never classify into the
// mechanical lane, stranding docs-only edits in fast (which demands tests).
// Tracked non-docs data files (benchmark reference runs, fixture corpora, test
// data) also earn mechanical scope, but only when BOTH hold: the extension is
// in DATA_EXTENSIONS AND the claim's FIRST path segment is exactly a DATA_DIRS
// name. The first segment is matched exactly — never by substring — so
// 'metadata/x.json' and 'lib/benchmarks/table.json' can never false-positive
// into the mechanical lane.
const DOC_EXTENSIONS = new Set(['.md', '.markdown', '.mdx', '.txt', '.rst', '.adoc', '.asciidoc']);
const DATA_EXTENSIONS = new Set(['.json', '.jsonl', '.ndjson', '.csv', '.tsv']);
const DATA_DIRS = new Set(['benchmarks', 'fixtures', 'testdata']);
// Generated/build output roots earn mechanical scope, but — like DATA_DIRS —
// only when the marker is the FIRST path segment, never an unanchored
// substring. This keeps ordinary production source that merely contains one of
// these words (e.g. 'src/schema-generated.ts', 'packages/build/src/index.ts',
// 'predist/x.js') out of the mechanical lane, which has no independent
// test-writer stage or code-review group.
const GENERATED_MARKERS = new Set(['generated', 'dist', 'build', 'vendor']);
const CONFIG_NAMES = new Set([
  '.editorconfig',
  '.gitattributes',
  '.gitignore',
  '.npmrc',
  'prettier.config.js',
  'eslint.config.js',
]);

function extension(path) {
  const base = path.split('/').at(-1) ?? '';
  const dot = base.lastIndexOf('.');
  return dot < 0 ? '' : base.slice(dot).toLowerCase();
}

function isMechanicalPath(path) {
  const normalized = path.replaceAll('\\', '/').toLowerCase();
  const ext = extension(normalized);
  if (DOC_EXTENSIONS.has(ext)) return true;
  if (DATA_EXTENSIONS.has(ext) && DATA_DIRS.has(normalized.split('/')[0])) return true;
  if (GENERATED_MARKERS.has(normalized.split('/')[0])) return true;
  return CONFIG_NAMES.has(normalized.split('/').at(-1));
}

export function classifyLane(input, policy = {}) {
  const claimed = [...new Set(input.claimed_paths ?? [])];
  const configuredLimit = Number.isInteger(policy.fast_max_files) ? policy.fast_max_files : 6;
  const triggers = new Set((input.risk_triggers ?? []).map((value) => String(value).toLowerCase()));
  const knownRisk = RISK_TRIGGERS.filter((trigger) => triggers.has(trigger));
  const allMechanical = claimed.length > 0 && claimed.every(isMechanicalPath);
  const requested = input.requested_lane;

  if (requested === 'full') {
    return { lane: 'full', reasons: ['requested-full'], risk_triggers: knownRisk };
  }
  if (requested === 'mechanical' || requested === 'fast') {
    const violations = knownRisk.map((risk) => `risk:${risk}`);
    if (requested === 'mechanical') {
      if (input.behavioral) violations.push('behavioral-change');
      if (!allMechanical) {
        violations.push(claimed.length === 0 ? 'unbounded-scope' : 'non-mechanical-scope');
      }
    } else if (claimed.length === 0 || claimed.length > configuredLimit) {
      violations.push(claimed.length === 0 ? 'unbounded-scope' : `scope-over-${configuredLimit}-files`);
    }
    if (violations.length === 0) {
      return { lane: requested, reasons: [`requested-${requested}`], risk_triggers: [] };
    }
    // The requested lane fails its bounds: escalate with an explicit reason
    // instead of silently ignoring the request.
    const withinFastBounds =
      knownRisk.length === 0 && claimed.length > 0 && claimed.length <= configuredLimit;
    return {
      lane: requested === 'mechanical' && withinFastBounds ? 'fast' : 'full',
      reasons: [`requested-${requested}-escalated`, ...violations],
      risk_triggers: knownRisk,
    };
  }
  if (!input.behavioral && allMechanical) {
    // Declared risk triggers are never silently dropped (D3): they ride along
    // on the mechanical lane so the caller persists high_risk and the
    // conditional security review arms. The lane deliberately does NOT
    // escalate to full here — full demands test_paths, which a non-behavioral
    // docs/config scope cannot truthfully supply, so escalation would turn a
    // legitimate high-risk mechanical start into a hard reject. Contrast the
    // requested-mechanical path above: an explicit lane request with a known
    // trigger escalates with a reason, because the operator asked for a lane
    // the declared risk forbids.
    return {
      lane: 'mechanical',
      reasons: ['non-behavioral-mechanical-scope', ...knownRisk.map((risk) => `risk:${risk}`)],
      risk_triggers: knownRisk,
    };
  }
  if (knownRisk.length > 0) {
    return { lane: 'full', reasons: knownRisk.map((risk) => `risk:${risk}`), risk_triggers: knownRisk };
  }
  if (claimed.length === 0 || claimed.length > configuredLimit) {
    return {
      lane: 'full',
      reasons: [claimed.length === 0 ? 'unbounded-scope' : `scope-over-${configuredLimit}-files`],
      risk_triggers: [],
    };
  }
  return { lane: 'fast', reasons: ['bounded-behavioral-scope'], risk_triggers: [] };
}

export function escalateLane(currentLane, input, policy = {}) {
  if (currentLane === 'full') return { lane: 'full', escalated: false, reasons: [] };
  const classified = classifyLane({ ...input, requested_lane: 'auto' }, policy);
  if (classified.lane === 'full') {
    return { ...classified, escalated: true };
  }
  if (currentLane === 'mechanical' && classified.lane === 'fast') {
    return { ...classified, escalated: true };
  }
  return { lane: currentLane, escalated: false, reasons: [] };
}
