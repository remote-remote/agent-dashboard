import { FilterBar } from "@/components/FilterBar";
import { LiveRefresh } from "@/components/LiveRefresh";
import { RollupStrip } from "@/components/RollupStrip";
import { SessionTable } from "@/components/SessionTable";
import { getReadyIndex } from "@/lib/index-singleton";
import { facets, parseFilters, query, summarize, type SearchParams } from "@/lib/query";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The server component calls the index directly. There is no /api/sessions, no
 * fetch and no response schema, and filters live in search params so every view
 * is bookmarkable.
 */
export default async function Page({
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
  const parseErrors = all.reduce((sum, r) => sum + r.parseErrors, 0);

  const range = Array.isArray(params.range) ? params.range[0] : params.range;
  const priceTable = index.getPriceTable();

  return (
    <main className="shell">
      <header className="masthead">
        <h1>Agent Dashboard</h1>
        <span className="sub">
          {all.length} sessions indexed · {totals.working} working now
        </span>
        <LiveRefresh />
      </header>

      {parseErrors > 0 && (
        <div className="warn">
          {parseErrors} record{parseErrors === 1 ? "" : "s"} could not be parsed. The
          transcript schemas are undocumented and may have changed.
        </div>
      )}

      {priceTable.configError && (
        <div className="warn">
          Price config at {priceTable.configPath} could not be read
          ({priceTable.configError}). Using built-in rates.
        </div>
      )}

      <FilterBar filters={filters} facets={facets(all)} range={range} />
      <RollupStrip totals={totals} />
      <SessionTable rows={rows} />

      <div className="legend">
        <span><span className="measured-key">green</span> measured dollars, reported by the harness</span>
        <span><span className="imputed-key">purple ~</span> imputed from tokens at API rates, never summed with measured</span>
        <span>~ after a status means it was inferred from file mtime</span>
        <span>
          {priceTable.configPath && !priceTable.configError
            ? `rates from ${priceTable.configPath}`
            : "rates are built-in defaults, override them in ~/.config/agent-dashboard/prices.json"}
        </span>
      </div>
    </main>
  );
}
