// Colour legend: the gradient over [vmin, vmax] with nice ticks, the problem range in its colours, the cursor value marked.
// The bar is the gradient as it is (its stops where they sit); a value's place along it follows the scale's scaling
// (lib/gradients position), so under a log or equalised scaling the ticks crowd where the colours change slowly.
import { useId } from 'react';
import { position, positionsOf, type Scale } from '../lib/gradients';
import { fmtNum } from '../lib/result';
import { AXIS, FONT, STRONG, TEXT, fmtTick, niceTicks } from './axes';

const W = 320, H = 40, PX = 8, BAR_Y = 4, BAR_H = 12, APART = 34; // px between two tick labels

/** The legend's tick values. Linear: nice steps. Otherwise candidates in order of how round they are (for log the
 *  powers of ten, then 2 and 5 times them; then nice linear steps), each kept while its label stays apart from those
 *  kept before: under a log or equalised scaling the ticks crowd where the colours change slowly. */
export function legendTicks(scale: Scale, x: (v: number) => number): number[] {
  const { vmin, vmax, scaling } = scale;
  if (scaling === 'linear' || !(vmax > vmin)) return niceTicks(vmin, vmax, 5);
  const floor = vmin > 0 ? vmin : vmax * 1e-3, tens: number[] = [], twos: number[] = [];
  if (scaling === 'log' && vmax > 0) for (let e = Math.floor(Math.log10(floor)); 10 ** e <= vmax; e++) { const t = Number((10 ** e).toPrecision(12)); tens.push(t); twos.push(2 * t, 5 * t); }
  const kept: number[] = [];
  for (const group of [tens, twos, niceTicks(vmin, vmax, 10)]) {
    if (kept.length >= 3) break; // rounder ones suffice: no 300 between 100 and 1000
    for (const v of group) if (v >= vmin - 1e-6 * Math.abs(vmin) && v <= vmax + 1e-6 * Math.abs(vmax) && kept.every((k) => Math.abs(x(k) - x(v)) >= APART)) kept.push(v);
  }
  return kept.sort((a, b) => a - b);
}

export function Legend({ scale, unit, probe }: { scale: Scale; unit: string; probe: number | null }) {
  const id = useId();
  const { vmin, vmax, lo, hi, gradient } = scale;
  const x = (v: number) => PX + Math.min(Math.max(position(scale, v), 0), 1) * (W - 2 * PX);
  const ticks = legendTicks(scale, x), at = positionsOf(gradient);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={`Colour scale from ${fmtNum(vmin)} to ${fmtNum(vmax)} ${unit}${lo !== null ? `, below ${fmtNum(lo)} in ${scale.below}` : ''}${hi !== null ? `, above ${fmtNum(hi)} in ${scale.above}` : ''}`}>
      <defs>
        <linearGradient id={id}>{gradient.stops.map((hex, i) => <stop key={i} offset={`${100 * at[i]}%`} stopColor={hex} />)}</linearGradient>
      </defs>
      <rect x={PX} y={BAR_Y} width={W - 2 * PX} height={BAR_H} fill={`url(#${id})`} />
      {lo !== null && lo > vmin && <rect x={PX} y={BAR_Y} width={x(lo) - PX} height={BAR_H} fill={scale.below} />}
      {hi !== null && hi < vmax && <rect x={x(hi)} y={BAR_Y} width={W - PX - x(hi)} height={BAR_H} fill={scale.above} />}
      <line x1={PX} x2={W - PX} y1={BAR_Y + BAR_H} y2={BAR_Y + BAR_H} stroke={AXIS} />
      {ticks.map((t) => (
        <g key={t}>
          <line x1={x(t)} x2={x(t)} y1={BAR_Y + BAR_H} y2={BAR_Y + BAR_H + 3} stroke={AXIS} />
          <text x={x(t)} y={BAR_Y + BAR_H + 12} fontSize={FONT} textAnchor={x(t) > W - PX - 12 ? 'end' : x(t) < PX + 12 ? 'start' : 'middle'} fill={TEXT}>{fmtTick(t)}</text>
        </g>
      ))}
      <text x={W - PX} y={H - 2} fontSize={FONT} textAnchor="end" fill={TEXT}>{unit}</text>
      {probe !== null && Number.isFinite(probe) && (
        <g aria-label={`cursor at ${fmtNum(probe)} ${unit}`}>
          <line x1={x(probe)} x2={x(probe)} y1={BAR_Y - 2} y2={BAR_Y + BAR_H + 2} stroke={STRONG} strokeWidth={2} />
          <path d={`M${x(probe) - 4} ${BAR_Y + BAR_H + 9}l4 -5l4 5Z`} fill={STRONG} />
        </g>
      )}
    </svg>
  );
}
