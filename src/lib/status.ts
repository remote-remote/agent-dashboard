import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { CLAUDE_SESSIONS } from "./paths.ts";
import type { SessionStatus, StatusSource } from "./types.ts";

const execFileAsync = promisify(execFile);

/** A pi session that has not written for this long is assumed finished. */
export const PI_LIVE_WINDOW_MS = 60_000;

export interface RegistryEntry {
  pid: number;
  sessionId: string;
  cwd?: string;
  status?: string;
  procStart?: string;
  startedAt?: number;
  name?: string;
  version?: string;
  entrypoint?: string;
  kind?: string;
}

export interface StatusVerdict {
  status: SessionStatus;
  statusSource: StatusSource;
}

/**
 * Read `~/.claude/sessions/<pid>.json`. Undocumented internal state: if it
 * disappears, Claude status degrades to the same mtime heuristic as pi rather
 * than breaking.
 */
export async function readRegistry(): Promise<RegistryEntry[]> {
  let names: string[];
  try {
    names = await readdir(CLAUDE_SESSIONS);
  } catch {
    return [];
  }

  const entries: RegistryEntry[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(await readFile(join(CLAUDE_SESSIONS, name), "utf8"));
      if (typeof parsed?.pid === "number" && typeof parsed?.sessionId === "string") {
        entries.push(parsed as RegistryEntry);
      }
    } catch {
      // A half-written or malformed registry file is skipped, not fatal.
    }
  }
  return entries;
}

function isAlive(pid: number): boolean {
  try {
    // `pgrep -x claude` misses sessions that are demonstrably running; signal 0
    // asks the kernel directly.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

const MONTHS = "JanFebMarAprMayJunJulAugSepOctNovDec";

/**
 * Parse the `ps lstart` format ("Fri Sep  4 14:06:47 2026") as UTC.
 *
 * The registry writes `procStart` in this format but in **UTC**, while `ps`
 * prints it in local time. Comparing the two as strings never matches, which
 * would resolve every live session to `done`.
 */
export function parseProcStart(value: string): number | undefined {
  const m = /^\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/.exec(
    value.trim(),
  );
  if (!m) return undefined;

  const month = MONTHS.indexOf(m[1]!) / 3;
  if (!Number.isInteger(month) || month < 0) return undefined;

  return Date.UTC(
    Number(m[6]),
    month,
    Number(m[2]),
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
  );
}

/** Actual start time per pid, from `ps`, in epoch ms. */
async function readProcessStarts(pids: number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (pids.length === 0) return out;

  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("ps", ["-o", "pid=,lstart=", "-p", pids.join(",")]));
  } catch {
    return out; // ps unavailable or every pid gone; caller degrades gracefully.
  }

  for (const line of stdout.split("\n")) {
    const m = /^\s*(\d+)\s+(.*\S)\s*$/.exec(line);
    if (!m) continue;
    // `ps` prints local time; parse it as UTC then shift by the local offset.
    const asUtc = parseProcStart(m[2]!);
    if (asUtc === undefined) continue;
    const local = new Date(asUtc);
    out.set(Number(m[1]), asUtc + local.getTimezoneOffset() * 60_000);
  }
  return out;
}

/** Tolerance for comparing two renderings of the same start time. */
const PROC_START_TOLERANCE_MS = 2_000;

export interface StatusResolver {
  resolve(
    harness: "claude" | "pi",
    sessionId: string,
    transcriptMtimeMs: number | undefined,
    now?: number,
  ): StatusVerdict;
  registryFor(sessionId: string): RegistryEntry | undefined;
}

/**
 * Snapshot the liveness inputs once per refresh so every session in a pass is
 * resolved against the same view of the world.
 */
export async function createStatusResolver(): Promise<StatusResolver> {
  const registry = await readRegistry();
  const alive = new Map<number, boolean>();
  for (const entry of registry) alive.set(entry.pid, isAlive(entry.pid));

  const livePids = registry.filter((e) => alive.get(e.pid)).map((e) => e.pid);
  const starts = await readProcessStarts(livePids);

  const bySession = new Map<string, RegistryEntry>();
  for (const entry of registry) {
    if (!alive.get(entry.pid)) continue;

    // Guard against the pid having been recycled by an unrelated process.
    const expected = entry.procStart ? parseProcStart(entry.procStart) : undefined;
    const actual = starts.get(entry.pid);
    if (
      expected !== undefined &&
      actual !== undefined &&
      Math.abs(expected - actual) > PROC_START_TOLERANCE_MS
    ) {
      continue;
    }
    bySession.set(entry.sessionId, entry);
  }

  return {
    registryFor: (sessionId) => bySession.get(sessionId),

    resolve(harness, sessionId, transcriptMtimeMs, now = Date.now()) {
      if (harness === "claude") {
        const entry = bySession.get(sessionId);
        if (entry) {
          return {
            status: entry.status === "busy" ? "working" : "idle",
            statusSource: "registry",
          };
        }
        // A registry entry that is missing, dead, or recycled means the session
        // is over. Stale files are left alone: this app never writes to ~/.claude.
        return { status: "done", statusSource: "registry" };
      }

      // pi has no registry. mtime under-reports `working` (a session thinking
      // with nothing to write looks finished) rather than claiming work that is
      // not happening, and can never report `idle` at all.
      if (transcriptMtimeMs === undefined) {
        return { status: "unknown", statusSource: "none" };
      }
      return {
        status: now - transcriptMtimeMs < PI_LIVE_WINDOW_MS ? "working" : "done",
        statusSource: "mtime",
      };
    },
  };
}
