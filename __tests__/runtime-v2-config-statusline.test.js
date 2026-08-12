import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configAction } from '../lib/runtime/service.js';

// statusline.js resolves the host config dir from os.homedir(), which reads
// $HOME on posix and %USERPROFILE% on Windows — so a temp home must override
// both to fully isolate these writes from the real ~/.claude/settings.json.
// The wired PROJECT must be a throwaway too: wire resolves
// statusline.refresh_interval_seconds from the project's .ape/runtime/config.json,
// so wiring process.cwd() would couple these pins to the host repo's own
// gitignored runtime config (a locally-set custom interval would flip the
// refreshInterval expectations below).
describe('ape v2 config statusline wiring', () => {
  let home;
  let project;
  let prevHome;
  let prevUserProfile;
  const settingsFile = () => join(home, '.claude', 'settings.json');

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ape-home-'));
    project = mkdtempSync(join(tmpdir(), 'ape-proj-'));
    prevHome = process.env.HOME;
    prevUserProfile = process.env.USERPROFILE;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    mkdirSync(join(home, '.claude'), { recursive: true });
  });
  afterEach(() => {
    process.env.HOME = prevHome;
    process.env.USERPROFILE = prevUserProfile;
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });

  it('wire writes a statusLine block + executable shim and reports state', async () => {
    const res = await configAction(project, 'wire', { host: 'claude' });
    expect(res.ok).toBe(true);
    expect(res.statusline.wired).toBe(true);

    const settings = JSON.parse(readFileSync(settingsFile(), 'utf8'));
    expect(settings.statusLine.type).toBe('command');
    expect(settings.statusLine.command).toContain('ape-statusline.sh');
    // T12: the wired default is 5s. An always-on 1s cadence spawns one node
    // plus up to ~3 git processes every second in every wired project, forever,
    // even when APE is idle — a disproportionate cost for the renderer's
    // wall-clock animations. A user who wants the old 1s smoothness sets
    // statusline.refresh_interval_seconds back to 1 explicitly.
    expect(settings.statusLine.refreshInterval).toBe(5);

    const shim = join(home, '.claude', 'ape-statusline.sh');
    expect(existsSync(shim)).toBe(true);
    // POSIX-only: Windows filesystems have no executable bit, and the shim is
    // invoked via `bash "<shim>"` regardless, so the mode is not meaningful there.
    if (process.platform !== 'win32') {
      expect(statSync(shim).mode & 0o100).toBeTruthy(); // owner-executable
    }
    expect(readFileSync(shim, 'utf8')).toContain('bin/ape-statusline.mjs');
  });

  it('wire preserves existing settings keys and backs up the prior file', async () => {
    writeFileSync(settingsFile(), JSON.stringify({ model: 'opus', theme: 'dark' }, null, 2));
    await configAction(project, 'wire', { host: 'claude' });

    const settings = JSON.parse(readFileSync(settingsFile(), 'utf8'));
    expect(settings.model).toBe('opus');
    expect(settings.theme).toBe('dark');
    expect(settings.statusLine).toBeDefined();

    const backup = JSON.parse(readFileSync(`${settingsFile()}.bak`, 'utf8'));
    expect(backup.statusLine).toBeUndefined(); // backup is the pre-wire state
    expect(backup.model).toBe('opus');
  });

  it('unwire removes the statusLine block and the shim', async () => {
    writeFileSync(settingsFile(), JSON.stringify({ model: 'opus' }, null, 2));
    await configAction(project, 'wire', { host: 'claude' });
    const res = await configAction(project, 'unwire', { host: 'claude' });

    expect(res.statusline.removed).toBe(true);
    const settings = JSON.parse(readFileSync(settingsFile(), 'utf8'));
    expect(settings.statusLine).toBeUndefined();
    expect(settings.model).toBe('opus'); // unrelated keys survive
    expect(existsSync(join(home, '.claude', 'ape-statusline.sh'))).toBe(false);
  });

  it('unwire leaves a foreign statusLine untouched', async () => {
    writeFileSync(
      settingsFile(),
      JSON.stringify({ statusLine: { type: 'command', command: 'echo hi' } }, null, 2),
    );
    const res = await configAction(project, 'unwire', { host: 'claude' });
    expect(res.statusline.removed).toBe(false);
    const settings = JSON.parse(readFileSync(settingsFile(), 'utf8'));
    expect(settings.statusLine.command).toBe('echo hi');
  });

  it('unwire backs up the wired settings and leaves no temp litter', async () => {
    writeFileSync(settingsFile(), JSON.stringify({ model: 'opus' }, null, 2));
    await configAction(project, 'wire', { host: 'claude' });
    const res = await configAction(project, 'unwire', { host: 'claude' });
    expect(res.statusline.removed).toBe(true);

    // The backup is the PRE-unwire (wired) state — same courtesy as wire.
    const backup = JSON.parse(readFileSync(`${settingsFile()}.bak`, 'utf8'));
    expect(backup.statusLine).toBeDefined();
    expect(backup.model).toBe('opus');
    // The rewritten settings survive as valid JSON with no orphaned temp file
    // from the atomic replace.
    const settings = JSON.parse(readFileSync(settingsFile(), 'utf8'));
    expect(settings.statusLine).toBeUndefined();
    expect(readdirSync(join(home, '.claude')).filter((f) => f.includes('.tmp'))).toEqual([]);
  });

  it('unwire on an unwired host does not create or rewrite settings.json', async () => {
    // No settings.json at all: unwire must not conjure one (the runtime never
    // touched this host), only ensure the shim is gone.
    const res = await configAction(project, 'unwire', { host: 'claude' });
    expect(res.statusline.removed).toBe(false);
    expect(existsSync(settingsFile())).toBe(false);
    expect(existsSync(`${settingsFile()}.bak`)).toBe(false);
  });

  it('doctor reports statusline wiring state', async () => {
    await configAction(project, 'wire', { host: 'claude' });
    const res = await configAction(project, 'doctor', { host: 'claude' });
    expect(res.statusline.wired).toBe(true);
  });

  // --- T12: raise the wired statusLine refresh interval to 5s and make it
  // config-driven. The wire path resolves statusline.refresh_interval_seconds
  // from the WIRED PROJECT's runtime config (`configAction` receives the
  // project dir), clamped to an integer >= 1: numerics floor then clamp up to a
  // minimum of 1 (2.9 -> 2, 1.5 -> 1, 0 -> 1, -1 -> 1); a non-numeric value
  // ('abc', null) falls back to the shipped default of 5. Wiring writes that
  // resolved integer as settings.statusLine.refreshInterval.
  describe('T12 configurable refresh interval', () => {
    // Wire against a throwaway project whose .ape/runtime/config.json is written
    // VERBATIM (bypassing `config set`), so out-of-range and non-numeric values
    // — which a hand-edited or legacy config can carry and which the `config
    // set` number validator would reject at set time — still reach the wire
    // path's resolve/clamp. Pass `undefined` for "no statusline key configured"
    // (bare default). Returns the refreshInterval written into the temp-home
    // settings.json. settings land in the per-test temp HOME from beforeEach;
    // the throwaway project only carries the runtime config being resolved.
    async function wiredRefreshInterval(refreshValue) {
      const project = mkdtempSync(join(tmpdir(), 'ape-proj-'));
      try {
        mkdirSync(join(project, '.ape', 'runtime'), { recursive: true });
        const config = refreshValue === undefined
          ? {}
          : { statusline: { refresh_interval_seconds: refreshValue } };
        writeFileSync(
          join(project, '.ape', 'runtime', 'config.json'),
          `${JSON.stringify(config, null, 2)}\n`,
        );
        const res = await configAction(project, 'wire', { host: 'claude' });
        expect(res.ok).toBe(true);
        return JSON.parse(readFileSync(settingsFile(), 'utf8')).statusLine.refreshInterval;
      } finally {
        rmSync(project, { recursive: true, force: true });
      }
    }

    it('defaults the wired refreshInterval to 5 when nothing is configured', async () => {
      expect(await wiredRefreshInterval(undefined)).toBe(5);
    });

    it('honors statusline.refresh_interval_seconds set through the config API', async () => {
      const project = mkdtempSync(join(tmpdir(), 'ape-proj-'));
      try {
        await configAction(project, 'set', {
          key: 'statusline.refresh_interval_seconds',
          value: 2,
        });
        const res = await configAction(project, 'wire', { host: 'claude' });
        expect(res.ok).toBe(true);
        const settings = JSON.parse(readFileSync(settingsFile(), 'utf8'));
        expect(settings.statusLine.refreshInterval).toBe(2);
      } finally {
        rmSync(project, { recursive: true, force: true });
      }
    });

    it('passes a larger configured interval straight through — no upper clamp', async () => {
      expect(await wiredRefreshInterval(30)).toBe(30);
    });

    it('floors fractional intervals and clamps sub-1 values up to an integer >= 1', async () => {
      expect(await wiredRefreshInterval(2.9)).toBe(2); // floor, not round
      expect(await wiredRefreshInterval(1.5)).toBe(1); // floor
      expect(await wiredRefreshInterval(0)).toBe(1);   // min-1 clamp
      expect(await wiredRefreshInterval(-1)).toBe(1);  // min-1 clamp
    });

    it('falls back to the default 5 for a non-numeric configured value', async () => {
      expect(await wiredRefreshInterval('abc')).toBe(5);
      expect(await wiredRefreshInterval(null)).toBe(5);
    });

    it('re-wiring is idempotent, resolved refreshInterval included', async () => {
      const project = mkdtempSync(join(tmpdir(), 'ape-proj-'));
      try {
        await configAction(project, 'wire', { host: 'claude' });
        const first = JSON.parse(readFileSync(settingsFile(), 'utf8')).statusLine;
        await configAction(project, 'wire', { host: 'claude' });
        const second = JSON.parse(readFileSync(settingsFile(), 'utf8')).statusLine;
        expect(second).toEqual(first);
        expect(second.refreshInterval).toBe(5);
      } finally {
        rmSync(project, { recursive: true, force: true });
      }
    });

    it('unwire still removes the whole statusLine block after a custom interval was wired', async () => {
      const project = mkdtempSync(join(tmpdir(), 'ape-proj-'));
      try {
        await configAction(project, 'set', {
          key: 'statusline.refresh_interval_seconds',
          value: 3,
        });
        await configAction(project, 'wire', { host: 'claude' });
        const res = await configAction(project, 'unwire', { host: 'claude' });
        expect(res.statusline.removed).toBe(true);
        expect(JSON.parse(readFileSync(settingsFile(), 'utf8')).statusLine).toBeUndefined();
      } finally {
        rmSync(project, { recursive: true, force: true });
      }
    });
  });

  it('rejects an unsupported host', async () => {
    await expect(configAction(project, 'wire', { host: 'other' })).rejects.toThrow(/host/);
  });
});
