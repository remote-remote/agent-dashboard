import Link from "next/link";

import { Breakdown, ChartPanel, TimeChart, type Series } from "@/components/Chart";
import { FilterBar } from "@/components/FilterBar";
import { LiveRefresh } from "@/components/LiveRefresh";
import { RollupStrip } from "@/components/RollupStrip";
import { formatCost, formatTokens, projectName } from "@/lib/format";
import { getReadyIndex } from "@/lib/index-singleton";
import { carryParams, facets, parseFilters, query, summarize, type SearchParams } from "@/lib/query";
import { bucketize, byModelFamily, groupBy, timeExtent, toolUsage, type Point } from "@/lib/series";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Hues are fixed to the measure, so a filter never repaints the survivors. */
const TOKEN_SERIES: Series<Point>[] = [
  { key: "input", label: "Input", color: "var(--series-1)", value: (p) => p.tokens.input },
  { key: "output", label: "Output", color: "var(--series-2)", value: (p) => p.tokens.output },
  { key: "cacheRead", label: "Cache read", color: "var(--series-3)", value: (p) => p.tokens.cacheRead },
  { key: "cacheWrite", label: "Cache write", color: "var(--series-4)", value: (p) => p.tokens.cacheWrite },
];

const COST_SERIES: Series<Point>[] = [
  { key: "measured", label: "Measured", color: "var(--mark-measured)", value: (p) => p.measuredCost },
  { key: "imputed", label: "Imputed", color: "var(--mark-imputed)", value: (p) => p.imputedCost },
];

const ACTIVITY_SERIES: Series<Point>[] = [
  { key: "prompts", label: "Prompts", color: "var(--series-1)", value: (p) => p.userPromptCount },
  { key: "turns", label: "Model turns", color: "var(--series-2)", value: (p) => p.turnCount },
  { key: "tools", label: "Tool calls", color: "var(--series-3)", value: (p) => p.toolCalls },
];

const BUCKET_NOUN = { hour: "hour", day: "day", week: "week", month: "month" } as const;

function count(value: number): string {
  return Math.round(value).toLocaleString();
}

/** Both dollar figures, kept apart: one is charged, the other is an estimate. */
function costNote(measured: number, imputed: number): string | undefined {
  const parts: string[] = [];
  if (measured > 0) parts.push(formatCost(measured));
  if (imputed > 0) parts.push(`~${formatCost(imputed)}`);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

export default async function GraphsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const filters = parseFilters(params);

  const index = await getReadyIndex();
  await index.refresh();

  const all = index.getAll();
  const rows = query(all, filters);
  const totals = summarize(rows);

  const range = Array.isArray(params.range) ? params.range[0] : params.range;
  const extent = timeExtent(rows, filters.since, filters.until);
  const { unit, points } = bucketize(rows, extent);

  const qs = carryParams(params);
  const listHref = (project: string) => {
    const next = new URLSearchParams(qs);
    next.set("project", project);
    return `/?${next.toString()}`;
  };

  const projects = groupBy(rows, (r) => r.project);
  const models = byModelFamily(rows);
  const tools = toolUsage(rows);
  const per = BUCKET_NOUN[unit];

  return (
    <main className="shell">
      <header className="masthead">
        <h1>Agent Dashboard</h1>
        <nav className="views">
          <Link href={qs.size > 0 ? `/?${qs}` : "/"}>Sessions</Link>
          <span className="on">Graphs</span>
        </nav>
        <span className="sub">
          {rows.length} session{rows.length === 1 ? "" : "s"} in range · one bar per {per}
        </span>
        <LiveRefresh />
      </header>

      <FilterBar filters={filters} facets={facets(all)} range={range} basePath="/graphs" />
      <RollupStrip totals={totals} />

      <div className="chart-grid">
        <ChartPanel
          title="Tokens over time"
          note={`by kind, per ${per}`}
          wide
        >
          <TimeChart items={points} series={TOKEN_SERIES} format={formatTokens} />
        </ChartPanel>

        {/*
          Measured and imputed dollars are two bars, never one stack: adding
          them would claim a total that was never charged.
        */}
        <ChartPanel
          title="Cost over time"
          note={`measured against imputed, per ${per}`}
          wide
        >
          <TimeChart items={points} series={COST_SERIES} mode="grouped" format={formatCost} />
        </ChartPanel>

        <ChartPanel
          title="Activity over time"
          note={`prompts, model turns and tool calls, per ${per}`}
          wide
        >
          <TimeChart items={points} series={ACTIVITY_SERIES} mode="grouped" format={count} height={150} />
        </ChartPanel>

        <ChartPanel title="Tokens by project" note="click through to the sessions">
          <Breakdown
            rows={projects.map((p) => ({
              key: p.key,
              label: projectName(p.key),
              value: p.total,
              display: formatTokens(p.total),
              note: costNote(p.measuredCost, p.imputedCost),
              href: listHref(p.key),
            }))}
          />
        </ChartPanel>

        <ChartPanel title="Tokens by model" note="a mixed session is split across the models it used">
          <Breakdown
            rows={models.map((m) => ({
              key: m.key,
              label: m.key,
              value: m.total,
              display: formatTokens(m.total),
              note: costNote(m.measuredCost, m.imputedCost),
            }))}
          />
        </ChartPanel>

        <ChartPanel title="Tool calls" note="subagent calls counted with their parent">
          <Breakdown
            rows={tools.map((t) => ({
              key: t.name,
              label: t.name,
              value: t.count,
              display: count(t.count),
            }))}
          />
        </ChartPanel>
      </div>

      <div className="legend">
        <span>Every figure counts in the {per} its session started, not spread across the {per}s it ran through.</span>
        <span><span className="measured-key">green</span> measured dollars, reported by the harness</span>
        <span><span className="imputed-key">purple</span> imputed from tokens at API rates, never summed with measured</span>
      </div>
    </main>
  );
}
