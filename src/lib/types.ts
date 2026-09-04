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
