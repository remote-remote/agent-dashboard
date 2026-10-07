"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { type KeyboardEvent, useEffect, useOptimistic, useRef, useState, useTransition } from "react";

import type { FacetCounts, Filters } from "@/lib/query";
import type { SessionStatus } from "@/lib/types";
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
  // Checkboxes would otherwise snap back until the server re-renders the page.
  const [statuses, setStatuses] = useOptimistic(filters.status ?? []);

  useEffect(() => () => clearTimeout(debounce.current), []);

  /** An array value repeats the param once per element. */
  function apply(changes: Record<string, string | string[]>, optimistic?: () => void) {
    const next = new URLSearchParams(params.toString());
    for (const [key, value] of Object.entries(changes)) {
      next.delete(key);
      for (const v of [value].flat()) if (v) next.append(key, v);
    }
    const qs = next.toString();
    startTransition(() => {
      optimistic?.();
      router.replace(qs ? `${basePath}?${qs}` : basePath, { scroll: false });
    });
  }

  function onSearch(value: string) {
    setSearch(value);
    clearTimeout(debounce.current);
    debounce.current = setTimeout(() => apply({ q: value }), SEARCH_DEBOUNCE_MS);
  }

  function reset() {
    clearTimeout(debounce.current);
    setSearch("");
    startTransition(() => {
      setStatuses([]);
      router.replace(basePath, { scroll: false });
    });
  }

  function toggleStatus(status: SessionStatus, on: boolean) {
    const next = on ? [...statuses, status] : statuses.filter((s) => s !== status);
    apply({ status: next }, () => setStatuses(next));
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

        <StatusSelect
          options={facets.statuses}
          selected={statuses}
          onToggle={toggleStatus}
        />

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

/**
 * A disclosure of checkboxes rather than `<select multiple>`, which renders as
 * a tall list box. Summary and checkboxes are native, so Tab, Space and Enter
 * work without help; Escape and outside clicks close it like a select would.
 * The checkboxes carry `name="status"`, so the form still submits without JS.
 */
function StatusSelect({
  options, selected, onToggle,
}: {
  options: FacetCounts["statuses"];
  selected: SessionStatus[];
  onToggle: (status: SessionStatus, on: boolean) => void;
}) {
  const ref = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    function onPointerDown(e: PointerEvent) {
      if (ref.current?.open && !ref.current.contains(e.target as Node)) {
        ref.current.open = false;
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, []);

  function onKeyDown(e: KeyboardEvent) {
    if (e.key !== "Escape" || !ref.current?.open) return;
    ref.current.open = false;
    ref.current.querySelector("summary")?.focus();
  }

  return (
    <details className="multiselect" ref={ref} onKeyDown={onKeyDown}>
      <summary className="control" aria-label={`Status: ${selected.join(", ") || "any"}`}>
        {selected.length === 0 ? "Any status" : selected.join(", ")}
      </summary>
      <fieldset className="multiselect-menu" aria-label="Status">
        {options.map((s) => (
          <label key={s.value}>
            <input
              type="checkbox"
              name="status"
              value={s.value}
              checked={selected.includes(s.value as SessionStatus)}
              onChange={(e) => onToggle(s.value as SessionStatus, e.target.checked)}
            />
            {s.value} ({s.count})
          </label>
        ))}
      </fieldset>
    </details>
  );
}
