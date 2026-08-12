import { readFile, readdir } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

function read(relative) {
  return readFile(new URL(`../${relative}`, import.meta.url), 'utf8');
}

async function sourceFiles(dirRelative, extensions) {
  const dir = new URL(`../${dirRelative}/`, import.meta.url);
  const names = (await readdir(dir, { recursive: true })).sort();
  return Promise.all(names
    .filter((name) => extensions.some((extension) => name.endsWith(extension)))
    .map(async (name) => [`${dirRelative}/${name}`, await readFile(new URL(name, dir), 'utf8')]));
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

describe('roadmap registration stays a skill convention', () => {
  it('adds no registration-bar enforcement to runtime or bin', async () => {
    const files = [
      ...(await sourceFiles('lib/runtime', ['.js'])),
      ...(await sourceFiles('bin', ['.mjs'])),
    ];
    const offenders = files
      .filter(([, text]) => /documentation nits remain advisory|behavioral or operator consequence/i.test(text))
      .map(([name]) => name);
    expect(offenders).toEqual([]);
  });

  it('does not make reviewers operate the roadmap control plane', async () => {
    for (const prompt of ['prompts/reviewer.md', 'prompts/security_reviewer.md']) {
      const text = await read(prompt);
      expect(text).not.toContain('roadmap-register');
      expect(text).not.toContain('ape_history');
    }
  });
});
