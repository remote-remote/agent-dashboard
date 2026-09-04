import { mkdtemp, mkdir, rm, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "agent-dashboard-"));
  process.env.AGENT_DASHBOARD_CLAUDE_ROOT = join(root, "claude");
  process.env.AGENT_DASHBOARD_PI_ROOT = join(root, "pi");
  await mkdir(join(root, "claude", "projects", "-tmp-proj"), { recursive: true });
  await mkdir(join(root, "pi", "sessions", "--tmp-proj--"), { recursive: true });
  vi.resetModules();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});


async function freshIndex() {
  // Path constants are read at module load, so the index must be imported after
  // the fixture roots are in place.
  const { SessionIndex } = await import("./index-store");
  return new SessionIndex();
}

const SESSION = "11111111-1111-1111-1111-111111111111";

function claudePath() {
  return join(root, "claude", "projects", "-tmp-proj", `${SESSION}.jsonl`);
}

/** One response written as several records, each repeating the same usage. */
function responseRecords(id: string, output: number, tools: string[]) {
  const usage = {
    input_tokens: 3,
    output_tokens: output,
    cache_read_input_tokens: 100,
    cache_creation_input_tokens: 10,
    output_tokens_details: { thinking_tokens: 5 },
  };
  const base = {
    type: "assistant",
    sessionId: SESSION,
    cwd: "/tmp/proj",
    timestamp: "2026-09-04T00:00:00.000Z",
    gitBranch: "main",
  };
  const blocks: unknown[][] = [[{ type: "text", text: "hi" }]];
  for (const name of tools) blocks.push([{ type: "tool_use", name, input: {} }]);

  return blocks.map((content, i) => ({
    ...base,
    apiBlockIndex: i,
    uuid: `${id}-${i}`,
    message: { id, model: "claude-opus-5", usage, content },
  }));
}

function transcriptLines() {
  return [
    { type: "session", sessionId: SESSION, cwd: "/tmp/proj", timestamp: "2026-09-04T00:00:00.000Z" },
    { type: "ai-title", aiTitle: "A test session", sessionId: SESSION },
    { type: "user", sessionId: SESSION, message: { content: "do the thing" }, timestamp: "2026-09-04T00:00:01.000Z" },
    ...responseRecords("msg_a", 143, ["Bash", "Read"]),
    { type: "user", sessionId: SESSION, message: { content: [{ type: "tool_result", is_error: true }] }, timestamp: "2026-09-04T00:00:05.000Z" },
    ...responseRecords("msg_b", 260, ["Edit"]),
    { type: "cost-state", sessionId: SESSION, totalCostUSD: 0, totalLinesAdded: 9, totalLinesRemoved: 2 },
  ].map((r) => JSON.stringify(r));
}

describe("SessionIndex incremental tailing", () => {
  it("matches a full parse when the file arrives in one piece", async () => {
    const lines = transcriptLines();
    await writeFile(claudePath(), lines.join("\n") + "\n");

    const index = await freshIndex();
    await index.refresh();
    const rollup = index.get(`claude:${SESSION}`);

    expect(rollup).toBeDefined();
    expect(rollup!.tokens.output).toBe(403); // 143 + 260, each counted once
    expect(rollup!.turnCount).toBe(2);
    expect(rollup!.tools).toEqual({ Bash: 1, Edit: 1, Read: 1 });
    expect(rollup!.toolErrors).toBe(1);
    expect(rollup!.userPromptCount).toBe(1);
    expect(rollup!.title).toBe("A test session");
    expect(rollup!.linesAdded).toBe(9);
  });

  it("reaches the same totals when the transcript is appended line by line", async () => {
    const lines = transcriptLines();
    const index = await freshIndex();

    await writeFile(claudePath(), "");
    for (const line of lines) {
      await appendFile(claudePath(), line + "\n");
      await index.refresh();
    }

    const incremental = index.get(`claude:${SESSION}`);

    const oneShot = await freshIndex();
    await oneShot.refresh();
    const full = oneShot.get(`claude:${SESSION}`);

    expect(incremental).toEqual(full);
  });

  it("does not double count when a read splits a response group", async () => {
    // The two records of msg_a land in different reads, so the dedup window has
    // to survive across refreshes.
    const lines = transcriptLines();
    const index = await freshIndex();

    const split = lines.findIndex((l) => l.includes('"apiBlockIndex":1'));
    await writeFile(claudePath(), lines.slice(0, split).join("\n") + "\n");
    await index.refresh();
    await appendFile(claudePath(), lines.slice(split).join("\n") + "\n");
    await index.refresh();

    const rollup = index.get(`claude:${SESSION}`);
    expect(rollup!.tokens.output).toBe(403);
    expect(rollup!.turnCount).toBe(2);
  });

  it("ignores a line that is still being written", async () => {
    const lines = transcriptLines();
    const index = await freshIndex();

    const whole = lines.join("\n") + "\n";
    const cut = whole.length - 40;
    await writeFile(claudePath(), whole.slice(0, cut)); // no trailing newline
    await index.refresh();
    const partial = index.get(`claude:${SESSION}`)!;

    await writeFile(claudePath(), whole);
    await index.refresh();
    const complete = index.get(`claude:${SESSION}`)!;

    expect(partial.parseErrors).toBe(0);
    expect(complete.parseErrors).toBe(0);
    expect(complete.tokens.output).toBe(403);
  });

  it("re-parses from scratch when a transcript is rewritten shorter", async () => {
    const lines = transcriptLines();
    const index = await freshIndex();

    await writeFile(claudePath(), lines.join("\n") + "\n");
    await index.refresh();
    expect(index.get(`claude:${SESSION}`)!.tokens.output).toBe(403);

    // Compaction: the file is replaced by something smaller.
    await writeFile(claudePath(), lines.slice(0, 6).join("\n") + "\n");
    const stats = await index.refresh();

    expect(stats.reparsed).toBe(1);
    expect(index.get(`claude:${SESSION}`)!.tokens.output).toBe(143);
    expect(index.get(`claude:${SESSION}`)!.turnCount).toBe(1);
  });

  it("reads nothing on a refresh when no file changed", async () => {
    await writeFile(claudePath(), transcriptLines().join("\n") + "\n");
    const index = await freshIndex();
    await index.refresh();

    const stats = await index.refresh();
    expect(stats.bytesRead).toBe(0);
    expect(stats.filesRead).toBe(0);
  });

  it("folds subagent transcripts into the parent's sidechain totals", async () => {
    await writeFile(claudePath(), transcriptLines().join("\n") + "\n");

    const subagents = join(root, "claude", "projects", "-tmp-proj", SESSION, "subagents");
    await mkdir(subagents, { recursive: true });
    await writeFile(
      join(subagents, "agent-abc.jsonl"),
      responseRecords("msg_sub", 50, ["Grep"])
        .map((r) => JSON.stringify({ ...r, isSidechain: true, agentId: "abc" }))
        .join("\n") + "\n",
    );

    const index = await freshIndex();
    await index.refresh();
    const rollup = index.get(`claude:${SESSION}`)!;

    expect(rollup.tokens.output).toBe(403);
    expect(rollup.sidechain.tokens.output).toBe(50);
    expect(rollup.sidechain.turnCount).toBe(1);
    // The subagent file is not a session of its own.
    expect(index.getAll()).toHaveLength(1);
  });

  it("drops a session whose transcript disappears", async () => {
    await writeFile(claudePath(), transcriptLines().join("\n") + "\n");
    const index = await freshIndex();
    await index.refresh();
    expect(index.getAll()).toHaveLength(1);

    await rm(claudePath());
    await index.refresh();
    expect(index.getAll()).toHaveLength(0);
  });

  it("indexes pi sessions alongside Claude ones", async () => {
    await writeFile(claudePath(), transcriptLines().join("\n") + "\n");

    const piFile = join(
      root, "pi", "sessions", "--tmp-proj--",
      "2026-09-04T00-00-00-000Z_01a06964-085f-7da8-a7d4-05c51898069f.jsonl",
    );
    await writeFile(piFile, [
      { type: "session", version: 3, id: "x", cwd: "/tmp/proj", timestamp: "2026-09-04T00:00:00.000Z" },
      { type: "model_change", provider: "anthropic", modelId: "claude-opus-4-8", timestamp: "2026-09-04T00:00:00.100Z" },
      {
        type: "message", timestamp: "2026-09-04T00:00:02.000Z",
        message: {
          role: "assistant", model: "claude-opus-4-8", provider: "anthropic", responseId: "r1",
          usage: { input: 2, output: 11, cacheRead: 2158, cacheWrite: 12, cost: { total: 0.001439 } },
          content: [{ type: "toolCall", name: "bash" }],
        },
      },
    ].map((r) => JSON.stringify(r)).join("\n") + "\n");

    const index = await freshIndex();
    await index.refresh();

    expect(index.getAll()).toHaveLength(2);
    const pi = index.get("pi:01a06964-085f-7da8-a7d4-05c51898069f")!;
    expect(pi.cost.measured).toBeCloseTo(0.001439, 9);
    expect(pi.provider).toBe("anthropic");
    expect(pi.tools).toEqual({ bash: 1 });
    // pi has no registry, so status can only come from mtime.
    expect(pi.statusSource).toBe("mtime");
  });
});
