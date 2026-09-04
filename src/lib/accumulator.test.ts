import { describe, expect, it } from "vitest";
import { chargeUsage, createAccumulator, finalize } from "./accumulator.ts";
import { foldClaudeRecord } from "./parse-claude.ts";
import { foldPiRecord } from "./parse-pi.ts";

const usage = (o: number, cr = 0) => ({
  input: 1,
  output: o,
  cacheRead: cr,
  cacheWrite: 0,
  thinking: 0,
});

function claudeAssistant(id: string, output: number, content: unknown[] = []) {
  return {
    type: "assistant",
    timestamp: "2026-09-04T00:00:00.000Z",
    cwd: "/tmp/x",
    message: {
      id,
      model: "claude-opus-5",
      usage: { input_tokens: 1, output_tokens: output, cache_read_input_tokens: 0 },
      content,
    },
  };
}

describe("chargeUsage", () => {
  it("counts one response once", () => {
    const acc = createAccumulator("claude", "s", "/t");
    chargeUsage(acc, "msg_1", usage(10), "main");
    expect(acc.tokens.output).toBe(10);
    expect(acc.turnCount).toBe(1);
  });

  it("does not double count repeated blocks of one response", () => {
    const acc = createAccumulator("claude", "s", "/t");
    chargeUsage(acc, "msg_1", usage(143), "main");
    chargeUsage(acc, "msg_1", usage(143), "main");
    chargeUsage(acc, "msg_1", usage(143), "main");
    expect(acc.tokens.output).toBe(143);
    expect(acc.turnCount).toBe(1);
  });

  it("keeps the newest value when a later block reports more output", () => {
    // Streaming: an early block is written before the response finished.
    const acc = createAccumulator("claude", "s", "/t");
    chargeUsage(acc, "msg_1", usage(4), "main");
    chargeUsage(acc, "msg_1", usage(260), "main");
    expect(acc.tokens.output).toBe(260);
    expect(acc.turnCount).toBe(1);
  });

  it("counts distinct responses separately", () => {
    const acc = createAccumulator("claude", "s", "/t");
    chargeUsage(acc, "msg_1", usage(10), "main");
    chargeUsage(acc, "msg_2", usage(20), "main");
    expect(acc.tokens.output).toBe(30);
    expect(acc.turnCount).toBe(2);
  });

  it("counts every record when no dedup key is available", () => {
    const acc = createAccumulator("claude", "s", "/t");
    chargeUsage(acc, undefined, usage(10), "main");
    chargeUsage(acc, undefined, usage(10), "main");
    expect(acc.tokens.output).toBe(20);
    expect(acc.turnCount).toBe(2);
  });

  it("keeps sidechain tokens out of the main bucket", () => {
    const acc = createAccumulator("claude", "s", "/t");
    chargeUsage(acc, "msg_1", usage(10), "main");
    chargeUsage(acc, "msg_2", usage(7), "sidechain");
    expect(acc.tokens.output).toBe(10);
    expect(acc.sidechainTokens.output).toBe(7);
    expect(acc.turnCount).toBe(1);
    expect(acc.sidechainTurnCount).toBe(1);
  });
});

describe("foldClaudeRecord", () => {
  it("folds the blocks of one response into a single turn", () => {
    const acc = createAccumulator("claude", "s", "/t");
    foldClaudeRecord(acc, claudeAssistant("msg_1", 143, [{ type: "text", text: "hi" }]));
    foldClaudeRecord(acc, claudeAssistant("msg_1", 143, [{ type: "tool_use", name: "Bash" }]));
    expect(acc.tokens.output).toBe(143);
    expect(acc.turnCount).toBe(1);
    expect(acc.tools.get("Bash")).toBe(1);
  });

  it("ignores synthetic messages when collecting models", () => {
    const acc = createAccumulator("claude", "s", "/t");
    foldClaudeRecord(acc, {
      type: "assistant",
      message: { id: "m", model: "<synthetic>", usage: {} },
    });
    expect([...acc.models]).toEqual([]);
  });

  it("counts typed prompts but not tool results or injected context", () => {
    const acc = createAccumulator("claude", "s", "/t");
    foldClaudeRecord(acc, { type: "user", message: { content: "do the thing" } });
    foldClaudeRecord(acc, { type: "user", isMeta: true, message: { content: "reminder" } });
    foldClaudeRecord(acc, {
      type: "user",
      message: { content: [{ type: "tool_result", is_error: true }] },
    });
    expect(acc.userPromptCount).toBe(1);
    expect(acc.toolErrors).toBe(1);
  });

  it("counts interruptions", () => {
    const acc = createAccumulator("claude", "s", "/t");
    foldClaudeRecord(acc, {
      type: "user",
      message: { content: "[Request interrupted by user]" },
    });
    expect(acc.interruptions).toBe(1);
  });

  it("survives unknown types, missing fields and junk", () => {
    const acc = createAccumulator("claude", "s", "/t");
    expect(() => {
      foldClaudeRecord(acc, { type: "some-future-record", nested: { a: 1 } });
      foldClaudeRecord(acc, { type: "assistant" });
      foldClaudeRecord(acc, {});
      foldClaudeRecord(acc, null);
      foldClaudeRecord(acc, 42);
      foldClaudeRecord(acc, []);
    }).not.toThrow();
    expect(acc.parseErrors).toBeGreaterThan(0);
  });

  it("takes line counts from cost-state and ignores its zero dollar total", () => {
    const acc = createAccumulator("claude", "s", "/t");
    foldClaudeRecord(acc, {
      type: "cost-state",
      totalCostUSD: 0,
      totalLinesAdded: 12,
      totalLinesRemoved: 3,
    });
    const rollup = finalize(acc, "/p");
    expect(rollup.linesAdded).toBe(12);
    expect(rollup.cost.measured).toBeUndefined();
  });
});

describe("foldPiRecord", () => {
  const assistant = (cost: number, output: number) => ({
    type: "message",
    timestamp: "2026-09-04T00:00:00.000Z",
    message: {
      role: "assistant",
      model: "claude-opus-4-8",
      provider: "anthropic",
      responseId: `msg_${output}`,
      usage: {
        input: 2,
        output,
        cacheRead: 5,
        cacheWrite: 7,
        cacheWrite1h: 0,
        reasoning: 3,
        cost: { total: cost },
      },
      content: [{ type: "toolCall", name: "bash" }],
    },
  });

  it("sums measured cost and reads the usage block", () => {
    const acc = createAccumulator("pi", "s", "/t");
    foldPiRecord(acc, assistant(0.001439, 11));
    foldPiRecord(acc, assistant(0.0138475, 13));
    const rollup = finalize(acc, "/p");
    expect(rollup.cost.measured).toBeCloseTo(0.0152865, 9);
    expect(rollup.tokens.output).toBe(24);
    expect(rollup.tokens.thinking).toBe(6);
    expect(rollup.tools.bash).toBe(2);
  });

  it("does not add cacheWrite1h on top of cacheWrite", () => {
    const acc = createAccumulator("pi", "s", "/t");
    foldPiRecord(acc, {
      type: "message",
      message: {
        role: "assistant",
        usage: { input: 2, output: 11, cacheRead: 2158, cacheWrite: 12, cacheWrite1h: 12, totalTokens: 2183 },
      },
    });
    const t = acc.tokens;
    expect(t.input + t.output + t.cacheRead + t.cacheWrite).toBe(2183);
  });

  it("counts tool errors and user turns", () => {
    const acc = createAccumulator("pi", "s", "/t");
    foldPiRecord(acc, { type: "message", message: { role: "user", content: "hi" } });
    foldPiRecord(acc, { type: "message", message: { role: "toolResult", isError: true, toolName: "bash" } });
    foldPiRecord(acc, { type: "message", message: { role: "toolResult", isError: false, toolName: "bash" } });
    expect(acc.userPromptCount).toBe(1);
    expect(acc.toolErrors).toBe(1);
  });

  it("takes cwd, model and provider from metadata records", () => {
    const acc = createAccumulator("pi", "s", "/t");
    foldPiRecord(acc, { type: "session", id: "s", cwd: "/Users/x/proj" });
    foldPiRecord(acc, { type: "model_change", provider: "anthropic", modelId: "claude-opus-4-8" });
    expect(acc.cwd).toBe("/Users/x/proj");
    expect(acc.provider).toBe("anthropic");
    expect([...acc.models]).toEqual(["claude-opus-4-8"]);
  });

  it("survives junk", () => {
    const acc = createAccumulator("pi", "s", "/t");
    expect(() => {
      foldPiRecord(acc, { type: "message" });
      foldPiRecord(acc, null);
      foldPiRecord(acc, { type: "unknown_future" });
    }).not.toThrow();
  });
});
