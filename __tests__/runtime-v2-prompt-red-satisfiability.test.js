import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

async function read(relative) {
  return readFile(new URL(`../${relative}`, import.meta.url), 'utf8');
}

describe('APE v2 test-writer red satisfiability contract', () => {
  it('requires public, mutually consistent, green-reachable behavioral assertions', async () => {
    const prompt = (await read('prompts/test_writer.md')).replace(/\s+/g, ' ');
    expect(prompt).toMatch(/public behavior/i);
    expect(prompt).toMatch(/mutually consistent and satisfiable/i);
    expect(prompt).toMatch(/deterministically fail for missing behavior[\s\S]*passable by a correct implementation/i);
    expect(prompt).toMatch(/rewrite contradictory outcomes/i);
  });

  it('requires the authored test itself to provide the observed red evidence', async () => {
    const prompt = (await read('prompts/test_writer.md')).replace(/\s+/g, ' ');
    expect(prompt).toMatch(/Run the narrow authored test repeatedly/i);
    expect(prompt).toMatch(/Zero collection[\s\S]*unrelated or pre-existing failure[\s\S]*not red evidence/i);
    for (const evidence of ['command', 'tree SHA', 'exit code', 'repetition count', 'red result', 'green result', 'output hash', 'gate']) {
      expect(prompt).toContain(evidence);
    }
    expect(prompt).toMatch(/identical command alternates fail\/pass[\s\S]*nondeterministic[\s\S]*rewrite/i);
  });

  it('keeps analyzer defects in synthetic fixtures and live-tree checks green-only', async () => {
    const prompt = (await read('prompts/test_writer.md')).replace(/\s+/g, ' ');
    expect(prompt).toMatch(/analyzers, validators, scanners, or defect detectors[\s\S]*synthetic fixture/i);
    expect(prompt).toMatch(/Red must not depend on a defect remaining in live source/i);
    expect(prompt).toMatch(/live tree[\s\S]*post-fix invariants/i);
  });

  it('gives contradictory authored tests one exact implementer failure shape', async () => {
    const prompt = await read('prompts/implementer.md');
    expect(prompt).toMatch(/do not edit or evade it/i);
    expect(prompt).toContain('`evidence.failure_kind: "test-contradiction"`');
    expect(prompt).toMatch(/test\s+path and location[\s\S]*reproducing command and result/i);
    expect(prompt).toMatch(/incompatible expectations or objective conflict/i);
    expect(prompt).toMatch(/no conforming implementation can pass/i);
    expect(prompt).toMatch(/exact conflict[\s\S]*`evidence.summary`/i);
  });

  it('does not depend on private run exemplars', async () => {
    const prompts = `${await read('prompts/test_writer.md')}\n${await read('prompts/implementer.md')}`;
    expect(prompts).not.toMatch(/\brun-\d{12,}-[a-z0-9]+\b/i);
  });
});
