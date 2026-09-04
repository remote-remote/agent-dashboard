import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CLAUDE_FACETS } from "./paths";

/**
 * Claude's LLM-written session summaries.
 *
 * Undocumented internal state that can vanish in a Claude Code update, and pi
 * has no equivalent, so this is displayed when present and never depended on.
 * The app is fully functional with the whole usage-data directory missing.
 */
export interface Facet {
  underlying_goal?: string;
  brief_summary?: string;
  outcome?: string;
  session_type?: string;
  claude_helpfulness?: string;
  primary_success?: string;
  friction_detail?: string;
  goal_categories?: Record<string, number>;
  friction_counts?: Record<string, number>;
}

export async function readFacet(sessionId: string): Promise<Facet | undefined> {
  try {
    const raw = await readFile(join(CLAUDE_FACETS, `${sessionId}.json`), "utf8");
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as Facet) : undefined;
  } catch {
    return undefined;
  }
}
