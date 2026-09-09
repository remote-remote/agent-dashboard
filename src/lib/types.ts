export type Harness = "claude" | "pi";

export type SessionStatus = "working" | "idle" | "done" | "unknown";
export type StatusSource = "registry" | "mtime" | "none";

export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  thinking: number;
}

export interface CostBreakdown {
  /** Real dollars, reported by the harness. pi only. */
  measured?: number;
  /** Token counts priced against the user's config table. Claude only. */
  imputed?: number;
  /** Models with no price, so an imputed figure can be flagged as partial. */
  unpricedModels?: string[];
  /**
   * Per-model dollars. A measured session can still hold an imputed entry:
   * pi only attaches a cost to some records, so a model that ran but was never
   * charged is priced from its tokens and flagged, rather than shown as zero.
   */
  byModel?: Record<string, ModelCost>;
}

export interface ModelCost {
  dollars: number;
  imputed: boolean;
}

export interface SidechainTotals {
  turnCount: number;
  tokens: TokenCounts;
  tools: Record<string, number>;
  toolErrors: number;
}

export interface SessionRollup {
  /** `${harness}:${sessionId}` */
  key: string;
  harness: Harness;
  sessionId: string;
  transcriptPath: string;

  cwd: string;
  /** Git repo root walked up from cwd, else cwd itself. */
  project: string;
  gitBranch?: string;
  title?: string;

  startedAt?: string;
  endedAt?: string;
  durationMs: number;

  models: string[];
  provider?: string;
  effort?: string;

  tokens: TokenCounts;
  /** Per-model split, used to price a session that mixed models. */
  tokensByModel: Record<string, TokenCounts>;
  cost: CostBreakdown;

  tools: Record<string, number>;
  toolErrors: number;

  linesAdded: number;
  linesRemoved: number;
  filesTouched: string[];

  turnCount: number;
  userPromptCount: number;
  interruptions: number;

  status: SessionStatus;
  statusSource: StatusSource;

  sidechain: SidechainTotals;

  /** Records that failed to parse or were structurally unrecognizable. */
  parseErrors: number;
}

export function emptyTokens(): TokenCounts {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, thinking: 0 };
}

export function addTokens(target: TokenCounts, delta: TokenCounts): void {
  target.input += delta.input;
  target.output += delta.output;
  target.cacheRead += delta.cacheRead;
  target.cacheWrite += delta.cacheWrite;
  target.thinking += delta.thinking;
}

export function totalTokens(t: TokenCounts): number {
  return t.input + t.output + t.cacheRead + t.cacheWrite;
}
