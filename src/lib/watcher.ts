import "server-only";
import { watch, type FSWatcher } from "node:fs";
import { CLAUDE_PROJECTS, CLAUDE_SESSIONS, PI_SESSIONS } from "./paths";

/** One assistant turn writes several records; wait for the burst to settle. */
export const DEBOUNCE_MS = 500;

type Listener = () => void;

/**
 * Watches the transcript roots and Claude's session registry, and notifies
 * subscribers once writes have settled.
 *
 * Pinned to `globalThis` for the same reason as the index: dev-mode HMR would
 * otherwise leave the previous module's watchers attached, and the symptom
 * (doubled SSE pings) looks like a client bug.
 */
const globalForWatcher = globalThis as unknown as {
  __agentDashboardWatcher?: TranscriptWatcher;
};

class TranscriptWatcher {
  private listeners = new Set<Listener>();
  private watchers: FSWatcher[] = [];
  private timer?: NodeJS.Timeout;
  private started = false;

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    this.start();
    return () => {
      this.listeners.delete(listener);
    };
  }

  get listenerCount(): number {
    return this.listeners.size;
  }

  private start(): void {
    if (this.started) return;
    this.started = true;

    for (const root of [CLAUDE_PROJECTS, PI_SESSIONS, CLAUDE_SESSIONS]) {
      try {
        const watcher = watch(root, { recursive: true, persistent: false }, () => {
          this.schedule();
        });
        // A missing directory is normal: the user may not use both harnesses.
        watcher.on("error", () => {});
        this.watchers.push(watcher);
      } catch {
        // Watching is best effort; the page still works on manual refresh.
      }
    }
  }

  private schedule(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      for (const listener of this.listeners) listener();
    }, DEBOUNCE_MS);
  }

  close(): void {
    clearTimeout(this.timer);
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
    this.listeners.clear();
    this.started = false;
  }
}

export function getWatcher(): TranscriptWatcher {
  globalForWatcher.__agentDashboardWatcher ??= new TranscriptWatcher();
  return globalForWatcher.__agentDashboardWatcher;
}
