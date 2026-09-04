import {
  addTokens,
  emptyTokens,
  type Harness,
  type SessionRollup,
  type TokenCounts,
} from "./types";

/**
 * Mutable fold target for one session. Folding is incremental: the index reads
 * only the bytes appended since it last looked and folds those records in, so
 * every field here must be a running total that never needs to revisit a record.
 */
export interface Accumulator {
  harness: Harness;
  sessionId: string;
  transcriptPath: string;

  cwd?: string;
  gitBranch?: string;
  title?: string;
  provider?: string;
  effort?: string;

  firstTimestamp?: string;
  lastTimestamp?: string;

  models: Set<string>;
  tokens: TokenCounts;
  measuredCost: number;
  hasMeasuredCost: boolean;

  tools: Map<string, number>;
  toolErrors: number;

  linesAdded: number;
  linesRemoved: number;
  filesTouched: Set<string>;

  turnCount: number;
  userPromptCount: number;
  interruptions: number;

  sidechainTurnCount: number;
  sidechainTokens: TokenCounts;

  parseErrors: number;

  /**
   * Claude splits one API response across one record per content block, each
   * repeating the *same* usage object. Summing them naively inflated output
   * tokens by 126% on the sample corpus. Records sharing a message id are always
   * contiguous, so remembering just the last id and what we already charged for
   * it is enough to correct in place without retaining the whole transcript.
   */
  lastUsageKey?: string;
  lastUsageCharged?: TokenCounts;
  lastUsageTarget?: "main" | "sidechain";
}

export function createAccumulator(
  harness: Harness,
  sessionId: string,
  transcriptPath: string,
): Accumulator {
  return {
    harness,
    sessionId,
    transcriptPath,
    models: new Set(),
    tokens: emptyTokens(),
    measuredCost: 0,
    hasMeasuredCost: false,
    tools: new Map(),
    toolErrors: 0,
    linesAdded: 0,
    linesRemoved: 0,
    filesTouched: new Set(),
    turnCount: 0,
    userPromptCount: 0,
    interruptions: 0,
    sidechainTurnCount: 0,
    sidechainTokens: emptyTokens(),
    parseErrors: 0,
  };
}

/**
 * Charge `usage` against the accumulator, replacing any amount already charged
 * for the same `key`. A repeated key means another content block of a response
 * we have already counted; a later block can also carry a larger output count
 * than an earlier one (streaming), so the newest value wins.
 */
export function chargeUsage(
  acc: Accumulator,
  key: string | undefined,
  usage: TokenCounts,
  target: "main" | "sidechain",
): void {
  const bucket = target === "sidechain" ? acc.sidechainTokens : acc.tokens;

  if (key !== undefined && key === acc.lastUsageKey && acc.lastUsageCharged) {
    const prev = acc.lastUsageCharged;
    const prevBucket =
      acc.lastUsageTarget === "sidechain" ? acc.sidechainTokens : acc.tokens;
    addTokens(prevBucket, {
      input: -prev.input,
      output: -prev.output,
      cacheRead: -prev.cacheRead,
      cacheWrite: -prev.cacheWrite,
      thinking: -prev.thinking,
    });
  } else {
    // A new response, not another block of the one we just counted.
    if (target === "sidechain") acc.sidechainTurnCount += 1;
    else acc.turnCount += 1;
  }

  addTokens(bucket, usage);

  if (key !== undefined) {
    acc.lastUsageKey = key;
    acc.lastUsageCharged = { ...usage };
    acc.lastUsageTarget = target;
  } else {
    acc.lastUsageKey = undefined;
    acc.lastUsageCharged = undefined;
    acc.lastUsageTarget = undefined;
  }
}

export function noteTimestamp(acc: Accumulator, ts: unknown): void {
  if (typeof ts !== "string" || ts === "") return;
  if (acc.firstTimestamp === undefined || ts < acc.firstTimestamp) {
    acc.firstTimestamp = ts;
  }
  if (acc.lastTimestamp === undefined || ts > acc.lastTimestamp) {
    acc.lastTimestamp = ts;
  }
}

export function countTool(acc: Accumulator, name: unknown): void {
  if (typeof name !== "string" || name === "") return;
  acc.tools.set(name, (acc.tools.get(name) ?? 0) + 1);
}

export function finalize(
  acc: Accumulator,
  project: string,
): Omit<SessionRollup, "status" | "statusSource"> {
  const start = acc.firstTimestamp;
  const end = acc.lastTimestamp;
  const durationMs =
    start && end ? Math.max(0, Date.parse(end) - Date.parse(start)) : 0;

  return {
    key: `${acc.harness}:${acc.sessionId}`,
    harness: acc.harness,
    sessionId: acc.sessionId,
    transcriptPath: acc.transcriptPath,
    cwd: acc.cwd ?? "",
    project,
    gitBranch: acc.gitBranch,
    title: acc.title,
    startedAt: start,
    endedAt: end,
    durationMs: Number.isFinite(durationMs) ? durationMs : 0,
    models: [...acc.models].sort(),
    provider: acc.provider,
    effort: acc.effort,
    tokens: { ...acc.tokens },
    cost: acc.hasMeasuredCost ? { measured: acc.measuredCost } : {},
    tools: Object.fromEntries([...acc.tools].sort(([a], [b]) => a.localeCompare(b))),
    toolErrors: acc.toolErrors,
    linesAdded: acc.linesAdded,
    linesRemoved: acc.linesRemoved,
    filesTouched: [...acc.filesTouched].sort(),
    turnCount: acc.turnCount,
    userPromptCount: acc.userPromptCount,
    interruptions: acc.interruptions,
    sidechain: {
      turnCount: acc.sidechainTurnCount,
      tokens: { ...acc.sidechainTokens },
    },
    parseErrors: acc.parseErrors,
  };
}
