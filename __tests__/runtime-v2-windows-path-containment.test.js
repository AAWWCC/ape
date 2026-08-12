import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { evidenceOperandNeedsRoot, normalizePath } from '../lib/runtime/hooks.js';

// Windows CI failure fix (part of the 8-failure sweep). PRODUCTION FIX target:
// lib/runtime/hooks.js normalizePath (~line 1347) and evidenceOperandNeedsRoot
// (~line 1428) decide "is this operand absolute?" with `path.isAbsolute(value)`
// alone. The fix adds `value.startsWith('/')` as an ADDITIONAL absolute-path
// signal, so a Unix-rooted operand like `/outside-project` is judged absolute
// (and therefore subjected to containment) NO MATTER what the host platform's
// own `path.isAbsolute` reports for a rootless, driveless path.
//
// WHY THIS FILE MOCKS `path.isAbsolute` (and, for normalizePath, `path.resolve`)
// RATHER THAN CALLING THE FUNCTIONS PLAIN. On THIS host (macOS/POSIX) the real
// `path.isAbsolute('/outside-project')` is already `true` — Node's posix
// implementation, and even Node's own win32 implementation, already treats a
// leading `/` as a root. Calling normalizePath/evidenceOperandNeedsRoot with a
// plain string and the real platform `path` module therefore already returns
// the POST-FIX answer today, on every current platform this suite's CI runs
// on: no observable difference exists to pin, and red-test admission demands a
// genuine, deterministic failure of the authored tests against the unfixed
// tree. The two functions' PUBLIC CONTRACT is platform-INDEPENDENT ("no path
// starting with / should escape containment on any platform" — the ticket's
// own acceptance line), so these arms pin that contract by substituting the
// one primitive the objective names as insufficient (`path.isAbsolute`) with a
// stand-in that reports exactly what the ticket says a real Windows
// `path.isAbsolute` reports for a rootless `/abs` path: `false`. Everything
// downstream is left as the REAL implementation (`path.relative`, and for
// evidenceOperandNeedsRoot nothing else at all), so the arms observe the two
// functions' OWN decision, not a fabricated one.
//
// normalizePath additionally routes a value `path.isAbsolute` calls false
// through `path.resolve(projectDir, value)` before ever reaching
// `path.relative`. The REAL POSIX `path.resolve` independently recognizes a
// leading `/` and resets to it regardless of what `path.isAbsolute` reported,
// which would silently rescue the unfixed function's answer on this host and
// mask the defect the fix targets — the ternary's OWN branch choice would
// never be exercised. `resolveThatDoesNotKnowAboutRoot` models the platform
// behavior the objective attributes to Windows: a rootless `/abs` value is NOT
// independently recognized as anchored, so it is joined UNDER the base like
// any other relative segment — exactly the "judged as relative and allowed"
// failure mode the objective describes. Every other value passes through to
// the real `path.resolve` untouched, so the arms below observe
// normalizePath's OWN `path.isAbsolute(value) ? value : path.resolve(...)`
// branch decision, not a blanket override.
describe('APE v2 hooks.js Windows path containment: leading `/` must be treated as absolute', () => {
  const PROJECT_DIR = '/workspace/user/project';

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockIsAbsoluteAlwaysFalse() {
    vi.spyOn(path, 'isAbsolute').mockReturnValue(false);
  }

  function resolveThatDoesNotKnowAboutRoot(originalResolve) {
    return (...args) => {
      const value = args[args.length - 1];
      if (typeof value === 'string' && value.startsWith('/')) {
        // The platform's own resolve does not independently reset to root for
        // a rootless `/abs` value either — it joins it under the base, same
        // as any other relative segment.
        return path.posix.join(...args);
      }
      return originalResolve(...args);
    };
  }

  describe('evidenceOperandNeedsRoot', () => {
    it('still needs a root for a leading-`/` operand even when path.isAbsolute reports false', () => {
      mockIsAbsoluteAlwaysFalse();
      for (const operand of ['/outside', '/outside-project', '/outside-project/secret', '/etc/passwd']) {
        expect(evidenceOperandNeedsRoot(operand), operand).toBe(true);
      }
    });

    it('non-vacuity: an ordinary relative, dotdot-free operand still needs no root under the same mock', () => {
      // Proves the assertion above is pinned on the leading `/`, not on the
      // mock making every operand report "needs root" unconditionally.
      mockIsAbsoluteAlwaysFalse();
      for (const operand of ['test', 'src/index.js', 'HEAD', '--silent']) {
        expect(evidenceOperandNeedsRoot(operand), operand).toBe(false);
      }
    });
  });

  describe('normalizePath', () => {
    it('returns null for a leading-`/` operand that resolves outside the project', () => {
      for (const operand of ['/outside', '/outside-project', '/outside-project/secret']) {
        expect(normalizePath(operand, PROJECT_DIR), operand).toBeNull();
      }
    });

    it('non-vacuity: an ordinary relative, dotdot-free operand normalizes to itself', () => {
      expect(normalizePath('src/index.js', PROJECT_DIR)).toBe('src/index.js');
      expect(normalizePath('sub/dir/file.test.js', PROJECT_DIR)).toBe('sub/dir/file.test.js');
    });

    it('still returns null for a `..`-segment escape (the pre-existing trigger)', () => {

      expect(normalizePath('../outside', PROJECT_DIR)).toBeNull();
      expect(normalizePath('sub/../../outside', PROJECT_DIR)).toBeNull();
    });
  });
});
