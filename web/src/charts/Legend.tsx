// Colour legend: the gradient over [vmin, vmax] with nice ticks, the problem range in its colours, the cursor value marked.
import { useId } from 'react';
import { hexAt, type Scale } from '../lib/gradients';
import { fmtNum } from '../lib/result';
import { AXIS, FONT, STRONG, TEXT, fmtTick, niceTicks } from './axes';

const W = 320, H = 40, PX = 8, BAR_Y = 4, BAR_H = 12;

export function Legend({ scale, unit, probe }: { scale: Scale; unit: string; probe: number | null }) {
  const id = useId();
  const { vmin, vmax, lo, hi, gradient } = scale;
  const x = (v: number) => PX + Math.min(Math.max((v - vmin) / (vmax - vmin || 1), 0), 1) * (W - 2 * PX);
  const ticks = niceTicks(vmin, vmax, 5);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={`Colour scale from ${fmtNum(vmin)} to ${fmtNum(vmax)} ${unit}${lo !== null ? `, below ${fmtNum(lo)} in ${scale.below}` : ''}${hi !== null ? `, above ${fmtNum(hi)} in ${scale.above}` : ''}`}>
      <defs>
        <linearGradient id={id}>{gradient.stops.map((_, i) => <stop key={i} offset={`${(100 * i) / (gradient.stops.length - 1)}%`} stopColor={hexAt(gradient, i / (gradient.stops.length - 1))} />)}</linearGradient>
      </defs>
      <rect x={PX} y={BAR_Y} width={W - 2 * PX} height={BAR_H} fill={`url(#${id})`} />
      {lo !== null && lo > vmin && <rect x={PX} y={BAR_Y} width={x(lo) - PX} height={BAR_H} fill={scale.below} />}
      {hi !== null && hi < vmax && <rect x={x(hi)} y={BAR_Y} width={W - PX - x(hi)} height={BAR_H} fill={scale.above} />}
      <line x1={PX} x2={W - PX} y1={BAR_Y + BAR_H} y2={BAR_Y + BAR_H} stroke={AXIS} />
      {ticks.map((t) => (
        <g key={t}>
          <line x1={x(t)} x2={x(t)} y1={BAR_Y + BAR_H} y2={BAR_Y + BAR_H + 3} stroke={AXIS} />
          <text x={x(t)} y={BAR_Y + BAR_H + 12} fontSize={FONT} textAnchor="middle" fill={TEXT}>{fmtTick(t)}</text>
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
