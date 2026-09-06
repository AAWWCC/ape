#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
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
const SKILLS = ['config', 'history', 'override', 'resume', 'roadmap', 'run', 'status'];

// Editorial targets, not host capacities or evidence of prompt correctness.
// Semantic contracts, package parity and behavior evaluations remain gates.
export async function promptBudgetReport(root = ROOT) {
  const entries = [
    { file: 'prompts/common.md', target: 450 },
    ...Object.entries(ROLE_BUDGETS).map(([role, target]) => ({
      file: `prompts/${role}.md`, target,
    })),
    ...Object.keys(ROLE_BUDGETS).map((role) => ({
      file: `agents/${role.replaceAll('_', '-')}.md`, target: 40, frontmatter: true,
    })),
    ...SKILLS.map((name) => ({ file: `plugin-src/skills/${name}/body.md`, target: 500 })),
  ];
  const files = await Promise.all(entries.map(async ({ file, target, frontmatter }) => {
    let text = await readFile(path.join(root, file), 'utf8');
    if (frontmatter) text = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/u, '');
    const words = text.trim().split(/\s+/u).filter(Boolean).length;
    return { file, words, target, over_target: words > target };
  }));
  return { advisory: true, files, over_target_count: files.filter((entry) => entry.over_target).length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const report = await promptBudgetReport();
    if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else {
      for (const entry of report.files.filter((item) => item.over_target)) {
        process.stdout.write(`advisory: ${entry.file}: ${entry.words} words (target ${entry.target}); review clarity and behavior before shortening\n`);
      }
      process.stdout.write(`prompt budgets: ${report.files.length} files, ${report.over_target_count} over advisory targets; word counts do not block\n`);
    }
  } catch (error) {
    process.stderr.write(`prompt budgets: ${error.message}\n`);
    process.exitCode = 1;
  }
}
