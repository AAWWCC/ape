import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

function read(relative) {
  return readFile(new URL(`../${relative}`, import.meta.url), 'utf8');
}

describe('APE roadmap registration contract', () => {
  it('requires approved, cold-reader-complete entries with observable consequences', async () => {
    const skill = await read('plugin-src/skills/roadmap/body.md');
    expect(skill).toMatch(/draft cold-reader-complete entries and obtain explicit approval/i);
    expect(skill).toMatch(/`id`[\s\S]*`title`[\s\S]*`description`[\s\S]*observable `acceptance`/i);
    expect(skill).toMatch(/behavioral or[\s\S]*operator consequence/i);
    expect(skill).toMatch(/style notes[\s\S]*documentation nits[\s\S]*advisory/i);
  });

  it('keeps status derived and mutations explicit and atomic', async () => {
    const skill = await read('plugin-src/skills/roadmap/body.md');
    expect(skill).toMatch(/statuses are always derived[\s\S]*never supplied/i);
    expect(skill).toMatch(/Registration is atomic/i);
    expect(skill).toMatch(/supersede[\s\S]*explicit approval/i);
    expect(skill).toMatch(/Never pass a `status` field/i);
  });

  it('keeps production and test claims distinct at run intake', async () => {
    const skill = await read('plugin-src/skills/run/body.md');
    expect(skill).toMatch(/`claimed_paths`: production paths only/i);
    expect(skill).toMatch(/`test_paths`: independently authored test paths/i);
    expect(skill).toMatch(/never put them in[\s\S]*`claimed_paths`/i);
    expect(skill).toMatch(/documentation[\s\S]*only when the objective may require them/i);
  });
});

describe('roadmap registration runtime enforcement', () => {
  it('documents graph, lifecycle, recovery, and accepted-receipt provenance enforcement', async () => {
    const [skill, tools, architecture, bin] = await Promise.all([
      read('plugin-src/skills/roadmap/body.md'),
      read('docs/mcp-tools.md'),
      read('docs/architecture.md'),
      read('bin/ape-mcp.mjs'),
    ]);
    expect(skill).toMatch(/forward references[\s\S]*duplicate edges[\s\S]*cycles/i);
    expect(skill).toMatch(/evidence\.roadmap_followups[\s\S]*accepted receipt[\s\S]*exact declaration/i);
    expect(tools).toMatch(/unapplied, applied-but-unaudited, and committed[\s\S]*divergent/i);
    expect(architecture).toMatch(/start and completed archival[\s\S]*satisfied/i);
    expect(bin).toMatch(/accepted receipt with an exact normalized evidence\.roadmap_followups declaration/i);
  });

  it('does not make reviewers operate the roadmap control plane', async () => {
    for (const prompt of ['prompts/reviewer.md', 'prompts/security_reviewer.md']) {
      const text = await read(prompt);
      expect(text).not.toContain('roadmap-register');
      expect(text).not.toContain('ape_history');
    }
  });
});
