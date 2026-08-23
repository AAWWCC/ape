import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

function read(relative) {
  return readFile(new URL(`../${relative}`, import.meta.url), 'utf8');
}

function issueFormEntries(source) {
  return source.split(/\n(?=\s*-\s+type:)/u).filter((entry) => /^\s*-\s+type:/u.test(entry));
}

function scalar(entry, key) {
  const value = entry.match(new RegExp(`^\\s*${key}:\\s*(.+?)\\s*$`, 'mu'))?.[1]?.trim();
  return value?.replace(/^(['"])(.*)\1$/u, '$2');
}

describe('incident-to-regression adoption workflow', () => {
  it('provides a valid required GitHub issue form for bounded runtime evidence', async () => {
    const source = await read('.github/ISSUE_TEMPLATE/bug_report.yml');
    expect(source).toMatch(/^name:\s*\S/imu);
    expect(source).toMatch(/^description:\s*\S/imu);
    expect(source).toMatch(/^title:\s*\S/imu);
    expect(source).toMatch(/^body:\s*$/imu);

    const entries = issueFormEntries(source);
    const fields = entries.filter((entry) => !/^\s*-\s+type:\s*markdown\s*$/imu.test(entry));
    const ids = fields.map((entry) => scalar(entry, 'id'));
    expect(ids.every((id) => /^[A-Za-z0-9_-]+$/u.test(id ?? ''))).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);

    const expectedLabels = [
      /^ape version$/iu,
      /^(?:ape )?host$/iu,
      /^(?:ape )?host version$/iu,
      /^(?:os|operating system)(?: and version)?$/iu,
      /^node(?:\.js)? version$/iu,
      /^lane$/iu,
      /^stage$/iu,
      /^(?:stable )?(?:diagnostic )?reason code$/iu,
      /^(?:bounded )?diagnostic projection(?: \(bounded\))?$/iu,
      /^minimal reproduction$/iu,
    ];
    for (const expected of expectedLabels) {
      const matches = fields.filter((entry) => expected.test(scalar(entry, 'label') ?? ''));
      expect(matches, String(expected)).toHaveLength(1);
      expect(matches[0]).toMatch(/\n\s+validations:\s*\n\s+required:\s*true\s*(?:\n|$)/iu);
    }

    const warning = entries.find((entry) => /^\s*-\s+type:\s*markdown\s*$/imu.test(entry));
    expect(warning).toBeTruthy();
    expect(warning).toMatch(/(?:do not|never)[\s\S]*secret/iu);
    expect(warning).toMatch(/private (?:file system |filesystem )?paths?/iu);
    expect(warning).toMatch(/private prose/iu);
    expect(source.indexOf(warning)).toBeLessThan(source.search(/\n\s*-\s+type:\s*(?:input|dropdown|textarea)/iu));
  });

  it('documents an explicit local-first, privacy-safe minimal reproduction convention', async () => {
    const guide = await read('docs/incident-reporting.md');
    expect(guide).toMatch(/inspect[\s\S]*diagnostic[\s\S]*local/iu);
    expect(guide).toMatch(/opt[ -]in[\s\S]*manual/iu);
    expect(guide).toMatch(/no automatic telemetry|does not (?:collect|upload|send)[\s\S]*automatically/iu);
    expect(guide).toMatch(/minimal reproduction/iu);
    expect(guide).toMatch(/synthetic[\s\S]*privacy-safe|privacy-safe[\s\S]*synthetic/iu);

    for (const omitted of [
      /raw `?\.ape/iu,
      /objectives?/iu,
      /claimed[ /-]?paths?[\s\S]*test[ /-]?paths?/iu,
      /receipt prose[\s\S]*receipt capabilities?/iu,
      /prompts?/iu,
      /command(?: lines?)?[\s\S]*command output/iu,
      /secrets?/iu,
      /private (?:file system |filesystem )?paths?/iu,
      /private prose/iu,
    ]) {
      expect(guide, String(omitted)).toMatch(omitted);
    }
  });

  it('requires regression-first defect fixes and links the workflow from repository guidance', async () => {
    const [readme, contributing] = await Promise.all([
      read('README.md'),
      read('CONTRIBUTING.md'),
    ]);
    expect(contributing).toMatch(/confirmed runtime defect[\s\S]*minimal failing regression test[\s\S]*before the fix/iu);
    expect(contributing).toMatch(/incident-derived fixtures?[\s\S]*synthetic[\s\S]*privacy-safe/iu);

    const guidance = `${readme}\n${contributing}`;
    expect(readme).toMatch(/\[[^\]]*(?:contribut|development)[^\]]*\]\(CONTRIBUTING\.md\)/iu);
    expect(guidance).toMatch(/\[[^\]]*(?:incident|defect|bug)[^\]]*\]\(docs\/incident-reporting\.md\)/iu);
  });
});
