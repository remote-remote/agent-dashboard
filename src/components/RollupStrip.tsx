import { formatCost, formatTokens } from "@/lib/format";
import type { Totals } from "@/lib/query";

function Stat({
  label, value, note, tone,
}: {
  label: string;
  value: string;
  note?: string;
  tone?: "measured" | "imputed";
}) {
  return (
    <div className="stat">
      <div className="label">{label}</div>
      <div className={`value mono${tone ? ` ${tone}` : ""}`}>{value}</div>
      {note && <div className="note">{note}</div>}
    </div>
  );
}

export function RollupStrip({ totals }: { totals: Totals }) {
  return (
    <div className="strip">
      <Stat
        label="Sessions"
        value={String(totals.sessions)}
        note={totals.working > 0 ? `${totals.working} working now` : undefined}
      />
      <Stat
        label="Tokens"
        value={formatTokens(totals.tokens)}
        note={
          totals.sidechainTokens > 0
            ? `+${formatTokens(totals.sidechainTokens)} subagent`
            : undefined
        }
      />
      <Stat label="Output" value={formatTokens(totals.output)} note={`${formatTokens(totals.thinking)} thinking`} />
      <Stat label="Cache read" value={formatTokens(totals.cacheRead)} note={`${formatTokens(totals.cacheWrite)} written`} />
      {/*
        Measured and imputed dollars are shown as two figures and never added
        together: one is what pi actually charged, the other is what Claude
        would have cost at API rates.
      */}
      <Stat
        label="Cost measured"
        value={formatCost(totals.measuredCost)}
        note={`${totals.measuredSessions} session${totals.measuredSessions === 1 ? "" : "s"}`}
        tone="measured"
      />
      <Stat
        label="Cost imputed"
        value={totals.imputedSessions > 0 ? `~${formatCost(totals.imputedCost)}` : "-"}
        note={
          totals.imputedSessions > 0
            ? `${totals.imputedSessions} session${totals.imputedSessions === 1 ? "" : "s"} at API rates` +
              (totals.partiallyPriced > 0 ? ` · ${totals.partiallyPriced} partial` : "")
            : "nothing to impute"
        }
        tone="imputed"
      />
      <Stat label="Turns" value={String(totals.turnCount)} note={`${totals.toolErrors} tool errors`} />
      <Stat label="Lines" value={`+${totals.linesAdded}`} note={`-${totals.linesRemoved}`} />
    </div>
  );
}
