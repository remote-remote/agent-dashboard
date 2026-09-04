import { open, stat } from "node:fs/promises";
import { createAccumulator, finalize, type Accumulator } from "./accumulator.ts";
import { discoverAllSessions, type DiscoveredSession } from "./discover.ts";
import { foldInto } from "./load.ts";
import { resolveProject } from "./project.ts";
import { imputeCost, loadPriceTable, type PriceTable } from "./prices.ts";
import { createStatusResolver } from "./status.ts";
import type { SessionRollup } from "./types.ts";

interface TrackedFile {
  path: string;
  size: number;
  mtimeMs: number;
  inode: number;
  byteOffset: number;
  isSidechain: boolean;
}

interface TrackedSession {
  session: DiscoveredSession;
  acc: Accumulator;
  files: Map<string, TrackedFile>;
  /** Newest mtime across the session's files, for pi's liveness heuristic. */
  mtimeMs?: number;
  /** File the accumulator's dedup window currently refers to. */
  dedupPath?: string;
}

export interface RefreshStats {
  sessions: number;
  filesRead: number;
  bytesRead: number;
  reparsed: number;
  durationMs: number;
}

/**
 * In-memory index of session rollups.
 *
 * Holds rollups only, never parsed messages, so memory is O(sessions) rather
 * than O(bytes). Transcripts are append-only, so each file is read from its
 * last byte offset to EOF and the new records are folded into the running
 * accumulator. That is the same operation at startup and on every later write,
 * which is why tailing for liveness and indexing for scale are one mechanism.
 */
export class SessionIndex {
  private tracked = new Map<string, TrackedSession>();
  private rollups = new Map<string, SessionRollup>();
  private lastRefresh?: RefreshStats;
  private priceTable: PriceTable = loadPriceTable();

  /** Re-read on every refresh so editing the config shows up without a restart. */
  getPriceTable(): PriceTable {
    return this.priceTable;
  }

  getAll(): SessionRollup[] {
    return [...this.rollups.values()];
  }

  get(key: string): SessionRollup | undefined {
    return this.rollups.get(key);
  }

  getStats(): RefreshStats | undefined {
    return this.lastRefresh;
  }

  async refresh(): Promise<RefreshStats> {
    const started = Date.now();
    const stats = { sessions: 0, filesRead: 0, bytesRead: 0, reparsed: 0, durationMs: 0 };
    this.priceTable = loadPriceTable();

    const discovered = await discoverAllSessions();
    const seen = new Set<string>();

    for (const session of discovered) {
      const key = `${session.harness}:${session.sessionId}`;
      seen.add(key);
      await this.refreshSession(key, session, stats);
    }

    // A session whose transcript disappeared drops out of the index.
    for (const key of [...this.tracked.keys()]) {
      if (!seen.has(key)) {
        this.tracked.delete(key);
        this.rollups.delete(key);
      }
    }

    await this.applyStatus();

    stats.sessions = this.rollups.size;
    stats.durationMs = Date.now() - started;
    this.lastRefresh = stats;
    return stats;
  }

  private async refreshSession(
    key: string,
    session: DiscoveredSession,
    stats: RefreshStats,
  ): Promise<void> {
    let entry = this.tracked.get(key);
    if (!entry) {
      entry = {
        session,
        acc: createAccumulator(session.harness, session.sessionId, session.transcriptPath),
        files: new Map(),
      };
      this.tracked.set(key, entry);
    } else {
      entry.session = session;
    }

    const wanted: { path: string; isSidechain: boolean }[] = [
      { path: session.transcriptPath, isSidechain: false },
      ...session.sidechainPaths.map((path) => ({ path, isSidechain: true })),
    ];

    // Rewritten or vanished files invalidate the running totals, which cannot
    // be un-folded, so the whole session is rebuilt from scratch.
    if (await this.needsReparse(entry, wanted)) {
      entry.acc = createAccumulator(
        session.harness,
        session.sessionId,
        session.transcriptPath,
      );
      entry.files.clear();
      entry.dedupPath = undefined;
      stats.reparsed += 1;
    }

    let newestMtime = entry.mtimeMs;

    for (const { path, isSidechain } of wanted) {
      let info: Awaited<ReturnType<typeof stat>>;
      try {
        info = await stat(path);
      } catch {
        continue;
      }

      newestMtime = Math.max(newestMtime ?? 0, info.mtimeMs);

      const tracked = entry.files.get(path) ?? {
        path,
        size: 0,
        mtimeMs: 0,
        inode: Number(info.ino),
        byteOffset: 0,
        isSidechain,
      };

      if (info.size === tracked.byteOffset && tracked.mtimeMs === info.mtimeMs) {
        entry.files.set(path, tracked);
        continue;
      }

      const bytes = await this.foldTail(entry, tracked, info.size, isSidechain);
      stats.filesRead += 1;
      stats.bytesRead += bytes;

      tracked.size = info.size;
      tracked.mtimeMs = info.mtimeMs;
      tracked.inode = Number(info.ino);
      entry.files.set(path, tracked);
    }

    entry.mtimeMs = newestMtime;

    const rollup = finalize(entry.acc, resolveProject(entry.acc.cwd ?? ""));

    // pi measures real dollars per message. Claude reports none, so its cost is
    // imputed from token counts at API rates and kept in a separate field that
    // is never summed with measured dollars.
    const cost = { ...rollup.cost };
    if (cost.measured === undefined) {
      const { cost: imputed, unpriced } = imputeCost(
        rollup.tokensByModel,
        this.priceTable.prices,
      );
      if (imputed > 0) cost.imputed = imputed;
      if (unpriced.length > 0) cost.unpricedModels = unpriced;
    }

    this.rollups.set(key, {
      ...rollup,
      cost,
      status: "unknown",
      statusSource: "none",
    });
  }

  /**
   * Append-only is an assumption, not a guarantee. A file that shrank or was
   * recreated (compaction, redaction, `/clear`) has to be re-read in full.
   */
  private async needsReparse(
    entry: TrackedSession,
    wanted: { path: string }[],
  ): Promise<boolean> {
    for (const { path } of wanted) {
      const tracked = entry.files.get(path);
      if (!tracked) continue;
      try {
        const info = await stat(path);
        if (info.size < tracked.byteOffset) return true;
        if (Number(info.ino) !== tracked.inode) return true;
      } catch {
        return true; // a file we had folded is gone
      }
    }
    return false;
  }

  private async foldTail(
    entry: TrackedSession,
    tracked: TrackedFile,
    size: number,
    isSidechain: boolean,
  ): Promise<number> {
    if (size <= tracked.byteOffset) return 0;

    const handle = await open(tracked.path, "r");
    try {
      const length = size - tracked.byteOffset;
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, tracked.byteOffset);

      // The dedup window has to survive a tail that splits a response group
      // across two reads, but must not carry over between files. It is kept
      // only when this read continues the file the window belongs to.
      if (entry.dedupPath !== tracked.path) {
        entry.acc.lastUsageKey = undefined;
        entry.acc.lastUsageCharged = undefined;
        entry.dedupPath = tracked.path;
      }

      const consumed = foldInto(entry.acc, buffer.subarray(0, bytesRead), isSidechain);
      tracked.byteOffset += consumed;
      return consumed;
    } finally {
      await handle.close();
    }
  }

  private async applyStatus(): Promise<void> {
    const resolver = await createStatusResolver();
    const now = Date.now();

    for (const [key, rollup] of this.rollups) {
      const entry = this.tracked.get(key);
      const verdict = resolver.resolve(
        rollup.harness,
        rollup.sessionId,
        entry?.mtimeMs,
        now,
      );

      const registry = resolver.registryFor(rollup.sessionId);
      this.rollups.set(key, {
        ...rollup,
        status: verdict.status,
        statusSource: verdict.statusSource,
        title: rollup.title ?? registry?.name,
      });
    }
  }
}
