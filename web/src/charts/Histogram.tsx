// Value distribution: share of area per bin, bars in the colour their values wear on the model, the problem range
// shaded behind them, mean / median / P10 / P90 markers, the cursor value, and bar hover that fades the rest of the model.
// The bins span the colour scale; the area outside it is given as a share at each edge.
import type { Dispatch } from 'react';
import { svgColor, type Scale } from '../lib/gradients';
import { fmtNum } from '../lib/result';
import type { Action } from '../store';
import { pct } from '../ui';
import { AXIS, FONT, GRID, STRONG, TEXT, fmtTick, niceTicks } from './axes';

const W = 320, H = 200, L = 34, R = 8, TOP = 20, BOTTOM = 30;

export interface Markers { mean: number; median: number; p10: number; p90: number }

export function Histogram({ edges, shares, counts, below, above, scale, unit, probe, bin, markers, dispatch }: {
  edges: number[]; shares: number[]; counts: number[]; below: number; above: number; scale: Scale; unit: string; probe: number | null; bin: [number, number] | null; markers: Markers; dispatch: Dispatch<Action>;
}) {
  const bins = edges.length - 1, plotW = W - L - R, plotH = H - TOP - BOTTOM, base = TOP + plotH;
  const dmin = edges[0], dmax = edges[bins], max = Math.max(...shares, 1e-9);
  const x = (v: number) => L + Math.min(Math.max((v - dmin) / (dmax - dmin || 1), 0), 1) * plotW;
  const head = below > 0 || above > 0 ? 12 : 0; // room above the bars for the shares outside the range
  const y = (share: number) => base - (share / max) * (plotH - head);
  const inside = (v: number) => Number.isFinite(v) && v >= dmin && v <= dmax; // markers outside the range are not drawn
  const bw = plotW / bins, gap = bw > 6 ? 1 : 0.5;
  const hoveredBin = bin ? edges.findIndex((e, b) => b < bins && e === bin[0]) : -1;
  const yTicks = niceTicks(0, max, 4), xTicks = niceTicks(dmin, dmax, 6);
  const n = counts.reduce((s, c) => s + c, 0);
  // the mean label sits above the plot, the median label just above the axis, so the two never collide
  const marker = (v: number, label: string, ty: number, dash?: string) => (
    <g key={label}>
      <line x1={x(v)} x2={x(v)} y1={TOP - 4} y2={base} stroke={STRONG} strokeWidth={1.25} strokeDasharray={dash} />
      <text x={x(v) + 3} y={ty} fontSize={FONT} fill={STRONG} textAnchor={x(v) > L + plotW * 0.75 ? 'end' : 'start'} dx={x(v) > L + plotW * 0.75 ? -6 : 0}>{label}</text>
    </g>
  );
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={`Distribution of ${unit} values: share of area in ${bins} bins from ${fmtNum(dmin)} to ${fmtNum(dmax)}${head ? ` (${pct(below)} of the area below, ${pct(above)} above)` : ''}; mean ${fmtNum(markers.mean)}, median ${fmtNum(markers.median)}`} onPointerLeave={() => dispatch({ type: 'BIN', bin: null })}>
      {scale.lo !== null && scale.lo > dmin && <rect x={L} y={TOP} width={x(scale.lo) - L} height={plotH} fill={scale.below} opacity={0.12} />}
      {scale.hi !== null && scale.hi < dmax && <rect x={x(scale.hi)} y={TOP} width={L + plotW - x(scale.hi)} height={plotH} fill={scale.above} opacity={0.12} />}
      {yTicks.map((t) => (
        <g key={t}>
          <line x1={L} x2={L + plotW} y1={y(t)} y2={y(t)} stroke={GRID} />
          <text x={L - 4} y={y(t) + 3} fontSize={FONT} textAnchor="end" fill={TEXT}>{`${fmtTick(100 * t)} %`}</text>
        </g>
      ))}
      {shares.map((share, b) => {
        if (share <= 0) return null;
        const h = Math.max(base - y(share), 1), left = L + b * bw + gap / 2, hot = hoveredBin === b;
        const hi = b < bins - 1 ? edges[b + 1] : above > 0 ? dmax + (dmax - dmin) * 1e-9 : Infinity; // the last bin keeps its top value
        return (
          <rect
            key={b} x={left} y={base - h} width={Math.max(bw - gap, 0.5)} height={h} fill={svgColor(scale, (edges[b] + edges[b + 1]) / 2)}
            opacity={hoveredBin >= 0 && !hot ? 0.45 : 1} stroke={hot ? STRONG : 'none'} strokeWidth={hot ? 1.5 : 0}
            onPointerEnter={() => dispatch({ type: 'BIN', bin: [edges[b], hi] })}
          >
            <title>{`${pct(share)} of the area, ${counts[b]} elements, ${fmtNum(edges[b])} to ${fmtNum(edges[b + 1])} ${unit}`}</title>
          </rect>
        );
      })}
      {below > 0 && <text x={L + 2} y={TOP + 8} fontSize={FONT} fill={TEXT}><title>{`${pct(below)} of the area is below ${fmtNum(dmin)} ${unit}, the colour scale's Min`}</title>{`◂ ${pct(below)} below`}</text>}
      {above > 0 && <text x={L + plotW - 2} y={TOP + 8} fontSize={FONT} textAnchor="end" fill={TEXT}><title>{`${pct(above)} of the area is above ${fmtNum(dmax)} ${unit}, the colour scale's Max`}</title>{`${pct(above)} above ▸`}</text>}
      {inside(markers.mean) && marker(markers.mean, `mean ${fmtNum(markers.mean)}`, TOP - 7)}
      {inside(markers.median) && Math.abs(x(markers.median) - x(markers.mean)) > 2 && marker(markers.median, `median ${fmtNum(markers.median)}`, base - 4, '3 2')}
      {[['P10', markers.p10], ['P90', markers.p90]].filter(([, v]) => inside(v as number)).map(([k, v]) => (
        <g key={k as string}>
          <path d={`M${x(v as number) - 3} ${base + 8}l3 -5l3 5Z`} fill={STRONG} />
          <text x={x(v as number)} y={base + 17} fontSize={FONT} textAnchor="middle" fill={STRONG}>{k}</text>
        </g>
      ))}
      {probe !== null && inside(probe) && <line x1={x(probe)} x2={x(probe)} y1={TOP} y2={base} stroke={STRONG} strokeWidth={2} strokeDasharray="4 2" />}
      <line x1={L} x2={L + plotW} y1={base} y2={base} stroke={AXIS} />
      {xTicks.map((t) => (
        <g key={t}>
          <line x1={x(t)} x2={x(t)} y1={base} y2={base + 3} stroke={AXIS} />
          <text x={x(t)} y={base + 26} fontSize={FONT} textAnchor="middle" fill={TEXT}>{fmtTick(t)}</text>
        </g>
      ))}
      <text x={L + plotW} y={base + 26} fontSize={FONT} textAnchor="end" fill={TEXT} dx={-xTicks.length ? 0 : 0}>{xTicks.length && Math.abs(x(xTicks[xTicks.length - 1]) - (L + plotW)) < 20 ? '' : unit}</text>
      <text x={L} y={TOP - 7} fontSize={FONT} fill={TEXT}>{`${n.toLocaleString('en-GB')} elements, bin ${fmtNum((dmax - dmin) / bins)} ${unit}`}</text>
    </svg>
  );
}
