import "server-only";
import { SessionIndex } from "./index-store";

/**
 * The index is pinned to `globalThis`, not held in a module-level `const`.
 *
 * This is load-bearing and easy to lose in a refactor. Dev-mode HMR
 * re-evaluates modules, so a module-scoped instance would be rebuilt on every
 * edit, and once watchers are attached (slice 4) each rebuild leaves the old
 * ones running: duplicate watchers and doubled SSE pings, with a confusing
 * symptom that looks like a client bug.
 */
const globalForIndex = globalThis as unknown as {
  __agentDashboardIndex?: SessionIndex;
  __agentDashboardReady?: Promise<void>;
};

export function getIndex(): SessionIndex {
  globalForIndex.__agentDashboardIndex ??= new SessionIndex();
  return globalForIndex.__agentDashboardIndex;
}

/** Build the index once, then refresh on demand. */
export async function getReadyIndex(): Promise<SessionIndex> {
  const index = getIndex();
  globalForIndex.__agentDashboardReady ??= index.refresh().then(() => undefined);
  await globalForIndex.__agentDashboardReady;
  return index;
}
