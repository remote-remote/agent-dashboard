export function formatTokens(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

/**
 * Rough token count for a span of text. Neither harness records per-block
 * usage, so a pill for a tool result or a prompt can only ever approximate;
 * anything derived from this must be marked as an estimate in the UI.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function formatCost(value: number): string {
  if (value === 0) return "$0";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

/** Claude is "CC" so the column stays as narrow as pi's. */
export function harnessLabel(harness: string): string {
  return harness === "claude" ? "CC" : harness;
}

/**
 * Model ids carry a release date suffix that is noise in a list, and pi
 * qualifies them with a provider. Neither changes which model it is.
 */
export function shortModel(model: string): string {
  const tail = model.slice(model.lastIndexOf("/") + 1);
  return tail.replace(/-\d{8}$/, "");
}

export function formatDuration(ms: number): string {
  if (ms <= 0) return "-";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

export function formatRelative(iso: string | undefined, now = Date.now()): string {
  if (!iso) return "-";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "-";

  const diff = now - then;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  const days = Math.floor(diff / 86_400_000);
  if (days < 30) return `${days}d ago`;
  return new Date(then).toISOString().slice(0, 10);
}

/**
 * Stays free of `$HOME` so it can render on both sides of the client boundary;
 * `shortenPath` in `paths.ts` is the server-only counterpart.
 */
export function projectName(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}
