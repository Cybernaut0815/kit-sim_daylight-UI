// Colour legend: the gradient over [vmin, vmax], the problem range painted in the polarity tokens, the cursor value marked.
import { useId } from 'react';
import { ABOVE_VAR, BELOW_VAR, hexAt, type Scale } from '../lib/gradients';
import { fmtNum } from '../lib/result';

const W = 320, H = 36, PX = 6, BAR_Y = 4, BAR_H = 12;

export function Legend({ scale, unit, probe }: { scale: Scale; unit: string; probe: number | null }) {
  const id = useId();
  const { vmin, vmax, lo, hi, gradient } = scale;
  const x = (v: number) => PX + (Math.min(Math.max((v - vmin) / (vmax - vmin || 1), 0), 1)) * (W - 2 * PX);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={`Colour scale from ${fmtNum(vmin)} to ${fmtNum(vmax)} ${unit}${lo !== null ? `, below ${fmtNum(lo)} marked` : ''}${hi !== null ? `, above ${fmtNum(hi)} marked` : ''}`}>
      <defs>
        <linearGradient id={id}>{gradient.stops.map((_, i) => <stop key={i} offset={`${(100 * i) / (gradient.stops.length - 1)}%`} stopColor={hexAt(gradient, i / (gradient.stops.length - 1))} />)}</linearGradient>
      </defs>
      <rect x={PX} y={BAR_Y} width={W - 2 * PX} height={BAR_H} rx={2} fill={`url(#${id})`} />
      {lo !== null && lo > vmin && <rect x={PX} y={BAR_Y} width={x(lo) - PX} height={BAR_H} rx={2} fill={`var(${BELOW_VAR})`} />}
      {hi !== null && hi < vmax && <rect x={x(hi)} y={BAR_Y} width={W - PX - x(hi)} height={BAR_H} rx={2} fill={`var(${ABOVE_VAR})`} />}
      {probe !== null && Number.isFinite(probe) && (
        <g aria-label={`cursor at ${fmtNum(probe)} ${unit}`}>
          <line x1={x(probe)} x2={x(probe)} y1={BAR_Y - 2} y2={BAR_Y + BAR_H + 2} stroke="var(--chart-text-strong)" strokeWidth={2} />
          <path d={`M${x(probe) - 4} ${BAR_Y + BAR_H + 8}l4 -5l4 5Z`} fill="var(--chart-text-strong)" />
        </g>
      )}
      <text x={PX} y={H - 4} fontSize={9} fill="var(--chart-text)">{fmtNum(vmin)}</text>
      <text x={W / 2} y={H - 4} fontSize={9} textAnchor="middle" fill="var(--chart-text)">{fmtNum((vmin + vmax) / 2)}</text>
      <text x={W - PX} y={H - 4} fontSize={9} textAnchor="end" fill="var(--chart-text)">{`${fmtNum(vmax)} ${unit}`}</text>
    </svg>
  );
}
