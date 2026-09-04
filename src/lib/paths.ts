import { homedir } from "node:os";
import { join } from "node:path";

/** Roots are overridable so tests can point at fixtures. */
export const CLAUDE_ROOT = process.env.AGENT_DASHBOARD_CLAUDE_ROOT ?? join(homedir(), ".claude");
export const PI_ROOT = process.env.AGENT_DASHBOARD_PI_ROOT ?? join(homedir(), ".pi", "agent");

export const CLAUDE_PROJECTS = join(CLAUDE_ROOT, "projects");
export const CLAUDE_SESSIONS = join(CLAUDE_ROOT, "sessions");
export const CLAUDE_USAGE_DATA = join(CLAUDE_ROOT, "usage-data");
export const CLAUDE_FACETS = join(CLAUDE_USAGE_DATA, "facets");
export const PI_SESSIONS = join(PI_ROOT, "sessions");
