"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";

import type { FacetCounts, Filters } from "@/lib/query";
import { projectName } from "@/lib/format";

const SEARCH_DEBOUNCE_MS = 250;

/**
 * Filters write to search params, so every view is still bookmarkable and the
 * server component remains the only thing that reads them. Changes navigate on
 * their own; `replace` keeps tweaking a filter out of the back stack.
 */
export function FilterBar({
  filters, facets, range, basePath = "/",
}: {
  filters: Filters;
  facets: FacetCounts;
  range?: string;
  /** The view the filters navigate within, so the bar works on any page. */
  basePath?: string;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();
  const [search, setSearch] = useState(filters.search ?? "");
  const debounce = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => () => clearTimeout(debounce.current), []);

  function apply(changes: Record<string, string>) {
    const next = new URLSearchParams(params.toString());
    for (const [key, value] of Object.entries(changes)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    const qs = next.toString();
    startTransition(() =>
      router.replace(qs ? `${basePath}?${qs}` : basePath, { scroll: false }),
    );
  }

  function onSearch(value: string) {
    setSearch(value);
    clearTimeout(debounce.current);
    debounce.current = setTimeout(() => apply({ q: value }), SEARCH_DEBOUNCE_MS);
  }

  function reset() {
    clearTimeout(debounce.current);
    setSearch("");
    startTransition(() => router.replace(basePath, { scroll: false }));
  }

  return (
    <div className="filters" data-pending={pending || undefined}>
      <form
        method="GET"
        action={basePath}
        onSubmit={(e) => {
          e.preventDefault();
          clearTimeout(debounce.current);
          apply({ q: search });
        }}
      >
        <input
          className="control"
          type="search"
          name="q"
          placeholder="Search title, project, id"
          value={search}
          onChange={(e) => onSearch(e.target.value)}
        />

        <select
          className="control"
          name="harness"
          value={filters.harness ?? ""}
          onChange={(e) => apply({ harness: e.target.value })}
        >
          <option value="">All harnesses</option>
          {facets.harnesses.map((h) => (
            <option key={h.value} value={h.value}>
              {h.value} ({h.count})
            </option>
          ))}
        </select>

        <select
          className="control"
          name="project"
          value={filters.project ?? ""}
          onChange={(e) => apply({ project: e.target.value })}
        >
          <option value="">All projects</option>
          {facets.projects.map((p) => (
            <option key={p.value} value={p.value}>
              {projectName(p.value)} ({p.count})
            </option>
          ))}
        </select>

        <select
          className="control"
          name="model"
          value={filters.model ?? ""}
          onChange={(e) => apply({ model: e.target.value })}
        >
          <option value="">All models</option>
          {facets.models.map((m) => (
            <option key={m.value} value={m.value}>
              {m.value} ({m.count})
            </option>
          ))}
        </select>

        <select
          className="control"
          name="status"
          value={filters.status ?? ""}
          onChange={(e) => apply({ status: e.target.value })}
        >
          <option value="">Any status</option>
          {facets.statuses.map((s) => (
            <option key={s.value} value={s.value}>
              {s.value} ({s.count})
            </option>
          ))}
        </select>

        <select
          className="control"
          name="range"
          value={range ?? ""}
          onChange={(e) => apply({ range: e.target.value })}
        >
          <option value="">All time</option>
          <option value="24h">Last 24h</option>
          <option value="7d">Last 7 days</option>
          <option value="30d">Last 30 days</option>
          <option value="month">This month</option>
          <option value="last-month">Last month</option>
        </select>

        <select
          className="control"
          name="sort"
          value={filters.sort}
          onChange={(e) => apply({ sort: e.target.value })}
        >
          <option value="recent">Most recent</option>
          <option value="tokens">Most tokens</option>
          <option value="cost">Most expensive</option>
          <option value="duration">Longest</option>
          <option value="turns">Most turns</option>
        </select>

        <button className="control" type="button" onClick={reset}>Reset</button>
      </form>
    </div>
  );
}
