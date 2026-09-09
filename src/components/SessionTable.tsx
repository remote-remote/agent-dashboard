import Link from "next/link";
import {
  formatCost, formatDuration, formatRelative, formatTokens, harnessLabel,
  projectName, shortModel,
} from "@/lib/format";
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

function ModelCell({ rollup }: { rollup: SessionRollup }) {
  if (rollup.models.length === 0) return <span className="sub">-</span>;

  const byModel = rollup.cost.byModel ?? {};
  const unpriced = new Set(rollup.cost.unpricedModels ?? []);

  return (
    <ul className="model-list">
      {rollup.models.map((model) => {
        const cost = byModel[model];
        return (
          <li key={model}>
            <span className="sub" title={model}>{shortModel(model)}</span>
            {cost !== undefined ? (
              <span
                className={`cost mono ${cost.imputed ? "imputed" : "measured"}`}
                title={
                  cost.imputed
                    ? "Imputed from token counts at API rates"
                    : "Measured by the harness"
                }
              >
                {cost.imputed ? "~" : ""}{formatCost(cost.dollars)}
              </span>
            ) : (
              <span className="cost none mono">{unpriced.has(model) ? "n/p" : "-"}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
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
            <th>Harness</th>
            <th>Session</th>
            <th>Project</th>
            <th>Model</th>
            <th className="num">Tokens</th>
            <th className="num">In</th>
            <th className="num">Out</th>
            <th className="num">Cached</th>
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
              <td className={`harness-cell ${r.harness}`}>{harnessLabel(r.harness)}</td>
              <td className="title-cell">
                <Link href={`/session/${r.harness}/${r.sessionId}`}>
                  {r.title ?? <span className="none">untitled</span>}
                </Link>
              </td>
              <td className="project-cell">
                <span>{projectName(r.project)}</span>
                {r.gitBranch && r.gitBranch !== "HEAD" && (
                  <span className="sub">{r.gitBranch}</span>
                )}
              </td>
              <td><ModelCell rollup={r} /></td>
              <td className="num mono">
                {formatTokens(totalTokens(r.tokens))}
                {r.sidechain.turnCount > 0 && (
                  <span className="sub" title="Subagent tokens">
                    {" "}+{formatTokens(totalTokens(r.sidechain.tokens))}
                  </span>
                )}
              </td>
              <td className="num mono">{formatTokens(r.tokens.input)}</td>
              <td className="num mono">{formatTokens(r.tokens.output)}</td>
              <td className="num mono" title={`${r.tokens.cacheWrite} written`}>
                {formatTokens(r.tokens.cacheRead)}
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
