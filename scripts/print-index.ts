/**
 * Headless check on the index: build it against the real filesystem and print
 * the table. `pnpm index:print`
 */
import { SessionIndex } from "../src/lib/index-store.ts";
import { totalTokens } from "../src/lib/types.ts";

function short(value: string, width: number): string {
  if (value.length <= width) return value.padEnd(width);
  return value.slice(0, width - 1) + "…";
}

function num(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

const index = new SessionIndex();
const stats = await index.refresh();

const rows = index.getAll().sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""));

const header = [
  short("HARNESS", 7), short("STATUS", 8), short("SRC", 8), short("PROJECT", 26),
  short("TITLE", 32), "TURNS".padStart(6), "TOKENS".padStart(8), "COST".padStart(10),
].join("  ");
console.log(header);
console.log("-".repeat(header.length));

for (const r of rows) {
  const cost =
    r.cost.measured !== undefined
      ? `$${r.cost.measured.toFixed(4)}`
      : r.cost.imputed !== undefined
        ? `~$${r.cost.imputed.toFixed(4)}`
        : "-";
  console.log([
    short(r.harness, 7),
    short(r.status, 8),
    short(r.statusSource, 8),
    short(r.project.replace(process.env.HOME ?? "", "~"), 26),
    short(r.title ?? "", 32),
    String(r.turnCount).padStart(6),
    num(totalTokens(r.tokens)).padStart(8),
    cost.padStart(10),
  ].join("  "));
}

const totals = rows.reduce(
  (acc, r) => ({
    tokens: acc.tokens + totalTokens(r.tokens),
    sidechain: acc.sidechain + totalTokens(r.sidechain.tokens),
    measured: acc.measured + (r.cost.measured ?? 0),
    errors: acc.errors + r.parseErrors,
  }),
  { tokens: 0, sidechain: 0, measured: 0, errors: 0 },
);

console.log("-".repeat(header.length));
console.log(
  `${rows.length} sessions | ${num(totals.tokens)} tokens ` +
    `(+${num(totals.sidechain)} sidechain) | $${totals.measured.toFixed(4)} measured ` +
    `| ${totals.errors} parse errors`,
);
console.log(
  `indexed in ${stats.durationMs}ms | ${stats.filesRead} files | ` +
    `${num(stats.bytesRead)} bytes | ${stats.reparsed} reparsed`,
);

// A second pass should read nothing: proves the byte offsets are holding.
const second = await index.refresh();
console.log(`re-refresh: ${second.filesRead} files, ${second.bytesRead} bytes read`);
