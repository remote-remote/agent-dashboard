import {
  chargeUsage,
  countTool,
  noteTimestamp,
  type Accumulator,
} from "./accumulator";
import type { TokenCounts } from "./types";

const INTERRUPT_MARKERS = [
  "[Request interrupted by user",
  "[Request interrupted by the user",
];

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

function readUsage(usage: Record<string, unknown> | undefined): TokenCounts {
  if (!usage) return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, thinking: 0 };
  const details = asRecord(usage.output_tokens_details);
  return {
    input: num(usage.input_tokens),
    output: num(usage.output_tokens),
    cacheRead: num(usage.cache_read_input_tokens),
    cacheWrite: num(usage.cache_creation_input_tokens),
    thinking: num(details?.thinking_tokens),
  };
}

/** Text of a user message, whether stored as a bare string or content blocks. */
function userText(message: Record<string, unknown>): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      const b = asRecord(block);
      return b?.type === "text" && typeof b.text === "string" ? b.text : "";
    })
    .join("\n");
}

/**
 * Fold one Claude transcript record into the accumulator.
 *
 * `isSidechainFile` is set when reading a `<sessionId>/subagents/*.jsonl` file.
 * Subagent turns live in their own files, not inline in the parent transcript,
 * so the flag rather than the record's `isSidechain` decides the bucket.
 */
export function foldClaudeRecord(
  acc: Accumulator,
  record: unknown,
  isSidechainFile = false,
): void {
  const rec = asRecord(record);
  if (!rec) {
    acc.parseErrors += 1;
    return;
  }

  const type = typeof rec.type === "string" ? rec.type : undefined;
  noteTimestamp(acc, rec.timestamp);

  if (typeof rec.cwd === "string" && rec.cwd !== "" && acc.cwd === undefined) {
    acc.cwd = rec.cwd;
  }
  if (typeof rec.gitBranch === "string" && rec.gitBranch !== "") {
    acc.gitBranch = rec.gitBranch;
  }

  const sidechain = isSidechainFile || rec.isSidechain === true;

  switch (type) {
    case "assistant": {
      const message = asRecord(rec.message);
      if (!message) {
        acc.parseErrors += 1;
        return;
      }

      const model = message.model;
      // `<synthetic>` marks locally generated messages with no real API call.
      if (typeof model === "string" && model !== "" && model !== "<synthetic>") {
        acc.models.add(model);
      }
      if (typeof rec.effort === "string" && rec.effort !== "") {
        acc.effort = rec.effort;
      }

      const usageKey =
        typeof message.id === "string" && message.id !== ""
          ? message.id
          : undefined;
      chargeUsage(
        acc,
        usageKey,
        readUsage(asRecord(message.usage)),
        sidechain ? "sidechain" : "main",
      );

      if (Array.isArray(message.content)) {
        for (const block of message.content) {
          const b = asRecord(block);
          if (b?.type === "tool_use") countTool(acc, b.name);
        }
      }
      return;
    }

    case "user": {
      const message = asRecord(rec.message);
      if (!message) {
        acc.parseErrors += 1;
        return;
      }

      let sawToolResult = false;
      if (Array.isArray(message.content)) {
        for (const block of message.content) {
          const b = asRecord(block);
          if (b?.type !== "tool_result") continue;
          sawToolResult = true;
          if (b.is_error === true) acc.toolErrors += 1;
        }
      }

      const text = userText(message);
      if (INTERRUPT_MARKERS.some((m) => text.includes(m))) {
        acc.interruptions += 1;
      }

      // `isMeta` records are injected context, not something the user typed.
      if (!sawToolResult && rec.isMeta !== true && !sidechain) {
        acc.userPromptCount += 1;
      }
      return;
    }

    case "ai-title": {
      if (typeof rec.aiTitle === "string" && rec.aiTitle !== "") {
        acc.title = rec.aiTitle;
      }
      return;
    }

    case "cost-state": {
      // `totalCostUSD` is always 0 on a subscription, so it is deliberately
      // ignored; dollars for Claude are imputed from token counts instead.
      acc.linesAdded = Math.max(acc.linesAdded, num(rec.totalLinesAdded));
      acc.linesRemoved = Math.max(acc.linesRemoved, num(rec.totalLinesRemoved));
      return;
    }

    case "file-history-snapshot":
    case "file-history-delta": {
      const path = rec.trackingPath;
      if (typeof path === "string" && path !== "") acc.filesTouched.add(path);
      return;
    }

    default:
      // Unknown and uninteresting record types are ignored, not errors: the
      // schema is undocumented and gains new types across Claude Code releases.
      return;
  }
}
