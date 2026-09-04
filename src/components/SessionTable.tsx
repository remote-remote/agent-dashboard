import Link from "next/link";
import {
  formatCost, formatDuration, formatRelative, formatTokens, projectName,
} from "@/lib/format";
import { modelFamilies } from "@/lib/query";
import { totalTokens, type SessionRollup } from "@/lib/types";

function StatusCell({ rollup }: { rollup: SessionRollup }) {
  // pi can never report `idle`: a session waiting on input writes nothing, so
  // it is indistinguishable from one that exited. statusSource says so.
  const title =
    rollup.statusSource === "registry"
      ? "From Claude's session registry"
      : rollup.statusSource === "mtime"
        ? "Inferred from transcript mtime; pi cannot report idle"
        : "No liveness signal available";

  return (
    <span className="status-cell" title={title}>
      <span className={`dot ${rollup.status}`} />
      {rollup.status}
      {rollup.statusSource === "mtime" && <span className="src">~</span>}
    </span>
  );
}

function CostCell({ cost }: { cost: SessionRollup["cost"] }) {
  if (cost.measured !== undefined) {
    return <span className="cost measured mono" title="Measured by the harness">{formatCost(cost.measured)}</span>;
  }
  if (cost.imputed !== undefined) {
    const partial = cost.unpricedModels && cost.unpricedModels.length > 0;
    return (
      <span
        className="cost imputed mono"
        title={
          partial
            ? `Imputed at API rates, but no price for: ${cost.unpricedModels!.join(", ")}`
            : "Imputed from token counts at API rates"
        }
      >
        ~{formatCost(cost.imputed)}
        {partial && <span className="sub">*</span>}
      </span>
    );
  }
  if (cost.unpricedModels && cost.unpricedModels.length > 0) {
    return (
      <span className="cost none mono" title={`No price for: ${cost.unpricedModels.join(", ")}`}>
        n/p
      </span>
    );
  }
  return <span className="cost none mono">-</span>;
}

export function SessionTable({ rows }: { rows: SessionRollup[] }) {
  if (rows.length === 0) {
    return (
      <div className="panel empty">No sessions match these filters.</div>
    );
  }

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Status</th>
            <th>Session</th>
            <th>Project</th>
            <th>Model</th>
            <th className="num">Tokens</th>
            <th className="num">Cost</th>
            <th className="num">Turns</th>
            <th className="num">Duration</th>
            <th className="num">Lines</th>
            <th className="num">Started</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <td><StatusCell rollup={r} /></td>
              <td className="title-cell">
                <Link href={`/session/${r.harness}/${r.sessionId}`}>
                  <span className={`badge ${r.harness}`}>{r.harness}</span>{" "}
                  {r.title ?? <span className="none">untitled</span>}
                </Link>
              </td>
              <td>
                {projectName(r.project)}
                {r.gitBranch && r.gitBranch !== "HEAD" && (
                  <span className="sub"> · {r.gitBranch}</span>
                )}
              </td>
              <td className="sub">{modelFamilies(r).join(", ") || "-"}</td>
              <td className="num mono">
                {formatTokens(totalTokens(r.tokens))}
                {r.sidechain.turnCount > 0 && (
                  <span className="sub" title="Subagent tokens">
                    {" "}+{formatTokens(totalTokens(r.sidechain.tokens))}
                  </span>
                )}
              </td>
              <td className="num"><CostCell cost={r.cost} /></td>
              <td className="num mono">
                {r.turnCount}
                {r.toolErrors > 0 && (
                  <span className="sub" title={`${r.toolErrors} tool errors`}> !{r.toolErrors}</span>
                )}
              </td>
              <td className="num mono">{formatDuration(r.durationMs)}</td>
              <td className="num mono sub">+{r.linesAdded}/-{r.linesRemoved}</td>
              <td className="num sub">{formatRelative(r.startedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
