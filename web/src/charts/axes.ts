// Shared chart scaffolding: nice tick positions (1-2-5 steps), tick formatting, the common text and line colours.
export function niceStep(span: number, n: number): number {
  const raw = span / Math.max(1, n), p = 10 ** Math.floor(Math.log10(raw)), f = raw / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
}

/** About n ticks inside [min, max] on a 1-2-5 grid; a degenerate span gives the single value. */
export function niceTicks(min: number, max: number, n = 5): number[] {
  if (!(max > min) || !Number.isFinite(min) || !Number.isFinite(max)) return [min];
  const step = niceStep(max - min, n), out: number[] = [];
  // the length cap: a span below float resolution (5 .. 5 + 1e-15) never steps v forward
  for (let v = Math.ceil(min / step - 1e-9) * step; v <= max + step * 1e-9 && out.length <= 2 * n; v += step) out.push(Number(v.toFixed(10)));
  return out;
}

/** Tick label: thousands grouped, else 3 significant digits. */
export const fmtTick = (v: number): string => (Math.abs(v) >= 1000 ? Math.round(v).toLocaleString('en-GB') : Number(v.toPrecision(3)).toString());

export const FONT = 9, TITLE_FONT = 10;
export const TEXT = 'var(--chart-text)', STRONG = 'var(--chart-text-strong)', GRID = 'var(--chart-grid)', AXIS = 'var(--chart-axis)';
export const MONTHS = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];
