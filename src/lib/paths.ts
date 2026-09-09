import "server-only";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = homedir();

/** Roots are overridable so tests can point at fixtures. */
export const CLAUDE_ROOT = process.env.AGENT_DASHBOARD_CLAUDE_ROOT ?? join(HOME, ".claude");
export const PI_ROOT = process.env.AGENT_DASHBOARD_PI_ROOT ?? join(HOME, ".pi", "agent");

export const CLAUDE_PROJECTS = join(CLAUDE_ROOT, "projects");
export const CLAUDE_SESSIONS = join(CLAUDE_ROOT, "sessions");
export const CLAUDE_USAGE_DATA = join(CLAUDE_ROOT, "usage-data");
export const CLAUDE_FACETS = join(CLAUDE_USAGE_DATA, "facets");
export const PI_SESSIONS = join(PI_ROOT, "sessions");

/** Project paths are long and share a prefix; the tail is the useful part. */
export function shortenPath(path: string): string {
  return path.startsWith(HOME) ? `~${path.slice(HOME.length)}` : path;
}
