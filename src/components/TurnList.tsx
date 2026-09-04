import { formatCost, formatTokens } from "@/lib/format";
import type { Turn } from "@/lib/detail";
import { totalTokens } from "@/lib/types";

function elapsed(turn: Turn, first: Turn | undefined): string {
  if (!turn.timestamp || !first?.timestamp) return "";
  const ms = Date.parse(turn.timestamp) - Date.parse(first.timestamp);
  if (!Number.isFinite(ms) || ms < 0) return "";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `+${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `+${minutes}m` : `+${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

export function TurnList({ turns }: { turns: Turn[] }) {
  if (turns.length === 0) {
    return <div className="panel empty">No assistant turns in this transcript.</div>;
  }

  const first = turns[0];
  const peak = Math.max(...turns.map((t) => totalTokens(t.tokens)), 1);

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th className="num">#</th>
            <th className="num">At</th>
            <th>Model</th>
            <th className="num">In</th>
            <th className="num">Out</th>
            <th className="num">Think</th>
            <th className="num">Cache r/w</th>
            <th className="num">Cost</th>
            <th>Tools</th>
            <th>Weight</th>
          </tr>
        </thead>
        <tbody>
          {turns.map((turn) => (
            <tr key={turn.index}>
              <td className="num sub mono">{turn.index + 1}</td>
              <td className="num sub mono">{elapsed(turn, first)}</td>
              <td className="sub">
                {turn.model ?? "-"}
                {turn.effort && <span className="sub"> · {turn.effort}</span>}
              </td>
              <td className="num mono">{formatTokens(turn.tokens.input)}</td>
              <td className="num mono">{formatTokens(turn.tokens.output)}</td>
              <td className="num mono sub">
                {turn.tokens.thinking > 0 ? formatTokens(turn.tokens.thinking) : turn.thinking ? "y" : "-"}
              </td>
              <td className="num mono sub">
                {formatTokens(turn.tokens.cacheRead)}/{formatTokens(turn.tokens.cacheWrite)}
              </td>
              <td className="num mono">
                {turn.cost !== undefined
                  ? <span className="cost measured">{formatCost(turn.cost)}</span>
                  : <span className="cost none">-</span>}
              </td>
              <td className="sub tools-cell">{turn.tools.join(", ") || "-"}</td>
              <td>
                {/* Relative token weight, so an outlier turn is visible at a glance. */}
                <span className="bar" aria-hidden>
                  <span
                    className="bar-fill"
                    style={{ width: `${Math.round((totalTokens(turn.tokens) / peak) * 100)}%` }}
                  />
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
