import { describe, expect, it } from "vitest";
import { parseProcStart, PI_LIVE_WINDOW_MS } from "./status.ts";

describe("parseProcStart", () => {
  it("reads the ps lstart format as UTC", () => {
    // The registry writes this field in UTC while `ps` prints local time.
    // Comparing the two as strings never matches, which would resolve every
    // live session to `done`.
    expect(parseProcStart("Fri Sep  4 14:06:47 2026")).toBe(
      Date.UTC(2026, 8, 4, 14, 6, 47),
    );
  });

  it("handles a padded and an unpadded day", () => {
    expect(parseProcStart("Mon Sep  1 00:00:00 2026")).toBe(Date.UTC(2026, 8, 1, 0, 0, 0));
    expect(parseProcStart("Wed Dec 31 23:59:59 2025")).toBe(Date.UTC(2025, 11, 31, 23, 59, 59));
  });

  it("agrees with the epoch startedAt the registry writes alongside it", () => {
    // Observed pairing from a live registry file.
    expect(parseProcStart("Fri Sep  4 14:06:47 2026")).toBe(1788530807000);
  });

  it("returns undefined for anything it does not recognize", () => {
    expect(parseProcStart("")).toBeUndefined();
    expect(parseProcStart("not a date")).toBeUndefined();
    expect(parseProcStart("Fri Xxx  4 14:06:47 2026")).toBeUndefined();
  });
});

describe("pi liveness window", () => {
  it("is a minute", () => {
    expect(PI_LIVE_WINDOW_MS).toBe(60_000);
  });
});
