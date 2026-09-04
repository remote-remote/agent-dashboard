import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { CLAUDE_PROJECTS, PI_SESSIONS } from "./paths";
import type { Harness } from "./types";

export interface DiscoveredSession {
  harness: Harness;
  sessionId: string;
  transcriptPath: string;
  /** `<sessionId>/subagents/*.jsonl` files belonging to this session. */
  sidechainPaths: string[];
}

async function safeReaddir(dir: string) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * Claude: `projects/<mangled-cwd>/<sessionId>.jsonl`, with subagent transcripts
 * in a sibling `projects/<mangled-cwd>/<sessionId>/subagents/*.jsonl`. The
 * directory name mangles `/` to `-` and cannot be reversed, so it is a key only
 * and the real cwd is read from inside the records.
 */
export async function discoverClaudeSessions(): Promise<DiscoveredSession[]> {
  const out: DiscoveredSession[] = [];

  for (const projectDir of await safeReaddir(CLAUDE_PROJECTS)) {
    if (!projectDir.isDirectory()) continue;
    const dir = join(CLAUDE_PROJECTS, projectDir.name);

    for (const entry of await safeReaddir(dir)) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const sessionId = basename(entry.name, ".jsonl");
      out.push({
        harness: "claude",
        sessionId,
        transcriptPath: join(dir, entry.name),
        sidechainPaths: await findSidechains(join(dir, sessionId)),
      });
    }
  }

  return out;
}

async function findSidechains(sessionDir: string): Promise<string[]> {
  const subagents = join(sessionDir, "subagents");
  const entries = await safeReaddir(subagents);
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".jsonl"))
    .map((e) => join(subagents, e.name))
    .sort();
}

/**
 * pi: `sessions/--<mangled-cwd>--/<ISO>_<uuidv7>.jsonl`. The session id is the
 * uuid half of the filename, which is why both harnesses can key the same way.
 */
export async function discoverPiSessions(): Promise<DiscoveredSession[]> {
  const out: DiscoveredSession[] = [];

  for (const projectDir of await safeReaddir(PI_SESSIONS)) {
    if (!projectDir.isDirectory()) continue;
    const dir = join(PI_SESSIONS, projectDir.name);

    for (const entry of await safeReaddir(dir)) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      out.push({
        harness: "pi",
        sessionId: piSessionId(entry.name),
        transcriptPath: join(dir, entry.name),
        sidechainPaths: [],
      });
    }
  }

  return out;
}

export function piSessionId(fileName: string): string {
  const stem = basename(fileName, ".jsonl");
  const underscore = stem.indexOf("_");
  return underscore === -1 ? stem : stem.slice(underscore + 1);
}

export async function discoverAllSessions(): Promise<DiscoveredSession[]> {
  const [claude, pi] = await Promise.all([
    discoverClaudeSessions(),
    discoverPiSessions(),
  ]);
  return [...claude, ...pi];
}
