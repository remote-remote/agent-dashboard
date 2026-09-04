import { describe, expect, it } from "vitest";
import { facets, modelFamily, parseFilters, query, summarize } from "./query";
import type { SessionRollup } from "./types";

function rollup(over: Partial<SessionRollup> = {}): SessionRollup {
  return {
    key: "claude:a", harness: "claude", sessionId: "a", transcriptPath: "/t",
    cwd: "/p", project: "/p", startedAt: "2026-09-04T00:00:00.000Z",
    endedAt: "2026-09-04T01:00:00.000Z", durationMs: 3_600_000,
    models: ["claude-opus-5"],
    tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, thinking: 1 },
    cost: {}, tools: {}, toolErrors: 0, linesAdded: 0, linesRemoved: 0,
    filesTouched: [], turnCount: 1, userPromptCount: 1, interruptions: 0,
    status: "done", statusSource: "registry",
    sidechain: { turnCount: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, thinking: 0 }, tools: {}, toolErrors: 0 },
    parseErrors: 0,
    ...over,
  };
}

describe("parseFilters", () => {
  it("defaults to recent with no filters", () => {
    expect(parseFilters({})).toEqual({
      harness: undefined, project: undefined, model: undefined, status: undefined,
      since: undefined, until: undefined, search: undefined, sort: "recent",
    });
  });

  it("ignores values outside the known vocabulary", () => {
    const f = parseFilters({ harness: "bogus", status: "blocked", sort: "sideways" });
    expect(f.harness).toBeUndefined();
    expect(f.status).toBeUndefined();
    expect(f.sort).toBe("recent");
  });

  it("resolves a named range against now", () => {
    const now = Date.parse("2026-09-04T12:00:00.000Z");
    expect(parseFilters({ range: "24h" }, now).since).toBe("2026-09-03T12:00:00.000Z");
  });

  it("takes the first value when a param repeats", () => {
    expect(parseFilters({ harness: ["pi", "claude"] }).harness).toBe("pi");
  });
});

describe("modelFamily", () => {
  it("groups model ids by family", () => {
    expect(modelFamily("claude-opus-5")).toBe("opus");
    expect(modelFamily("claude-opus-4-8")).toBe("opus");
    expect(modelFamily("claude-haiku-4-5-20251001")).toBe("haiku");
  });

  it("falls back to the id it cannot classify", () => {
    expect(modelFamily("some-other-model")).toBe("some-other-model");
  });
});

describe("query", () => {
  const rows = [
    rollup({ key: "claude:a", sessionId: "a", harness: "claude", project: "/one", startedAt: "2026-09-01T00:00:00.000Z", turnCount: 5 }),
    rollup({ key: "pi:b", sessionId: "b", harness: "pi", project: "/two", startedAt: "2026-09-03T00:00:00.000Z", models: ["claude-haiku-4-5"], status: "working", turnCount: 1 }),
    rollup({ key: "claude:c", sessionId: "c", harness: "claude", project: "/one", startedAt: "2026-09-02T00:00:00.000Z", turnCount: 9 }),
  ];

  it("filters by harness, project, model family and status", () => {
    expect(query(rows, parseFilters({ harness: "pi" })).map((r) => r.sessionId)).toEqual(["b"]);
    expect(query(rows, parseFilters({ project: "/one" })).map((r) => r.sessionId)).toEqual(["c", "a"]);
    expect(query(rows, parseFilters({ model: "haiku" })).map((r) => r.sessionId)).toEqual(["b"]);
    expect(query(rows, parseFilters({ status: "working" })).map((r) => r.sessionId)).toEqual(["b"]);
  });

  it("sorts most recent first by default", () => {
    expect(query(rows, parseFilters({})).map((r) => r.sessionId)).toEqual(["b", "c", "a"]);
  });

  it("sorts by turns when asked", () => {
    expect(query(rows, parseFilters({ sort: "turns" })).map((r) => r.sessionId)).toEqual(["c", "a", "b"]);
  });

  it("applies a time window", () => {
    const f = parseFilters({ since: "2026-09-02T00:00:00.000Z" });
    expect(query(rows, f).map((r) => r.sessionId)).toEqual(["b", "c"]);
  });

  it("searches title, project and session id", () => {
    const titled = [...rows, rollup({ key: "claude:d", sessionId: "d", title: "Fix the parser" })];
    expect(query(titled, parseFilters({ q: "parser" })).map((r) => r.sessionId)).toEqual(["d"]);
  });

  it("combines filters", () => {
    const f = parseFilters({ harness: "claude", project: "/one", sort: "turns" });
    expect(query(rows, f).map((r) => r.sessionId)).toEqual(["c", "a"]);
  });
});

describe("summarize", () => {
  it("keeps measured and imputed dollars apart", () => {
    const totals = summarize([
      rollup({ cost: { measured: 1.5 } }),
      rollup({ cost: { imputed: 9.75 } }),
      rollup({ cost: {} }),
    ]);
    expect(totals.measuredCost).toBe(1.5);
    expect(totals.measuredSessions).toBe(1);
    expect(totals.imputedCost).toBe(9.75);
    expect(totals.imputedSessions).toBe(1);
    expect(totals.sessions).toBe(3);
  });

  it("adds up tokens across sessions", () => {
    const totals = summarize([rollup(), rollup()]);
    expect(totals.tokens).toBe(20); // (1+2+3+4) * 2
    expect(totals.thinking).toBe(2);
  });

  it("counts working sessions", () => {
    expect(summarize([rollup({ status: "working" }), rollup()]).working).toBe(1);
  });
});

describe("facets", () => {
  it("counts projects and model families over every row", () => {
    const f = facets([
      rollup({ project: "/one" }),
      rollup({ project: "/one" }),
      rollup({ project: "/two", models: ["claude-haiku-4-5"] }),
    ]);
    expect(f.projects).toEqual([
      { value: "/one", count: 2 },
      { value: "/two", count: 1 },
    ]);
    expect(f.models).toEqual([
      { value: "opus", count: 2 },
      { value: "haiku", count: 1 },
    ]);
  });
});
