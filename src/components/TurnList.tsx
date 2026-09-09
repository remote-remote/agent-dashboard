"use client";

import { useState } from "react";
import { estimateTokens, formatCost, formatTokens } from "@/lib/format";
import type { Turn, TranscriptEvent } from "@/lib/detail";
import { totalTokens } from "@/lib/types";
import { Transcript } from "./Transcript";
import { BrainIcon, MessageIcon, UserIcon, WrenchIcon } from "./icons";

const COLUMN_COUNT = 6;

type PillKind = "user" | "reasoning" | "assistant" | "tool";

interface Pill {
  key: string;
  kind: PillKind;
  label?: string;
  tokens: number;
  /** False when the count is inferred from text length rather than reported. */
  exact: boolean;
  title: string;
}

function elapsed(turn: Turn, first: Turn | undefined): string {
  if (!turn.timestamp || !first?.timestamp) return "";
  const ms = Date.parse(turn.timestamp) - Date.parse(first.timestamp);
  if (!Number.isFinite(ms) || ms < 0) return "";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `+${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `+${minutes}m` : `+${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

/**
 * One pill per thing that happened in the turn, in transcript order. A tool
 * call and its result are a single pill: they always come as a pair, and the
 * result is the half that costs tokens.
 */
function pillsFor(turn: Turn, events: TranscriptEvent[]): Pill[] {
  const resultText = new Map<string, string>();
  for (const e of events) {
    if (e.kind === "tool_result" && e.toolUseId) resultText.set(e.toolUseId, e.text ?? "");
  }

  const pills: Pill[] = [];
  let brain: Pill | undefined;
  let reasoningText = "";
  let say: Pill | undefined;
  let sayText = "";

  for (const e of events) {
    if (e.kind === "user") {
      pills.push({
        key: `u${e.index}`,
        kind: "user",
        tokens: estimateTokens(e.text ?? ""),
        exact: false,
        title: "Your prompt, size estimated from its text",
      });
      continue;
    }

    if (e.kind === "reasoning") {
      reasoningText += e.text ?? "";
      // Reasoning is reported per turn, not per block, so all of a turn's
      // thinking collapses into the pill created by its first block.
      if (!brain) {
        brain = {
          key: `r${e.index}`,
          kind: "reasoning",
          tokens: 0,
          exact: false,
          title: "",
        };
        pills.push(brain);
      }
      continue;
    }

    if (e.kind === "assistant") {
      sayText += e.text ?? "";
      // A response split across records merges into one turn, so its text
      // blocks merge into one pill rather than several near-identical ones.
      if (!say) {
        say = { key: `a${e.index}`, kind: "assistant", tokens: 0, exact: false, title: "" };
        pills.push(say);
      }
      continue;
    }

    if (e.kind === "tool_call") {
      const result = e.toolUseId ? resultText.get(e.toolUseId) : undefined;
      const source = result ?? JSON.stringify(e.toolInput ?? {});
      pills.push({
        key: `t${e.index}`,
        kind: "tool",
        label: e.toolName ?? "tool",
        tokens: estimateTokens(source),
        exact: false,
        title: result === undefined
          ? `${e.toolName}: no result recorded, size estimated from arguments`
          : `${e.toolName}: result size estimated from its text`,
      });
    }
  }

  if (brain) {
    const reported = turn.tokens.thinking;
    brain.exact = reported > 0;
    brain.tokens = reported > 0 ? reported : estimateTokens(reasoningText);
    brain.title = reported > 0
      ? "Reasoning tokens reported by the harness"
      : "Reasoning, size estimated from its text";
  }

  if (say) {
    // With no tools and no thinking, every output token went into this text,
    // so the reported figure is the text's own count rather than a guess.
    const soleOutput = turn.tools.length === 0 && turn.tokens.thinking === 0 && turn.tokens.output > 0;
    say.exact = soleOutput;
    say.tokens = soleOutput ? turn.tokens.output : estimateTokens(sayText);
    say.title = soleOutput
      ? "Output tokens reported by the harness"
      : "Assistant text, size estimated from its text";
  }

  if (!brain && (turn.tokens.thinking > 0 || turn.thinking)) {
    // Claude records thinking blocks with the text stripped, so a turn can
    // reason expensively and leave no reasoning event behind. The reported
    // token count is the only trace, and it is too big to omit.
    const reported = turn.tokens.thinking;
    // Reasoning precedes the work it drives, so it sits after the prompt that
    // triggered the turn and before the first tool call.
    let at = 0;
    while (at < pills.length && pills[at]!.kind === "user") at += 1;
    pills.splice(at, 0, {
      key: `r-reported-${turn.index}`,
      kind: "reasoning",
      tokens: reported,
      exact: reported > 0,
      title: "Reasoning happened but its text was not recorded by the harness",
    });
  }

  return pills;
}

/** True when a turn reasoned but the harness kept none of the text. */
function hasRedactedReasoning(turn: Turn, events: TranscriptEvent[]): boolean {
  if (turn.tokens.thinking === 0 && !turn.thinking) return false;
  return !events.some((e) => e.kind === "reasoning");
}

function PillRow({ pills }: { pills: Pill[] }) {
  if (pills.length === 0) return <span className="sub">-</span>;

  return (
    <span className="pills">
      {pills.map((p) => (
        <span key={p.key} className={`pill pill-${p.kind}`} title={p.title}>
          {p.kind === "user" && <UserIcon />}
          {p.kind === "reasoning" && <BrainIcon />}
          {p.kind === "assistant" && <MessageIcon />}
          {p.kind === "tool" && <WrenchIcon />}
          {p.label && <span className="pill-label">{p.label}</span>}
          <span className="pill-num mono">
            {p.exact ? "" : "~"}
            {formatTokens(p.tokens)}
          </span>
        </span>
      ))}
    </span>
  );
}

export function TurnList({
  turns,
  events = [],
}: {
  turns: Turn[];
  events?: TranscriptEvent[];
}) {
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set());

  const toggle = (index: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });

  if (turns.length === 0) {
    return <div className="panel empty">No assistant turns in this transcript.</div>;
  }

  const first = turns[0];
  const peak = Math.max(...turns.map((t) => totalTokens(t.tokens)), 1);

  const byTurn = new Map<number, TranscriptEvent[]>();
  for (const event of events) {
    const bucket = byTurn.get(event.turnIndex);
    if (bucket) bucket.push(event);
    else byTurn.set(event.turnIndex, [event]);
  }

  // A prompt sent after the last response has no turn yet: surface it rather
  // than letting it fall off the end of the table.
  const pending = [...byTurn.entries()]
    .filter(([index]) => index >= turns.length)
    .flatMap(([, list]) => list);

  return (
    <div className="table-wrap">
      <table className="turns">
        <thead>
          <tr>
            <th className="num turn-num-col">#</th>
            <th>Summary</th>
            <th className="model-col">Model</th>
            <th className="num">Cost</th>
            <th className="num">Cache r/w</th>
            <th className="num weight-col">Weight</th>
          </tr>
        </thead>
        <tbody>
          {turns.flatMap((turn) => {
            const isOpen = expanded.has(turn.index);
            const turnEvents = byTurn.get(turn.index) ?? [];
            const pills = pillsFor(turn, turnEvents);
            const total = totalTokens(turn.tokens);
            const say = turn.text.trim();
            const when = elapsed(turn, first);
            // A zero cache read means the prompt cache had expired by this turn,
            // so the whole context was re-billed at full rate. Flag it.
            const cacheExpired = turn.tokens.cacheRead === 0;

            return [
              <tr
                key={turn.index}
                className={`turn-row${isOpen ? " open" : ""}${say ? " has-say" : ""}${cacheExpired ? " cache-expired" : ""}`}
                onClick={() => toggle(turn.index)}
              >
                <td
                  className="num turn-num-col"
                  title={[turn.model, turn.effort, when].filter(Boolean).join(" · ")}
                >
                  <span className="mono turn-index">{turn.index + 1}</span>
                  <span className={`chevron${isOpen ? " open" : ""}`} aria-hidden>&rsaquo;</span>
                </td>
                <td><PillRow pills={pills} /></td>
                <td className="model-col sub" title={turn.model ?? undefined}>
                  {turn.model ? (
                    <span className="model-name">
                      {turn.model}
                      {turn.effort && <span className="model-effort"> · {turn.effort}</span>}
                    </span>
                  ) : (
                    "-"
                  )}
                </td>
                <td className="num mono">
                  {turn.cost !== undefined
                    ? <span className="cost measured">{formatCost(turn.cost)}</span>
                    : <span className="cost none">-</span>}
                </td>
                <td className="num mono sub">
                  {formatTokens(turn.tokens.cacheRead)}/{formatTokens(turn.tokens.cacheWrite)}
                </td>
                <td className="num weight-col">
                  <span className="weight">
                    <span className="mono weight-num">{formatTokens(total)}</span>
                    <span className="bar" aria-hidden>
                      <span
                        className="bar-fill"
                        style={{ width: `${Math.round((total / peak) * 100)}%` }}
                      />
                    </span>
                  </span>
                </td>
              </tr>,

              say && !isOpen ? (
                <tr key={`${turn.index}-say`} className="say-row" onClick={() => toggle(turn.index)}>
                  <td className="turn-num-col" />
                  <td colSpan={COLUMN_COUNT - 1}>
                    <div className="say">{say}</div>
                  </td>
                </tr>
              ) : null,

              isOpen ? (
                <tr key={`${turn.index}-detail`} className="detail-row">
                  <td colSpan={COLUMN_COUNT}>
                    <div className="turn-detail">
                      {hasRedactedReasoning(turn, turnEvents) && (
                        <div className="redacted sub">
                          <BrainIcon />
                          {turn.tokens.thinking > 0
                            ? `${formatTokens(turn.tokens.thinking)} reasoning tokens, text not recorded by this harness`
                            : "This turn reasoned, but the text was not recorded by this harness"}
                        </div>
                      )}
                      {turnEvents.length > 0 ? (
                        <Transcript events={turnEvents} />
                      ) : (
                        !hasRedactedReasoning(turn, turnEvents) && (
                          <div className="empty sub">No recorded content for this turn.</div>
                        )
                      )}
                    </div>
                  </td>
                </tr>
              ) : null,
            ];
          })}

          {pending.length > 0 && (
            <tr className="detail-row">
              <td colSpan={COLUMN_COUNT}>
                <div className="turn-detail">
                  <div className="sub pending-label">Awaiting a response</div>
                  <Transcript events={pending} />
                </div>
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
