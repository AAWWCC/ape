import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { lstatFile, statFileHandle } from './file-stats.js';

const CHUNK_BYTES = 64 * 1024;
const MAX_LINE_BYTES = 16 * 1024 * 1024;

// Search the complete retained log without retaining it in memory. Scope and
// operator-recovery replay must still find old audit entries beyond any tail
// window. An unsafe/unreadable log or malformed/oversized line is no evidence
// of an earlier audit; callers prefer a duplicate over an unaudited effect.
export async function receiptAuditContains(file, matches) {
  let handle;
  try {
    const before = await lstatFile(file);
    if (!before.isFile() || before.isSymbolicLink()) return false;
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const opened = await statFileHandle(handle);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino ||
        !Number.isSafeInteger(opened.size) || opened.size < 0) return false;
    let chunks = [];
    let lineBytes = 0;
    let oversized = false;
    const append = (chunk) => {
      if (oversized) return;
      lineBytes += chunk.length;
      if (lineBytes > MAX_LINE_BYTES) { chunks = []; oversized = true; }
      else chunks.push(chunk);
    };
    const matchedLine = () => {
      let matched = false;
      if (!oversized && lineBytes > 0) {
        try { matched = matches(JSON.parse(Buffer.concat(chunks, lineBytes).toString('utf8'))); }
        catch { /* A torn or malformed line does not establish an audit. */ }
      }
      chunks = []; lineBytes = 0; oversized = false;
      return matched;
    };
    let offset = 0;
    // Bound this scan to the descriptor's initial extent: concurrent appends
    // cannot keep a receipt admission alive indefinitely.
    while (offset < opened.size) {
      const buffer = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, opened.size - offset));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      if (!bytesRead) break;
      offset += bytesRead;
      let start = 0;
      for (let end = buffer.indexOf(10, start); end >= 0 && end < bytesRead; end = buffer.indexOf(10, start)) {
        append(buffer.subarray(start, end));
        if (matchedLine()) return true;
        start = end + 1;
      }
      append(buffer.subarray(start, bytesRead));
    }
    return matchedLine();
  } catch { return false; }
  finally { await handle?.close().catch(() => {}); }
}
