import {
  chargeUsage,
  countTool,
  countToolError,
  noteTimestamp,
  type Accumulator,
} from "./accumulator.ts";
import type { TokenCounts } from "./types.ts";

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
  return {
    input: num(usage.input),
    output: num(usage.output),
    cacheRead: num(usage.cacheRead),
    // `cacheWrite1h` is a breakdown of `cacheWrite`, not an addition to it:
    // input + output + cacheRead + cacheWrite already equals `totalTokens`.
    cacheWrite: num(usage.cacheWrite),
    thinking: num(usage.reasoning),
  };
}

/** Fold one pi transcript record into the accumulator. */
export function foldPiRecord(acc: Accumulator, record: unknown): void {
  const rec = asRecord(record);
  if (!rec) {
    acc.parseErrors += 1;
    return;
  }

  const type = typeof rec.type === "string" ? rec.type : undefined;
  noteTimestamp(acc, rec.timestamp);

  switch (type) {
    case "session": {
      if (typeof rec.cwd === "string" && rec.cwd !== "") acc.cwd = rec.cwd;
      return;
    }

    case "model_change": {
      if (typeof rec.modelId === "string" && rec.modelId !== "") {
        acc.models.add(rec.modelId);
      }
      if (typeof rec.provider === "string" && rec.provider !== "") {
        acc.provider = rec.provider;
      }
      return;
    }

    case "thinking_level_change": {
      const level = rec.level ?? rec.thinkingLevel;
      if (typeof level === "string" && level !== "") acc.effort = level;
      return;
    }

    case "message": {
      const message = asRecord(rec.message);
      if (!message) {
        acc.parseErrors += 1;
        return;
      }
      foldPiMessage(acc, message);
      return;
    }

    default:
      return;
  }
}

function foldPiMessage(acc: Accumulator, message: Record<string, unknown>): void {
  const role = typeof message.role === "string" ? message.role : undefined;

  switch (role) {
    case "assistant": {
      if (typeof message.model === "string" && message.model !== "") {
        acc.models.add(message.model);
      }
      if (typeof message.provider === "string" && message.provider !== "") {
        acc.provider = message.provider;
      }

      const usage = asRecord(message.usage);
      // pi writes one record per assistant response, so `responseId` dedup is
      // belt-and-braces rather than load-bearing as it is for Claude.
      const usageKey =
        typeof message.responseId === "string" && message.responseId !== ""
          ? message.responseId
          : undefined;
      chargeUsage(acc, usageKey, readUsage(usage), "main");

      const cost = asRecord(usage?.cost);
      if (cost && typeof cost.total === "number" && Number.isFinite(cost.total)) {
        acc.measuredCost += cost.total;
        acc.hasMeasuredCost = true;
      }

      if (Array.isArray(message.content)) {
        for (const block of message.content) {
          const b = asRecord(block);
          if (b?.type === "toolCall") countTool(acc, b.name);
        }
      }
      return;
    }

    case "user": {
      acc.userPromptCount += 1;
      return;
    }

    case "toolResult": {
      if (message.isError === true) countToolError(acc);
      return;
    }

    default:
      return;
  }
}
