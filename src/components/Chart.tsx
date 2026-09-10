import Link from "next/link";

/**
 * Charts are inline SVG rendered on the server: no chart library, no client
 * bundle, and they re-render through the same `router.refresh()` the rest of
 * the dashboard already uses. Hover detail is a native `<title>`, so it needs
 * no JavaScript at all.
 */

export interface Series<T> {
  key: string;
  label: string;
  /** A `--series-*` custom property, so light and dark are one definition. */
  color: string;
  value: (item: T) => number;
}

const VIEW_W = 720;
const PAD = { left: 54, right: 10, top: 10, bottom: 22 };
const SEGMENT_GAP = 2;
const CORNER = 4;
const MAX_X_LABELS = 10;

function niceMax(value: number): number {
  if (value <= 0) return 1;
  const base = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 1.5, 2, 2.5, 3, 4, 5, 7.5]) {
    if (value <= step * base) return step * base;
  }
  return 10 * base;
}

/** A bar with its far end rounded and its baseline end square. */
function barPath(x: number, y: number, w: number, h: number, round: boolean): string {
  const r = round ? Math.min(CORNER, w / 2, h) : 0;
  return [
    `M${x},${y + h}`,
    `L${x},${y + r}`,
    r > 0 ? `Q${x},${y} ${x + r},${y}` : "",
    `L${x + w - r},${y}`,
    r > 0 ? `Q${x + w},${y} ${x + w},${y + r}` : "",
    `L${x + w},${y + h}`,
    "Z",
  ].join(" ");
}

function Legend<T>({ series }: { series: Series<T>[] }) {
  if (series.length < 2) return null;
  return (
    <ul className="legend-swatches">
      {series.map((s) => (
        <li key={s.key}>
          <span className="swatch" style={{ background: s.color }} />
          {s.label}
        </li>
      ))}
    </ul>
  );
}

function BarChart<T extends { label: string }>({
  items,
  series,
  mode = "stacked",
  format,
  height = 170,
  emptyNote = "Nothing in this range.",
}: {
  items: T[];
  series: Series<T>[];
  mode?: "stacked" | "grouped";
  format: (value: number) => string;
  height?: number;
  emptyNote?: string;
}) {
  const columnTotal = (item: T) =>
    mode === "stacked"
      ? series.reduce((sum, s) => sum + Math.max(0, s.value(item)), 0)
      : Math.max(0, ...series.map((s) => s.value(item)));

  const peak = Math.max(0, ...items.map(columnTotal));
  if (items.length === 0 || peak === 0) {
    return <div className="chart-empty">{emptyNote}</div>;
  }

  const top = niceMax(peak);
  const plotW = VIEW_W - PAD.left - PAD.right;
  const plotH = height - PAD.top - PAD.bottom;
  const band = plotW / items.length;
  const columnW = Math.min(band - 2, 36);
  const y = (value: number) => PAD.top + plotH - (value / top) * plotH;

  const labelStep = Math.ceil(items.length / MAX_X_LABELS);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * top);

  return (
    <svg className="chart" viewBox={`0 0 ${VIEW_W} ${height}`} role="img">
      {ticks.map((value) => (
        <g key={value}>
          <line
            className="grid"
            x1={PAD.left}
            x2={VIEW_W - PAD.right}
            y1={y(value)}
            y2={y(value)}
          />
          <text className="axis" x={PAD.left - 6} y={y(value) + 3} textAnchor="end">
            {format(value)}
          </text>
        </g>
      ))}

      {items.map((item, i) => {
        const bandX = PAD.left + i * band + (band - columnW) / 2;
        const marks: React.ReactNode[] = [];

        if (mode === "stacked") {
          let cursor = 0;
          const drawn = series.filter((s) => s.value(item) > 0);
          drawn.forEach((s, si) => {
            const value = s.value(item);
            const full = (value / top) * plotH;
            const h = Math.max(1, full - (si < drawn.length - 1 ? SEGMENT_GAP : 0));
            const yTop = PAD.top + plotH - cursor - full;
            cursor += full;
            marks.push(
              <path
                key={s.key}
                d={barPath(bandX, yTop, columnW, h, si === drawn.length - 1)}
                fill={s.color}
              />,
            );
          });
        } else {
          const slot = (columnW - SEGMENT_GAP * (series.length - 1)) / series.length;
          series.forEach((s, si) => {
            const value = Math.max(0, s.value(item));
            if (value === 0) return;
            const h = Math.max(1, (value / top) * plotH);
            marks.push(
              <path
                key={s.key}
                d={barPath(bandX + si * (slot + SEGMENT_GAP), PAD.top + plotH - h, slot, h, true)}
                fill={s.color}
              />,
            );
          });
        }

        return (
          <g key={item.label + i}>
            {marks}
            {/* Hit target spans the whole column, not just the drawn height. */}
            <rect
              x={PAD.left + i * band}
              y={PAD.top}
              width={band}
              height={plotH}
              fill="transparent"
            >
              <title>
                {[item.label, ...series.map((s) => `${s.label} ${format(s.value(item))}`)].join(
                  "\n",
                )}
              </title>
            </rect>
            {i % labelStep === 0 && (
              <text
                className="axis"
                x={PAD.left + i * band + band / 2}
                y={height - 6}
                textAnchor="middle"
              >
                {item.label}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

/**
 * A time chart and the three things that always travel with it: the legend
 * that keeps identity off colour alone, the numbers behind the bars, and one
 * empty state for the whole panel rather than three.
 */
export function TimeChart<T extends { label: string }>({
  items,
  series,
  mode = "stacked",
  format,
  height,
  emptyNote = "Nothing in this range.",
}: {
  items: T[];
  series: Series<T>[];
  mode?: "stacked" | "grouped";
  format: (value: number) => string;
  height?: number;
  emptyNote?: string;
}) {
  const hasData = items.some((item) => series.some((s) => s.value(item) > 0));
  if (!hasData) return <div className="chart-empty">{emptyNote}</div>;

  return (
    <>
      <Legend series={series} />
      <BarChart items={items} series={series} mode={mode} format={format} height={height} />
      <DataTable items={items} series={series} format={format} />
    </>
  );
}

export interface BreakdownRow {
  key: string;
  label: string;
  /** Bar length, relative to the largest row. */
  value: number;
  /** Shown at the end of the bar. */
  display: string;
  note?: string;
  /** Where the row drills to, usually the session list filtered to it. */
  href?: string;
}

/**
 * Magnitude down a list of names, so the labels stay horizontal and readable
 * however long they get. One measure, one hue - rank never picks the colour.
 */
export function Breakdown({
  rows,
  color = "var(--series-1)",
  emptyNote = "Nothing in this range.",
}: {
  rows: BreakdownRow[];
  color?: string;
  emptyNote?: string;
}) {
  if (rows.length === 0) return <div className="chart-empty">{emptyNote}</div>;
  const peak = Math.max(...rows.map((r) => r.value), 1);

  return (
    <ul className="breakdown">
      {rows.map((row) => (
        <li key={row.key}>
          <span className="breakdown-label" title={row.label}>
            {row.href ? <Link href={row.href}>{row.label}</Link> : row.label}
          </span>
          <span className="breakdown-track">
            <span
              className="breakdown-bar"
              style={{ width: `${Math.max(1, (row.value / peak) * 100)}%`, background: color }}
            />
          </span>
          <span className="breakdown-value mono">{row.display}</span>
          <span className="breakdown-note">{row.note}</span>
        </li>
      ))}
    </ul>
  );
}

export function ChartPanel({
  title,
  note,
  children,
  wide,
}: {
  title: string;
  note?: string;
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <section className={`panel chart-panel${wide ? " wide" : ""}`}>
      <header>
        <h2>{title}</h2>
        {note && <span className="note">{note}</span>}
      </header>
      {children}
    </section>
  );
}

/**
 * The numbers behind a chart. Three of the light-mode series sit under a 3:1
 * contrast ratio against white, which obliges an alternative reading of the
 * same data; it doubles as the exact figures the bars only approximate.
 */
function DataTable<T extends { label: string }>({
  items,
  series,
  format,
  caption = "Show the numbers",
}: {
  items: T[];
  series: Series<T>[];
  format: (value: number) => string;
  caption?: string;
}) {
  if (items.length === 0) return null;
  return (
    <details className="chart-table">
      <summary>{caption}</summary>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th />
              {series.map((s) => (
                <th key={s.key} className="num">{s.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {items.map((item, i) => (
              <tr key={item.label + i}>
                <td>{item.label}</td>
                {series.map((s) => (
                  <td key={s.key} className="num mono">{format(s.value(item))}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
