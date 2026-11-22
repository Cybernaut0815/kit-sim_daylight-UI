// Value distribution: share of area per bin, bars in the colour their values wear on the model, the problem range
// shaded behind them, mean / median / P10 / P90 markers, the cursor value, and bar hover that fades the rest of the model.
// Bars are selected as rows of the model tree are: a click takes one, Shift+click the range from the bar clicked before,
// Ctrl+click adds or removes one, a drag across bars takes them all (added with Ctrl); a click on the empty plot lets
// go. The selection is kept as value ranges (store `bins`): the views keep them bright, as they do the hovered bar.
// The bins span the chart's range (relative: the colour scale); the area outside it is given as a share at each edge. Several models (`series`): one
// step outline each in its colour over the same bins, a hover strip per bin; their markers and shares outside the range
// are in the Results tables.
import { useRef, useState, type Dispatch, type PointerEvent } from 'react';
import { MARKERS, MAX_BIN_RANGES, binRanges, binsIn, pickBins, type Marker, type Markers } from '../lib/charts';
import { svgColor, type Scale } from '../lib/gradients';
import { fmtNum } from '../lib/result';
import type { Action } from '../store';
import { pct } from '../ui';
import { AXIS, DASH, FONT, GRID, STRONG, TEXT, fmtTick, niceTicks } from './axes';

const L = 34, R = 8, TOP = 20, BOTTOM = 30;
const NONE: readonly [number, number][] = [];
const PICK = 'Click to select it, Shift+click for a range, Ctrl+click to add or remove, drag across bars';

/** `width` / `height`: the viewBox (the drawing scales to its box); `show`: the markers drawn; `picked`: the selected bars
 *  as value ranges; without `dispatch` no bin hover and no selection. */
export function Histogram({ edges, shares, counts, below, above, scale, unit, probe, bin, bins: picked = NONE, markers, series, dispatch, show = MARKERS.histogram, grid = true, width = 320, height = 200 }: {
  edges: number[]; shares: number[]; counts: number[]; below: number; above: number; scale: Scale; unit: string; probe: number | null; bin: [number, number] | null; markers: Markers;
  bins?: readonly [number, number][];
  series?: { color: string; label: string; shares: number[] }[]; // several models: one outline each (above: the largest share above of any)
  dispatch?: Dispatch<Action>; show?: readonly Marker[]; grid?: boolean; width?: number; height?: number;
}) {
  const bins = edges.length - 1, plotW = width - L - R, plotH = height - TOP - BOTTOM, base = TOP + plotH;
  const dmin = edges[0], dmax = edges[bins], max = Math.max(...(series ? series.flatMap((s) => s.shares) : shares), 1e-9);
  const x = (v: number) => L + Math.min(Math.max((v - dmin) / (dmax - dmin || 1), 0), 1) * plotW;
  const head = !series && (below > 0 || above > 0) ? 12 : 0; // room above the bars for the shares outside the range
  const y = (share: number) => base - (share / max) * (plotH - head);
  const inside = (v: number) => Number.isFinite(v) && v >= dmin && v <= dmax; // markers outside the range are not drawn
  const bw = plotW / bins, gap = bw > 6 ? 1 : 0.5;
  const hoveredBin = bin ? edges.findIndex((e, b) => b < bins && e === bin[0]) : -1;
  const yTicks = niceTicks(0, max, 4), xTicks = niceTicks(dmin, dmax, 6), last = xTicks[xTicks.length - 1]; // niceTicks: never empty
  const n = counts.reduce((s, c) => s + c, 0);
  const hiOf = (b: number) => (b < bins - 1 ? edges[b + 1] : above > 0 ? dmax + (dmax - dmin) * 1e-9 : Infinity); // the last bin keeps its top value
  const loOf = (b: number) => edges[b];
  const anchor = useRef<number | null>(null); // the bar clicked last: where a Shift+click's range starts
  const [brush, setBrush] = useState<{ from: number; to: number } | null>(null); // the bars under a press: one (a click) or a drag's
  const selected = binsIn(picked, bins, loOf, hiOf);
  const lit = (b: number) => selected.has(b) || (brush !== null && brush.from !== brush.to && b >= Math.min(brush.from, brush.to) && b <= Math.max(brush.from, brush.to));
  const some = selected.size > 0 || (brush !== null && brush.from !== brush.to); // bars are picked: the others fade
  const hover = (b: number) => dispatch && (() => { dispatch({ type: 'BIN', bin: [edges[b], hiOf(b)] }); setBrush((d) => d && { ...d, to: b }); });
  const press = (b: number) => dispatch && ((e: PointerEvent) => { if (e.button === 0) { e.preventDefault(); setBrush({ from: b, to: b }); } }); // no text selected by the drag
  const release = dispatch && ((e: PointerEvent) => {
    if (!brush) return;
    const { from, to } = brush, ctrl = e.ctrlKey || e.metaKey, drag = from !== to;
    const next = drag ? pickBins(selected, from, to, { shift: true, ctrl }) : pickBins(selected, anchor.current, to, { shift: e.shiftKey, ctrl });
    if (drag || !e.shiftKey || anchor.current === null) anchor.current = from; // a Shift+click keeps the bar its range starts at
    const ranges = binRanges(next, loOf, hiOf);
    if (ranges.length <= MAX_BIN_RANGES) dispatch({ type: 'BINS', bins: ranges }); // more than the views can keep apart: the click does nothing
    setBrush(null);
  });
  const clear = dispatch && (() => { anchor.current = null; dispatch({ type: 'BINS', bins: [] }); });
  const has = (m: Marker) => !series && show.includes(m); // the markers: one model only
  const header = series ? `per model, bin ${fmtNum((dmax - dmin) / bins)} ${unit}` : `${n.toLocaleString('en-GB')} elements, bin ${fmtNum((dmax - dmin) / bins)} ${unit}`;
  // the mean label sits above the plot, the median label just above the axis, so the two never collide; a label starting
  // at the line starts no sooner than `from` (the mean's: past the header, glyphs about 5 units wide)
  // the markers and the cursor's line take no pointer: a bar under them is hovered, pressed and dragged over as any other
  const marker = (v: number, label: string, ty: number, dash?: string, from = 0) => (
    <g key={label} pointerEvents="none">
      <line x1={x(v)} x2={x(v)} y1={TOP - 4} y2={base} stroke={STRONG} strokeWidth={1.25} strokeDasharray={dash} />
      <text x={x(v) > L + plotW * 0.75 ? x(v) + 3 : Math.max(x(v) + 3, from)} y={ty} fontSize={FONT} fill={STRONG} textAnchor={x(v) > L + plotW * 0.75 ? 'end' : 'start'} dx={x(v) > L + plotW * 0.75 ? -6 : 0}>{label}</text>
    </g>
  );
  return (
    <svg viewBox={`0 0 ${width} ${height}`} width="100%" role="img" aria-label={series ? `Distribution of ${unit} values per model: share of each model's area in ${bins} bins from ${fmtNum(dmin)} to ${fmtNum(dmax)}` : `Distribution of ${unit} values: share of area in ${bins} bins from ${fmtNum(dmin)} to ${fmtNum(dmax)}${head ? ` (${pct(below)} of the area below, ${pct(above)} above)` : ''}; mean ${fmtNum(markers.mean)}, median ${fmtNum(markers.median)}`} onPointerLeave={dispatch && (() => { dispatch({ type: 'BIN', bin: null }); setBrush(null); })} onPointerUp={release}>
      {scale.lo !== null && scale.lo > dmin && <rect x={L} y={TOP} width={x(scale.lo) - L} height={plotH} fill={scale.below} opacity={0.12} />}
      {scale.hi !== null && scale.hi < dmax && <rect x={x(scale.hi)} y={TOP} width={L + plotW - x(scale.hi)} height={plotH} fill={scale.above} opacity={0.12} />}
      {/* the empty plot: a click here lets the selected bars go */}
      {dispatch && <rect x={L} y={TOP} width={plotW} height={plotH} fill="transparent" onPointerDown={clear} />}
      {yTicks.map((t) => (
        <g key={t}>
          {grid && <line x1={L} x2={L + plotW} y1={y(t)} y2={y(t)} stroke={GRID} pointerEvents="none" />}
          <text x={L - 4} y={y(t) + 3} fontSize={FONT} textAnchor="end" fill={TEXT}>{`${fmtTick(100 * t)} %`}</text>
        </g>
      ))}
      {!series && shares.map((share, b) => {
        if (share <= 0) return null;
        const h = Math.max(base - y(share), 1), left = L + b * bw + gap / 2, hot = hoveredBin === b, on = lit(b);
        return (
          <rect
            key={b} className={dispatch && 'chart-bar'} x={left} y={base - h} width={Math.max(bw - gap, 0.5)} height={h} fill={svgColor(scale, (edges[b] + edges[b + 1]) / 2)}
            opacity={(some || hoveredBin >= 0) && !hot && !on ? 0.45 : 1} stroke={hot || on ? STRONG : 'none'} strokeWidth={hot || on ? 1.5 : 0} onPointerEnter={hover(b)} onPointerDown={press(b)}
          >
            <title>{`${pct(share)} of the area, ${counts[b]} elements, ${fmtNum(edges[b])} to ${fmtNum(edges[b + 1])} ${unit}${dispatch ? `. ${PICK}` : ''}`}</title>
          </rect>
        );
      })}
      {series && Array.from({ length: bins }, (_, b) => (
        <rect key={b} className={dispatch && 'chart-bar'} x={L + b * bw} y={TOP} width={bw} height={plotH} fill={lit(b) ? STRONG : 'transparent'} fillOpacity={0.1} stroke={hoveredBin === b || lit(b) ? STRONG : 'none'} strokeWidth={1.5} onPointerEnter={hover(b)} onPointerDown={press(b)}>
          <title>{`${fmtNum(edges[b])} to ${fmtNum(edges[b + 1])} ${unit}: ${series.map((s) => `${s.label} ${pct(s.shares[b])}`).join(', ')} of the area${dispatch ? `. ${PICK}` : ''}`}</title>
        </rect>
      ))}
      {series?.map((s, k) => <path key={s.label} d={`M${L} ${base}${s.shares.map((v, b) => `V${y(v)}H${L + (b + 1) * bw}`).join('')}V${base}`} fill="none" stroke={s.color} strokeWidth={1.5} strokeDasharray={DASH[k]} pointerEvents="none" />)}
      {!series && below > 0 && <text x={L + 2} y={TOP + 8} fontSize={FONT} fill={TEXT}><title>{`${pct(below)} of the area is below ${fmtNum(dmin)} ${unit}, where the chart starts`}</title>{`‹ ${pct(below)} below`}</text>}
      {!series && above > 0 && <text x={L + plotW - 2} y={TOP + 8} fontSize={FONT} textAnchor="end" fill={TEXT}><title>{`${pct(above)} of the area is above ${fmtNum(dmax)} ${unit}, where the chart ends`}</title>{`${pct(above)} above ›`}</text>}
      {has('mean') && inside(markers.mean) && marker(markers.mean, `mean ${fmtNum(markers.mean)}`, TOP - 7, undefined, L + 5 * header.length + 6)}
      {has('median') && inside(markers.median) && (!has('mean') || Math.abs(x(markers.median) - x(markers.mean)) > 2) && marker(markers.median, `median ${fmtNum(markers.median)}`, base - 4, '3 2')}
      {(['p10', 'p90'] as const).filter((k) => has(k) && inside(markers[k])).map((k) => (
        <g key={k} pointerEvents="none">
          <path d={`M${x(markers[k]) - 3} ${base + 8}l3 -5l3 5Z`} fill={STRONG} />
          <text x={x(markers[k])} y={base + 17} fontSize={FONT} textAnchor="middle" fill={STRONG}>{k.toUpperCase()}</text>
        </g>
      ))}
      {probe !== null && inside(probe) && <line x1={x(probe)} x2={x(probe)} y1={TOP} y2={base} stroke={STRONG} strokeWidth={2} strokeDasharray="4 2" pointerEvents="none" />}
      <line x1={L} x2={L + plotW} y1={base} y2={base} stroke={AXIS} />
      {xTicks.map((t) => (
        <g key={t}>
          <line x1={x(t)} x2={x(t)} y1={base} y2={base + 3} stroke={AXIS} />
          <text x={x(t)} y={base + 26} fontSize={FONT} textAnchor={x(t) > L + plotW - 10 ? 'end' : 'middle'} fill={TEXT}>{fmtTick(t)}</text>
        </g>
      ))}
      {/* the unit, unless the last tick's label would run into it (glyphs about 5 units wide) */}
      <text x={L + plotW} y={base + 26} fontSize={FONT} textAnchor="end" fill={TEXT}>{L + plotW - x(last) < Math.max(20, 5 + 5 * unit.length + 2.5 * fmtTick(last).length) ? '' : unit}</text>
      <text x={L} y={TOP - 7} fontSize={FONT} fill={TEXT}>{header}</text>
    </svg>
  );
}
