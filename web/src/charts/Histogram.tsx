// Distribution: 24 fixed bins over the column's global range, one stacked series per receiver in slot order.
// Marks <= 24 px, 2 px surface gaps between stacked segments, rounded data-end on the top segment, one hairline axis.
import type { Dispatch } from 'react';
import { fmtNum } from '../lib/result';
import { slotVar, type Action } from '../store';

export interface Series { id: string; name: string; slot?: number }

const W = 320, H = 132, PX = 6, TOP = 14, BOTTOM = 18;

const rectPath = (x: number, y: number, w: number, h: number) => `M${x} ${y}h${w}v${h}h${-w}Z`;
const roundedTop = (x: number, y: number, w: number, h: number, r: number) => `M${x} ${y + h}v${-(h - r)}a${r} ${r} 0 0 1 ${r} ${-r}h${w - 2 * r}a${r} ${r} 0 0 1 ${r} ${r}v${h - r}Z`;

export function Histogram({ edges, counts, series, unit, hovered, dispatch }: { edges: number[]; counts: number[][]; series: Series[]; unit: string; hovered: string | null; dispatch: Dispatch<Action> }) {
  const bins = edges.length - 1, plotH = H - TOP - BOTTOM, base = TOP + plotH;
  const max = Math.max(1, ...Array.from({ length: bins }, (_, b) => counts.reduce((s, c) => s + c[b], 0)));
  const slot = (W - 2 * PX) / bins, bw = Math.min(slot - 2, 24), scale = plotH / max;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={`Histogram of ${unit} values in ${bins} bins from ${fmtNum(edges[0])} to ${fmtNum(edges[bins])}`}>
      <text x={PX} y={10} fontSize={9} fill="var(--chart-text)">{`${max} elements in the tallest bin`}</text>
      <line x1={PX} x2={W - PX} y1={base - plotH / 2} y2={base - plotH / 2} stroke="var(--chart-grid)" />
      {Array.from({ length: bins }, (_, b) => {
        const x = PX + b * slot + (slot - bw) / 2;
        const segs = series.map((s, k) => ({ s, n: counts[k][b] })).filter((d) => d.n > 0);
        let y = base;
        return segs.map((d, i) => {
          const h = d.n * scale, top = y - h, last = i === segs.length - 1, gap = last ? 0 : 2;
          y = top;
          const hh = Math.max(h - gap, 0.5), r = Math.min(4, hh, bw / 2);
          return (
            <path
              key={d.s.id} d={last ? roundedTop(x, top, bw, hh, r) : rectPath(x, top + gap, bw, hh)} fill={`var(${slotVar(d.s.slot)})`}
              opacity={hovered && hovered !== d.s.id ? 0.45 : 1}
              onPointerEnter={() => dispatch({ type: 'HOVER', id: d.s.id })} onPointerLeave={() => dispatch({ type: 'HOVER', id: null })}
              onClick={(e) => dispatch({ type: 'SELECT', ids: [d.s.id], additive: e.shiftKey || e.ctrlKey })}
            >
              <title>{`${d.s.name}: ${d.n} elements between ${fmtNum(edges[b])} and ${fmtNum(edges[b + 1])} ${unit}`}</title>
            </path>
          );
        });
      })}
      <line x1={PX} x2={W - PX} y1={base} y2={base} stroke="var(--chart-axis)" />
      <text x={PX} y={H - 5} fontSize={9} fill="var(--chart-text)">{fmtNum(edges[0])}</text>
      <text x={W / 2} y={H - 5} fontSize={9} textAnchor="middle" fill="var(--chart-text)">{fmtNum(edges[bins >> 1])}</text>
      <text x={W - PX} y={H - 5} fontSize={9} textAnchor="end" fill="var(--chart-text)">{`${fmtNum(edges[bins])} ${unit}`}</text>
    </svg>
  );
}
