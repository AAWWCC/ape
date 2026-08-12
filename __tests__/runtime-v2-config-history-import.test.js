import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { historyAction } from '../lib/runtime/service.js';

// F24: `ape_history import` used to be write-only — the migration manifest had
// no reader and imported requirement IDs never reached requirement-index.json,
// so `ape_history query {requirement}` returned [] for requirements that only
// appear in imported legacy plans. Import must round-trip through the query
// surface.
describe('ape v2 history import round-trip', () => {
  const dirs = [];
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

  function project() {
    const dir = mkdtempSync(join(tmpdir(), 'ape-import-'));
    dirs.push(dir);
    mkdirSync(join(dir, '.planning'), { recursive: true });
    writeFileSync(
      join(dir, '.planning', '1-1-PLAN.md'),
      '# Plan 1-1\n\nDelivers R3 and R7.\n\nStatus: shipped\n',
    );
    writeFileSync(join(dir, '.planning', 'research-notes.md'), 'R99 appears here but is retained, not imported.\n');
    return dir;
  }

  it('imported requirements become queryable through ape_history', async () => {
    const dir = project();
    const imported = await historyAction(dir, 'import', {});
    expect(imported.ok).toBe(true);
    expect(imported.migration.record_count).toBe(1);

    const { records } = await historyAction(dir, 'query', { requirement: 'R3' });
    expect(records).toHaveLength(1);
    expect(records[0].imported).toBe(true);
    expect(records[0].source_path).toBe('.planning/1-1-PLAN.md');
    expect(records[0].requirements).toEqual(['R3', 'R7']);
    expect(records[0].status).toBe('completed');
    // The `0` segment makes imports sort below every real run id (year digit)
    // in the descending unfiltered listing.
    expect(records[0].run_id).toMatch(/^run-0-import-[0-9a-f]{24}$/);

    const byOther = await historyAction(dir, 'query', { requirement: 'R7' });
    expect(byOther.records).toHaveLength(1);
    expect(byOther.records[0].run_id).toBe(records[0].run_id);
  });

  it('re-importing is idempotent: no duplicate index entries or records', async () => {
    const dir = project();
    await historyAction(dir, 'import', {});
    await historyAction(dir, 'import', {});
    const { records } = await historyAction(dir, 'query', { requirement: 'R3' });
    expect(records).toHaveLength(1);
  });

  it('retained (non-machine) planning files are not indexed', async () => {
    const dir = project();
    await historyAction(dir, 'import', {});
    const { records } = await historyAction(dir, 'query', { requirement: 'R99' });
    expect(records).toEqual([]);
  });

  it('imported records appear in the plain history listing and keep the manifest', async () => {
    const dir = project();
    const { migration } = await historyAction(dir, 'import', {});
    expect(migration.records[0].history_run_id).toMatch(/^run-0-import-/);
    expect(existsSync(join(dir, '.ape', 'runtime', 'migration.json'))).toBe(true);

    const { records } = await historyAction(dir, 'query', {});
    expect(records.some((record) => record.run_id === migration.records[0].history_run_id)).toBe(true);
  });

  it('classifies imported status from the status line, never a document-wide substring scan', async () => {
    // The old `/shipped|complete/i` whole-text scan imported explicitly
    // incomplete plans and unexecuted "mark complete when done" templates as
    // completed — inverting the answer `query {requirement}` exists to give.
    const dir = mkdtempSync(join(tmpdir(), 'ape-import-status-'));
    dirs.push(dir);
    mkdirSync(join(dir, '.planning'), { recursive: true });
    const cases = [
      // [file body, expected status]
      ['# Plan\n\nDelivers R11.\n\nStatus: shipped\n', 'completed'],
      ['# Plan\n\nDelivers R12.\n\nStatus: incomplete\n', 'unknown'],
      ['# Plan\n\nDelivers R13.\n\nStatus: blocked — R3 incomplete\n', 'blocked'],
      // Prospective template: completion words in the body, no status line.
      ['# Plan\n\nDelivers R14.\n\nWhen every step is done, mark complete when done.\n', 'unknown'],
      ['# Plan\n\nDelivers R15.\n\n**Status**: Complete\n', 'completed'],
    ];
    for (const [index, [body]] of cases.entries()) {
      writeFileSync(join(dir, '.planning', `2-${index + 1}-PLAN.md`), body);
    }
    const { migration } = await historyAction(dir, 'import', {});
    expect(migration.record_count).toBe(cases.length);
    for (const [index, [, expected]] of cases.entries()) {
      const record = migration.records.find(
        (entry) => entry.source_path === `.planning/2-${index + 1}-PLAN.md`,
      );
      expect(record.status, record.source_path).toBe(expected);
    }
  });
});
