# Transcript schema notes

Observed by sampling one machine's data. Both schemas are undocumented and can change silently. Recorded here because each item cost time to find or would silently corrupt the numbers.

## Claude: one response is written as several records

The single most important finding. Claude writes **one record per content block** of an assistant response, and every one of those records repeats the **same `message.usage` object**:

```
msg_011Cei…  apiBlockIndex 0  content [text]      usage {o:143, cr:24471, …}
msg_011Cei…  apiBlockIndex 1  content [tool_use]  usage {o:143, cr:24471, …}
```

Summing `usage` across assistant records therefore double counts. Measured across the sample corpus:

| | naive sum | deduped | inflation |
| --- | --- | --- | --- |
| output tokens | 881,298 | 389,905 | +126% |
| cache read | 92,567,825 | 47,789,374 | +93% |

Usage is charged **once per `message.id`**. Supporting observations:

- A `message.id` never spans more than one `requestId`, so either works as the
  key; `message.id` is used.
- Records sharing a `message.id` are always **contiguous** within a file. That
  is what lets the index dedup with O(1) state per session (the last id and the amount already charged for it) instead of retaining every id it has seen.
- Usage is *usually* identical across the group, but not always: an early block
  can be written before the response finished (`output_tokens` 4, then 260). The newest value wins.
- `usage.iterations[]` exists but had length 0 or 1 everywhere in the corpus.
  Top-level usage is read; iterations are ignored.

**Claude's own `usage-data/session-meta/*.json` double counts this way.** For session `1e24079a`, session-meta reports `output_tokens: 31567`, which is exactly the naive sum; the true figure is 14357. A test pins this: reproducing their number confirms we read the same fields, and the dedup is the deliberate divergence.

## Claude: subagents are separate files, not inline

The design assumed sidechain turns were inline with `isSidechain: true`. In practice there are **zero** such records in main transcripts. Subagent turns live in:

```
projects/<mangled-cwd>/<sessionId>/subagents/agent-<agentId>.jsonl
```

Those records carry the **parent** `sessionId` plus an `agentId`, so they fold into the parent's sidechain totals. Discovery must not mistake them for sessions of their own.

## Claude: other details

- `model: "<synthetic>"` marks locally generated messages with no API call.
  Excluded from the model list; its usage is all zeros anyway.
- `isMeta: true` on a user record means injected context, not a typed prompt.
- Record types beyond those in the design doc: `queue-operation`,
  `file-history-delta`. Unknown types are ignored rather than counted as errors.
- `totalCostUSD` is `0`, not missing. Never treated as a measurement.
- Registry `updatedAt` only moves on status change, so its freshness is not a
  liveness signal.

## pi

Cleaner: one record per assistant response, no duplication (no repeated `responseId` in the corpus), and a real per-message `cost` breakdown in dollars.

- The record is nested: `{type: "message", message: {role, usage, …}}`. Roles
  observed: `assistant`, `user`, `toolResult`, `bashExecution`.
- Tool calls are `content[].type === "toolCall"`; results carry `toolName` and
  `isError`.
- **`usage.cacheWrite1h` is a breakdown of `cacheWrite`, not an addition.**
  `input + output + cacheRead + cacheWrite === totalTokens` holds exactly, so adding it would double count. It was 0 everywhere in the corpus, so this is inferred from the total rather than observed directly.
- Session id is the uuid half of `<ISO>_<uuidv7>.jsonl`.
- A transcript under `/private/var/folders/.../tmp.XXXX` is just a session run
  in a `mktemp -d`. Real session, real tokens.

## Claude registry: `procStart` is UTC, `ps` is local

`~/.claude/sessions/<pid>.json` writes `procStart` in `ps lstart` format ("Fri Sep  4 14:06:47 2026") but in **UTC**, while `ps -o lstart=` prints the same instant in local time. On a UTC-5 machine the two strings are five hours apart, so comparing them directly never matches and every live session resolves to `done`.

Parsing the registry string as UTC reproduces the epoch `startedAt` written alongside it exactly (`Fri Sep  4 14:06:47 2026` -> 1788530807000, and `startedAt` is 1788530807831). The `ps` value is parsed as UTC and shifted by the local offset before comparison, with a 2s tolerance.

The comparison only guards against a recycled pid; `process.kill(pid, 0)` already covers the ordinary crashed-session case.
