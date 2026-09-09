import {
  addTokens,
  emptyTokens,
  type Harness,
  type SessionRollup,
  type TokenCounts,
} from "./types.ts";

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
  /** Per-model split, so a session that mixed models can be priced correctly. */
  tokensByModel: Map<string, TokenCounts>;
  measuredCost: number;
  /** Per-model split of the measured dollars, for the model column. */
  measuredCostByModel: Map<string, number>;
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
  sidechainTools: Map<string, number>;
  sidechainToolErrors: number;

  /**
   * True while folding a subagent transcript. Subagent activity is attributed
   * to the sidechain totals rather than the parent's, so tokens, tools and
   * errors are all split the same way and the rollup agrees with the detail
   * view, which parses the two sets of files separately.
   */
  sidechainMode: boolean;

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
  lastUsageModel?: string;
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
    tokensByModel: new Map(),
    measuredCost: 0,
    measuredCostByModel: new Map(),
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
    sidechainTools: new Map(),
    sidechainToolErrors: 0,
    sidechainMode: false,
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
  model?: string,
): void {
  const bucket = target === "sidechain" ? acc.sidechainTokens : acc.tokens;

  if (key !== undefined && key === acc.lastUsageKey && acc.lastUsageCharged) {
    const prev = acc.lastUsageCharged;
    const negated: TokenCounts = {
      input: -prev.input,
      output: -prev.output,
      cacheRead: -prev.cacheRead,
      cacheWrite: -prev.cacheWrite,
      thinking: -prev.thinking,
    };
    const prevBucket =
      acc.lastUsageTarget === "sidechain" ? acc.sidechainTokens : acc.tokens;
    addTokens(prevBucket, negated);
    if (acc.lastUsageModel !== undefined) {
      addTokens(modelBucket(acc, acc.lastUsageModel), negated);
    }
  } else {
    // A new response, not another block of the one we just counted.
    if (target === "sidechain") acc.sidechainTurnCount += 1;
    else acc.turnCount += 1;
  }

  addTokens(bucket, usage);
  if (model !== undefined) addTokens(modelBucket(acc, model), usage);

  if (key !== undefined) {
    acc.lastUsageKey = key;
    acc.lastUsageCharged = { ...usage };
    acc.lastUsageTarget = target;
    acc.lastUsageModel = model;
  } else {
    acc.lastUsageKey = undefined;
    acc.lastUsageCharged = undefined;
    acc.lastUsageTarget = undefined;
    acc.lastUsageModel = undefined;
  }
}

function modelBucket(acc: Accumulator, model: string): TokenCounts {
  let bucket = acc.tokensByModel.get(model);
  if (!bucket) {
    bucket = emptyTokens();
    acc.tokensByModel.set(model, bucket);
  }
  return bucket;
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
  const bucket = acc.sidechainMode ? acc.sidechainTools : acc.tools;
  bucket.set(name, (bucket.get(name) ?? 0) + 1);
}

export function countToolError(acc: Accumulator): void {
  if (acc.sidechainMode) acc.sidechainToolErrors += 1;
  else acc.toolErrors += 1;
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
    tokensByModel: Object.fromEntries(
      [...acc.tokensByModel].map(([model, t]) => [model, { ...t }]),
    ),
    cost: acc.hasMeasuredCost
      ? {
          measured: acc.measuredCost,
          byModel: Object.fromEntries(
            [...acc.measuredCostByModel].map(([model, dollars]) => [
              model,
              { dollars, imputed: false },
            ]),
          ),
        }
      : {},
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
      tools: Object.fromEntries(
        [...acc.sidechainTools].sort(([a], [b]) => a.localeCompare(b)),
      ),
      toolErrors: acc.sidechainToolErrors,
    },
    parseErrors: acc.parseErrors,
  };
}
