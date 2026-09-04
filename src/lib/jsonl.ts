export interface FoldResult {
  /** Bytes consumed, always ending on a newline. */
  bytesConsumed: number;
  linesFolded: number;
  parseErrors: number;
}

/**
 * Fold complete JSONL lines out of `buffer`, calling `onRecord` per record.
 *
 * A tail can catch a line the harness is still writing, so anything after the
 * last newline is left unconsumed for the next read rather than parsed as a
 * truncated record.
 */
export function foldJsonl(
  buffer: Buffer,
  onRecord: (record: unknown) => void,
): FoldResult {
  const lastNewline = buffer.lastIndexOf(0x0a);
  if (lastNewline === -1) {
    return { bytesConsumed: 0, linesFolded: 0, parseErrors: 0 };
  }

  const complete = buffer.subarray(0, lastNewline + 1).toString("utf8");
  let linesFolded = 0;
  let parseErrors = 0;

  for (const line of complete.split("\n")) {
    if (line === "") continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      // A malformed line is counted and skipped; one bad record must never
      // take out the whole session.
      parseErrors += 1;
      continue;
    }
    onRecord(record);
    linesFolded += 1;
  }

  return { bytesConsumed: lastNewline + 1, linesFolded, parseErrors };
}
