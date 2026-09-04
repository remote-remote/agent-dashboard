import { formatDuration } from "@/lib/format";
import { shortenPath } from "@/lib/format";
import type { Retrospective } from "@/lib/detail";

/**
 * Everything here is computed from the transcript, no LLM involved, and is
 * available for both harnesses.
 */
export function Retro({ retro }: { retro: Retrospective }) {
  const tools = Object.entries(retro.toolsByName);
  const busiest = Math.max(...tools.map(([, n]) => n), 1);

  return (
    <section className="section">
      <h2>Retrospective<span className="caveat">deterministic, computed from the transcript</span></h2>

      <div className="retro-grid">
        <div className="panel retro-panel">
          <div className="retro-row"><span>Tool calls</span><span className="mono">{retro.toolCalls}</span></div>
          <div className="retro-row">
            <span>Tool errors</span>
            <span className="mono">
              {retro.toolErrors}
              {retro.toolErrorRate !== undefined && (
                <span className="sub"> ({(retro.toolErrorRate * 100).toFixed(0)}%)</span>
              )}
            </span>
          </div>
          <div className="retro-row">
            <span>Time to first tool</span>
            <span className="mono">
              {retro.timeToFirstToolMs !== undefined ? formatDuration(retro.timeToFirstToolMs) : "-"}
            </span>
          </div>
          <div className="retro-row"><span>Interruptions</span><span className="mono">{retro.interruptions}</span></div>
          <div className="retro-row">
            <span>Lines</span>
            <span className="mono">+{retro.linesAdded} / -{retro.linesRemoved}</span>
          </div>
          <div className="retro-row">
            <span>Models</span>
            <span className="sub">{retro.models.join(", ") || "-"}</span>
          </div>
        </div>

        <div className="panel retro-panel">
          {tools.length === 0 ? (
            <div className="sub">No tool calls.</div>
          ) : (
            tools.map(([name, count]) => (
              <div key={name} className="tool-row">
                <span className="tool-name">{name}</span>
                <span className="bar">
                  <span className="bar-fill" style={{ width: `${Math.round((count / busiest) * 100)}%` }} />
                </span>
                <span className="mono tool-count">{count}</span>
              </div>
            ))
          )}
        </div>
      </div>

      {retro.filesTouched.length > 0 && (
        <details className="panel files">
          <summary>{retro.filesTouched.length} files touched</summary>
          <ul>
            {retro.filesTouched.map((f) => (
              <li key={f} className="mono sub">{shortenPath(f)}</li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
