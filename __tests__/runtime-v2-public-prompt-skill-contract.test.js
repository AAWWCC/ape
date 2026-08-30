import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PlanContractSchema, validatePreflightArtifact } from '../lib/runtime/plan-contract.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ROLES = [
  'preflight_analyst',
  'planner',
  'plan_checker',
  'plan_critic',
  'plan_judge',
  'test_writer',
  'implementer',
  'reviewer',
  'security_reviewer',
  'debugger',
  'spike_researcher',
];
const SKILLS = ['config', 'history', 'override', 'resume', 'roadmap', 'run', 'status'];
const ROLE_BUDGETS = {
  preflight_analyst: 260,
  planner: 220,
  plan_checker: 220,
  plan_critic: 220,
  plan_judge: 220,
  test_writer: 220,
  implementer: 220,
  reviewer: 220,
  security_reviewer: 220,
  debugger: 100,
  spike_researcher: 100,
};

async function read(...parts) {
  return readFile(path.join(ROOT, ...parts), 'utf8');
}

function words(text) {
  return text.trim().split(/\s+/u).filter(Boolean).length;
}

function agentPromptBody(text) {
  const match = text.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/u);
  if (!match) throw new Error('invalid agent frontmatter');
  return match[1];
}

function splitSkill(text) {
  const match = text.match(/^---\n([\s\S]*?)\n---\n\n([\s\S]*)$/u);
  if (!match) throw new Error('invalid skill frontmatter');
  const metadata = Object.fromEntries(match[1].split('\n').map((line) => {
    const separator = line.indexOf(':');
    const key = line.slice(0, separator);
    const raw = line.slice(separator + 1).trim();
    return [key, raw.startsWith('"') ? JSON.parse(raw) : raw];
  }));
  return { metadata, body: match[2] };
}

describe('public prompt contracts', () => {
  it('ships one common contract and eleven bounded role prompts', async () => {
    const files = (await readdir(path.join(ROOT, 'prompts'))).filter((name) => name.endsWith('.md')).sort();
    expect(files).toEqual(['common.md', ...ROLES.map((role) => `${role}.md`)].sort());
    expect(words(await read('prompts', 'common.md'))).toBeLessThanOrEqual(450);
    for (const role of ROLES) {
      expect(words(await read('prompts', `${role}.md`)), role).toBeLessThanOrEqual(ROLE_BUDGETS[role]);
    }
  });

  it('teaches every stage to quote Next.js dynamic-route paths before shell inspection', async () => {
    const common = await read('prompts', 'common.md');
    expect(common).toContain("cat 'app/[id]/page.tsx'");
    expect(common).toMatch(/Single-quote each Next\.js bracketed route operand/iu);
    expect(common).toContain('`[name]`');
    expect(common).toContain('`[...name]`');
    expect(common).toContain('`[[...name]]`');
  });

  it('permits one bounded same-stage correction for a denied harmless read', async () => {
    const common = await read('prompts', 'common.md');
    expect(common).toMatch(/first non-mutating-read shape denial[\s\S]*correct syntax[\s\S]*retry[\s\S]*once in-stage/iu);
    expect(common).toMatch(/If denied again[\s\S]*return `failed`[\s\S]*failure_kind: "command-shape"/iu);
  });

  it('keeps eleven Claude wrappers thin and common-before-role', async () => {
    const agentFiles = (await readdir(path.join(ROOT, 'agents'))).filter((name) => name.endsWith('.md')).sort();
    expect(agentFiles).toEqual(ROLES.map((role) => `${role.replaceAll('_', '-')}.md`).sort());
    for (const role of ROLES) {
      const wrapper = await read('agents', `${role.replaceAll('_', '-')}.md`);
      const common = wrapper.indexOf('${CLAUDE_PLUGIN_ROOT}/prompts/common.md');
      const specific = wrapper.indexOf(`\${CLAUDE_PLUGIN_ROOT}/prompts/${role}.md`);
      expect(common, role).toBeGreaterThan(-1);
      expect(specific, role).toBeGreaterThan(common);
      expect(wrapper).toMatch(/model: inherit/u);
      expect(words(agentPromptBody(wrapper)), role).toBeLessThanOrEqual(40);
    }
  });

  it('defines ordered authority, confinement, materiality, and the receipt schema once', async () => {
    const common = await read('prompts', 'common.md');
    const authority = [
      'Host/system instructions',
      "ticket's `objective`",
      'Repository evidence',
      '`approved_plan`',
      '`candidate_plan`, legacy `plan_artifact`, `prior_attempts`, and `review_findings`',
    ].map((marker) => common.indexOf(marker));
    expect(authority.every((index) => index >= 0)).toBe(true);
    expect(authority).toEqual([...authority].sort((left, right) => left - right));
    expect(common).toMatch(/Never write `\.ape\/`/u);
    expect(common).toMatch(/Read broadly enough to verify[\s\S]*write only paths authorized/u);
    expect(common).toMatch(/Never .*APE control tools.*APE skills.*spawn another agent/u);
    expect(common).toMatch(/Do not commit, push, merge, weaken tests/u);
    expect(common).toMatch(/unmet\s+objective[\s\S]*security[\s\S]*unauthorized scope[\s\S]*missing required evidence/iu);
    expect(common).toMatch(/Style preferences[\s\S]*equally valid[\s\S]*advisory only/iu);
    expect(common).toMatch(
      /`allowed_evidence_commands`[\s\S]*`command_profiles`[\s\S]*`required_capabilities`[\s\S]*execution[\s\S]*`tests`/iu,
    );
    expect(common).toMatch(
      /future-stage feasibility[\s\S]*`plannable_evidence_commands`[\s\S]*fallback[\s\S]*`planning_command_profiles`[\s\S]*`planning_required_capabilities`[\s\S]*Planning fields grant no execution authority/iu,
    );

    for (const field of ['ticket_id', 'status', 'tests', 'findings', 'evidence']) {
      expect(common, `receipt field ${field}`).toContain(`\`${field}\``);
    }
    expect(common).toMatch(/Return one JSON object with required/iu);
    expect(common).toMatch(/omit optional runtime-stamped `timing`/iu);
    for (const field of ['command', 'passed', 'exit_code', 'duration_ms', 'output_hash']) {
      expect(common, `test field ${field}`).toContain(`\`${field}\``);
    }
    expect(common).toContain('`evidence.summary`');
    expect(common).toMatch(/`evidence\.required_claims`[\s\S]*object, never an array/iu);
    for (const field of ['claimed_paths', 'test_paths', 'required_role']) {
      expect(common, `required claim field ${field}`).toContain(`\`${field}\``);
    }
    expect(common).toMatch(/plan_deviation[\s\S]*only[\s\S]*material deviation[\s\S]*approved_plan[\s\S]*otherwise omit/iu);
    expect(common).toMatch(/Plan review[\s\S]*"passed"[\s\S]*"agree"[\s\S]*"disagree"/u);
    expect(common).toMatch(/Code\/security review[\s\S]*"passed"[\s\S]*"pass"[\s\S]*"fail"/u);
    expect(common).toMatch(/stable final `draft`[\s\S]*omit timing[\s\S]*never generate timestamps during validation[\s\S]*ape_validate_receipt[\s\S]*corrections_remaining/iu);
    expect(common).toMatch(/`valid: true` is\s+terminal[\s\S]*no continuation action[\s\S]*return unchanged[\s\S]*never validate again/iu);
  });

  it('gives each role a distinct evidence-producing responsibility', async () => {
    const prompts = Object.fromEntries(await Promise.all(ROLES.map(async (role) => [
      role,
      (await read('prompts', `${role}.md`)).replace(/\s+/g, ' '),
    ])));
    expect(prompts.preflight_analyst).toMatch(/read.only[\s\S]*preflight_artifact/iu);
    expect(prompts.preflight_analyst).toMatch(/acceptance[\s\S]*non.goals[\s\S]*baseline/iu);
    expect(prompts.preflight_analyst).toMatch(/impacted[\s\S]*read[\s\S]*write/iu);
    expect(prompts.preflight_analyst).toMatch(/compatibility[\s\S]*rollback[\s\S]*question/iu);
    expect(prompts.preflight_analyst).toMatch(/verification[\s\S]*disposition/iu);
    for (const field of [
      '"version"', '"objective"', '"acceptance"', '"non_goals"', '"baseline"',
      '"impacted_paths"', '"compatibility"', '"rollback"', '"verification_profiles"',
      '"questions"',
    ]) {
      expect(prompts.preflight_analyst, `preflight artifact field ${field}`).toContain(field);
    }
    expect(prompts.preflight_analyst).toMatch(/every top-level field present and no other fields/iu);
    expect(prompts.preflight_analyst).toMatch(/at least one `acceptance` and one `baseline` entry/iu);
    expect(prompts.preflight_analyst).toMatch(/empty arrays only where the schema permits/iu);
    expect(prompts.preflight_analyst).toMatch(/Baseline entries contain only[\s\S]*execution metadata/iu);
    expect(prompts.plan_checker).toMatch(/Coverage:[\s\S]*Paths:[\s\S]*Checks:[\s\S]*Acceptance:/u);
    expect(prompts.plan_checker).toMatch(/Do not judge feasibility/u);
    expect(prompts.plan_critic).toMatch(/own feasibility review/u);
    expect(prompts.plan_critic).toMatch(/hidden scope[\s\S]*failure modes/u);
    expect(prompts.plan_judge).toMatch(/independently[\s\S]*Do not count votes/u);
    for (const role of ['plan_checker', 'plan_critic', 'plan_judge']) {
      expect(prompts[role]).toMatch(
        /`plannable_evidence_commands`[\s\S]*`planning_command_profiles`[\s\S]*`planning_required_capabilities`[\s\S]*execution view[\s\S]*no execution or[\s\S]*`tests` authority/iu,
      );
    }
    expect(prompts.test_writer).toMatch(/public behavior[\s\S]*mutually consistent[\s\S]*synthetic fixture/iu);
    expect(prompts.test_writer).toMatch(/Red must not depend on a defect remaining in live source/u);
    expect(prompts.test_writer).toMatch(/approved_plan[\s\S]*material deviation[\s\S]*plan_deviation[\s\S]*workstream_id[\s\S]*acceptance_impact[\s\S]*otherwise omit/iu);
    expect(prompts.planner).toMatch(/evidence\.candidate_plan[\s\S]*"version": 2[\s\S]*preflight_hash[\s\S]*verification_profiles/iu);
    expect(prompts.planner).toMatch(/untrusted[\s\S]*preflight/iu);
    expect(prompts.planner).toMatch(/16,384 UTF-8 bytes[\s\S]*receipt_contract[\s\S]*ape_validate_receipt/iu);
    expect(prompts.implementer).toMatch(/approved_plan[\s\S]*smallest complete change[\s\S]*plan_deviation[\s\S]*test-contradiction/u);
    expect(prompts.implementer).toMatch(/policy denials[\s\S]*command-shape[\s\S]*capability/iu);
    expect(prompts.implementer).toMatch(/approved_plan[\s\S]*materially deviates[\s\S]*plan_deviation[\s\S]*otherwise omit/iu);
    expect(prompts.implementer).toMatch(/test\s+path and location[\s\S]*reproducing command and result[\s\S]*no conforming implementation can pass/u);
    for (const risk of ['injection', 'secret', 'supply-chain', 'integrity', 'availability']) {
      expect(prompts.security_reviewer).toContain(risk);
    }
    for (const role of ['reviewer', 'security_reviewer']) {
      expect(prompts[role]).toMatch(/style|defense-in-depth/iu);
      expect(prompts[role]).toMatch(/advisory/u);
      expect(prompts[role]).toMatch(/`file`, `line`, `title`, and `detail`/u);
      expect(prompts[role]).toMatch(/"passed"[\s\S]*"pass"[\s\S]*"fail"/u);
    }
  });

  it('publishes a preflight artifact example accepted by the live strict schema', async () => {
    const preflight = await read('prompts', 'preflight_analyst.md');
    const block = preflight.match(/```json\n([\s\S]*?)\n```/u);
    expect(block).not.toBeNull();
    const artifact = JSON.parse(block[1]);
    artifact.objective = 'Add bounded behavior';
    artifact.acceptance = ['The behavior is observable'];
    artifact.non_goals = [];
    artifact.baseline = [{
      command: 'npm test',
      observation: 'The existing suite passes',
      output_hash: 'a'.repeat(64),
    }];
    artifact.impacted_paths = { read: ['package.json'], write: ['src/value.js'] };
    artifact.compatibility = 'Keep the existing public export.';
    artifact.rollback = 'Revert the implementation and focused test.';
    artifact.verification_profiles = [{
      id: 'unit',
      disposition: 'required',
      reason: 'The requested change is behavioral.',
    }];
    artifact.questions = [];

    const validated = validatePreflightArtifact(artifact, {
      objective: artifact.objective,
      claims: ['src/value.js'],
      profiles: [{ id: 'unit' }],
      tests: [{ command: 'npm test', output_hash: 'a'.repeat(64) }],
    });
    expect(validated.valid, JSON.stringify(validated.errors)).toBe(true);
    expect(Object.keys(artifact).sort()).toEqual([
      'acceptance', 'baseline', 'compatibility', 'impacted_paths', 'non_goals', 'objective',
      'questions', 'rollback', 'verification_profiles', 'version',
    ]);
    expect(Object.keys(artifact.baseline[0]).sort()).toEqual([
      'command', 'observation', 'output_hash',
    ]);
  });

  it('publishes a planner example accepted by the live PlanContract schema', async () => {
    const planner = await read('prompts', 'planner.md');
    const block = planner.match(/```json\n([\s\S]*?)\n```/u);
    expect(block).not.toBeNull();
    const example = JSON.parse(block[1]);
    expect(PlanContractSchema.safeParse(example)).toMatchObject({ success: true });
    expect(example.version).toBe(2);
    expect(Object.keys(example).sort()).toEqual([
      'assurances', 'non_goals', 'preflight_hash', 'requirements', 'risks', 'version', 'workstreams',
    ]);
  });

  it('contains no private run exemplars or historical incident identifiers', async () => {
    const all = await Promise.all(['common', ...ROLES].map((name) => read('prompts', `${name}.md`)));
    expect(all.join('\n')).not.toMatch(/\brun-\d{12,}-[a-z0-9]+\b|\bPR #\d+\b/iu);
  });
});

describe('canonical skill sources', () => {
  it('contains exactly seven non-discoverable neutral skill sources', async () => {
    const sourceRoot = path.join(ROOT, 'plugin-src', 'skills');
    const entries = (await readdir(sourceRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name !== 'references')
      .map((entry) => entry.name)
      .sort();
    expect(entries).toEqual(SKILLS);

    for (const name of SKILLS) {
      const files = (await readdir(path.join(sourceRoot, name))).sort();
      expect(files).toEqual(['body.md', 'metadata.json']);
      const metadata = JSON.parse(await read('plugin-src', 'skills', name, 'metadata.json'));
      expect(Object.keys(metadata).sort()).toEqual(
        (name === 'status' || name === 'resume'
          ? ['description', 'invocation', 'name']
          : ['argumentHint', 'description', 'invocation', 'name']).sort(),
      );
      expect(metadata).toMatchObject({ name, invocation: name === 'status' ? 'implicit' : 'explicit' });
      expect(metadata).not.toHaveProperty('disable-model-invocation');
      expect(metadata).not.toHaveProperty('allow_implicit_invocation');
    }
  });

  it('renders both host entrypoints from canonical bodies with explicit-only mutation policy', async () => {
    for (const name of SKILLS) {
      const canonical = await read('plugin-src', 'skills', name, 'body.md');
      const metadata = JSON.parse(await read('plugin-src', 'skills', name, 'metadata.json'));
      const codex = splitSkill(await read('plugins', 'ape', 'skills', name, 'SKILL.md'));
      const claude = splitSkill(await read('plugins', 'ape-claude', 'skills', name, 'SKILL.md'));
      const codexPolicy = await read('plugins', 'ape', 'skills', name, 'agents', 'openai.yaml');

      expect(words(canonical), name).toBeLessThanOrEqual(500);
      expect(codex.body).toBe(canonical);
      expect(claude.body).toBe(canonical);
      expect(codex.metadata).toEqual({ name: metadata.name, description: metadata.description });
      expect(claude.metadata.name).toBe(metadata.name);
      expect(claude.metadata.description).toBe(metadata.description);
      expect(claude.metadata['argument-hint']).toBe(metadata.argumentHint);
      expect(claude.metadata['disable-model-invocation']).toBe(name === 'status' ? 'false' : 'true');
      expect(codexPolicy).toContain(
        `allow_implicit_invocation: ${name === 'status' ? 'true' : 'false'}`,
      );
    }
  });

  it('uses dedicated status reads and treats explicit_invocation as attestation only', async () => {
    const status = await read('plugin-src', 'skills', 'status', 'body.md');
    const override = await read('plugin-src', 'skills', 'override', 'body.md');
    const run = await read('plugin-src', 'skills', 'run', 'body.md');
    expect(status).toMatch(/dedicated read-only `ape_status`/u);
    expect(status).toMatch(/roadmap data[\s\S]*counts only[\s\S]*explicit `ape:roadmap`/u);
    expect(override).toMatch(/call[\s\S]*`ape_status` first/u);
    expect(run).toMatch(/Host invocation policy is the human-intent boundary/u);
    expect(run).toMatch(/`?explicit_invocation: true`?[\s\S]*caller-attested defense-in-depth[\s\S]*not proof of human intent/u);
    expect(run).toMatch(/plan_contract_version: 2[\s\S]*new(?:ly)? started[\s\S]*(?:fast[\s\S]*full|full[\s\S]*fast)/iu);
    expect(run).toMatch(/input_required[\s\S]*answer-preflight/iu);
    expect(run).toMatch(/complete exact answers[\s\S]*additive/iu);
    expect(run).toMatch(/Omit it for[\s\S]*mechanical[\s\S]*non-phase modes[\s\S]*every resume/iu);
    expect(run).toMatch(/Repository discovery[\s\S]*no match is valid[\s\S]*`\|\| true`/iu);
    expect(run).toMatch(/never place[\s\S]*optional discovery[\s\S]*`&&` chain/iu);
    expect(run).toContain(
      "`rg --files -g 'AGENTS.md' -g '!**/.git/**' || true`",
    );
    expect(run).toMatch(/Stop instead of[\s\S]*(?:retrying|self-correcting)[\s\S]*inspection[\s\S]*call/iu);
    expect(run).toMatch(/ape_config[\s\S]*doctor[\s\S]*gate-command and visual-evidence readiness/iu);
  });

  it('shares one synchronized run/resume protocol reference', async () => {
    const canonical = await read('plugin-src', 'skills', 'references', 'run-resume-protocol.md');
    for (const name of ['run', 'resume']) {
      expect(await read('plugin-src', 'skills', name, 'body.md')).toContain('references/run-resume-protocol.md');
      expect(await read('plugins', 'ape', 'skills', name, 'references', 'run-resume-protocol.md'))
        .toBe(canonical);
      expect(await read('plugins', 'ape-claude', 'skills', name, 'references', 'run-resume-protocol.md'))
        .toBe(canonical);
    }
    expect(canonical).toMatch(/dispatch_agent[\s\S]*common prompt[\s\S]*role prompt[\s\S]*immutable ticket/u);
    expect(canonical).toContain('`receipt_capability`');
    expect(canonical).toContain('`action: "record"`');
    expect(canonical).toMatch(/control-call top level[\s\S]*only `action`, `project_dir`, and[\s\S]*`receipt`/u);
    expect(canonical).toMatch(/never send `run_id` on a record call/u);
    expect(canonical).toContain('`ape_run next`');
    expect(canonical).toContain('`wait_ms: 300000`');
    expect(canonical).toMatch(/server-side poll/iu);
    expect(canonical).toMatch(/do not sleep inside[\s\S]*`functions\.exec`/iu);
    expect(canonical).toMatch(/record.*rejects[\s\S]*same physical agent[\s\S]*at most two/iu);
    expect(canonical).toMatch(/test_commands\.full[\s\S]*verification\.profiles[\s\S]*browser\/Playwright/iu);
  });
});
