#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const RELEASE_VERSION = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const PIPELINES = Object.freeze(['mechanical', 'fast', 'full', 'land']);

export class LiveCertificationPromptError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LiveCertificationPromptError';
  }
}

function exactCampaignRoot(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new LiveCertificationPromptError('--campaign-root is required');
  }
  try {
    const root = realpathSync(value);
    if (!statSync(root).isDirectory()) throw new Error('not a directory');
    return root;
  } catch {
    throw new LiveCertificationPromptError('--campaign-root must resolve to an existing directory');
  }
}

function attemptContract(pipeline, repetition) {
  const suffix = RELEASE_VERSION.split('.').slice(1).join('');
  if (pipeline === 'mechanical') {
    return {
      authorization: 'push its APE branch, open a pull request, and squash-merge it',
      objective: `Create docs/codex-${suffix}-mechanical-${repetition}.md containing a concise heading and one sentence identifying it as synthetic Codex mechanical certification attempt ${repetition} for APE ${RELEASE_VERSION}.`,
      mode: 'phase',
      lane: 'mechanical',
      behavioral: false,
      claimedPaths: [`docs/codex-${suffix}-mechanical-${repetition}.md`],
      testPaths: [],
    };
  }
  if (pipeline === 'fast') {
    return {
      authorization: 'push its APE branch, open a pull request, and squash-merge it',
      objective: `Create src/is-even-${suffix}-${repetition}.js exporting isEven(value). It accepts only primitive finite integer numbers and returns true exactly for even integers, including zero and negative values. For every non-number, NaN, positive or negative infinity, or fractional number, it throws TypeError with the exact message "value must be a finite integer". Create independent tests at test/is-even-${suffix}-${repetition}.test.js covering zero, positive and negative odd and even integers, and every invalid input class.`,
      mode: 'phase',
      lane: 'fast',
      behavioral: true,
      planContractVersion: 2,
      claimedPaths: [`src/is-even-${suffix}-${repetition}.js`],
      testPaths: [`test/is-even-${suffix}-${repetition}.test.js`],
    };
  }
  if (pipeline === 'full') {
    return {
      authorization: 'push its APE branch, open a pull request, and squash-merge it',
      objective: `Create src/normalize-label-${suffix}-${repetition}.js exporting normalizeLabel(value). It accepts only primitive strings. It trims leading and trailing ECMAScript whitespace, collapses every remaining run of ECMAScript whitespace to one ASCII space, and returns the result lowercased with String.prototype.toLowerCase(). For any non-string, it throws TypeError with the exact message "value must be a string". If the input contains only whitespace, it throws RangeError with the exact message "value must contain non-whitespace characters". Create independent tests at test/normalize-label-${suffix}-${repetition}.test.js covering unchanged lowercase text, mixed case, surrounding whitespace, internal spaces, tabs, newlines, non-breaking spaces, whitespace-only input, and representative primitive and object non-string inputs.`,
      mode: 'phase',
      lane: 'full',
      behavioral: true,
      planContractVersion: 2,
      claimedPaths: [`src/normalize-label-${suffix}-${repetition}.js`],
      testPaths: [`test/normalize-label-${suffix}-${repetition}.test.js`],
    };
  }
  return {
    authorization: 'push its APE branch, open a pull request, and perform a protected squash merge after every required remote check passes, including automatic merging only when the protected workflow needs it',
    objective: `Review and land the already-finished committed feature diff that creates docs/codex-${suffix}-protected-land-${repetition}.md as synthetic protected Codex land certification attempt ${repetition} for APE ${RELEASE_VERSION}.`,
    mode: 'land',
    lane: 'mechanical',
    behavioral: false,
    claimedPaths: [`docs/codex-${suffix}-protected-land-${repetition}.md`],
    testPaths: [],
  };
}

function exactRunCall(action, projectDir, contract) {
  return Object.freeze({
    action,
    project_dir: projectDir,
    objective: contract.objective,
    mode: contract.mode,
    lane: contract.lane,
    host: 'codex',
    claimed_paths: contract.claimedPaths,
    test_paths: contract.testPaths,
    requirements: [],
    completes: [],
    risk_triggers: [],
    required_capabilities: [],
    behavioral: contract.behavioral,
    hooks_trusted: true,
    subagents_available: true,
    explicit_invocation: true,
    auto_merge_authorized: true,
    ...(contract.planContractVersion === undefined
      ? {}
      : { plan_contract_version: contract.planContractVersion }),
  });
}

export function buildLiveCertificationPrompt(campaignRoot, pipeline, repetition) {
  const root = exactCampaignRoot(campaignRoot);
  if (!PIPELINES.includes(pipeline) || repetition !== 1) {
    throw new LiveCertificationPromptError('pipeline and repetition must name one pinned certification attempt');
  }
  const projectDir = path.join(root, pipeline);
  try {
    if (realpathSync(projectDir) !== projectDir || !statSync(projectDir).isDirectory()) {
      throw new Error('non-canonical project directory');
    }
  } catch {
    throw new LiveCertificationPromptError(`campaign project does not resolve exactly to an existing directory: ${projectDir}`);
  }
  const contract = attemptContract(pipeline, repetition);
  const previewCall = JSON.stringify(
    exactRunCall('preview', projectDir, contract),
  );
  const startCall = JSON.stringify(
    exactRunCall('start', projectDir, contract),
  );
  return `$ape:run

Conduct APE ${RELEASE_VERSION} live-certification attempt codex-${pipeline}-${repetition} in this disposable repository only after the operator has separately authorized this exact run to ${contract.authorization}. This generated prompt is not evidence of operator approval, repository permission, or hook trust; if any prerequisite is missing, stop before starting.

Start one run with this complete objective: ${contract.objective}
${pipeline === 'land' ? '\nProtected land may complete by immediate or automatic squash. Do not force the automatic path, delay or fabricate checks, bypass protection, or count an accepted queue request as a merge. Require observed MERGED state at the exact pushed head and the passed-gate tree. The operator retains required-CI and unchanged protected-main policy observations for schema-v5 certification; never infer them from a successful command or invent missing evidence.\n' : ''}

Pass project_dir "${projectDir}" on every APE MCP call. After ape_config doctor and get, call ape_run preview exactly once with the exact JSON object on the next line:
APE_PREVIEW_CALL=${previewCall}

Review the preview's complete admission manifest. After the required binding probe succeeds, call ape_run start exactly once using the JSON object on the next line plus expected_admission_digest copied unchanged from the preview's top-level admission_digest:
APE_START_CALL=${startCall}

The prospective preview and start inputs differ only in action. The sole required addition to start is expected_admission_digest copied from that ready preview; never use a placeholder, guess a digest, or send the digest on preview. Do not add, remove, infer, default, or modify any other field. A missing digest, admission.ready !== true, truncated manifest, or changed prospective inputs fails the attempt before start. In particular, never send run_id, supersedes_run, binding_protocol, or binding_probe on either call. If doctor, get, preview, probe, probe-status, probe-ack, or start rejects, returns malformed output, or otherwise fails, stop immediately and report that the certification candidate failed. Never correct or retry one of those control calls. This digest confirms reviewed inputs, not independent human authorization.

Follow the installed APE run skill and every returned control action exactly through terminal completion. Begin every functions.exec wrapper that can return APE MCP or control output with \`// @exec: {"max_output_tokens": 30000}\`. Complete the required Codex binding probe. Pass each returned spawn_args object directly and unchanged to native collaboration spawn_agent. Its runtime-generated bootstrap message is transport-only: do not add, reconstruct, normalize, reserialize, or relay stage content through it. SubagentStart is provisional native identity evidence only, not ticket association or stage authority. The assigned child's first APE operation is ape_bind with the exact bootstrap_args carried in that launch. If the tool is deferred, the child may make one bounded catalog discovery using only the literal registered tool name ape_bind; never include bootstrap arguments or capabilities in discovery. For that APE bootstrap only, a functions.exec wrapper may inspect exact-matching ALL_TOOLS metadata or invoke that installed APE tool only; shell, functions.exec_command, reconstructed commands, and substitute tools are not bootstrap alternatives. Before binding, missing stage context is expected; after ape_bind, require the complete authenticated hook-injected ticket/receipt context before any stage work. For the probe only, follow its injected acknowledgement-only contract: no further tools, synthetic ticket loading, or receipt validation; return its exact acknowledgement. The parent must never invoke the child's ape_bind. Record each original receipt unchanged exactly once. Do not edit from the parent, assemble replacement prompts, repair receipts, duplicate or relaunch agents, expire dispatches, regate, resume a started run, create a successor, inspect session logs to recover a receipt, or weaken gates. Stop and report unavailable or invalid evidence without reconstructing it or automatically aborting/resetting the run. Continue bounded next calls through terminal completion and report the run id and result, including whether spawn_args remained byte-for-byte unchanged and authoritative context was injected by the ape_bind hook.
`;
}

export function writeLiveCertificationPrompts(campaignRoot) {
  const root = exactCampaignRoot(campaignRoot);
  const promptsDir = path.join(root, 'prompts');
  if (existsSync(promptsDir)) {
    throw new LiveCertificationPromptError(`refusing to reuse existing prompt directory: ${promptsDir}`);
  }
  // Validate and render the complete campaign before creating output. A missing
  // later project must not leave a partial directory that prevents correction.
  const prompts = PIPELINES.map((pipeline) => ({
    file: path.join(promptsDir, `${pipeline}-1.txt`),
    content: buildLiveCertificationPrompt(root, pipeline, 1),
  }));
  mkdirSync(promptsDir, { mode: 0o700 });
  const written = [];
  for (const { file, content } of prompts) {
    writeFileSync(file, content, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    written.push(file);
  }
  return Object.freeze(written);
}

function invokedDirectly(argvPath) {
  if (!argvPath) return false;
  try {
    return realpathSync(argvPath) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly(process.argv[1])) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 2 || args[0] !== '--campaign-root') {
      throw new LiveCertificationPromptError(
        'usage: node scripts/prepare-live-certification-prompts.mjs --campaign-root <path>',
      );
    }
    const files = writeLiveCertificationPrompts(args[1]);
    process.stdout.write(`wrote ${files.length} live-certification prompts for ${RELEASE_VERSION}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
