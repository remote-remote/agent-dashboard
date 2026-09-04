import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TokenCounts } from "./types";

/** Dollars per million tokens. */
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * Base input/output rates are Anthropic's first-party API prices. Cache rates
 * follow the documented multipliers - a cache write costs about 1.25x the input
 * rate and a cache read about 0.1x - except where a model publishes its own
 * cache read price.
 *
 * This table is only a default. Rates change, this machine may run models that
 * are not listed, and the user owns the real numbers: anything in the config
 * file overrides what is here.
 */
export const DEFAULT_PRICES: Record<string, ModelPrice> = {
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  "claude-fable-5": { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-7": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-6": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
};

export const PRICE_CONFIG_PATH =
  process.env.AGENT_DASHBOARD_PRICES ??
  join(homedir(), ".config", "agent-dashboard", "prices.json");

export interface PriceTable {
  prices: Record<string, ModelPrice>;
  /** Where the user's overrides came from, for honesty in the UI. */
  configPath?: string;
  configError?: string;
}

function isPrice(value: unknown): value is ModelPrice {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return ["input", "output", "cacheRead", "cacheWrite"].every(
    (k) => typeof v[k] === "number" && Number.isFinite(v[k] as number),
  );
}

export function loadPriceTable(path = PRICE_CONFIG_PATH): PriceTable {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    // No config is the normal case; the defaults stand.
    return { prices: { ...DEFAULT_PRICES } };
  }

  try {
    const parsed = JSON.parse(raw);
    const source = parsed?.prices ?? parsed;
    if (typeof source !== "object" || source === null) {
      return { prices: { ...DEFAULT_PRICES }, configPath: path, configError: "not an object" };
    }

    const prices = { ...DEFAULT_PRICES };
    for (const [model, price] of Object.entries(source)) {
      if (isPrice(price)) prices[model] = price;
    }
    return { prices, configPath: path };
  } catch (err) {
    return {
      prices: { ...DEFAULT_PRICES },
      configPath: path,
      configError: err instanceof Error ? err.message : "unreadable",
    };
  }
}

/**
 * Look up a model id, tolerating the date suffixes Claude writes
 * (`claude-haiku-4-5-20251001`) and falling back to the nearest known prefix.
 * An unknown model returns undefined rather than a guess: a wrong price is
 * worse than an honest gap.
 */
export function resolvePrice(
  model: string,
  prices: Record<string, ModelPrice>,
): ModelPrice | undefined {
  const exact = prices[model];
  if (exact) return exact;

  const withoutDate = model.replace(/-\d{8}$/, "");
  const dateless = prices[withoutDate];
  if (dateless) return dateless;

  let best: { id: string; price: ModelPrice } | undefined;
  for (const [id, price] of Object.entries(prices)) {
    if (!model.startsWith(id)) continue;
    if (!best || id.length > best.id.length) best = { id, price };
  }
  return best?.price;
}

export interface Imputation {
  cost: number;
  /** Models with no price, so the UI can say the figure is partial. */
  unpriced: string[];
}

export function imputeCost(
  tokensByModel: Record<string, TokenCounts>,
  prices: Record<string, ModelPrice>,
): Imputation {
  let cost = 0;
  const unpriced: string[] = [];

  for (const [model, tokens] of Object.entries(tokensByModel)) {
    const price = resolvePrice(model, prices);
    if (!price) {
      if (
        tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite > 0
      ) {
        unpriced.push(model);
      }
      continue;
    }
    cost +=
      (tokens.input * price.input +
        tokens.output * price.output +
        tokens.cacheRead * price.cacheRead +
        tokens.cacheWrite * price.cacheWrite) /
      1_000_000;
  }

  return { cost, unpriced: unpriced.sort() };
}
