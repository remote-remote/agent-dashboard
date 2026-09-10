import { addTokens, emptyTokens, totalTokens, type SessionRollup, type TokenCounts } from "./types";
import { modelFamily } from "./query";

/**
 * Every figure a chart draws is attributed to the bucket a session *started*
 * in, not spread across the buckets it ran through. A session is the smallest
 * unit the index holds - it keeps no per-message timeline - so spreading would
 * be an invention. Sessions rarely straddle a bucket boundary at day scale;
 * at hour scale a long one lands entirely on its first hour.
 */
export interface Point {
  /** Local start of the bucket, epoch ms. */
  start: number;
  label: string;
  sessions: number;
  tokens: TokenCounts;
  total: number;
  /** Real dollars reported by the harness. Never summed with imputed. */
  measuredCost: number;
  imputedCost: number;
  turnCount: number;
  userPromptCount: number;
  toolCalls: number;
}

export type BucketUnit = "hour" | "day" | "week" | "month";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Past this the x axis is unreadable and the SVG is pointlessly large. */
const MAX_BUCKETS = 400;

const PROMOTION: Record<BucketUnit, BucketUnit | undefined> = {
  hour: "day",
  day: "week",
  week: "month",
  month: undefined,
};

export function chooseBucket(spanMs: number): BucketUnit {
  if (spanMs <= 2 * DAY_MS) return "hour";
  if (spanMs <= 70 * DAY_MS) return "day";
  if (spanMs <= 400 * DAY_MS) return "week";
  return "month";
}

/** Buckets are cut in local time, so a day boundary is the viewer's midnight. */
function bucketStart(unit: BucketUnit, ms: number): number {
  const d = new Date(ms);
  switch (unit) {
    case "hour":
      return new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()).getTime();
    case "day":
      return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    case "week": {
      // Monday-first, so a working week reads as one bar.
      const back = (d.getDay() + 6) % 7;
      return new Date(d.getFullYear(), d.getMonth(), d.getDate() - back).getTime();
    }
    case "month":
      return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  }
}

/**
 * Stepping by calendar components rather than by a fixed millisecond width
 * keeps the buckets aligned across a DST change.
 */
function bucketNext(unit: BucketUnit, ms: number): number {
  const d = new Date(ms);
  switch (unit) {
    case "hour":
      return new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours() + 1).getTime();
    case "day":
      return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
    case "week":
      return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 7).getTime();
    case "month":
      return new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
  }
}

export function bucketLabel(unit: BucketUnit, start: number): string {
  const d = new Date(start);
  const day = `${d.getMonth() + 1}/${d.getDate()}`;
  switch (unit) {
    case "hour":
      return `${day} ${String(d.getHours()).padStart(2, "0")}:00`;
    case "day":
    case "week":
      return day;
    case "month":
      return d.toLocaleDateString(undefined, { month: "short", year: "2-digit" });
  }
}

export interface Extent {
  from: number;
  to: number;
}

/**
 * The window the charts cover. An explicit filter wins so an empty range still
 * draws its own span rather than collapsing; otherwise the data decides.
 */
export function timeExtent(
  rollups: SessionRollup[],
  since: string | undefined,
  until: string | undefined,
  now = Date.now(),
): Extent {
  const stamps = rollups
    .map((r) => (r.startedAt ? Date.parse(r.startedAt) : NaN))
    .filter((ms) => !Number.isNaN(ms));

  const from = since ? Date.parse(since) : stamps.length > 0 ? Math.min(...stamps) : now - DAY_MS;
  const to = until ? Date.parse(until) : Math.max(now, ...stamps);
  return { from, to: Math.max(to, from + HOUR_MS) };
}

function emptyPoint(unit: BucketUnit, start: number): Point {
  return {
    start,
    label: bucketLabel(unit, start),
    sessions: 0,
    tokens: emptyTokens(),
    total: 0,
    measuredCost: 0,
    imputedCost: 0,
    turnCount: 0,
    userPromptCount: 0,
    toolCalls: 0,
  };
}

function toolCallCount(rollup: SessionRollup): number {
  const own = Object.values(rollup.tools).reduce((sum, n) => sum + n, 0);
  const sub = Object.values(rollup.sidechain.tools).reduce((sum, n) => sum + n, 0);
  return own + sub;
}

/**
 * Buckets over the whole extent, empty ones included: a quiet day is a gap in
 * the data and has to draw as zero rather than vanish and compress the axis.
 */
export function bucketize(
  rollups: SessionRollup[],
  extent: Extent,
  unit: BucketUnit = chooseBucket(extent.to - extent.from),
): { unit: BucketUnit; points: Point[] } {
  let resolved = unit;
  let points: Point[] = [];

  for (;;) {
    points = [];
    for (
      let start = bucketStart(resolved, extent.from);
      start <= extent.to && points.length <= MAX_BUCKETS;
      start = bucketNext(resolved, start)
    ) {
      points.push(emptyPoint(resolved, start));
    }
    const promoted = PROMOTION[resolved];
    if (points.length <= MAX_BUCKETS || !promoted) break;
    resolved = promoted;
  }

  const byStart = new Map(points.map((p) => [p.start, p]));

  for (const r of rollups) {
    if (!r.startedAt) continue;
    const ms = Date.parse(r.startedAt);
    if (Number.isNaN(ms)) continue;
    const point = byStart.get(bucketStart(resolved, ms));
    if (!point) continue;

    point.sessions += 1;
    addTokens(point.tokens, r.tokens);
    point.total += totalTokens(r.tokens);
    point.measuredCost += r.cost.measured ?? 0;
    point.imputedCost += r.cost.imputed ?? 0;
    point.turnCount += r.turnCount;
    point.userPromptCount += r.userPromptCount;
    point.toolCalls += toolCallCount(r);
  }

  return { unit: resolved, points };
}

export interface Slice {
  key: string;
  sessions: number;
  tokens: TokenCounts;
  total: number;
  measuredCost: number;
  imputedCost: number;
}

function slice(key: string): Slice {
  return {
    key,
    sessions: 0,
    tokens: emptyTokens(),
    total: 0,
    measuredCost: 0,
    imputedCost: 0,
  };
}

function sorted(map: Map<string, Slice>): Slice[] {
  return [...map.values()].sort((a, b) => b.total - a.total || a.key.localeCompare(b.key));
}

/** One slice per whole session, keyed by whatever `keyOf` picks off it. */
export function groupBy(
  rollups: SessionRollup[],
  keyOf: (rollup: SessionRollup) => string,
): Slice[] {
  const map = new Map<string, Slice>();
  for (const r of rollups) {
    const key = keyOf(r);
    let s = map.get(key);
    if (!s) map.set(key, (s = slice(key)));
    s.sessions += 1;
    addTokens(s.tokens, r.tokens);
    s.total += totalTokens(r.tokens);
    s.measuredCost += r.cost.measured ?? 0;
    s.imputedCost += r.cost.imputed ?? 0;
  }
  return sorted(map);
}

/**
 * A session that switched models mid-run belongs to every model it used, so
 * this splits it by `tokensByModel` and `cost.byModel` rather than crediting
 * the whole session to one of them. Session counts therefore sum to more than
 * the number of sessions.
 */
export function byModelFamily(rollups: SessionRollup[]): Slice[] {
  const map = new Map<string, Slice>();
  for (const r of rollups) {
    const byModel = r.cost.byModel ?? {};
    for (const [model, tokens] of Object.entries(r.tokensByModel)) {
      const key = modelFamily(model);
      let s = map.get(key);
      if (!s) map.set(key, (s = slice(key)));
      s.sessions += 1;
      addTokens(s.tokens, tokens);
      s.total += totalTokens(tokens);
      const cost = byModel[model];
      if (cost) {
        if (cost.imputed) s.imputedCost += cost.dollars;
        else s.measuredCost += cost.dollars;
      }
    }
  }
  return sorted(map);
}

export interface ToolUse {
  name: string;
  count: number;
}

/**
 * Subagent tool calls are counted with the parent's: they are work the session
 * caused. Neither harness attributes an error to a tool name, so the error
 * count stays a session-level figure and is not broken down here.
 */
export function toolUsage(rollups: SessionRollup[], limit = 12): ToolUse[] {
  const map = new Map<string, number>();
  for (const r of rollups) {
    for (const [name, count] of [...Object.entries(r.tools), ...Object.entries(r.sidechain.tools)]) {
      map.set(name, (map.get(name) ?? 0) + count);
    }
  }
  return [...map]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, limit);
}
