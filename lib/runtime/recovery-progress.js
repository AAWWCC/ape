import { canonicalJson, hashRecord, sha256 } from './canonical.js';
import { GENERAL_INPUT_MAX_BYTES } from './input-guard.js';
import { reviewFindings } from './review-evidence.js';

// Pure decisions: callers persist the returned episode in their existing
// serialized transaction. Identity and prose never constitute progress.
export function recoveryDecision(history = [], observation) {
  const blockers = observation.blockers;
  const valid = Array.isArray(blockers) && blockers.length > 0 &&
    blockers.every((value) => typeof value === 'string' && value.length > 0);
  const current = { version: 1, blockers: valid ? [...new Set(blockers)].sort() : [],
    artifact: observation.artifact ?? null };
  const identity = sha256(current.blockers);
  const previous = history.at(-1);
  const resolved = previous?.blockers.filter((value) => !current.blockers.includes(value)) ?? [];
  const reintroduced = history.slice(0, -1).some((entry) =>
    entry.blockers.some((value) => !previous.blockers.includes(value) && current.blockers.includes(value)));
  const reason = !valid ? 'missing_evidence'
    : history.some((entry) => entry.identity === identity) || reintroduced ? 'repeated_or_cyclic_failure'
    : previous && (!resolved.length || observation.material !== true) ? 'stalled_progress'
    : 'evidenced_recovery';
  const next = [...history, { ...current, identity }];
  const resource = Buffer.byteLength(JSON.stringify(next), 'utf8') > GENERAL_INPUT_MAX_BYTES;
  return { version: 1, continue: reason === 'evidenced_recovery' && !resource,
    reason_code: resource ? 'recovery_evidence_resource_limit' : reason,
    resolved, remaining: current.blockers.filter((value) => previous?.blockers.includes(value)),
    added: current.blockers.filter((value) => !previous?.blockers.includes(value)),
    history: resource ? history : next };
}

// The judge, not a prose-difference heuristic, decides whether a repair resolves
// a defect. The runtime binds that decision to exact prior/current plans and
// related coverage. Whitespace, ordering and duplicate entries are not changes.
export const PLAN_IMPLEMENTATION_ASSURANCE_FIELDS = Object.freeze([
  'feasibility', 'failure_modes', 'crash_recovery', 'migration', 'determinism',
]);
const normalizedPlanText = (value) => typeof value === 'string'
  ? value.normalize('NFC').replace(/\s+/gu, ' ').trim() : '';
const planTextSet = (values) => new Set(values.flat().map(normalizedPlanText).filter(Boolean));
const validCandidate = (candidate) => Boolean(candidate?.plan && candidate.plan_hash === sha256(candidate.plan));

export function planRecoveryContextForState(state) {
  const recovery = state.plan_recovery;
  if (!recovery) return undefined;
  const source = state.tickets?.find((entry) => entry.ticket_id === recovery.source_ticket_id);
  if (source?.role !== 'plan_judge' || source.stage_id !== 'plan-judge' ||
      source.ticket_hash !== hashRecord(source, ['ticket_hash']) || !validCandidate(source.candidate_plan)) {
    throw new Error('prior immutable plan judge context is unavailable');
  }
  return { version: 1, source_ticket_hash: source.ticket_hash,
    previous_candidate: structuredClone(source.candidate_plan) };
}

export function hasPlanResolutionContract(ticket) {
  return ticket?.execution_limits?.version === 4 && ticket.role === 'plan_judge' &&
    ticket.stage_id === 'plan-judge' && ticket.plan_recovery_context?.version === 1 &&
    Boolean(ticket.plan_recovery && ticket.candidate_plan);
}

export function planBlockerIdentity(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const identity = entry.requirement_id ?? entry.risk_trigger;
  const anchor = entry.evidence_anchor;
  const groundedAnchor = typeof anchor === 'string' && !/^(receipt|ticket):/.test(anchor) ? anchor : '';
  return identity || groundedAnchor ? `${identity ?? 'anchor'}:${groundedAnchor}` : null;
}

function relatedWorkstreams(plan, assurance) {
  const requirement = plan.requirements?.find((entry) => entry.id === assurance.requirement_id);
  return (plan.workstreams ?? []).filter((entry) => requirement?.workstreams.includes(entry.id));
}

function coverage(plan, assurance, anchor, kind) {
  if (!anchor || typeof anchor !== 'object') return null;
  const keys = Object.keys(anchor).sort().join(',');
  if (typeof anchor.workstream_id === 'string') {
    const field = kind === 'implementation' ? 'steps' : 'acceptance';
    if (keys !== 'field,index,workstream_id' || anchor.field !== field ||
        !Number.isSafeInteger(anchor.index) || anchor.index < 0) return null;
    const linked = relatedWorkstreams(plan, assurance);
    const owner = linked.find((entry) => entry.id === anchor.workstream_id);
    const text = owner?.[field]?.[anchor.index];
    return typeof text === 'string' ? { text: normalizedPlanText(text) } : null;
  }
  const fields = kind === 'implementation' ? PLAN_IMPLEMENTATION_ASSURANCE_FIELDS : ['executable_tests'];
  if (typeof anchor.assurance_id !== 'string' || !fields.includes(anchor.field) ||
      !['assurance_id,field', 'assurance_id,field,index'].includes(keys)) return null;
  const owner = plan.assurances?.find((entry) => entry.id === anchor.assurance_id &&
    entry.risk_trigger === assurance.risk_trigger);
  const value = owner?.[anchor.field];
  const text = Array.isArray(value)
    ? Number.isSafeInteger(anchor.index) && anchor.index >= 0 ? value[anchor.index] : null
    : anchor.index === undefined ? value : null;
  return typeof text === 'string' ? { text: normalizedPlanText(text) } : null;
}

function previousCoverage(plan, assurance, anchor, kind) {
  if (anchor.workstream_id !== undefined) {
    const field = kind === 'implementation' ? 'steps' : 'acceptance';
    return planTextSet(relatedWorkstreams(plan, assurance).flatMap((entry) => entry[field] ?? []));
  }
  const owners = (plan.assurances ?? []).filter((entry) => entry.risk_trigger === assurance.risk_trigger);
  return planTextSet(owners.flatMap((entry) => entry[anchor.field] ?? []));
}

export function validatePlanResolutionEvidence(ticket, receipt) {
  const evidence = receipt?.evidence?.plan_resolutions;
  if (evidence === undefined) return [];
  // Historical evidence was extensible. Preserve its acceptance and schema;
  // an unadvertised field can never authorize a new recovery decision.
  if (!hasPlanResolutionContract(ticket)) return [];
  const reject = (reason) => [`evidence.plan_resolutions ${reason}`];
  const previous = ticket.plan_recovery_context.previous_candidate;
  const current = ticket.candidate_plan;
  if (receipt.ticket_id !== ticket.ticket_id || receipt.status !== 'passed' ||
      !['agree', 'disagree'].includes(receipt.evidence?.verdict)) {
    return reject('requires a completed independent plan judgment');
  }
  if (!validCandidate(previous) || !validCandidate(current) || evidence?.version !== 1 ||
      evidence.previous_plan_hash !== previous.plan_hash || evidence.candidate_plan_hash !== current.plan_hash ||
      Object.keys(evidence).sort().join(',') !== 'candidate_plan_hash,previous_plan_hash,resolved,version' ||
      !Array.isArray(evidence.resolved) || evidence.resolved.length === 0) {
    return reject('must bind the exact previous and current immutable candidates');
  }
  const seen = new Set();
  // Compare the same bounded, control-neutralized identities the reducer
  // persists. Raw receipt spelling must not make a still-open blocker vanish.
  const unresolved = reviewFindings.planRecovery({}, ticket, receipt).missing_assurances;
  for (const resolution of evidence.resolved) {
    const prior = ticket.plan_recovery.missing_assurances.find((entry) => entry.id === resolution?.prior_assurance_id);
    if (!prior || seen.has(prior.id) || Object.keys(resolution).sort().join(',') !==
        'acceptance_anchors,implementation_anchors,prior_assurance_id,rationale' ||
        !normalizedPlanText(resolution.rationale) ||
        unresolved.some((entry) => planBlockerIdentity(entry) === planBlockerIdentity(prior))) {
      return reject('must explicitly resolve a distinct prior blocker that is no longer unresolved');
    }
    seen.add(prior.id);
    const beforeRequirement = previous.plan.requirements?.find((entry) => entry.id === prior.requirement_id);
    const afterRequirement = current.plan.requirements?.find((entry) => entry.id === prior.requirement_id);
    if (beforeRequirement && (!afterRequirement || normalizedPlanText(beforeRequirement.requirement) !==
        normalizedPlanText(afterRequirement.requirement))) return reject('cannot resolve a blocker by changing its requirement');
    let changed = false;
    for (const kind of ['implementation', 'acceptance']) {
      const anchors = resolution[`${kind}_anchors`];
      if (!Array.isArray(anchors) || anchors.length === 0) return reject('requires implementation and acceptance anchors');
      for (const anchor of anchors) {
        const currentCoverage = coverage(current.plan, prior, anchor, kind);
        if (!currentCoverage?.text) return reject('contains a missing, unrelated or incorrectly typed coverage anchor');
        if (!previousCoverage(previous.plan, prior, anchor, kind).has(currentCoverage.text)) changed = true;
      }
    }
    if (!changed) return reject('requires changed related coverage; whitespace, ordering and duplicates do not count');
  }
  return [];
}

export function planRecoveryMaterial(state, ticket, receipt) {
  if (!hasPlanResolutionContract(ticket) || !receipt.evidence?.plan_resolutions ||
      validatePlanResolutionEvidence(ticket, receipt).length > 0 ||
      canonicalJson(ticket.plan_recovery) !== canonicalJson(state.plan_recovery)) return false;
  try {
    return canonicalJson(ticket.plan_recovery_context) === canonicalJson(planRecoveryContextForState(state));
  } catch { return false; }
}

export function blockerIdentity(finding) {
  if (!finding || typeof finding !== 'object') return null;
  // Free-form worker findings and review rendering accept both anchors.
  // Resolve the alias here without rewriting the attested receipt, so the
  // field spelling cannot lose evidence or buy another recovery episode.
  const file = [finding.file, finding.path].find((value) =>
    typeof value === 'string' && value.trim() !== '')?.trim();
  if (!file) return null;
  const identity = finding.id ?? finding.code ?? finding.requirement_id;
  return typeof identity === 'string' && identity.trim()
    ? `${file}:${identity.trim()}`
    : Number.isSafeInteger(finding.line) && finding.line > 0
      ? `${file}:line:${finding.line}:${finding.remediation?.owner ?? 'production'}`
      : null;
}
