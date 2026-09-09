import Link from "next/link";
import { notFound } from "next/navigation";
import { getSessionDetail } from "@/lib/detail";
import { readFacet } from "@/lib/facet";
import { formatCost, formatDuration, formatRelative, formatTokens } from "@/lib/format";
import { shortenPath } from "@/lib/paths";
import { totalTokens, type Harness } from "@/lib/types";
import { TurnList } from "@/components/TurnList";
import { Retro } from "@/components/Retro";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function SessionPage({
  params,
}: {
  params: Promise<{ harness: string; id: string }>;
}) {
  const { harness, id } = await params;
  if (harness !== "claude" && harness !== "pi") notFound();

  const detail = await getSessionDetail(harness as Harness, id);
  if (!detail) notFound();

  // Facets exist for Claude sessions only, and only sometimes.
  const facet = harness === "claude" ? await readFacet(id) : undefined;

  const tokens = detail.turns.reduce(
    (sum, t) => sum + totalTokens(t.tokens),
    0,
  );
  const measured = detail.turns.reduce((sum, t) => sum + (t.cost ?? 0), 0);
  const hasMeasured = detail.turns.some((t) => t.cost !== undefined);

  return (
    <main className="shell">
      <header className="masthead">
        <Link className="back" href="/">&larr; All sessions</Link>
        <h1>{detail.title ?? "Untitled session"}</h1>
        <span className={`badge ${detail.harness}`}>{detail.harness}</span>
      </header>

      <div className="meta-row">
        <span title={detail.cwd}>{shortenPath(detail.cwd ?? "")}</span>
        {detail.gitBranch && detail.gitBranch !== "HEAD" && <span>branch {detail.gitBranch}</span>}
        {detail.provider && <span>provider {detail.provider}</span>}
        {detail.entrypoint && <span>entrypoint {detail.entrypoint}</span>}
        {detail.version && <span>v{detail.version}</span>}
        <span className="mono">{detail.sessionId}</span>
      </div>

      {detail.parseErrors > 0 && (
        <div className="warn">
          {detail.parseErrors} record{detail.parseErrors === 1 ? "" : "s"} in this
          transcript could not be parsed.
        </div>
      )}

      <div className="strip">
        <div className="stat">
          <div className="label">Tokens</div>
          <div className="value mono">{formatTokens(tokens)}</div>
        </div>
        <div className="stat">
          <div className="label">Cost</div>
          <div className={`value mono ${hasMeasured ? "measured" : ""}`}>
            {hasMeasured ? formatCost(measured) : "-"}
          </div>
          <div className="note">{hasMeasured ? "measured" : "not reported"}</div>
        </div>
        <div className="stat">
          <div className="label">Turns</div>
          <div className="value mono">{detail.retro.turnCount}</div>
          <div className="note">{detail.retro.promptCount} prompts</div>
        </div>
        <div className="stat">
          <div className="label">Duration</div>
          <div className="value mono">{formatDuration(detail.retro.durationMs)}</div>
          <div className="note">{formatRelative(detail.turns[0]?.timestamp)}</div>
        </div>
      </div>

      <Retro retro={detail.retro} />

      {facet && (
        <section className="section">
          <h2>
            Claude&rsquo;s own summary
            <span className="caveat">
              LLM-written, undocumented, absent for pi and for most sessions
            </span>
          </h2>
          <div className="panel facet">
            {facet.brief_summary && <p>{facet.brief_summary}</p>}
            {facet.underlying_goal && (
              <p className="sub"><strong>Goal:</strong> {facet.underlying_goal}</p>
            )}
            <div className="chips">
              {facet.outcome && <span className="chip">outcome: {facet.outcome}</span>}
              {facet.session_type && <span className="chip">{facet.session_type}</span>}
              {facet.claude_helpfulness && <span className="chip">{facet.claude_helpfulness}</span>}
            </div>
          </div>
        </section>
      )}

      {detail.sidechains.length > 0 && (
        <section className="section">
          <h2>Subagents<span className="caveat">{detail.sidechains.length} agent transcripts</span></h2>
          {detail.sidechains.map((chain) => (
            <details key={chain.agentId} className="panel chain">
              <summary>
                <span className="mono">{chain.agentId}</span>
                <span className="sub">
                  {chain.turns.length} turns · {formatTokens(totalTokens(chain.tokens))} tokens
                </span>
              </summary>
              <TurnList turns={chain.turns} events={chain.events} />
            </details>
          ))}
        </section>
      )}

      <section className="section">
        <h2>
          Turns
          <span className="caveat">
            one row per response; expand for the full detail. ~ marks a token count
            estimated from text, since neither harness reports usage per block
          </span>
        </h2>
        <TurnList turns={detail.turns} events={detail.events} />
      </section>
    </main>
  );
}
