import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_PRICES, imputeCost, loadPriceTable, resolvePrice,
} from "./prices";
import { emptyTokens } from "./types";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "prices-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("resolvePrice", () => {
  it("matches an exact model id", () => {
    expect(resolvePrice("claude-opus-5", DEFAULT_PRICES)?.input).toBe(5);
  });

  it("tolerates the date suffix Claude writes", () => {
    // Transcripts carry ids like claude-haiku-4-5-20251001.
    expect(resolvePrice("claude-haiku-4-5-20251001", DEFAULT_PRICES)?.input).toBe(1);
  });

  it("prefers the longest matching prefix", () => {
    const price = resolvePrice("claude-opus-4-8-preview", DEFAULT_PRICES);
    expect(price?.input).toBe(5);
  });

  it("returns undefined for an unknown model rather than guessing", () => {
    expect(resolvePrice("ornith-1.5:9b", DEFAULT_PRICES)).toBeUndefined();
    expect(resolvePrice("glm-5.3-highspeed", DEFAULT_PRICES)).toBeUndefined();
  });
});

describe("imputeCost", () => {
  it("prices each token class at its own rate", () => {
    const { cost } = imputeCost(
      {
        "claude-opus-5": {
          input: 1_000_000, output: 1_000_000,
          cacheRead: 1_000_000, cacheWrite: 1_000_000, thinking: 0,
        },
      },
      DEFAULT_PRICES,
    );
    // 5 + 25 + 0.5 + 6.25
    expect(cost).toBeCloseTo(36.75, 6);
  });

  it("prices a session that mixed models per model", () => {
    const tokens = (input: number) => ({ ...emptyTokens(), input });
    const { cost } = imputeCost(
      { "claude-opus-5": tokens(1_000_000), "claude-haiku-4-5": tokens(1_000_000) },
      DEFAULT_PRICES,
    );
    expect(cost).toBeCloseTo(6, 6); // 5 + 1, not 2 x either rate
  });

  it("reports models it could not price instead of silently dropping them", () => {
    const { cost, unpriced } = imputeCost(
      {
        "claude-opus-5": { ...emptyTokens(), input: 1_000_000 },
        "ornith-1.5:9b": { ...emptyTokens(), input: 500_000 },
      },
      DEFAULT_PRICES,
    );
    expect(cost).toBeCloseTo(5, 6);
    expect(unpriced).toEqual(["ornith-1.5:9b"]);
  });

  it("ignores an unpriced model that used no tokens", () => {
    const { unpriced } = imputeCost({ "some-model": emptyTokens() }, DEFAULT_PRICES);
    expect(unpriced).toEqual([]);
  });
});

describe("loadPriceTable", () => {
  it("falls back to defaults when there is no config", () => {
    const table = loadPriceTable(join(dir, "missing.json"));
    expect(table.prices["claude-opus-5"]?.input).toBe(5);
    expect(table.configPath).toBeUndefined();
  });

  it("lets the user override a rate", async () => {
    const path = join(dir, "prices.json");
    await writeFile(path, JSON.stringify({
      prices: { "claude-opus-5": { input: 99, output: 1, cacheRead: 2, cacheWrite: 3 } },
    }));

    const table = loadPriceTable(path);
    expect(table.prices["claude-opus-5"]?.input).toBe(99);
    // Models the user did not mention keep their defaults.
    expect(table.prices["claude-haiku-4-5"]?.input).toBe(1);
    expect(table.configPath).toBe(path);
  });

  it("accepts a bare map without the prices wrapper", async () => {
    const path = join(dir, "bare.json");
    await writeFile(path, JSON.stringify({
      "my-local-model": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }));
    expect(loadPriceTable(path).prices["my-local-model"]).toBeDefined();
  });

  it("keeps the defaults and reports the problem on malformed config", async () => {
    const path = join(dir, "bad.json");
    await writeFile(path, "{ not json");

    const table = loadPriceTable(path);
    expect(table.prices["claude-opus-5"]?.input).toBe(5);
    expect(table.configError).toBeTruthy();
  });

  it("skips entries that are not complete prices", async () => {
    const path = join(dir, "partial.json");
    await writeFile(path, JSON.stringify({ "claude-opus-5": { input: 99 } }));
    expect(loadPriceTable(path).prices["claude-opus-5"]?.input).toBe(5);
  });
});
