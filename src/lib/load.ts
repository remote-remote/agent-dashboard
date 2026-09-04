import { readFile } from "node:fs/promises";
import { createAccumulator, finalize, type Accumulator } from "./accumulator.ts";
import type { DiscoveredSession } from "./discover.ts";
import { foldJsonl } from "./jsonl.ts";
import { foldClaudeRecord } from "./parse-claude.ts";
import { foldPiRecord } from "./parse-pi.ts";
import { resolveProject } from "./project.ts";
import type { SessionRollup } from "./types.ts";

export function foldInto(
  acc: Accumulator,
  buffer: Buffer,
  isSidechainFile = false,
): number {
  acc.sidechainMode = isSidechainFile;
  const fold =
    acc.harness === "claude"
      ? (r: unknown) => foldClaudeRecord(acc, r, isSidechainFile)
      : (r: unknown) => foldPiRecord(acc, r);

  const result = foldJsonl(buffer, fold);
  acc.parseErrors += result.parseErrors;
  return result.bytesConsumed;
}

async function readOrEmpty(path: string): Promise<Buffer> {
  try {
    return await readFile(path);
  } catch {
    return Buffer.alloc(0);
  }
}

/** Parse a session's transcript (and any subagent transcripts) into a rollup. */
export async function loadSession(
  session: DiscoveredSession,
): Promise<Omit<SessionRollup, "status" | "statusSource">> {
  const acc = createAccumulator(
    session.harness,
    session.sessionId,
    session.transcriptPath,
  );

  foldInto(acc, await readOrEmpty(session.transcriptPath));

  for (const path of session.sidechainPaths) {
    // Subagent files repeat the parent's session id and are folded into the
    // parent's sidechain totals; the dedup key is per-file, so reset it.
    acc.lastUsageKey = undefined;
    acc.lastUsageCharged = undefined;
    foldInto(acc, await readOrEmpty(path), true);
  }

  return finalize(acc, resolveProject(acc.cwd ?? ""));
}
