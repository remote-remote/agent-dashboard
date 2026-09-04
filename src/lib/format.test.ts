import { describe, expect, it } from "vitest";
import { formatCost, formatDuration, formatRelative, formatTokens, projectName } from "./format";

describe("formatTokens", () => {
  it("scales by magnitude", () => {
    expect(formatTokens(42)).toBe("42");
    expect(formatTokens(1500)).toBe("1.5k");
    expect(formatTokens(9_700_000)).toBe("9.7M");
    expect(formatTokens(2_400_000_000)).toBe("2.40B");
  });
});

describe("formatCost", () => {
  it("keeps small amounts legible", () => {
    expect(formatCost(0)).toBe("$0");
    expect(formatCost(0.001439)).toBe("$0.0014");
    expect(formatCost(3.4995)).toBe("$3.50");
  });
});

describe("formatDuration", () => {
  it("renders seconds, minutes and hours", () => {
    expect(formatDuration(0)).toBe("-");
    expect(formatDuration(45_000)).toBe("45s");
    expect(formatDuration(600_000)).toBe("10m");
    expect(formatDuration(3_600_000)).toBe("1h");
    expect(formatDuration(5_400_000)).toBe("1h 30m");
  });
});

describe("formatRelative", () => {
  const now = Date.parse("2026-09-04T12:00:00.000Z");
  it("describes recency", () => {
    expect(formatRelative("2026-09-04T11:59:30.000Z", now)).toBe("just now");
    expect(formatRelative("2026-09-04T11:30:00.000Z", now)).toBe("30m ago");
    expect(formatRelative("2026-09-04T09:00:00.000Z", now)).toBe("3h ago");
    expect(formatRelative("2026-09-01T12:00:00.000Z", now)).toBe("3d ago");
    expect(formatRelative(undefined, now)).toBe("-");
  });
});

describe("projectName", () => {
  it("takes the last path segment", () => {
    expect(projectName("/Users/x/code/ts/agent-dashboard")).toBe("agent-dashboard");
  });
});
