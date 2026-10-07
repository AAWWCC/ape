import { devNull } from 'node:os';

/**
 * A fresh environment for Git in disposable test repositories, including Git
 * launched by fixture child processes. Ambient Git settings are never trusted.
 * Compose deliberate fixture overrides (e.g. GIT_INDEX_FILE) after this call:
 * { ...gitFixtureEnv(), GIT_INDEX_FILE: ownedIndex }.
 * Local repository filters and explicit command-line settings remain available.
 */
export function gitFixtureEnv(baseEnv = process.env) {
  const env = Object.fromEntries(
    Object.entries(baseEnv).filter(([key]) => !/^GIT_/i.test(key)),
  );
  Object.assign(env, {
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_SYSTEM: devNull,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'APE Test',
    GIT_AUTHOR_EMAIL: 'ape-test@example.invalid',
    GIT_COMMITTER_NAME: 'APE Test',
    GIT_COMMITTER_EMAIL: 'ape-test@example.invalid',
    GIT_TERMINAL_PROMPT: '0',
    GIT_TEMPLATE_DIR: '',
  });
  // Command-scope settings reach descendant Git processes and override local
  // hook/signing settings, without writing any Git configuration to disk.
  const settings = [
    ['user.name', 'APE Test'],
    ['user.email', 'ape-test@example.invalid'],
    ['init.defaultBranch', 'main'],
    ['core.autocrlf', 'false'],
    ['core.eol', 'lf'],
    ['core.hooksPath', devNull],
    ['commit.gpgSign', 'false'],
    ['tag.gpgSign', 'false'],
  ];
  env.GIT_CONFIG_COUNT = String(settings.length);
  for (const [index, [key, value]] of settings.entries()) {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  }
  return env;
}
