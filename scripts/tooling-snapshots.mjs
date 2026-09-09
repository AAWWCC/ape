// Shared comparisons for bounded tooling reads. Readers retain their own
// synchronous/asynchronous I/O and lock ownership protocols.
export function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

export function sameSnapshot(left, right) {
  return sameIdentity(left, right)
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function sameLockBytes(left, right) {
  return left.bytes === null || right.bytes === null
    ? left.bytes === right.bytes : left.bytes.equals(right.bytes);
}

export function sameLockSnapshot(left, right) {
  return left && right && sameSnapshot(left.stats, right.stats) && sameLockBytes(left, right);
}

export function sameReclaimableLock(left, right) {
  // Creating the reclaim hard link changes ctime, but not the observed data.
  return left && right
    && sameIdentity(left.stats, right.stats)
    && left.stats.size === right.stats.size
    && left.stats.mtimeMs === right.stats.mtimeMs
    && sameLockBytes(left, right);
}
