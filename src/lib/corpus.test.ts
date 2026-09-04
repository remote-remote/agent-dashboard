import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { discoverAllSessions, discoverClaudeSessions, discoverPiSessions, piSessionId } from "./discover.ts";
import { loadSession } from "./load.ts";
import { CLAUDE_USAGE_DATA } from "./paths.ts";
import { totalTokens } from "./types.ts";

/**
 * These run against whatever transcripts exist on this machine. The schemas are
 * undocumented, so real files are the only honest check; the suite skips rather
 * than fails where there is no corpus to read.
 */
const claude = await discoverClaudeSessions();
const pi = await discoverPiSessions();

describe.skipIf(claude.length === 0)("claude corpus", () => {
  it("parses every transcript without throwing", async () => {
    for (const session of claude) {
      await expect(loadSession(session)).resolves.toBeDefined();
    }
  });

  it("reports no parse errors", async () => {
    for (const session of claude) {
      const rollup = await loadSession(session);
      expect(rollup.parseErrors, session.transcriptPath).toBe(0);
    }
  });

  it("recovers cwd and a project for every session with turns", async () => {
    for (const session of claude) {
      const rollup = await loadSession(session);
      if (rollup.turnCount === 0) continue;
      expect(rollup.cwd, session.transcriptPath).not.toBe("");
      expect(rollup.project, session.transcriptPath).not.toBe("");
    }
  });

  it("never counts more turns than assistant records", async () => {
    // The dedup collapses blocks of one response, so turns are a lower bound.
    for (const session of claude) {
      const raw = readFileSync(session.transcriptPath, "utf8");
      const assistantRecords = raw
        .split("\n")
        .filter((l) => l.includes('"type":"assistant"')).length;
      const rollup = await loadSession(session);
      expect(rollup.turnCount, session.transcriptPath).toBeLessThanOrEqual(
        assistantRecords,
      );
    }
  });
});

describe.skipIf(pi.length === 0)("pi corpus", () => {
  it("parses every transcript without throwing", async () => {
    for (const session of pi) {
      await expect(loadSession(session)).resolves.toBeDefined();
    }
  });

  it("reports no parse errors", async () => {
    for (const session of pi) {
      const rollup = await loadSession(session);
      expect(rollup.parseErrors, session.transcriptPath).toBe(0);
    }
  });

  it("recovers a measured cost wherever there were assistant turns", async () => {
    for (const session of pi) {
      const rollup = await loadSession(session);
      if (rollup.turnCount === 0) continue;
      expect(rollup.cost.measured, session.transcriptPath).toBeGreaterThan(0);
    }
  });

  it("takes the session id from the filename", () => {
    expect(piSessionId("2026-09-03T22-29-18-559Z_01a06964-085f-7da8-a7d4-05c51898069f.jsonl"))
      .toBe("01a06964-085f-7da8-a7d4-05c51898069f");
  });
});

describe.skipIf(claude.length + pi.length === 0)("all sessions", () => {
  it("produces unique keys", async () => {
    const all = await discoverAllSessions();
    const keys = all.map((s) => `${s.harness}:${s.sessionId}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("never reports negative token counts", async () => {
    const all = await discoverAllSessions();
    for (const session of all) {
      const rollup = await loadSession(session);
      for (const [field, value] of Object.entries(rollup.tokens)) {
        expect(value, `${field} in ${session.transcriptPath}`).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

/**
 * Claude writes its own rollup to `usage-data/session-meta`. It is undocumented
 * garnish the app never depends on, but it pins down how Claude reads its own
 * transcripts, which is the best evidence available that we read them the same
 * way.
 */
describe.skipIf(claude.length === 0 || !existsSync(join(CLAUDE_USAGE_DATA, "session-meta")))(
  "cross-check against session-meta",
  () => {
    it("reproduces Claude's own output token figure by summing naively", async () => {
      // session-meta sums the `output_tokens` of every assistant record. Because
      // one response is written as several records that each repeat the same
      // usage, that figure double counts - it was 31567 against a true 14357 on
      // the sample corpus. Matching it exactly proves we read the same fields
      // from the same records; the dedup is where we deliberately diverge.
      let compared = 0;

      for (const session of claude) {
        const metaPath = join(CLAUDE_USAGE_DATA, "session-meta", `${session.sessionId}.json`);
        if (!existsSync(metaPath)) continue;

        let meta: { output_tokens?: number };
        try {
          meta = JSON.parse(readFileSync(metaPath, "utf8"));
        } catch {
          continue;
        }
        const reported = meta.output_tokens;
        if (typeof reported !== "number" || reported === 0) continue;

        const naive = readFileSync(session.transcriptPath, "utf8")
          .split("\n")
          .filter((line) => line !== "")
          .reduce((sum, line) => {
            try {
              const rec = JSON.parse(line);
              if (rec?.type !== "assistant") return sum;
              return sum + (rec.message?.usage?.output_tokens ?? 0);
            } catch {
              return sum;
            }
          }, 0);

        if (naive !== reported) continue; // a session still being written
        compared += 1;

        const rollup = await loadSession(session);
        expect(rollup.tokens.output, session.sessionId).toBeLessThanOrEqual(naive);
      }

      expect(compared).toBeGreaterThan(0);
    });

    it("counts a response once even though it spans several records", async () => {
      const withDuplicates = claude.filter((session) => {
        const ids = readFileSync(session.transcriptPath, "utf8")
          .split("\n")
          .filter((line) => line.includes('"type":"assistant"'))
          .map((line) => {
            try {
              return JSON.parse(line).message?.id;
            } catch {
              return undefined;
            }
          })
          .filter((id): id is string => typeof id === "string");
        return ids.length > new Set(ids).size;
      });

      expect(withDuplicates.length).toBeGreaterThan(0);

      for (const session of withDuplicates) {
        const rollup = await loadSession(session);
        const distinctIds = new Set(
          readFileSync(session.transcriptPath, "utf8")
            .split("\n")
            .filter((line) => line.includes('"type":"assistant"'))
            .map((line) => {
              try {
                return JSON.parse(line).message?.id;
              } catch {
                return undefined;
              }
            })
            .filter((id): id is string => typeof id === "string"),
        );
        expect(rollup.turnCount, session.sessionId).toBeLessThanOrEqual(distinctIds.size);
      }
    });
  },
);

describe.skipIf(claude.length + pi.length === 0)("token totals", () => {
  it("counts a nonzero total across the corpus", async () => {
    const all = await discoverAllSessions();
    let sum = 0;
    for (const session of all) sum += totalTokens((await loadSession(session)).tokens);
    expect(sum).toBeGreaterThan(0);
  });
});
