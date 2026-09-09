import { runGit } from './git.js';

const COMMIT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;

// A remote merge proves only the pushed head. Later local work is independent
// and must retain its branch even if it has the same tree as that head.
export async function assertLocalShippingBranchCurrent(projectDir, branch, expectedHead) {
  if (!COMMIT.test(expectedHead ?? '')) {
    throw new Error('local shipping branch retained: no exact pushed head is available for safe cleanup');
  }
  const ref = `refs/heads/${branch}`;
  await runGit(projectDir, ['check-ref-format', ref]);
  // for-each-ref distinguishes absence (successful empty output) from Git
  // failures, which must retain the branch and surface cleanup diagnostics.
  const output = await runGit(projectDir, ['for-each-ref', '--format=%(refname) %(objectname) %(symref)', ref]);
  const entries = output.split('\n').filter(Boolean).map((line) => line.trim().split(' '));
  const matches = entries.filter(([name]) => name === ref);
  if (matches.length === 0 && entries.length === 0) return { present: false };
  if (matches.length !== 1 || matches[0][2] || !COMMIT.test(matches[0][1] ?? '')) {
    throw new Error('local shipping branch retained: its exact direct ref could not be verified');
  }
  if (matches[0][1] !== expectedHead) {
    throw new Error('local shipping branch retained: its tip changed after the attested push; preserve the additional local work');
  }
  return { present: true };
}

export async function deleteLocalShippingBranch(projectDir, branch, expectedHead) {
  const observed = await assertLocalShippingBranchCurrent(projectDir, branch, expectedHead);
  if (!observed.present) return observed;
  const ref = `refs/heads/${branch}`;
  const worktrees = await runGit(projectDir, ['worktree', 'list', '--porcelain', '-z'], { raw: true });
  if (worktrees.split('\0').includes(`branch ${ref}`)) {
    throw new Error('local shipping branch retained: it is checked out in a worktree');
  }
  // The expected old OID makes a concurrent commit/ref update a refusal rather
  // than deleting the writer's new tip. --no-deref never deletes another ref.
  await runGit(projectDir, ['update-ref', '--no-deref', '-d', ref, expectedHead]);
  return { present: false };
}
