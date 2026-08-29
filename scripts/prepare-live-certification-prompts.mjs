#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const RELEASE_VERSION = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const PIPELINES = Object.freeze(['mechanical', 'fast', 'full', 'land']);
// Release certification is first-pass-perfect: the dispatch caps authorize
// exactly the deterministic happy path for each cohort, while the active-time
// caps allow one hour per required worker. A retry, remediation cycle, or
// replacement worker must therefore fail the candidate instead of extending a
// synthetic certification run into an unbounded recovery loop.
const EXECUTION_BUDGETS = Object.freeze({
  mechanical: Object.freeze({ max_worker_dispatches: 1, max_active_seconds: 3_600 }),
  fast: Object.freeze({ max_worker_dispatches: 4, max_active_seconds: 14_400 }),
  full: Object.freeze({ max_worker_dispatches: 7, max_active_seconds: 25_200 }),
  land: Object.freeze({ max_worker_dispatches: 1, max_active_seconds: 3_600 }),
});

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
    return realpathSync(value);
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
      run: `Use mode phase, lane mechanical, behavioral false, claimed_paths ["docs/codex-${suffix}-mechanical-${repetition}.md"], test_paths [], and empty requirements, completes, risk_triggers, and tool_claims. Omit plan_contract_version.`,
    };
  }
  if (pipeline === 'fast') {
    return {
      authorization: 'push its APE branch, open a pull request, and squash-merge it',
      objective: `Create src/is-even-${suffix}-${repetition}.js exporting isEven(value). It accepts only primitive finite integer numbers and returns true exactly for even integers, including zero and negative values. For every non-number, NaN, positive or negative infinity, or fractional number, it throws TypeError with the exact message "value must be a finite integer". Create independent tests at test/is-even-${suffix}-${repetition}.test.js covering zero, positive and negative odd and even integers, and every invalid input class.`,
      run: `Use mode phase, lane fast, behavioral true, plan_contract_version 2, claimed_paths ["src/is-even-${suffix}-${repetition}.js"], test_paths ["test/is-even-${suffix}-${repetition}.test.js"], and empty requirements, completes, risk_triggers, and tool_claims.`,
    };
  }
  if (pipeline === 'full') {
    return {
      authorization: 'push its APE branch, open a pull request, and squash-merge it',
      objective: `Create src/normalize-label-${suffix}-${repetition}.js exporting normalizeLabel(value). It accepts only primitive strings. It trims leading and trailing ECMAScript whitespace, collapses every remaining run of ECMAScript whitespace to one ASCII space, and returns the result lowercased with String.prototype.toLowerCase(). For any non-string, it throws TypeError with the exact message "value must be a string". If the input contains only whitespace, it throws RangeError with the exact message "value must contain non-whitespace characters". Create independent tests at test/normalize-label-${suffix}-${repetition}.test.js covering unchanged lowercase text, mixed case, surrounding whitespace, internal spaces, tabs, newlines, non-breaking spaces, whitespace-only input, and representative primitive and object non-string inputs.`,
      run: `Use mode phase, lane full, behavioral true, plan_contract_version 2, claimed_paths ["src/normalize-label-${suffix}-${repetition}.js"], test_paths ["test/normalize-label-${suffix}-${repetition}.test.js"], and empty requirements, completes, risk_triggers, and tool_claims.`,
    };
  }
  return {
    authorization: 'push its APE branch, open a pull request, enable protected auto-merge, and squash-merge it after every required remote check passes',
    objective: `Review and land the already-finished committed feature diff that creates docs/codex-${suffix}-protected-land-${repetition}.md as synthetic protected Codex land certification attempt ${repetition} for APE ${RELEASE_VERSION}.`,
    run: `Use mode land, lane mechanical, behavioral false, claimed_paths ["docs/codex-${suffix}-protected-land-${repetition}.md"], test_paths [], and empty requirements, completes, risk_triggers, and tool_claims. Omit plan_contract_version.`,
  };
}

export function buildLiveCertificationPrompt(campaignRoot, pipeline, repetition) {
  const root = exactCampaignRoot(campaignRoot);
  if (!PIPELINES.includes(pipeline) || repetition !== 1) {
    throw new LiveCertificationPromptError('pipeline and repetition must name one pinned certification attempt');
  }
  const projectDir = path.join(root, pipeline);
  try {
    if (realpathSync(projectDir) !== projectDir) throw new Error('non-canonical project path');
  } catch {
    throw new LiveCertificationPromptError(`campaign project does not resolve exactly: ${projectDir}`);
  }
  const contract = attemptContract(pipeline, repetition);
  const executionBudget = JSON.stringify(EXECUTION_BUDGETS[pipeline]);
  return `$ape:run

Conduct authorized APE ${RELEASE_VERSION} live-certification attempt codex-${pipeline}-${repetition} in this disposable repository. The operator explicitly invokes APE and authorizes this exact run to ${contract.authorization}.

Start one run with this complete objective: ${contract.objective}

${contract.run} Pass execution_budget ${executionBudget}, explicit_invocation true, hooks_trusted true, subagents_available true, and auto_merge_authorized true. Pass project_dir "${projectDir}" on every APE MCP call.

Follow the installed APE run skill and every returned control action exactly through terminal completion. Begin every functions.exec wrapper that can return APE MCP or control output with \`// @exec: {"max_output_tokens": 30000}\`. Complete the required Codex binding probe. Pass each returned spawn_args object directly and unchanged to native collaboration spawn_agent. The native message is transport-only: do not add, reconstruct, normalize, reserialize, or relay stage content through it. Require the trusted SubagentStart context before stage work. Record each original receipt unchanged exactly once. Do not edit from the parent, assemble replacement prompts, repair receipts, duplicate or relaunch agents, expire dispatches, regate, resume a started run, create a successor, inspect session logs to recover a receipt, or weaken gates. Abort rather than reconstruct unavailable or invalid evidence. Continue bounded next calls through terminal completion and report the run id and result, including whether spawn_args remained byte-for-byte unchanged and authoritative context was hook-injected.
`;
}

export function writeLiveCertificationPrompts(campaignRoot) {
  const root = exactCampaignRoot(campaignRoot);
  const promptsDir = path.join(root, 'prompts');
  if (existsSync(promptsDir)) {
    throw new LiveCertificationPromptError(`refusing to reuse existing prompt directory: ${promptsDir}`);
  }
  mkdirSync(promptsDir, { mode: 0o700 });
  const written = [];
  for (const pipeline of PIPELINES) {
    const repetition = 1;
    const file = path.join(promptsDir, `${pipeline}-${repetition}.txt`);
    writeFileSync(file, buildLiveCertificationPrompt(root, pipeline, repetition), {
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
