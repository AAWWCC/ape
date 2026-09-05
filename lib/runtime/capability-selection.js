import { withinClaims } from './path-scope.js';
import { splitCommand } from './runner.js';

// A catalog entry describes a tool the project can use. It grants a worker
// execution authority only when that role also owns every declared output.
export function commandProfileAvailableToRole(profile, role, scope) {
  if (!Array.isArray(profile?.roles) || !profile.roles.includes(role)) return false;
  if (profile.effect !== 'write') return true;
  const claims = role === 'test_writer' ? scope.test_paths ?? [] : scope.claimed_paths ?? [];
  return Array.isArray(profile.output_paths) && profile.output_paths.length > 0 &&
    profile.output_paths.every((file) => withinClaims(file, claims));
}

export function requiredCommandProfileRoles(profile, input, roles) {
  const requirements = (input.required_capabilities ?? []).filter((entry) =>
    entry.kind === 'command_profile' && entry.id === profile.id);
  const runLocal = (input.run_command_profiles ?? []).some((entry) => entry.id === profile.id);
  return (profile.roles ?? []).filter((role) => roles.has(role) &&
    (runLocal || requirements.some((entry) => entry.role === undefined || entry.role === role)));
}

export function scopedEvidenceCommands(commands, profiles, roles, scope) {
  const unavailableWrites = new Set(profiles.filter((profile) => profile.effect === 'write' &&
    !roles.some((role) => commandProfileAvailableToRole(profile, role, scope))).map((profile) => profile.command));
  return [...commands].filter((command) => !unavailableWrites.has(command)).sort();
}

export function sameCommandArgv(left, right) {
  if (left === right) return true;
  // splitCommand describes process argv, not shell expansion. Normalize only
  // literal simple commands; complex approved profiles retain exact matching.
  const literal = /^[A-Za-z0-9_./:=+,@'" \t-]+$/;
  if (typeof left !== 'string' || typeof right !== 'string' || !literal.test(left) || !literal.test(right)) return false;
  if (/''|""/.test(left) || /''|""/.test(right)) return false;
  try {
    const actual = splitCommand(left);
    const declared = splitCommand(right);
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(actual[0] ?? '')) return false;
    return actual.length === declared.length && actual.every((token, index) => token === declared[index]);
  } catch { return false; }
}

export function invokesDeclaredWriteProfile(command, profile) {
  if (profile?.effect !== 'write') return false;
  try {
    const actual = splitCommand(command);
    const declared = splitCommand(profile.command);
    if (sameCommandArgv(command, profile.command)) return true;
    // Appending script arguments does not turn a known generator into a read.
    // npm consumes help/version before its separator. pnpm, Yarn, and Bun forward
    // options after the script name, including --help, to the generator.
    const script = (argv) => ['npm', 'pnpm', 'yarn', 'bun'].includes(argv[0]) &&
      ['run', 'run-script'].includes(argv[1]) ? argv[2] : null;
    const separator = actual.indexOf('--');
    if (actual[0] === 'npm' && actual.slice(0, separator < 0 ? undefined : separator)
      .some((token) => ['--help', '-h', '--version', '-v'].includes(token))) return false;
    return Boolean(script(declared) && script(actual) === script(declared) && actual[0] === declared[0]);
  } catch { return command === profile.command; }
}

export function requiresTestRunnerAdmission(projection) {
  return (projection.runtime_stages ?? []).some((stage) => stage.action === 'run_gates') ||
    (projection.stages ?? []).some((stage) => (stage.required_checks ?? [])
      .some((check) => ['targeted-tests', 'red-test', 'green-test', 'test-correction'].includes(check)));
}
