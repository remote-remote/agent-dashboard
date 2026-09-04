import type { Harness, SessionRollup, SessionStatus } from "./types";
import { totalTokens } from "./types";

export type SortKey = "recent" | "tokens" | "duration" | "cost" | "turns";

export interface Filters {
  harness?: Harness;
  project?: string;
  /** Model family, e.g. `opus`, matched against any model on the session. */
  model?: string;
  status?: SessionStatus;
  /** Inclusive lower bound on `startedAt`, ISO. */
  since?: string;
  /** Exclusive upper bound on `startedAt`, ISO. */
  until?: string;
  search?: string;
  sort: SortKey;
}

export type SearchParams = Record<string, string | string[] | undefined>;

function one(value: string | string[] | undefined): string | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  return v === undefined || v === "" ? undefined : v;
}

const HARNESSES = new Set<Harness>(["claude", "pi"]);
const STATUSES = new Set<SessionStatus>(["working", "idle", "done", "unknown"]);
const SORTS = new Set<SortKey>(["recent", "tokens", "duration", "cost", "turns"]);

/** Named windows are resolved at parse time so a bookmarked URL stays relative. */
export const RANGES = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
} as const;

export type RangeKey = keyof typeof RANGES;

export function parseFilters(params: SearchParams, now = Date.now()): Filters {
  const harness = one(params.harness) as Harness | undefined;
  const status = one(params.status) as SessionStatus | undefined;
  const sort = one(params.sort) as SortKey | undefined;
  const range = one(params.range) as RangeKey | undefined;

  const windowMs = range ? RANGES[range] : undefined;

  return {
    harness: harness && HARNESSES.has(harness) ? harness : undefined,
    project: one(params.project),
    model: one(params.model),
    status: status && STATUSES.has(status) ? status : undefined,
    since: windowMs ? new Date(now - windowMs).toISOString() : one(params.since),
    until: one(params.until),
    search: one(params.q),
    sort: sort && SORTS.has(sort) ? sort : "recent",
  };
}

/** `claude-opus-4-8` and `claude-opus-5` both belong to family `opus`. */
export function modelFamily(model: string): string {
  const known = ["opus", "sonnet", "haiku", "fable"];
  const lower = model.toLowerCase();
  for (const family of known) {
    if (lower.includes(family)) return family;
  }
  return model;
}

export function modelFamilies(rollup: SessionRollup): string[] {
  return [...new Set(rollup.models.map(modelFamily))].sort();
}

function matches(rollup: SessionRollup, filters: Filters): boolean {
  if (filters.harness && rollup.harness !== filters.harness) return false;
  if (filters.project && rollup.project !== filters.project) return false;
  if (filters.status && rollup.status !== filters.status) return false;

  if (filters.model && !modelFamilies(rollup).includes(filters.model)) return false;

  if (filters.since && (rollup.startedAt ?? "") < filters.since) return false;
  if (filters.until && (rollup.startedAt ?? "") >= filters.until) return false;

  if (filters.search) {
    const needle = filters.search.toLowerCase();
    const haystack = [rollup.title ?? "", rollup.project, rollup.cwd, rollup.sessionId]
      .join(" ")
      .toLowerCase();
    if (!haystack.includes(needle)) return false;
  }

  return true;
}

function sortValue(rollup: SessionRollup, sort: SortKey): number | string {
  switch (sort) {
    case "tokens":
      return totalTokens(rollup.tokens);
    case "duration":
      return rollup.durationMs;
    case "cost":
      return rollup.cost.measured ?? rollup.cost.imputed ?? 0;
    case "turns":
      return rollup.turnCount;
    case "recent":
      return rollup.startedAt ?? "";
  }
}

export function query(rollups: SessionRollup[], filters: Filters): SessionRollup[] {
  const rows = rollups.filter((r) => matches(r, filters));
  rows.sort((a, b) => {
    const av = sortValue(a, filters.sort);
    const bv = sortValue(b, filters.sort);
    if (typeof av === "string" || typeof bv === "string") {
      return String(bv).localeCompare(String(av));
    }
    return bv - av;
  });
  return rows;
}

export interface Totals {
  sessions: number;
  tokens: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  thinking: number;
  /** Real dollars reported by pi. */
  measuredCost: number;
  measuredSessions: number;
  /** Token counts priced at API rates. Never added to measuredCost. */
  imputedCost: number;
  imputedSessions: number;
  /** Sessions whose imputed figure is missing at least one model's price. */
  partiallyPriced: number;
  working: number;
  turnCount: number;
  toolErrors: number;
  linesAdded: number;
  linesRemoved: number;
  sidechainTokens: number;
}

/**
 * Measured and imputed dollars are tracked separately and never summed into one
 * figure: one is what pi actually charged, the other is what Claude would have
 * cost at API rates.
 */
export function summarize(rollups: SessionRollup[]): Totals {
  const totals: Totals = {
    sessions: rollups.length,
    tokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, thinking: 0,
    measuredCost: 0, measuredSessions: 0,
    imputedCost: 0, imputedSessions: 0, partiallyPriced: 0,
    working: 0, turnCount: 0, toolErrors: 0,
    linesAdded: 0, linesRemoved: 0, sidechainTokens: 0,
  };

  for (const r of rollups) {
    totals.tokens += totalTokens(r.tokens);
    totals.input += r.tokens.input;
    totals.output += r.tokens.output;
    totals.cacheRead += r.tokens.cacheRead;
    totals.cacheWrite += r.tokens.cacheWrite;
    totals.thinking += r.tokens.thinking;
    totals.turnCount += r.turnCount;
    totals.toolErrors += r.toolErrors;
    totals.linesAdded += r.linesAdded;
    totals.linesRemoved += r.linesRemoved;
    totals.sidechainTokens += totalTokens(r.sidechain.tokens);
    if (r.status === "working") totals.working += 1;
    if (r.cost.measured !== undefined) {
      totals.measuredCost += r.cost.measured;
      totals.measuredSessions += 1;
    }
    if (r.cost.imputed !== undefined) {
      totals.imputedCost += r.cost.imputed;
      totals.imputedSessions += 1;
    }
    if (r.cost.unpricedModels && r.cost.unpricedModels.length > 0) {
      totals.partiallyPriced += 1;
    }
  }

  return totals;
}

export interface FacetCounts {
  projects: { value: string; count: number }[];
  models: { value: string; count: number }[];
  harnesses: { value: string; count: number }[];
  statuses: { value: string; count: number }[];
}

/** Options for the filter bar, counted over all rollups so nothing vanishes. */
export function facets(rollups: SessionRollup[]): FacetCounts {
  const count = (values: (r: SessionRollup) => string[]) => {
    const map = new Map<string, number>();
    for (const r of rollups) {
      for (const v of values(r)) {
        if (v === "") continue;
        map.set(v, (map.get(v) ?? 0) + 1);
      }
    }
    return [...map]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
  };

  return {
    projects: count((r) => [r.project]),
    models: count(modelFamilies),
    harnesses: count((r) => [r.harness]),
    statuses: count((r) => [r.status]),
  };
}
