# Agent Dashboard: Design

A local-only web app that reads Claude Code and pi session transcripts off the
host filesystem and shows session statistics, live-updating as sessions work.

Status: design agreed, not yet implemented.

## Purpose

Two jobs, in priority order:

1. **Accounting.** Where are tokens and (imputed) dollars going, by project,
   model, and harness, over time.
2. **Retrospective.** Which sessions went well, which thrashed, what did they
   touch.

Live operational awareness is a *requirement* (the view updates as sessions
work) but not the spine. The dashboard is not a control plane: it never writes
to `~/.claude` or `~/.pi`, and it never sends input to a running agent.

Explicitly out of scope: herdr integration, LLM-generated session summaries,
any process the user has to install into another tool's config.

## Data sources

Everything is read-only. Nothing outside the app's own directory is written.

### Claude Code (`~/.claude`)

| Path | Role | Required |
| --- | --- | --- |
| `projects/<mangled-cwd>/<sessionId>.jsonl` | transcript, source of truth | yes |
| `sessions/<pid>.json` | live session registry | for status |
| `usage-data/session-meta/*.json` | precomputed rollups | no, garnish |
| `usage-data/facets/*.json` | LLM-written summaries | no, garnish |
| `history.jsonl` | every prompt typed | no |

Transcript record types observed: `session`-adjacent metadata (`mode`,
`permission-mode`, `bridge-session`, `ai-title`, `last-prompt`, `cost-state`,
`file-history-snapshot`, `atis-latch`), plus `user`, `assistant`, `system`,
`attachment`.

Fields we use:

- Common to most records: `sessionId`, `cwd`, `gitBranch`, `version`,
  `timestamp`, `uuid`, `parentUuid`, `isSidechain`, `entrypoint`.
- `assistant.message`: `model`, `usage` (input, output, cache read, cache
  creation, `output_tokens_details.thinking_tokens`), and record-level `effort`.
- `ai-title`: human-readable session title.
- `cost-state`: `totalLinesAdded`, `totalLinesRemoved`, `totalDuration`,
  `totalToolDuration`. Note `totalCostUSD` is **always 0** on a subscription.

The live registry (`sessions/<pid>.json`) carries `pid`, `sessionId`, `cwd`,
`status` (`busy` | `idle` observed), `procStart`, `startedAt`, `name`,
`version`, `entrypoint`, `kind`.

### pi (`~/.pi/agent`)

| Path | Role | Required |
| --- | --- | --- |
| `sessions/--<mangled-cwd>--/<ISO>_<uuidv7>.jsonl` | transcript | yes |

Record types: `session` (carries `cwd`, `id`, `version`), `model_change`
(`provider`, `modelId`), `thinking_level_change`, `message`.

Assistant messages carry `model`, `provider`, `api`, `stopReason`,
`responseId`, and a `usage` object with `input`, `output`, `cacheRead`,
`cacheWrite`, `reasoning`, `totalTokens`, and a real **`cost`** breakdown in
dollars.

pi has no live registry, no session titles, and no git branch.

### Known asymmetries

These drive most of the design. Neither harness is a superset of the other.

| | Claude Code | pi |
| --- | --- | --- |
| Dollar cost | absent (writes `0`) | measured, per message |
| Live status | authoritative (`busy`/`idle`) | none |
| Session title | `ai-title` | none |
| Git branch | yes | no |
| Provider | Anthropic only | multi-provider |
| Subagents | inline, `isSidechain: true` | none observed |
| Session id | UUID | UUIDv7, embedded in filename |

### Gotchas discovered while spiking

Recorded because each one cost time to find.

- **Directory names are lossy.** Both harnesses mangle `/` to `-` in the
  project directory name, so it cannot be reversed into a path. It is a
  **key only**. Always read the real `cwd` from inside the records.
- **A pi transcript under `/private/var/folders/.../tmp.XXXX` is not special.**
  That is just a mangled cwd from running `pi` inside a `mktemp -d`. Nothing is
  ever written outside `~/.pi/agent/sessions/`. These are real sessions and
  their tokens count.
- **`updatedAt` in Claude's registry is not a heartbeat.** It only moves on
  status change. Measured 58s and 69s of age on two sessions that were both
  alive. Never use its freshness as a liveness signal.
- **`pgrep -x claude` is unreliable here.** It missed a session that `kill -0`
  and `ps` both confirmed alive. Use `process.kill(pid, 0)`.
- **`totalCostUSD` is 0, not missing.** Do not treat it as a real measurement.

## Model

One row is a **session**. Claude sidechain (subagent) turns roll into their
parent's totals and are expandable in the detail view; pi has no subagents.

Composite key: `` `${harness}:${sessionId}` ``. pi's session id is recoverable
from its filename (`<ISO>_<uuid>.jsonl`), so both harnesses key the same way.

`project` resolves to the **git repo root**, walked up from `cwd` at index time
and cached per cwd. Non-repo cwds (a bare `~` session, a temp dir) fall back to
the cwd itself. This collapses six sessions in six subdirectories of one repo
into one project, and buckets throwaway temp-dir runs on their own with no
special case.

`SessionRollup` is roughly:

```
key, harness, sessionId, transcriptPath
cwd, project, gitBranch?, title?
startedAt, endedAt, durationMs
models: Set<modelId>, provider?, effort?
tokens: { input, output, cacheRead, cacheWrite, thinking }
cost: { measured?: number, imputed?: number }
tools: Record<toolName, count>, toolErrors
linesAdded, linesRemoved, filesTouched
turnCount, userPromptCount, interruptions
status, statusSource
sidechain: { turnCount, tokens }        // Claude only
```

## Status

Vocabulary: `working | idle | done | unknown`. (`blocked` is dropped; nothing
on disk reports it without an installed integration.)

Resolution order, per session:

1. **Claude**: registry entry exists for the sessionId, `process.kill(pid, 0)`
   succeeds, and `procStart` matches. Use its `status` verbatim
   (`busy` -> `working`, `idle` -> `idle`). Otherwise `done`.
2. **pi**: transcript mtime under 60s -> `working`, else `done`.
3. Neither applies -> `unknown`.

Every row carries `statusSource` (`"registry" | "mtime"`) so the UI can be
honest about how much it knows.

**Accepted limitation:** pi can never report `idle`. A pi session waiting on
user input writes nothing, so it is indistinguishable from one that exited.
The error direction is safe: mtime under-reports `working` (a session thinking
for 90s with no writes reads as `done`) rather than claiming work that is not
happening.

Stale registry files from a crashed Claude session resolve correctly to `done`
via the `kill -0` plus `procStart` check. The dashboard does **not** clean them
up; reading another tool's state directory stays read-only.

Deferred (not v1): matching live `pi` processes to sessions by cwd to recover
`idle`. Read-only and would work, but ambiguous when two pi sessions run in the
same directory, and not worth the complexity yet.

## Cost

pi's measured `usage.cost` is used verbatim. Claude has none, so it is
**imputed**: token counts multiplied by a price table in a config file the user
owns, keyed by model id.

Imputed values are rendered visually distinct from measured ones and are never
summed into a single total with measured dollars without saying so. The imputed
number means *"what this session would have cost at API rates,"* which on a
subscription is the interesting figure: it tells you what the subscription is
returning.

Token counts are the primary currency throughout. Dollars are secondary.

## Retrospective

Deterministic, no LLM. Everything computable from either harness's transcript:
turn count, wall duration, tool calls by name, tool error rate, files touched,
lines added and removed, user interruptions, time to first tool, prompt count.

Claude's `usage-data/facets/*.json` (LLM-written `brief_summary`, `outcome`,
`friction_counts`) is displayed **when present** and never depended on. It is
undocumented internal state that can vanish in a Claude Code update, and pi has
no equivalent. The app must be fully functional with the entire `usage-data`
directory missing.

## Architecture

Next.js App Router, one process, `runtime = 'nodejs'`.

The justification is not "we need a server that can read the filesystem" (true
of any Node process). It is that a **server component calls the index directly**:

```
export default async function Page({ searchParams }) {
  const rows = getIndex().query(parseFilters(searchParams));
  ...
}
```

No `/api/sessions`, no fetch, no response schema, no serialization layer.
Filters live in URL search params, so every view is bookmarkable. The whole app
has exactly one route handler: the SSE endpoint.

Cost accepted: the index must be pinned to `globalThis` (the PrismaClient
singleton trick) so dev-mode HMR module re-evaluation does not spawn duplicate
watchers. This is load-bearing and non-obvious.

### Index

In memory, no SQLite. Holds **rollups only**, roughly 1KB per session, so
memory is O(session count) and not O(bytes). It never retains parsed messages.

Transcripts are append-only, so each file is tracked as
`{ path, size, mtime, inode, byteOffset, rollup }`. On change, read from
`byteOffset` to EOF and fold the new records into the rollup accumulator. That
is the same operation at server start and on every subsequent write, which is
why tailing for liveness and indexing for scale are one mechanism rather than
two.

**Append-only is an assumption, not a guarantee.** If size shrinks or the inode
changes (compaction, redaction, `/clear`), that one file is fully re-parsed.

The detail view re-parses its single transcript on demand behind a small LRU.
At 1.7MB (today's largest) that is single-digit milliseconds.

### Liveness

`fs.watch` over the transcript roots and `~/.claude/sessions`, debounced 500ms
(one assistant turn writes several records). On settle, the index folds new
bytes and the SSE endpoint pushes a **content-free ping**. The client calls
`router.refresh()`, the server component re-runs against the fresh index.

No delta payloads and no client-side merge, which is where this class of bug
lives. The refetch is cheap precisely because the index is already warm.

### Screens

Two routes.

- `/` filter bar, rollup strip, charts, session table. All driven by the same
  search params.
- `/session/[harness]/[id]` detail: deterministic retrospective, per-turn token
  breakdown, sidechain expansion (Claude), facets if present.

v1 filters: harness, project, model (by family, exact id in detail), time
range, status. Branch, provider, effort, and entrypoint appear in the detail
view only.

## Build order

Slices 1 and 2 are pure functions over files, testable without a browser.
Nothing after them can invalidate them, and slice 1 is where the real risk
lives (two undocumented schemas).

1. Parsers and the normalized `SessionRollup`, both harnesses, tested against
   real files on disk. Headless.
2. Index: byte-offset tailing, size/mtime/inode invalidation, rollups only.
   Headless, verified by a script that prints the table.
3. Page: server component over the index, filters in search params, rollup
   strip and table. Static, refresh by hand.
4. Liveness: fs watchers, SSE ping, `router.refresh()`.
5. Detail route: on-demand re-parse, per-turn breakdown, sidechain expansion,
   deterministic retrospective.
6. Garnish: cost imputation from the config price table, facets when present.

## Risks

- **Both transcript schemas are undocumented** and were derived by sampling one
  machine's data. A harness update can change them silently. Parsers must
  tolerate unknown record types and missing fields rather than throwing, and
  every parse failure should be counted and surfaced rather than swallowed.
- **The Claude registry is undocumented internal state.** If it disappears,
  Claude status degrades to the same mtime heuristic as pi. Design the fallback
  in from the start rather than bolting it on.
- **Corpus is small today** (13 Claude sessions, ~5MB; ~20 pi sessions). The
  index design is a bet on future volume. If that bet is wrong the cost is
  ~200 extra lines, which is acceptable.
- **`globalThis` pinning is easy to lose** in a refactor, and the symptom
  (duplicate watchers, doubled SSE pings) is confusing. Worth a comment at the
  pin site.
