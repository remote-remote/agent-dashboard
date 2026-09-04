import type { FacetCounts, Filters } from "@/lib/query";
import { projectName } from "@/lib/format";

/**
 * Filters are a plain GET form writing to search params, so every view is
 * bookmarkable and the server component is the only thing that reads them.
 */
export function FilterBar({
  filters, facets, range,
}: {
  filters: Filters;
  facets: FacetCounts;
  range?: string;
}) {
  return (
    <div className="filters">
      <form method="GET" action="/">
        <input
          className="control"
          type="search"
          name="q"
          placeholder="Search title, project, id"
          defaultValue={filters.search ?? ""}
        />

        <select className="control" name="harness" defaultValue={filters.harness ?? ""}>
          <option value="">All harnesses</option>
          {facets.harnesses.map((h) => (
            <option key={h.value} value={h.value}>
              {h.value} ({h.count})
            </option>
          ))}
        </select>

        <select className="control" name="project" defaultValue={filters.project ?? ""}>
          <option value="">All projects</option>
          {facets.projects.map((p) => (
            <option key={p.value} value={p.value}>
              {projectName(p.value)} ({p.count})
            </option>
          ))}
        </select>

        <select className="control" name="model" defaultValue={filters.model ?? ""}>
          <option value="">All models</option>
          {facets.models.map((m) => (
            <option key={m.value} value={m.value}>
              {m.value} ({m.count})
            </option>
          ))}
        </select>

        <select className="control" name="status" defaultValue={filters.status ?? ""}>
          <option value="">Any status</option>
          {facets.statuses.map((s) => (
            <option key={s.value} value={s.value}>
              {s.value} ({s.count})
            </option>
          ))}
        </select>

        <select className="control" name="range" defaultValue={range ?? ""}>
          <option value="">All time</option>
          <option value="24h">Last 24h</option>
          <option value="7d">Last 7 days</option>
          <option value="30d">Last 30 days</option>
        </select>

        <select className="control" name="sort" defaultValue={filters.sort}>
          <option value="recent">Most recent</option>
          <option value="tokens">Most tokens</option>
          <option value="cost">Most expensive</option>
          <option value="duration">Longest</option>
          <option value="turns">Most turns</option>
        </select>

        <button className="control" type="submit">Apply</button>
        <a className="control" href="/">Reset</a>
      </form>
    </div>
  );
}
