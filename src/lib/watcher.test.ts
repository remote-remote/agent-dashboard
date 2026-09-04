import { mkdir, mkdtemp, rm, appendFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "agent-dashboard-watch-"));
  process.env.AGENT_DASHBOARD_CLAUDE_ROOT = join(root, "claude");
  process.env.AGENT_DASHBOARD_PI_ROOT = join(root, "pi");
  await mkdir(join(root, "claude", "projects", "-tmp-x"), { recursive: true });
  await mkdir(join(root, "claude", "sessions"), { recursive: true });
  await mkdir(join(root, "pi", "sessions", "--tmp-x--"), { recursive: true });
  vi.resetModules();
  // The watcher is pinned to globalThis, so a previous test's instance would be
  // reused and would still be watching a deleted directory.
  delete (globalThis as Record<string, unknown>).__agentDashboardWatcher;
});

afterEach(async () => {
  const w = (globalThis as Record<string, unknown>).__agentDashboardWatcher as
    | { close(): void }
    | undefined;
  w?.close();
  delete (globalThis as Record<string, unknown>).__agentDashboardWatcher;
  await rm(root, { recursive: true, force: true });
});

const file = () => join(root, "claude", "projects", "-tmp-x", "s.jsonl");

function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error("timed out"));
      setTimeout(tick, 25);
    };
    tick();
  });
}

describe("TranscriptWatcher", () => {
  it("notifies a subscriber when a transcript is written", async () => {
    const { getWatcher } = await import("./watcher");
    let calls = 0;
    getWatcher().subscribe(() => { calls += 1; });

    await writeFile(file(), "{}\n");
    await waitFor(() => calls > 0);
    expect(calls).toBeGreaterThan(0);
  });

  it("collapses a burst of writes into one notification", async () => {
    // One assistant turn writes several records; subscribers should see the
    // settled result, not each record.
    const { getWatcher, DEBOUNCE_MS } = await import("./watcher");
    let calls = 0;
    getWatcher().subscribe(() => { calls += 1; });

    await writeFile(file(), "{}\n");
    for (let i = 0; i < 8; i += 1) {
      await appendFile(file(), "{}\n");
    }

    await waitFor(() => calls > 0);
    await new Promise((r) => setTimeout(r, DEBOUNCE_MS * 3));
    expect(calls).toBe(1);
  });

  it("stops notifying after unsubscribe", async () => {
    const { getWatcher, DEBOUNCE_MS } = await import("./watcher");
    let calls = 0;
    const unsubscribe = getWatcher().subscribe(() => { calls += 1; });

    unsubscribe();
    await writeFile(file(), "{}\n");
    await new Promise((r) => setTimeout(r, DEBOUNCE_MS * 3));
    expect(calls).toBe(0);
  });

  it("hands every subscriber the same watcher instance", async () => {
    // The globalThis pin is what stops HMR from leaving duplicate watchers
    // attached, whose symptom is doubled SSE pings.
    const { getWatcher } = await import("./watcher");
    expect(getWatcher()).toBe(getWatcher());

    getWatcher().subscribe(() => {});
    getWatcher().subscribe(() => {});
    expect(getWatcher().listenerCount).toBe(2);
  });

  it("survives a missing harness directory", async () => {
    await rm(join(root, "pi"), { recursive: true, force: true });
    const { getWatcher } = await import("./watcher");
    let calls = 0;
    expect(() => getWatcher().subscribe(() => { calls += 1; })).not.toThrow();

    await writeFile(file(), "{}\n");
    await waitFor(() => calls > 0);
    expect(calls).toBeGreaterThan(0);
  });
});
