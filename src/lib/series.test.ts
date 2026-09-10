import { describe, expect, it } from "vitest";
import { bucketize, byModelFamily, chooseBucket, groupBy, timeExtent, toolUsage } from "./series";
import type { SessionRollup } from "./types";

function rollup(over: Partial<SessionRollup> = {}): SessionRollup {
  return {
    key: "claude:a", harness: "claude", sessionId: "a", transcriptPath: "/t",
    cwd: "/p", project: "/p", startedAt: "2026-09-04T00:00:00.000Z",
    endedAt: "2026-09-04T01:00:00.000Z", durationMs: 3_600_000,
    models: ["claude-opus-5"],
    tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, thinking: 1 },
    tokensByModel: {},
    cost: {}, tools: {}, toolErrors: 0, linesAdded: 0, linesRemoved: 0,
    filesTouched: [], turnCount: 1, userPromptCount: 1, interruptions: 0,
    status: "done", statusSource: "registry",
    sidechain: { turnCount: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, thinking: 0 }, tools: {}, toolErrors: 0 },
    parseErrors: 0,
    ...over,
  };
}

/** Buckets are cut in local time, so expectations are built the same way. */
function localDay(year: number, month: number, day: number, hour = 12): string {
  return new Date(year, month, day, hour).toISOString();
}

describe("chooseBucket", () => {
  const day = 24 * 60 * 60 * 1000;
  it("widens the bucket as the span grows", () => {
    expect(chooseBucket(6 * 60 * 60 * 1000)).toBe("hour");
    expect(chooseBucket(10 * day)).toBe("day");
    expect(chooseBucket(200 * day)).toBe("week");
    expect(chooseBucket(3 * 365 * day)).toBe("month");
  });
});

describe("bucketize", () => {
  const extent = {
    from: new Date(2026, 8, 1).getTime(),
    to: new Date(2026, 8, 4).getTime(),
  };

  it("keeps empty buckets so a quiet day reads as zero", () => {
    const { unit, points } = bucketize([rollup({ startedAt: localDay(2026, 8, 2) })], extent);
    expect(unit).toBe("day");
    expect(points).toHaveLength(4);
    expect(points.map((p) => p.total)).toEqual([0, 10, 0, 0]);
  });

  it("adds up every session that starts in one bucket", () => {
    const { points } = bucketize(
      [
        rollup({ startedAt: localDay(2026, 8, 2, 1), cost: { measured: 1 }, turnCount: 3 }),
        rollup({ startedAt: localDay(2026, 8, 2, 23), cost: { imputed: 2 }, turnCount: 4 }),
      ],
      extent,
    );
    const second = points[1]!;
    expect(second.sessions).toBe(2);
    expect(second.turnCount).toBe(7);
    expect(second.measuredCost).toBe(1);
    expect(second.imputedCost).toBe(2);
  });

  it("counts a session in the bucket it started, not the one it ended in", () => {
    const { points } = bucketize(
      [rollup({ startedAt: localDay(2026, 8, 1, 23), endedAt: localDay(2026, 8, 2, 2) })],
      extent,
    );
    expect(points[0]!.sessions).toBe(1);
    expect(points[1]!.sessions).toBe(0);
  });

  it("counts subagent tool calls with the parent's", () => {
    const { points } = bucketize(
      [
        rollup({
          startedAt: localDay(2026, 8, 1),
          tools: { Bash: 2 },
          sidechain: { turnCount: 1, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, thinking: 0 }, tools: { Read: 3 }, toolErrors: 0 },
        }),
      ],
      extent,
    );
    expect(points[0]!.toolCalls).toBe(5);
  });

  it("promotes the unit rather than drawing thousands of bars", () => {
    const wide = { from: new Date(2020, 0, 1).getTime(), to: new Date(2026, 0, 1).getTime() };
    // Six years is 52k hours and 2.2k days, but only 313 weeks.
    const { unit, points } = bucketize([], wide, "hour");
    expect(unit).toBe("week");
    expect(points.length).toBeLessThanOrEqual(400);
  });

  it("ignores a session with no start", () => {
    const { points } = bucketize([rollup({ startedAt: undefined })], extent);
    expect(points.every((p) => p.sessions === 0)).toBe(true);
  });
});

describe("timeExtent", () => {
  it("prefers the filter window over the data", () => {
    const e = timeExtent(
      [rollup({ startedAt: "2026-01-01T00:00:00.000Z" })],
      "2026-09-01T00:00:00.000Z",
      "2026-09-10T00:00:00.000Z",
    );
    expect(new Date(e.from).toISOString()).toBe("2026-09-01T00:00:00.000Z");
    expect(new Date(e.to).toISOString()).toBe("2026-09-10T00:00:00.000Z");
  });

  it("falls back to the earliest session when the range is open", () => {
    const now = Date.parse("2026-09-10T00:00:00.000Z");
    const e = timeExtent([rollup({ startedAt: "2026-09-01T00:00:00.000Z" })], undefined, undefined, now);
    expect(new Date(e.from).toISOString()).toBe("2026-09-01T00:00:00.000Z");
    expect(e.to).toBe(now);
  });
});

describe("groupBy", () => {
  it("ranks slices by tokens and keeps the two dollar figures apart", () => {
    const slices = groupBy(
      [
        rollup({ project: "/one", cost: { measured: 3 } }),
        rollup({ project: "/two", tokens: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0, thinking: 0 }, cost: { imputed: 5 } }),
        rollup({ project: "/one", cost: { measured: 1 } }),
      ],
      (r) => r.project,
    );
    expect(slices.map((s) => s.key)).toEqual(["/two", "/one"]);
    expect(slices[1]!.sessions).toBe(2);
    expect(slices[1]!.measuredCost).toBe(4);
    expect(slices[0]!.imputedCost).toBe(5);
  });
});

describe("byModelFamily", () => {
  it("splits a mixed session across the models it used", () => {
    const slices = byModelFamily([
      rollup({
        models: ["claude-opus-5", "claude-haiku-4-5"],
        tokensByModel: {
          "claude-opus-5": { input: 10, output: 0, cacheRead: 0, cacheWrite: 0, thinking: 0 },
          "claude-haiku-4-5": { input: 4, output: 0, cacheRead: 0, cacheWrite: 0, thinking: 0 },
        },
        cost: {
          imputed: 1.5,
          byModel: {
            "claude-opus-5": { dollars: 1.25, imputed: true },
            "claude-haiku-4-5": { dollars: 0.25, imputed: false },
          },
        },
      }),
    ]);
    expect(slices.map((s) => s.key)).toEqual(["opus", "haiku"]);
    expect(slices[0]!.imputedCost).toBe(1.25);
    expect(slices[1]!.measuredCost).toBe(0.25);
    expect(slices[1]!.imputedCost).toBe(0);
  });
});

describe("toolUsage", () => {
  it("ranks tools across sessions and caps the list", () => {
    const tools = toolUsage(
      [rollup({ tools: { Bash: 2, Read: 5 } }), rollup({ tools: { Bash: 4 } })],
      1,
    );
    expect(tools).toEqual([{ name: "Bash", count: 6 }]);
  });
});
