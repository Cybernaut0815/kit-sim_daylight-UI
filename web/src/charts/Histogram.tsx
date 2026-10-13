// Value distribution: share of area per bin, each bar in the colour its values wear on the model (gradient, or the
// polarity tokens outside the problem range); the cursor value is a marker; hovering a bar fades the rest of the model.
import type { Dispatch } from 'react';
import { svgColor, type Scale } from '../lib/gradients';
import { fmtNum } from '../lib/result';
import type { Action } from '../store';
import { pct } from '../ui';

const W = 320, H = 132, PX = 6, TOP = 14, BOTTOM = 18;

export function Histogram({ edges, shares, counts, scale, unit, probe, bin, dispatch }: {
  edges: number[]; shares: number[]; counts: number[]; scale: Scale; unit: string; probe: number | null; bin: [number, number] | null; dispatch: Dispatch<Action>;
}) {
  const bins = edges.length - 1, plotH = H - TOP - BOTTOM, base = TOP + plotH;
  const max = Math.max(...shares, 1e-9), slot = (W - 2 * PX) / bins, bw = Math.min(slot - 2, 24);
  const x = (v: number) => PX + ((v - edges[0]) / (edges[bins] - edges[0] || 1)) * (W - 2 * PX);
  const hoveredBin = bin ? edges.findIndex((e, b) => b < bins && e === bin[0]) : -1;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={`Share of area per value bin, ${bins} bins from ${fmtNum(edges[0])} to ${fmtNum(edges[bins])} ${unit}`} onPointerLeave={() => dispatch({ type: 'BIN', bin: null })}>
      <text x={PX} y={10} fontSize={9} fill="var(--chart-text)">{`Share of area per bin, tallest ${pct(max)}`}</text>
      <line x1={PX} x2={W - PX} y1={base - plotH / 2} y2={base - plotH / 2} stroke="var(--chart-grid)" />
      {shares.map((share, b) => {
        if (share <= 0) return null;
        const h = Math.max((share / max) * plotH, 1), left = PX + b * slot + (slot - bw) / 2, hi = b === bins - 1 ? Infinity : edges[b + 1];
        return (
          <rect
            key={b} x={left} y={base - h} width={bw} height={h} rx={Math.min(3, bw / 2)} fill={svgColor(scale, (edges[b] + edges[b + 1]) / 2)}
            opacity={hoveredBin >= 0 && hoveredBin !== b ? 0.4 : 1}
            onPointerEnter={() => dispatch({ type: 'BIN', bin: [edges[b], hi] })}
          >
            <title>{`${pct(share)} of the area (${counts[b]} elements) between ${fmtNum(edges[b])} and ${fmtNum(edges[b + 1])} ${unit}`}</title>
          </rect>
        );
      })}
      {probe !== null && Number.isFinite(probe) && <line x1={x(probe)} x2={x(probe)} y1={TOP} y2={base} stroke="var(--chart-text-strong)" strokeWidth={2} strokeDasharray="3 2" />}
      <line x1={PX} x2={W - PX} y1={base} y2={base} stroke="var(--chart-axis)" />
      <text x={PX} y={H - 5} fontSize={9} fill="var(--chart-text)">{fmtNum(edges[0])}</text>
      <text x={W / 2} y={H - 5} fontSize={9} textAnchor="middle" fill="var(--chart-text)">{fmtNum(edges[bins >> 1])}</text>
      <text x={W - PX} y={H - 5} fontSize={9} textAnchor="end" fill="var(--chart-text)">{`${fmtNum(edges[bins])} ${unit}`}</text>
    </svg>
  );
}
