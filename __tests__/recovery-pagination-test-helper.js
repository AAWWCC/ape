import { execFileSync } from 'node:child_process';
import { gitFixtureEnv } from '../test-support/git-fixtures.js';

// Shared entry points for the recovery/pagination fixtures. baseEnv permits
// adversarial coverage without modifying the orchestrating process environment.
export function fixtureGit(root, args, options = {}, baseEnv = process.env) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', env: gitFixtureEnv(baseEnv), ...options }).trim();
}

export function packagedFixtureEnv(baseEnv = process.env) {
  const env = gitFixtureEnv(baseEnv);
  delete env.CODEX_CWD;
  delete env.CLAUDE_PROJECT_DIR;
  return env;
}
