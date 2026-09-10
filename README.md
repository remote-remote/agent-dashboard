# Agent Dashboard

A local-only web app that reads Claude Code and pi session transcripts off this machine and shows session statistics, live-updating as sessions work.

Everything is read-only. Nothing outside this directory is ever written.

## Running it

```sh
pnpm install
pnpm dev            # http://localhost:3000
pnpm index:print    # headless: build the index and print the table
pnpm test
```

## What it reads

| Harness | Path | Required |
| --- | --- | --- |
| Claude Code | `~/.claude/projects/<mangled-cwd>/<sessionId>.jsonl` | yes |
| Claude Code | `~/.claude/projects/<mangled-cwd>/<sessionId>/subagents/*.jsonl` | no |
| Claude Code | `~/.claude/sessions/<pid>.json` (live registry) | for status |
| Claude Code | `~/.claude/usage-data/facets/*.json` | no, garnish |
| pi | `~/.pi/agent/sessions/--<mangled-cwd>--/<ISO>_<uuid>.jsonl` | yes |

The app is fully functional with the entire `usage-data` directory missing, and with either harness absent.

Override the roots with `AGENT_DASHBOARD_CLAUDE_ROOT` and `AGENT_DASHBOARD_PI_ROOT` (used by the tests).

## Cost

pi measures real dollars per message; those are used verbatim and shown in green. Claude reports none - `totalCostUSD` is always `0` on a subscription - so its cost is **imputed**: token counts priced at API rates, shown in purple with a `~`. The two are never added into one number.

Rates live in `~/.config/agent-dashboard/prices.json` (override with `AGENT_DASHBOARD_PRICES`). Anything there overrides the built-in defaults per model; unlisted models keep the defaults.

```json
{
  "prices": {
    "claude-opus-5": { "input": 5, "output": 25, "cacheRead": 0.5, "cacheWrite": 6.25 }
  }
}
```

All four rates are dollars per million tokens. A model with no price is never guessed at - the session is marked partially priced and names the model.

## Status

`working | idle | done | unknown`, each row carrying how it was decided:

- **Claude** uses the session registry: an entry exists, `kill(pid, 0)`
  succeeds, and the process start time matches. Otherwise `done`.
- **pi** has no registry, so it falls back to transcript mtime under 60s.
  **pi can never report `idle`** - a session waiting on input writes nothing, so it is indistinguishable from one that exited. The error direction is safe: mtime under-reports `working` rather than claiming work that is not happening.

If the registry disappears, Claude degrades to the same mtime heuristic.

## Layout

```
src/lib/
  types.ts          SessionRollup and token vocabulary
  accumulator.ts    incremental fold target, shared by both parsers
  parse-claude.ts   Claude transcript records -> accumulator
  parse-pi.ts       pi transcript records -> accumulator
  jsonl.ts          line folding that never parses a half-written line
  discover.ts       finds transcripts and their subagent files
  index-store.ts    byte-offset tailing, invalidation, rollups only
  detail.ts         on-demand full re-parse behind an LRU
  status.ts         registry + kill(pid,0) + mtime fallback
  prices.ts         price table and imputation
  query.ts          filters, sorting, totals, facets
  series.ts         time buckets and breakdowns for the charts
  watcher.ts        fs.watch, debounced
src/app/
  page.tsx                       server component over the index
  graphs/page.tsx                the same index, charted
  session/[harness]/[id]/         detail view
  api/events/route.ts            the only route handler: SSE ping
```

## Views

`/` is the session list and `/graphs` charts the same filtered set: tokens by kind over time, measured against imputed cost, prompts/turns/tool calls, and breakdowns by project, model and tool. Both read the same search params, so the nav carries the current filters across and either view is bookmarkable.

Charts are inline SVG rendered on the server - no chart library, nothing in the client bundle - and each figure counts in the bucket its session *started* in. The index holds no per-message timeline, so spreading a long session across the buckets it ran through would be an invention.

The range picker offers rolling windows (24h, 7d, 30d) and calendar ones (this month, last month). Calendar windows are cut on local month boundaries, so "this month" means the month you are looking at, not UTC's.

Notes on the two undocumented transcript schemas, including the several places where reading them naively gives wrong numbers, are in [docs/SCHEMA-NOTES.md](docs/SCHEMA-NOTES.md). The design is in [docs/DESIGN.md](docs/DESIGN.md).
