import { describe, expect, it } from "vitest";
import { clearDetailCache, getSessionDetail } from "./detail";
import { discoverAllSessions } from "./discover";
import { loadSession } from "./load";
import { totalTokens } from "./types";

const sessions = await discoverAllSessions();

describe.skipIf(sessions.length === 0)("session detail over the real corpus", () => {
  it("agrees with the rollup on tokens and turn count", async () => {
    // The rollup folds incrementally and discards messages; the detail view
    // re-parses from scratch and keeps them. They must not disagree.
    for (const session of sessions) {
      const rollup = await loadSession(session);
      const detail = await getSessionDetail(session.harness, session.sessionId);
      expect(detail, session.transcriptPath).toBeDefined();

      const detailTokens = detail!.turns.reduce((s, t) => s + totalTokens(t.tokens), 0);
      expect(detailTokens, session.transcriptPath).toBe(totalTokens(rollup.tokens));
      expect(detail!.retro.turnCount, session.transcriptPath).toBe(rollup.turnCount);
    }
  });

  it("agrees with the rollup on tool counts", async () => {
    for (const session of sessions) {
      const rollup = await loadSession(session);
      const detail = await getSessionDetail(session.harness, session.sessionId);
      expect(detail!.retro.toolsByName, session.transcriptPath).toEqual(rollup.tools);
      expect(detail!.retro.toolErrors, session.transcriptPath).toBe(rollup.toolErrors);
    }
  });

  it("agrees on subagent totals", async () => {
    const withSidechains = sessions.filter((s) => s.sidechainPaths.length > 0);
    for (const session of withSidechains) {
      const rollup = await loadSession(session);
      const detail = await getSessionDetail(session.harness, session.sessionId);
      const chainTokens = detail!.sidechains.reduce(
        (s, c) => s + totalTokens(c.tokens),
        0,
      );
      expect(chainTokens).toBe(totalTokens(rollup.sidechain.tokens));

      // Subagent tool calls belong to the sidechain, not the parent, so the
      // two code paths split the work the same way.
      const chainTools = detail!.sidechains
        .flatMap((c) => c.turns.flatMap((t) => t.tools))
        .reduce<Record<string, number>>((acc, name) => {
          acc[name] = (acc[name] ?? 0) + 1;
          return acc;
        }, {});
      expect(chainTools).toEqual(rollup.sidechain.tools);
    }

    expect(withSidechains.length).toBeGreaterThan(0);
  });

  it("reports no parse errors", async () => {
    for (const session of sessions) {
      const detail = await getSessionDetail(session.harness, session.sessionId);
      expect(detail!.parseErrors, session.transcriptPath).toBe(0);
    }
  });

  it("returns undefined for a session that does not exist", async () => {
    expect(await getSessionDetail("claude", "no-such-session")).toBeUndefined();
  });

  it("serves a repeat view from cache", async () => {
    const target = sessions[0]!;
    clearDetailCache();
    const first = await getSessionDetail(target.harness, target.sessionId);
    const second = await getSessionDetail(target.harness, target.sessionId);
    // Same object identity means the parse was not repeated.
    expect(second).toBe(first);
  });

  it("assigns every event to a real turn, or to the one still pending", async () => {
    for (const session of sessions) {
      const detail = await getSessionDetail(session.harness, session.sessionId);
      for (const event of detail!.events) {
        expect(event.turnIndex, session.transcriptPath).toBeGreaterThanOrEqual(0);
        // turns.length is legal: a prompt with no response yet.
        expect(event.turnIndex, session.transcriptPath).toBeLessThanOrEqual(detail!.turns.length);
      }
    }
  });

  it("only leaves user prompts awaiting a response", async () => {
    for (const session of sessions) {
      const detail = await getSessionDetail(session.harness, session.sessionId);
      const pending = detail!.events.filter((e) => e.turnIndex >= detail!.turns.length);
      for (const event of pending) {
        expect(event.kind, session.transcriptPath).toBe("user");
      }
    }
  });

  it("files a tool result under the turn that called it", async () => {
    let matched = 0;

    for (const session of sessions) {
      const detail = await getSessionDetail(session.harness, session.sessionId);
      const callTurn = new Map<string, number>();
      for (const event of detail!.events) {
        if (event.kind === "tool_call" && event.toolUseId) {
          callTurn.set(event.toolUseId, event.turnIndex);
        }
      }

      for (const event of detail!.events) {
        if (event.kind !== "tool_result" || !event.toolUseId) continue;
        const expected = callTurn.get(event.toolUseId);
        if (expected === undefined) continue;
        matched += 1;
        expect(event.turnIndex, `${session.sessionId} ${event.toolUseId}`).toBe(expected);
      }
    }

    expect(matched).toBeGreaterThan(0);
  });

  it("emits one tool_call event per counted tool call", async () => {
    for (const session of sessions) {
      const detail = await getSessionDetail(session.harness, session.sessionId);
      const calls = detail!.events.filter((e) => e.kind === "tool_call").length;
      expect(calls, session.transcriptPath).toBe(detail!.retro.toolCalls);
    }
  });

  it("groups a turn's tool_call events to match that turn's tools", async () => {
    for (const session of sessions) {
      const detail = await getSessionDetail(session.harness, session.sessionId);
      for (const turn of detail!.turns) {
        const names = detail!.events
          .filter((e) => e.kind === "tool_call" && e.turnIndex === turn.index)
          .map((e) => e.toolName);
        expect(names.slice().sort(), `${session.sessionId} turn ${turn.index}`)
          .toEqual(turn.tools.slice().sort());
      }
    }
  });

  it("merges the blocks of one response into a single turn", async () => {
    const claude = sessions.filter((s) => s.harness === "claude");
    let checked = 0;

    for (const session of claude) {
      const detail = await getSessionDetail(session.harness, session.sessionId);
      if (!detail || detail.turns.length === 0) continue;
      checked += 1;

      // A merged turn keeps every tool call from every block it was built from.
      const rollup = await loadSession(session);
      const toolsInTurns = detail.turns.reduce((s, t) => s + t.tools.length, 0);
      const toolsInRollup = Object.values(rollup.tools).reduce((s, n) => s + n, 0);
      expect(toolsInTurns, session.sessionId).toBe(toolsInRollup);
    }

    expect(checked).toBeGreaterThan(0);
  });
});
