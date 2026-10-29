// Cumulative area curve: the share of area at or below each value ("x % of the area gets less than v"), with the
// problem range tinted, P10 / P50 / P90 marked and the cursor value's percentile. It spans the colour scale: the curve
// starts at the share below the range and ends at the share up to its top. Several models (`curves`): one line each in
// its colour, the cursor's share on each.
import { MARKERS, type Marker } from '../lib/charts';
import { type Scale } from '../lib/gradients';
import { fmtNum, percentile, shareBelow, type Cumulative } from '../lib/result';
import { pct } from '../ui';
import { AXIS, FONT, GRID, STRONG, TEXT, fmtTick, niceTicks } from './axes';

const L = 34, R = 8, TOP = 10, BOTTOM = 30;
const AT: Partial<Record<Marker, number>> = { p10: 0.1, median: 0.5, p90: 0.9 }; // the marked percentiles

/** `width` / `height`: the viewBox (the drawing scales to its box); `show`: the percentiles marked (one model). */
export function AreaCurve({ cum, domain, scale, unit, probe, curves, show = MARKERS.curve, grid = true, width = 320, height = 170 }: {
  cum: Cumulative; domain: [number, number]; scale: Scale; unit: string; probe: number | null;
  curves?: { color: string; cum: Cumulative }[]; // several models: one line each
  show?: readonly Marker[]; grid?: boolean; width?: number; height?: number;
}) {
  const [dmin, dmax] = domain, plotW = width - L - R, plotH = height - TOP - BOTTOM, base = TOP + plotH;
  const x = (v: number) => L + Math.min(Math.max((v - dmin) / (dmax - dmin || 1), 0), 1) * plotW;
  const y = (share: number) => base - share * plotH;
  const inside = (v: number) => Number.isFinite(v) && v >= dmin && v <= dmax;
  /** The curve's points over the range, at most ~200. */
  const line = (c: Cumulative) => {
    const n = c.v.length;
    let i0 = 0, i1 = n; // the elements inside the range
    while (i0 < n && c.v[i0] < dmin) i0++;
    while (i1 > i0 && c.v[i1 - 1] > dmax) i1--;
    const step = Math.max(1, Math.floor((i1 - i0) / 200));
    const pts: string[] = [`${x(dmin)},${y(i0 ? c.cw[i0 - 1] : 0)}`];
    for (let i = i0; i < i1; i += step) pts.push(`${x(c.v[i])},${y(c.cw[i])}`);
    if (i1 > i0) pts.push(`${x(c.v[i1 - 1])},${y(c.cw[i1 - 1])}`);
    pts.push(`${x(dmax)},${y(i1 ? c.cw[i1 - 1] : 0)}`);
    return pts.join(' ');
  };
  const p = probe !== null && inside(probe) ? { x: x(probe), share: shareBelow(cum, probe) } : null;
  const xTicks = niceTicks(dmin, dmax, 6);
  return (
    <svg viewBox={`0 0 ${width} ${height}`} width="100%" role="img" aria-label={curves ? `Cumulative share of area by ${unit} value, one line per model` : `Cumulative share of area by ${unit} value; P10 ${fmtNum(percentile(cum, 0.1))}, median ${fmtNum(percentile(cum, 0.5))}, P90 ${fmtNum(percentile(cum, 0.9))}`}>
      {scale.lo !== null && scale.lo > dmin && <rect x={L} y={TOP} width={x(scale.lo) - L} height={plotH} fill={scale.below} opacity={0.12} />}
      {scale.hi !== null && scale.hi < dmax && <rect x={x(scale.hi)} y={TOP} width={L + plotW - x(scale.hi)} height={plotH} fill={scale.above} opacity={0.12} />}
      {grid && [0.25, 0.5, 0.75, 1].map((s) => <line key={s} x1={L} x2={L + plotW} y1={y(s)} y2={y(s)} stroke={GRID} />)}
      {[0, 0.25, 0.5, 0.75, 1].map((s) => <text key={s} x={L - 4} y={y(s) + 3} fontSize={FONT} textAnchor="end" fill={TEXT}>{`${100 * s} %`}</text>)}
      {(curves ?? [{ color: STRONG, cum }]).map((c, k) => <polyline key={k} points={line(c.cum)} fill="none" stroke={c.color} strokeWidth={curves ? 2 : 1.5} />)}
      {!curves && show.flatMap((m) => AT[m] ?? []).map((q) => {
        const v = percentile(cum, q), right = x(v) > L + plotW * 0.7; // labels near the right edge turn inwards
        return inside(v) && (
          <g key={q}>
            <circle cx={x(v)} cy={y(q)} r={2.5} fill={STRONG} />
            <text x={x(v) + (right ? -4 : 4)} y={y(q) + (right ? 12 : -3)} fontSize={FONT} textAnchor={right ? 'end' : 'start'} fill={TEXT}>{`P${Math.round(100 * q)} ${fmtNum(v)}`}</text>
          </g>
        );
      })}
      {p && curves && (
        <g aria-label={`cursor: ${fmtNum(probe!)} ${unit}`}>
          <line x1={p.x} x2={p.x} y1={TOP} y2={base} stroke={STRONG} strokeWidth={2} strokeDasharray="4 2" />
          {curves.map((c, k) => <circle key={k} cx={p.x} cy={y(shareBelow(c.cum, probe!))} r={3.5} fill={c.color} />)}
        </g>
      )}
      {p && !curves && (
        <g aria-label={`cursor: ${pct(p.share)} of the area below ${fmtNum(probe!)} ${unit}`}>
          <line x1={p.x} x2={p.x} y1={TOP} y2={base} stroke={STRONG} strokeWidth={2} strokeDasharray="4 2" />
          <line x1={L} x2={p.x} y1={y(p.share)} y2={y(p.share)} stroke={STRONG} strokeDasharray="4 2" />
          <circle cx={p.x} cy={y(p.share)} r={3.5} fill={STRONG} />
        </g>
      )}
      <line x1={L} x2={L + plotW} y1={base} y2={base} stroke={AXIS} />
      {xTicks.map((t) => (
        <g key={t}>
          <line x1={x(t)} x2={x(t)} y1={base} y2={base + 3} stroke={AXIS} />
          <text x={x(t)} y={base + 14} fontSize={FONT} textAnchor={x(t) > L + plotW - 10 ? 'end' : 'middle'} fill={TEXT}>{fmtTick(t)}</text>
        </g>
      ))}
      <text x={L + plotW} y={base + 26} fontSize={FONT} textAnchor="end" fill={TEXT}>{unit}</text>
      <text x={L} y={base + 26} fontSize={FONT} fill={TEXT}>share of area at or below the value</text>
    </svg>
  );
}
