import { readFile, stat } from "node:fs/promises";
import { discoverAllSessions, type DiscoveredSession } from "./discover";
import { foldJsonl } from "./jsonl";
import type { Harness, TokenCounts } from "./types";
import { emptyTokens } from "./types";

export interface Turn {
  index: number;
  timestamp?: string;
  model?: string;
  effort?: string;
  tokens: TokenCounts;
  tools: string[];
  /** Real dollars, pi only. */
  cost?: number;
  stopReason?: string;
  /** Blank for a turn that only called tools. */
  text: string;
  thinking: boolean;
}

export interface Prompt {
  timestamp?: string;
  text: string;
}

export interface Sidechain {
  agentId: string;
  turns: Turn[];
  tokens: TokenCounts;
}

export interface Retrospective {
  turnCount: number;
  promptCount: number;
  durationMs: number;
  toolCalls: number;
  toolsByName: Record<string, number>;
  toolErrors: number;
  /** Errors as a share of tool calls, or undefined with no calls to divide by. */
  toolErrorRate?: number;
  filesTouched: string[];
  linesAdded: number;
  linesRemoved: number;
  interruptions: number;
  /** From the first prompt to the first tool call. */
  timeToFirstToolMs?: number;
  models: string[];
}

export interface SessionDetail {
  harness: Harness;
  sessionId: string;
  transcriptPath: string;
  cwd?: string;
  gitBranch?: string;
  title?: string;
  provider?: string;
  entrypoint?: string;
  version?: string;
  turns: Turn[];
  prompts: Prompt[];
  sidechains: Sidechain[];
  retro: Retrospective;
  parseErrors: number;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

/**
 * Builder shared by the main transcript and each subagent file. Turns are
 * merged by response id for the same reason the rollup dedups: Claude writes
 * one record per content block, each repeating the whole usage object.
 */
class TurnBuilder {
  turns: Turn[] = [];
  private byId = new Map<string, Turn>();

  add(
    id: string | undefined,
    fields: Omit<Turn, "index" | "tools" | "text" | "thinking"> & {
      tools?: string[];
      text?: string;
      thinking?: boolean;
    },
  ): Turn {
    const existing = id ? this.byId.get(id) : undefined;

    if (existing) {
      // Another block of a response already counted: merge content, and take
      // the newest usage since an early block can predate the final counts.
      existing.tokens = fields.tokens;
      if (fields.cost !== undefined) existing.cost = fields.cost;
      if (fields.tools) existing.tools.push(...fields.tools);
      if (fields.text) existing.text = existing.text ? `${existing.text}\n${fields.text}` : fields.text;
      if (fields.thinking) existing.thinking = true;
      if (fields.stopReason) existing.stopReason = fields.stopReason;
      return existing;
    }

    const turn: Turn = {
      index: this.turns.length,
      timestamp: fields.timestamp,
      model: fields.model,
      effort: fields.effort,
      tokens: fields.tokens,
      cost: fields.cost,
      stopReason: fields.stopReason,
      tools: fields.tools ? [...fields.tools] : [],
      text: fields.text ?? "",
      thinking: fields.thinking ?? false,
    };
    this.turns.push(turn);
    if (id) this.byId.set(id, turn);
    return turn;
  }
}

const INTERRUPT_MARKERS = ["[Request interrupted by user", "[Request interrupted by the user"];

function claudeUsage(usage: Record<string, unknown> | undefined): TokenCounts {
  if (!usage) return emptyTokens();
  const details = asRecord(usage.output_tokens_details);
  return {
    input: num(usage.input_tokens),
    output: num(usage.output_tokens),
    cacheRead: num(usage.cache_read_input_tokens),
    cacheWrite: num(usage.cache_creation_input_tokens),
    thinking: num(details?.thinking_tokens),
  };
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      const b = asRecord(block);
      return b?.type === "text" && typeof b.text === "string" ? b.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

function parseClaude(buffer: Buffer, isSidechain: boolean) {
  const builder = new TurnBuilder();
  const prompts: Prompt[] = [];
  const toolsByName: Record<string, number> = {};
  const filesTouched = new Set<string>();
  let toolErrors = 0;
  let toolCalls = 0;
  let interruptions = 0;
  let linesAdded = 0;
  let linesRemoved = 0;
  let firstToolAt: string | undefined;
  let meta: Partial<SessionDetail> = {};

  const { parseErrors } = foldJsonl(buffer, (record) => {
    const rec = asRecord(record);
    if (!rec) return;

    if (!meta.cwd) meta.cwd = str(rec.cwd);
    const branch = str(rec.gitBranch);
    if (branch) meta.gitBranch = branch;
    if (!meta.entrypoint) meta.entrypoint = str(rec.entrypoint);
    if (!meta.version) meta.version = str(rec.version);

    switch (rec.type) {
      case "assistant": {
        const message = asRecord(rec.message);
        if (!message) return;

        const tools: string[] = [];
        let hasThinking = false;
        if (Array.isArray(message.content)) {
          for (const block of message.content) {
            const b = asRecord(block);
            if (b?.type === "tool_use") {
              const name = str(b.name);
              if (name) {
                tools.push(name);
                toolsByName[name] = (toolsByName[name] ?? 0) + 1;
                toolCalls += 1;
                firstToolAt ??= str(rec.timestamp);
              }
            } else if (b?.type === "thinking") {
              hasThinking = true;
            }
          }
        }

        const model = str(message.model);
        builder.add(str(message.id), {
          timestamp: str(rec.timestamp),
          model: model === "<synthetic>" ? undefined : model,
          effort: str(rec.effort),
          tokens: claudeUsage(asRecord(message.usage)),
          stopReason: str(message.stop_reason),
          tools,
          text: textOf(message.content),
          thinking: hasThinking,
        });
        return;
      }

      case "user": {
        const message = asRecord(rec.message);
        if (!message) return;

        let sawToolResult = false;
        if (Array.isArray(message.content)) {
          for (const block of message.content) {
            const b = asRecord(block);
            if (b?.type !== "tool_result") continue;
            sawToolResult = true;
            if (b.is_error === true) toolErrors += 1;
          }
        }

        const text = textOf(message.content) || (typeof message.content === "string" ? message.content : "");
        if (INTERRUPT_MARKERS.some((m) => text.includes(m))) interruptions += 1;

        if (!sawToolResult && rec.isMeta !== true && !isSidechain) {
          prompts.push({ timestamp: str(rec.timestamp), text });
        }
        return;
      }

      case "ai-title":
        meta.title = str(rec.aiTitle) ?? meta.title;
        return;

      case "cost-state":
        linesAdded = Math.max(linesAdded, num(rec.totalLinesAdded));
        linesRemoved = Math.max(linesRemoved, num(rec.totalLinesRemoved));
        return;

      case "file-history-snapshot":
      case "file-history-delta": {
        const path = str(rec.trackingPath);
        if (path) filesTouched.add(path);
        return;
      }

      default:
        return;
    }
  });

  return {
    builder, prompts, toolsByName, toolCalls, toolErrors, interruptions,
    filesTouched, linesAdded, linesRemoved, firstToolAt, meta, parseErrors,
  };
}

function parsePi(buffer: Buffer) {
  const builder = new TurnBuilder();
  const prompts: Prompt[] = [];
  const toolsByName: Record<string, number> = {};
  let toolErrors = 0;
  let toolCalls = 0;
  let firstToolAt: string | undefined;
  const meta: Partial<SessionDetail> = {};

  const { parseErrors } = foldJsonl(buffer, (record) => {
    const rec = asRecord(record);
    if (!rec) return;

    if (rec.type === "session") {
      meta.cwd = str(rec.cwd) ?? meta.cwd;
      meta.version = rec.version === undefined ? meta.version : String(rec.version);
      return;
    }
    if (rec.type === "model_change") {
      meta.provider = str(rec.provider) ?? meta.provider;
      return;
    }
    if (rec.type !== "message") return;

    const message = asRecord(rec.message);
    if (!message) return;

    if (message.role === "assistant") {
      meta.provider = str(message.provider) ?? meta.provider;

      const tools: string[] = [];
      let hasThinking = false;
      if (Array.isArray(message.content)) {
        for (const block of message.content) {
          const b = asRecord(block);
          if (b?.type === "toolCall") {
            const name = str(b.name);
            if (name) {
              tools.push(name);
              toolsByName[name] = (toolsByName[name] ?? 0) + 1;
              toolCalls += 1;
              firstToolAt ??= str(rec.timestamp);
            }
          } else if (b?.type === "thinking") {
            hasThinking = true;
          }
        }
      }

      const usage = asRecord(message.usage);
      const cost = asRecord(usage?.cost);
      builder.add(str(message.responseId), {
        timestamp: str(rec.timestamp),
        model: str(message.model),
        tokens: {
          input: num(usage?.input),
          output: num(usage?.output),
          cacheRead: num(usage?.cacheRead),
          cacheWrite: num(usage?.cacheWrite),
          thinking: num(usage?.reasoning),
        },
        cost: typeof cost?.total === "number" ? cost.total : undefined,
        stopReason: str(message.stopReason),
        tools,
        text: textOf(message.content),
        thinking: hasThinking,
      });
      return;
    }

    if (message.role === "user") {
      prompts.push({ timestamp: str(rec.timestamp), text: textOf(message.content) });
      return;
    }

    if (message.role === "toolResult" && message.isError === true) {
      toolErrors += 1;
    }
  });

  return {
    builder, prompts, toolsByName, toolCalls, toolErrors, interruptions: 0,
    filesTouched: new Set<string>(), linesAdded: 0, linesRemoved: 0,
    firstToolAt, meta, parseErrors,
  };
}

function sumTokens(turns: Turn[]): TokenCounts {
  const total = emptyTokens();
  for (const turn of turns) {
    total.input += turn.tokens.input;
    total.output += turn.tokens.output;
    total.cacheRead += turn.tokens.cacheRead;
    total.cacheWrite += turn.tokens.cacheWrite;
    total.thinking += turn.tokens.thinking;
  }
  return total;
}

async function readOrEmpty(path: string): Promise<Buffer> {
  try {
    return await readFile(path);
  } catch {
    return Buffer.alloc(0);
  }
}

async function buildDetail(session: DiscoveredSession): Promise<SessionDetail> {
  const buffer = await readOrEmpty(session.transcriptPath);
  const parsed =
    session.harness === "claude" ? parseClaude(buffer, false) : parsePi(buffer);

  const sidechains: Sidechain[] = [];
  let sidechainErrors = 0;
  for (const path of session.sidechainPaths) {
    const sub = parseClaude(await readOrEmpty(path), true);
    sidechainErrors += sub.parseErrors;
    const agentId = path.split("/").pop()?.replace(/^agent-|\.jsonl$/g, "") ?? path;
    sidechains.push({
      agentId,
      turns: sub.builder.turns,
      tokens: sumTokens(sub.builder.turns),
    });
  }

  const turns = parsed.builder.turns;
  const stamps = [
    ...turns.map((t) => t.timestamp),
    ...parsed.prompts.map((p) => p.timestamp),
  ].filter((t): t is string => typeof t === "string");
  const first = stamps.length > 0 ? stamps.reduce((a, b) => (a < b ? a : b)) : undefined;
  const last = stamps.length > 0 ? stamps.reduce((a, b) => (a > b ? a : b)) : undefined;

  const firstPromptAt = parsed.prompts.find((p) => p.timestamp)?.timestamp ?? first;
  const timeToFirstToolMs =
    firstPromptAt && parsed.firstToolAt
      ? Math.max(0, Date.parse(parsed.firstToolAt) - Date.parse(firstPromptAt))
      : undefined;

  return {
    harness: session.harness,
    sessionId: session.sessionId,
    transcriptPath: session.transcriptPath,
    cwd: parsed.meta.cwd,
    gitBranch: parsed.meta.gitBranch,
    title: parsed.meta.title,
    provider: parsed.meta.provider,
    entrypoint: parsed.meta.entrypoint,
    version: parsed.meta.version,
    turns,
    prompts: parsed.prompts,
    sidechains,
    parseErrors: parsed.parseErrors + sidechainErrors,
    retro: {
      turnCount: turns.length,
      promptCount: parsed.prompts.length,
      durationMs: first && last ? Math.max(0, Date.parse(last) - Date.parse(first)) : 0,
      toolCalls: parsed.toolCalls,
      toolsByName: Object.fromEntries(
        Object.entries(parsed.toolsByName).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
      ),
      toolErrors: parsed.toolErrors,
      toolErrorRate: parsed.toolCalls > 0 ? parsed.toolErrors / parsed.toolCalls : undefined,
      filesTouched: [...parsed.filesTouched].sort(),
      linesAdded: parsed.linesAdded,
      linesRemoved: parsed.linesRemoved,
      interruptions: parsed.interruptions,
      timeToFirstToolMs,
      models: [...new Set(turns.map((t) => t.model).filter((m): m is string => !!m))].sort(),
    },
  };
}

/**
 * Small LRU over on-demand re-parses. The detail view is the only place that
 * needs per-turn data, and at the largest transcript on disk (1.7MB) a full
 * re-parse is single-digit milliseconds, so caching is about repeat views
 * rather than making one view fast.
 */
const CACHE_LIMIT = 8;
const cache = new Map<string, { mtimeMs: number; size: number; detail: SessionDetail }>();

export async function getSessionDetail(
  harness: Harness,
  sessionId: string,
): Promise<SessionDetail | undefined> {
  const session = (await discoverAllSessions()).find(
    (s) => s.harness === harness && s.sessionId === sessionId,
  );
  if (!session) return undefined;

  let mtimeMs = 0;
  let size = 0;
  try {
    const info = await stat(session.transcriptPath);
    mtimeMs = info.mtimeMs;
    size = info.size;
  } catch {
    return undefined;
  }

  const key = `${harness}:${sessionId}`;
  const hit = cache.get(key);
  if (hit && hit.mtimeMs === mtimeMs && hit.size === size) {
    cache.delete(key);
    cache.set(key, hit); // refresh recency
    return hit.detail;
  }

  const detail = await buildDetail(session);
  cache.set(key, { mtimeMs, size, detail });
  if (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return detail;
}

export function clearDetailCache(): void {
  cache.clear();
}
